/**
 * pi — `~/.pi/agent/sessions/<cwd-slug>/<timestamp>_<session-uuid>.jsonl`.
 *
 * The file is a JSONL log of one session. Every line has a `type`:
 *
 * - `session` — the header: version, id and working directory;
 * - `model_change` — the model the agent talks to;
 * - `thinking_level_change` — the reasoning effort of the agent;
 * - `message` — a message of the conversation. The `message.role` says what
 *   it is: `user`, `assistant`, `toolResult` or `system`.
 *
 * A message of the assistant carries the content blocks of the answer
 * (`thinking`, `text`, `toolCall`), the usage of the call and the model that
 * produced it. A message of the role `toolResult` is the result of a tool
 * call and names the call it belongs to with `toolCallId`.
 *
 * Newer pi versions also write `compaction` and `branch_summary` entries, and
 * a session header can point at the session it was forked from. Those are
 * context boundaries, not ordinary messages: they open a new `segment` and
 * become a `segment.boundary` event (design §15.1).
 *
 * Turns: every real user message starts a turn; the turn ends when the agent
 * yields (the assistant stops with a reason other than `toolUse`), or when the
 * next user message / the end of the session arrives.
 */

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  FIRST_SEGMENT_ID,
  contextTokens,
  type AgentEvent,
  type EventContent,
  type Normalizer,
  type RawRecord,
  type SegmentBoundaryReason,
} from "@openmatel/core";

import {
  EventScope,
  SourceEventFactory,
  ToolCallRegistry,
  applyToolOutcome,
  asBoolean,
  asNumber,
  asString,
  contentBlocks,
  createToolCall,
  discoverSessions,
  emptyUsage,
  endLineOf,
  isPlainObject,
  llmCallAttrs,
  parseJsonlText,
  sessionStartAttrs,
  textFromContent,
  timestampOf,
  truncateTitle,
  usageFrom,
  type ParsedRecords,
  type ReadStats,
  type SessionFile,
} from "./common.js";

/** Source name of the pi connector. */
export const SOURCE = "pi";

/** Payload format of the pi connector. */
export const FORMAT = "pi.jsonl";

/** The session id the agent puts into the file name. */
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Record types this normalizer knows about.
 *
 * The extra entries are written by newer pi versions. They are recognized so
 * they never surface as `raw.unknown`; only the ones that describe a context
 * boundary change the trace.
 */
const KNOWN_TYPES = new Set([
  "session",
  "model_change",
  "thinking_level_change",
  "message",
  "compaction",
  "branch_summary",
  "branch",
  "fork",
  "resume",
  "session_info",
  "label",
  "custom",
  "custom_message",
  "context_edit",
  "usage",
]);

/** Stop reasons after which the agent continues with another model call. */
const CONTINUES_TURN = new Set(["toolUse", "pending"]);

/** Directory below `$HOME` that holds the pi sessions. */
function sessionsRoot(home: string): string {
  return path.join(home, ".pi", "agent", "sessions");
}

/**
 * Find every pi session file below `home`.
 *
 * A missing `~/.pi` directory simply yields an empty list.
 */
