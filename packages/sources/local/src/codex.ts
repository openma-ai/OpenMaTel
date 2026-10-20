/**
 * Codex — `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<session-uuid>.jsonl`.
 *
 * The file is a JSONL log of one session. Every line has a `type` and most of
 * them carry a `payload`:
 *
 * - `session_meta` — the header of the session: working directory, CLI
 *   version, git branch and the model provider;
 * - `turn_context` — the context of the running turn, e.g. the model;
 * - `event_msg` — what the CLI reported to the user: `task_started`,
 *   `task_complete`, `token_count` and the `item_completed` projections of
 *   the items (a user message, an agent message, a command execution, …);
 * - `response_item` — the items of the conversation itself: a `message` with
 *   role `user`/`assistant`, a `reasoning`, a `custom_tool_call` /
 *   `function_call` and the matching `*_output`;
 * - `token_usage_record` — the token counts of one model response;
 * - `compacted` — a context compaction checkpoint. It opens a new segment and
 *   carries the summary of the context the model now sees.
 *
 * Turns: a real user message opens a turn and `task_complete` closes it.
 * `task_started` and `turn_context` are harness bookkeeping and do not open a
 * turn by themselves (design §15.2).
 *
 * The model calls are reconstructed from the items: a response that produced a
 * message, a reasoning or a tool call opens one `llm.call`, and the usage that
 * the CLI reports afterwards completes it. Codex counts the cached input
 * inside `input_tokens`, so the canonical uncached input is the difference
 * (design §15.5). A response without a usage report keeps
 * `usage: { source: "missing" }` — never a zero.
 */

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  FIRST_SEGMENT_ID,
  contextTokens,
  type AgentEvent,
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
  createToolCall,
  discoverSessions,
  emptyUsage,
  endLineOf,
  isPlainObject,
  laterTimestamp,
  latestEventTimestamp,
  llmCallAttrs,
  parseJsonObject,
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

/** Source name of the Codex connector. */
export const SOURCE = "codex";

/** Payload format of the Codex connector. */
export const FORMAT = "codex.jsonl";

/** The session id the CLI puts into the file name. */
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** The name of a rollout file. */
const ROLLOUT_PATTERN = /^rollout-.*\.jsonl$/;

/** Directory below `$HOME` that holds the Codex sessions. */
function sessionsRoot(home: string): string {
  return path.join(home, ".codex", "sessions");
}

/**
 * Find every Codex session file below `home`.
 *
 * A missing `~/.codex` directory simply yields an empty list.
 */
export async function discover(home: string = os.homedir()): Promise<SessionFile[]> {
  return discoverSessions(SOURCE, [sessionsRoot(home)], (filePath) => {
    const name = path.basename(filePath);
    if (!ROLLOUT_PATTERN.test(name)) return null;
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
/* Tool inputs                                                                 */
/* -------------------------------------------------------------------------- */

/** What a Codex tool call told the normalizer. */
interface CodexToolInput {
  /** The effective tool name, e.g. `apply_patch` instead of `exec`. */
  name: string;
  /** Parsed arguments, when they could be parsed. */
  args: Record<string, unknown> | undefined;
  /** The arguments exactly as Codex wrote them. */
  rawArgs: unknown;
}

/** The tool Codex wrapped into a free form call. */
const INNER_TOOL = /tools\.([A-Za-z0-9_]+)\s*\(/;

/** `cmd: "…"` inside a free form call. */
const COMMAND_ARG = /cmd\s*:\s*"((?:[^"\\]|\\.)*)"/;

/** The file a patch touches. */
const PATCH_FILE = /\*\*\* (Add|Update|Delete) File: ([^\n\r*]+)/;

/**
 * Read the argument of a call, from the opening parenthesis on.
 *
 * Returns the text between the parentheses, e.g. `{cmd:"ls"}`.
 */
function balancedArgument(text: string, openIndex: number): string | undefined {
  let depth = 0;
  let quote: string | undefined;

  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== undefined) {
      if (char === "\\") {
        index += 1;
        continue;
      }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "{" || char === "[") {
      depth += 1;
      continue;
    }
    if (char === ")" || char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) return text.slice(openIndex + 1, index);
    }
  }
  return undefined;
}

