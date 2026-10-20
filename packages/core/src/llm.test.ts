import { describe, expect, it } from "vitest";

import { contextTokens, llmCallSeries } from "./llm.js";
import { SCHEMA_VERSION, type AgentEvent, type Usage } from "./schema.js";

const usage = (overrides: Partial<Usage> = {}): Usage => ({
  input_tokens: 10,
  output_tokens: 5,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  reasoning_tokens: null,
  source: "provider",
  ...overrides,
});

const call = (
  event_id: string,
  ts: string,
  segment_id: string,
  options: {
    step_id?: string;
    turn_id?: string;
    usage?: Usage | null;
    attrs?: Record<string, unknown>;
  } = {},
): AgentEvent => ({
  schema: SCHEMA_VERSION,
  event_id,
  project_id: "proj_1",
  session_id: "ss_1",
  segment_id,
  turn_id: options.turn_id ?? "turn_1",
  step_id: options.step_id ?? `st_${event_id}`,
  ts,
  kind: "llm.call",
  attrs: options.attrs ?? {
    provider: "anthropic",
    model: "claude-opus",
    context_tokens: null,
    stop_reason: "end_turn",
    latency_ms: 1200,
    ttft_ms: 300,
  },
  usage: options.usage === undefined ? usage() : options.usage,
  source: { name: "test", format: "json" },
});

describe("contextTokens", () => {
  it("adds uncached input, cache reads and cache writes", () => {
    expect(contextTokens(usage({ input_tokens: 100, cache_read_tokens: 50, cache_write_tokens: 10 }))).toBe(160);
  });

  it("keeps zero values and returns null only for unknown inputs", () => {
    expect(contextTokens(usage({ input_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }))).toBe(0);
    expect(contextTokens(usage({ cache_read_tokens: null }))).toBeNull();
    expect(contextTokens(usage({ cache_write_tokens: null }))).toBeNull();
    expect(contextTokens(usage({ input_tokens: null }))).toBeNull();
    expect(contextTokens(null)).toBeNull();
  });
});

describe("llmCallSeries", () => {
  it("orders calls and computes per-segment context deltas and cache ratios", () => {
    const series = llmCallSeries([
      call("ev_2", "2026-01-01T00:00:02.000Z", "seg_0", {
        step_id: "st_2",
        usage: usage({ input_tokens: 5, cache_read_tokens: 5, cache_write_tokens: 0 }),
      }),
      call("ev_1", "2026-01-01T00:00:01.000Z", "seg_0", {
        step_id: "st_1",
        usage: usage({ input_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 0 }),
      }),
      call("ev_3", "2026-01-01T00:00:03.000Z", "seg_1", {
        step_id: "st_3",
        usage: usage({ input_tokens: 7, cache_read_tokens: 3, cache_write_tokens: 0 }),
      }),
      call("ev_4", "2026-01-01T00:00:04.000Z", "seg_1", {
        step_id: "st_4",
        usage: null,
      }),
    ]);

    expect(series.map((point) => point.step_id)).toEqual(["st_1", "st_2", "st_3", "st_4"]);

    expect(series[0]).toMatchObject({
      segment_id: "seg_0",
      context_tokens: 10,
      context_delta: null,
      cache_hit_ratio: 0,
      input: 10,
      cache_read: 0,
      cache_write: 0,
      output: 5,
      reasoning: null,
      model: "claude-opus",
      stop_reason: "end_turn",
      latency_ms: 1200,
      ttft_ms: 300,
    });
    expect(series[1]?.context_tokens).toBe(10);
    expect(series[1]?.context_delta).toBe(0);
    expect(series[1]?.cache_hit_ratio).toBeCloseTo(0.5, 10);

    expect(series[2]).toMatchObject({ segment_id: "seg_1", context_tokens: 10, context_delta: null });
    expect(series[2]?.cache_hit_ratio).toBeCloseTo(0.3, 10);

    expect(series[3]).toMatchObject({
      context_tokens: null,
      context_delta: null,
      cache_hit_ratio: null,
      input: null,
      cache_read: null,
      cache_write: null,
      output: null,
      reasoning: null,
    });
  });

  it("keeps unknown attrs null and ignores non-llm events", () => {
    const tool: AgentEvent = {
      ...call("ev_tool", "2026-01-01T00:00:00.000Z", "seg_0"),
      kind: "tool.call",
      attrs: { tool_name: "read" },
      usage: null,
    };
    const series = llmCallSeries([
      tool,
      call("ev_llm", "2026-01-01T00:00:01.000Z", "seg_0", {
        attrs: {
          provider: null,
          model: null,
          context_tokens: null,
          stop_reason: null,
          latency_ms: null,
          ttft_ms: null,
        },
        usage: null,
      }),
    ]);

    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({
      model: null,
      stop_reason: null,
      latency_ms: null,
      ttft_ms: null,
      context_tokens: null,
    });
  });
});
