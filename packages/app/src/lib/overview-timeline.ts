/**
 * Geometry for the three-lane session overview (docs/design.md §16.2).
 *
 * The overview is deliberately built from plain numbers: the component only
 * turns the projected domain into CSS percentages, so the difficult parts —
 * sequence/actual/compressed projection, idle-gap collapsing, context
 * watermark points and brush → turn filtering — are unit-testable without a
 * DOM.
 *
 * Unknown values stay `null` all the way through. Nothing here turns a
 * missing duration or token count into zero.
 */

import {
  DEFAULT_IDLE_THRESHOLD_MS,
  idleGaps,
  type IdleGap,
} from "@openmatel/core/idle";
import type {
  AgentEvent,
  LlmCallPoint,
  SegmentBoundaryReason,
  SegmentView,
  TurnView,
} from "@openmatel/core";

import { formatCompactTokens, formatTokens } from "./session-format";

/** Horizontal projection of the overview. */
export type OverviewMode = "sequence" | "actual" | "compressed";

/** A selection in the active projection's coordinate space. */
export interface OverviewRange {
  start: number;
  end: number;
}

/** The three swim lanes. */
export type OverviewLane = "input" | "model" | "tools";

/** What one lane bar represents. */
export type OverviewSpanKind = "input" | "llm" | "tool";

/** One projected bar or start marker. */
export interface OverviewSpan {
  id: string;
  lane: OverviewLane;
  kind: OverviewSpanKind;
  turn_id: string | null;
  segment_id: string;
  /** Start in the active projection's domain. */
  start: number;
  /** End in the active projection's domain; equal to `start` for markers. */
  end: number;
  /** `true` when the end was never recorded; render a start marker only. */
  running: boolean;
  /** Recorded duration in milliseconds, or `null` when unknown/running. */
  duration_ms: number | null;
  is_error: boolean;
  /** Short human label: prompt preview, tool name or request heading. */
  label: string;
  /** Optional detail for the tooltip (error message, full tool name, …). */
  detail: string | null;
  tool_name: string | null;
  /** The model call behind an `llm` span, or `null` for another kind. */
  call: LlmCallPoint | null;
}

/** One point of the context watermark. */
export interface OverviewWatermarkPoint {
  x: number;
  /** `null` breaks the line; it is never plotted as zero. */
  value: number | null;
  segment_id: string;
  call: LlmCallPoint;
}

/** A run of consecutive watermark points with reported values. */
export interface OverviewWatermarkLine {
  points: OverviewWatermarkPoint[];
}

/** A `segment.boundary` projected onto the active domain. */
export interface OverviewBoundary {
  segment_id: string;
  reason: SegmentBoundaryReason;
  ts: string;
  x: number;
}

/** A collapsed idle gap in compressed mode. */
export interface OverviewBreak {
  /** Start of the fixed-width break slot in the projected domain. */
  start: number;
  /** End of the fixed-width break slot in the projected domain. */
  end: number;
  real_start: string;
  real_end: string;
  duration_ms: number;
}

/** The context-watermark strip below the Model lane. */
export interface OverviewWatermark {
  points: OverviewWatermarkPoint[];
  lines: OverviewWatermarkLine[];
  /** Largest reported context size, or `null` when nothing was reported. */
  peak: number | null;
  /** Axis ceiling derived from {@link peak}; `null` without data. */
  ceiling: number | null;
  has_data: boolean;
}

/** Everything the overview component needs. */
export interface OverviewModel {
  mode: OverviewMode;
  domain: OverviewRange & { duration: number };
  lanes: Record<OverviewLane, OverviewSpan[]>;
  spans: OverviewSpan[];
  watermark: OverviewWatermark;
  boundaries: OverviewBoundary[];
  breaks: OverviewBreak[];
  /** `false` when the session has no input, model or tool event to draw. */
  has_data: boolean;
}

