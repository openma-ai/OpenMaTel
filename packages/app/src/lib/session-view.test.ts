import { describe, expect, it } from "vitest";

import {
  SCHEMA_VERSION,
  sumUsage,
  type AgentEvent,
  type EventKind,
  type SegmentView,
  type TurnView,
} from "@openmatel/core";

import {
  EM_DASH,
  formatCompactTokens,
  formatCount,
  formatIdleDuration,
  formatIdleGapLabel,
  formatPercent,
  formatSignalLabel,
  formatTokenDelta,
  formatTokens,
  turnPromptPreview,
} from "./session-format";
import {
  filterTurnGroups,
  groupTurnsBySegment,
  idleGapByTurn,
  idleGapsByTurn,
  idleGapsWithinTurn,
  internalIdleGapsByTurn,
  needsSegmentChrome,
  parseSegmentBoundary,
  subagentSteps,
} from "./session-view";

const event = (
  event_id: string,
  kind: EventKind,
  ts: string,
  overrides: Partial<AgentEvent> = {},
): AgentEvent => ({
  schema: SCHEMA_VERSION,
  event_id,
  project_id: "proj_test",
  session_id: "ses_test",
  segment_id: "seg_0",
  kind,
  ts,
  attrs: {},
  source: { name: "test", format: "test" },
  ...overrides,
});

const turnView = (
  turn_id: string,
  segment_id: string,
  events: AgentEvent[],
  overrides: Partial<TurnView> = {},
): TurnView => ({
  turn_id,
  segment_id,
  ts: events[0]?.ts ?? null,
  end_ts: null,
  events,
  steps: [],
  summary: {
    step_count: 0,
    tool_call_count: 0,
    tool_error_count: 0,
    llm_calls: 0,
    usage: sumUsage([]),
    context_tokens_peak: null,
    wall_ms: null,
    active_ms: null,
    stop_reason: null,
    signals: [],
  },
  signals: [],
  prompt: null,
  tokens_in: null,
  output_tokens: null,
  step_count: 0,
  tool_call_count: 0,
  tool_error_count: 0,
  llm_calls: 0,
  usage: sumUsage([]),
  context_tokens_peak: null,
  wall_ms: null,
  active_ms: null,
  stop_reason: null,
  ...overrides,
});

const segmentView = (
  segment_id: string,
  overrides: Partial<SegmentView> = {},
): SegmentView => ({
  segment_id,
  turns: [],
  turn_count: 0,
  step_count: 0,
  tool_call_count: 0,
  tool_error_count: 0,
  llm_calls: 0,
  started_at: null,
  ended_at: null,
  status: "unknown",
  usage: sumUsage([]),
  context_tokens_peak: null,
  cache_hit_ratio: null,
  tokens_in: null,
  signal_counts: {},
  ...overrides,
});

