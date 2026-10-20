/**
 * dsh — `~/.dsh/sessions/<cwd-slug>/session-<session-uuid>/session.v4.jsonl.zstd`.
 *
 * The file is a JSONL log that is **compressed as a concatenation of many zstd
 * frames**: every append of the session log writes its own frame. A plain
 * `zlib.zstdDecompressSync(buffer)` only returns the *first* frame, so the
 * frames have to be split before they can be decompressed — see
 * {@link splitZstdFrames}.
 *
 * Every record has a `type` and, from the second one on, a `seq` and a `time`.
 * The interesting types are:
 *
 * - `session` — the header: version, id, working directory and the depth of
 *   the delegation the session runs in;
 * - `turn/start` and `turn/end` — the boundaries of a turn;
 * - `user/message` — a message of the user. The `source.kind` says where it
 *   comes from: only `"user"` is something the user actually typed, the other
 *   kinds are instructions and context the runtime injected;
 * - `assistant/message` — one model response, with the reasoning, the answer
 *   and the usage of the call;
 * - `tool/call` and `tool/result` — the tools the agent used, paired by the
 *   call id;
 * - `todo/write` — the plan of the agent;
 * - `llm/retry` — a model call that had to be retried;
 * - `approval/asked` and `approval/decided` — the permissions of the agent;
 * - `session/title` — the title of the session.
 *
 * Everything else (`step/start`, `step/end`, `request/header`,
 * `agent/inbox/spliced`, the `session-log-…/delivery-accepted` records, …) is
 * bookkeeping of the runtime and is skipped silently.
 */

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import {
  FIRST_SEGMENT_ID,
  contextTokens,
  type AgentEvent,
  type EventError,
  type LlmCallRetry,
  type Normalizer,
  type RawRecord,
  type Usage,
} from "@openmatel/core";