/** Input of {@link buildOverviewModel}. */
export interface OverviewInput {
  turns: readonly Pick<TurnView, "turn_id" | "segment_id" | "events">[];
  calls: readonly LlmCallPoint[];
  segments: readonly Pick<SegmentView, "segment_id" | "boundary">[];
  mode: OverviewMode;
  idle_threshold_ms?: number;
}

/** Labels and the ordering used by the duration-mode control. */
export const OVERVIEW_MODES: readonly {
  value: OverviewMode;
  label: string;
  title: string;
}[] = [
  {
    value: "sequence",
    label: "sequence",
    title: "Equal width per span, in recorded order",
  },
  {
    value: "actual",
    label: "actual",
    title: "Widths follow recorded wall-clock durations",
  },
  {
    value: "compressed",
    label: "compressed",
    title: "Recorded durations with idle gaps folded into a fixed-width break",
  },
] as const;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const timeOf = (value: unknown): number | null => {
  if (typeof value !== "string" || value === "") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
};

const BOUNDARY_REASONS: ReadonlySet<string> = new Set([
  "compaction",
  "resume",
  "fork",
  "unknown",
]);

const boundaryReason = (event: AgentEvent): SegmentBoundaryReason => {
  const attrs = isObject(event.attrs) ? event.attrs : {};
  const reason = asString(attrs.reason);
  return reason !== null && BOUNDARY_REASONS.has(reason)
    ? (reason as SegmentBoundaryReason)
    : "unknown";
};

const promptPreview = (event: AgentEvent): string => {
  const text = event.content?.input?.text;
  if (typeof text !== "string") return "User message";
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat === "") return "User message";
  return flat.length <= 96 ? flat : `${flat.slice(0, 95)}…`;
};

const errorMessage = (event: AgentEvent): string | null =>
  event.error !== undefined && event.error.message !== ""
    ? event.error.message
    : null;

interface RawSpan {
  id: string;
  lane: OverviewLane;
  kind: OverviewSpanKind;
  turn_id: string | null;
  segment_id: string;
  absolute_start: number;
  absolute_end: number | null;
  running: boolean;
  is_error: boolean;
  label: string;
  detail: string | null;
  tool_name: string | null;
  call: LlmCallPoint | null;
  duration_ms: number | null;
}

interface TimedSpan {
  start: number;
  end: number;
}

const laneOrder = (lane: OverviewLane): number =>
  lane === "input" ? 0 : lane === "model" ? 1 : 2;

const compareRawSpans = (left: RawSpan, right: RawSpan): number => {
  if (left.absolute_start !== right.absolute_start) {
    return left.absolute_start - right.absolute_start;
  }
  const lane = laneOrder(left.lane) - laneOrder(right.lane);
  if (lane !== 0) return lane;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
};

/** Events that participate in idle-gap detection, deduped by id. */
function collectGapEvents(
  turns: OverviewInput["turns"],
  segments: OverviewInput["segments"],
): AgentEvent[] {
  const byId = new Map<string, AgentEvent>();
  for (const turn of turns) {
    for (const event of turn.events) {
      if (typeof event.event_id !== "string" || event.event_id === "") continue;
      byId.set(event.event_id, event);
    }
  }
  for (const segment of segments) {
    const boundary = segment.boundary;
    if (boundary === undefined) continue;
    if (typeof boundary.event_id !== "string" || boundary.event_id === "") continue;
    byId.set(boundary.event_id, boundary);
  }
  return [...byId.values()];
}

function modelSpan(
  call: LlmCallPoint,
  index: number,
): RawSpan | null {
  const start = timeOf(call.ts);
  if (start === null) return null;

  const reportedEnd = timeOf(call.end_ts);
  const latencyEnd =
    call.latency_ms !== null && call.latency_ms >= 0
      ? start + call.latency_ms
      : null;
  const end = reportedEnd ?? latencyEnd;
  const duration = end === null ? null : Math.max(0, end - start);

  return {
    id: `llm:${call.step_id ?? index}:${call.ts}`,
    lane: "model",
    kind: "llm",
    turn_id: call.turn_id,
    segment_id: call.segment_id,
    absolute_start: start,
    absolute_end: end,
    running: end === null,
    is_error: false,
    label: `Request #${call.request_index}`,
    detail: call.stop_reason,
    tool_name: null,
    call,
    duration_ms: duration,
  };
}