/** Unescape a JSON string literal. */
function unescapeString(literal: string): string {
  try {
    const parsed: unknown = JSON.parse(`"${literal}"`);
    return typeof parsed === "string" ? parsed : literal;
  } catch {
    return literal;
  }
}

/**
 * Read the arguments of a Codex tool call.
 *
 * Codex writes two kinds of calls: a plain JSON object, and a free form
 * string that wraps the real tool, e.g.
 * `text(await tools.exec_command({cmd:"ls"}))`. The free form form is unpacked
 * as far as possible, so the call still knows which command it ran and which
 * file it edited.
 */
function parseCodexToolInput(name: string, raw: unknown): CodexToolInput {
  if (isPlainObject(raw)) return { name, args: raw, rawArgs: raw };
  if (typeof raw !== "string") return { name, args: undefined, rawArgs: raw };

  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    const parsed = parseJsonObject(trimmed);
    if (parsed !== undefined) return { name, args: parsed, rawArgs: raw };
  }

  const inner = INNER_TOOL.exec(trimmed);
  if (!inner) return { name, args: undefined, rawArgs: raw };

  const innerName = inner[1];
  const openIndex = trimmed.indexOf("(", inner.index);
  const argument = openIndex === -1 ? undefined : balancedArgument(trimmed, openIndex);
  if (argument === undefined) return { name, args: undefined, rawArgs: raw };

  // `tools.apply_patch("*** Begin Patch …")`
  if (innerName === "apply_patch") {
    const args: Record<string, unknown> = { patch: argument };
    const file = PATCH_FILE.exec(argument);
    if (file) {
      args.file_path = file[2].trim();
      args.op = file[1] === "Add" ? "create" : file[1] === "Delete" ? "delete" : "modify";
    }
    return { name: innerName, args, rawArgs: raw };
  }

  // `tools.exec_command({cmd:"ls", …})`
  const command = COMMAND_ARG.exec(argument);
  if (command) {
    return { name, args: { cmd: unescapeString(command[1]) }, rawArgs: raw };
  }

  const parsed = argument.trim().startsWith("{") ? parseJsonObject(argument) : undefined;
  return { name, args: parsed, rawArgs: raw };
}

/* -------------------------------------------------------------------------- */
/* Normalization                                                               */
/* -------------------------------------------------------------------------- */

/** State kept while walking the records of one session. */
interface CodexState {
  factory: SourceEventFactory;
  scope: EventScope;
  events: AgentEvent[];
  sessionStart?: AgentEvent;
  explicitTitle?: string;
  userTitle?: string;
  model?: string;
  provider?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  nativeSessionId?: string;
  /** Segment every new event belongs to (design §15.1). */
  segmentId: string;
  /** Index of the running segment; the first one is `seg_0`. */
  segmentIndex: number;
  /** Last known context size of a model call, for a boundary's "before". */
  lastContextTokens: number | null;
  /** Boundaries whose "first call after" has not been seen yet. */
  pendingBoundaries: AgentEvent[];
  /** Context window the harness reported, used until a call reports its own. */
  contextWindow?: number;
  turnIndex: number;
  turnId?: string;
  turnOpen: boolean;
  toolCalls: ToolCallRegistry;
  /** The model call that waits for its usage report. */
  pendingLlm?: AgentEvent;
  /** The most recently completed model call, for late `token_count` data. */
  lastLlm?: AgentEvent;
  /** A tool result closed the previous response; the next item opens a new call. */
  responseClosed: boolean;
  /** System prompt and tool catalog snapshots of the session. */
  context: ContextTracker;
  /** The user messages that were already emitted, per turn. */
  seenUserTexts: Set<string>;
  /** Latest timestamp of any record of the file, for the closing events. */
  latestRecordTs?: string;
}

/** Create the state for one session file. */
function createState(file: SessionFile): CodexState {
  return {
    factory: new SourceEventFactory(file.source, file.sourceSessionId, FORMAT),
    scope: new EventScope(),
    events: [],
    context: new ContextTracker(),
    segmentId: FIRST_SEGMENT_ID,
    segmentIndex: 0,
    lastContextTokens: null,
    pendingBoundaries: [],
    turnIndex: 0,
    turnOpen: false,
    toolCalls: new ToolCallRegistry(),
    responseClosed: false,
    seenUserTexts: new Set(),
  };
}

/** The title of the session: an explicit title wins over the first prompt. */
function sessionTitle(state: CodexState): string | undefined {
  return state.explicitTitle ?? state.userTitle;
}

