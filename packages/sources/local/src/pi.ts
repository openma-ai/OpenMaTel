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
 * Turns: every message of the user starts a turn; the turn ends when the next
 * message of the user arrives or when the session ends.
 */

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

/** Record types this normalizer knows about. */
const KNOWN_TYPES = new Set(["session", "model_change", "thinking_level_change", "message"]);

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

  ensureSessionStart(state, ts, ref);
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
  ensureSessionStart(state, ts, ref);
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
        ts,
        turnId: state.turnId,
        attrs: { role: "assistant" },
        content: { output: { text: answer.join("\n") }, capture: "full" },
        ref,
      }),
    );
  }

  // The call of the model itself.
  const usage = isPlainObject(message.usage) ? message.usage : undefined;
  const cost = usage && isPlainObject(usage.cost) ? usage.cost : undefined;
  const stopReason = asString(message.stopReason);
  const llmAttrs = llmCallAttrs({
    provider: state.provider,
    model: state.model,
    stopReason,
  });

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
              input_tokens: asNumber(usage.input) ?? null,
              output_tokens: asNumber(usage.output) ?? null,
              cache_read_tokens: asNumber(usage.cacheRead) ?? null,
              cache_write_tokens: asNumber(usage.cacheWrite) ?? null,
              reasoning_tokens: asNumber(usage.reasoning) ?? null,
              cost_usd: asNumber(cost?.total) ?? null,
              cost_source: "harness",
            },
            "harness",
          )
        : emptyUsage("missing"),
      ref,
    }),
  );

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
    state.toolCalls.register(call);
    state.events.push(...events);
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
    default: {
      if (type !== "" && !KNOWN_TYPES.has(type)) {
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