describe("session formatting", () => {
  it("renders unknown as an em dash and a reported zero as zero", () => {
    expect(formatCount(null)).toBe(EM_DASH);
    expect(formatCount(undefined)).toBe(EM_DASH);
    expect(formatCount(0)).toBe("0");
    expect(formatTokens(null)).toBe(EM_DASH);
    expect(formatTokens(0)).toBe("0");
    expect(formatPercent(null)).toBe(EM_DASH);
    expect(formatPercent(0)).toBe("0%");
    expect(formatTokenDelta(null)).toBe(EM_DASH);
    expect(formatTokenDelta(0)).toBe("0");
  });

  it("summarises prompts to one line and never invents a prompt", () => {
    expect(turnPromptPreview(null)).toBe(EM_DASH);
    expect(turnPromptPreview("   ")).toBe(EM_DASH);
    expect(turnPromptPreview("hello\n  world")).toBe("hello world");
    expect(turnPromptPreview("abcdef", 4)).toBe("abc…");
    expect(turnPromptPreview("abcd", 4)).toBe("abcd");
  });

  it("formats token deltas, compact tokens and cache ratios", () => {
    expect(formatTokenDelta(1200)).toBe("+1200");
    expect(formatTokenDelta(-45)).toBe("-45");
    expect(formatCompactTokens(999)).toBe("999");
    expect(formatCompactTokens(1200)).toBe("1.2k");
    expect(formatCompactTokens(3_400_000)).toBe("3.4m");
    expect(formatPercent(0.456)).toBe("46%");
  });

  it("formats idle gaps compactly at every unit", () => {
    expect(formatIdleDuration(null)).toBe(EM_DASH);
    expect(formatIdleDuration(45_000)).toBe("45s");
    expect(formatIdleDuration(2 * 60 * 60 * 1000 + 13 * 60 * 1000)).toBe("2h 13m");
    expect(formatIdleDuration(25 * 60 * 60 * 1000)).toBe("1d 1h");
    expect(formatIdleGapLabel(2 * 60 * 60 * 1000 + 13 * 60 * 1000)).toBe(
      "idle 2h 13m",
    );
  });

  it("formats signals with their repetition count", () => {
    expect(
      formatSignalLabel({
        kind: "loop",
        turn_id: "turn_1",
        step_ids: [],
        count: 3,
      }),
    ).toBe("loop ×3");
    expect(
      formatSignalLabel({
        kind: "user_interrupt",
        turn_id: "turn_1",
        step_ids: [],
      }),
    ).toBe("user interrupt");
  });
});