/** Write the title into the session start event, as soon as it is known. */
function refreshTitle(state: CodexState): void {
  const title = sessionTitle(state);
  if (title === undefined || state.sessionStart === undefined) return;
  state.sessionStart.attrs.title = title;
}

/** Make sure the session start event exists. */
function ensureSessionStart(
  state: CodexState,
  ts: string,
  ref: string,
  extra?: Record<string, unknown>,
): AgentEvent {
  if (state.sessionStart) return state.sessionStart;

  const event = state.factory.create({
    line: state.scope.line,
    sub: state.scope.next(),
    segmentId: state.segmentId,
    kind: "session.start",
    ts,
    attrs: sessionStartAttrs({
      harness: SOURCE,
      harnessVersion: state.version,
      model: state.model,
      cwd: state.cwd,
      gitBranch: state.gitBranch,
      title: sessionTitle(state),
      extra,
    }),
    ref,
  });

  if (state.nativeSessionId !== undefined) {
    event.links = { external: { [`${SOURCE}.session_id`]: state.nativeSessionId } };
  }

  state.sessionStart = event;
  state.events.push(event);
  return event;
}

/** Start a new turn. */
function startTurn(state: CodexState, ts: string, ref: string, trigger: string): void {
  state.turnIndex += 1;
  state.turnId = state.factory.turnIdFor(state.turnIndex);
  state.turnOpen = true;
  // A call that never received a usage report belongs to the previous turn.
  state.pendingLlm = undefined;
  state.responseClosed = false;
  // Codex reports a user message twice — as an item of the conversation and as
  // an event of the CLI. Remember the texts of the running turn so the second
  // report is not emitted again.
  state.seenUserTexts = new Set();
  state.events.push(
    state.factory.create({
      line: state.scope.line,
      sub: state.scope.next(),
      segmentId: state.segmentId,
      kind: "turn.start",
      ts,
      turnId: state.turnId,
      attrs: { trigger },
      ref,
    }),
  );
}

