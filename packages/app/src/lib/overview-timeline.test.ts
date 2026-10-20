import { describe, expect, it } from "vitest";

import {
  SCHEMA_VERSION,
  type AgentEvent,
  type EventKind,
  type LlmCallPoint,
  type SegmentView,
  type TurnView,
} from "@openmatel/core";

import {
  buildOverviewModel,
  formatRetry,
  niceCeiling,
  normalizeOverviewRange,
  overviewFraction,
  overviewSpanTooltip,
  timeRangeForRange,
  turnIdsForRange,
  type OverviewInput,
} from "./overview-timeline";

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

type OverviewTurn = Pick<TurnView, "turn_id" | "segment_id" | "events">;

const turn = (
  turn_id: string,
  events: AgentEvent[],
  segment_id = "seg_0",
): OverviewTurn => ({ turn_id, segment_id, events });

const call = (
  ts: string,
  overrides: Partial<LlmCallPoint> = {},
): LlmCallPoint => ({
  step_id: "st_llm",
  turn_id: "turn_1",
  segment_id: "seg_0",
  ts,
  end_ts: null,
  request_index: 1,
  purpose: "chat",
  provider: "openai",
  model: "gpt-test",
  context_tokens: null,
  context_delta: null,
  watermark: null,
  cache_hit_ratio: null,
  input: null,
  cache_read: null,
  cache_write: null,
  output: null,
  reasoning: null,
  stop_reason: null,
  latency_ms: null,
  ttft_ms: null,
  decode_ms: null,
  output_tokens_per_s: null,
  retry: null,
  derived: [],
  usage: null,
  ...overrides,
});

const segment = (
  segment_id: string,
  boundary?: AgentEvent,
): Pick<SegmentView, "segment_id" | "boundary"> => ({
  segment_id,
  boundary,
});

const modelFor = (
  input: Omit<OverviewInput, "segments"> & {
    segments?: OverviewInput["segments"];
  },
) =>
  buildOverviewModel({
    segments: input.segments ?? [segment("seg_0")],
    ...input,
  });

