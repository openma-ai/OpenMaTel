/**
 * Pure grouping helpers for the segment → turn view (docs/design.md §15).
 *
 * The Query API already returns one row per segment (`getSegments`) and one
 * row per turn (`getTurns`). This module joins those two lists without
 * assuming they were loaded together, and annotates a turn with the idle gap
 * that precedes it (the render-time annotation from core `idleGaps`, §15.3).
 *
 * No React, no IO: everything here is unit-testable.
 */

import {
  DEFAULT_IDLE_THRESHOLD_MS,
  idleGaps,
  type IdleGap,
} from "@openmatel/core/idle";
import type {
  AgentEvent,
  SegmentBoundaryReason,
  SegmentView,
  TurnView,
} from "@openmatel/core";

/** Id of the first segment; kept local so the browser bundle need not load ids. */
const FIRST_SEGMENT_ID = "seg_0";

/** One turn row, with the idle gap that happened immediately before it. */
export interface TurnRow {
  turn: TurnView;
  /** Gap between the previous turn and this one; `null` when there is none. */
  idle_gap: IdleGap | null;
}

/** One segment and the turn rows rendered below its boundary. */
export interface SegmentGroup {
  segment_id: string;
  /** Full segment row when the Query API returned one. */
  segment: SegmentView | null;
  turns: TurnRow[];
}

/** A `subagent.spawn` / `handoff` event flattened for the drill-down link. */
export interface SubagentStep {
  event_id: string;
  step_id: string | null;
  child_session_id: string | null;
  agent_name: string | null;
  task: string | null;
}

/** The values SegmentBoundaryNode renders, normalised to `null` for unknown. */
export interface SegmentBoundaryInfo {
  segment_id: string;
  reason: SegmentBoundaryReason;
  context_tokens_before: number | null;
  context_tokens_after: number | null;
  tokens_removed: number | null;
  summary: string | null;
  parent_segment_id: string | null;
  derived: boolean;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

const asFiniteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const BOUNDARY_REASONS: ReadonlySet<string> = new Set([
  "compaction",
  "resume",
  "fork",
  "unknown",
]);

/** Normalise the attrs of a `segment.boundary` event for the UI. */
export function parseSegmentBoundary(
  boundary: Pick<AgentEvent, "segment_id" | "attrs">,
): SegmentBoundaryInfo {
  const attrs = isObject(boundary.attrs) ? boundary.attrs : {};
  const rawReason = asString(attrs.reason);
  const reason: SegmentBoundaryReason =
    rawReason !== null && BOUNDARY_REASONS.has(rawReason)
      ? (rawReason as SegmentBoundaryReason)
      : "unknown";

  return {
    segment_id: boundary.segment_id,
    reason,
    context_tokens_before: asFiniteNumber(attrs.context_tokens_before),
    context_tokens_after: asFiniteNumber(attrs.context_tokens_after),
    tokens_removed: asFiniteNumber(attrs.tokens_removed),
    summary: asString(attrs.summary),
    parent_segment_id: asString(attrs.parent_segment_id),
    derived: attrs.derived === true,
  };
}

/**
 * Attach each idle gap to the turn that starts immediately after it.
 *
 * Gaps *inside* one turn are already excluded from that turn's `active_ms`
 * (core `summarizeTurn`), so they do not get a divider between turn rows.
 * The threshold is core's default of 30 minutes.
 */
export function idleGapByTurn(
  turns: readonly TurnView[],
  thresholdMs: number = DEFAULT_IDLE_THRESHOLD_MS,
): Map<string, IdleGap> {
  const eventTurn = new Map<string, string>();
  const events: AgentEvent[] = [];

  for (const turn of turns) {
    for (const event of turn.events) {
      if (!isObject(event) || typeof event.event_id !== "string") continue;
      events.push(event);
      eventTurn.set(event.event_id, turn.turn_id);
    }
  }

  const byTurn = new Map<string, IdleGap>();
  for (const gap of idleGaps(events, thresholdMs)) {
    const previousTurn = eventTurn.get(gap.after_event_id);
    const nextTurn = eventTurn.get(gap.before_event_id);
    if (
      previousTurn === undefined ||
      nextTurn === undefined ||
      previousTurn === nextTurn
    ) {
      continue;
    }

    const existing = byTurn.get(nextTurn);
    if (existing === undefined || gap.duration_ms > existing.duration_ms) {
      byTurn.set(nextTurn, gap);
    }
  }

  return byTurn;
}

/**
 * Group turn rows by segment, preserving the segment order returned by the
 * Query API. Segment ids that only occur on turns (for example when the
 * optional segments endpoint was unavailable) are appended in first-seen
 * order, so no turn is ever dropped.
 */
export function groupTurnsBySegment(
  segments: readonly SegmentView[],
  turns: readonly TurnView[],
  thresholdMs: number = DEFAULT_IDLE_THRESHOLD_MS,
): SegmentGroup[] {
  const gaps = idleGapByTurn(turns, thresholdMs);
  const turnsBySegment = new Map<string, TurnView[]>();

  for (const turn of turns) {
    const list = turnsBySegment.get(turn.segment_id) ?? [];
    list.push(turn);
    turnsBySegment.set(turn.segment_id, list);
  }

  const groups: SegmentGroup[] = [];
  const emitted = new Set<string>();

  for (const segment of segments) {
    emitted.add(segment.segment_id);
    groups.push({
      segment_id: segment.segment_id,
      segment,
      turns: turnRows(turnsBySegment.get(segment.segment_id) ?? [], gaps),
    });
  }

  for (const [segmentId, segmentTurns] of turnsBySegment) {
    if (emitted.has(segmentId)) continue;
    emitted.add(segmentId);
    groups.push({
      segment_id: segmentId,
      segment: null,
      turns: turnRows(segmentTurns, gaps),
    });
  }

  return groups;
}

const turnRows = (
  turns: readonly TurnView[],
  gaps: ReadonlyMap<string, IdleGap>,
): TurnRow[] =>
  turns.map((turn) => ({
    turn,
    idle_gap: gaps.get(turn.turn_id) ?? null,
  }));

/**
 * Segment chrome is useful only when there is more than one context segment,
 * or when the only segment is a non-`seg_0` branch opened by a boundary.
 * A normal single-segment session therefore reads as one flat turn list.
 */
export function needsSegmentChrome(groups: readonly SegmentGroup[]): boolean {
  if (groups.length > 1) return true;
  const only = groups[0];
  if (only === undefined) return false;
  return (
    only.segment_id !== FIRST_SEGMENT_ID ||
    only.segment?.boundary !== undefined
  );
}

/** The sub-agent steps of one turn, in event order. */
export function subagentSteps(turn: Pick<TurnView, "events">): SubagentStep[] {
  const steps: SubagentStep[] = [];
  for (const event of turn.events) {
    if (event.kind !== "subagent.spawn" && event.kind !== "handoff") continue;
    const attrs = isObject(event.attrs) ? event.attrs : {};
    steps.push({
      event_id: event.event_id,
      step_id: asString(event.step_id),
      child_session_id: asString(attrs.child_session_id),
      agent_name: asString(attrs.agent_name),
      task: asString(attrs.task),
    });
  }
  return steps;
}