/** Close the running turn, if any. */
function endTurn(state: CodexState, ts: string, ref: string, stopReason: string): void {
  if (!state.turnOpen || state.turnId === undefined) return;
  const attrs: Record<string, unknown> = { stop_reason: stopReason };
  if (state.model !== undefined) attrs.model = state.model;
  state.events.push(
    state.factory.create({
      line: state.scope.line,
      sub: state.scope.next(),
      segmentId: state.segmentId,
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

/**
 * The model call of the response that is being assembled.
 *
 * Codex reports the usage of a response *after* the items of that response,
 * so the call is created when the first item shows up and completed when the
 * usage arrives.
 */
function ensureLlmCall(
  state: CodexState,
  ts: string,
  ref: string,
  call?: { provider?: string | undefined; model?: string | undefined },
): AgentEvent {
  if (state.pendingLlm !== undefined) return state.pendingLlm;

  const attrs = llmCallAttrs({
    provider: call?.provider ?? state.provider,
    model: call?.model ?? state.model,
    contextWindow: state.contextWindow ?? null,
  });
  // The contract lists these keys even when Codex does not provide them.
  attrs.request_id = null;
  attrs.derived = [];

  const event = state.factory.create({
    line: state.scope.line,
    sub: state.scope.next(),
    segmentId: state.segmentId,
    kind: "llm.call",
    ts,
    turnId: state.turnId,
    attrs,
    usage: emptyUsage("missing"),
    ref,
  });
  state.events.push(event);
  state.pendingLlm = event;
  state.responseClosed = false;
  return event;
}

/** The first numeric value of a list of candidate fields. */
function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const number = asNumber(value);
    if (number !== undefined) return number;
  }
  return undefined;
}

/** An optional numeric attribute of an event, or `null` when unknown. */
function attrNumber(event: AgentEvent, key: string): number | null {
  return asNumber(event.attrs[key]) ?? null;
}

/** Fill the "first call after" values of the boundaries that are still open. */
function closePendingBoundaries(state: CodexState, context: number | null): void {
  for (const boundary of state.pendingBoundaries) {
    const before = attrNumber(boundary, "context_tokens_before");
    boundary.attrs.context_tokens_after = context;
    boundary.attrs.tokens_removed =
      before !== null && context !== null ? before - context : null;
  }
  state.pendingBoundaries = [];
}

/**
 * Complete the model call with the usage the CLI reported.
 *
 * Codex counts the cached input inside `input_tokens`; the canonical usage
 * field is the uncached input, so the cached part is subtracted. Missing
 * numbers stay `null`, while a reported zero stays a zero.
 */
function applyUsage(
  state: CodexState,
  usage: Record<string, unknown> | undefined,
  requestId?: string,
  contextWindow?: number,
  call?: { provider?: string | undefined; model?: string | undefined },
): void {
  const pending = state.pendingLlm;
  if (pending === undefined) return;

  if (call?.provider !== undefined) pending.attrs.provider = call.provider;
  if (call?.model !== undefined) pending.attrs.model = call.model;
  if (contextWindow !== undefined) {
    state.contextWindow = contextWindow;
    pending.attrs.context_window = contextWindow;
  } else if (pending.attrs.context_window === null && state.contextWindow !== undefined) {
    pending.attrs.context_window = state.contextWindow;
  }
  if (requestId !== undefined) pending.attrs.request_id = requestId;

  if (usage === undefined) return;

  const input = firstNumber(usage.input_tokens);
  const cacheRead = firstNumber(
    usage.cached_input_tokens,
    usage.cache_read_input_tokens,
    usage.cache_read_tokens,
  );
  const uncachedInput =
    input !== undefined && cacheRead !== undefined ? input - cacheRead : null;
  const cacheWrite = firstNumber(
    usage.cache_write_input_tokens,
    usage.cache_write_tokens,
    usage.cache_creation_input_tokens,
  );
  const output = firstNumber(usage.output_tokens, usage.completion_tokens);
  const reasoning = firstNumber(usage.reasoning_output_tokens, usage.reasoning_tokens);

  pending.usage = usageFrom(
    {
      input_tokens: uncachedInput,
      output_tokens: output ?? null,
      cache_read_tokens: cacheRead ?? null,
      cache_write_tokens: cacheWrite ?? null,
      reasoning_tokens: reasoning ?? null,
    },
    "harness",
  );

  const context = contextTokens(pending.usage);
  pending.attrs.context_tokens = context;
  if (context !== null) state.lastContextTokens = context;
  state.lastLlm = pending;
  state.pendingLlm = undefined;
  state.responseClosed = false;
  closePendingBoundaries(state, context);
}

/** Read the summary text of a compaction record, if it carries one. */
function compactionSummary(payload: Record<string, unknown>): string | undefined {
  const direct = firstString(
    payload.message,
    payload.summary,
    payload.text,
    payload.compaction_output,
    payload.summary_text,
  );
  if (direct !== undefined) return direct;

  const messageText = textFromContent(payload.message);
  if (messageText !== "") return messageText;
  const content = textFromContent(payload.content);
  if (content !== "") return content;

  const item = isPlainObject(payload.item) ? payload.item : undefined;
  if (item === undefined) return undefined;
  const itemText = firstString(item.message, item.summary, item.text);
  if (itemText !== undefined) return itemText;
  const itemMessage = textFromContent(item.message);
  if (itemMessage !== "") return itemMessage;
  const itemContent = textFromContent(item.content);
  return itemContent === "" ? undefined : itemContent;
}

/** Read the first non-empty string of a list of candidate fields. */
function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = asString(value);
    if (text !== undefined && text !== "") return text;
  }
  return undefined;
}

/**
 * Open a new segment at a context boundary (design §15.1).
 *
 * The boundary itself belongs to the new segment. Its "before" value is the
 * last context size seen on a call; its "after" value is filled in when the
 * first call of the new segment reports its usage.
 */
