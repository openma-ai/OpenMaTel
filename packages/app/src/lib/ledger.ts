/**
 * Pure "ledger" projection of a session (GitHub #76, part 1).
 *
 * The ledger is a flat, ordered list of rows for a Trajectory-style view. It
 * joins the three Query API products — segments, turns and model calls — into
 * rows the UI can render as a virtualized list with sticky turn headers.
 *
 * Design rules:
 *
 * - **No React, no IO.** Everything here is a pure projection, so it is
 *   unit-testable without a DOM or a server.
 * - **Unknown stays unknown.** Missing timestamps, token counts, model names
 *   and durations are `null`; they are never replaced with `0`.
 * - **Stable ids.** A row id is derived from the event / turn / request that
 *   produced it, so re-rendering or re-filtering never reshuffles React keys.
 * - **One-line summaries.** Every summary collapses whitespace and is capped
 *   at {@link SUMMARY_LIMIT} characters.
 */

import type {
  AgentEvent,
  EventKind,
  IdleGap,
  LlmCallPoint,
  LlmCallRetry,
  SegmentView,
  TurnView,
  UsageTotal,
} from "@openmatel/core";

import {
  EM_DASH,
  formatCount,
  formatIdleDuration,
  formatIdleGapLabel,
  formatTokens,
  turnPromptPreview,
} from "./session-format";
import {
  groupTurnsBySegment,
  parseSegmentBoundary,
  type TurnRow,
} from "./session-view";

// The brush time range is defined by the overview projection; re-export the
// mapper here so callers that only work with the ledger can use it too.
export { timeRangeForRange, type OverviewTimeRange } from "./overview-timeline";

/** Maximum length of a ledger summary, in characters. */
export const SUMMARY_LIMIT = 240;

/** Kind of one ledger row. */
export type LedgerRowKind =
  | "turn_header"
  | "segment_boundary"
  | "compaction"
  | "idle_gap"
  | "request"
  | "step"
  | "user"
  | "assistant"
  | "tool"
  | "subtool"
  | "system_prompt"
  | "tools_updated";

/**
 * One row of the flat ledger.
 *
 * `step` is the 1-based ordinal of the step inside its turn (not the raw
 * `step_id`), which is what the "Step N" grouping marker displays.
 */
export interface LedgerRow {
  id: string;
  kind: LedgerRowKind;
  turn_id: string | null;
  segment_id: string;
  step: number | null;
  request_index: number | null;
  /** ISO start timestamp, or `null` when the source did not record one. */
  start: string | null;
  /** ISO end timestamp, or `null` when the row is still running / unknown. */
  end: string | null;
  event_ids: string[];
  /** One line, whitespace collapsed and capped at {@link SUMMARY_LIMIT}. */
  summary: string;
  error: boolean;
  status: string;
}

/** Input of {@link buildLedger}. */
export interface BuildLedgerInput {
  segments: readonly SegmentView[];
  turns: readonly TurnView[];
  calls: readonly LlmCallPoint[];
}

/** A wall-clock range in epoch milliseconds or ISO strings. */
export interface LedgerTimeRange {
  start: number | string;
  end: number | string;
}

/** Options of {@link filterLedger}. */
export interface FilterLedgerOptions {
  /** Case-insensitive search over `summary` and `kind`. */
  query?: string;
  /** Brushed turn ids; rows outside the selection are dimmed, not removed. */
  turnIds?: ReadonlySet<string> | null;
  /**
   * Brushed wall-clock range. Rows whose time does not overlap it are dimmed,
   * not removed. Values may be epoch milliseconds or ISO strings.
   */
  timeRange?: LedgerTimeRange | null;
  /** Turns whose rows collapse to their `turn_header`. */
  collapsedTurns?: ReadonlySet<string>;
  /** Hide `tool`/`subtool` rows but keep request separators with a count. */
  collapseCalls?: boolean;
  /** Remove dimmed rows instead of returning them in `dimmed`. */
  hideDimmed?: boolean;
}

/** Result of {@link filterLedger}. */
export interface FilterLedgerResult {
  rows: LedgerRow[];
  /** Ids of rows whose summary or kind matched the query. */
  matches: Set<string>;
  /** Ids of rows dimmed by the active turn or time selection. */
  dimmed: Set<string>;
}

/** Options of {@link tailWindow}. */
export interface TailWindowOptions {
  /** Maximum number of rows to return. */
  size: number;
  /** Exclusive end index; defaults to the end of the list. */
  before?: number;
}

/** Result of {@link tailWindow}. */
export interface TailWindowResult {
  rows: LedgerRow[];
  /** `true` when rows before `start` exist and can be requested. */
  hasEarlier: boolean;
  /** Index of the first returned row in the input list. */
  start: number;
}

/** Per-request timing metrics. Every field is `null` when unavailable. */
export interface RequestTiming {
  start: number | string | null;
  total_ms: number | string | null;
  ttft_ms: number | string | null;
  generation_ms: number | string | null;
  throughput_tps: number | string | null;
}

/** The five token figures shown for one request or for the session. */
export interface LedgerUsageFigures {
  input: number | null;
  cache_read: number | null;
  cache_write: number | null;
  output: number | null;
  context: number | null;
}

