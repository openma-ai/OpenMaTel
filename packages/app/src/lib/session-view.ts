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
  /**
   * Every gap before this turn and after the previous turn (or segment
   * boundary), in time order. Usually zero or one entry; the list keeps all
   * of them so no gap is dropped when non-turn events interleave.
   */
  preceding_idle_gaps: IdleGap[];
  /**
   * Gaps inside this turn, in time order. They are rendered above the turn's
   * timeline when the row is expanded.
   */
  internal_idle_gaps: IdleGap[];
  /** Alias of {@link internal_idle_gaps}, for callers that read it as a list. */
  idle_gaps: IdleGap[];
}

/** One segment and the turn rows rendered below its boundary. */
export interface SegmentGroup {
  segment_id: string;
  /** Full segment row when the Query API returned one. */
  segment: SegmentView | null;
  turns: TurnRow[];
  /**
   * The gap that immediately precedes this segment, rendered above its
   * boundary. This is the last entry of {@link leading_idle_gaps}, or `null`
   * when the segment starts without an idle gap.
   */
  idle_gap: IdleGap | null;
  /**
   * Gaps before the segment's first event (the `segment.boundary` node when
   * there is one), in time order.
   */
  leading_idle_gaps: IdleGap[];
  /** Alias of {@link leading_idle_gaps}. */
  idle_gaps: IdleGap[];
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

/** Event kinds that close a turn/session and are not activity of their own. */
const END_BOOKKEEPING_KINDS: ReadonlySet<string> = new Set([
  "turn.end",
  "session.end",
]);

/** Where an event lives in the segment → turn view. */
interface GapEventMeta {
  turn_id: string | null;
  segment_id: string;
  kind: string;
}

interface GapContext {
  events: AgentEvent[];
  meta: Map<string, GapEventMeta>;
}

/**
 * Collect every event that can participate in an idle gap.
 *
 * Turn events are not enough: a `segment.boundary` lives on the segment and
 * never inside a turn, so a gap ending at the boundary would otherwise be
 * dropped — or, worse, the turn-only gap calculation would bridge across the
 * boundary and fabricate a gap on the first turn of the next segment.
 */
const gapContext = (
  segments: readonly SegmentView[],
  turns: readonly TurnView[],
): GapContext => {
  const events: AgentEvent[] = [];
  const meta = new Map<string, GapEventMeta>();

  for (const turn of turns) {
    for (const event of turn.events) {
      if (!isObject(event) || typeof event.event_id !== "string") continue;
      events.push(event);
      meta.set(event.event_id, {
        turn_id: turn.turn_id,
        segment_id: turn.segment_id,
        kind: event.kind,
      });
    }
  }

  for (const segment of segments) {
    const boundary = segment.boundary;
    if (boundary === undefined || typeof boundary.event_id !== "string") continue;
    events.push(boundary);
    meta.set(boundary.event_id, {
      turn_id: null,
      segment_id: segment.segment_id,
      kind: boundary.kind,
    });
  }

  return { events, meta };
};

export interface ClassifiedIdleGaps {
  /** Gaps immediately before a segment's first event, by segment id. */
  beforeSegment: Map<string, IdleGap[]>;
  /** Gaps between two turns (or a boundary and the next turn), by turn id. */
  beforeTurn: Map<string, IdleGap[]>;
  /** Gaps wholly inside one turn. */
  withinTurn: Map<string, IdleGap[]>;
}

const appendGap = (
  byKey: Map<string, IdleGap[]>,
  key: string,
  gap: IdleGap,
): void => {
  const list = byKey.get(key);
  if (list === undefined) byKey.set(key, [gap]);
  else list.push(gap);
};

/**
 * Split the session's idle gaps into the three places the Turns view can
 * render them. Every gap from `idleGaps` is returned exactly once, except
 * gaps ending at `turn.end` / `session.end` bookkeeping, which are the
 * closure of the trace rather than a pause of the agent.
 *
 * A gap whose following event is a `segment.boundary` (or otherwise does not
 * belong to a turn) opens the segment instead of attaching to a turn, so it
 * can be drawn above `SegmentBoundaryNode` even when the segment has no turns.
 */
export function classifyIdleGaps(
  segments: readonly SegmentView[],
  turns: readonly TurnView[],
  thresholdMs: number = DEFAULT_IDLE_THRESHOLD_MS,
): ClassifiedIdleGaps {
  const { events, meta } = gapContext(segments, turns);
  const beforeSegment = new Map<string, IdleGap[]>();
  const beforeTurn = new Map<string, IdleGap[]>();
  const withinTurn = new Map<string, IdleGap[]>();

  for (const gap of idleGaps(events, thresholdMs)) {
    const after = meta.get(gap.after_event_id);
    const before = meta.get(gap.before_event_id);
    if (before === undefined) continue;

    // A gap that ends at turn/session closure is not agent idle time.
    if (END_BOOKKEEPING_KINDS.has(before.kind)) continue;

    if (before.turn_id === null) {
      // The next event is a segment node (normally the boundary) or another
      // session-level event: this gap belongs above the segment.
      appendGap(beforeSegment, before.segment_id, gap);
      continue;
    }

    if (after !== undefined && after.turn_id === before.turn_id) {
      appendGap(withinTurn, before.turn_id, gap);
      continue;
    }

    appendGap(beforeTurn, before.turn_id, gap);
  }

  return { beforeSegment, beforeTurn, withinTurn };
}

/**
 * The idle gaps inside one turn.
 *
 * Unlike {@link idleGapByTurn} these are the gaps that the turn itself spans
 * (for example while it waited for a background job). Gaps adjacent to the
 * synthetic `turn.end` / `session.end` bookkeeping are dropped: they are the
 * closure of the trace, not a pause of the agent. The threshold is core's
 * default of 30 minutes.
 */
export function idleGapsWithinTurn(
  turn: Pick<TurnView, "events">,
  thresholdMs: number = DEFAULT_IDLE_THRESHOLD_MS,
): IdleGap[] {
  const kindById = new Map<string, string>();
  const events: AgentEvent[] = [];

  for (const event of turn.events) {
    if (!isObject(event) || typeof event.event_id !== "string") continue;
    events.push(event);
    kindById.set(event.event_id, event.kind);
  }

  return idleGaps(events, thresholdMs).filter((gap) => {
    const afterKind = kindById.get(gap.after_event_id);
    const beforeKind = kindById.get(gap.before_event_id);
    return (
      !END_BOOKKEEPING_KINDS.has(afterKind ?? "") &&
      !END_BOOKKEEPING_KINDS.has(beforeKind ?? "")
    );
  });
}

/** Group the internal idle gaps of each turn by its id. */
export function internalIdleGapsByTurn(
  turns: readonly TurnView[],
  thresholdMs: number = DEFAULT_IDLE_THRESHOLD_MS,
): Map<string, IdleGap[]> {
  const byTurn = new Map<string, IdleGap[]>();
  for (const turn of turns) {
    const gaps = idleGapsWithinTurn(turn, thresholdMs);
    if (gaps.length > 0) byTurn.set(turn.turn_id, gaps);
  }
  return byTurn;
}

/** Alias of {@link internalIdleGapsByTurn} with a name that mirrors the map. */
export function idleGapsByTurn(
  turns: readonly TurnView[],
  thresholdMs: number = DEFAULT_IDLE_THRESHOLD_MS,
): Map<string, IdleGap[]> {
  return internalIdleGapsByTurn(turns, thresholdMs);
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
  const gaps = classifyIdleGaps(segments, turns, thresholdMs);
  const turnsBySegment = new Map<string, TurnView[]>();

  for (const turn of turns) {
    const list = turnsBySegment.get(turn.segment_id) ?? [];
    list.push(turn);
    turnsBySegment.set(turn.segment_id, list);
  }

  const groups: SegmentGroup[] = [];
  const emitted = new Set<string>();

  const group = (segmentId: string, segment: SegmentView | null): SegmentGroup => {
    const leading = gaps.beforeSegment.get(segmentId) ?? [];
    return {
      segment_id: segmentId,
      segment,
      turns: turnRows(
        turnsBySegment.get(segmentId) ?? [],
        gaps.beforeTurn,
        gaps.withinTurn,
      ),
      idle_gap: leading.length === 0 ? null : leading[leading.length - 1]!,
      leading_idle_gaps: leading,
      idle_gaps: leading,
    };
  };

  for (const segment of segments) {
    emitted.add(segment.segment_id);
    groups.push(group(segment.segment_id, segment));
  }

  for (const segmentId of turnsBySegment.keys()) {
    if (emitted.has(segmentId)) continue;
    emitted.add(segmentId);
    groups.push(group(segmentId, null));
  }

  return groups;
}

const turnRows = (
  turns: readonly TurnView[],
  gaps: ReadonlyMap<string, IdleGap[]>,
  internalGaps: ReadonlyMap<string, IdleGap[]>,
): TurnRow[] =>
  turns.map((turn) => {
    const preceding = gaps.get(turn.turn_id) ?? [];
    const inside = internalGaps.get(turn.turn_id) ?? [];
    const widest = preceding.reduce<IdleGap | null>(
      (current, gap) =>
        current === null || gap.duration_ms > current.duration_ms ? gap : current,
      null,
    );
    return {
      turn,
      idle_gap: widest,
      preceding_idle_gaps: preceding,
      internal_idle_gaps: inside,
      idle_gaps: inside,
    };
  });

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