function emitSegmentBoundary(
  state: CodexState,
  payload: Record<string, unknown> | undefined,
  ts: string,
  ref: string,
  reason: "compaction" | "resume" | "fork" | "unknown" = "compaction",
): AgentEvent {
  const parent = state.segmentId;
  state.segmentIndex += 1;
  const segmentId = `seg_${state.segmentIndex}`;
  state.segmentId = segmentId;

  const explicitBefore = payload
    ? firstNumber(payload.context_tokens_before, payload.tokens_before)
    : undefined;
  const explicitAfter = payload
    ? firstNumber(payload.context_tokens_after, payload.tokens_after)
    : undefined;
  const before = explicitBefore ?? state.lastContextTokens;
  const after = explicitAfter ?? null;
  const explicitRemoved = payload ? firstNumber(payload.tokens_removed) : undefined;
  const summary = payload ? compactionSummary(payload) : undefined;

  const attrs: Record<string, unknown> = {
    reason,
    context_tokens_before: before ?? null,
    context_tokens_after: after,
    tokens_removed:
      explicitRemoved ?? (before !== null && after !== null ? before - after : null),
    summary: summary ?? null,
    parent_segment_id: parent,
    derived: explicitBefore === undefined || explicitAfter === undefined,
  };

  const event = state.factory.create({
    line: state.scope.line,
    sub: state.scope.next(),
    segmentId,
    kind: "segment.boundary",
    ts,
    attrs,
    content:
      summary !== undefined
        ? { output: { text: summary }, capture: "full" }
        : undefined,
    ref,
  });
  state.events.push(event);
  if (explicitAfter === undefined) state.pendingBoundaries.push(event);
  return event;
}

/** Text Codex injects as a user message; it is not something the user typed. */
function isInjectedUserText(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith("<") ||
    /^#\s*AGENTS\.md\b/i.test(trimmed) ||
    /^AGENTS\.md instructions\b/i.test(trimmed)
  );
}

/** Emit the text of a real user message — once per turn. */
function emitUserMessage(state: CodexState, text: string, ts: string, ref: string): void {
  if (text === "" || isInjectedUserText(text)) return;
  if (state.seenUserTexts.has(text)) return;

  ensureSessionStart(state, ts, ref);
  // A real user input opens the turn (design §15.2); harness bookkeeping such
  // as `task_started` or `turn_context` does not.
  if (!state.turnOpen) startTurn(state, ts, ref, "user");
  state.seenUserTexts.add(text);

  const title = truncateTitle(text);
  if (state.userTitle === undefined && title !== "") state.userTitle = title;
  refreshTitle(state);

  state.events.push(
    state.factory.create({
      line: state.scope.line,
      sub: state.scope.next(),
      segmentId: state.segmentId,
      kind: "message.user",
      ts,
      turnId: state.turnId,
      attrs: { role: "user" },
      content: { input: { text }, capture: "full" },
      ref,
    }),
  );
}

/** Emit a system prompt snapshot when it is new or changed. */
function emitSystemPrompt(
  state: CodexState,
  text: string,
  ts: string,
  ref: string,
): void {
  const observation = state.context.observeSystemPrompt(text);
  if (observation === undefined) return;
  state.events.push(
    state.factory.create({
      line: state.scope.line,
      sub: state.scope.next(),
      segmentId: state.segmentId,
      kind: observation.kind,
      ts,
      turnId: state.turnOpen ? state.turnId : undefined,
      attrs: observation.attrs,
      content: observation.content,
      ref,
    }),
  );
}

/** Emit a tool catalog snapshot when the source recorded one. */
function emitToolCatalog(
  state: CodexState,
  tools: unknown,
  ts: string,
  ref: string,
): void {
  if (!Array.isArray(tools)) return;
  const observation = state.context.observeToolCatalog(tools);
  if (observation === undefined) return;
  state.events.push(
    state.factory.create({
      line: state.scope.line,
      sub: state.scope.next(),
      segmentId: state.segmentId,
      kind: observation.kind,
      ts,
      turnId: state.turnOpen ? state.turnId : undefined,
      attrs: observation.attrs,
      ref,
    }),
  );
}