/** Per-request usage compared with the session totals. */
export interface LedgerUsageComparison {
  request: LedgerUsageFigures;
  session: LedgerUsageFigures;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

const asFiniteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const asNonNegative = (value: unknown): number | null => {
  const number = asFiniteNumber(value);
  return number !== null && number >= 0 ? number : null;
};

const timeOf = (value: string | null | undefined): number | null => {
  if (typeof value !== "string" || value === "") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
};

const asIso = (value: string | null | undefined): string | null =>
  timeOf(value) === null ? null : value ?? null;

const isoAt = (value: number): string | null =>
  Number.isFinite(value) ? new Date(value).toISOString() : null;

/** Parse either an epoch-millisecond number or an ISO timestamp. */
const instantOf = (value: number | string | null | undefined): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value === "") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
};

interface ResolvedTimeRange {
  start: number;
  end: number;
}

function resolveTimeRange(
  range: LedgerTimeRange | null | undefined,
): ResolvedTimeRange | null {
  if (range === null || range === undefined) return null;
  const start = instantOf(range.start);
  const end = instantOf(range.end);
  if (start === null || end === null) return null;
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

interface RowInterval {
  start: number;
  end: number;
}

/**
 * Effective wall-clock interval of every row.
 *
 * A row with no timestamp inherits the start of the nearest previous row that
 * has one, so old or synthetic events still sort into the brushed window.
 */
function rowIntervals(rows: readonly LedgerRow[]): Map<string, RowInterval> {
  const intervals = new Map<string, RowInterval>();
  let previous: number | null = null;
  for (const row of rows) {
    const start: number | null =
      instantOf(row.start) ?? instantOf(row.end) ?? previous;
    const end: number | null = instantOf(row.end) ?? start;
    if (start !== null) previous = start;
    if (start !== null && end !== null) {
      intervals.set(row.id, { start, end });
    }
  }
  return intervals;
}

const intervalsOverlap = (left: RowInterval, right: ResolvedTimeRange): boolean =>
  left.start <= right.end && left.end >= right.start;

function rowOverlapsRange(
  row: LedgerRow,
  intervals: ReadonlyMap<string, RowInterval>,
  range: ResolvedTimeRange,
): boolean {
  const interval = intervals.get(row.id);
  return interval !== undefined && intervalsOverlap(interval, range);
}

/**
 * Kinds that only describe the shape of the timeline. They can span a whole
 * turn or segment, so they are poor reveal targets for a brushed range.
 */
const isStructuralRowKind = (kind: LedgerRowKind): boolean =>
  kind === "turn_header" ||
  kind === "segment_boundary" ||
  kind === "request" ||
  kind === "idle_gap";

/**
 * Index of the row that should be revealed for `range`, or `-1` when no row
 * does. Used to scroll the ledger to the start of a brushed window.
 *
 * Structural rows (turn headers, segment boundaries, request separators and
 * idle gaps) are skipped while a content row is available: a turn header spans
 * the whole turn, so it would otherwise always steal the reveal. Prefer the
 * first content row that *starts* inside the range, then the first content row
 * that merely overlaps it. Only a ledger with no content rows at all falls back
 * to structural chrome.
 */
export function firstRowIndexInTimeRange(
  rows: readonly LedgerRow[],
  range: LedgerTimeRange | null | undefined,
): number {
  const resolved = resolveTimeRange(range);
  if (resolved === null) return -1;
  const intervals = rowIntervals(rows);

  let firstOverlap = -1;
  let hasContent = false;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (isStructuralRowKind(row.kind)) continue;
    hasContent = true;

    const interval = intervals.get(row.id);
    if (interval === undefined || !intervalsOverlap(interval, resolved)) continue;
    if (firstOverlap < 0) firstOverlap = index;

    const ownStart = instantOf(row.start);
    if (
      ownStart !== null &&
      ownStart >= resolved.start &&
      ownStart <= resolved.end
    ) {
      return index;
    }
  }

  if (hasContent) return firstOverlap;
  return rows.findIndex((row) => rowOverlapsRange(row, intervals, resolved));
}

