/**
 * Shared plumbing for the local-file sources.
 *
 * All four harnesses (Claude Code, Codex, dsh, pi) are read the same way:
 *
 * 1. {@link discoverSessions} walks a directory tree and reports the session
 *    files it finds — no glob dependency, just `fs.readdir`.
 * 2. {@link parseJsonlText} turns a file into {@link RawRecord}s, one per
 *    non-empty line, and counts the lines it had to skip.
 * 3. A harness module walks those records in order, keeping the little state
 *    it needs (current turn, pending tool calls, …) and emits canonical
 *    {@link AgentEvent}s.
 *
 * The rules encoded here come from `docs/design.md` §4:
 *
 * - `"missing"` is not `"0"`: {@link usageFrom} never turns an absent token
 *   count into a zero.
 * - ids are deterministic: {@link SourceEventFactory} derives every
 *   `event_id` / `step_id` from the source coordinates of the record, so the
 *   same file always yields the same ids.
 * - unknown record types must not throw: they become `raw.unknown` events
 *   without content.
 */

import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import {
  emptyUsage,
  eventId,
  sessionId,
  stepId,
  type AgentEvent,
  type Content,
  type EventContent,
  type EventError,
  type EventKind,
  type RawRecord,
  type StepStatus,
  type ToolKind,
  type Usage,
  type UsageSource,
} from "@openmatel/core";

/** Every local session lives in the single `local` project. */
export const PROJECT_ID = "local";

/** Longest title kept for a session. */
export const TITLE_MAX_LENGTH = 120;

/** The usage of a call the harness did not report. */
export { emptyUsage } from "@openmatel/core";

/* -------------------------------------------------------------------------- */
/* Files                                                                       */
/* -------------------------------------------------------------------------- */

/** One session file found on disk. */
export interface SessionFile {
  /** Source name, e.g. `"claude-code"`. */
  source: string;
  /** Absolute path of the session file. */
  path: string;
  /** Size of the file in bytes. */
  size: number;
  /** Modification time, in milliseconds since the epoch. */
  mtimeMs: number;
  /** The harness' own id for the session, taken from the file name. */
  sourceSessionId: string;
}

/**
 * List every regular file below `dir`, recursively.
 *
 * A missing or unreadable directory yields an empty list: a source that is
 * simply not installed on this machine is not an error.
 */
export async function listFilesRecursively(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursively(full)));
      continue;
    }
    try {
      const info = await stat(full);
      if (info.isFile()) files.push(full);
    } catch {
      // A file that vanished between readdir and stat is simply skipped.
    }
  }
  return files;
}

/**
 * Describe a file as a {@link SessionFile}, or `null` when it cannot be read.
 */
export async function describeFile(
  source: string,
  filePath: string,
  sourceSessionId: string,
): Promise<SessionFile | null> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return null;
    return {
      source,
      path: filePath,
      size: info.size,
      mtimeMs: info.mtimeMs,
      sourceSessionId,
    };
  } catch {
    return null;
  }
}

/**
 * Discover the session files of one harness.
 *
 * @param source - source name, e.g. `"claude-code"`.
 * @param roots - directories to search, in order.
 * @param match - decides whether a file belongs to the source and which
 *               session id it carries.
 */
export async function discoverSessions(
  source: string,
  roots: string[],
  match: (filePath: string) => { sourceSessionId: string } | null,
): Promise<SessionFile[]> {
  const found: SessionFile[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    for (const filePath of await listFilesRecursively(root)) {
      const matched = match(filePath);
      if (!matched) continue;
      if (seen.has(filePath)) continue;
      seen.add(filePath);
      const described = await describeFile(source, filePath, matched.sourceSessionId);
      if (described) found.push(described);
    }
  }

  found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return found;
}

/* -------------------------------------------------------------------------- */
/* Records                                                                     */
/* -------------------------------------------------------------------------- */

/** How many lines a file had, and how many of them were usable. */
export interface ReadStats {
  /** Non-empty lines seen. */
  total: number;
  /** Empty lines. */
  blank: number;
  /** Lines that were not valid JSON objects. */
  invalid: number;
  /** `blank + invalid`: the lines that were skipped. */
  skipped: number;
  /** Records that were kept. */
  records: number;
}

