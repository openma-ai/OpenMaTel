/**
 * Per-call LLM metrics (design §15.5–§15.7).
 *
 * A `llm.call` event carries a {@link Usage} record whose `input_tokens` is
 * **uncached** input. The size of the prompt the model actually saw is the
 * sum of the uncached input and both cache buckets. This module derives that
 * context size and the metrics an agent-native UI needs:
 *
 * - `context_tokens` — the full prompt size of one call;
 * - `context_delta` — how much context the call added compared with the
 *   previous call in the same segment (compaction resets it);
 * - `cache_hit_ratio` — `cache_read_tokens / context_tokens`.
 *
 * Everything is pure and deterministic; missing numbers stay `null`.
 */

import {
  FIRST_SEGMENT_ID,
  type AgentEvent,
  type Usage,
} from "./schema.js";

/**
 * The full prompt size of one model call:
 * `input_tokens + cache_read_tokens + cache_write_tokens`.
 *
 * @returns the sum, or `null` when any of the three inputs is unknown. A
 *          missing cache bucket must not silently count as zero.
 */
export function contextTokens(usage: Usage | null | undefined): number | null {
  if (usage === null || usage === undefined) return null;
  const input = usage.input_tokens;
  const cacheRead = usage.cache_read_tokens;
  const cacheWrite = usage.cache_write_tokens;
  if (
    typeof input !== "number" ||
    !Number.isFinite(input) ||
    typeof cacheRead !== "number" ||
    !Number.isFinite(cacheRead) ||
    typeof cacheWrite !== "number" ||
    !Number.isFinite(cacheWrite)
  ) {
    return null;
  }
  return input + cacheRead + cacheWrite;
}

/** One `llm.call` of a session, flattened for charts and tables. */
export interface LlmCallPoint {
  step_id: string | null;
  turn_id: string | null;
  segment_id: string;
  ts: string;
  model: string | null;
  context_tokens: number | null;
  /** Change against the previous call in the same segment, or `null`. */
  context_delta: number | null;
  /**
   * The context watermark after this call: the full prompt size the call saw.
   * It is the same value as {@link context_tokens}, exposed under the name the
   * context-watermark chart uses.
   */
  watermark: number | null;
  /** `cache_read_tokens / context_tokens`, or `null` when unknown. */
  cache_hit_ratio: number | null;
  input: number | null;
  cache_read: number | null;
  cache_write: number | null;
  output: number | null;
  reasoning: number | null;
  stop_reason: string | null;
  latency_ms: number | null;
  ttft_ms: number | null;
  /** The raw usage record of the call, or `null` when the source gave none. */
  usage: Usage | null;
}

/** Filter for {@link llmCallSeries}. */
export interface LlmCallFilter {
  segment_id?: string;
  turn_id?: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const segmentOf = (event: AgentEvent): string =>
  typeof event.segment_id === "string" && event.segment_id !== ""
    ? event.segment_id
    : FIRST_SEGMENT_ID;

/** Remove duplicated events, keeping the last write for an `event_id`. */
function dedupe(events: AgentEvent[]): AgentEvent[] {
  const byId = new Map<string, AgentEvent>();
  for (const event of events) {
    if (!isObject(event)) continue;
    const id = event.event_id;
    if (typeof id !== "string" || id === "") continue;
    byId.set(id, event);
  }
  return [...byId.values()];
}

/** Stable timestamp order, with the event id as tie breaker. */
function sortEvents(events: AgentEvent[]): AgentEvent[] {
  return [...events].sort((left, right) => {
    const delta = Date.parse(left.ts) - Date.parse(right.ts);
    if (delta !== 0 && !Number.isNaN(delta)) return delta;
    if (left.ts !== right.ts) return left.ts < right.ts ? -1 : 1;
    if (left.event_id === right.event_id) return 0;
    return left.event_id < right.event_id ? -1 : 1;
  });
}

/**
 * Flatten the `llm.call` events of a session into a series.
 *
 * The series is ordered by timestamp. `context_delta` is computed against the
 * previous call **in the same segment**, so the first call of a segment (and
 * the first call after a compaction boundary) has `null` instead of a
 * meaningless jump.
 *
 * When a filter is given, the full series is built first and then filtered.
 * That keeps `context_delta` relative to the real previous call in the
 * segment, not to the first row of the filtered result.
 */
export function llmCallSeries(events: AgentEvent[], filter: LlmCallFilter = {}): LlmCallPoint[] {
  const ordered = sortEvents(dedupe(events)).filter((event) => event.kind === "llm.call");
  const previousBySegment = new Map<string, number | null>();
  const points: LlmCallPoint[] = [];

  for (const event of ordered) {
    const attrs = isObject(event.attrs) ? event.attrs : {};
    const usage = event.usage ?? null;
    const segment_id = segmentOf(event);
    const context_tokens = contextTokens(usage);
    const cacheRead = usage ? asNumber(usage.cache_read_tokens) : null;

    const previous = previousBySegment.get(segment_id);
    const context_delta =
      previous === undefined || previous === null || context_tokens === null
        ? null
        : context_tokens - previous;

    const cache_hit_ratio =
      context_tokens === null || context_tokens === 0 || cacheRead === null
        ? null
        : cacheRead / context_tokens;

    points.push({
      step_id: asString(event.step_id),
      turn_id: asString(event.turn_id),
      segment_id,
      ts: event.ts,
      model: asString(attrs.model),
      context_tokens,
      context_delta,
      watermark: context_tokens,
      cache_hit_ratio,
      input: usage ? asNumber(usage.input_tokens) : null,
      cache_read: cacheRead,
      cache_write: usage ? asNumber(usage.cache_write_tokens) : null,
      output: usage ? asNumber(usage.output_tokens) : null,
      reasoning: usage ? asNumber(usage.reasoning_tokens) : null,
      stop_reason: asString(attrs.stop_reason),
      latency_ms: asNumber(attrs.latency_ms),
      ttft_ms: asNumber(attrs.ttft_ms),
      usage,
    });

    previousBySegment.set(segment_id, context_tokens);
  }

  if (filter.segment_id === undefined && filter.turn_id === undefined) return points;
  return points.filter(
    (point) =>
      (filter.segment_id === undefined || point.segment_id === filter.segment_id) &&
      (filter.turn_id === undefined || point.turn_id === filter.turn_id),
  );
}