describe("overview projection", () => {
  const input = (mode: OverviewInput["mode"]): OverviewInput => {
    const boundary = event("b1", "segment.boundary", "2026-10-20T10:00:06.000Z", {
      segment_id: "seg_1",
      attrs: { reason: "compaction" },
    });
    return {
      mode,
      turns: [
        turn("turn_1", [
          event("u1", "message.user", "2026-10-20T10:00:00.000Z", {
            content: { input: { text: "hello world" }, capture: "none" },
          }),
          event("t1", "tool.call", "2026-10-20T10:00:01.000Z", {
            end_ts: "2026-10-20T10:00:02.000Z",
            attrs: { tool_name: "read" },
          }),
          event("t2", "tool.call", "2026-10-20T10:00:03.000Z", {
            status: "error",
            attrs: { tool_name: "bash" },
            error: { type: "tool_error", message: "exit 1" },
          }),
        ]),
        turn(
          "turn_2",
          [
            event("u2", "message.user", "2026-10-20T10:00:07.000Z", {
              segment_id: "seg_1",
            }),
          ],
          "seg_1",
        ),
      ],
      calls: [
        call("2026-10-20T10:00:04.000Z", {
          context_tokens: 100,
          end_ts: "2026-10-20T10:00:05.000Z",
          latency_ms: 1_000,
          ttft_ms: 200,
          decode_ms: 800,
          output: 20,
        }),
        call("2026-10-20T10:00:08.000Z", {
          step_id: "st_llm_2",
          turn_id: "turn_2",
          segment_id: "seg_1",
          request_index: 2,
          context_tokens: 40,
          end_ts: "2026-10-20T10:00:09.000Z",
          latency_ms: 1_000,
        }),
      ],
      segments: [segment("seg_0"), segment("seg_1", boundary)],
    };
  };

  it("draws three lanes in equal-width sequence mode", () => {
    const model = buildOverviewModel(input("sequence"));

    expect(model.mode).toBe("sequence");
    expect(model.spans).toHaveLength(6);
    expect(model.lanes.input).toHaveLength(2);
    expect(model.lanes.model).toHaveLength(2);
    expect(model.lanes.tools).toHaveLength(2);
    for (const span of model.spans) {
      expect(span.end - span.start).toBe(1);
    }
    expect(model.domain).toEqual({ start: 0, end: 6, duration: 6 });
    expect(model.boundaries.map((boundary) => boundary.segment_id)).toEqual([
      "seg_1",
    ]);
    expect(model.boundaries[0]?.x).toBe(4);
  });

  it("uses recorded wall time in actual mode and keeps running spans open", () => {
    const model = modelFor({
      mode: "actual",
      turns: [
        turn("turn_1", [
          event("u1", "message.user", "2026-10-20T10:00:00.000Z"),
          event("t1", "tool.call", "2026-10-20T10:00:01.000Z", {
            end_ts: "2026-10-20T10:00:03.000Z",
            attrs: { tool_name: "read" },
          }),
          event("t2", "tool.call", "2026-10-20T10:00:04.000Z", {
            attrs: { tool_name: "bash" },
          }),
          event("t3", "tool.call", "2026-10-20T10:00:05.000Z", {
            attrs: { tool_name: "running", duration_ms: 500 },
          }),
        ]),
      ],
      calls: [call("2026-10-20T10:00:06.000Z", {
        end_ts: "2026-10-20T10:00:08.000Z",
        context_tokens: 80,
      })],
    });

    expect(model.lanes.input[0]?.start).toBe(0);
    expect(model.lanes.input[0]?.end).toBe(0);
    expect(model.lanes.tools[0]?.start).toBe(1_000);
    expect(model.lanes.tools[0]?.end).toBe(3_000);
    expect(model.lanes.tools[1]).toMatchObject({
      start: 4_000,
      end: 4_000,
      running: true,
      duration_ms: null,
    });
    expect(model.lanes.tools[2]).toMatchObject({
      start: 5_000,
      end: 5_500,
      running: false,
      duration_ms: 500,
    });
    expect(model.lanes.model[0]).toMatchObject({
      start: 6_000,
      end: 8_000,
      running: false,
    });
    expect(model.domain.duration).toBe(8_000);
  });

  it("maps a brushed range to an absolute time range", () => {
    const actual = modelFor(input("actual"));
    expect(
      timeRangeForRange(actual, { start: 1_000, end: 3_000 }),
    ).toEqual({
      start: Date.parse("2026-10-20T10:00:01.000Z"),
      end: Date.parse("2026-10-20T10:00:03.000Z"),
    });

    const sequence = buildOverviewModel(input("sequence"));
    expect(
      timeRangeForRange(sequence, { start: 0.5, end: 1.5 }),
    ).toEqual({
      start: Date.parse("2026-10-20T10:00:00.000Z"),
      end: Date.parse("2026-10-20T10:00:02.000Z"),
    });
    expect(timeRangeForRange(sequence, { start: 10, end: 20 })).toBeNull();
  });

  it("maps a brush inside a compressed idle break back to real time", () => {
    const turns = [
      turn("turn_1", [
        event("a1", "message.user", "2026-10-20T10:00:00.000Z"),
        event("a2", "tool.call", "2026-10-20T10:00:00.000Z", {
          end_ts: "2026-10-20T10:00:01.000Z",
          attrs: { tool_name: "read" },
        }),
      ]),
      turn("turn_2", [
        event("b1", "message.user", "2026-10-20T12:00:00.000Z"),
      ]),
    ];
    const compressed = modelFor({ mode: "compressed", turns, calls: [] });
    const gap = compressed.breaks[0]!;

    expect(
      timeRangeForRange(compressed, { start: gap.start, end: gap.end }),
    ).toEqual({
      start: Date.parse("2026-10-20T10:00:01.000Z"),
      end: Date.parse("2026-10-20T12:00:00.000Z"),
    });
  });

  it("collapses idle gaps to a fixed-width break in compressed mode", () => {
    const turns = [
      turn("turn_1", [
        event("a1", "message.user", "2026-10-20T10:00:00.000Z"),
        event("a2", "tool.call", "2026-10-20T10:00:00.000Z", {
          end_ts: "2026-10-20T10:00:01.000Z",
          attrs: { tool_name: "read" },
        }),
      ]),
      turn("turn_2", [
        event("b1", "message.user", "2026-10-20T12:00:00.000Z"),
        event("b2", "tool.call", "2026-10-20T12:00:00.000Z", {
          end_ts: "2026-10-20T12:00:01.000Z",
          attrs: { tool_name: "read" },
        }),
      ]),
    ];

    const actual = modelFor({ mode: "actual", turns, calls: [] });
    const compressed = modelFor({ mode: "compressed", turns, calls: [] });

    expect(actual.breaks).toEqual([]);
    expect(actual.domain.duration).toBe(2 * 60 * 60 * 1000 + 1_000);
    expect(compressed.breaks).toHaveLength(1);
    expect(compressed.breaks[0]?.duration_ms).toBe(2 * 60 * 60 * 1000 - 1_000);
    expect(
      (compressed.breaks[0]?.end ?? 0) - (compressed.breaks[0]?.start ?? 0),
    ).toBeGreaterThan(0);
    expect(compressed.domain.duration).toBeLessThan(actual.domain.duration);
    expect(compressed.lanes.input[1]?.start).toBeLessThan(
      actual.lanes.input[1]?.start ?? Infinity,
    );
  });

  it("keeps unknown context values as line breaks, never as zero", () => {
    const model = modelFor({
      mode: "sequence",
      turns: [],
      calls: [
        call("2026-10-20T10:00:00.000Z", { context_tokens: 100 }),
        call("2026-10-20T10:00:01.000Z", { context_tokens: null }),
        call("2026-10-20T10:00:02.000Z", { context_tokens: 40 }),
      ],
    });

    expect(model.watermark.points.map((point) => point.value)).toEqual([
      100,
      null,
      40,
    ]);
    expect(model.watermark.lines).toHaveLength(2);
    expect(model.watermark.peak).toBe(100);
    expect(model.watermark.ceiling).toBe(100);
    expect(model.watermark.has_data).toBe(true);
  });

  it("reports an empty watermark without inventing a ceiling", () => {
    const model = modelFor({
      mode: "sequence",
      turns: [],
      calls: [call("2026-10-20T10:00:00.000Z", { context_tokens: null })],
    });

    expect(model.watermark.has_data).toBe(false);
    expect(model.watermark.peak).toBeNull();
    expect(model.watermark.ceiling).toBeNull();
  });

  it("filters turns by overlapping spans and normalises the brush", () => {
    const model = modelFor(input("sequence"));

    expect([...turnIdsForRange(model, { start: 0.5, end: 1.5 })]).toEqual([
      "turn_1",
    ]);
    expect([...turnIdsForRange(model, { start: 4.2, end: 4.2 })]).toEqual([
      "turn_2",
    ]);
    expect([...turnIdsForRange(model, { start: 10, end: 20 })]).toEqual([]);
    expect(normalizeOverviewRange(model, 4, 1)).toEqual({ start: 1, end: 4 });
    expect(overviewFraction(model, 3)).toBe(0.5);
  });
});

