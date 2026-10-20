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

import type { AgentEvent, Normalizer, RawRecord } from "@openmatel/core";

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
  parseJsonlText,
  parseToolArguments,
  planEntriesFrom,
  sessionStartAttrs,
  textFromContent,
  timestampOf,
  truncateTitle,
  usageFrom,
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
  // Bookkeeping of the runtime.
  "step/start",
  "step/end",
  "request/header",
  "system/message",
  "permission/preset",
  "sandbox/mode",
  "approval/policy",
  "agent/inbox/spliced",
  "session/title-llm-request",
  "assistant/attempt",
  "llm/retry-started",
  "web/deepseek-search-llm-request",
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
  turnIndex: number;
  turnId?: string;
  turnOpen: boolean;
  toolCalls: ToolCallRegistry;
}

/** Create the state for one session file. */
function createState(file: SessionFile): DshState {
  return {
    factory: new SourceEventFactory(file.source, file.sourceSessionId, FORMAT),
    scope: new EventScope(),
    events: [],
    turnIndex: 0,
    turnOpen: false,
    toolCalls: new ToolCallRegistry(),
  };
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

  const event = state.factory.create({
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

  state.sessionStart = event;
  state.events.push(event);
  return event;
}

/** Start a new turn. */
function startTurn(state: DshState, ts: string, ref: string): void {
  state.turnIndex += 1;
  state.turnId = state.factory.turnIdFor(state.turnIndex);
  state.turnOpen = true;
  state.events.push(
    state.factory.create({
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

/** Close the running turn, if any. */
function endTurn(state: DshState, ts: string, ref: string, stopReason: string): void {
  if (!state.turnOpen || state.turnId === undefined) return;
  const attrs: Record<string, unknown> = { stop_reason: stopReason };
  if (state.model !== undefined) attrs.model = state.model;
  state.events.push(
    state.factory.create({
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
  startTurn(state, ts, ref);
}

/** Handle the `turn/end` record. */
function handleTurnEnd(state: DshState, data: Record<string, unknown>, ts: string, ref: string): void {
  const reason = isPlainObject(data.reason) ? data.reason : undefined;
  const kind = asString(reason?.kind) ?? "completed";
  const error = isPlainObject(reason?.error) ? reason.error : undefined;

  if (!state.turnOpen) return;
  const attrs: Record<string, unknown> = { stop_reason: kind };
  if (error) {
    const message = asString(error.message) ?? "turn failed";
    attrs.error_message = message;
  }
  if (state.model !== undefined) attrs.model = state.model;

  state.events.push(
    state.factory.create({
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
  // Only what the user typed is a message of the user; the runtime injects
  // instructions and context as user messages as well.
  if (kind !== undefined && kind !== "user") return;

  const text = textFromContent(data.content);
  if (text === "") return;

  ensureSessionStart(state, ts, ref);

  const title = truncateTitle(text);
  if (state.userTitle === undefined && title !== "") state.userTitle = title;
  refreshTitle(state);

  state.events.push(
    state.factory.create({
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

  // The reasoning of the model.
  const reasoning = blocks
    .filter((block) => block.type === "reasoning")
    .map((block) => asString(block.text) ?? "")
    .filter((text) => text !== "");
  if (reasoning.length > 0) {
    state.events.push(
      state.factory.create({
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
      state.factory.create({
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
  const usage = isPlainObject(data.usage) ? data.usage : undefined;
  const llmAttrs: Record<string, unknown> = {};
  if (state.provider !== undefined) llmAttrs.provider = state.provider;
  if (state.model !== undefined) llmAttrs.model = state.model;

  state.events.push(
    state.factory.create({
      line: state.scope.line,
      sub: state.scope.next(),
      kind: "llm.call",
      ts,
      turnId: state.turnId,
      attrs: llmAttrs,
      usage: usage
        ? usageFrom(
            {
              input_tokens: asNumber(usage.inputTokens) ?? null,
              output_tokens: asNumber(usage.outputTokens) ?? null,
              cache_read_tokens: asNumber(usage.cacheReadTokens) ?? null,
              cache_write_tokens: asNumber(usage.cacheWriteTokens) ?? null,
            },
            "harness",
          )
        : emptyUsage("missing"),
      ref,
    }),
  );
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
    state.factory.create({
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

  state.events.push(
    state.factory.create({
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
    state.factory.create({
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
    state.factory.create({
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
  const ts =
    timestampOf(data.time, data.timestamp, data.createdAt, payload?.createdAt) ??
    new Date(0).toISOString();

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
    default: {
      if (type !== "" && !KNOWN_TYPES.has(type) && !isNoiseType(type)) {
        state.events.push(
          state.factory.create({
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
  return state.events;
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
    return state.events;
  },
};

export type { SessionFile } from "./common.js";
