/**
 * Claude Code — `~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl`.
 *
 * The file is a JSONL log of the conversation. Every line has a `type`; the
 * interesting ones are:
 *
 * - `user` — an external prompt, or the result of a tool call that Claude
 *   Code writes back as a `user` message with `tool_result` blocks;
 * - `assistant` — one model response, with `text`, `thinking` and `tool_use`
 *   blocks and the `usage` of the call;
 * - `system` — harness level events, e.g. an API error that was retried.
 *
 * Everything else (`attachment`, `queue-operation`, `api-request*`,
 * `last-prompt`, `atis-latch`, `cost-state`, …) is harness bookkeeping and is
 * skipped silently; only a genuinely unknown type becomes `raw.unknown`.
 *
 * Turns: every external user message starts a new turn. A user message that
 * only carries `tool_result` blocks belongs to the running turn. The
 * `isCompactSummary` record is not a user turn: it belongs to the
 * `segment.boundary` that follows a compaction.
 *
 * Model calls: Claude Code writes several `assistant` records for one API
 * response (one per streamed content block). They share `message.id` and
 * `requestId`, so they are collapsed into exactly one `llm.call`; the last
 * record carries the final usage. The `<synthetic>` model is not a model call
 * and is skipped for `llm.call`.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  contextTokens,
  type AgentEvent,
  type LlmCallRetry,
  type Normalizer,
  type RawRecord,
} from "@openmatel/core";

import {
  ContextTracker,
  EventScope,
  SourceEventFactory,
  ToolCallRegistry,
  applyToolOutcome,
  assignRequestIndexes,
  asBoolean,
  asNumber,
  asString,
  contentBlocks,
  createToolCall,
  discoverSessions,
  emptyUsage,
  endLineOf,
  isPlainObject,
  laterTimestamp,
  latestEventTimestamp,
  llmCallAttrs,
  parseJsonlText,
  planEntriesFrom,
  sessionStartAttrs,
  textFromContent,
  timestampOf,
  truncateTitle,
  usageFrom,
  type EventInit,
  type ParsedRecords,
  type ReadStats,
  type SessionFile,
} from "./common.js";

/** Source name of the Claude Code connector. */
export const SOURCE = "claude-code";

/** Payload format of the Claude Code connector. */
export const FORMAT = "claude-code.jsonl";

/**
 * Model sentinel Claude Code writes for messages it generated itself
 * (summaries, reminders, …). It is not a model the session talked to and
 * must never become the session/llm model.
 */
const SYNTHETIC_MODEL = "<synthetic>";

/** The real model of a message, or `undefined` for the synthetic sentinel. */
const realModel = (model: string | undefined): string | undefined =>
  model === undefined || model.trim().toLowerCase() === SYNTHETIC_MODEL ? undefined : model;


/** Top level record types this normalizer knows about. */
const KNOWN_TYPES = new Set([
  "user",
  "assistant",
  "system",
  "attachment",
  "queue-operation",
  "api-request",
  "api-request-blob",
  "api-request-shape",
  "last-prompt",
  "atis-latch",
  "ai-title",
  "cost-state",
  "summary",
]);

/** Directory below `$HOME` that holds the Claude Code projects. */
function projectsRoot(home: string): string {
  return path.join(home, ".claude", "projects");
}

/**
 * Find every Claude Code session file below `home`.
 *
 * A missing `~/.claude` directory simply yields an empty list.
 */
export async function discover(home: string = os.homedir()): Promise<SessionFile[]> {
  return discoverSessions(SOURCE, [projectsRoot(home)], (filePath) => {
    const name = path.basename(filePath);
    if (!name.endsWith(".jsonl")) return null;
    const sessionId = name.slice(0, -".jsonl".length);
    if (sessionId === "") return null;
    return { sourceSessionId: sessionId };
  });
}

/** Read and parse one session file. */
export async function readRecords(file: SessionFile): Promise<RawRecord[]> {
  const text = await readFile(file.path, "utf8");
  return parseJsonlText(text, file.source, file.path).records;
}

/** Read one session file and report how many lines were skipped. */
export async function readRecordsWithStats(
  file: SessionFile,
): Promise<{ records: RawRecord[]; stats: ReadStats }> {
  const text = await readFile(file.path, "utf8");
  const parsed: ParsedRecords = parseJsonlText(text, file.source, file.path);
  return { records: parsed.records, stats: parsed.stats };
}

/* -------------------------------------------------------------------------- */
/* Normalization                                                               */
/* -------------------------------------------------------------------------- */

/** One model call that may still receive more assistant records. */
interface PendingLlmCall {
  event: AgentEvent;
  /** Start of the API request, when an `api-request` record reported it. */
  requestStart?: string;
  /** End of the latest assistant record of the call. */
  endTs?: string;
  /** Boundaries opened by this call, whose after-size may still be updated. */
  boundaries: PendingBoundary[];
}

/** A segment boundary whose `context_tokens_after` is still unknown. */
interface PendingBoundary {
  event: AgentEvent;
  contextBefore: number | null;
}