function inputSpan(turn: OverviewInput["turns"][number], event: AgentEvent): RawSpan | null {
  const start = timeOf(event.ts);
  if (start === null) return null;
  const end = timeOf(event.end_ts);
  return {
    id: `input:${event.event_id}`,
    lane: "input",
    kind: "input",
    turn_id: event.turn_id ?? turn.turn_id,
    segment_id: event.segment_id ?? turn.segment_id,
    absolute_start: start,
    absolute_end: end ?? start,
    running: false,
    is_error: false,
    label: promptPreview(event),
    detail: null,
    tool_name: null,
    call: null,
    duration_ms: end === null ? 0 : Math.max(0, end - start),
  };
}

function toolSpan(turn: OverviewInput["turns"][number], event: AgentEvent): RawSpan | null {
  const start = timeOf(event.ts);
  if (start === null) return null;
  const attrs = isObject(event.attrs) ? event.attrs : {};
  const toolName = asString(attrs.tool_name) ?? "tool";
  const duration = asNumber(attrs.duration_ms);
  const reportedEnd = timeOf(event.end_ts);
  const end =
    reportedEnd ??
    (duration !== null && duration >= 0 ? start + duration : null);
  const status = (event as { status?: unknown }).status;
  const statusName = typeof status === "string" ? status : null;
  const running = statusName === "running" || end === null;
  const isError = statusName === "error" || event.error !== undefined;

  return {
    id: `tool:${event.event_id}`,
    lane: "tools",
    kind: "tool",
    turn_id: event.turn_id ?? turn.turn_id,
    segment_id: event.segment_id ?? turn.segment_id,
    absolute_start: start,
    absolute_end: running ? null : end,
    running,
    is_error: isError,
    label: toolName,
    detail: errorMessage(event),
    tool_name: toolName,
    call: null,
    duration_ms: running || end === null ? null : Math.max(0, end - start),
  };
}

function rawSpans(input: OverviewInput): RawSpan[] {
  const spans: RawSpan[] = [];

  for (const turn of input.turns) {
    for (const event of turn.events) {
      if (event.kind === "message.user") {
        const span = inputSpan(turn, event);
        if (span !== null) spans.push(span);
      } else if (event.kind === "tool.call") {
        const span = toolSpan(turn, event);
        if (span !== null) spans.push(span);
      }
    }
  }

  input.calls.forEach((call, index) => {
    const span = modelSpan(call, index);
    if (span !== null) spans.push(span);
  });

  return spans.sort(compareRawSpans);
}

function sequenceProjection(spans: readonly RawSpan[]): Map<RawSpan, TimedSpan> {
  const projected = new Map<RawSpan, TimedSpan>();
  spans.forEach((span, index) => {
    projected.set(span, { start: index, end: index + 1 });
  });
  return projected;
}

/**
 * Fold every idle gap to a fixed-width break.
 *
 * The returned `project` maps an absolute timestamp into the compressed
 * domain. A span that crosses a gap is stretched across the break slot, so
 * the bar stays continuous while the idle time itself collapses.
 */