export async function discover(home: string = os.homedir()): Promise<SessionFile[]> {
  return discoverSessions(SOURCE, [sessionsRoot(home)], (filePath) => {
    const name = path.basename(filePath);
    if (!name.endsWith(".jsonl")) return null;
    const match = UUID_PATTERN.exec(name);
    const sourceSessionId = match ? match[0] : name.slice(0, -".jsonl".length);
    if (sourceSessionId === "") return null;
    return { sourceSessionId };
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

/** State kept while walking the records of one session. */
interface PiState {
  factory: SourceEventFactory;
  scope: EventScope;
  events: AgentEvent[];
  sessionStart?: AgentEvent;
  explicitTitle?: string;
  userTitle?: string;
  model?: string;
  provider?: string;
  cwd?: string;
  version?: string;
  nativeSessionId?: string;
  turnIndex: number;
  turnId?: string;
  turnOpen: boolean;
  toolCalls: ToolCallRegistry;
  /** First segment is `seg_0`; a boundary opens `seg_1`, `seg_2`, … */
  segmentIndex: number;
  segmentId: string;
  /** Last context size a model call reported, if any. */
  lastContextTokens: number | null;
  /** Context window of the model, when the source reported one. */
  contextWindow?: number;
  /** Boundaries whose `context_tokens_after` waits for the next call. */
  pendingBoundaries: PendingBoundary[];
}

interface PendingBoundary {
  event: AgentEvent;
  before: number | null;
}

/** Create the state for one session file. */
function createState(file: SessionFile): PiState {
  return {
    factory: new SourceEventFactory(file.source, file.sourceSessionId, FORMAT),
    scope: new EventScope(),
    events: [],
    turnIndex: 0,
    turnOpen: false,
    toolCalls: new ToolCallRegistry(),
    segmentIndex: 0,
    segmentId: FIRST_SEGMENT_ID,
    lastContextTokens: null,
    pendingBoundaries: [],
  };
}

/** The title of the session: an explicit title wins over the first prompt. */
function sessionTitle(state: PiState): string | undefined {
  return state.explicitTitle ?? state.userTitle;
}

/** Write the title into the session start event, as soon as it is known. */
function refreshTitle(state: PiState): void {
  const title = sessionTitle(state);
  if (title === undefined || state.sessionStart === undefined) return;
  state.sessionStart.attrs.title = title;
}

/** Make sure the session start event exists. */
function ensureSessionStart(state: PiState, ts: string, ref: string): AgentEvent {
  if (state.sessionStart) return state.sessionStart;

  const extra: Record<string, unknown> = {};
  if (state.provider !== undefined) extra.provider = state.provider;
  if (state.nativeSessionId !== undefined) extra.native_session_id = state.nativeSessionId;

  const event = state.factory.create({
    line: state.scope.line,
    sub: state.scope.next(),
    kind: "session.start",
    segmentId: state.segmentId,
    ts,
    attrs: sessionStartAttrs({
      harness: SOURCE,
      harnessVersion: state.version,
      model: state.model,
      cwd: state.cwd,
      title: sessionTitle(state),
      extra: Object.keys(extra).length > 0 ? extra : undefined,
    }),
    ref,
  });

  state.sessionStart = event;
  state.events.push(event);
  return event;
}

/** Start a new turn. */
function startTurn(state: PiState, ts: string, ref: string): void {
  endTurn(state, ts, ref, "completed");
  state.turnIndex += 1;
  state.turnId = state.factory.turnIdFor(state.turnIndex);
  state.turnOpen = true;
  state.events.push(
    state.factory.create({
      line: state.scope.line,
      sub: state.scope.next(),
      kind: "turn.start",
      segmentId: state.segmentId,
      ts,
      turnId: state.turnId,
      attrs: { trigger: "user" },
      ref,
    }),
  );
}

/** Close the running turn, if any. */
function endTurn(state: PiState, ts: string, ref: string, stopReason: string): void {
  if (!state.turnOpen || state.turnId === undefined) return;
  const attrs: Record<string, unknown> = { stop_reason: stopReason };
  if (state.model !== undefined) attrs.model = state.model;
  state.events.push(
    state.factory.create({
      line: state.scope.line,
      sub: state.scope.next(),
      kind: "turn.end",
      segmentId: state.segmentId,
      ts,
      turnId: state.turnId,
      attrs,
      ref,
    }),
  );
  state.turnOpen = false;
  state.turnId = undefined;
}

/** Content of a compaction / branch summary, captured like other content. */
function summaryContent(summary: string | undefined): EventContent | undefined {
  if (summary === undefined) return undefined;
  return { output: { text: summary }, capture: "full" };
}

/**
 * Open a new segment with a `segment.boundary` event (design §15.1).
 *
 * `context_tokens_before` is the last context size a call reported; when the
 * boundary itself reports a token count (pi's `compaction.tokensBefore`) and
 * no call came before it, that value is used instead. `context_tokens_after`
 * and `tokens_removed` can only be filled once the first call after the
 * boundary is known, so the event is queued in `pendingBoundaries`.
 */
function emitSegmentBoundary(
  state: PiState,
  init: {
    ts: string;
    ref: string;
    reason: SegmentBoundaryReason;
    tokensBefore?: number | null;
    summary?: string | undefined;
  },
): AgentEvent {
  const parentSegmentId = state.segmentId;
  state.segmentIndex += 1;
  state.segmentId = `seg_${state.segmentIndex}`;

  const before = state.lastContextTokens ?? init.tokensBefore ?? null;
  const content = summaryContent(init.summary);
  const attrs: Record<string, unknown> = {
    reason: init.reason,
    context_tokens_before: before,
    context_tokens_after: null,
    tokens_removed: null,
    parent_segment_id: parentSegmentId,
    derived: false,
  };
  if (init.summary !== undefined) attrs.summary = init.summary;

  const event = state.factory.create({
    line: state.scope.line,
    sub: state.scope.next(),
    kind: "segment.boundary",
    segmentId: state.segmentId,
    ts: init.ts,
    attrs,
    content,
    ref: init.ref,
  });

  state.pendingBoundaries.push({ event, before });
  state.events.push(event);
  return event;
}

/** Fill the derived `after` / `removed` values of the pending boundaries. */
function completeBoundaries(state: PiState, context: number | null): void {
  if (state.pendingBoundaries.length === 0) return;

  for (const pending of state.pendingBoundaries) {
    pending.event.attrs.context_tokens_after = context;
    if (context !== null) {
      pending.event.attrs.derived = true;
      if (pending.before !== null) {
        pending.event.attrs.tokens_removed = pending.before - context;
      }
    }
  }
  state.pendingBoundaries = [];
}

/** Read an explicit context window from a record, when the format has one. */
function contextWindowOf(value: Record<string, unknown>): number | undefined {
  return asNumber(value.contextWindow) ?? asNumber(value.context_window);
}

/** Handle the `session` record. */
function handleSession(state: PiState, data: Record<string, unknown>, ts: string, ref: string): void {
  const version = asNumber(data.version);
  if (version !== undefined) {
    state.version = String(version);
    state.factory.version = state.version;
  }
  const cwd = asString(data.cwd);
  if (cwd !== undefined) state.cwd = cwd;
  const nativeSessionId = asString(data.id);
  if (nativeSessionId !== undefined) state.nativeSessionId = nativeSessionId;
  const contextWindow = contextWindowOf(data);
  if (contextWindow !== undefined) state.contextWindow = contextWindow;

  ensureSessionStart(state, ts, ref);

  // A session with a parent was created with /fork, /clone or
  // newSession({ parentSession }); it starts from a context checkpoint.
  const parentSession =
    asString(data.parentSession) ?? asString(data.parent_session) ?? asString(data.forkedFrom);
  if (parentSession !== undefined && state.segmentIndex === 0) {
    emitSegmentBoundary(state, { ts, ref, reason: "fork" });
  }
}

/** Handle the `model_change` record. */
function handleModelChange(
  state: PiState,
  data: Record<string, unknown>,
  ts: string,
  ref: string,
): void {
  const provider = asString(data.provider);
  if (provider !== undefined) state.provider = provider;
  const model = asString(data.modelId) ?? asString(data.model);
  if (model !== undefined) {
    state.model = model;
    if (state.sessionStart) state.sessionStart.attrs.model = model;
  }
  const contextWindow = contextWindowOf(data);
  if (contextWindow !== undefined) state.contextWindow = contextWindow;
  ensureSessionStart(state, ts, ref);
}

/** Handle a compaction entry: context was summarized into a new segment. */
function handleCompaction(
  state: PiState,
  data: Record<string, unknown>,
  ts: string,
  ref: string,
): void {
  const tokensBefore = asNumber(data.tokensBefore) ?? asNumber(data.tokens_before) ?? null;
  emitSegmentBoundary(state, {
    ts,
    ref,
    reason: "compaction",
    tokensBefore,
    summary: asString(data.summary),
  });
}

/** Handle a branch summary: pi switched to a forked branch of the tree. */
function handleBranchSummary(
  state: PiState,
  data: Record<string, unknown>,
  ts: string,
  ref: string,
): void {
  emitSegmentBoundary(state, {
    ts,
    ref,
    reason: "fork",
    summary: asString(data.summary),
  });
}

/** Handle the `message` record. */
function handleMessage(
  state: PiState,
  data: Record<string, unknown>,
  ts: string,
  ref: string,
): void {
  const message = isPlainObject(data.message) ? data.message : undefined;
  const role = asString(message?.role);

  switch (role) {
    case "user":
      handleUserMessage(state, message ?? {}, ts, ref);
      return;
    case "assistant":
      handleAssistantMessage(state, message ?? {}, ts, ref);
      return;
    case "toolResult":
      handleToolResult(state, message ?? {}, ts, ref);
      return;
    default:
      // The system message holds the instructions of the agent; it is not
      // part of the conversation.
      return;
  }
}

/** Handle a message of the user. */
function handleUserMessage(
  state: PiState,
  message: Record<string, unknown>,
  ts: string,
  ref: string,
): void {
  const text = textFromContent(message.content);
  if (text === "") return;

  ensureSessionStart(state, ts, ref);
  startTurn(state, ts, ref);

  const title = truncateTitle(text);
  if (state.userTitle === undefined && title !== "") state.userTitle = title;
  refreshTitle(state);

  state.events.push(
    state.factory.create({
      line: state.scope.line,
      sub: state.scope.next(),
      kind: "message.user",
      segmentId: state.segmentId,
      ts,
      turnId: state.turnId,
      attrs: { role: "user" },
      content: { input: { text }, capture: "full" },
      ref,
    }),
  );
}

/** Handle a message of the assistant. */
function handleAssistantMessage(
  state: PiState,
  message: Record<string, unknown>,
  ts: string,
  ref: string,
): void {
  ensureSessionStart(state, ts, ref);

  const provider = asString(message.provider);
  if (provider !== undefined) state.provider = provider;
  const model = asString(message.model);
  if (model !== undefined) {
    state.model = model;
    if (state.sessionStart) state.sessionStart.attrs.model = model;
  }

  const blocks = contentBlocks(message.content);

  // The reasoning of the model.
  const thinking = blocks
    .filter((block) => block.type === "thinking")
    .map((block) => asString(block.thinking) ?? asString(block.text) ?? "")
    .filter((text) => text !== "");
  if (thinking.length > 0) {
    state.events.push(
      state.factory.create({
        line: state.scope.line,
        sub: state.scope.next(),
        kind: "reasoning",
        segmentId: state.segmentId,
        ts,
        turnId: state.turnId,
        attrs: { role: "assistant" },
        content: { output: { text: thinking.join("\n") }, capture: "full" },
        ref,
      }),
    );
  }

  // The answer of the model.
  const answer = blocks
    .filter((block) => block.type === "text")
    .map((block) => asString(block.text) ?? "")
    .filter((text) => text !== "");
  if (answer.length > 0) {
    state.events.push(
      state.factory.create({
        line: state.scope.line,
        sub: state.scope.next(),
        kind: "message.agent",
        segmentId: state.segmentId,
        ts,
        turnId: state.turnId,
        attrs: { role: "assistant" },
        content: { output: { text: answer.join("\n") }, capture: "full" },
        ref,
      }),
    );
  }

  // The call of the model itself. pi writes one assistant message per model
  // call, so this is exactly one `llm.call` step (design §15.4–§15.5).
  const usageRecord = isPlainObject(message.usage) ? message.usage : undefined;
  const cost = usageRecord && isPlainObject(usageRecord.cost) ? usageRecord.cost : undefined;
  const stopReason =
    asString(message.stopReason) ?? asString(message.rawStopReason);
  const usage = usageRecord
    ? usageFrom(
        {
          input_tokens: asNumber(usageRecord.input) ?? null,
          output_tokens: asNumber(usageRecord.output) ?? null,
          cache_read_tokens: asNumber(usageRecord.cacheRead) ?? null,
          cache_write_tokens: asNumber(usageRecord.cacheWrite) ?? null,
          reasoning_tokens: asNumber(usageRecord.reasoning) ?? null,
          cost_usd: asNumber(cost?.total) ?? null,
          cost_source: "harness",
        },
        "harness",
      )
    : emptyUsage("missing");

  const context = contextTokens(usage);
  const contextWindow = contextWindowOf(message) ?? state.contextWindow ?? null;
  const requestId =
    asString(message.responseId) ?? asString(message.requestId) ?? asString(message.request_id);
  const llmAttrs = llmCallAttrs({
    provider: state.provider,
    model: state.model,
    contextTokens: context,
    stopReason,
    requestId,
    contextWindow,
  });
  // The contract keeps these optional keys optional, but every pi call can
  // carry them explicitly: unknown is null, never a made-up value. pi does not
  // report latency or TTFT, so both stay null and `derived` stays empty.
  if (llmAttrs.request_id === undefined) llmAttrs.request_id = null;
  if (llmAttrs.context_window === undefined) llmAttrs.context_window = null;
  llmAttrs.derived = [];

  const llmSub = state.scope.next();
  state.events.push(
    state.factory.create({
      line: state.scope.line,
      sub: llmSub,
      kind: "llm.call",
      segmentId: state.segmentId,
      ts,
      turnId: state.turnId,
      stepId: state.factory.stepIdFor(state.scope.line, llmSub),
      attrs: llmAttrs,
      usage,
      ref,
    }),
  );

  // The first call after a compaction/fork completes the boundary's derived
  // `context_tokens_after` and `tokens_removed`.
  completeBoundaries(state, context);
  if (context !== null) state.lastContextTokens = context;

  // The tools the agent used. pi writes the call and its result as two
  // messages; the result names the call it belongs to.
  for (const block of blocks.filter((entry) => entry.type === "toolCall")) {
    const callId = asString(block.id);
    const toolName = asString(block.name);
    if (callId === undefined || toolName === undefined) continue;

    const args = isPlainObject(block.arguments) ? block.arguments : undefined;

    const { call, events } = createToolCall(state.factory, {
      callId,
      toolName,
      args,
      rawArgs: block.arguments,
      ts,
      line: state.scope.line,
      sub: state.scope.next(),
      turnId: state.turnId,
      ref,
      cwd: state.cwd,
      scope: state.scope,
    });
    for (const event of events) event.segment_id = state.segmentId;
    state.toolCalls.register(call);
    state.events.push(...events);
  }

  // A call that does not ask for a tool yields control back to the user; the
  // turn is over even before the next user message arrives (design §15.2).
  if (
    state.turnOpen &&
    stopReason !== undefined &&
    !CONTINUES_TURN.has(stopReason)
  ) {
    endTurn(state, ts, ref, stopReason);
  }
}

/** Handle the result of a tool call. */
function handleToolResult(
  state: PiState,
  message: Record<string, unknown>,
  ts: string,
  ref: string,
): void {
  const callId = asString(message.toolCallId);
  if (callId === undefined) return;
  const call = state.toolCalls.find(callId);
  if (call === undefined) return;

  const text = textFromContent(message.content);
  const isError = asBoolean(message.isError) ?? false;
  const durationMs = asNumber(message.durationMs);

  applyToolOutcome(call, {
    outputText: text,
    isError,
    errorMessage: isError ? text : undefined,
    ts,
    durationMs,
  });
}

/** Handle one record of any type. */
function handleRecord(state: PiState, record: RawRecord): void {
  const data = record.data;
  if (!isPlainObject(data)) return;

  const line = record.line ?? 0;
  const ref = record.ref;
  state.scope.begin(line);

  const type = asString(data.type) ?? "";
  const ts =
    timestampOf(data.timestamp, data.time, data.createdAt) ?? new Date(0).toISOString();

  switch (type) {
    case "session": {
      handleSession(state, data, ts, ref);
      break;
    }
    case "model_change": {
      handleModelChange(state, data, ts, ref);
      break;
    }
    case "message": {
      handleMessage(state, data, ts, ref);
      break;
    }
    case "thinking_level_change": {
      // The reasoning effort of the agent; it does not change the trace.
      break;
    }
    case "compaction": {
      handleCompaction(state, data, ts, ref);
      break;
    }
    case "branch_summary":
    case "branch":
    case "fork": {
      handleBranchSummary(state, data, ts, ref);
      break;
    }
    case "resume": {
      emitSegmentBoundary(state, { ts, ref, reason: "resume" });
      break;
    }
    case "session_info": {
      const name = asString(data.name);
      if (name !== undefined && name !== "") {
        state.explicitTitle = name;
        refreshTitle(state);
      }
      break;
    }
    case "label":
    case "custom":
    case "custom_message":
    case "context_edit":
    case "usage": {
      // Recognized bookkeeping / extension records: no trace step of their
      // own. (A `usage` entry is out-of-band accounting, not a model call of
      // the conversation.)
      break;
    }
    default: {
      if (type !== "" && !KNOWN_TYPES.has(type)) {
        state.events.push(
          state.factory.create({
            line,
            sub: state.scope.next(),
            kind: "raw.unknown",
            segmentId: state.segmentId,
            ts,
            attrs: { record_type: type },
            ref,
          }),
        );
      }
      break;
    }
  }
}

/** Close the session: the last turn, the open tool calls and the session end. */
function finalize(state: PiState, file: SessionFile, endLine: number): void {
  const endTs = new Date(file.mtimeMs > 0 ? file.mtimeMs : 0).toISOString();
  state.scope.begin(endLine);

  if (state.sessionStart === undefined) ensureSessionStart(state, endTs, file.path);

  endTurn(state, endTs, file.path, "end_of_session");

  for (const call of state.toolCalls.all()) {
    if (call.resolved) continue;
    if (call.event.status === undefined) call.event.status = "ok";
  }

  const attrs: Record<string, unknown> = { end_reason: "end_of_file" };
  const title = sessionTitle(state);
  if (title !== undefined) attrs.title = title;

  state.events.push(
    state.factory.create({
      line: endLine,
      sub: state.scope.next(),
      kind: "session.end",
      segmentId: state.segmentId,
      ts: endTs,
      attrs,
      ref: file.path,
    }),
  );
}

/**
 * Normalize the records of one pi session.
 *
 * The records are walked in order, keeping the state the mapping needs: the
 * running turn, the tool calls that wait for their result and the title of the
 * session.
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
  return state.events;
}

/** Build a minimal session file for a record that arrives without one. */
function minimalFile(record: RawRecord): SessionFile {
  const filePath = record.ref.split("#")[0] ?? record.ref;
  const name = path.basename(filePath);
  const match = UUID_PATTERN.exec(name);
  const sourceSessionId = match ? match[0] : name.replace(/\.jsonl$/, "");
  return {
    source: SOURCE,
    path: filePath,
    size: 0,
    mtimeMs: 0,
    sourceSessionId,
  };
}

/**
 * The pi normalizer.
 *
 * `normalize` works on a single record and therefore has no session context:
 * use {@link normalizeFile} to normalize a whole file with the state the
 * mapping needs.
 */
export const piNormalizer: Normalizer = {
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
    return state.events;
  },
};

export type { SessionFile } from "./common.js";