/** State kept while walking the records of one session. */
interface ClaudeState {
  factory: SourceEventFactory;
  scope: EventScope;
  events: AgentEvent[];
  sessionStart?: AgentEvent;
  explicitTitle?: string;
  userTitle?: string;
  model?: string;
  cwd?: string;
  gitBranch?: string;
  turnIndex: number;
  turnId?: string;
  turnOpen: boolean;
  toolCalls: ToolCallRegistry;
  /** Uuids of records that belong to a side chain (a sub agent). */
  sidechainUuids: Set<string>;
  /** Records by uuid, so a side chain can find the call that spawned it. */
  byUuid: Map<string, Record<string, unknown>>;
  /** Current context segment; the first one is `seg_0`. */
  segmentIndex: number;
  segmentId: string;
  /** Last context size reported by an `llm.call`, before the next boundary. */
  lastContextTokens: number | null;
  /** Boundaries waiting for the first call of their segment. */
  pendingBoundaries: PendingBoundary[];
  /** The latest compaction boundary, so its summary can be attached later. */
  lastCompactionBoundary?: AgentEvent;
  /** Model calls by `message.id` and `requestId`, for de-duplication. */
  pendingLlmByMessage: Map<string, PendingLlmCall>;
  pendingLlmByRequest: Map<string, PendingLlmCall>;
  /** Start timestamps of `api-request` records, by request id. */
  requestStarts: Map<string, string>;
  /** Context window of a request, when the record reported one. */
  requestContextWindows: Map<string, number>;
  /** Latest `api-request` start, for files that omit `requestRef`. */
  latestRequestStart?: string;
  latestRequestContextWindow?: number;
  /** Whether the latest `api-request` has already been matched to a call. */
  latestRequestConsumed: boolean;
  /** Session id of the previous record, to notice a resumed file. */
  lastRecordSessionId?: string;
  /** `leafUuid` of a `last-prompt` that points outside this file. */
  resumeLeaf?: string;
  /** Whether a real user/assistant/system record has been seen. */
  sawConversation: boolean;
  /** Latest timestamp of any record of the file, for the closing events. */
  latestRecordTs?: string;
  /** Retry reported by a `system` error, applied to the next model call. */
  pendingRetry?: LlmCallRetry;
  /** System prompt and tool catalog snapshots of the session. */
  context: ContextTracker;
  /** Whether a `prompt_snapshot` already supplied the system prompt. */
  sawSnapshotSystem: boolean;
  /** Whether a `prompt_snapshot` already supplied the tool list. */
  sawSnapshotTools: boolean;
}

/** Create the state for one session file. */
function createState(file: SessionFile): ClaudeState {
  return {
    factory: new SourceEventFactory(file.source, file.sourceSessionId, FORMAT),
    scope: new EventScope(),
    events: [],
    turnIndex: 0,
    turnOpen: false,
    toolCalls: new ToolCallRegistry(),
    sidechainUuids: new Set(),
    byUuid: new Map(),
    segmentIndex: 0,
    segmentId: "seg_0",
    lastContextTokens: null,
    pendingBoundaries: [],
    pendingLlmByMessage: new Map(),
    pendingLlmByRequest: new Map(),
    requestStarts: new Map(),
    requestContextWindows: new Map(),
    latestRequestConsumed: false,
    sawConversation: false,
    context: new ContextTracker(),
    sawSnapshotSystem: false,
    sawSnapshotTools: false,
  };
}

/** Build an event in the segment the walker is currently in. */
function createEvent(state: ClaudeState, init: EventInit): AgentEvent {
  return state.factory.create({ ...init, segmentId: init.segmentId ?? state.segmentId });
}

/** The title of the session: an explicit title wins over the first prompt. */
function sessionTitle(state: ClaudeState): string | undefined {
  return state.explicitTitle ?? state.userTitle;
}

/** Write the title into the session start event, as soon as it is known. */
function refreshTitle(state: ClaudeState): void {
  const title = sessionTitle(state);
  if (title === undefined || state.sessionStart === undefined) return;
  state.sessionStart.attrs.title = title;
}

/** Open the next context segment and emit its boundary node. */
function openSegment(
  state: ClaudeState,
  reason: "compaction" | "resume" | "fork" | "unknown",
  ts: string,
  ref: string,
  init: { contextBefore?: number | null; summary?: string; trigger?: string } = {},
): AgentEvent {
  const parent = state.segmentId;
  state.segmentIndex += 1;
  state.segmentId = `seg_${state.segmentIndex}`;

  const contextBefore =
    init.contextBefore !== undefined ? init.contextBefore : state.lastContextTokens;

  const attrs: Record<string, unknown> = {
    reason,
    context_tokens_before: contextBefore,
    context_tokens_after: null,
    tokens_removed: null,
    parent_segment_id: parent,
    derived: false,
  };
  if (init.trigger !== undefined) attrs.trigger = init.trigger;

  const content =
    init.summary !== undefined
      ? { output: { text: init.summary }, capture: "full" as const }
      : undefined;
  if (init.summary !== undefined) attrs.summary = init.summary;

  const event = createEvent(state, {
    line: state.scope.line,
    sub: state.scope.next(),
    kind: "segment.boundary",
    ts,
    attrs,
    content,
    ref,
  });

  state.events.push(event);
  state.pendingBoundaries.push({ event, contextBefore });
  if (reason === "compaction") state.lastCompactionBoundary = event;
  return event;
}

/** Attach the compaction summary to the boundary that opened the segment. */
function attachCompactionSummary(state: ClaudeState, summary: string, ts: string, ref: string): void {
  const boundary =
    state.lastCompactionBoundary ??
    openSegment(state, "compaction", ts, ref, { contextBefore: state.lastContextTokens });
  if (summary === "") return;
  boundary.attrs.summary = summary;
  boundary.content = { output: { text: summary }, capture: "full" };
  state.lastCompactionBoundary = boundary;
}

