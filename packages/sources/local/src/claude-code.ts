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
 * only carries `tool_result` blocks belongs to the running turn.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

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
  };
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

  const event = state.factory.create({
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

/** Start a new turn. */
function startTurn(state: ClaudeState, ts: string, ref: string): void {
  endTurn(state, ts, "completed", ref);
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

/** Handle one `assistant` record. */
function handleAssistant(
  state: ClaudeState,
  record: Record<string, unknown>,
  ts: string,
  ref: string,
): void {
  const message = isPlainObject(record.message) ? record.message : undefined;
  const blocks = contentBlocks(message?.content);

  const model = realModel(asString(message?.model));
  if (model !== undefined) {
    state.model = model;
    if (state.sessionStart) state.sessionStart.attrs.model = model;
  }

  ensureSessionStart(state, record, ts, ref);

  // The model call itself.
  const usageRecord = isPlainObject(message?.usage) ? message.usage : undefined;
  const details = isPlainObject(usageRecord?.output_tokens_details)
    ? usageRecord?.output_tokens_details
    : undefined;
  const requestId = asString(record.requestId);
  const llmAttrs = llmCallAttrs({ provider: "anthropic", model, requestId });

  state.events.push(
    state.factory.create({
      line: state.scope.line,
      sub: state.scope.next(),
      kind: "llm.call",
      ts,
      turnId: state.turnId,
      attrs: llmAttrs,
      usage: usageRecord
        ? usageFrom({
            input_tokens: asNumber(usageRecord.input_tokens) ?? null,
            output_tokens: asNumber(usageRecord.output_tokens) ?? null,
            cache_read_tokens: asNumber(usageRecord.cache_read_input_tokens) ?? null,
            cache_write_tokens: asNumber(usageRecord.cache_creation_input_tokens) ?? null,
            reasoning_tokens: asNumber(details?.thinking_tokens) ?? null,
          })
        : emptyUsage("missing"),
      ref,
    }),
  );

  // Reasoning.
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

  // The answer.
  const texts = blocks
    .filter((block) => block.type === "text")
    .map((block) => asString(block.text) ?? "")
    .filter((text) => text !== "");
  if (texts.length > 0) {
    state.events.push(
      state.factory.create({
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
    state.events.push(
      state.factory.create({
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
    state.events.push(
      state.factory.create({
        line: state.scope.line,
        sub: state.scope.next(),
        kind: "control.compaction",
        ts,
        turnId: state.turnId,
        attrs: {},
        ref,
      }),
    );
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
    state.factory.create({
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
  const ts =
    timestampOf(data.timestamp, data.createdAt) ?? new Date(0).toISOString();

  const isSidechain = asBoolean(data.isSidechain) === true;
  if (isSidechain) {
    handleSidechain(state, data, ts, ref);
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
    case "attachment":
    case "queue-operation":
    case "api-request":
    case "api-request-blob":
    case "api-request-shape":
    case "last-prompt":
    case "atis-latch":
    case "cost-state":
      break;
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

  const uuid = asString(data.uuid);
  if (uuid !== undefined) state.byUuid.set(uuid, data);
}

/** Close the session: the last turn, the open tool calls and the session end. */
function finalize(state: ClaudeState, file: SessionFile, endLine: number): void {
  // Events that belong to the file as a whole are placed one line past the
  // last record, so their ids cannot collide with the events of a record.
  const endTs = new Date(file.mtimeMs > 0 ? file.mtimeMs : 0).toISOString();
  state.scope.begin(endLine);

  // A session that never had a message still has a start.
  if (state.sessionStart === undefined) {
    ensureSessionStart(state, {}, endTs, file.path);
  }

  // Close the running turn. The scope keeps counting, so the id of this
  // event cannot collide with the events of the last record.
  endTurn(state, endTs, "end_of_session", file.path);

  // Tool calls without a result keep their call time and no output.
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
  return state.events;
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
    return state.events;
  },
};

export type { SessionFile } from "./common.js";