/** Collapse whitespace and cap a summary at {@link SUMMARY_LIMIT}. */
function oneLine(text: string, max = SUMMARY_LIMIT): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat === "") return "";
  if (max <= 0) return "";
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1))}…`;
}

const joinParts = (parts: Array<string | null>): string =>
  oneLine(parts.filter((part): part is string => part !== null && part !== "").join(" · "));

/** Compact, single-line JSON used by tool summaries. */
function compactJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return String(value);
  }
}

/** Plain text of one side of a captured payload. */
function contentText(event: AgentEvent, side: "input" | "output"): string {
  const part = event.content?.[side];
  if (part === undefined) return "";
  if (typeof part.text === "string") return part.text;
  if (part.json !== undefined) return compactJson(part.json);
  return "";
}

function messageText(event: AgentEvent, preferred: "input" | "output"): string {
  const primary = contentText(event, preferred);
  if (primary.trim() !== "") return primary;
  return contentText(event, preferred === "input" ? "output" : "input");
}

/** First non-empty line of a payload, collapsed for a one-line summary. */
function firstLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const flat = oneLine(line);
    if (flat !== "") return flat;
  }
  return "";
}

function toolInput(event: AgentEvent): unknown {
  const part = event.content?.input;
  if (part === undefined) return undefined;
  if (part.json !== undefined) return part.json;
  if (typeof part.text !== "string") return undefined;

  const trimmed = part.text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      // Not JSON after all; keep the original text.
    }
  }
  return part.text;
}

/** `true` when the event carries a successful-looking tool-call payload. */
function hasToolCalls(event: AgentEvent): boolean {
  const attrs = isObject(event.attrs) ? event.attrs : {};
  for (const key of ["tool_calls", "toolCalls"] as const) {
    const value = attrs[key];
    if (Array.isArray(value) && value.length > 0) return true;
  }

  const json = event.content?.output?.json;
  if (Array.isArray(json)) {
    return json.some(
      (block) =>
        isObject(block) &&
        (block.type === "tool_use" || block.type === "tool_call" || block.type === "tool-call"),
    );
  }
  if (isObject(json)) {
    if (Array.isArray(json.tool_calls) && json.tool_calls.length > 0) return true;
    if (Array.isArray(json.content)) {
      return json.content.some(
        (block) =>
          isObject(block) &&
          (block.type === "tool_use" || block.type === "tool_call" || block.type === "tool-call"),
      );
    }
  }
  return false;
}

const ERROR_STATUSES: ReadonlySet<string> = new Set([
  "error",
  "timeout",
  "denied",
  "cancelled",
  "interrupted",
]);

function isErrorStatus(status: string | undefined): boolean {
  return status !== undefined && ERROR_STATUSES.has(status);
}

function eventError(event: AgentEvent): boolean {
  if (event.error !== undefined) return true;
  if (isErrorStatus(event.status)) return true;
  const exitCode = asFiniteNumber(event.attrs.exit_code);
  return exitCode !== null && exitCode !== 0;
}

function eventStatus(event: AgentEvent, fallback = "ok"): string {
  if (event.status !== undefined) return event.status;
  if (event.error !== undefined) return "error";
  return fallback;
}

function toolSummary(event: AgentEvent): string {
  const attrs = isObject(event.attrs) ? event.attrs : {};
  const toolName = asString(attrs.tool_name) ?? "tool";
  const input = toolInput(event);
  const args = input === undefined ? "" : ` ${compactJson(input)}`;
  const output = firstLine(contentText(event, "output")) || firstLine(event.error?.message ?? "");
  const child = asString(attrs.child_session_id);
  const arrow = output === "" ? "→" : `→ ${output}`;
  const parts = [`${toolName}${args} ${arrow}`];
  if (child !== null) parts.push(`child ${child}`);
  return joinParts(parts);
}

function subagentSummary(event: AgentEvent): string {
  const attrs = isObject(event.attrs) ? event.attrs : {};
  const name = asString(attrs.agent_name) ?? "subagent";
  const task = asString(attrs.task);
  const child = asString(attrs.child_session_id);
  return joinParts([
    name,
    task === null ? null : firstLine(task),
    child === null ? null : `child ${child}`,
  ]);
}

function systemPromptSummary(event: AgentEvent): string {
  const attrs = isObject(event.attrs) ? event.attrs : {};
  const change = asString(attrs.change);
  const length = asFiniteNumber(attrs.length_chars);
  const hash = asString(attrs.hash);
  return joinParts([
    "System prompt updated",
    change,
    length === null ? null : `${length} chars`,
    hash === null ? null : `#${hash.slice(0, 8)}`,
  ]);
}

function toolsUpdatedSummary(event: AgentEvent): string {
  const attrs = isObject(event.attrs) ? event.attrs : {};
  const count = asFiniteNumber(attrs.tool_count);
  const added = Array.isArray(attrs.added)
    ? attrs.added.filter((name): name is string => typeof name === "string")
    : [];
  const removed = Array.isArray(attrs.removed)
    ? attrs.removed.filter((name): name is string => typeof name === "string")
    : [];
  return joinParts([
    "Tools updated",
    count === null ? null : `${count} tools`,
    added.length === 0 ? null : `+${added.join(", ")}`,
    removed.length === 0 ? null : `-${removed.join(", ")}`,
  ]);
}

function endFromDuration(event: AgentEvent): string | null {
  const start = timeOf(event.ts);
  const duration = asNonNegative(event.attrs.duration_ms);
  if (start === null || duration === null) return null;
  return isoAt(start + duration);
}

interface EventDraft {
  kind: LedgerRowKind;
  summary: string;
  error: boolean;
  status: string;
  start: string | null;
  end: string | null;
  event_ids: string[];
}

function eventDraft(event: AgentEvent): EventDraft | null {
  const start = asIso(event.ts);
  const end = asIso(event.end_ts);
  const common = {
    error: eventError(event),
    start,
    event_ids: [event.event_id],
  };

  switch (event.kind) {
    case "message.user": {
      const text = oneLine(messageText(event, "input"));
      return {
        ...common,
        kind: "user",
        summary: text === "" ? "(empty message)" : text,
        status: eventStatus(event),
        end,
      };
    }
    case "message.agent": {
      const text = oneLine(messageText(event, "output"));
      const summary =
        text !== "" ? text : hasToolCalls(event) ? "(tool call only)" : "(empty message)";
      return {
        ...common,
        kind: "assistant",
        summary,
        status: eventStatus(event),
        end,
      };
    }
    case "tool.call": {
      const nested =
        event.parent_step_id !== undefined ||
        asString(event.attrs.child_session_id) !== null;
      return {
        ...common,
        kind: nested ? "subtool" : "tool",
        summary: toolSummary(event),
        status:
          event.status === undefined && event.end_ts === undefined && event.error === undefined
            ? "running"
            : eventStatus(event),
        end: end ?? endFromDuration(event),
      };
    }
    case "subagent.spawn":
    case "handoff":
      return {
        ...common,
        kind: "subtool",
        summary: subagentSummary(event),
        status: eventStatus(event),
        end,
      };
    case "context.system_prompt":
      return {
        ...common,
        kind: "system_prompt",
        summary: systemPromptSummary(event),
        status: eventStatus(event),
        end,
      };
    case "context.tool_catalog":
      return {
        ...common,
        kind: "tools_updated",
        summary: toolsUpdatedSummary(event),
        status: eventStatus(event),
        end,
      };
    default:
      // turn.start/end, session envelopes, raw events and control records are
      // not rows of the Trajectory ledger.
      return null;
  }
}