describe("overview tooltips", () => {
  it("prints unavailable instead of zero for unknown model values", () => {
    const model = modelFor({
      mode: "sequence",
      turns: [],
      calls: [
        call("2026-10-20T10:00:00.000Z", {
          request_index: 3,
          provider: null,
          model: null,
          ttft_ms: null,
          decode_ms: null,
          output_tokens_per_s: null,
          context_tokens: null,
          output: null,
          retry: { attempt: 2, max_attempts: 3, delay_ms: 250, error_code: null },
        }),
      ],
    });

    const tooltip = overviewSpanTooltip(model.lanes.model[0]!);
    expect(tooltip.title).toBe("Request #3");
    expect(tooltip.lines[0]).toBe("unavailable · unavailable");
    expect(tooltip.lines[1]).toBe(
      "TTFT unavailable · decode unavailable · tok/s unavailable",
    );
    expect(tooltip.lines[2]).toBe(
      "tokens in unavailable · out unavailable",
    );
    expect(tooltip.lines[3]).toBe("attempt 2 of 3, delay 0.25s");
  });

  it("reports known timings and token counts without rounding zeros away", () => {
    const model = modelFor({
      mode: "sequence",
      turns: [],
      calls: [
        call("2026-10-20T10:00:00.000Z", {
          request_index: 1,
          provider: "anthropic",
          model: "claude",
          ttft_ms: 0,
          decode_ms: 2_000,
          output_tokens_per_s: 12.5,
          context_tokens: 0,
          output: 25,
          retry: null,
        }),
      ],
    });

    const tooltip = overviewSpanTooltip(model.lanes.model[0]!);
    expect(tooltip.lines[0]).toBe("anthropic · claude");
    expect(tooltip.lines[1]).toBe(
      "TTFT 0ms · decode 2.00s · 12.5 tok/s",
    );
    expect(tooltip.lines[2]).toBe("tokens in 0 · out 25");
    expect(tooltip.lines).toHaveLength(3);
  });

  it("formats retries with an unavailable delay", () => {
    expect(
      formatRetry({ attempt: 1, max_attempts: null, delay_ms: null }),
    ).toBe("attempt 1, delay unavailable");
  });

  it("uses recorded tool durations rather than projected bar widths", () => {
    const model = modelFor({
      mode: "sequence",
      turns: [
        turn("turn_1", [
          event("t1", "tool.call", "2026-10-20T10:00:00.000Z", {
            end_ts: "2026-10-20T10:00:02.000Z",
            attrs: { tool_name: "read" },
          }),
        ]),
      ],
      calls: [],
    });

    const tooltip = overviewSpanTooltip(model.lanes.tools[0]!);
    expect(tooltip.title).toBe("read");
    expect(tooltip.lines).toEqual(["duration 2.00s", "status ok"]);
  });
});

describe("overview helpers", () => {
  it("rounds context ceilings up the 1 / 2 / 5 series", () => {
    expect(niceCeiling(null)).toBeNull();
    expect(niceCeiling(0)).toBe(0);
    expect(niceCeiling(1_200)).toBe(2_000);
    expect(niceCeiling(4_500)).toBe(5_000);
  });
});
