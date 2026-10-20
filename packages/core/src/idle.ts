/**
 * Idle-gap markers (design §15.3).
 *
 * An idle gap is **not** part of the schema and does not create a segment or
 * a turn. It is a render-time/query-time annotation: when two adjacent events
 * are more than the threshold apart, the timeline folds that stretch of time
 * into a marker and "active time" excludes it.
 *
 * The gap starts at the end of the previous event (`end_ts` when it has one,
 * its `ts` otherwise) and ends at the start of the next event.
 */

import type { AgentEvent } from "./schema.js";

/** Default threshold: 30 minutes. */
export const DEFAULT_IDLE_THRESHOLD_MS = 30 * 60 * 1000;

/** One folded stretch of time between two adjacent events. */
export interface IdleGap {
  /** Event before the gap. */
  after_event_id: string;
  /** Event after the gap. */
  before_event_id: string;
  /** ISO timestamp at which the idle period starts. */
  start: string;
  /** ISO timestamp at which the idle period ends. */
  end: string;
  /** Length of the gap in milliseconds. */
  duration_ms: number;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
 * Find the idle gaps of an event stream.
 *
 * @param events - events of a session (or of one turn), in any order.
 * @param thresholdMs - gaps strictly longer than this are returned.
 *                      Defaults to 30 minutes.
 */
export function idleGaps(
  events: AgentEvent[],
  thresholdMs: number = DEFAULT_IDLE_THRESHOLD_MS,
): IdleGap[] {
  const ordered = sortEvents(dedupe(events));
  const gaps: IdleGap[] = [];
  const threshold = Number.isFinite(thresholdMs) ? thresholdMs : DEFAULT_IDLE_THRESHOLD_MS;

  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (!previous || !current) continue;

    const previousEnd = Date.parse(previous.end_ts ?? previous.ts);
    const currentStart = Date.parse(current.ts);
    if (Number.isNaN(previousEnd) || Number.isNaN(currentStart)) continue;

    const duration = currentStart - previousEnd;
    if (!Number.isFinite(duration) || duration <= threshold) continue;

    gaps.push({
      after_event_id: previous.event_id,
      before_event_id: current.event_id,
      start: new Date(previousEnd).toISOString(),
      end: new Date(currentStart).toISOString(),
      duration_ms: duration,
    });
  }

  return gaps;
}