/** Write a context size into the boundaries opened by the same call. */
function applyBoundaryContext(boundaries: PendingBoundary[], context: number | null): void {
  for (const pending of boundaries) {
    const before = pending.contextBefore;
    pending.event.attrs.context_tokens_after = context;
    pending.event.attrs.tokens_removed =
      before === null || context === null ? null : before - context;
    if (context !== null) pending.event.attrs.derived = true;
  }
}

/**
 * Close the open boundaries at the first call of their segment.
 *
 * A call whose usage is not known yet keeps its boundary list, so a later
 * record of the same call can still supply the context size. The next call
 * does not, because the boundary is already closed.
 */
function completeBoundaries(state: ClaudeState, context: number | null): PendingBoundary[] {
  const boundaries = state.pendingBoundaries;
  state.pendingBoundaries = [];
  applyBoundaryContext(boundaries, context);
  return boundaries;
}

/**
 * Open a `resume` / `fork` boundary when the records make one inferable.
 *
 * The format has no explicit resume marker. A new file that continues an old
 * conversation shows up as a `last-prompt` whose `leafUuid` is not in the
 * file, as the first record whose `parentUuid` is unknown, or as a `sessionId`
 * change inside one file. None of these can be read from a single record, so
 * they are detected while walking the whole file.
 */
function maybeOpenResumeBoundary(
  state: ClaudeState,
  data: Record<string, unknown>,
  ts: string,
  ref: string,
  isSidechain: boolean,
): void {
  if (isSidechain) return;

  const type = asString(data.type) ?? "";
  const recordSessionId = asString(data.sessionId);
  const previousSessionId = state.lastRecordSessionId;
  const subtype = asString(data.subtype);

  // These records open their own boundary; do not infer a second one here.
  const isBoundaryRecord =
    asBoolean(data.isCompactSummary) === true ||
    (type === "system" &&
      (subtype === "compact_boundary" ||
        subtype === "compaction" ||
        subtype === "resume" ||
        subtype === "session_resume" ||
        subtype === "resume_boundary" ||
        subtype === "fork" ||
        subtype === "session_fork" ||
        subtype === "fork_boundary"));
  if (isBoundaryRecord) {
    if (recordSessionId !== undefined) state.lastRecordSessionId = recordSessionId;
    return;
  }

  let reason: "resume" | "fork" | undefined;
  if (
    asBoolean(data.isFork) === true ||
    asString(data.forkedFromSessionId) !== undefined ||
    asString(data.forkedFrom) !== undefined
  ) {
    reason = "fork";
  } else if (
    asBoolean(data.isResume) === true ||
    asString(data.resumedFromSessionId) !== undefined ||
    asString(data.resumeFrom) !== undefined
  ) {
    reason = "resume";
  } else if (
    recordSessionId !== undefined &&
    previousSessionId !== undefined &&
    recordSessionId !== previousSessionId
  ) {
    reason = "resume";
  } else if (
    recordSessionId !== undefined &&
    previousSessionId === undefined &&
    recordSessionId !== state.factory.sourceSessionId &&
    (type === "user" || type === "assistant" || type === "system")
  ) {
    // The first conversation record of a new file belongs to an older
    // session: the file is a resumed continuation.
    reason = "resume";
  } else if (
    !state.sawConversation &&
    (type === "user" || type === "assistant" || type === "system")
  ) {
    const parentUuid = asString(data.parentUuid);
    if (state.resumeLeaf !== undefined) reason = "resume";
    else if (parentUuid !== undefined && !state.byUuid.has(parentUuid)) reason = "resume";
  }

  if (recordSessionId !== undefined) state.lastRecordSessionId = recordSessionId;
  if (reason === undefined) return;

  ensureSessionStart(state, data, ts, ref);
  openSegment(state, reason, ts, ref);
  state.resumeLeaf = undefined;
}

/** Emit a system prompt snapshot when it is new or changed. */
function emitSystemPrompt(
  state: ClaudeState,
  text: string,
  ts: string,
  ref: string,
): void {
  const observation = state.context.observeSystemPrompt(text);
  if (observation === undefined) return;
  state.events.push(
    createEvent(state, {
      line: state.scope.line,
      sub: state.scope.next(),
      kind: observation.kind,
      ts,
      turnId: state.turnOpen ? state.turnId : undefined,
      attrs: observation.attrs,
      content: observation.content,
      ref,
    }),
  );
}

/** Emit a tool catalog snapshot when it is new or changed. */
function emitToolCatalog(
  state: ClaudeState,
  tools: unknown,
  ts: string,
  ref: string,
): void {
  if (!Array.isArray(tools)) return;
  const observation = state.context.observeToolCatalog(tools);
  if (observation === undefined) return;
  state.events.push(
    createEvent(state, {
      line: state.scope.line,
      sub: state.scope.next(),
      kind: observation.kind,
      ts,
      turnId: state.turnOpen ? state.turnId : undefined,
      attrs: observation.attrs,
      ref,
    }),
  );
}

/**
 * Handle an `attachment` record.
 *
 * `prompt_snapshot` is the record in which Claude Code stores the system
 * prompt it assembled, and newer versions also put the tool list there.
 */