function compressedProjection(
  domainStart: number,
  domainEnd: number,
  gaps: readonly IdleGap[],
): {
  project: (time: number) => number;
  breaks: OverviewBreak[];
  duration: number;
} {
  const clipped = gaps
    .map((gap) => {
      const start = Math.max(domainStart, timeOf(gap.start) ?? domainStart);
      const end = Math.min(domainEnd, timeOf(gap.end) ?? domainEnd);
      return { gap, start, end, duration: end - start };
    })
    .filter((gap) => gap.duration > 0)
    .sort((left, right) => left.start - right.start);

  const activeDuration = Math.max(
    0,
    domainEnd - domainStart - clipped.reduce((total, gap) => total + gap.duration, 0),
  );
  // One percent of the active span per gap keeps every break visually small
  // and identical, even for sessions with hours of idle time.
  const breakWidth = Math.max(1, activeDuration / 100);

  const breaks: OverviewBreak[] = [];
  const map: Array<{ start: number; end: number; projectedStart: number }> = [];
  let realCursor = domainStart;
  let projectedCursor = 0;

  for (const clippedGap of clipped) {
    if (clippedGap.start > realCursor) {
      projectedCursor += clippedGap.start - realCursor;
    }
    const projectedStart = projectedCursor;
    projectedCursor += breakWidth;
    map.push({
      start: clippedGap.start,
      end: clippedGap.end,
      projectedStart,
    });
    breaks.push({
      start: projectedStart,
      end: projectedCursor,
      real_start: clippedGap.gap.start,
      real_end: clippedGap.gap.end,
      duration_ms: clippedGap.gap.duration_ms,
    });
    realCursor = clippedGap.end;
  }
  projectedCursor += Math.max(0, domainEnd - realCursor);

  const project = (time: number): number => {
    let cursor = domainStart;
    let projected = 0;
    for (const gap of map) {
      if (time <= gap.start) return projected + Math.max(0, time - cursor);
      projected += Math.max(0, gap.start - cursor);
      if (time <= gap.end) {
        const width = breakWidth;
        const ratio = (time - gap.start) / Math.max(1, gap.end - gap.start);
        return projected + width * ratio;
      }
      projected += breakWidth;
      cursor = gap.end;
    }
    return projected + Math.max(0, time - cursor);
  };

  return {
    project,
    breaks,
    duration: Math.max(1, projectedCursor),
  };
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

/** Round a value up to a readable 1 / 2 / 5 × 10ⁿ axis ceiling. */
export function niceCeiling(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) {
    return null;
  }
  if (value === 0) return 0;

  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  const fraction = value / base;
  const step = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return Number((step * base).toPrecision(12));
}

function watermarkPoints(
  calls: readonly LlmCallPoint[],
  modelByCall: ReadonlyMap<LlmCallPoint, RawSpan>,
  projected: ReadonlyMap<RawSpan, TimedSpan>,
  sequence: boolean,
): OverviewWatermarkPoint[] {
  const points: OverviewWatermarkPoint[] = [];
  for (const call of calls) {
    const span = modelByCall.get(call);
    const range = span === undefined ? undefined : projected.get(span);
    const x =
      range !== undefined
        ? sequence
          ? range.start + (range.end - range.start) / 2
          : range.start
        : 0;
    points.push({
      x,
      value: call.context_tokens,
      segment_id: call.segment_id,
      call,
    });
  }
  return points;
}

function watermarkLines(points: readonly OverviewWatermarkPoint[]): OverviewWatermarkLine[] {
  const lines: OverviewWatermarkLine[] = [];
  let run: OverviewWatermarkPoint[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    lines.push({ points: run });
    run = [];
  };

  for (const point of points) {
    if (point.value === null) {
      flush();
      continue;
    }
    run.push(point);
  }
  flush();
  return lines;
}

/**
 * Project the session into the three lanes.
 *
 * The input is ordered by first recorded timestamp (ties use the lane order),
 * so the sequence projection is stable even when the server returns turns or
 * calls in a slightly different order.
 */