/** Handle the `session_meta` record. */
function handleSessionMeta(
  state: CodexState,
  payload: Record<string, unknown>,
  ts: string,
  ref: string,
): void {
  const cwd = asString(payload.cwd);
  if (cwd !== undefined) state.cwd = cwd;

  const version = asString(payload.cli_version);
  if (version !== undefined) state.version = version;

  const provider = asString(payload.model_provider);
  if (provider !== undefined) state.provider = provider;

  const git = isPlainObject(payload.git) ? payload.git : undefined;
  const branch = asString(git?.branch);
  if (branch !== undefined) state.gitBranch = branch;

  const baseInstructions = isPlainObject(payload.base_instructions)
    ? payload.base_instructions
    : undefined;
  const provenance = isPlainObject(baseInstructions?.provenance)
    ? baseInstructions.provenance
    : undefined;
  const model = asString(provenance?.model) ?? asString(payload.model);
  if (model !== undefined) state.model = model;

  // Codex records the effective system prompt as `base_instructions.text`.
  // The tool list is not part of the header or of `turn_context` in the
  // versions on this machine, so no tool catalog is emitted for Codex.
  const systemPrompt =
    asString(payload.base_instructions) ?? asString(baseInstructions?.text);
  if (systemPrompt !== undefined) emitSystemPrompt(state, systemPrompt, ts, ref);

  const tools =
    payload.tools ?? payload.tool_names ?? payload.available_tools ?? baseInstructions?.tools;
  emitToolCatalog(state, tools, ts, ref);

  const nativeSessionId = asString(payload.id);
  if (nativeSessionId !== undefined) state.nativeSessionId = nativeSessionId;

  if (state.version !== undefined) state.factory.version = state.version;

  const extra: Record<string, unknown> = {};
  if (provider !== undefined) extra.provider = provider;
  if (nativeSessionId !== undefined) extra.native_session_id = nativeSessionId;

  ensureSessionStart(state, ts, ref, Object.keys(extra).length > 0 ? extra : undefined);
}

/** Handle the `turn_context` record. */
function handleTurnContext(
  state: CodexState,
  payload: Record<string, unknown>,
  ts: string,
  ref: string,
): void {
  const provider = asString(payload.model_provider) ?? asString(payload.provider);
  if (provider !== undefined) state.provider = provider;
  const model = asString(payload.model);
  if (model !== undefined) {
    state.model = model;
    if (state.sessionStart) state.sessionStart.attrs.model = model;
  }
  const cwd = asString(payload.cwd);
  if (cwd !== undefined) {
    state.cwd = cwd;
    if (state.sessionStart) state.sessionStart.attrs.cwd = cwd;
  }

  // Newer turn contexts may repeat the effective prompt or the tool catalog.
  // Only a field the record actually carries is observed; the local samples
  // carry neither, so the normalizer emits nothing for them.
  const baseInstructions = isPlainObject(payload.base_instructions)
    ? payload.base_instructions
    : undefined;
  const systemPrompt =
    asString(payload.base_instructions) ?? asString(baseInstructions?.text);
  if (systemPrompt !== undefined) emitSystemPrompt(state, systemPrompt, ts, ref);
  const tools =
    payload.tools ?? payload.tool_names ?? payload.available_tools ?? baseInstructions?.tools;
  emitToolCatalog(state, tools, ts, ref);

  // `turn_context` is harness bookkeeping, not a real user input: it does not
  // open a turn (design §15.2).
}

/** Handle one `event_msg` record. */
function handleEventMsg(
  state: CodexState,
  payload: Record<string, unknown>,
  ts: string,
  ref: string,
): void {
  const type = asString(payload.type);

  switch (type) {
    case "task_started": {
      // The task opens before the prompt is written; the real user message
      // below opens the turn. The reported context window is still useful.
      const contextWindow = firstNumber(
        payload.model_context_window,
        isPlainObject(payload.info) ? payload.info.model_context_window : undefined,
      );
      if (contextWindow !== undefined) state.contextWindow = contextWindow;
      break;
    }
    case "task_complete": {
      endTurn(state, ts, ref, "completed");
      break;
    }
    case "token_count": {
      const info = isPlainObject(payload.info) ? payload.info : undefined;
      const last = isPlainObject(info?.last_token_usage) ? info.last_token_usage : undefined;
      const contextWindow = firstNumber(
        info?.model_context_window,
        payload.model_context_window,
      );
      if (contextWindow !== undefined) {
        state.contextWindow = contextWindow;
        if (state.lastLlm !== undefined) {
          state.lastLlm.attrs.context_window = contextWindow;
        }
      }
      applyUsage(
        state,
        last,
        asString(payload.response_id) ?? asString(info?.response_id),
        contextWindow,
        {
          provider:
            asString(payload.provider) ??
            asString(payload.model_provider) ??
            asString(info?.provider),
          model: asString(payload.model) ?? asString(info?.model),
        },
      );
      break;
    }
    case "context_compaction":
    case "compacted": {
      emitSegmentBoundary(state, payload, ts, ref, "compaction");
      break;
    }
    case "item_completed": {
      const item = isPlainObject(payload.item) ? payload.item : undefined;
      const itemType = asString(item?.type);
      if (itemType === "UserMessage") {
        const text = textFromContent(item?.content);
        emitUserMessage(state, text, ts, ref);
      } else if (
        itemType !== undefined &&
        (itemType === "ContextCompaction" || itemType === "Compaction")
      ) {
        emitSegmentBoundary(state, item, ts, ref, "compaction");
      }
      break;
    }
    default:
      // Every other event of the CLI is a projection of an item that is
      // already handled, or bookkeeping.
      break;
  }
}