function handleAttachment(
  state: ClaudeState,
  record: Record<string, unknown>,
  ts: string,
  ref: string,
): void {
  const attachment = isPlainObject(record.attachment) ? record.attachment : undefined;
  if (attachment === undefined) return;
  if (asString(attachment.type) !== "prompt_snapshot") return;

  const systemPrompt = textFromContent(attachment.systemPrompt);
  if (systemPrompt !== "") {
    state.sawSnapshotSystem = true;
    ensureSessionStart(state, record, ts, ref);
    emitSystemPrompt(state, systemPrompt, ts, ref);
  }

  if (Array.isArray(attachment.tools)) {
    state.sawSnapshotTools = true;
    ensureSessionStart(state, record, ts, ref);
    emitToolCatalog(state, attachment.tools, ts, ref);
  }
}

/**
 * Handle an `api-request-shape` record.
 *
 * It carries the system blocks and the tool definitions of one request. It is
 * the fallback when no `prompt_snapshot` supplied that part of the context;
 * the snapshot wins so the same request is not reported twice.
 */
function handleRequestShape(
  state: ClaudeState,
  record: Record<string, unknown>,
  ts: string,
  ref: string,
): void {
  const shape = isPlainObject(record.shape) ? record.shape : undefined;
  if (shape === undefined) return;

  if (!state.sawSnapshotSystem) {
    const systemPrompt = textFromContent(shape.system);
    if (systemPrompt !== "") {
      ensureSessionStart(state, record, ts, ref);
      emitSystemPrompt(state, systemPrompt, ts, ref);
    }
  }

  if (!state.sawSnapshotTools) {
    ensureSessionStart(state, record, ts, ref);
    emitToolCatalog(state, shape.tools, ts, ref);
  }
}

/** Make sure the session start event exists. */
function ensureSessionStart(
  state: ClaudeState,
  record: Record<string, unknown>,
  ts: string,
  ref: string,
): AgentEvent {
  if (state.sessionStart) return state.sessionStart;

  const version = asString(record.version);
  const cwd = asString(record.cwd);
  const branch = asString(record.gitBranch);
  const nativeSessionId = asString(record.sessionId);

  if (version !== undefined) state.factory.version = version;
  if (cwd !== undefined) state.cwd = cwd;
  if (branch !== undefined) state.gitBranch = branch;

  const event = createEvent(state, {
    line: state.scope.line,
    sub: state.scope.next(),
    kind: "session.start",
    ts,
    attrs: sessionStartAttrs({
      harness: SOURCE,
      harnessVersion: version,
      model: state.model,
      cwd,
      gitBranch: branch,
      title: sessionTitle(state),
    }),
    ref,
  });

  const title = sessionTitle(state);
  if (title !== undefined) event.attrs.title = title;
  if (nativeSessionId !== undefined) {
    event.links = { external: { [`${SOURCE}.session_id`]: nativeSessionId } };
  }

  state.sessionStart = event;
  state.events.push(event);
  return event;
}

/** Close the running turn, if any. */
function endTurn(state: ClaudeState, ts: string, stopReason: string, ref: string): void {
  if (!state.turnOpen || state.turnId === undefined) return;
  const attrs: Record<string, unknown> = { stop_reason: stopReason };
  if (state.model !== undefined) attrs.model = state.model;
  state.events.push(
    createEvent(state, {
      line: state.scope.line,
      sub: state.scope.next(),
      kind: "turn.end",
      ts,
      turnId: state.turnId,
      attrs,
      ref,
    }),
  );
  state.turnOpen = false;
  state.turnId = undefined;
}

/** Start a new turn. */
function startTurn(state: ClaudeState, ts: string, ref: string): void {
  endTurn(state, ts, "completed", ref);
  state.turnIndex += 1;
  state.turnId = state.factory.turnIdFor(state.turnIndex);
  state.turnOpen = true;
  state.events.push(
    createEvent(state, {
      line: state.scope.line,
      sub: state.scope.next(),
      kind: "turn.start",
      ts,
      turnId: state.turnId,
      attrs: { trigger: "user" },
      ref,
    }),
  );
}

/** Handle one `user` record. */
function handleUser(
  state: ClaudeState,
  record: Record<string, unknown>,
  ts: string,
  ref: string,
  isSidechain: boolean,
): void {
  const message = isPlainObject(record.message) ? record.message : undefined;
  const blocks = contentBlocks(message?.content);

  // The synthetic summary that follows a compaction is not a user turn; it
  // belongs to the boundary that has already opened the new segment.
  if (asBoolean(record.isCompactSummary) === true) {
    ensureSessionStart(state, record, ts, ref);
    attachCompactionSummary(state, textFromContent(message?.content), ts, ref);
    return;
  }

  const toolResults = blocks.filter((block) => block.type === "tool_result");
  const contentBlocksOnly = blocks.filter((block) => block.type !== "tool_result");
  const hasUserContent = contentBlocksOnly.length > 0;

  // Results of tool calls belong to the turn that is already running.
  for (const block of toolResults) {
    const toolUseId = asString(block.tool_use_id);
    if (toolUseId === undefined) continue;
    const call = state.toolCalls.find(toolUseId);
    if (call === undefined) continue;

    const isError = asBoolean(block.is_error) ?? false;
    applyToolOutcome(call, {
      outputText: textFromContent(block.content),
      isError,
      errorMessage: isError ? textFromContent(block.content) : undefined,
      ts,
    });
  }

  // A message that only carries tool results is not an external prompt.
  if (!hasUserContent) return;
  if (asBoolean(record.isMeta) === true) return;

  ensureSessionStart(state, record, ts, ref);

  // A side chain is a sub agent: it runs inside the turn of its parent and
  // must not open a turn of its own.
  if (!isSidechain) startTurn(state, ts, ref);

  const text = textFromContent(contentBlocksOnly);
  const title = truncateTitle(text);
  if (state.userTitle === undefined && title !== "") state.userTitle = title;
  refreshTitle(state);

  state.events.push(
    createEvent(state, {
      line: state.scope.line,
      sub: state.scope.next(),
      kind: "message.user",
      ts,
      turnId: state.turnId,
      attrs: { role: "user" },
      content: { input: { text }, capture: "full" },
      ref,
    }),
  );
}