function parseRetry(value: unknown): LlmCallRetry | null {
  if (!isObject(value)) return null;
  const attempt = asFiniteNumber(value.attempt);
  if (attempt === null || !Number.isInteger(attempt) || attempt < 1) return null;
  return {
    attempt,
    max_attempts: (() => {
      const max = asFiniteNumber(value.max_attempts);
      return max !== null && Number.isInteger(max) && max >= 1 ? max : null;
    })(),
    delay_ms: asNonNegative(value.delay_ms),
    error_code: asString(value.error_code),
  };
}

interface RequestInfo {
  step_id: string | null;
  request_index: number | null;
  model: string | null;
  retry: LlmCallRetry | null;
  start: string | null;
  end: string | null;
  stop_reason: string | null;
  error: boolean;
  event_id: string | null;
}

function requestFromCall(call: LlmCallPoint): RequestInfo {
  const start = timeOf(call.ts);
  const latency = asNonNegative(call.latency_ms);
  return {
    step_id: call.step_id,
    request_index: call.request_index,
    model: call.model,
    retry: call.retry,
    start: asIso(call.ts),
    end:
      asIso(call.end_ts) ??
      (start === null || latency === null ? null : isoAt(start + latency)),
    stop_reason: call.stop_reason,
    error: false,
    event_id: null,
  };
}

function requestFromEvent(event: AgentEvent): RequestInfo {
  const attrs = isObject(event.attrs) ? event.attrs : {};
  const requestIndex = asFiniteNumber(attrs.request_index);
  const start = timeOf(event.ts);
  const latency = asNonNegative(attrs.latency_ms);
  return {
    step_id: asString(event.step_id),
    request_index:
      requestIndex !== null && Number.isInteger(requestIndex) && requestIndex >= 1
        ? requestIndex
        : null,
    model: asString(attrs.model),
    retry: parseRetry(attrs.retry),
    start: asIso(event.ts),
    end:
      asIso(event.end_ts) ??
      (start === null || latency === null ? null : isoAt(start + latency)),
    stop_reason: asString(attrs.stop_reason),
    error: eventError(event),
    event_id: event.event_id,
  };
}

function requestSummary(info: RequestInfo): string {
  const retry =
    info.retry === null
      ? null
      : `retry ${info.retry.attempt}${
          info.retry.max_attempts === null ? "" : `/${info.retry.max_attempts}`
        }`;
  return joinParts([
    info.request_index === null ? "Request" : `Request #${info.request_index}`,
    info.model,
    retry,
    info.retry?.error_code ?? null,
  ]);
}

function boundarySummary(boundary: AgentEvent): string {
  const info = parseSegmentBoundary(boundary);
  return joinParts([
    "Segment boundary",
    info.reason,
    info.context_tokens_before === null || info.context_tokens_after === null
      ? null
      : `${info.context_tokens_before} → ${info.context_tokens_after} tokens`,
    info.tokens_removed === null ? null : `${info.tokens_removed} tokens removed`,
    info.summary === null ? null : firstLine(info.summary),
  ]);
}

function compactionSummary(boundary: AgentEvent): string {
  const info = parseSegmentBoundary(boundary);
  if (info.summary !== null) return oneLine(info.summary);
  return joinParts([
    "Context compacted",
    info.tokens_removed === null ? null : `${info.tokens_removed} tokens removed`,
    info.context_tokens_before === null || info.context_tokens_after === null
      ? null
      : `${info.context_tokens_before} → ${info.context_tokens_after} tokens`,
  ]);
}

const turnStart = (turn: TurnView): string | null => {
  const start = asIso(turn.ts);
  if (start !== null) return start;
  for (const event of turn.events) {
    const eventStart = asIso(event.ts);
    if (eventStart !== null) return eventStart;
  }
  return null;
};

const turnEnd = (turn: TurnView): string | null => {
  if (turn.end_ts !== null) return asIso(turn.end_ts);
  let latest: string | null = null;
  let latestTime: number | null = null;
  for (const event of turn.events) {
    const value = asIso(event.end_ts ?? event.ts);
    const time = timeOf(value);
    if (time !== null && (latestTime === null || time > latestTime)) {
      latest = value;
      latestTime = time;
    }
  }
  return latest;
};

function promptOf(turn: TurnView): string | null {
  if (turn.prompt !== null && turn.prompt.trim() !== "") return turn.prompt;
  for (const event of turn.events) {
    if (event.kind !== "message.user") continue;
    const text = messageText(event, "input");
    if (text.trim() !== "") return text;
  }
  return null;
}