import {
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
  parseToolArguments,
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

/** Source name of the dsh connector. */
export const SOURCE = "dsh";

/** Payload format of the dsh connector. */
export const FORMAT = "dsh.jsonl.zstd";

/** The name of the session log of a dsh session. */
const LOG_NAME = /^session\.v\d+\.jsonl\.zstd$/;

/** The magic number every zstd frame starts with. */
const ZSTD_MAGIC = 0xfd2fb528;

/** Record types this normalizer knows about. */
const KNOWN_TYPES = new Set([
  "session",
  "turn/start",
  "turn/end",
  "user/message",
  "assistant/message",
  "tool/call",
  "tool/result",
  "todo/write",
  "llm/retry",
  "approval/asked",
  "approval/decided",
  "session/title",
  "request/context",
  "session/end-seed",
  "compaction/start",
  "compaction/summary",
  "compaction/end",
  "compaction/prune",
  // Bookkeeping of the runtime.
  "step/start",
  "step/end",
  "request/header",
  "system/message",
  "developer/message",
  "permission/preset",
  "sandbox/mode",
  "approval/policy",
  "agent/inbox/spliced",
  "session/title-llm-request",
  "assistant/attempt",
  "llm/retry-started",
  "web/deepseek-search-llm-request",
  "model/selection",
  "agent-preset/selected",
  "command/run",
  "command/done",
  "subagent/descriptor",
  "subagent/catalog",
  "tool/ptc-dispatch-start",
  "tool/ptc-dispatch",
  "image/offload",
  "feedback/record",
  "feedback/message-put",
  "feedback/message-delete",
  "goal/change",
  "schedule/change",
]);

/**
 * Record types that are bookkeeping of the runtime.
 *
 * dsh writes a delivery record for every message it hands to a model; the
 * name of the record depends on the provider, so they are recognized by
 * their prefix.
 */
function isNoiseType(type: string): boolean {
  return type.startsWith("session-log-");
}

/** Directory below `$HOME` that holds the dsh sessions. */
function sessionsRoot(home: string): string {
  return path.join(home, ".dsh", "sessions");
}

/**
 * Find every dsh session file below `home`.
 *
 * A missing `~/.dsh` directory simply yields an empty list.
 */
export async function discover(home: string = os.homedir()): Promise<SessionFile[]> {
  return discoverSessions(SOURCE, [sessionsRoot(home)], (filePath) => {
    const name = path.basename(filePath);
    if (!LOG_NAME.test(name)) return null;
    // The session id is the name of the directory the log lives in.
    const directory = path.basename(path.dirname(filePath));
    const match = /session-(.+)$/.exec(directory);
    const sourceSessionId = match ? match[1] : directory;
    if (sourceSessionId === "") return null;
    return { sourceSessionId };
  });
}

/* -------------------------------------------------------------------------- */
/* zstd                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Split a buffer of concatenated zstd frames into its frames.
 *
 * dsh appends one zstd frame per write, so a session log is a whole series of
 * frames. The boundaries are found by walking the frame structure of the
 * format (RFC 8878): a magic number, a frame header, a series of blocks and
 * an optional checksum. When the structure cannot be read, the buffer is cut
 * at the next magic number instead, and a segment that does not decompress is
 * dropped.
 */
export function splitZstdFrames(buffer: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  let position = 0;

  while (position + 4 <= buffer.length) {
    if (buffer.readUInt32LE(position) !== ZSTD_MAGIC) break;
    const end = frameEnd(buffer, position);
    if (end !== undefined) {
      frames.push(buffer.subarray(position, end));
      position = end;
      continue;
    }

    // The frame structure could not be read: cut at the next magic number.
    const next = nextMagic(buffer, position + 4);
    const end2 = next === -1 ? buffer.length : next;
    frames.push(buffer.subarray(position, end2));
    position = end2;
  }

  return frames;
}

/** The offset right behind the zstd frame that starts at `start`. */
function frameEnd(buffer: Buffer, start: number): number | undefined {
  let position = start + 4;
  if (position >= buffer.length) return undefined;

  const descriptor = buffer[position];
  position += 1;
  const contentSizeFlag = (descriptor >> 6) & 0x03;
  const singleSegment = (descriptor >> 5) & 0x01;
  const checksum = (descriptor >> 2) & 0x01;
  const dictionaryIdFlag = descriptor & 0x03;

  // The window descriptor is only present when the frame has no single segment.
  if (singleSegment === 0) position += 1;
  position += dictionaryIdFlag === 0 ? 0 : dictionaryIdFlag === 1 ? 1 : dictionaryIdFlag === 2 ? 2 : 4;
  position +=
    contentSizeFlag === 0 ? (singleSegment === 1 ? 1 : 0) : contentSizeFlag === 1 ? 2 : contentSizeFlag === 2 ? 4 : 8;

  for (;;) {
    if (position + 3 > buffer.length) return undefined;
    const header = buffer.readUInt32LE(position) & 0x00ffffff;
    position += 3;
    const last = (header & 0x01) === 1;
    const type = (header >> 1) & 0x03;
    const size = header >> 3;
    if (type === 3) return undefined; // Reserved block type.
    position += type === 1 ? 1 : size;
    if (last) break;
  }

  if (checksum === 1) position += 4;
  if (position > buffer.length) return undefined;
  return position;
}

/** The offset of the next zstd magic number, or `-1`. */
function nextMagic(buffer: Buffer, from: number): number {
  for (let index = from; index + 4 <= buffer.length; index += 1) {
    if (buffer.readUInt32LE(index) === ZSTD_MAGIC) return index;
  }
  return -1;
}

/**
 * Decompress a buffer of concatenated zstd frames.
 *
 * A frame that cannot be decompressed is skipped: a half written append must
 * not take the whole session down.
 */
export function decompressZstdFrames(buffer: Buffer): string {
  if (typeof zlib.zstdDecompressSync !== "function") {
    throw new Error("dsh source requires Node >= 22.15");
  }

  const parts: string[] = [];
  for (const frame of splitZstdFrames(buffer)) {
    try {
      parts.push(zlib.zstdDecompressSync(frame).toString("utf8"));
    } catch {
      // A broken frame is skipped.
    }
  }

  if (parts.length === 0) {
    // A file that is not a series of frames (or a file with an unknown
    // structure) is still worth a try as a single frame.
    try {
      parts.push(zlib.zstdDecompressSync(buffer).toString("utf8"));
    } catch {
      // Nothing to read.
    }
  }

  return parts.join("");
}

/** Read and parse one session file. */
export async function readRecords(file: SessionFile): Promise<RawRecord[]> {
  const buffer = await readFile(file.path);
  const text = decompressZstdFrames(buffer);
  return parseJsonlText(text, file.source, file.path).records;
}

/** Read one session file and report how many lines were skipped. */
export async function readRecordsWithStats(
  file: SessionFile,
): Promise<{ records: RawRecord[]; stats: ReadStats }> {
  const buffer = await readFile(file.path);
  const text = decompressZstdFrames(buffer);
  const parsed: ParsedRecords = parseJsonlText(text, file.source, file.path);
  return { records: parsed.records, stats: parsed.stats };
}

/* -------------------------------------------------------------------------- */
/* Normalization                                                               */
/* -------------------------------------------------------------------------- */

/** One compaction lifecycle, assembled from `compaction/*` and checkpoint records. */
interface DshCompaction {
  id?: string;
  before: number | null;
  started: boolean;
  turn: number | null;
  startTs?: string;
  summary?: string;
  summaryTs?: string;
  endTs?: string;
  error?: EventError;
  provider?: string;
  model?: string;
  usage?: Usage;
  callEmitted: boolean;
  boundary?: AgentEvent;
}

/** State kept while walking the records of one session. */
interface DshState {
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
  delegationDepth?: number;
  segmentIndex: number;
  segmentId: string;
  lastContextTokens: number | null;
  pendingBoundary?: AgentEvent;
  contextWindow?: number;
  pendingTurn?: { ts: string; ref: string; line: number };
  stepStarts: Map<string, number>;
  firstTokens: Map<string, number>;
  turnLlmCalls: AgentEvent[];
  compaction?: DshCompaction;
  /** Retry facts by `turn:step`, waiting for the settled call. */
  pendingRetries: Map<string, LlmCallRetry>;
  /** Error codes seen in `assistant/attempt`, by `turn:step`. */
  attemptErrors: Map<string, string>;
  turnIndex: number;
  turnId?: string;
  turnOpen: boolean;
  toolCalls: ToolCallRegistry;
  /** Latest timestamp of any record of the file, for the closing events. */
  latestRecordTs?: string;
}

/** Create the state for one session file. */
function createState(file: SessionFile): DshState {
  return {
    factory: new SourceEventFactory(file.source, file.sourceSessionId, FORMAT),
    scope: new EventScope(),
    events: [],
    segmentIndex: 0,
    segmentId: FIRST_SEGMENT_ID,
    lastContextTokens: null,
    stepStarts: new Map(),
    firstTokens: new Map(),
    turnLlmCalls: [],
    pendingRetries: new Map(),
    attemptErrors: new Map(),
    turnIndex: 0,
    turnOpen: false,
    toolCalls: new ToolCallRegistry(),
  };
}

/** Build an event in the segment the session is currently in. */
function createDshEvent(
  state: DshState,
  init: Omit<EventInit, "segmentId">,
): AgentEvent {
  return state.factory.create({ ...init, segmentId: state.segmentId });
}

/** The title of the session: an explicit title wins over the first prompt. */
function sessionTitle(state: DshState): string | undefined {
  return state.explicitTitle ?? state.userTitle;
}

/** Write the title into the session start event, as soon as it is known. */
function refreshTitle(state: DshState): void {
  const title = sessionTitle(state);
  if (title === undefined || state.sessionStart === undefined) return;
  state.sessionStart.attrs.title = title;
}

/** Make sure the session start event exists. */
function ensureSessionStart(state: DshState, ts: string, ref: string): AgentEvent {
  if (state.sessionStart) return state.sessionStart;

  const extra: Record<string, unknown> = {};
  if (state.provider !== undefined) extra.provider = state.provider;
  if (state.nativeSessionId !== undefined) extra.native_session_id = state.nativeSessionId;
  // A session that runs inside a delegation points at the session it belongs to.
  if (state.delegationDepth !== undefined && state.delegationDepth > 0) {
    extra.parent = { delegation_depth: state.delegationDepth };
  }

  const event = createDshEvent(state, {
    line: state.scope.line,
    sub: state.scope.next(),
    kind: "session.start",
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
  // The first event of a session always belongs to its first segment, even
  // when the header is missing and the start is synthesized later.
  event.segment_id = FIRST_SEGMENT_ID;

  state.sessionStart = event;
  state.events.push(event);
  return event;
}

/**
 * Start a new turn.
 *
 * A turn starts with a real user message, so the event may be emitted a few
 * records after `turn/start`. `line` keeps the id anchored to the record that
 * announced the turn instead of the message that finally claimed it.
 */
function startTurn(state: DshState, ts: string, ref: string, line?: number): void {
  state.turnIndex += 1;
  state.turnId = state.factory.turnIdFor(state.turnIndex);
  state.turnOpen = true;
  state.turnLlmCalls = [];
  const eventLine = line ?? state.scope.line;
  const sub = line === undefined ? state.scope.next() : 0;
  state.events.push(
    createDshEvent(state, {
      line: eventLine,
      sub,
      kind: "turn.start",
      ts,
      turnId: state.turnId,
      attrs: { trigger: "user" },
      ref,
    }),
  );
}

/** Start the turn of a real user message, if it has not started yet. */
function ensureTurnForUser(state: DshState, ts: string, ref: string): void {
  if (state.turnOpen) return;
  const pending = state.pendingTurn;
  state.pendingTurn = undefined;
  if (pending !== undefined) {
    startTurn(state, pending.ts, pending.ref, pending.line);
    return;
  }
  startTurn(state, ts, ref);
}

/** Close the running turn, if any. */
function endTurn(state: DshState, ts: string, ref: string, stopReason: string): void {
  if (!state.turnOpen || state.turnId === undefined) return;
  const attrs: Record<string, unknown> = { stop_reason: stopReason };
  if (state.model !== undefined) attrs.model = state.model;
  state.events.push(
    createDshEvent(state, {
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
  state.turnLlmCalls = [];
}

/**
 * Open the next context segment.
 *
 * The boundary event itself belongs to the **new** segment; its
 * `parent_segment_id` points at the segment it closes. `context_tokens_after`
 * and `tokens_removed` are filled in by {@link noteContext} when the first
 * model call of the new segment arrives.
 */
function openSegment(
  state: DshState,
  reason: "compaction" | "resume" | "fork" | "unknown",
  ts: string,
  ref: string,
  summary?: string,
): AgentEvent {
  const parent = state.segmentId;
  state.segmentIndex += 1;
  state.segmentId = `seg_${state.segmentIndex}`;

  const summaryText = summary !== undefined && summary !== "" ? summary : null;
  const attrs: Record<string, unknown> = {
    reason,
    context_tokens_before: state.lastContextTokens,
    context_tokens_after: null,
    tokens_removed: null,
    summary: summaryText,
    parent_segment_id: parent,
    derived: false,
  };

  const event = createDshEvent(state, {
    line: state.scope.line,
    sub: state.scope.next(),
    kind: "segment.boundary",
    ts,
    attrs,
    content:
      summaryText === null
        ? undefined
        : { output: { text: summaryText }, capture: "full" },
    ref,
  });

  state.pendingBoundary = event;
  state.events.push(event);
  return event;
}

/** Remember the context size of a call and complete a pending boundary. */
function noteContext(state: DshState, context: number | null): void {
  state.lastContextTokens = context;

  const boundary = state.pendingBoundary;
  if (boundary === undefined) return;
  state.pendingBoundary = undefined;

  const before =
    typeof boundary.attrs.context_tokens_before === "number"
      ? boundary.attrs.context_tokens_before
      : null;

  boundary.attrs.context_tokens_after = context;
  boundary.attrs.tokens_removed =
    before !== null && context !== null ? before - context : null;
  boundary.attrs.derived = context !== null;
}

/** Create the state of a compaction that has not been seen before. */
function newCompaction(
  state: DshState,
  data: Record<string, unknown> | undefined,
  started: boolean,
): DshCompaction {
  return {
    id: asString(data?.compactionId),
    before: state.lastContextTokens,
    started,
    turn: asNumber(data?.turn) ?? null,
    callEmitted: false,
  };
}

/**
 * Find the compaction a record belongs to.
 *
 * A new compaction id starts a new lifecycle; when the log is truncated and
 * the id is missing, the open compaction is reused.
 */
function compactionFor(
  state: DshState,
  data: Record<string, unknown> | undefined,
  started: boolean,
): DshCompaction {
  const id = asString(data?.compactionId);
  const current = state.compaction;
  if (
    current !== undefined &&
    (id === undefined || current.id === undefined || id === current.id)
  ) {
    if (current.id === undefined && id !== undefined) current.id = id;
    return current;
  }
  state.compaction = newCompaction(state, data, started);
  return state.compaction;
}

/** Attach the summary of a compaction to its boundary and content. */
function attachCompactionSummary(compaction: DshCompaction, summary: string): void {
  if (summary === "") return;
  compaction.summary = summary;
  const boundary = compaction.boundary;
  if (boundary === undefined) return;
  boundary.attrs.summary = summary;
  boundary.content = { output: { text: summary }, capture: "full" };
}

/** Open the segment boundary of a compaction (once). */
function openCompactionBoundary(
  state: DshState,
  compaction: DshCompaction,
  ts: string,
  ref: string,
): AgentEvent {
  if (compaction.boundary !== undefined) return compaction.boundary;

  const boundary = openSegment(
    state,
    "compaction",
    compaction.startTs ?? ts,
    ref,
    compaction.summary,
  );
  compaction.boundary = boundary;
  finishCompactionBoundary(compaction);
  return boundary;
}

/** Copy the known end/error facts onto the boundary event. */
function finishCompactionBoundary(compaction: DshCompaction): void {
  const boundary = compaction.boundary;
  if (boundary === undefined) return;
  if (compaction.endTs !== undefined) boundary.end_ts = compaction.endTs;
  if (compaction.error !== undefined) {
    boundary.status = "error";
    boundary.error = compaction.error;
  }
}

/** Parse the error of `compaction/end`, which is a string in the format. */
function compactionError(value: unknown): EventError {
  if (isPlainObject(value)) {
    return {
      type: asString(value.type) ?? "compaction_error",
      message: asString(value.message) ?? "compaction failed",
    };
  }
  return {
    type: "compaction_error",
    message: asString(value) ?? "compaction failed",
  };
}

/** Use the reason of `turn/end` for a call that had no finish chunk. */
function applyTurnStopReason(state: DshState, stopReason: string): void {
  const last = state.turnLlmCalls[state.turnLlmCalls.length - 1];
  if (last !== undefined && last.attrs.stop_reason === null) {
    last.attrs.stop_reason = stopReason;
  }
}

/** Handle the `session` record. */
function handleSession(
  state: DshState,
  data: Record<string, unknown>,
  ts: string,
  ref: string,
): void {
  const version = asNumber(data.version);
  if (version !== undefined) {
    state.version = String(version);
    state.factory.version = state.version;
  }
  const cwd = asString(data.cwd);
  if (cwd !== undefined) state.cwd = cwd;
  const nativeSessionId = asString(data.id);
  if (nativeSessionId !== undefined) state.nativeSessionId = nativeSessionId;
  const depth = asNumber(data.delegationDepth);
  if (depth !== undefined) state.delegationDepth = depth;

  ensureSessionStart(state, ts, ref);
}

/** Handle the `turn/start` record. */
function handleTurnStart(state: DshState, ts: string, ref: string): void {
  if (state.turnOpen) return;
  // dsh opens a turn before it claims the queued input. The turn event is
  // only emitted once a real user message shows up (design §15.2).
  state.pendingTurn = { ts, ref, line: state.scope.line };
}

/** Handle the `turn/end` record. */
function handleTurnEnd(state: DshState, data: Record<string, unknown>, ts: string, ref: string): void {
  const reason = isPlainObject(data.reason) ? data.reason : undefined;
  const kind = asString(reason?.kind) ?? "completed";
  const error = isPlainObject(reason?.error) ? reason.error : undefined;

  if (!state.turnOpen) {
    state.pendingTurn = undefined;
    return;
  }
  const attrs: Record<string, unknown> = { stop_reason: kind };
  if (error) {
    const message = asString(error.message) ?? "turn failed";
    attrs.error_message = message;
  }
  if (state.model !== undefined) attrs.model = state.model;

  applyTurnStopReason(state, kind);

  state.events.push(
    createDshEvent(state, {
      line: state.scope.line,
      sub: state.scope.next(),
      kind: "turn.end",
      ts,
      turnId: state.turnId,
      status: kind === "error" ? "error" : undefined,
      error:
        kind === "error"
          ? { type: "turn_error", message: asString(error?.message) ?? "turn failed" }
          : undefined,
      attrs,
      ref,
    }),
  );
  state.turnOpen = false;
  state.turnId = undefined;
  state.turnLlmCalls = [];
}

/** Handle the `user/message` record. */
function handleUserMessage(
  state: DshState,
  data: Record<string, unknown>,
  ts: string,
  ref: string,
): void {
  const source = isPlainObject(data.source) ? data.source : undefined;
  const kind = asString(source?.kind);
  // The replacement message that follows a compaction is a context
  // checkpoint, not something the user typed (design §16.1). It belongs to
  // the compaction boundary, never to a new turn.
  if (kind === "compact-checkpoint") {
    ensureSessionStart(state, ts, ref);
    const compaction = compactionFor(
      state,
      { compactionId: asString(source?.compactionId), turn: data.turn },
      false,
    );
    const summary = textFromContent(data.content);
    if (compaction.summary === undefined) attachCompactionSummary(compaction, summary);
    openCompactionBoundary(state, compaction, ts, ref);
    return;
  }
  // Only what the user typed is a message of the user; the runtime injects
  // instructions and context as user messages as well.
  if (kind !== undefined && kind !== "user") return;

  const text = textFromContent(data.content);
  if (text === "") return;

  ensureSessionStart(state, ts, ref);
  ensureTurnForUser(state, ts, ref);

  const title = truncateTitle(text);
  if (state.userTitle === undefined && title !== "") state.userTitle = title;
  refreshTitle(state);

  state.events.push(
    createDshEvent(state, {
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

/** The key dsh uses to pair `step/start` with its `assistant/message`. */
function stepKey(turn: number, step: number): string {
  return `${turn}:${step}`;
}

/** Handle the `step/start` record: remember when the model call began. */
function handleStepStart(state: DshState, data: Record<string, unknown>, ts: string): void {
  const turn = asNumber(data.turn);
  const step = asNumber(data.step);
  if (turn === undefined || step === undefined) return;
  const time = asNumber(data.time) ?? Date.parse(ts);
  if (!Number.isFinite(time)) return;
  state.stepStarts.set(stepKey(turn, step), time);
}

/**
 * Handle the `assistant/attempt` record.
 *
 * It keeps the first-token time and the failure code of a settled attempt.
 * An attempt never becomes an `llm.call`: only the final assistant message is
 * the call, and it carries the retry facts (design §16.1).
 */
function handleAssistantAttempt(
  state: DshState,
  data: Record<string, unknown>,
  ts: string,
): void {
  const turn = asNumber(data.turn);
  const step = asNumber(data.step);
  if (turn !== undefined && step !== undefined) {
    const key = stepKey(turn, step);
    const failure = finishFailureOf(data.stream);
    const code = asString(failure?.code) ?? asString(failure?.type);
    if (code !== undefined) state.attemptErrors.set(key, code);

    const first = firstTokenTime(data.stream);
    if (first !== undefined) {
      const previous = state.firstTokens.get(key);
      if (previous === undefined || first < previous) state.firstTokens.set(key, first);
    }
  }
  void ts;
}

/** The time of the first token in one compact dsh stream. */
function firstTokenTime(stream: unknown): number | undefined {
  if (!Array.isArray(stream)) return undefined;

  for (const record of stream) {
    if (!isPlainObject(record)) continue;
    const type = asString(record.type);

    if (type === "chunk") {
      const chunk = isPlainObject(record.chunk) ? record.chunk : undefined;
      const chunkType = asString(chunk?.type);
      const time = asNumber(record.time);
      if (time === undefined) continue;
      if (chunkType === "text-delta" || chunkType === "reasoning-delta") {
        if ((asString(chunk?.text) ?? "") !== "") return time;
      }
      if (chunkType === "tool-call-delta") {
        if (
          asString(chunk?.name) !== undefined ||
          (asString(chunk?.argumentsDelta) ?? "") !== ""
        ) {
          return time;
        }
      }
      continue;
    }

    if (type !== "text-chunks" && type !== "reasoning-chunks" && type !== "tool-call-chunks") {
      continue;
    }

    const time0 = asNumber(record.time0);
    if (time0 === undefined) continue;
    if (type === "tool-call-chunks" && asString(record.name) !== undefined) return time0;

    const fragments = type === "tool-call-chunks" ? record.args : record.texts;
    if (!Array.isArray(fragments)) continue;
    const dt = Array.isArray(record.dt) ? record.dt : [];
    let time = time0;
    for (let index = 0; index < fragments.length; index += 1) {
      if (index > 0) time += asNumber(dt[index - 1]) ?? 0;
      if (typeof fragments[index] === "string" && fragments[index] !== "") return time;
    }
  }

  return undefined;
}

/** The first and last timestamps recorded in a compact dsh stream. */
function streamBounds(stream: unknown): { first: number; last: number } | undefined {
  if (!Array.isArray(stream)) return undefined;
  let first: number | undefined;
  let last: number | undefined;

  const note = (value: number | undefined): void => {
    if (value === undefined) return;
    first = first === undefined ? value : Math.min(first, value);
    last = last === undefined ? value : Math.max(last, value);
  };

  for (const record of stream) {
    if (!isPlainObject(record)) continue;
    const time = asNumber(record.time) ?? asNumber(record.time0);
    note(time);

    if (record.type === "text-chunks" || record.type === "reasoning-chunks" || record.type === "tool-call-chunks") {
      const dt = Array.isArray(record.dt) ? record.dt : [];
      if (time !== undefined) {
        const end = dt.reduce<number>((total, delta) => total + (asNumber(delta) ?? 0), time);
        note(end);
      }
    }
  }

  return first === undefined || last === undefined ? undefined : { first, last };
}

/** The finish reason kind of a dsh stream, when it carries one. */
function finishReasonOf(stream: unknown): string | undefined {
  if (!Array.isArray(stream)) return undefined;
  let reason: string | undefined;
  for (const record of stream) {
    if (!isPlainObject(record) || record.type !== "chunk") continue;
    const chunk = isPlainObject(record.chunk) ? record.chunk : undefined;
    if (asString(chunk?.type) !== "finish") continue;
    const finish = isPlainObject(chunk?.reason) ? chunk.reason : undefined;
    const kind = asString(finish?.kind);
    if (kind !== undefined) reason = kind;
  }
  return reason;
}

/** The request id dsh happened to attach to a model response, if any. */
function requestIdOf(
  data: Record<string, unknown>,
  message: Record<string, unknown> | undefined,
  source: Record<string, unknown> | undefined,
  usage: Record<string, unknown> | undefined,
): string | undefined {
  return (
    asString(data.requestId) ??
    asString(message?.requestId) ??
    asString(source?.requestId) ??
    asString(usage?.requestId)
  );
}

/** The failure of a `finish` chunk, when the stream ended with an error. */
function finishFailureOf(stream: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(stream)) return undefined;
  let failure: Record<string, unknown> | undefined;
  for (const record of stream) {
    if (!isPlainObject(record) || record.type !== "chunk") continue;
    const chunk = isPlainObject(record.chunk) ? record.chunk : undefined;
    if (asString(chunk?.type) !== "finish") continue;
    const finish = isPlainObject(chunk?.reason) ? chunk.reason : undefined;
    if (asString(finish?.kind) !== "error") continue;
    const value = isPlainObject(finish?.failure) ? finish.failure : undefined;
    if (value !== undefined) failure = value;
  }
  return failure;
}

/** Handle the `assistant/message` record. */
function handleAssistantMessage(
  state: DshState,
  data: Record<string, unknown>,
  ts: string,
  ref: string,
): void {
  const message = isPlainObject(data.message) ? data.message : undefined;
  const blocks = contentBlocks(message?.content);

  const source = isPlainObject(message?.source) ? message.source : undefined;
  const provider = asString(source?.provider);
  if (provider !== undefined) state.provider = provider;
  const model = asString(source?.model);
  if (model !== undefined) {
    state.model = model;
    if (state.sessionStart) state.sessionStart.attrs.model = model;
  }

  ensureSessionStart(state, ts, ref);

  // A truncated log may be missing `compaction/end`; a summary followed by the
  // first call of the new context is enough evidence to open the segment.
  if (state.compaction?.summary !== undefined && state.compaction.boundary === undefined) {
    openCompactionBoundary(state, state.compaction, ts, ref);
  }

  // The reasoning of the model.
  const reasoning = blocks
    .filter((block) => block.type === "reasoning")
    .map((block) => asString(block.text) ?? "")
    .filter((text) => text !== "");
  if (reasoning.length > 0) {
    state.events.push(
      createDshEvent(state, {
        line: state.scope.line,
        sub: state.scope.next(),
        kind: "reasoning",
        ts,
        turnId: state.turnId,
        attrs: { role: "assistant" },
        content: { output: { text: reasoning.join("\n") }, capture: "full" },
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
      createDshEvent(state, {
        line: state.scope.line,
        sub: state.scope.next(),
        kind: "message.agent",
        ts,
        turnId: state.turnId,
        attrs: { role: "assistant" },
        content: { output: { text: answer.join("\n") }, capture: "full" },
        ref,
      }),
    );
  }

  // The call of the model itself. The `tool-call` blocks of the message are
  // left out on purpose: dsh writes them again as `tool/call` records, and
  // the call needs the arguments and the result of those records.
  const usageRecord = isPlainObject(data.usage) ? data.usage : undefined;
  const usage = usageRecord
    ? usageFrom(
        {
          input_tokens: asNumber(usageRecord.inputTokens) ?? null,
          output_tokens: asNumber(usageRecord.outputTokens) ?? null,
          cache_read_tokens: asNumber(usageRecord.cacheReadTokens) ?? null,
          cache_write_tokens: asNumber(usageRecord.cacheWriteTokens) ?? null,
          reasoning_tokens: asNumber(usageRecord.reasoningTokens) ?? null,
        },
        "harness",
      )
    : emptyUsage("missing");

  const context = contextTokens(usage);
  const stream = data.stream;
  const hasStream = Array.isArray(stream) && stream.length > 0;

  const turn = asNumber(data.turn);
  const step = asNumber(data.step);
  const key = turn !== undefined && step !== undefined ? stepKey(turn, step) : undefined;
  const stepStart = key !== undefined ? state.stepStarts.get(key) : undefined;
  const bounds = hasStream ? streamBounds(stream) : undefined;

  let latency: number | undefined;
  let ttft: number | undefined;
  if (hasStream) {
    const start = stepStart ?? bounds?.first;
    const completion =
      (asNumber(data.time) ?? Date.parse(ts)) ||
      bounds?.last;
    if (start !== undefined && completion !== undefined && Number.isFinite(completion)) {
      latency = Math.max(0, completion - start);
    }
    const streamFirst = firstTokenTime(stream);
    const first =
      key !== undefined
        ? [state.firstTokens.get(key), streamFirst]
            .filter((value): value is number => value !== undefined)
            .reduce<number | undefined>(
              (best, value) => (best === undefined || value < best ? value : best),
              undefined,
            )
        : streamFirst;
    if (start !== undefined && first !== undefined) ttft = Math.max(0, first - start);
  }

  const derived: string[] = [];
  if (latency !== undefined) derived.push("latency_ms");
  if (ttft !== undefined) derived.push("ttft_ms");

  const retry =
    (key !== undefined ? state.pendingRetries.get(key) : undefined) ??
    state.pendingRetries.get("*") ??
    null;
  if (key !== undefined) {
    state.pendingRetries.delete(key);
    state.attemptErrors.delete(key);
  }
  state.pendingRetries.delete("*");

  const llmAttrs = llmCallAttrs({
    // The route belongs to this record, never to the session header.
    provider,
    model,
    contextTokens: context,
    stopReason: finishReasonOf(stream),
    latencyMs: latency,
    ttftMs: ttft,
    retry,
    requestId: requestIdOf(data, message, source, usageRecord),
    contextWindow: state.contextWindow,
    derived,
  });
  // Keep the optional keys explicit: "unknown" is null, never an absent key.
  if (llmAttrs.request_id === undefined) llmAttrs.request_id = null;
  if (llmAttrs.context_window === undefined) llmAttrs.context_window = null;

  const call = createDshEvent(state, {
    line: state.scope.line,
    sub: state.scope.next(),
    kind: "llm.call",
    ts,
    turnId: state.turnId,
    attrs: llmAttrs,
    usage,
    ref,
  });
  state.events.push(call);
  state.turnLlmCalls.push(call);
  noteContext(state, context);
}

/** Handle the `tool/call` record. */
function handleToolCall(
  state: DshState,
  data: Record<string, unknown>,
  ts: string,
  ref: string,
): void {
  const callId = asString(data.callId);
  if (callId === undefined) return;
  const toolName = asString(data.name);
  if (toolName === undefined) return;

  const { args, rawArgs } = parseToolArguments(data.arguments);

  const { call, events } = createToolCall(state.factory, {
    callId,
    toolName,
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
  // The shared helper does not know about dsh segments: put the call and its
  // child steps into the segment the session is currently in.
  call.event.segment_id = state.segmentId;
  for (const event of events) event.segment_id = state.segmentId;
  state.toolCalls.register(call);
  state.events.push(...events);
}

/** Handle the `tool/result` record. */
function handleToolResult(
  state: DshState,
  data: Record<string, unknown>,
  ts: string,
  ref: string,
): void {
  const message = isPlainObject(data.message) ? data.message : undefined;
  const source = isPlainObject(message?.source) ? message.source : undefined;
  const callId = asString(message?.toolCallId) ?? asString(source?.callId);
  if (callId === undefined) return;
  const call = state.toolCalls.find(callId);
  if (call === undefined) return;

  const text = textFromContent(message?.content);
  const isError = asBoolean(message?.isError) ?? false;

  applyToolOutcome(call, {
    outputText: text,
    isError,
    errorMessage: isError ? text : undefined,
    ts,
  });
}

/** Handle the `todo/write` record. */
function handleTodoWrite(
  state: DshState,
  data: Record<string, unknown>,
  ts: string,
  ref: string,
): void {
  const entries = planEntriesFrom({ todos: data.todos });
  if (entries.length === 0) return;

  state.events.push(
    createDshEvent(state, {
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

/** Handle the `llm/retry` record. */
function handleLlmRetry(
  state: DshState,
  data: Record<string, unknown>,
  ts: string,
  ref: string,
): void {
  const failure = isPlainObject(data.failure) ? data.failure : undefined;
  const message = asString(failure?.message) ?? "the model call failed";
  const attrs: Record<string, unknown> = { reason: message };
  const attempt = asNumber(data.retry);
  if (attempt !== undefined) attrs.retry_attempt = attempt;
  const maxRetries = asNumber(data.maxRetries);
  if (maxRetries !== undefined) attrs.max_retries = maxRetries;
  const provider = asString(data.provider);
  if (provider !== undefined) attrs.provider = provider;
  const mode = asString(data.mode);
  if (mode !== undefined) attrs.mode = mode;

  const turn = asNumber(data.turn);
  const step = asNumber(data.step);
  const key =
    turn !== undefined && step !== undefined ? stepKey(turn, step) : undefined;
  const errorCode =
    asString(failure?.code) ??
    asString(failure?.type) ??
    (key !== undefined ? state.attemptErrors.get(key) : undefined);
  if (attempt !== undefined) {
    const retry: LlmCallRetry = {
      attempt: Math.max(1, Math.trunc(attempt)),
      max_attempts:
        maxRetries !== undefined ? Math.max(1, Math.trunc(maxRetries)) : null,
      delay_ms: asNumber(data.delayMs) ?? null,
      error_code: errorCode ?? null,
    };
    if (key !== undefined) state.pendingRetries.set(key, retry);
    else state.pendingRetries.set("*", retry);
  }

  state.events.push(
    createDshEvent(state, {
      line: state.scope.line,
      sub: state.scope.next(),
      kind: "control.retry",
      ts,
      turnId: state.turnId,
      status: "error",
      error: { type: "llm_error", message, retryable: true },
      attrs,
      ref,
    }),
  );
}

/** Handle the `approval/asked` record. */
function handleApprovalAsked(
  state: DshState,
  data: Record<string, unknown>,
  ts: string,
  ref: string,
): void {
  const attrs: Record<string, unknown> = {};
  const toolName = asString(data.toolName);
  if (toolName !== undefined) attrs.tool_name = toolName;
  const callId = asString(data.callId);
  if (callId !== undefined) attrs.call_id = callId;
  const reason = asString(data.reason);
  if (reason !== undefined) attrs.reason = reason;

  state.events.push(
    createDshEvent(state, {
      line: state.scope.line,
      sub: state.scope.next(),
      kind: "permission.request",
      ts,
      turnId: state.turnId,
      attrs,
      ref,
    }),
  );
}

/** Handle the `approval/decided` record. */
function handleApprovalDecided(
  state: DshState,
  data: Record<string, unknown>,
  ts: string,
  ref: string,
): void {
  const outcome = asString(data.outcome);
  const attrs: Record<string, unknown> = {};
  if (outcome !== undefined) attrs.outcome = outcome;

  const decision =
    outcome === "allow" || outcome === "approved" || outcome === "allow_once"
      ? "allow_once"
      : outcome === "deny" || outcome === "denied" || outcome === "reject"
        ? "deny"
        : undefined;

  state.events.push(
    createDshEvent(state, {
      line: state.scope.line,
      sub: state.scope.next(),
      kind: "permission.decision",
      ts,
      turnId: state.turnId,
      attrs: decision !== undefined ? { ...attrs, decision } : attrs,
      ref,
    }),
  );
}

/** Handle the `session/title` record. */
function handleSessionTitle(
  state: DshState,
  data: Record<string, unknown>,
  ts: string,
  ref: string,
): void {
  const title = asString(data.title);
  if (title === undefined || title === "") return;
  state.explicitTitle = truncateTitle(title);
  refreshTitle(state);
}

/** Handle the `request/context` record. */
function handleRequestContext(
  state: DshState,
  data: Record<string, unknown>,
  ts: string,
  ref: string,
): void {
  const provider = asString(data.provider);
  if (provider !== undefined) state.provider = provider;
  const model = asString(data.model);
  if (model !== undefined) {
    state.model = model;
    if (state.sessionStart) state.sessionStart.attrs.model = model;
  }
  const contextWindow = asNumber(data.contextWindow);
  if (contextWindow !== undefined) state.contextWindow = contextWindow;
  void ts;
  void ref;
}

/**
 * Handle the `request/header` record.
 *
 * `reason: "resume"` is how the format exposes that a new process picked up
 * an existing log: the context was reloaded, so the next calls are a new
 * segment. The provider/model of the config are a fallback for the route.
 */
function handleRequestHeader(
  state: DshState,
  data: Record<string, unknown>,
  ts: string,
  ref: string,
): void {
  const header = isPlainObject(data.header) ? data.header : undefined;
  const config = isPlainObject(header?.config) ? header.config : undefined;

  const provider = asString(config?.provider);
  if (provider !== undefined) state.provider = provider;
  const model = asString(config?.model);
  if (model !== undefined) {
    state.model = model;
    if (state.sessionStart) state.sessionStart.attrs.model = model;
  }

  if (asString(data.reason) === "resume" && state.pendingBoundary === undefined) {
    openSegment(state, "resume", ts, ref);
  }
}

/** Handle the `session/end-seed` record: the boundary of restored history. */
function handleSessionEndSeed(
  state: DshState,
  data: Record<string, unknown>,
  ts: string,
  ref: string,
): void {
  // The tagged marker is the exact cut of a fork child; an untagged marker
  // is an ordinary restore/resume of the same log.
  const reason = data.inherited === true ? "fork" : "resume";
  if (state.pendingBoundary !== undefined) return;
  openSegment(state, reason, ts, ref);
}

/** Token usage of a compaction summary record, when it reported one. */
function compactionUsage(data: Record<string, unknown>): Usage | undefined {
  const record = isPlainObject(data.usage) ? data.usage : undefined;
  if (record === undefined) return undefined;
  const usage = usageFrom(
    {
      input_tokens: asNumber(record.inputTokens) ?? null,
      output_tokens: asNumber(record.outputTokens) ?? null,
      cache_read_tokens: asNumber(record.cacheReadTokens) ?? null,
      cache_write_tokens: asNumber(record.cacheWriteTokens) ?? null,
      reasoning_tokens: asNumber(record.reasoningTokens) ?? null,
    },
    "harness",
  );
  return usage.source === "missing" ? undefined : usage;
}

/** Emit the model call that produced a compaction summary. */
function emitCompactionCall(
  state: DshState,
  compaction: DshCompaction,
  data: Record<string, unknown>,
  ts: string,
  ref: string,
): void {
  if (compaction.callEmitted || compaction.usage === undefined) return;

  const attrs = llmCallAttrs({
    purpose: "compaction",
    // The summary record names the route that wrote it.
    provider: asString(data.provider),
    model: asString(data.model),
    contextTokens: contextTokens(compaction.usage),
    contextWindow: state.contextWindow,
    requestId: asString(data.requestId) ?? asString(data.request_id),
    derived: [],
  });
  if (attrs.request_id === undefined) attrs.request_id = null;
  if (attrs.context_window === undefined) attrs.context_window = null;

  state.events.push(
    createDshEvent(state, {
      line: state.scope.line,
      sub: state.scope.next(),
      kind: "llm.call",
      ts,
      turnId: state.turnId,
      attrs,
      usage: compaction.usage,
      ref,
    }),
  );
  compaction.callEmitted = true;
}

/** Handle the `compaction/start` record. */
function handleCompactionStart(
  state: DshState,
  data: Record<string, unknown>,
  ts: string,
  ref: string,
): void {
  const compaction = compactionFor(state, data, true);
  compaction.started = true;
  compaction.startTs = ts;
  compaction.turn = asNumber(data.turn) ?? compaction.turn;
  // The boundary node carries the start of the operation; its summary and
  // end are filled in by the following records.
  openCompactionBoundary(state, compaction, ts, ref);
}

/** Handle the `compaction/summary` record. */
function handleCompactionSummary(
  state: DshState,
  data: Record<string, unknown>,
  ts: string,
  ref: string,
): void {
  const compaction = compactionFor(state, data, false);
  compaction.summaryTs = ts;
  compaction.turn = asNumber(data.turn) ?? compaction.turn;
  const provider = asString(data.provider);
  if (provider !== undefined) compaction.provider = provider;
  const model = asString(data.model);
  if (model !== undefined) compaction.model = model;
  const usage = compactionUsage(data);
  if (usage !== undefined) compaction.usage = usage;
  attachCompactionSummary(compaction, textFromContent(data.summary));

  // A summary without a matching start is still a complete boundary record.
  openCompactionBoundary(state, compaction, compaction.startTs ?? ts, ref);
  emitCompactionCall(state, compaction, data, ts, ref);
}

/** Handle the `compaction/end` record. */
function handleCompactionEnd(
  state: DshState,
  data: Record<string, unknown>,
  ts: string,
  ref: string,
): void {
  const compaction = compactionFor(state, data, false);
  compaction.endTs = ts;
  if (data.error !== undefined) compaction.error = compactionError(data.error);

  openCompactionBoundary(
    state,
    compaction,
    compaction.startTs ?? compaction.summaryTs ?? ts,
    ref,
  );
  finishCompactionBoundary(compaction);
  state.compaction = undefined;
}

/** Handle one record of any type. */
function handleRecord(state: DshState, record: RawRecord): void {
  const data = record.data;
  if (!isPlainObject(data)) return;

  const line = record.line ?? 0;
  const ref = record.ref;
  state.scope.begin(line);

  const type = asString(data.type) ?? "";
  const payload = isPlainObject(data.data) ? data.data : undefined;
  const recordTs = timestampOf(
    data.time,
    data.timestamp,
    data.createdAt,
    payload?.createdAt,
  );
  const ts = recordTs ?? new Date(0).toISOString();
  state.latestRecordTs = laterTimestamp(state.latestRecordTs, recordTs);

  switch (type) {
    case "session": {
      // The header of the session is written into the record itself.
      handleSession(state, data, ts, ref);
      break;
    }
    case "turn/start": {
      handleTurnStart(state, ts, ref);
      break;
    }
    case "turn/end": {
      if (payload) handleTurnEnd(state, payload, ts, ref);
      break;
    }
    case "user/message": {
      if (payload) handleUserMessage(state, payload, ts, ref);
      break;
    }
    case "assistant/message": {
      if (payload) handleAssistantMessage(state, payload, ts, ref);
      break;
    }
    case "assistant/attempt": {
      if (payload) handleAssistantAttempt(state, payload, ts);
      break;
    }
    case "step/start": {
      if (payload) handleStepStart(state, payload, ts);
      break;
    }
    case "tool/call": {
      if (payload) handleToolCall(state, payload, ts, ref);
      break;
    }
    case "tool/result": {
      if (payload) handleToolResult(state, payload, ts, ref);
      break;
    }
    case "todo/write": {
      if (payload) handleTodoWrite(state, payload, ts, ref);
      break;
    }
    case "llm/retry": {
      if (payload) handleLlmRetry(state, payload, ts, ref);
      break;
    }
    case "approval/asked": {
      if (payload) handleApprovalAsked(state, payload, ts, ref);
      break;
    }
    case "approval/decided": {
      if (payload) handleApprovalDecided(state, payload, ts, ref);
      break;
    }
    case "session/title": {
      if (payload) handleSessionTitle(state, payload, ts, ref);
      break;
    }
    case "request/context": {
      if (payload) handleRequestContext(state, payload, ts, ref);
      break;
    }
    case "request/header": {
      if (payload) handleRequestHeader(state, payload, ts, ref);
      break;
    }
    case "session/end-seed": {
      if (payload) handleSessionEndSeed(state, payload, ts, ref);
      break;
    }
    case "compaction/start": {
      if (payload) handleCompactionStart(state, payload, ts, ref);
      break;
    }
    case "compaction/summary": {
      if (payload) handleCompactionSummary(state, payload, ts, ref);
      break;
    }
    case "compaction/end": {
      if (payload) handleCompactionEnd(state, payload, ts, ref);
      break;
    }
    default: {
      if (type !== "" && !KNOWN_TYPES.has(type) && !isNoiseType(type)) {
        state.events.push(
          createDshEvent(state, {
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
}

/** Close the session: the last turn, the open tool calls and the session end. */
function finalize(state: DshState, file: SessionFile, endLine: number): void {
  // The file mtime is not part of the trace: use the latest record timestamp
  // so a file touched later does not invent an idle gap at the end.
  const endTs =
    state.latestRecordTs ??
    new Date(file.mtimeMs > 0 ? file.mtimeMs : 0).toISOString();
  state.scope.begin(endLine);

  if (state.sessionStart === undefined) ensureSessionStart(state, endTs, file.path);

  // A truncated log may contain a compaction whose `compaction/end` never
  // made it to disk. The boundary still opened a new context, so keep it.
  const compaction = state.compaction;
  if (compaction !== undefined) {
    if (compaction.boundary === undefined) {
      openCompactionBoundary(
        state,
        compaction,
        compaction.startTs ?? compaction.summaryTs ?? endTs,
        file.path,
      );
    }
    finishCompactionBoundary(compaction);
    state.compaction = undefined;
  }

  state.pendingTurn = undefined;
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
    createDshEvent(state, {
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
 * Normalize the records of one dsh session.
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
  return assignRequestIndexes(state.events);
}

/** Build a minimal session file for a record that arrives without one. */
function minimalFile(record: RawRecord): SessionFile {
  const filePath = record.ref.split("#")[0] ?? record.ref;
  const segments = filePath.split(/[\\/]/);
  const directory = segments.length > 1 ? segments[segments.length - 2] : "";
  const match = /session-(.+)$/.exec(directory);
  const sourceSessionId = match ? match[1] : path.basename(filePath).replace(/\.zstd$/, "");
  return {
    source: SOURCE,
    path: filePath,
    size: 0,
    mtimeMs: 0,
    sourceSessionId,
  };
}

/**
 * The dsh normalizer.
 *
 * `normalize` works on a single record and therefore has no session context:
 * use {@link normalizeFile} to normalize a whole file with the state the
 * mapping needs.
 */
export const dshNormalizer: Normalizer = {
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
