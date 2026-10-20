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
  groupTurnsBySegment,
  idleGapByTurn,
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
});