/** Handle one `response_item` record. */
function handleResponseItem(
  state: CodexState,
  payload: Record<string, unknown>,
  ts: string,
  ref: string,
): void {
  const type = asString(payload.type);
  const role = asString(payload.role);
  const opensResponse =
    type === "reasoning" ||
    type === "custom_tool_call" ||
    type === "function_call" ||
    type === "local_shell_call" ||
    (type === "message" && role === "assistant");
  // A tool result ends the previous response. If that response never reported
  // usage, the next item still belongs to a new model call, not to the old one.
  if (opensResponse && state.pendingLlm !== undefined && state.responseClosed) {
    state.pendingLlm = undefined;
  }

  switch (type) {
    case "message": {
      if (role === "user") {
        emitUserMessage(state, textFromContent(payload.content), ts, ref);
        return;
      }
      if (role !== "assistant") return;

      ensureLlmCall(state, ts, ref, {
        provider: asString(payload.provider),
        model: asString(payload.model),
      });
      const text = textFromContent(payload.content);
      if (text === "") return;
      const phase = asString(payload.phase);
      const attrs: Record<string, unknown> = { role: "assistant" };
      if (phase !== undefined) attrs.phase = phase;
      state.events.push(
        state.factory.create({
          line: state.scope.line,
          sub: state.scope.next(),
          segmentId: state.segmentId,
          kind: "message.agent",
          ts,
          turnId: state.turnId,
          attrs,
          content: { output: { text }, capture: "full" },
          ref,
        }),
      );
      return;
    }
    case "reasoning": {
      // Even an encrypted reasoning item with no readable text belongs to a
      // model call; create the call first so its usage can be attached.
      ensureLlmCall(state, ts, ref, {
        provider: asString(payload.provider),
        model: asString(payload.model),
      });
      const text = reasoningText(payload);
      if (text === "") return;
      state.events.push(
        state.factory.create({
          line: state.scope.line,
          sub: state.scope.next(),
          segmentId: state.segmentId,
          kind: "reasoning",
          ts,
          turnId: state.turnId,
          attrs: { role: "assistant" },
          content: { output: { text }, capture: "full" },
          ref,
        }),
      );
      return;
    }
    case "custom_tool_call":
    case "function_call": {
      handleToolCall(state, payload, ts, ref);
      return;
    }
    case "custom_tool_call_output":
    case "function_call_output": {
      handleToolResult(state, payload, ts, ref);
      return;
    }
    case "local_shell_call": {
      const action = isPlainObject(payload.action) ? payload.action : undefined;
      handleToolCall(
        state,
        {
          call_id: payload.call_id,
          name: "local_shell",
          input: { command: action?.command },
        },
        ts,
        ref,
      );
      return;
    }
    default:
      break;
  }
}

/** The text of a reasoning item. */
function reasoningText(payload: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of ["summary", "content"]) {
    const blocks = Array.isArray(payload[key]) ? payload[key] : [];
    for (const block of blocks) {
      if (!isPlainObject(block)) continue;
      const text = asString(block.text);
      if (text !== undefined && text !== "") parts.push(text);
    }
  }
  return parts.join("\n");
}

/** Handle a tool call of the conversation. */
function handleToolCall(
  state: CodexState,
  payload: Record<string, unknown>,
  ts: string,
  ref: string,
): void {
  const callId = asString(payload.call_id) ?? asString(payload.id);
  if (callId === undefined) return;
  const outerName = asString(payload.name) ?? "tool";
  const { name, args, rawArgs } = parseCodexToolInput(outerName, payload.input ?? payload.arguments);

  ensureLlmCall(state, ts, ref, {
    provider: asString(payload.provider),
    model: asString(payload.model),
  });

  const { call, events } = createToolCall(state.factory, {
    callId,
    toolName: name,
    args,
    rawArgs,
    ts,
    line: state.scope.line,
    sub: state.scope.next(),
    turnId: state.turnId,
    ref,
    cwd: state.cwd,
    scope: state.scope,
  });
  // `createToolCall` is shared with the other sources and defaults to the
  // first segment; tool calls after a boundary belong to the running one.
  for (const event of events) event.segment_id = state.segmentId;
  state.toolCalls.register(call);
  state.events.push(...events);
}