function turnHeader(turn: TurnView, index: number): LedgerRow {
  const lastEvent = turn.events[turn.events.length - 1];
  const status = turn.status ?? lastEvent?.status ?? "unknown";
  const error = isErrorStatus(turn.status) || isErrorStatus(lastEvent?.status);
  const prompt = turnPromptPreview(promptOf(turn));
  const summary = joinParts([
    `Turn ${index + 1}`,
    prompt === EM_DASH ? null : prompt,
    `${formatCount(turn.step_count)} steps`,
    `active ${formatIdleDuration(turn.active_ms)}`,
    `in ${formatTokens(turn.tokens_in)}`,
    `out ${formatTokens(turn.output_tokens)}`,
  ]);
  return {
    id: `turn:${turn.turn_id}:header`,
    kind: "turn_header",
    turn_id: turn.turn_id,
    segment_id: turn.segment_id,
    step: null,
    request_index: null,
    start: turnStart(turn),
    end: turnEnd(turn),
    event_ids: turn.events.map((event) => event.event_id),
    summary,
    error,
    status,
  };
}

function idleRow(
  gap: IdleGap,
  segmentId: string,
  turnId: string | null,
  requestIndex: number | null = null,
  step: number | null = null,
): LedgerRow {
  return {
    id: `idle:${gap.after_event_id}:${gap.before_event_id}`,
    kind: "idle_gap",
    turn_id: turnId,
    segment_id: segmentId,
    step,
    request_index: requestIndex,
    start: asIso(gap.start),
    end: asIso(gap.end),
    event_ids: [gap.after_event_id, gap.before_event_id],
    summary: formatIdleGapLabel(gap.duration_ms),
    error: false,
    status: "idle",
  };
}

type Seed =
  | { type: "event"; at: number; order: number; event: AgentEvent }
  | { type: "request"; at: number; order: number; info: RequestInfo }
  | { type: "gap"; at: number; order: number; gap: IdleGap };

/**
 * Where a step first appears in the ledger. Step numbers live in the row
 * gutter now, so a marker is only materialised as a standalone row when the
 * step produced no other rows at all, is not a model call and has a kind that
 * can stand on its own.
 */
interface StepAnchor {
  index: number;
  ordinal: number;
  stepId: string;
  kind: EventKind;
  requestIndex: number | null;
  seed: Seed;
  event: AgentEvent | null;
}

/**
 * Kinds that may get a standalone step row when the step produced nothing
 * else.
 *
 * This is deliberately an allow-list: model calls have their request
 * separator, while env/environment, context, reasoning, memory, skill and
 * lifecycle/control events only describe the envelope around a step. A
 * permission or approval is the exception — it is meaningful on its own even
 * when no other row was recorded.
 */
const STANDALONE_STEP_KINDS: ReadonlySet<EventKind> = new Set<EventKind>([
  "permission.request",
  "permission.decision",
]);

const isStandaloneStepKind = (kind: EventKind): boolean =>
  STANDALONE_STEP_KINDS.has(kind);

/** The coarse, human-readable kind shown by a standalone step row. */
const stepKindLabel = (kind: EventKind): string => kind.split(".")[0] ?? kind;

const seedPriority = (seed: Seed): number => {
  switch (seed.type) {
    case "gap":
      return 0;
    case "request":
      return 1;
    default:
      return 2;
  }
};

function sortSeeds(seeds: Seed[]): void {
  seeds.sort((left, right) => {
    if (left.at !== right.at) return left.at - right.at;
    const priority = seedPriority(left) - seedPriority(right);
    if (priority !== 0) return priority;
    return left.order - right.order;
  });
}