export function buildOverviewModel(input: OverviewInput): OverviewModel {
  const spans = rawSpans(input);
  const sequence = input.mode === "sequence";

  const starts = spans.map((span) => span.absolute_start);
  const ends = spans.map((span) =>
    span.absolute_end === null ? span.absolute_start : span.absolute_end,
  );
  const rawStart = starts.length === 0 ? 0 : Math.min(...starts);
  const rawEnd = ends.length === 0 ? rawStart : Math.max(...ends);
  const rawDuration = Math.max(1, rawEnd - rawStart);

  const gaps =
    input.mode === "compressed"
      ? idleGaps(collectGapEvents(input.turns, input.segments), input.idle_threshold_ms)
      : [];
  const compressed = compressedProjection(rawStart, rawEnd, gaps);

  const projected = sequence
    ? sequenceProjection(spans)
    : new Map<RawSpan, TimedSpan>(
        spans.map((span) => [
          span,
          {
            start:
              input.mode === "compressed"
                ? compressed.project(span.absolute_start)
                : span.absolute_start - rawStart,
            end:
              input.mode === "compressed"
                ? compressed.project(
                    span.absolute_end === null
                      ? span.absolute_start
                      : span.absolute_end,
                  )
                : (span.absolute_end === null
                    ? span.absolute_start
                    : span.absolute_end) - rawStart,
          },
        ]),
      );

  const projectedSpans = spans.map((span): OverviewSpan => {
    const range = projected.get(span) ?? { start: 0, end: 0 };
    return {
      id: span.id,
      lane: span.lane,
      kind: span.kind,
      turn_id: span.turn_id,
      segment_id: span.segment_id,
      start: range.start,
      end: range.end,
      running: span.running,
      duration_ms: span.duration_ms,
      is_error: span.is_error,
      label: span.label,
      detail: span.detail,
      tool_name: span.tool_name,
      call: span.call,
    };
  });

  const lanes: Record<OverviewLane, OverviewSpan[]> = {
    input: projectedSpans.filter((span) => span.lane === "input"),
    model: projectedSpans.filter((span) => span.lane === "model"),
    tools: projectedSpans.filter((span) => span.lane === "tools"),
  };

  const modelByCall = new Map<LlmCallPoint, RawSpan>();
  for (const span of spans) {
    if (span.call !== null) modelByCall.set(span.call, span);
  }
  const points = watermarkPoints(input.calls, modelByCall, projected, sequence);
  const lines = watermarkLines(points);
  const values = points
    .map((point) => point.value)
    .filter((value): value is number => value !== null);
  const peak = values.length === 0 ? null : Math.max(...values);
  const ceiling = niceCeiling(peak);

  const domainDuration = sequence ? Math.max(1, spans.length) : compressed.duration;

  const boundaries: OverviewBoundary[] = [];
  for (const segment of input.segments) {
    const boundary = segment.boundary;
    if (boundary === undefined) continue;
    const boundaryTime = timeOf(boundary.ts);
    let x = 0;
    if (sequence) {
      const first = spans.find((span) => span.segment_id === segment.segment_id);
      x = first === undefined
        ? domainDuration
        : (projected.get(first)?.start ?? 0);
    } else if (boundaryTime !== null) {
      x = clamp(
        input.mode === "compressed"
          ? compressed.project(boundaryTime)
          : boundaryTime - rawStart,
        0,
        domainDuration,
      );
    }
    boundaries.push({
      segment_id: segment.segment_id,
      reason: boundaryReason(boundary),
      ts: boundary.ts,
      x,
    });
  }

  return {
    mode: input.mode,
    domain: { start: 0, end: domainDuration, duration: domainDuration },
    lanes,
    spans: projectedSpans,
    watermark: {
      points,
      lines,
      peak,
      ceiling,
      has_data: values.length > 0,
    },
    boundaries,
    breaks: input.mode === "compressed" ? compressed.breaks : [],
    has_data: projectedSpans.length > 0,
  };
}

/** Convert an absolute projected coordinate into a `0..1` track fraction. */
export function overviewFraction(model: OverviewModel, value: number): number {
  return clamp((value - model.domain.start) / Math.max(1, model.domain.duration), 0, 1);
}