describe("segment and turn grouping", () => {
  it("keeps segment order and attaches turns to their segment", () => {
    const a = turnView("turn_1", "seg_0", [event("a1", "message.user", "2026-10-20T10:00:00Z")]);
    const b = turnView("turn_2", "seg_1", [event("b1", "message.user", "2026-10-20T11:00:00Z", { segment_id: "seg_1" })]);
    const c = turnView("turn_3", "seg_0", [event("c1", "message.user", "2026-10-20T10:30:00Z")]);

    const groups = groupTurnsBySegment(
      [segmentView("seg_0"), segmentView("seg_1")],
      [a, b, c],
    );

    expect(groups.map((group) => group.segment_id)).toEqual(["seg_0", "seg_1"]);
    expect(groups[0]?.turns.map((row) => row.turn.turn_id)).toEqual([
      "turn_1",
      "turn_3",
    ]);
    expect(groups[1]?.turns.map((row) => row.turn.turn_id)).toEqual(["turn_2"]);
  });

  it("appends segment ids that only occur on turns", () => {
    const turn = turnView("turn_9", "seg_orphan", [
      event("o1", "message.user", "2026-10-20T10:00:00Z", {
        segment_id: "seg_orphan",
      }),
    ]);
    const groups = groupTurnsBySegment([segmentView("seg_0")], [turn]);
    expect(groups.map((group) => group.segment_id)).toEqual([
      "seg_0",
      "seg_orphan",
    ]);
    expect(groups[1]?.segment).toBeNull();
  });

  it("hides segment chrome for a single seg_0 but shows it for boundaries", () => {
    expect(
      needsSegmentChrome(groupTurnsBySegment([segmentView("seg_0")], [])),
    ).toBe(false);
    expect(
      needsSegmentChrome(
        groupTurnsBySegment(
          [segmentView("seg_0"), segmentView("seg_1")],
          [],
        ),
      ),
    ).toBe(true);
    expect(
      needsSegmentChrome(groupTurnsBySegment([segmentView("seg_1")], [])),
    ).toBe(true);
  });

  it("only marks idle gaps between two different turns", () => {
    const first = turnView("turn_1", "seg_0", [
      event("e1", "message.user", "2026-10-20T10:00:00Z", {
        turn_id: "turn_1",
        end_ts: "2026-10-20T10:00:02Z",
      }),
    ]);
    const second = turnView("turn_2", "seg_0", [
      event("e2", "message.user", "2026-10-20T11:00:00Z", {
        turn_id: "turn_2",
      }),
    ]);
    const gaps = idleGapByTurn([first, second]);
    expect(gaps.get("turn_2")?.duration_ms).toBe(59 * 60 * 1000 + 58 * 1000);
    expect(gaps.has("turn_1")).toBe(false);

    const inside = turnView("turn_1", "seg_0", [
      event("e3", "turn.start", "2026-10-20T10:00:00Z", { turn_id: "turn_1" }),
      event("e4", "llm.call", "2026-10-20T11:00:00Z", { turn_id: "turn_1" }),
    ]);
    expect(idleGapByTurn([inside])).toEqual(new Map());
  });

  it("ignores gaps at or below the default 30-minute threshold", () => {
    const first = turnView("turn_1", "seg_0", [
      event("f1", "message.user", "2026-10-20T10:00:00Z", {
        turn_id: "turn_1",
        end_ts: "2026-10-20T10:00:00Z",
      }),
    ]);
    const second = turnView("turn_2", "seg_0", [
      event("f2", "message.user", "2026-10-20T10:30:00Z", {
        turn_id: "turn_2",
      }),
    ]);
    expect(idleGapByTurn([first, second]).size).toBe(0);
  });

  it("keeps the between-turn gap even when the previous turn ends with turn.end", () => {
    const first = turnView("turn_1", "seg_0", [
      event("g1", "turn.start", "2026-10-20T10:00:00Z", { turn_id: "turn_1" }),
      event("g2", "turn.end", "2026-10-20T10:00:01Z", { turn_id: "turn_1" }),
    ]);
    const second = turnView("turn_2", "seg_0", [
      event("g3", "turn.start", "2026-10-20T11:00:00Z", { turn_id: "turn_2" }),
    ]);
    const gaps = idleGapByTurn([first, second]);
    expect(gaps.get("turn_2")?.duration_ms).toBe(59 * 60 * 1000 + 59 * 1000);
    expect(gaps.has("turn_1")).toBe(false);
  });

  it("finds the idle gaps inside one turn, not the closure of its trace", () => {
    const turn = turnView("turn_1", "seg_0", [
      event("i1", "message.user", "2026-10-20T10:00:00Z", {
        turn_id: "turn_1",
        end_ts: "2026-10-20T10:00:01Z",
      }),
      event("i2", "tool.call", "2026-10-20T12:00:01Z", { turn_id: "turn_1" }),
      event("i3", "message.agent", "2026-10-20T12:00:02Z", { turn_id: "turn_1" }),
      // Four hours between the last real event and the synthetic turn end:
      // that is bookkeeping, not an idle gap of the turn.
      event("i4", "turn.end", "2026-10-20T16:00:02Z", { turn_id: "turn_1" }),
    ]);

    const gaps = idleGapsWithinTurn(turn);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      after_event_id: "i1",
      before_event_id: "i2",
      start: "2026-10-20T10:00:01.000Z",
      end: "2026-10-20T12:00:01.000Z",
      duration_ms: 2 * 60 * 60 * 1000,
    });
    expect(internalIdleGapsByTurn([turn]).get("turn_1")).toEqual(gaps);
    expect(idleGapsByTurn([turn]).get("turn_1")).toEqual(gaps);
    // The old helper still only reports gaps *between* turns.
    expect(idleGapByTurn([turn])).toEqual(new Map());
  });

  it("drops internal gaps adjacent to session.end bookkeeping too", () => {
    const turn = turnView("turn_1", "seg_0", [
      event("j1", "llm.call", "2026-10-20T10:00:00Z", { turn_id: "turn_1" }),
      event("j2", "session.end", "2026-10-20T12:00:00Z"),
    ]);
    expect(idleGapsWithinTurn(turn)).toEqual([]);
  });

  it("puts internal gaps on the turn row, without a preceding-turn divider", () => {
    const turn = turnView("turn_1", "seg_0", [
      event("k1", "turn.start", "2026-10-20T10:00:00Z", { turn_id: "turn_1" }),
      event("k2", "permission.request", "2026-10-20T12:00:00Z", {
        turn_id: "turn_1",
      }),
    ]);
    const groups = groupTurnsBySegment([segmentView("seg_0")], [turn]);
    const row = groups[0]?.turns[0];
    expect(row?.idle_gap).toBeNull();
    expect(row?.internal_idle_gaps).toHaveLength(1);
    expect(row?.idle_gaps).toEqual(row?.internal_idle_gaps);
  });

  it("puts a gap before a resume boundary on the empty segment", () => {
    const before = turnView("turn_1", "seg_0", [
      event("r1", "message.user", "2026-10-20T10:00:00Z", {
        turn_id: "turn_1",
      }),
    ]);
    const boundary = event(
      "r2",
      "segment.boundary",
      "2026-10-20T11:00:00Z",
      {
        segment_id: "seg_resume",
        attrs: { reason: "resume" },
      },
    );
    const groups = groupTurnsBySegment(
      [
        segmentView("seg_0"),
        segmentView("seg_resume", {
          boundary,
          turn_count: 0,
          started_at: boundary.ts,
          ended_at: boundary.ts,
        }),
      ],
      [before],
    );

    expect(groups.map((group) => group.segment_id)).toEqual([
      "seg_0",
      "seg_resume",
    ]);
    const resume = groups[1]!;
    expect(resume.turns).toEqual([]);
    expect(resume.idle_gap).toMatchObject({
      after_event_id: "r1",
      before_event_id: "r2",
      start: "2026-10-20T10:00:00.000Z",
      end: "2026-10-20T11:00:00.000Z",
      duration_ms: 60 * 60 * 1000,
    });
    expect(resume.leading_idle_gaps).toEqual([resume.idle_gap]);
    expect(groups[0]?.idle_gap).toBeNull();
    expect(groups[0]?.turns[0]?.idle_gap).toBeNull();
  });

  it("renders every idle gap exactly once and never bridges a boundary", () => {
    const first = turnView("turn_1", "seg_0", [
      event("n1", "message.user", "2026-10-20T10:00:00Z", {
        turn_id: "turn_1",
      }),
      event("n2", "message.user", "2026-10-20T10:10:00Z", {
        turn_id: "turn_1",
      }),
    ]);
    const boundaryOne = event(
      "n3",
      "segment.boundary",
      "2026-10-20T11:00:00Z",
      { segment_id: "seg_1", attrs: { reason: "resume" } },
    );
    const second = turnView("turn_2", "seg_1", [
      event("n4", "llm.call", "2026-10-20T11:05:00Z", {
        turn_id: "turn_2",
        segment_id: "seg_1",
      }),
      event("n5", "tool.call", "2026-10-20T12:05:00Z", {
        turn_id: "turn_2",
        segment_id: "seg_1",
      }),
    ]);
    const boundaryTwo = event(
      "n6",
      "segment.boundary",
      "2026-10-20T14:00:00Z",
      { segment_id: "seg_2", attrs: { reason: "compaction" } },
    );
    const third = turnView("turn_3", "seg_2", [
      event("n7", "message.user", "2026-10-20T15:00:00Z", {
        turn_id: "turn_3",
        segment_id: "seg_2",
      }),
    ]);

    const groups = groupTurnsBySegment(
      [
        segmentView("seg_0"),
        segmentView("seg_1", { boundary: boundaryOne }),
        segmentView("seg_2", { boundary: boundaryTwo }),
      ],
      [first, second, third],
    );

    const rendered = groups.flatMap((group) => [
      ...group.leading_idle_gaps,
      ...group.turns.flatMap((row) => [
        ...row.preceding_idle_gaps,
        ...row.internal_idle_gaps,
      ]),
    ]);
    const renderedIds = rendered.map(
      (gap) => `${gap.after_event_id}:${gap.before_event_id}`,
    );

    // n1 -> n2 is below the threshold. The gaps are: before seg_1, inside
    // turn_2, before seg_2, and between the seg_2 boundary and turn_3.
    expect(renderedIds).toEqual(["n2:n3", "n4:n5", "n5:n6", "n6:n7"]);
    expect(new Set(renderedIds).size).toBe(renderedIds.length);

    // The n2 -> n3 gap belongs to seg_1 and must not be bridged onto turn_2.
    expect(groups[1]?.leading_idle_gaps).toHaveLength(1);
    expect(groups[1]?.turns[0]?.idle_gap).toBeNull();
    expect(groups[1]?.turns[0]?.internal_idle_gaps).toHaveLength(1);

    // The gap after the seg_2 boundary is attached to its first turn, not to
    // the segment itself.
    expect(groups[2]?.leading_idle_gaps).toHaveLength(1);
    expect(groups[2]?.turns[0]?.idle_gap).toMatchObject({
      after_event_id: "n6",
      before_event_id: "n7",
    });
  });

  it("normalises segment boundary attrs without inventing numbers", () => {
    const boundary = event("b1", "segment.boundary", "2026-10-20T10:00:00Z", {
      segment_id: "seg_1",
      attrs: {
        reason: "compaction",
        context_tokens_before: 1200,
        context_tokens_after: null,
        tokens_removed: null,
        summary: "short summary",
        parent_segment_id: "seg_0",
        derived: true,
      },
    });
    expect(parseSegmentBoundary(boundary)).toEqual({
      segment_id: "seg_1",
      reason: "compaction",
      context_tokens_before: 1200,
      context_tokens_after: null,
      tokens_removed: null,
      summary: "short summary",
      parent_segment_id: "seg_0",
      derived: true,
    });
    expect(
      parseSegmentBoundary({ segment_id: "seg_2", attrs: { reason: "nope" } }),
    ).toMatchObject({ reason: "unknown", context_tokens_before: null });
  });

  it("extracts sub-agent steps and their optional child session", () => {
    const turn = turnView("turn_1", "seg_0", [
      event("s1", "subagent.spawn", "2026-10-20T10:00:00Z", {
        step_id: "st_1",
        attrs: {
          child_session_id: "ses_child",
          agent_name: "explore",
          task: "find the bug",
        },
      }),
      event("s2", "subagent.spawn", "2026-10-20T10:00:01Z", {
        step_id: "st_2",
        attrs: {},
      }),
    ]);
    expect(subagentSteps(turn)).toEqual([
      {
        event_id: "s1",
        step_id: "st_1",
        child_session_id: "ses_child",
        agent_name: "explore",
        task: "find the bug",
      },
      {
        event_id: "s2",
        step_id: "st_2",
        child_session_id: null,
        agent_name: null,
        task: null,
      },
    ]);
  });

  it("filters turn groups to the brushed turn ids", () => {
    const first = turnView("turn_1", "seg_0", [
      event("u1", "message.user", "2026-10-20T10:00:00Z"),
    ]);
    const second = turnView("turn_2", "seg_0", [
      event("u2", "message.user", "2026-10-20T10:01:00Z"),
    ]);
    const third = turnView("turn_3", "seg_1", [
      event("u3", "message.user", "2026-10-20T10:02:00Z", {
        segment_id: "seg_1",
      }),
    ]);
    const groups = groupTurnsBySegment(
      [segmentView("seg_0"), segmentView("seg_1")],
      [first, second, third],
    );

    const filtered = filterTurnGroups(groups, new Set(["turn_2"]));
    expect(filtered.map((group) => group.segment_id)).toEqual(["seg_0"]);
    expect(filtered[0]?.turns.map((row) => row.turn.turn_id)).toEqual([
      "turn_2",
    ]);
    expect(filterTurnGroups(groups, new Set())).toEqual([]);
  });
});
