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
  type LlmCallPurpose,
  type LlmCallRetry,
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
  /** ISO end timestamp reported by the source, or `null` when unknown. */
  end_ts: string | null;
  /** 1-based position of the call in its session, in timestamp order. */
  request_index: number;
  /** Whether the call served the conversation or a context compaction. */
  purpose: LlmCallPurpose | null;
  /** Provider reported for this call, or `null` when the source did not say. */
  provider: string | null;
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
  /** Decode time after the first token, in milliseconds. */
  decode_ms: number | null;
  /** Output tokens divided by the decode time in seconds. */
  output_tokens_per_s: number | null;
  /** Retry information of the logical request, when known. */
  retry: LlmCallRetry | null;
  /** Names of the fields that were derived rather than reported. */
  derived: string[];
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

const asPositiveInteger = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;

const asDerived = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((field): field is string => typeof field === "string")
    : [];

const asPurpose = (value: unknown): LlmCallPurpose | null =>
  value === "chat" || value === "compaction" ? value : null;

const asRetry = (value: unknown): LlmCallRetry | null => {
  if (!isObject(value)) return null;
  const attempt = asPositiveInteger(value.attempt);
  if (attempt === null) return null;
  const maxAttempts = asPositiveInteger(value.max_attempts);
  const delayMs = asNumber(value.delay_ms);
  const errorCode = asString(value.error_code);
  return {
    attempt,
    max_attempts: maxAttempts,
    delay_ms: delayMs,
    error_code: errorCode,
  };
};

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

  ordered.forEach((event, order) => {
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

    const latency_ms = asNumber(attrs.latency_ms);
    const ttft_ms = asNumber(attrs.ttft_ms);
    const output = usage ? asNumber(usage.output_tokens) : null;
    const derived = asDerived(attrs.derived);

    // The source may already have filled these in (and marked them derived).
    // When latency and TTFT are both known we recompute from the primitives so
    // every source exposes the same numbers.
    const computedDecode =
      latency_ms !== null && ttft_ms !== null ? latency_ms - ttft_ms : null;
    const decode_ms = computedDecode ?? asNumber(attrs.decode_ms);
    if (computedDecode !== null && !derived.includes("decode_ms")) {
      derived.push("decode_ms");
    }

    let output_tokens_per_s = asNumber(attrs.output_tokens_per_s);
    if (decode_ms !== null && decode_ms > 0 && output !== null) {
      output_tokens_per_s = output / (decode_ms / 1000);
      if (!derived.includes("output_tokens_per_s")) {
        derived.push("output_tokens_per_s");
      }
    } else if (computedDecode !== null) {
      // A zero-length decode window has no meaningful rate.
      output_tokens_per_s = null;
    }

    points.push({
      step_id: asString(event.step_id),
      turn_id: asString(event.turn_id),
      segment_id,
      ts: event.ts,
      end_ts: asString(event.end_ts),
      request_index: asPositiveInteger(attrs.request_index) ?? order + 1,
      purpose: asPurpose(attrs.purpose),
      provider: asString(attrs.provider),
      model: asString(attrs.model),
      context_tokens,
      context_delta,
      watermark: context_tokens,
      cache_hit_ratio,
      input: usage ? asNumber(usage.input_tokens) : null,
      cache_read: cacheRead,
      cache_write: usage ? asNumber(usage.cache_write_tokens) : null,
      output,
      reasoning: usage ? asNumber(usage.reasoning_tokens) : null,
      stop_reason: asString(attrs.stop_reason),
      latency_ms,
      ttft_ms,
      decode_ms,
      output_tokens_per_s,
      retry: asRetry(attrs.retry),
      derived,
      usage,
    });

    previousBySegment.set(segment_id, context_tokens);
  });

  if (filter.segment_id === undefined && filter.turn_id === undefined) return points;
  return points.filter(
    (point) =>
      (filter.segment_id === undefined || point.segment_id === filter.segment_id) &&
      (filter.turn_id === undefined || point.turn_id === filter.turn_id),
  );
}