/** The set of turn ids with at least one span overlapping `range`. */
export function turnIdsForRange(
  model: OverviewModel,
  range: OverviewRange,
): ReadonlySet<string> {
  const start = Math.min(range.start, range.end);
  const end = Math.max(range.start, range.end);
  const turnIds = new Set<string>();

  for (const span of model.spans) {
    if (span.turn_id === null) continue;
    if (span.start <= end && span.end >= start) turnIds.add(span.turn_id);
  }
  return turnIds;
}

/** Normalise a drag into an ordered, non-empty range in the model domain. */
export function normalizeOverviewRange(
  model: OverviewModel,
  left: number,
  right: number,
): OverviewRange {
  const start = clamp(Math.min(left, right), model.domain.start, model.domain.end);
  const end = clamp(Math.max(left, right), model.domain.start, model.domain.end);
  return { start, end };
}

/** Human-readable tooltip of one span. Unknown values say "unavailable". */
export interface OverviewTooltip {
  title: string;
  lines: string[];
}

const formatUnknownDuration = (value: number | null): string =>
  value === null || !Number.isFinite(value) || value < 0
    ? "unavailable"
    : formatOverviewDuration(value);

/** Integer-millisecond duration used by the overview tooltips. */
export function formatOverviewDuration(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "unavailable";
  if (value < 1_000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 2 : 1)}s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

const formatUnknownTokens = (value: number | null): string =>
  value === null || !Number.isFinite(value) ? "unavailable" : formatTokens(value);

const formatUnknownRate = (value: number | null): string => {
  if (value === null || !Number.isFinite(value)) return "tok/s unavailable";
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} tok/s`;
};

const formatDelay = (value: number | null): string => {
  if (value === null || !Number.isFinite(value) || value < 0) return "unavailable";
  const seconds = value / 1_000;
  const rounded = Number.isInteger(seconds) ? String(seconds) : String(Number(seconds.toFixed(2)));
  return `${rounded}s`;
};

/** `attempt n of m, delay Xs`, with "unavailable" for unreported parts. */
export function formatRetry(retry: LlmCallRetryLike): string {
  const cap =
    retry.max_attempts === null ? "" : ` of ${retry.max_attempts}`;
  return `attempt ${retry.attempt}${cap}, delay ${formatDelay(retry.delay_ms)}`;
}

/** Structural subset of {@link LlmCallPoint.retry}. */
export interface LlmCallRetryLike {
  attempt: number;
  max_attempts: number | null;
  delay_ms: number | null;
}

export function overviewSpanTooltip(span: OverviewSpan): OverviewTooltip {
  if (span.kind === "llm") {
    const call = span.call;
    if (call === null) return { title: span.label, lines: [] };
    const provider = call.provider ?? "unavailable";
    const model = call.model ?? "unavailable";
    const timing = [
      `TTFT ${formatUnknownDuration(call.ttft_ms)}`,
      `decode ${formatUnknownDuration(call.decode_ms)}`,
      formatUnknownRate(call.output_tokens_per_s),
    ].join(" · ");
    const lines = [
      `${provider} · ${model}`,
      timing,
      `tokens in ${formatUnknownTokens(call.context_tokens)} · out ${formatUnknownTokens(call.output)}`,
    ];
    if (call.retry !== null) lines.push(formatRetry(call.retry));
    return { title: `Request #${call.request_index}`, lines };
  }

  if (span.kind === "tool") {
    const status = span.is_error ? "error" : span.running ? "running" : "ok";
    const lines = [
      `duration ${formatUnknownDuration(span.running ? null : span.duration_ms)}`,
      `status ${status}`,
    ];
    if (span.detail !== null) lines.push(`error ${span.detail}`);
    return { title: span.tool_name ?? span.label, lines };
  }

  return { title: "User message", lines: [span.label] };
}

/** Compact axis label for the watermark strip. */export function watermarkAxisLabel(value: number | null): string {
  return value === null ? "unavailable" : formatCompactTokens(value);
}