/** Usage of one assistant record. A counter the source omitted stays null. */
function assistantUsage(usageRecord: Record<string, unknown> | undefined) {
  if (usageRecord === undefined) return emptyUsage("missing");
  const details = isPlainObject(usageRecord.output_tokens_details)
    ? usageRecord.output_tokens_details
    : undefined;
  return usageFrom({
    input_tokens: asNumber(usageRecord.input_tokens) ?? null,
    output_tokens: asNumber(usageRecord.output_tokens) ?? null,
    cache_read_tokens: asNumber(usageRecord.cache_read_input_tokens) ?? null,
    cache_write_tokens: asNumber(usageRecord.cache_creation_input_tokens) ?? null,
    reasoning_tokens:
      asNumber(details?.thinking_tokens) ?? asNumber(usageRecord.thinking_tokens) ?? null,
  });
}

/** The pending model call of an assistant record, if it is a continuation. */
function findPendingLlm(
  state: ClaudeState,
  messageId: string | undefined,
  requestId: string | undefined,
): PendingLlmCall | undefined {
  if (messageId !== undefined) {
    const byMessage = state.pendingLlmByMessage.get(messageId);
    if (byMessage !== undefined) return byMessage;
  }
  if (requestId !== undefined) return state.pendingLlmByRequest.get(requestId);
  return undefined;
}

/** Add a field to `attrs.derived` without duplicating it. */
function markDerived(attrs: Record<string, unknown>, field: string): void {
  const current = Array.isArray(attrs.derived)
    ? attrs.derived.filter((value): value is string => typeof value === "string")
    : [];
  if (!current.includes(field)) attrs.derived = [...current, field];
}

/** Milliseconds between two timestamps, or `null` when either is invalid. */
function elapsedMs(start: string, end: string): number | null {
  const from = Date.parse(start);
  const to = Date.parse(end);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.max(0, to - from);
}

/** The context window reported by the record or its request, if any. */
function contextWindowOf(
  state: ClaudeState,
  record: Record<string, unknown>,
  usageRecord: Record<string, unknown> | undefined,
  requestRef: string | undefined,
): number | null {
  return (
    asNumber(usageRecord?.context_window) ??
    asNumber(usageRecord?.contextWindow) ??
    asNumber(record.context_window) ??
    asNumber(record.contextWindow) ??
    (requestRef !== undefined ? state.requestContextWindows.get(requestRef) : undefined) ??
    state.latestRequestContextWindow ??
    null
  );
}

/** Create the one `llm.call` of a model response. */
function startLlmCall(
  state: ClaudeState,
  record: Record<string, unknown>,
  message: Record<string, unknown> | undefined,
  provider: string,
  model: string | undefined,
  requestId: string | undefined,
  ts: string,
  ref: string,
): PendingLlmCall {
  const messageId = asString(message?.id);
  const requestRef = asString(record.requestRef);
  const fallbackStart = state.latestRequestConsumed ? undefined : state.latestRequestStart;
  const requestStart =
    (requestRef !== undefined ? state.requestStarts.get(requestRef) : undefined) ??
    fallbackStart;
  if (fallbackStart !== undefined) state.latestRequestConsumed = true;
  const usageRecord = isPlainObject(message?.usage) ? message.usage : undefined;
  const usage = assistantUsage(usageRecord);
  const context = contextTokens(usage);
  const contextWindow = contextWindowOf(state, record, usageRecord, requestRef);
  const attrs = llmCallAttrs({
    provider,
    model,
    contextTokens: context,
    stopReason: asString(message?.stop_reason),
    latencyMs: requestStart !== undefined ? elapsedMs(requestStart, ts) : null,
    ttftMs: null,
    retry: state.pendingRetry ?? null,
    requestId,
    contextWindow,
    derived: requestStart !== undefined ? ["latency_ms"] : [],
  });
  state.pendingRetry = undefined;
  // The contract lists these fields even when the source did not report them.
  attrs.request_id = requestId ?? null;
  attrs.context_window = contextWindow;

  const sub = state.scope.next();
  const event = createEvent(state, {
    line: state.scope.line,
    sub,
    kind: "llm.call",
    ts: requestStart ?? ts,
    endTs: ts,
    turnId: state.turnId,
    stepId: state.factory.stepIdFor(state.scope.line, sub),
    attrs,
    usage,
    ref,
  });

  state.events.push(event);
  const boundaries = completeBoundaries(state, context);
  const pending: PendingLlmCall = { event, requestStart, endTs: ts, boundaries };
  if (messageId !== undefined) state.pendingLlmByMessage.set(messageId, pending);
  if (requestId !== undefined) state.pendingLlmByRequest.set(requestId, pending);
  if (context !== null) state.lastContextTokens = context;
  return pending;
}