/** Result of parsing a JSONL file. */
export interface ParsedRecords {
  /** The usable records, in file order. */
  records: RawRecord[];
  /** Counts of the lines that were skipped. */
  stats: ReadStats;
}

/**
 * Parse JSONL text into raw records.
 *
 * Blank lines and lines that are not valid JSON objects are skipped and
 * counted. Every record keeps the line it came from, and its `ref` points at
 * `path#L<line>` so a store can go back to the exact line later.
 */
export function parseJsonlText(text: string, source: string, filePath: string): ParsedRecords {
  const records: RawRecord[] = [];
  const lines = text.split("\n");
  let blank = 0;
  let invalid = 0;
  let total = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "") {
      blank += 1;
      continue;
    }
    total += 1;

    let data: unknown;
    try {
      data = JSON.parse(line);
    } catch {
      invalid += 1;
      continue;
    }
    if (!isPlainObject(data)) {
      invalid += 1;
      continue;
    }

    const lineNo = index + 1;
    records.push({ source, ref: `${filePath}#L${lineNo}`, line: lineNo, data });
  }

  return {
    records,
    stats: { total, blank, invalid, skipped: blank + invalid, records: records.length },
  };
}

/** `true` for a plain object (not an array, not `null`). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The line one past the last record of a file.
 *
 * The events that belong to the file as a whole — the closing turn, the
 * `session.end` — are placed there, so their ids cannot collide with the ids
 * of the events of a record.
 */
export function endLineOf(records: RawRecord[]): number {
  let max = 0;
  for (const record of records) {
    const line = record.line ?? 0;
    if (line > max) max = line;
  }
  return max + 1;
}

/** Read a string property, or `undefined` when it is absent or not a string. */
export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Read a finite number property, or `undefined`. */
export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Read a boolean property, or `undefined`. */
export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/* -------------------------------------------------------------------------- */
/* Time                                                                        */
/* -------------------------------------------------------------------------- */

/** Convert epoch milliseconds to an ISO-8601 timestamp. */
export function isoFromEpochMs(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/**
 * Normalize a timestamp to an ISO-8601 string.
 *
 * Accepts an ISO string (kept as-is when it is parseable) or epoch
 * milliseconds. Returns `undefined` when the value is not a usable time, so
 * the caller can fall back to another source of truth.
 */
export function toIsoTimestamp(value: unknown): string | undefined {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) return undefined;
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    // Values below ~1e11 are seconds, not milliseconds.
    const ms = value < 1e11 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  return undefined;
}

/**
 * The timestamp of a record, with a fallback for harnesses that do not
 * report one.
 */
export function timestampOf(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    const iso = toIsoTimestamp(candidate);
    if (iso !== undefined) return iso;
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Content                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The blocks of a message body, as a list.
 *
 * A body that is a plain string becomes a single `text` block; anything that
 * is not a list of objects yields no blocks at all.
 */
export function contentBlocks(content: unknown): Record<string, unknown>[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.filter(isPlainObject);
}

/**
 * Extract the plain text of a message body.
 *
 * Handles the shapes the four harnesses use: a bare string, or an array of
 * blocks with a `text` property (`text`, `input_text`, `output_text`).
 */
export function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === "string") {
        parts.push(block);
        continue;
      }
      if (!isPlainObject(block)) continue;
      const type = asString(block.type);
      if (type !== undefined && type !== "text" && type !== "input_text" && type !== "output_text") {
        continue;
      }
      const text = block.text;
      if (typeof text === "string") parts.push(text);
    }
    return parts.join("\n");
  }
  if (isPlainObject(content)) {
    const text = content.text;
    return typeof text === "string" ? text : "";
  }
  return "";
}

/** Build a {@link Content} from plain text. */
export function textContent(text: string): Content {
  return { text };
}

/**
 * Shorten a title to {@link TITLE_MAX_LENGTH} characters.
 *
 * Newlines are collapsed so a multi-line prompt stays readable in a list.
 */