function compareEvents(left: AgentEvent, right: AgentEvent): number {
  const leftTime = timeOf(left.ts);
  const rightTime = timeOf(right.ts);
  if (leftTime !== null && rightTime !== null && leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  if (leftTime === null && rightTime !== null) return 1;
  if (leftTime !== null && rightTime === null) return -1;
  if (left.ts !== right.ts) return left.ts < right.ts ? -1 : 1;
  return left.event_id < right.event_id ? -1 : left.event_id > right.event_id ? 1 : 0;
}

function compareTurns(left: TurnView, right: TurnView): number {
  const leftTime = timeOf(left.ts);
  const rightTime = timeOf(right.ts);
  if (leftTime !== null && rightTime !== null && leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  if (leftTime === null && rightTime !== null) return 1;
  if (leftTime !== null && rightTime === null) return -1;
  return left.turn_id < right.turn_id ? -1 : left.turn_id > right.turn_id ? 1 : 0;
}

/** Find, and mark used, the call matching one `llm.call` event. */
function takeCallForEvent(
  event: AgentEvent,
  calls: readonly LlmCallPoint[],
  used: Set<LlmCallPoint>,
): LlmCallPoint | undefined {
  const stepId = asString(event.step_id);
  if (stepId !== null) {
    const match = calls.find((call) => !used.has(call) && call.step_id === stepId);
    if (match !== undefined) {
      used.add(match);
      return match;
    }
  }

  const requestIndex = asFiniteNumber(event.attrs.request_index);
  const turnId = asString(event.turn_id);
  const match = calls.find(
    (call) =>
      !used.has(call) &&
      (requestIndex === null || call.request_index === requestIndex) &&
      (turnId === null || call.turn_id === null || call.turn_id === turnId) &&
      (call.ts === event.ts || call.step_id === stepId),
  );
  if (match !== undefined) used.add(match);
  return match;
}

function turnRowsFor(
  turnRow: TurnRow,
  calls: readonly LlmCallPoint[],
  usedCalls: Set<LlmCallPoint>,
): LedgerRow[] {
  const turn = turnRow.turn;
  const seeds: Seed[] = [];
  const events = [...turn.events].sort(compareEvents);
  let order = 0;

  for (const event of events) {
    if (event.kind === "llm.call") {
      const call = takeCallForEvent(event, calls, usedCalls);
      const info = call === undefined ? requestFromEvent(event) : requestFromCall(call);
      if (call !== undefined) {
        info.start = asIso(call.ts) ?? asIso(event.ts);
        info.end = info.end ?? requestFromEvent(event).end;
        info.event_id = event.event_id;
      }
      if (info.request_index !== null) {
        seeds.push({ type: "request", at: timeOf(info.start) ?? Number.MAX_SAFE_INTEGER, order: order++, info });
      } else if (asString(event.step_id) !== null) {
        // A call without a request index has no separator row; keep a seed so
        // its step can still appear (standalone when it has no peers).
        seeds.push({
          type: "event",
          at: timeOf(event.ts) ?? Number.MAX_SAFE_INTEGER,
          order: order++,
          event,
        });
      }
      continue;
    }

    if (eventDraft(event) === null) {
      // Unprojected lifecycle events still identify their step. They only
      // materialise a row when the step produced nothing else.
      if (asString(event.step_id) !== null) {
        seeds.push({
          type: "event",
          at: timeOf(event.ts) ?? Number.MAX_SAFE_INTEGER,
          order: order++,
          event,
        });
      }
      continue;
    }
    seeds.push({
      type: "event",
      at: timeOf(event.ts) ?? Number.MAX_SAFE_INTEGER,
      order: order++,
      event,
    });
  }

  for (const call of calls) {
    if (usedCalls.has(call)) continue;
    if (call.turn_id !== turn.turn_id) continue;
    usedCalls.add(call);
    const info = requestFromCall(call);
    if (info.request_index === null) continue;
    seeds.push({
      type: "request",
      at: timeOf(info.start) ?? Number.MAX_SAFE_INTEGER,
      order: order++,
      info,
    });
  }

  for (const gap of turnRow.internal_idle_gaps) {
    seeds.push({
      type: "gap",
      at: timeOf(gap.end) ?? timeOf(gap.start) ?? Number.MAX_SAFE_INTEGER,
      order: order++,
      gap,
    });
  }

  sortSeeds(seeds);

  // A step is covered by a request separator when the separator belongs to
  // the same step. Such a step must not get a second, standalone "Step N"
  // row; lifecycle events with a request index are already excluded by the
  // standalone-kind allow-list.
  const requestStepIds = new Set<string>();
  for (const seed of seeds) {
    if (seed.type !== "request") continue;
    if (seed.info.step_id !== null) requestStepIds.add(seed.info.step_id);
  }

  const rows: LedgerRow[] = [];
  const stepAnchors: StepAnchor[] = [];
  const stepOrdinals = new Map<string, number>();
  let nextStep = 1;
  let currentStepId: string | null = null;
  let currentStep: number | null = null;
  let currentRequest: number | null = null;

  const stepIdOf = (seed: Seed): string | null => {
    if (seed.type === "event") return asString(seed.event.step_id);
    if (seed.type === "request") return seed.info.step_id;
    return null;
  };

  const ensureStep = (stepId: string): number => {
    let ordinal = stepOrdinals.get(stepId);
    if (ordinal === undefined) {
      ordinal = nextStep;
      nextStep += 1;
      stepOrdinals.set(stepId, ordinal);
    }
    return ordinal;
  };

  const stepRow = (anchor: StepAnchor): LedgerRow => {
    const { seed } = anchor;
    const eventId =
      seed.type === "event"
        ? seed.event.event_id
        : seed.type === "request"
          ? seed.info.event_id
          : null;
    const seedKey =
      seed.type === "request"
        ? `request-${seed.info.request_index ?? "unknown"}`
        : seed.type === "event"
          ? `event-${eventId ?? "unknown"}`
          : "gap";
    return {
      id: `step:${turn.turn_id}:${anchor.stepId}:${seedKey}`,
      kind: "step",
      turn_id: turn.turn_id,
      segment_id: turn.segment_id,
      step: anchor.ordinal,
      request_index: anchor.requestIndex,
      start: isoAt(seed.at),
      end: null,
      event_ids: eventId === null ? [] : [eventId],
      summary: joinParts([`Step ${anchor.ordinal}`, stepKindLabel(anchor.kind)]),
      error: false,
      status: "ok",
    };
  };

  const isRequestCovered = (anchor: StepAnchor): boolean =>
    anchor.stepId !== null && requestStepIds.has(anchor.stepId);

  for (const seed of seeds) {
    if (seed.type === "gap") {
      rows.push(
        idleRow(
          seed.gap,
          turn.segment_id,
          turn.turn_id,
          currentRequest,
          currentStep,
        ),
      );
      continue;
    }

    const stepId = stepIdOf(seed);
    if (stepId !== null && stepId !== currentStepId) {
      currentStepId = stepId;
      currentStep = ensureStep(stepId);
      stepAnchors.push({
        index: rows.length,
        ordinal: currentStep,
        stepId,
        kind: seed.type === "request" ? "llm.call" : seed.event.kind,
        requestIndex:
          seed.type === "request" ? seed.info.request_index : currentRequest,
        seed,
        event: seed.type === "event" ? seed.event : null,
      });
    }

    if (seed.type === "request") {
      currentRequest = seed.info.request_index;
      rows.push({
        id: `request:${turn.turn_id}:${seed.info.request_index ?? "unknown"}:${
          seed.info.step_id ?? "nostep"
        }:${seed.info.start ?? "notime"}`,
        kind: "request",
        turn_id: turn.turn_id,
        segment_id: turn.segment_id,
        step: currentStep,
        request_index: seed.info.request_index,
        start: seed.info.start,
        end: seed.info.end,
        event_ids: seed.info.event_id === null ? [] : [seed.info.event_id],
        summary: requestSummary(seed.info),
        error: seed.info.error,
        status: "ok",
      });
      continue;
    }

    const draft = eventDraft(seed.event);
    if (draft === null) continue;
    rows.push({
      id: `row:${seed.event.event_id}:${draft.kind}`,
      kind: draft.kind,
      turn_id: turn.turn_id,
      segment_id: turn.segment_id,
      step: currentStep,
      request_index: currentRequest,
      start: draft.start,
      end: draft.end,
      event_ids: draft.event_ids,
      summary: draft.summary,
      error: draft.error,
      status: draft.status,
    });
  }

  // Step numbers are rendered in the row gutter, so only a non-model step of
  // a known kind that never produced another row keeps a standalone marker.
  const representedSteps = new Set<number>();
  for (const row of rows) {
    if (row.step !== null) representedSteps.add(row.step);
  }
  let inserted = 0;
  for (const anchor of stepAnchors) {
    if (representedSteps.has(anchor.ordinal)) continue;
    if (!isStandaloneStepKind(anchor.kind)) continue;
    if (isRequestCovered(anchor)) continue;
    rows.splice(anchor.index + inserted, 0, stepRow(anchor));
    inserted += 1;
  }

  return rows;
}

/**
 * Project segments, turns and model calls into the flat Trajectory ledger.
 *
 * Rows are ordered by segment, then turn, then event/request time. Segment
 * boundaries and idle gaps are kept even when a segment has no turns, so the
 * UI never silently drops context chrome.
 */
export function buildLedger(input: BuildLedgerInput): LedgerRow[] {
  const turns = [...input.turns].sort(compareTurns);
  const groups = groupTurnsBySegment(input.segments, turns);
  const rows: LedgerRow[] = [];
  const usedCalls = new Set<LlmCallPoint>();
  let turnNumber = 0;

  for (const group of groups) {
    const segmentId = group.segment_id;

    for (const gap of group.leading_idle_gaps) {
      rows.push(idleRow(gap, segmentId, null));
    }

    const boundary = group.segment?.boundary;
    if (boundary !== undefined) {
      const info = parseSegmentBoundary(boundary);
      rows.push({
        id: `segment:${segmentId}:boundary`,
        kind: "segment_boundary",
        turn_id: null,
        segment_id: segmentId,
        step: null,
        request_index: null,
        start: asIso(boundary.ts),
        end: asIso(boundary.end_ts),
        event_ids: [boundary.event_id],
        summary: boundarySummary(boundary),
        error: eventError(boundary),
        status: eventStatus(boundary, "unknown"),
      });

      if (info.reason === "compaction") {
        rows.push({
          id: `segment:${segmentId}:compaction`,
          kind: "compaction",
          turn_id: null,
          segment_id: segmentId,
          step: null,
          request_index: null,
          start: asIso(boundary.ts),
          end: asIso(boundary.end_ts),
          event_ids: [boundary.event_id],
          summary: compactionSummary(boundary),
          error: eventError(boundary),
          status: eventStatus(boundary, "unknown"),
        });
      }
    }

    for (const turnRow of group.turns) {
      const turn = turnRow.turn;
      for (const gap of turnRow.preceding_idle_gaps) {
        rows.push(idleRow(gap, segmentId, turn.turn_id));
      }
      rows.push(turnHeader(turn, turnNumber));
      turnNumber += 1;
      rows.push(...turnRowsFor(turnRow, input.calls, usedCalls));
    }
  }

  return rows;
}

/**
 * Filter the ledger for the UI.
 *
 * - The query only marks matches; it never removes rows.
 * - A brushed turn selection dims rows outside it (or removes them when
 *   `hideDimmed` is set).
 * - A brushed time range additionally dims rows whose effective interval does
 *   not overlap it. The two dim rules are unioned: either one can dim a row.
 *   A turn header that overlaps the range always stays undimmed.
 * - A collapsed turn keeps only its header.
 * - `collapseCalls` removes tool/subtool rows and annotates the request
 *   separator with the number it hid.
 */
export function filterLedger(
  rows: readonly LedgerRow[],
  options: FilterLedgerOptions = {},
): FilterLedgerResult {
  const query = options.query?.trim().toLowerCase() ?? "";
  const matches = new Set<string>();
  if (query !== "") {
    for (const row of rows) {
      if (row.summary.toLowerCase().includes(query) || row.kind.toLowerCase().includes(query)) {
        matches.add(row.id);
      }
    }
  }

  const dimmed = new Set<string>();
  const turnIds = options.turnIds ?? null;
  const timeRange = resolveTimeRange(options.timeRange);
  const intervals = timeRange === null ? null : rowIntervals(rows);
  for (const row of rows) {
    const inTimeRange =
      timeRange !== null &&
      intervals !== null &&
      rowOverlapsRange(row, intervals, timeRange);
    const inTurnSelection =
      turnIds === null || row.turn_id === null || turnIds.has(row.turn_id);

    // A header spanning the brushed window is context for the rows inside it,
    // so keep it lit even when its turn id was not part of the selection.
    if (row.kind === "turn_header" && inTimeRange) continue;

    if (!inTurnSelection || (timeRange !== null && !inTimeRange)) {
      dimmed.add(row.id);
    }
  }

  const collapsed = options.collapsedTurns;
  let visible =
    collapsed === undefined || collapsed.size === 0
      ? [...rows]
      : rows.filter(
          (row) =>
            row.turn_id === null || !collapsed.has(row.turn_id) || row.kind === "turn_header",
        );

  if (options.collapseCalls === true) {
    const hiddenByRequest = new Map<string, number>();
    let currentRequestId: string | null = null;
    for (const row of visible) {
      if (row.kind === "request") {
        currentRequestId = row.id;
        continue;
      }
      if (
        currentRequestId !== null &&
        (row.kind === "tool" || row.kind === "subtool")
      ) {
        hiddenByRequest.set(
          currentRequestId,
          (hiddenByRequest.get(currentRequestId) ?? 0) + 1,
        );
      }
    }

    visible = visible
      .filter((row) => row.kind !== "tool" && row.kind !== "subtool")
      .map((row) => {
        if (row.kind !== "request") return row;
        const hidden = hiddenByRequest.get(row.id) ?? 0;
        if (hidden === 0) return row;
        return {
          ...row,
          summary: oneLine(`${row.summary} · ${hidden} tool call${hidden === 1 ? "" : "s"}`),
        };
      });
  }

  if (options.hideDimmed === true && dimmed.size > 0) {
    visible = visible.filter((row) => !dimmed.has(row.id));
  }

  return { rows: visible, matches, dimmed };
}

/** Compact request timing. Unknown values stay `null`, never `0`. */
export function requestTiming(call: LlmCallPoint | undefined): RequestTiming {
  if (call === undefined) {
    return {
      start: null,
      total_ms: null,
      ttft_ms: null,
      generation_ms: null,
      throughput_tps: null,
    };
  }

  const start = asIso(call.ts);
  const startTime = timeOf(start);
  const endTime = timeOf(call.end_ts);

  const reportedTotal = asNonNegative(call.latency_ms);
  const computedTotal =
    startTime === null || endTime === null ? null : Math.max(0, endTime - startTime);
  const total = reportedTotal ?? computedTotal;

  const ttft = asNonNegative(call.ttft_ms);
  const reportedGeneration = asNonNegative(call.decode_ms);
  const computedGeneration =
    total === null || ttft === null ? null : total - ttft;
  const generation =
    reportedGeneration ??
    (computedGeneration !== null && computedGeneration >= 0 ? computedGeneration : null);

  const output = asNonNegative(call.output);
  const throughput =
    output !== null && generation !== null && generation > 0
      ? output / (generation / 1_000)
      : null;

  return {
    start,
    total_ms: total,
    ttft_ms: ttft,
    generation_ms: generation,
    throughput_tps: throughput,
  };
}

function figuresFromCall(call: LlmCallPoint | undefined): LedgerUsageFigures {
  if (call === undefined) {
    return {
      input: null,
      cache_read: null,
      cache_write: null,
      output: null,
      context: null,
    };
  }
  return {
    input: asNonNegative(call.input),
    cache_read: asNonNegative(call.cache_read),
    cache_write: asNonNegative(call.cache_write),
    output: asNonNegative(call.output),
    context: asNonNegative(call.context_tokens),
  };
}

function figuresFromSession(sessionUsage: UsageTotal | null | undefined): LedgerUsageFigures {
  const total = sessionUsage?.total;
  const input = asNonNegative(total?.input_tokens);
  const cacheRead = asNonNegative(total?.cache_read_tokens);
  const cacheWrite = asNonNegative(total?.cache_write_tokens);
  const context =
    input === null || cacheRead === null || cacheWrite === null
      ? null
      : input + cacheRead + cacheWrite;
  return {
    input,
    cache_read: cacheRead,
    cache_write: cacheWrite,
    output: asNonNegative(total?.output_tokens),
    context,
  };
}

/**
 * Find the model call behind a ledger row.
 *
 * A row is linked to a call by its `request_index` (and, when present, its
 * turn). Returns `undefined` when the row has no request or no matching call.
 */
export function findCallForRow(
  row: Pick<LedgerRow, "request_index" | "turn_id">,
  calls: readonly LlmCallPoint[],
): LlmCallPoint | undefined {
  if (row.request_index === null) return undefined;
  return calls.find(
    (candidate) =>
      candidate.request_index === row.request_index &&
      (row.turn_id === null ||
        candidate.turn_id === null ||
        candidate.turn_id === row.turn_id),
  );
}

/**
 * Per-request token figures next to the session totals.
 *
 * A row is linked to a call by its `request_index` (and, when present, its
 * turn). Without a known call every request field is `null`.
 */
export function usageFor(
  row: Pick<LedgerRow, "request_index" | "turn_id">,
  calls: readonly LlmCallPoint[],
  sessionUsage: UsageTotal | null | undefined,
): LedgerUsageComparison {
  const call = findCallForRow(row, calls);
  return {
    request: figuresFromCall(call),
    session: figuresFromSession(sessionUsage),
  };
}

/** Slice the last `size` rows, allowing the UI to request earlier rows. */
export function tailWindow(
  rows: readonly LedgerRow[],
  options: TailWindowOptions,
): TailWindowResult {
  const total = rows.length;
  const requestedEnd = asFiniteNumber(options.before);
  const end =
    requestedEnd === null
      ? total
      : Math.min(total, Math.max(0, Math.floor(requestedEnd)));
  const requestedSize = asFiniteNumber(options.size);
  const size = requestedSize === null ? 0 : Math.max(0, Math.floor(requestedSize));
  const start = Math.max(0, end - size);

  return {
    rows: rows.slice(start, end),
    hasEarlier: start > 0,
    start,
  };
}