/** Fold a later assistant record of the same response into its `llm.call`. */
function updateLlmCall(
  state: ClaudeState,
  pending: PendingLlmCall,
  record: Record<string, unknown>,
  message: Record<string, unknown> | undefined,
  provider: string | undefined,
  model: string | undefined,
  requestId: string | undefined,
  ts: string,
): void {
  const messageId = asString(message?.id);
  const usageRecord = isPlainObject(message?.usage) ? message.usage : undefined;
  if (usageRecord !== undefined) pending.event.usage = assistantUsage(usageRecord);

  const usage = pending.event.usage ?? emptyUsage("missing");
  const context = contextTokens(usage);
  const attrs = pending.event.attrs;
  attrs.context_tokens = context;

  if (provider !== undefined) attrs.provider = provider;
  if (model !== undefined) attrs.model = model;
  if (requestId !== undefined) attrs.request_id = requestId;
  if (message !== undefined && Object.prototype.hasOwnProperty.call(message, "stop_reason")) {
    attrs.stop_reason = asString(message.stop_reason) ?? null;
  }

  const requestRef = asString(record.requestRef);
  const contextWindow = contextWindowOf(state, record, usageRecord, requestRef);
  if (contextWindow !== null || attrs.context_window === undefined) {
    attrs.context_window = contextWindow;
  }

  if (pending.requestStart !== undefined) {
    const latency = elapsedMs(pending.requestStart, ts);
    attrs.latency_ms = latency;
    if (latency !== null) markDerived(attrs, "latency_ms");
  }

  pending.endTs = ts;
  pending.event.end_ts = ts;
  if (messageId !== undefined) state.pendingLlmByMessage.set(messageId, pending);
  if (requestId !== undefined) state.pendingLlmByRequest.set(requestId, pending);

  if (context !== null) {
    state.lastContextTokens = context;
    applyBoundaryContext(pending.boundaries, context);
  }
}

/** Handle one `assistant` record. */
function handleAssistant(
  state: ClaudeState,
  record: Record<string, unknown>,
  ts: string,
  ref: string,
): void {
  const message = isPlainObject(record.message) ? record.message : undefined;
  const blocks = contentBlocks(message?.content);

  const rawModel = asString(message?.model);
  const synthetic = rawModel !== undefined && rawModel.trim().toLowerCase() === SYNTHETIC_MODEL;
  const model = realModel(rawModel);
  const provider =
    asString(message?.provider) ??
    asString(record.provider) ??
    "anthropic";
  if (model !== undefined) {
    state.model = model;
    if (state.sessionStart) state.sessionStart.attrs.model = model;
  }

  ensureSessionStart(state, record, ts, ref);

  // The model call itself. Several assistant records belong to one response;
  // the `<synthetic>` sentinel is not a model call at all.
  if (!synthetic) {
    const messageId = asString(message?.id);
    const requestId = asString(record.requestId);
    let pending = findPendingLlm(state, messageId, requestId);
    if (pending === undefined) {
      pending = startLlmCall(state, record, message, provider, model, requestId, ts, ref);
    } else {
      updateLlmCall(state, pending, record, message, provider, model, requestId, ts);
    }
  }

  // Reasoning.
  const thinking = blocks
    .filter((block) => block.type === "thinking")
    .map((block) => asString(block.thinking) ?? asString(block.text) ?? "")
    .filter((text) => text !== "");
  if (thinking.length > 0) {
    state.events.push(
      createEvent(state, {
        line: state.scope.line,
        sub: state.scope.next(),
        kind: "reasoning",
        ts,
        turnId: state.turnId,
        attrs: { role: "assistant" },
        content: { output: { text: thinking.join("\n") }, capture: "full" },
        ref,
      }),
    );
  }

  // The answer.
  const texts = blocks
    .filter((block) => block.type === "text")
    .map((block) => asString(block.text) ?? "")
    .filter((text) => text !== "");
  if (texts.length > 0) {
    state.events.push(
      createEvent(state, {
        line: state.scope.line,
        sub: state.scope.next(),
        kind: "message.agent",
        ts,
        turnId: state.turnId,
        attrs: { role: "assistant" },
        content: { output: { text: texts.join("\n") }, capture: "full" },
        ref,
      }),
    );
  }

  // Tool calls.
  for (const block of blocks.filter((b) => b.type === "tool_use")) {
    const toolUseId = asString(block.id);
    const toolName = asString(block.name);
    if (toolUseId === undefined || toolName === undefined) continue;

    const input = isPlainObject(block.input) ? block.input : undefined;
    const { call, events } = createToolCall(state.factory, {
      callId: toolUseId,
      toolName,
      args: input,
      rawArgs: block.input,
      ts,
      line: state.scope.line,
      sub: state.scope.next(),
      turnId: state.turnId,
      ref,
      cwd: state.cwd,
      scope: state.scope,
    });
    state.toolCalls.register(call);
    state.events.push(...events);

    // TodoWrite carries the plan of the agent.
    if (/todo/i.test(toolName)) {
      const entries = planEntriesFrom(input);
      if (entries.length > 0) {
        state.events.push(
          createEvent(state, {
            line: state.scope.line,
            sub: state.scope.next(),
            kind: "plan.update",
            ts,
            turnId: state.turnId,
            attrs: { entries },
            ref,
          }),
        );
      }
    }
  }
}