export function truncateTitle(text: string, max: number = TITLE_MAX_LENGTH): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) : flat;
}

/**
 * Parse the exit code out of a shell result.
 *
 * dsh marks bash results with `[exit code: N]`, Codex with
 * `Process exited with code N`. Returns `undefined` when there is none.
 */
export function parseExitCode(text: string): number | undefined {
  const bracketed = /\[exit code:\s*(-?\d+)\]/.exec(text);
  const plain = /exited with code\s+(-?\d+)/i.exec(text);
  const match = bracketed ?? plain;
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Parse the exit code out of a JSON payload embedded in a tool result.
 *
 * Codex reports the result of a shell command as a text blob that contains a
 * JSON object with an `exit_code` field; the code never appears as
 * `[exit code: N]`.
 */
export function parseExitCodeFromJson(text: string): number | undefined {
  const match = /"exit_code"\s*:\s*(-?\d+)/.exec(text);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Parse a JSON string into an object.
 *
 * Returns `undefined` when the text is not a JSON object, so a caller can
 * fall back to the raw text instead of failing.
 */
export function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* Arguments                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Read the arguments of a tool call.
 *
 * Codex and dsh write the arguments as a JSON *string*; Claude and pi write
 * them as an object. A string that does not parse stays a string, so the
 * call still shows what the harness passed.
 */
export function parseToolArguments(raw: unknown): {
  args: Record<string, unknown> | undefined;
  rawArgs: unknown;
} {
  if (isPlainObject(raw)) return { args: raw, rawArgs: raw };
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("{")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isPlainObject(parsed)) return { args: parsed, rawArgs: raw };
      } catch {
        // Not JSON after all — keep the raw string.
      }
    }
    return { args: undefined, rawArgs: raw };
  }
  if (raw === undefined || raw === null) return { args: undefined, rawArgs: undefined };
  return { args: undefined, rawArgs: raw };
}

/** Read the command out of a tool's arguments. */
export function commandFromArgs(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  for (const key of ["command", "cmd", "script", "shell_command"]) {
    const value = args[key];
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      const parts = value.filter((part): part is string => typeof part === "string");
      if (parts.length > 0) return parts.join(" ");
    }
  }
  return undefined;
}