/** Handle the result of a tool call. */
function handleToolResult(
  state: CodexState,
  payload: Record<string, unknown>,
  ts: string,
  ref: string,
): void {
  const callId = asString(payload.call_id);
  if (callId === undefined) return;
  const call = state.toolCalls.find(callId);
  if (call === undefined) return;

  const output = payload.output;
  const text = typeof output === "string" ? output : textFromContent(output);

  applyToolOutcome(call, {
    outputText: text,
    ts,
  });
  state.responseClosed = true;
}

/** Handle one record of any type. */
function handleRecord(state: CodexState, record: RawRecord): void {
  const data = record.data;
  if (!isPlainObject(data)) return;

  const line = record.line ?? 0;
  const ref = record.ref;
  state.scope.begin(line);

  const type = asString(data.type) ?? "";
  const payload = isPlainObject(data.payload) ? data.payload : undefined;
  const recordTs = timestampOf(data.timestamp, payload?.timestamp, data.time);
  const ts = recordTs ?? new Date(0).toISOString();
  state.latestRecordTs = laterTimestamp(state.latestRecordTs, recordTs);

  switch (type) {
    case "session_meta": {
      if (payload) handleSessionMeta(state, payload, ts, ref);
      break;
    }
    case "turn_context": {
      if (payload) handleTurnContext(state, payload, ts, ref);
      break;
    }
    case "event_msg": {
      if (payload) handleEventMsg(state, payload, ts, ref);
      break;
    }
    case "response_item": {
      if (payload) handleResponseItem(state, payload, ts, ref);
      break;
    }
    case "token_usage_record": {
      applyUsage(
        state,
        isPlainObject(payload?.usage) ? payload.usage : undefined,
        asString(payload?.response_id) ?? asString(payload?.request_id),
        undefined,
        {
          provider:
            asString(payload?.provider) ?? asString(payload?.model_provider),
          model: asString(payload?.model),
        },
      );
      break;
    }
    case "compacted": {
      // A compaction checkpoint: it opens the next segment and carries the
      // summary of the context the model now sees (design §15.1).
      emitSegmentBoundary(state, payload, ts, ref, "compaction");
      break;
    }
    case "world_state":
      // A snapshot of the sandbox; the CLI writes it for its own bookkeeping.
      break;
    default: {
      // Only a top level type the CLI does not write at all is unknown; the
      // payloads of the known types are filtered further down.
      if (type !== "") {
        state.events.push(
          state.factory.create({
            line,
            sub: state.scope.next(),
            segmentId: state.segmentId,
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
}

/** Close the session: the last turn, the open tool calls and the session end. */
function finalize(state: CodexState, file: SessionFile, endLine: number): void {
  // The file mtime is not part of the trace: use the latest record timestamp
  // so a file touched later does not invent an idle gap at the end.
  const endTs =
    state.latestRecordTs ??
    new Date(file.mtimeMs > 0 ? file.mtimeMs : 0).toISOString();
  state.scope.begin(endLine);

  if (state.sessionStart === undefined) ensureSessionStart(state, endTs, file.path);

  const turnEndTs =
    state.turnOpen && state.turnId !== undefined
      ? latestEventTimestamp(state.events, state.turnId) ?? endTs
      : endTs;
  endTurn(state, turnEndTs, file.path, "end_of_session");

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
      segmentId: state.segmentId,
      kind: "session.end",
      ts: endTs,
      attrs,
      ref: file.path,
    }),
  );
}

/**
 * Normalize the records of one Codex session.
 *
 * The records are walked in order, keeping the state the mapping needs: the
 * running turn, the model call that waits for its usage, the tool calls that
 * wait for their result and the title of the session.
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
 * The Codex normalizer.
 *
 * `normalize` works on a single record and therefore has no session context:
 * use {@link normalizeFile} to normalize a whole file with the state the
 * mapping needs.
 */
export const codexNormalizer: Normalizer = {
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