/** Handle one `system` record. */
function handleSystem(state: ClaudeState, record: Record<string, unknown>, ts: string, ref: string): void {
  const subtype = asString(record.subtype);
  if (subtype === "api_error") {
    const error = isPlainObject(record.error) ? record.error : undefined;
    const message = asString(error?.message) ?? asString(error?.formatted) ?? "api error";
    const attrs: Record<string, unknown> = { reason: message };
    const attempt = asNumber(record.retryAttempt);
    if (attempt !== undefined) attrs.retry_attempt = attempt;
    const maxRetries = asNumber(record.maxRetries);
    if (maxRetries !== undefined) attrs.max_retries = maxRetries;
    const errorCode = asString(error?.code) ?? asString(error?.type) ?? asString(record.error);
    if (attempt !== undefined) {
      state.pendingRetry = {
        attempt: Math.max(1, Math.trunc(attempt)),
        max_attempts:
          maxRetries !== undefined ? Math.max(1, Math.trunc(maxRetries)) : null,
        delay_ms: null,
        error_code: errorCode ?? null,
      };
    }
    state.events.push(
      createEvent(state, {
        line: state.scope.line,
        sub: state.scope.next(),
        kind: "control.retry",
        ts,
        turnId: state.turnId,
        status: "error",
        error: { type: "api_error", message, retryable: true },
        attrs,
        ref,
      }),
    );
    return;
  }
  if (subtype === "compact_boundary" || subtype === "compaction") {
    const metadata = isPlainObject(record.compactMetadata) ? record.compactMetadata : undefined;
    const preTokens =
      asNumber(metadata?.preTokens) ??
      asNumber(metadata?.pre_tokens) ??
      asNumber(record.preTokens);
    const summary =
      asString(metadata?.summary) ??
      asString(record.summary) ??
      (typeof record.content === "string" ? record.content : undefined);
    ensureSessionStart(state, record, ts, ref);
    openSegment(state, "compaction", ts, ref, {
      contextBefore: state.lastContextTokens ?? preTokens ?? null,
      summary,
      trigger: asString(metadata?.trigger),
    });
    return;
  }
  if (subtype === "resume" || subtype === "session_resume" || subtype === "resume_boundary") {
    ensureSessionStart(state, record, ts, ref);
    openSegment(state, "resume", ts, ref);
    return;
  }
  if (subtype === "fork" || subtype === "session_fork" || subtype === "fork_boundary") {
    ensureSessionStart(state, record, ts, ref);
    openSegment(state, "fork", ts, ref);
  }
}

/**
 * Handle a record that belongs to a side chain — a sub agent.
 *
 * Claude Code writes the sub agent's conversation into the same file, marked
 * with `isSidechain: true`. The chain is rooted at the assistant message that
 * issued the `Task`/`Agent` tool call, so the spawn event can name the agent
 * and the task it was given.
 */
function handleSidechain(state: ClaudeState, record: Record<string, unknown>, ts: string, ref: string): void {
  const uuid = asString(record.uuid);
  const parentUuid = asString(record.parentUuid);

  // The chain continues when the parent is itself part of a side chain.
  const continuesChain =
    uuid !== undefined && parentUuid !== undefined && state.sidechainUuids.has(parentUuid);

  if (continuesChain) {
    if (uuid !== undefined) state.sidechainUuids.add(uuid);
    return;
  }

  // A new side chain starts here.
  if (uuid !== undefined) state.sidechainUuids.add(uuid);

  const parent = parentUuid !== undefined ? state.byUuid.get(parentUuid) : undefined;
  const spawn = findSpawnToolUse(parent);

  const attrs: Record<string, unknown> = {};
  if (spawn?.agentName !== undefined) attrs.agent_name = spawn.agentName;
  if (spawn?.task !== undefined) attrs.task = spawn.task;

  state.events.push(
    createEvent(state, {
      line: state.scope.line,
      sub: state.scope.next(),
      kind: "subagent.spawn",
      ts,
      turnId: state.turnId,
      attrs,
      ref,
    }),
  );
}

/** Find the `Task`/`Agent` tool call that spawned a side chain. */
function findSpawnToolUse(
  parent: Record<string, unknown> | undefined,
): { agentName?: string; task?: string } | undefined {
  if (!parent) return undefined;
  const message = isPlainObject(parent.message) ? parent.message : undefined;
  const blocks = contentBlocks(message?.content);
  for (const block of blocks) {
    if (block.type !== "tool_use") continue;
    const name = asString(block.name);
    if (name !== "Task" && name !== "Agent" && name !== "task") continue;
    const input = isPlainObject(block.input) ? block.input : undefined;
    const agentName = asString(input?.subagent_type) ?? asString(input?.agent_type);
    const task = asString(input?.description) ?? asString(input?.prompt);
    return { agentName, task };
  }
  return undefined;
}