/** Read the edited file path out of a tool's arguments. */
export function pathFromArgs(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  for (const key of ["file_path", "filePath", "path", "file", "target_file"]) {
    const value = args[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

/**
 * Guess what an edit tool did to the file.
 *
 * `write` creates a file, `edit` / `apply_patch` / `str_replace` change one,
 * and an explicit `delete` argument removes it.
 */
export function editOpFor(
  toolName: string,
  args: Record<string, unknown> | undefined,
): "create" | "modify" | "delete" {
  if (args && args.delete === true) return "delete";
  // A harness that knows better than the name of the tool can say so.
  const explicit = asString(args?.op);
  if (explicit === "create" || explicit === "modify" || explicit === "delete") return explicit;
  const tokens = tokenizeToolName(toolName);
  if (tokens.includes("delete") || tokens.includes("remove")) return "delete";
  if (tokens.includes("write") || tokens.includes("create")) return "create";
  return "modify";
}

/* -------------------------------------------------------------------------- */
/* Plan                                                                        */
/* -------------------------------------------------------------------------- */

/** One entry of a plan / todo list. */
export interface PlanEntry {
  /** What the task is. */
  content: string;
  /** Where the task stands, e.g. `"pending"`. */
  status: string;
  /** How important the task is, when the harness says so. */
  priority?: string;
}

/**
 * Read the entries of a plan out of a tool input.
 *
 * Claude Code writes them as `TodoWrite({ todos: [...] })`, dsh as
 * `todo/write({ todos: [...] })`; both use `content` and `status`.
 */
export function planEntriesFrom(input: unknown): PlanEntry[] {
  const todos = isPlainObject(input) && Array.isArray(input.todos) ? input.todos : [];
  const entries: PlanEntry[] = [];
  for (const todo of todos) {
    if (!isPlainObject(todo)) continue;
    const content = asString(todo.content) ?? asString(todo.text) ?? asString(todo.title);
    if (content === undefined || content === "") continue;
    const entry: PlanEntry = { content, status: asString(todo.status) ?? "pending" };
    const priority = asString(todo.priority);
    if (priority !== undefined) entry.priority = priority;
    entries.push(entry);
  }
  return entries;
}

/* -------------------------------------------------------------------------- */
/* Usage                                                                       */
/* -------------------------------------------------------------------------- */

/** Token counts a harness reported, all optional. */
export interface UsageParts {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_tokens?: number | null;
  cache_write_tokens?: number | null;
  reasoning_tokens?: number | null;
  /** Cost of the call, when the harness reported one. */
  cost_usd?: number | null;
  /** Where the cost came from. */
  cost_source?: Usage["cost_source"];
}

/**
 * Build a {@link Usage} record from reported token counts.
 *
 * A count the harness did not report stays `null` — it never becomes `0`
 * (`docs/design.md` §4.5). When nothing at all was reported the record is
 * `source: "missing"`.
 */
export function usageFrom(parts: UsageParts, source: UsageSource = "provider"): Usage {
  const input = parts.input_tokens ?? null;
  const output = parts.output_tokens ?? null;
  const cacheRead = parts.cache_read_tokens ?? null;
  const cacheWrite = parts.cache_write_tokens ?? null;
  const reasoning = parts.reasoning_tokens ?? null;

  const reported =
    input !== null || output !== null || cacheRead !== null || cacheWrite !== null || reasoning !== null;

  if (!reported && parts.cost_usd === undefined) return emptyUsage("missing");

  const usage: Usage = {
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    reasoning_tokens: reasoning,
    source: reported ? source : "missing",
  };
  if (parts.cost_usd !== undefined && parts.cost_usd !== null) {
    usage.cost_usd = parts.cost_usd;
    usage.cost_source = parts.cost_source ?? "provider";
  }
  return usage;
}

/* -------------------------------------------------------------------------- */
/* Tool kind                                                                   */
/* -------------------------------------------------------------------------- */

/** Tool names that map to `execute`, checked as whole words. */
const EXECUTE_TOKENS = new Set(["bash", "shell", "exec", "execute", "command", "terminal", "sh"]);
/** Tool names that map to `edit`. */
const EDIT_TOKENS = new Set(["edit", "write", "patch", "replace", "apply", "multiedit", "notebookedit"]);
/** Tool names that map to `read`. */
const READ_TOKENS = new Set(["read", "view", "cat", "open"]);
/** Tool names that map to `fetch`. */
const FETCH_TOKENS = new Set(["fetch", "webfetch", "http", "curl", "download", "browse"]);
/** Tool names that map to `search`. */
const SEARCH_TOKENS = new Set(["grep", "glob", "search", "find", "rg"]);
/** Tool names that are none of the above. */
const OTHER_TOKENS = new Set([
  "todo",
  "plan",
  "think",
  "thought",
  "task",
  "agent",
  "goal",
  "question",
  "wait",
  "kill",
  "exit",
]);

/**
 * Split a tool name into lower-case words.
 *
 * `apply_patch` becomes `["apply", "patch"]`, `exec_command` becomes
 * `["exec", "command"]` and `mcp__server__tool` becomes
 * `["mcp", "server", "tool"]`.
 */
export function tokenizeToolName(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((token) => token.length > 0);
}

/**
 * Guess what kind of tool a call is, from its name.
 *
 * The mapping is deliberately a heuristic — harnesses name their tools
 * differently — and is the same for every source:
 *
 * | name contains | kind |
 * |---|---|
 * | `mcp__*` | `mcp` |
 * | `bash`, `shell`, `exec`, `command` | `execute` |
 * | `edit`, `write`, `apply_patch`, `str_replace` | `edit` |
 * | `read`, `view`, `cat` | `read` |
 * | `web_fetch`, `fetch` | `fetch` |
 * | `grep`, `glob`, `search` | `search` |
 * | anything else | `other` |
 */
export function toolKindFor(name: string): ToolKind {
  const lower = name.toLowerCase();
  if (lower.includes("mcp__")) return "mcp";

  const tokens = tokenizeToolName(name);
  if (tokens.some((token) => OTHER_TOKENS.has(token))) return "other";
  if (tokens.some((token) => EXECUTE_TOKENS.has(token))) return "execute";
  if (tokens.some((token) => EDIT_TOKENS.has(token))) return "edit";
  if (tokens.some((token) => READ_TOKENS.has(token))) return "read";
  if (tokens.some((token) => FETCH_TOKENS.has(token))) return "fetch";
  if (tokens.some((token) => SEARCH_TOKENS.has(token))) return "search";
  // `create_file` and friends: an edit, even though no other token matches.
  if (tokens.includes("create") && tokens.includes("file")) return "edit";
  return "other";
}

/* -------------------------------------------------------------------------- */
/* Events                                                                      */
/* -------------------------------------------------------------------------- */

/** Everything a harness needs to build one event. */
export interface EventInit {
  /** Line the record was read from; part of the event id. */
  line: number;
  /** Sub index of the event inside its record; part of the event id. */
  sub: number;
  /** What the agent did. */
  kind: EventKind;
  /** Start of the event. */
  ts: string;
  /** End of the event, for events that have a duration. */
  endTs?: string;
  /** Turn the event belongs to. */
  turnId?: string;
  /** Step id of the event itself. */
  stepId?: string;
  /** Step id of the parent step, for nested steps. */
  parentStepId?: string;
  /** Outcome of the step. */
  status?: StepStatus;
  /** Failure detail. */
  error?: EventError;
  /** Kind specific attributes. */
  attrs?: Record<string, unknown>;
  /** Captured content. */
  content?: EventContent;
  /** Token accounting. */
  usage?: Usage | null;
  /** Where the record was read from. */
  ref: string;
}

/**
 * Builds canonical events for one source.
 *
 * All ids are derived from the source coordinates of the record
 * (`source`, `source session id`, line, sub index), so re-reading a file
 * always produces the same ids and a sink can upsert idempotently.
 */
export class SourceEventFactory {
  /** Source name, e.g. `"claude-code"`. */
  readonly source: string;
  /** The harness' own id for the session. */
  readonly sourceSessionId: string;
  /** Concrete payload format, e.g. `"claude-code.jsonl"`. */
  readonly format: string;
  /** Canonical session id. */
  readonly sessionId: string;
  /** Version of the format or harness, when known. */
  version?: string;

  constructor(source: string, sourceSessionId: string, format: string, version?: string) {
    this.source = source;
    this.sourceSessionId = sourceSessionId;
    this.format = format;
    this.version = version;
    this.sessionId = sessionId(source, sourceSessionId);
  }

  /** Deterministic id of the event emitted from `line`/`sub`. */
  eventIdFor(line: number, sub: number): string {
    return eventId([this.source, this.sourceSessionId, line, sub]);
  }

  /** Deterministic id of the step emitted from `line`/`sub`. */
  stepIdFor(line: number, sub: number): string {
    return stepId([this.source, this.sourceSessionId, line, sub]);
  }

  /** Deterministic id of the `index`-th turn of the session. */
  turnIdFor(index: number): string {
    return stepId([this.source, this.sourceSessionId, "turn", index]);
  }

  /** Build one canonical event. */
  create(init: EventInit): AgentEvent {
    const event: AgentEvent = {
      schema: "oma.agentobs.v1",
      event_id: this.eventIdFor(init.line, init.sub),
      project_id: PROJECT_ID,
      session_id: this.sessionId,
      ts: init.ts,
      kind: init.kind,
      attrs: init.attrs ?? {},
      source: {
        name: this.source,
        format: this.format,
        ref: init.ref,
      },
    };
    if (this.version !== undefined) event.source.version = this.version;
    if (init.turnId !== undefined) event.turn_id = init.turnId;
    if (init.stepId !== undefined) event.step_id = init.stepId;
    if (init.parentStepId !== undefined) event.parent_step_id = init.parentStepId;
    if (init.endTs !== undefined) event.end_ts = init.endTs;
    if (init.status !== undefined) event.status = init.status;
    if (init.error !== undefined) event.error = init.error;
    if (init.content !== undefined) event.content = init.content;
    if (init.usage !== undefined) event.usage = init.usage;
    return event;
  }
}

/* -------------------------------------------------------------------------- */
/* Tool calls                                                                  */
/* -------------------------------------------------------------------------- */

/** A tool call that is waiting for its result. */
export interface PendingToolCall {
  /** Id the harness uses to pair call and result. */
  callId: string;
  /** Name of the tool. */
  toolName: string;
  /** Parsed arguments, when they could be parsed. */
  args: Record<string, unknown> | undefined;
  /** Arguments exactly as the harness wrote them. */
  rawArgs: unknown;
  /** When the call was issued. */
  ts: string;
  /** Line the call was read from. */
  line: number;
  /** Sub index of the call inside its record. */
  sub: number;
  /** Turn the call belongs to. */
  turnId?: string;
  /** Step id of the `tool.call` event. */
  stepId: string;
  /** The `tool.call` event, updated when the result arrives. */
  event: AgentEvent;
  /** Child steps (`env.command`, `env.file_edit`), updated with the result. */
  children: AgentEvent[];
  /** `true` once a result was seen. */
  resolved: boolean;
}

/** What a harness reported about the result of a tool call. */
export interface ToolOutcome {
  /** Result payload as text. */
  outputText?: string;
  /** Result payload as structured data. */
  outputJson?: unknown;
  /** `true` when the harness marked the result as an error. */
  isError?: boolean;
  /** Error message, when the harness reported one. */
  errorMessage?: string;
  /** When the result was produced. */
  ts?: string;
  /** How long the call took, in milliseconds. */
  durationMs?: number;
  /** Exit code of a shell command, when the harness reported one. */
  exitCode?: number;
}

/**
 * Counts the events emitted from one record.
 *
 * The sub index keeps the event ids of one record apart, and the line number
 * points back at the exact line of the file.
 */
export class EventScope {
  /** Line the current record was read from. */
  line = 0;
  private sub = 0;

  /** Start a new record. */
  begin(line: number): void {
    this.line = line;
    this.sub = 0;
  }

  /** Index of the next event of the current record. */
  next(): number {
    return this.sub++;
  }
}

/** Keeps track of the tool calls of one session. */
export class ToolCallRegistry {
  private readonly byId = new Map<string, PendingToolCall>();
  private readonly ordered: PendingToolCall[] = [];

  /** Remember a call until its result shows up. */
  register(call: PendingToolCall): void {
    if (!this.byId.has(call.callId)) this.ordered.push(call);
    this.byId.set(call.callId, call);
  }

  /** Find a call by its id. */
  find(callId: string): PendingToolCall | undefined {
    return this.byId.get(callId);
  }

  /**
   * The oldest call that is still waiting for a result.
   *
   * Some harnesses report the result of a shell command in a separate record
   * that does not carry the call id; matching it to the oldest open call of
   * the same kind keeps that mapping deterministic.
   */
  findOldestOpen(kind?: ToolKind): PendingToolCall | undefined {
    for (const call of this.ordered) {
      if (call.resolved) continue;
      if (kind !== undefined && toolKindFor(call.toolName) !== kind) continue;
      return call;
    }
    return undefined;
  }

  /** Every call of the session, in the order they were issued. */
  all(): PendingToolCall[] {
    return this.ordered;
  }
}

/** What a harness needs to emit one tool call. */
export interface ToolCallInit {
  /** Id the harness uses to pair call and result. */
  callId: string;
  /** Name of the tool. */
  toolName: string;
  /** Parsed arguments, when they could be parsed. */
  args?: Record<string, unknown> | undefined;
  /** Arguments exactly as the harness wrote them. */
  rawArgs?: unknown;
  /** When the call was issued. */
  ts: string;
  /** Line the call was read from. */
  line: number;
  /** Sub index of the call inside its record. */
  sub: number;
  /** Turn the call belongs to. */
  turnId?: string | undefined;
  /** Where the record was read from. */
  ref: string;
  /** Working directory of the session, when known. */
  cwd?: string | undefined;
  /**
   * Counter of the current record.
   *
   * The child steps of a call take sub indices of their own, so the counter
   * has to know about them.
   */
  scope: EventScope;
  /**
   * Further commands the call ran.
   *
   * Codex bundles several shell commands into one call; each of them becomes
   * its own `env.command` child.
   */
  extraCommands?: string[];
}

/** A tool call event together with the child steps it spawned. */
export interface ToolCallEvents {
  /** The call, so a later result can complete it. */
  call: PendingToolCall;
  /** The `tool.call` event and its children, in emission order. */
  events: AgentEvent[];
}

/**
 * Emit the `tool.call` event of one call, plus the child steps that describe
 * what it did to the environment.
 *
 * Shell tools get an `env.command` child, edit tools an `env.file_edit`
 * child. Both are nested under the call with `parent_step_id`, so the step
 * tree shows "the agent edited a file" inside "the agent called Edit".
 */
export function createToolCall(factory: SourceEventFactory, init: ToolCallInit): ToolCallEvents {
  const kind = toolKindFor(init.toolName);
  const stepId = factory.stepIdFor(init.line, init.sub);

  const input = describeToolInput(init.args, init.rawArgs);
  const event = factory.create({
    line: init.line,
    sub: init.sub,
    kind: "tool.call",
    ts: init.ts,
    turnId: init.turnId,
    stepId,
    attrs: {
      tool_name: init.toolName,
      tool_kind: kind,
      call_id: init.callId,
    },
    content: input ? { input, capture: "full" } : { capture: "full" },
    ref: init.ref,
  });

  const children: AgentEvent[] = [];

  if (kind === "execute") {
    const commands: string[] = [];
    const primary = commandFromArgs(init.args);
    if (primary !== undefined) commands.push(primary);
    for (const extra of init.extraCommands ?? []) {
      if (extra === primary) continue;
      commands.push(extra);
    }

    for (const command of commands) {
      const attrs: Record<string, unknown> = { command };
      if (init.cwd !== undefined) attrs.cwd = init.cwd;
      const childIndex = init.scope.next();
      children.push(
        factory.create({
          line: init.line,
          sub: childIndex,
          kind: "env.command",
          ts: init.ts,
          turnId: init.turnId,
          stepId: factory.stepIdFor(init.line, childIndex),
          parentStepId: stepId,
          attrs,
          ref: init.ref,
        }),
      );
    }
  }

  if (kind === "edit") {
    const filePath = pathFromArgs(init.args);
    if (filePath !== undefined) {
      const childIndex = init.scope.next();
      children.push(
        factory.create({
          line: init.line,
          sub: childIndex,
          kind: "env.file_edit",
          ts: init.ts,
          turnId: init.turnId,
          stepId: factory.stepIdFor(init.line, childIndex),
          parentStepId: stepId,
          attrs: { path: filePath, op: editOpFor(init.toolName, init.args) },
          ref: init.ref,
        }),
      );
    }
  }

  const call: PendingToolCall = {
    callId: init.callId,
    toolName: init.toolName,
    args: init.args,
    rawArgs: init.rawArgs,
    ts: init.ts,
    line: init.line,
    sub: init.sub,
    turnId: init.turnId,
    stepId,
    event,
    children,
    resolved: false,
  };

  return { call, events: [event, ...children] };
}

/**
 * Complete a tool call with the result the harness reported.
 *
 * The `tool.call` event keeps the time of the call in `ts` and gets the time
 * of the result in `end_ts`, so the duration stays correct even though the
 * result arrives in a later record.
 */
export function applyToolOutcome(call: PendingToolCall, outcome: ToolOutcome): void {
  call.resolved = true;

  const event = call.event;
  if (outcome.ts !== undefined) event.end_ts = outcome.ts;

  if (outcome.outputText !== undefined || outcome.outputJson !== undefined) {
    const output =
      outcome.outputText !== undefined
        ? { text: outcome.outputText }
        : { json: outcome.outputJson };
    event.content = { ...(event.content ?? { capture: "full" }), output, capture: "full" };
  }

  // The exit code of a shell command is the error signal of the harnesses
  // that do not report one themselves.
  const exitCode =
    outcome.exitCode ??
    (outcome.outputText !== undefined
      ? parseExitCode(outcome.outputText) ?? parseExitCodeFromJson(outcome.outputText)
      : undefined);
  const failedByExitCode = exitCode !== undefined && exitCode !== 0;

  if (outcome.isError || failedByExitCode) {
    event.status = "error";
    const message = outcome.errorMessage ?? outcome.outputText ?? "tool call failed";
    event.error = {
      type: "tool_error",
      message: message.length > 500 ? `${message.slice(0, 500)}…` : message,
    };
  } else if (event.status === undefined) {
    event.status = "ok";
  }

  const duration =
    outcome.durationMs ??
    (outcome.ts !== undefined ? Date.parse(outcome.ts) - Date.parse(call.ts) : undefined);
  if (duration !== undefined && Number.isFinite(duration) && event.attrs.duration_ms === undefined) {
    // The first duration wins: harnesses that report the runtime of the
    // command itself know more than the wall time between two records.
    event.attrs.duration_ms = duration;
  }

  for (const child of call.children) {
    if (child.kind === "env.command") {
      if (duration !== undefined && Number.isFinite(duration) && child.attrs.duration_ms === undefined) {
        child.attrs.duration_ms = duration;
      }
      if (exitCode !== undefined) child.attrs.exit_code = exitCode;
    }
    if (child.kind === "env.file_edit" && outcome.outputText !== undefined) {
      const bytes = Buffer.byteLength(outcome.outputText, "utf8");
      if (Number.isFinite(bytes)) child.attrs.bytes = bytes;
    }
  }
}

/** Describe the input of a tool call as content. */
function describeToolInput(
  args: Record<string, unknown> | undefined,
  rawArgs: unknown,
): Content | undefined {
  if (args !== undefined) return { json: args };
  if (typeof rawArgs === "string") return { text: rawArgs };
  if (rawArgs !== undefined) return { json: rawArgs };
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Session                                                                     */
/* -------------------------------------------------------------------------- */

/** Attributes of a `session.start` event. */
export interface SessionStartInit {
  /** Name of the harness, e.g. `"claude-code"`. */
  harness: string;
  /** Version of the harness, when it is known. */
  harnessVersion?: string | undefined;
  /** Model the session talked to. */
  model?: string | undefined;
  /** Working directory of the session. */
  cwd?: string | undefined;
  /** Git branch of the working directory. */
  gitBranch?: string | undefined;
  /** Title of the session. */
  title?: string | undefined;
  /** Extra attributes the harness wants to keep. */
  extra?: Record<string, unknown> | undefined;
}

/**
 * Build the attributes of a `session.start` event.
 *
 * Only the fields the harness actually reported end up in the event — a
 * missing `cwd` stays missing instead of becoming an empty string.
 */
export function sessionStartAttrs(init: SessionStartInit): Record<string, unknown> {
  const harness: Record<string, unknown> = { name: init.harness };
  if (init.harnessVersion !== undefined) harness.version = init.harnessVersion;

  const attrs: Record<string, unknown> = { harness };
  if (init.model !== undefined) attrs.model = init.model;
  if (init.cwd !== undefined) attrs.cwd = init.cwd;
  if (init.gitBranch !== undefined) attrs.git = { branch: init.gitBranch };
  if (init.title !== undefined) attrs.title = init.title;
  if (init.extra !== undefined) Object.assign(attrs, init.extra);
  return attrs;
}

/**
 * The `session_id` of a session, derived from the source coordinates.
 *
 * `core` owns the hashing; this is only a convenience for the harnesses.
 */
export function canonicalSessionId(source: string, sourceSessionId: string): string {
  return sessionId(source, sourceSessionId);
}
