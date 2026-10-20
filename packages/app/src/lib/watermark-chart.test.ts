import { describe, expect, it } from "vitest";

import type { LlmCallPoint } from "@openmatel/core";

import {
  buildWatermarkChart,
  contextValue,
  indexToX,
  niceCeiling,
  valueToY,
} from "./watermark-chart";

const call = (
  index: number,
  context_tokens: number | null,
  segment_id = "seg_0",
): LlmCallPoint => ({
  step_id: `st_${index}`,
  turn_id: `turn_${index}`,
  segment_id,
  ts: `2026-10-20T10:00:0${index}.000Z`,
  request_index: index,
  purpose: "chat",
  model: "test-model",
  context_tokens,
  context_delta: null,
  watermark: context_tokens,
  cache_hit_ratio: context_tokens === null ? null : 0.5,
  input: context_tokens,
  cache_read: null,
  cache_write: null,
  output: 10,
  reasoning: null,
  stop_reason: null,
  latency_ms: null,
  ttft_ms: null,
  decode_ms: null,
  output_tokens_per_s: null,
  retry: null,
  derived: [],
  usage: null,
});

describe("context watermark scaling", () => {
  it("rounds up to the 1 / 2 / 5 × 10ⁿ axis series", () => {
    expect(niceCeiling(null)).toBeNull();
    expect(niceCeiling(-1)).toBeNull();
    expect(niceCeiling(0)).toBe(0);
    expect(niceCeiling(100)).toBe(100);
    expect(niceCeiling(1200)).toBe(2000);
    expect(niceCeiling(4_500)).toBe(5000);
  });

  it("maps values to y and indices to x", () => {
    expect(valueToY(100, 100, 10, 100)).toBe(10);
    expect(valueToY(50, 100, 10, 100)).toBe(60);
    expect(valueToY(0, 100, 10, 100)).toBe(110);
    expect(valueToY(10, 0, 10, 100)).toBe(110);

    expect(indexToX(0, 1, 10, 100)).toBe(60);
    expect(indexToX(0, 3, 10, 100)).toBe(10);
    expect(indexToX(1, 3, 10, 100)).toBe(60);
    expect(indexToX(2, 3, 10, 100)).toBe(110);
  });

  it("prefers context_tokens and falls back to the watermark", () => {
    expect(contextValue(call(1, 120))).toBe(120);
    const fallback = { ...call(1, null), watermark: 42 };
    expect(contextValue(fallback)).toBe(42);
    expect(contextValue({ ...call(1, null), watermark: null })).toBeNull();
  });

  it("breaks lines at unknown values and marks segment boundaries", () => {
    const geometry = buildWatermarkChart(
      [call(1, 100), call(2, null), call(3, 50, "seg_1")],
      { width: 300, height: 120 },
    );

    expect(geometry.hasData).toBe(true);
    expect(geometry.maxValue).toBe(100);
    expect(geometry.samples).toHaveLength(3);
    expect(geometry.samples[1]?.y).toBeNull();
    expect(geometry.lines).toHaveLength(2);
    expect(geometry.lines[0]?.path).toMatch(/^M /);
    expect(geometry.lines[1]?.path).toMatch(/^M /);
    expect(geometry.boundaries).toEqual([
      { index: 2, x: geometry.samples[2]?.x, segment_id: "seg_1" },
    ]);
    expect(geometry.ticks[0]?.value).toBe(0);
    expect(geometry.ticks.at(-1)?.value).toBe(100);
  });

  it("keeps a safe denominator when no call reported a value", () => {
    const geometry = buildWatermarkChart([call(1, null), call(2, null)]);
    expect(geometry.hasData).toBe(false);
    expect(geometry.maxValue).toBe(1);
    expect(geometry.lines).toEqual([]);
    expect(geometry.samples.every((sample) => sample.y === null)).toBe(true);
  });

  it("marks a first call that is already in a later segment", () => {
    const geometry = buildWatermarkChart([call(1, 10, "seg_1")]);
    expect(geometry.boundaries).toEqual([
      { index: 0, x: geometry.samples[0]?.x, segment_id: "seg_1" },
    ]);
  });
});