/** Handle one record of any type. */
function handleRecord(state: ClaudeState, record: RawRecord): void {
  const data = record.data;
  if (!isPlainObject(data)) return;

  const line = record.line ?? 0;
  const ref = record.ref;
  state.scope.begin(line);

  const type = asString(data.type) ?? "";
  const recordTs = timestampOf(data.timestamp, data.createdAt);
  const ts = recordTs ?? new Date(0).toISOString();
  state.latestRecordTs = laterTimestamp(state.latestRecordTs, recordTs);

  const isSidechain = asBoolean(data.isSidechain) === true;
  maybeOpenResumeBoundary(state, data, ts, ref, isSidechain);
  if (isSidechain) {
    handleSidechain(state, data, ts, ref);
  } else if (type === "user" || type === "assistant" || type === "system") {
    state.sawConversation = true;
  }

  switch (type) {
    case "user":
      handleUser(state, data, ts, ref, isSidechain);
      break;
    case "assistant":
      handleAssistant(state, data, ts, ref);
      break;
    case "system":
      handleSystem(state, data, ts, ref);
      break;
    case "ai-title": {
      const title = asString(data.aiTitle);
      if (title !== undefined && title !== "") {
        state.explicitTitle = truncateTitle(title);
        refreshTitle(state);
      }
      break;
    }
    case "summary": {
      const summary = asString(data.summary);
      if (summary !== undefined && summary !== "" && state.explicitTitle === undefined) {
        state.explicitTitle = truncateTitle(summary);
        refreshTitle(state);
      }
      break;
    }
    case "api-request": {
      const requestId = asString(data.id);
      const start = timestampOf(data.timestamp, data.createdAt);
      if (requestId !== undefined && start !== undefined) {
        state.requestStarts.set(requestId, start);
        state.latestRequestStart = start;
        state.latestRequestConsumed = false;
      }
      const params = isPlainObject(data.params) ? data.params : undefined;
      const contextWindow =
        asNumber(params?.context_window) ?? asNumber(params?.contextWindow);
      if (requestId !== undefined && contextWindow !== undefined) {
        state.requestContextWindows.set(requestId, contextWindow);
      }
      if (contextWindow !== undefined) state.latestRequestContextWindow = contextWindow;
      break;
    }
    case "last-prompt": {
      const leafUuid = asString(data.leafUuid);
      if (leafUuid !== undefined && !state.byUuid.has(leafUuid)) {
        state.resumeLeaf = leafUuid;
      } else if (leafUuid !== undefined) {
        state.resumeLeaf = undefined;
      }
      break;
    }
    case "attachment": {
      handleAttachment(state, data, ts, ref);
      break;
    }
    case "api-request-shape": {
      handleRequestShape(state, data, ts, ref);
      break;
    }
    case "queue-operation":
    case "api-request-blob":
    case "atis-latch":
    case "cost-state":
      break;
    default: {
      if (type !== "" && !KNOWN_TYPES.has(type)) {
        state.events.push(
          createEvent(state, {
            line,
            sub: state.scope.next(),
            kind: "raw.unknown",
            ts,
            attrs: { record_type: type },
            ref,
          }),
        );
      }
      break;
    }
  }

  const uuid = asString(data.uuid);
  if (uuid !== undefined) state.byUuid.set(uuid, data);
}

/** Close the session: the last turn, the open tool calls and the session end. */
function finalize(state: ClaudeState, file: SessionFile, endLine: number): void {
  // Events that belong to the file as a whole are placed one line past the
  // last record, so their ids cannot collide with the events of a record.
  // The file mtime is not part of the trace: a file touched later must not
  // invent an idle gap at the end of the session.
  const endTs =
    state.latestRecordTs ??
    new Date(file.mtimeMs > 0 ? file.mtimeMs : 0).toISOString();
  state.scope.begin(endLine);

  // A session that never had a message still has a start.
  if (state.sessionStart === undefined) {
    ensureSessionStart(state, {}, endTs, file.path);
  }

  // Close the running turn at its last event, not at the file mtime. The
  // scope keeps counting, so the id of this event cannot collide with the
  // events of the last record.
  const turnEndTs =
    state.turnOpen && state.turnId !== undefined
      ? latestEventTimestamp(state.events, state.turnId) ?? endTs
      : endTs;
  endTurn(state, turnEndTs, "end_of_session", file.path);

  // Tool calls without a result keep their call time and no output.
  for (const call of state.toolCalls.all()) {
    if (call.resolved) continue;
    if (call.event.status === undefined) call.event.status = "ok";
  }

  const attrs: Record<string, unknown> = { end_reason: "end_of_file" };
  const title = sessionTitle(state);
  if (title !== undefined) attrs.title = title;

  state.events.push(
    createEvent(state, {
      line: endLine,
      sub: state.scope.next(),
      kind: "session.end",
      ts: endTs,
      attrs,
      ref: file.path,
    }),
  );
}

/**
 * Normalize the records of one Claude Code session.
 *
 * The records are walked in order, keeping the state the mapping needs:
 * the running turn, the tool calls waiting for their result and the title of
 * the session.
 */
export function normalizeFile(file: SessionFile, records: RawRecord[]): AgentEvent[] {
  const state = createState(file);

  for (const record of records) {
    try {
      handleRecord(state, record);
    } catch {
      // A broken record must never break the whole session.
    }
  }

  finalize(state, file, endLineOf(records));
  return assignRequestIndexes(state.events);
}

/** Build a minimal session file for a record that arrives without one. */
function minimalFile(record: RawRecord): SessionFile {
  const filePath = record.ref.split("#")[0] ?? record.ref;
  const name = path.basename(filePath);
  const sourceSessionId = name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : name;
  return {
    source: SOURCE,
    path: filePath,
    size: 0,
    mtimeMs: 0,
    sourceSessionId,
  };
}

/**
 * The Claude Code normalizer.
 *
 * `normalize` works on a single record and therefore has no session context:
 * use {@link normalizeFile} to normalize a whole file with the state the
 * mapping needs.
 */
export const claudeCodeNormalizer: Normalizer = {
  accepts: (raw: RawRecord): boolean => raw.source === SOURCE,
  schema: { source: SOURCE, version: "1" },
  normalize: (raw: RawRecord): AgentEvent[] => {
    const file = minimalFile(raw);
    const state = createState(file);
    try {
      handleRecord(state, raw);
    } catch {
      // A broken record must never break the whole session.
    }
    return assignRequestIndexes(state.events);
  },
};

export type { SessionFile } from "./common.js";
