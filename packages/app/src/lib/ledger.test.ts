import { describe, expect, it } from "vitest";

import {
  SCHEMA_VERSION,
  type AgentEvent,
  type EventKind,
  type LlmCallPoint,
  type SegmentView,
  type TurnView,
  type Usage,
  type UsageTotal,
} from "@openmatel/core";

import {
  buildLedger,
  filterLedger,
  firstRowIndexInTimeRange,
  requestTiming,
  SUMMARY_LIMIT,
  tailWindow,
  usageFor,
  type LedgerRow,
} from "./ledger";

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

const usage = (overrides: Partial<Usage> = {}): Usage => ({
  input_tokens: null,
  output_tokens: null,
  cache_read_tokens: null,
  cache_write_tokens: null,
  reasoning_tokens: null,
  source: "provider",
  ...overrides,
});

const emptyTurnSummary = () => ({
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
});

function sumUsage(usages: Array<Usage | null | undefined>): UsageTotal {
  const total: UsageTotal["total"] = {
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    reasoning_tokens: null,
    cost_usd: null,
  };
  let covered = 0;
  for (const item of usages) {
    if (item === null || item === undefined) continue;
    let reported = false;
    for (const field of [
      "input_tokens",
      "output_tokens",
      "cache_read_tokens",
      "cache_write_tokens",
      "reasoning_tokens",
    ] as const) {
      const value = item[field];
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      total[field] = (total[field] ?? 0) + value;
      reported = true;
    }
    if (reported) covered += 1;
  }
  return {
    total,
    calls: usages.length,
    covered,
    coverage: usages.length === 0 ? null : covered / usages.length,
  };
}

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
  summary: emptyTurnSummary(),
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

const call = (overrides: Partial<LlmCallPoint> = {}): LlmCallPoint => ({
  step_id: "st_llm_1",
  turn_id: "turn_1",
  segment_id: "seg_0",
  ts: "2026-10-20T10:01:00.000Z",
  end_ts: "2026-10-20T10:02:00.000Z",
  request_index: 1,
  purpose: "chat",
  provider: "test-provider",
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

const byKind = (rows: LedgerRow[], kind: LedgerRow["kind"]): LedgerRow[] =>
  rows.filter((row) => row.kind === kind);

/**
 * A compact session with two segments:
 *
 * - seg_0 has a user message, one model call, a tool + nested subtool, a
 *   context snapshot pair, an assistant tool-only message and an internal idle
 *   gap;
 * - seg_1 is opened by a compaction boundary (with a leading idle gap) and has
 *   one more turn / request / assistant answer.
 */
function fixture() {
  const boundary = event(
    "ev_boundary",
    "segment.boundary",
    "2026-10-20T13:00:00.000Z",
    {
      segment_id: "seg_1",
      attrs: {
        reason: "compaction",
        context_tokens_before: 120,
        context_tokens_after: 40,
        tokens_removed: 80,
        summary: "older turns compacted",
        parent_segment_id: "seg_0",
      },
    },
  );

  const turn1 = turnView("turn_1", "seg_0", [
    event("ev_user_1", "message.user", "2026-10-20T10:00:00.000Z", {
      turn_id: "turn_1",
      content: { capture: "full", input: { text: "please fix the login bug" } },
    }),
    event("ev_llm_1", "llm.call", "2026-10-20T10:01:00.000Z", {
      turn_id: "turn_1",
      step_id: "st_llm_1",
      end_ts: "2026-10-20T10:02:00.000Z",
      attrs: { request_index: 1 },
      usage: usage({ input_tokens: 10, output_tokens: 5 }),
    }),
    event("ev_tool_1", "tool.call", "2026-10-20T11:00:00.000Z", {
      turn_id: "turn_1",
      step_id: "st_tool_1",
      end_ts: "2026-10-20T11:00:30.000Z",
      attrs: { tool_name: "bash", duration_ms: 30_000 },
      content: {
        capture: "full",
        input: { json: { command: "ls -la" } },
        output: { text: "one\ntwo" },
      },
    }),
    event("ev_subtool", "tool.call", "2026-10-20T11:01:00.000Z", {
      turn_id: "turn_1",
      step_id: "st_subtool",
      parent_step_id: "st_tool_1",
      status: "error",
      error: { type: "tool_error", message: "nested failed" },
      attrs: { tool_name: "grep", child_session_id: "ss_child" },
    }),
    event("ev_prompt", "context.system_prompt", "2026-10-20T11:02:00.000Z", {
      turn_id: "turn_1",
      attrs: {
        hash: "0123456789abcdef0123456789abcdef",
        length_chars: 1200,
        change: "changed",
      },
    }),
    event("ev_tools", "context.tool_catalog", "2026-10-20T11:03:00.000Z", {
      turn_id: "turn_1",
      attrs: {
        hash: "fedcba9876543210fedcba9876543210",
        tool_count: 7,
        added: ["read"],
        removed: ["old_tool"],
        change: "changed",
      },
    }),
    event("ev_assistant_tools", "message.agent", "2026-10-20T11:04:00.000Z", {
      turn_id: "turn_1",
      attrs: { role: "assistant", tool_calls: [{ id: "call_1" }] },
    }),
    event("ev_turn_1_end", "turn.end", "2026-10-20T11:05:00.000Z", {
      turn_id: "turn_1",
      attrs: { stop_reason: "end_turn" },
    }),
  ], {
    prompt: "please fix the login bug",
    step_count: 4,
    active_ms: 120_000,
    tokens_in: 35,
    output_tokens: 5,
    status: "ok",
  });

  const turn2 = turnView("turn_2", "seg_1", [
    event("ev_user_2", "message.user", "2026-10-20T13:10:00.000Z", {
      turn_id: "turn_2",
      segment_id: "seg_1",
      content: { capture: "full", input: { text: "now add a regression test" } },
    }),
    event("ev_llm_2", "llm.call", "2026-10-20T13:11:00.000Z", {
      turn_id: "turn_2",
      segment_id: "seg_1",
      step_id: "st_llm_2",
      end_ts: "2026-10-20T13:12:00.000Z",
      attrs: { request_index: 2 },
    }),
    event("ev_assistant_2", "message.agent", "2026-10-20T13:12:00.000Z", {
      turn_id: "turn_2",
      segment_id: "seg_1",
      content: { capture: "full", output: { text: "Added the regression test." } },
    }),
  ], {
    prompt: "now add a regression test",
    step_count: 1,
    active_ms: 60_000,
    tokens_in: 20,
    output_tokens: 6,
    status: "ok",
  });

  return {
    segments: [
      segmentView("seg_0", { turn_count: 1 }),
      segmentView("seg_1", { boundary, turn_count: 1 }),
    ],
    turns: [turn1, turn2],
    calls: [
      call(),
      call({
        step_id: "st_llm_2",
        turn_id: "turn_2",
        segment_id: "seg_1",
        ts: "2026-10-20T13:11:00.000Z",
        end_ts: "2026-10-20T13:12:00.000Z",
        request_index: 2,
        model: "gpt-other",
      }),
    ],
  };
}

describe("buildLedger", () => {
  it("emits every Trajectory row kind in timeline order", () => {
    const rows = buildLedger(fixture());
    const kinds = new Set(rows.map((row) => row.kind));

    expect(kinds).toEqual(
      new Set([
        "turn_header",
        "user",
        "request",
        "idle_gap",
        "tool",
        "subtool",
        "system_prompt",
        "tools_updated",
        "assistant",
        "segment_boundary",
        "compaction",
      ]),
    );

    const order = rows.map((row) => row.kind);
    expect(order.indexOf("segment_boundary")).toBeLessThan(order.indexOf("compaction"));
    expect(order.indexOf("compaction")).toBeLessThan(order.indexOf("turn_header", 2));
  });

  it("keeps step numbers on rows instead of emitting a row per step", () => {
    const rows = buildLedger(fixture());

    expect(byKind(rows, "step")).toHaveLength(0);
    expect(byKind(rows, "request")[0]?.step).toBe(1);
    expect(byKind(rows, "tool")[0]?.step).toBe(2);
    expect(byKind(rows, "subtool")[0]?.step).toBe(3);
  });

  it("emits a standalone Step row only for a non-model step with no other rows", () => {
    const turn = turnView("turn_empty", "seg_0", [
      event("ev_permission", "permission.request", "2026-10-20T10:00:00.000Z", {
        turn_id: "turn_empty",
        step_id: "st_permission",
        attrs: { reason: "needs approval" },
      }),
    ], { step_count: 1 });

    const rows = buildLedger({
      segments: [segmentView("seg_0", { turn_count: 1 })],
      turns: [turn],
      calls: [],
    });

    expect(rows.map((row) => row.kind)).toEqual(["turn_header", "step"]);
    expect(rows[1]?.summary).toBe("Step 1 · permission");
    expect(rows[1]?.step).toBe(1);
    expect(rows[1]?.event_ids).toEqual(["ev_permission"]);
  });

  it("does not emit standalone Step rows for model calls or lifecycle events", () => {
    const turn = turnView("turn_model", "seg_0", [
      event("ev_llm_no_request", "llm.call", "2026-10-20T10:00:00.000Z", {
        turn_id: "turn_model",
        step_id: "st_model",
      }),
      event("ev_turn_start", "turn.start", "2026-10-20T10:01:00.000Z", {
        turn_id: "turn_model",
        step_id: "st_start",
      }),
    ], { step_count: 2 });

    const rows = buildLedger({
      segments: [segmentView("seg_0", { turn_count: 1 })],
      turns: [turn],
      calls: [],
    });

    expect(rows.map((row) => row.kind)).toEqual(["turn_header"]);
  });

  it("does not emit standalone Step rows for env, context or lifecycle steps", () => {
    const turn = turnView("turn_noise", "seg_0", [
      event("ev_env", "env.command", "2026-10-20T10:00:00.000Z", {
        turn_id: "turn_noise",
        step_id: "st_env",
        attrs: { command: "ls" },
      }),
      event("ev_file", "env.file_edit", "2026-10-20T10:00:01.000Z", {
        turn_id: "turn_noise",
        step_id: "st_file",
      }),
      event("ev_reason", "reasoning", "2026-10-20T10:00:02.000Z", {
        turn_id: "turn_noise",
        step_id: "st_reason",
      }),
      event("ev_prompt", "context.system_prompt", "2026-10-20T10:00:03.000Z", {
        turn_id: "turn_noise",
        step_id: "st_prompt",
        attrs: { change: "changed", length_chars: 10 },
      }),
      event("ev_tools", "context.tool_catalog", "2026-10-20T10:00:04.000Z", {
        turn_id: "turn_noise",
        step_id: "st_tools",
        attrs: { tool_count: 2 },
      }),
      event("ev_plan", "plan.update", "2026-10-20T10:00:05.000Z", {
        turn_id: "turn_noise",
        step_id: "st_plan",
      }),
      event("ev_memory", "memory.read", "2026-10-20T10:00:06.000Z", {
        turn_id: "turn_noise",
        step_id: "st_memory",
      }),
      event("ev_skill", "skill.use", "2026-10-20T10:00:07.000Z", {
        turn_id: "turn_noise",
        step_id: "st_skill",
      }),
      event("ev_control", "control.cancel", "2026-10-20T10:00:08.000Z", {
        turn_id: "turn_noise",
        step_id: "st_control",
      }),
      event("ev_outcome", "outcome", "2026-10-20T10:00:09.000Z", {
        turn_id: "turn_noise",
        step_id: "st_outcome",
      }),
    ], { step_count: 10 });

    const rows = buildLedger({
      segments: [segmentView("seg_0", { turn_count: 1 })],
      turns: [turn],
      calls: [],
    });

    expect(byKind(rows, "step")).toHaveLength(0);
    // The projected context rows are still real rows, just not step markers.
    expect(byKind(rows, "system_prompt")).toHaveLength(1);
    expect(byKind(rows, "tools_updated")).toHaveLength(1);
  });

  it("keeps standalone Step rows for permission and approval decisions", () => {
    const turn = turnView("turn_permission", "seg_0", [
      event("ev_permission", "permission.request", "2026-10-20T10:00:00.000Z", {
        turn_id: "turn_permission",
        step_id: "st_permission",
      }),
      event("ev_decision", "permission.decision", "2026-10-20T10:00:01.000Z", {
        turn_id: "turn_permission",
        step_id: "st_decision",
        attrs: { decision: "approve" },
      }),
    ], { step_count: 2 });

    const rows = buildLedger({
      segments: [segmentView("seg_0", { turn_count: 1 })],
      turns: [turn],
      calls: [],
    });

    expect(byKind(rows, "step").map((row) => row.summary)).toEqual([
      "Step 1 · permission",
      "Step 2 · permission",
    ]);
  });

  it("does not emit a Step row for a step already covered by a request separator", () => {
    const turn = turnView("turn_covered", "seg_0", [
      event("ev_llm_covered", "llm.call", "2026-10-20T10:00:00.000Z", {
        turn_id: "turn_covered",
        step_id: "st_llm_covered",
        attrs: { request_index: 1 },
      }),
      event("ev_reasoning_covered", "reasoning", "2026-10-20T10:01:00.000Z", {
        turn_id: "turn_covered",
        step_id: "st_reasoning_covered",
        attrs: { request_index: 1 },
      }),
    ], { step_count: 2 });

    const rows = buildLedger({
      segments: [segmentView("seg_0", { turn_count: 1 })],
      turns: [turn],
      calls: [],
    });

    expect(byKind(rows, "request")).toHaveLength(1);
    expect(byKind(rows, "step")).toHaveLength(0);
  });

  it("builds stable unique ids and one-line summaries", () => {
    const rows = buildLedger(fixture());
    const again = buildLedger(fixture());

    expect(rows.map((row) => row.id)).toEqual(again.map((row) => row.id));
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
    for (const row of rows) {
      expect(row.summary.length).toBeLessThanOrEqual(SUMMARY_LIMIT);
      expect(row.summary).not.toMatch(/\s{2,}/);
      expect(row.summary).not.toContain("\n");
      expect(typeof row.error).toBe("boolean");
      expect(typeof row.status).toBe("string");
    }
  });

  it("summarises turn headers with prompt, steps, active time and tokens", () => {
    const rows = buildLedger(fixture());
    const headers = byKind(rows, "turn_header");

    expect(headers).toHaveLength(2);
    expect(headers[0]?.summary).toContain("Turn 1");
    expect(headers[0]?.summary).toContain("please fix the login bug");
    expect(headers[0]?.summary).toContain("4 steps");
    expect(headers[0]?.summary).toContain("active 2m");
    expect(headers[0]?.summary).toContain("in 35");
    expect(headers[0]?.summary).toContain("out 5");
    expect(headers[0]?.turn_id).toBe("turn_1");
    expect(headers[0]?.start).toBe("2026-10-20T10:00:00.000Z");
    expect(headers[0]?.event_ids).toContain("ev_llm_1");
  });

  it("emits the segment boundary and the compaction summary", () => {
    const rows = buildLedger(fixture());
    const boundary = byKind(rows, "segment_boundary")[0];
    const compaction = byKind(rows, "compaction")[0];

    expect(boundary?.segment_id).toBe("seg_1");
    expect(boundary?.summary).toContain("compaction");
    expect(boundary?.summary).toContain("120 → 40 tokens");
    expect(boundary?.event_ids).toEqual(["ev_boundary"]);
    expect(compaction?.summary).toBe("older turns compacted");
    expect(compaction?.event_ids).toEqual(["ev_boundary"]);
  });

  it("places idle gaps between turns and inside a turn", () => {
    const rows = buildLedger(fixture());
    const gaps = byKind(rows, "idle_gap");

    expect(gaps).toHaveLength(2);
    const inside = gaps.find((row) => row.turn_id === "turn_1");
    const beforeSegment = gaps.find((row) => row.turn_id === null);
    expect(inside?.summary).toBe("idle 58m");
    expect(inside?.event_ids).toEqual(["ev_llm_1", "ev_tool_1"]);
    expect(beforeSegment?.summary).toBe("idle 1h 55m");
    expect(beforeSegment?.event_ids).toEqual(["ev_turn_1_end", "ev_boundary"]);
  });

  it("places request separators before the rows of that call", () => {
    const rows = buildLedger(fixture());
    const requests = byKind(rows, "request");

    expect(requests).toHaveLength(2);
    expect(requests[0]?.summary).toContain("Request #1");
    expect(requests[0]?.summary).toContain("gpt-test");
    expect(requests[1]?.summary).toContain("Request #2");
    expect(requests[1]?.summary).toContain("gpt-other");

    const request1Index = rows.findIndex((row) => row.kind === "request");
    const toolIndex = rows.findIndex((row) => row.kind === "tool");
    const assistantIndex = rows.findIndex((row) => row.kind === "assistant");
    const lastAssistantIndex = rows.findLastIndex((row) => row.kind === "assistant");
    const request2Index = rows.findIndex(
      (row) => row.kind === "request" && row.request_index === 2,
    );
    expect(request1Index).toBeLessThan(toolIndex);
    expect(request1Index).toBeLessThan(assistantIndex);
    expect(request2Index).toBeLessThan(lastAssistantIndex);

    // Rows after a request inherit its request index for usage lookup.
    expect(byKind(rows, "tool")[0]?.request_index).toBe(1);
    expect(byKind(rows, "assistant")[1]?.request_index).toBe(2);
  });

  it("renders tool, subtool and assistant-only-tool-call summaries", () => {
    const rows = buildLedger(fixture());
    const tool = byKind(rows, "tool")[0];
    const subtool = byKind(rows, "subtool")[0];
    const assistant = byKind(rows, "assistant")[0];

    expect(tool?.summary).toBe('bash {"command":"ls -la"} → one');
    expect(tool?.error).toBe(false);
    expect(subtool?.summary).toContain("grep");
    expect(subtool?.summary).toContain("child ss_child");
    expect(subtool?.summary).toContain("nested failed");
    expect(subtool?.error).toBe(true);
    expect(subtool?.status).toBe("error");
    expect(assistant?.summary).toBe("(tool call only)");
  });

  it("renders the context change rows", () => {
    const rows = buildLedger(fixture());
    const prompt = byKind(rows, "system_prompt")[0];
    const tools = byKind(rows, "tools_updated")[0];

    expect(prompt?.summary).toContain("System prompt updated");
    expect(prompt?.summary).toContain("1200 chars");
    expect(tools?.summary).toContain("Tools updated");
    expect(tools?.summary).toContain("7 tools");
    expect(tools?.summary).toContain("+read");
    expect(tools?.summary).toContain("-old_tool");
  });

  it("keeps a segment boundary when its segment has no turns", () => {
    const boundary = event(
      "ev_boundary_only",
      "segment.boundary",
      "2026-10-20T10:00:00.000Z",
      { segment_id: "seg_1", attrs: { reason: "fork" } },
    );
    const rows = buildLedger({
      segments: [
        segmentView("seg_0"),
        segmentView("seg_1", { boundary }),
      ],
      turns: [],
      calls: [],
    });

    expect(rows.map((row) => row.kind)).toEqual(["segment_boundary"]);
    expect(rows[0]?.summary).toContain("fork");
  });

  it("falls back to llm.call attrs and renders retry information", () => {
    const turn = turnView("turn_1", "seg_0", [
      event("ev_llm", "llm.call", "2026-10-20T10:00:00.000Z", {
        turn_id: "turn_1",
        step_id: "st_llm",
        end_ts: "2026-10-20T10:00:02.000Z",
        attrs: {
          request_index: 3,
          model: "gpt-retry",
          retry: {
            attempt: 2,
            max_attempts: 3,
            delay_ms: 1_000,
            error_code: "rate_limit",
          },
        },
      }),
    ]);
    const rows = buildLedger({
      segments: [segmentView("seg_0")],
      turns: [turn],
      calls: [],
    });
    const request = byKind(rows, "request")[0];

    expect(request?.request_index).toBe(3);
    expect(request?.summary).toContain("Request #3");
    expect(request?.summary).toContain("gpt-retry");
    expect(request?.summary).toContain("retry 2/3");
    expect(request?.summary).toContain("rate_limit");
  });
});

describe("requestTiming", () => {
  it("returns nulls for a missing call", () => {
    expect(requestTiming(undefined)).toEqual({
      start: null,
      total_ms: null,
      ttft_ms: null,
      generation_ms: null,
      throughput_tps: null,
    });
  });

  it("derives total and generation from recorded end timestamps", () => {
    const timing = requestTiming(
      call({
        latency_ms: null,
        ttft_ms: 2_000,
        decode_ms: null,
        output: 80,
      }),
    );

    expect(timing.start).toBe("2026-10-20T10:01:00.000Z");
    expect(timing.total_ms).toBe(60_000);
    expect(timing.ttft_ms).toBe(2_000);
    expect(timing.generation_ms).toBe(58_000);
    expect(timing.throughput_tps).toBeCloseTo(80 / 58);
  });

  it("prefers reported latency and decode windows", () => {
    const timing = requestTiming(
      call({
        ts: "2026-10-20T10:00:00.000Z",
        end_ts: "2026-10-20T10:01:00.000Z",
        latency_ms: 5_000,
        ttft_ms: 1_000,
        decode_ms: 1_000,
        output: 20,
      }),
    );

    expect(timing.total_ms).toBe(5_000);
    expect(timing.generation_ms).toBe(1_000);
    expect(timing.throughput_tps).toBe(20);
  });

  it("never invents a throughput for a zero-length generation window", () => {
    const timing = requestTiming(
      call({ latency_ms: 500, ttft_ms: 500, decode_ms: 0, output: 5 }),
    );

    expect(timing.total_ms).toBe(500);
    expect(timing.ttft_ms).toBe(500);
    expect(timing.generation_ms).toBe(0);
    expect(timing.throughput_tps).toBeNull();
  });

  it("keeps unknown values null", () => {
    const timing = requestTiming(
      call({
        ts: "2026-10-20T10:00:00.000Z",
        end_ts: null,
        latency_ms: null,
        ttft_ms: null,
        decode_ms: null,
        output: null,
      }),
    );

    expect(timing.start).toBe("2026-10-20T10:00:00.000Z");
    expect(timing.total_ms).toBeNull();
    expect(timing.ttft_ms).toBeNull();
    expect(timing.generation_ms).toBeNull();
    expect(timing.throughput_tps).toBeNull();
  });

  it("does not treat a missing output as zero", () => {
    const timing = requestTiming(
      call({ latency_ms: 1_000, ttft_ms: 100, decode_ms: 900, output: null }),
    );

    expect(timing.generation_ms).toBe(900);
    expect(timing.throughput_tps).toBeNull();
  });
});

describe("usageFor", () => {
  const sessionUsage: UsageTotal = sumUsage([
    usage({
      input_tokens: 10,
      cache_read_tokens: 20,
      cache_write_tokens: 5,
      output_tokens: 7,
    }),
  ]);

  const row = (requestIndex: number | null, turnId: string | null = "turn_1") =>
    ({ request_index: requestIndex, turn_id: turnId }) satisfies Pick<
      LedgerRow,
      "request_index" | "turn_id"
    >;

  it("compares per-request tokens with session totals", () => {
    const tokens = usageFor(
      row(1),
      [
        call({
          input: 10,
          cache_read: 20,
          cache_write: 5,
          output: 7,
          context_tokens: 35,
        }),
      ],
      sessionUsage,
    );

    expect(tokens.request).toEqual({
      input: 10,
      cache_read: 20,
      cache_write: 5,
      output: 7,
      context: 35,
    });
    expect(tokens.session).toEqual({
      input: 10,
      cache_read: 20,
      cache_write: 5,
      output: 7,
      context: 35,
    });
  });

  it("keeps every unknown field null instead of zero", () => {
    const tokens = usageFor(
      row(1),
      [call({ input: null, cache_read: null, cache_write: null, output: null, context_tokens: null })],
      {
        total: {
          input_tokens: null,
          output_tokens: null,
          cache_read_tokens: null,
          cache_write_tokens: null,
          reasoning_tokens: null,
          cost_usd: null,
        },
        calls: 1,
        covered: 0,
        coverage: 0,
      },
    );

    expect(tokens.request).toEqual({
      input: null,
      cache_read: null,
      cache_write: null,
      output: null,
      context: null,
    });
    expect(tokens.session).toEqual({
      input: null,
      cache_read: null,
      cache_write: null,
      output: null,
      context: null,
    });
  });

  it("does not match a request from another turn", () => {
    const tokens = usageFor(row(2), [call({ request_index: 2, turn_id: "turn_2" })], sessionUsage);

    expect(tokens.request.context).toBeNull();
  });

  it("returns all-null request figures without a known request index", () => {
    const tokens = usageFor(row(null), [call()], sessionUsage);

    expect(tokens.request.output).toBeNull();
    expect(tokens.session.output).toBe(7);
  });
});

describe("filterLedger", () => {
  const rows = () => buildLedger(fixture());

  it("matches the query case-insensitively over summary and kind", () => {
    const all = rows();
    const bySummary = filterLedger(all, { query: "BASH" });
    const byKindQuery = filterLedger(all, { query: "SUBTOOL" });
    const none = filterLedger(all, { query: "definitely-not-present" });

    expect(bySummary.matches.size).toBe(1);
    expect(byKindQuery.matches.size).toBe(1);
    expect([...byKindQuery.matches][0]).toBe(byKind(rows(), "subtool")[0]?.id);
    expect(none.matches.size).toBe(0);
    expect(filterLedger(all, { query: "   " }).matches.size).toBe(0);
    expect(filterLedger(all, { query: "request #2" }).matches.size).toBe(1);
  });

  it("keeps only the turn header for collapsed turns", () => {
    const all = rows();
    const filtered = filterLedger(all, { collapsedTurns: new Set(["turn_1"]) });

    const turn1 = filtered.rows.filter((row) => row.turn_id === "turn_1");
    expect(turn1.map((row) => row.kind)).toEqual(["turn_header"]);
    expect(filtered.rows.length).toBeLessThan(all.length);
    expect(filtered.rows.some((row) => row.turn_id === "turn_2")).toBe(true);
    expect(filtered.rows.some((row) => row.kind === "segment_boundary")).toBe(true);
  });

  it("hides call rows but keeps request separators with a count", () => {
    const filtered = filterLedger(rows(), { collapseCalls: true });
    const requests = byKind(filtered.rows, "request");

    expect(filtered.rows.some((row) => row.kind === "tool")).toBe(false);
    expect(filtered.rows.some((row) => row.kind === "subtool")).toBe(false);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.summary).toContain("2 tool calls");
    expect(requests[1]?.summary).not.toContain("tool call");
  });

  it("dims rows outside the brushed turns without removing them", () => {
    const all = rows();
    const filtered = filterLedger(all, { turnIds: new Set(["turn_1"]) });

    expect(filtered.rows).toHaveLength(all.length);
    expect(filtered.dimmed.has(byKind(all, "turn_header")[1]!.id)).toBe(true);
    expect(filtered.dimmed.has(byKind(all, "turn_header")[0]!.id)).toBe(false);
    // Turn-less chrome (segment boundary, gap before a segment) is kept lit.
    expect(filtered.dimmed.has(byKind(all, "segment_boundary")[0]!.id)).toBe(false);
  });

  it("dims rows outside a brushed time range and keeps overlapping headers", () => {
    const all = rows();
    const headers = byKind(all, "turn_header");
    const range = {
      start: Date.parse("2026-10-20T10:00:30.000Z"),
      end: Date.parse("2026-10-20T10:01:30.000Z"),
    };
    const filtered = filterLedger(all, { timeRange: range });

    // Turn 1's header spans 10:00–11:05, so it is context for the window.
    expect(filtered.dimmed.has(headers[0]!.id)).toBe(false);
    expect(filtered.dimmed.has(headers[1]!.id)).toBe(true);

    expect(filtered.dimmed.has(byKind(all, "user")[0]!.id)).toBe(true);
    expect(filtered.dimmed.has(byKind(all, "request")[0]!.id)).toBe(false);
    expect(filtered.dimmed.has(byKind(all, "tool")[0]!.id)).toBe(true);
    expect(filtered.rows).toHaveLength(all.length);
  });

  it("gives rows with no timestamp the nearest previous row's time", () => {
    const makeRow = (
      id: string,
      start: string | null,
      end: string | null = null,
    ): LedgerRow => ({
      id,
      kind: "assistant",
      turn_id: "turn_1",
      segment_id: "seg_0",
      step: null,
      request_index: null,
      start,
      end,
      event_ids: [],
      summary: id,
      error: false,
      status: "ok",
    });
    const timed = [
      makeRow("before", "2026-10-20T09:00:00.000Z"),
      makeRow("known", "2026-10-20T10:00:05.000Z"),
      makeRow("inherited", null),
      makeRow("later", "2026-10-20T11:00:00.000Z"),
    ];
    const filtered = filterLedger(timed, {
      timeRange: {
        start: Date.parse("2026-10-20T10:00:05.000Z"),
        end: Date.parse("2026-10-20T10:00:05.500Z"),
      },
    });

    expect(filtered.dimmed.has("before")).toBe(true);
    expect(filtered.dimmed.has("known")).toBe(false);
    expect(filtered.dimmed.has("inherited")).toBe(false);
    expect(filtered.dimmed.has("later")).toBe(true);
    expect(
      firstRowIndexInTimeRange(timed, {
        start: Date.parse("2026-10-20T10:00:05.000Z"),
        end: Date.parse("2026-10-20T10:00:05.500Z"),
      }),
    ).toBe(1);
  });

  it("hides time-dimmed rows when hideDimmed is enabled", () => {
    const all = rows();
    const range = {
      start: Date.parse("2026-10-20T10:00:30.000Z"),
      end: Date.parse("2026-10-20T10:01:30.000Z"),
    };
    const filtered = filterLedger(all, { timeRange: range, hideDimmed: true });

    expect(filtered.rows.every((row) => !filtered.dimmed.has(row.id))).toBe(true);
    expect(filtered.rows.length).toBeLessThan(all.length);
    expect(filtered.rows.some((row) => row.turn_id === "turn_2")).toBe(false);
  });

  it("removes dimmed rows when hideDimmed is enabled", () => {
    const all = rows();
    const filtered = filterLedger(all, {
      turnIds: new Set(["turn_1"]),
      hideDimmed: true,
    });

    expect(filtered.rows.every((row) => !filtered.dimmed.has(row.id))).toBe(true);
    expect(filtered.rows.length).toBeLessThan(all.length);
    expect(filtered.rows.some((row) => row.turn_id === "turn_2")).toBe(false);
  });
});

describe("tailWindow", () => {
  const rows = (): LedgerRow[] => buildLedger(fixture());

  it("returns the last N rows and reports earlier history", () => {
    const all = rows();
    const window = tailWindow(all, { size: 3 });

    expect(window.rows).toEqual(all.slice(-3));
    expect(window.start).toBe(all.length - 3);
    expect(window.hasEarlier).toBe(true);
  });

  it("loads earlier rows before an explicit index", () => {
    const all = rows();
    const window = tailWindow(all, { size: 2, before: 2 });

    expect(window.rows).toEqual(all.slice(0, 2));
    expect(window.start).toBe(0);
    expect(window.hasEarlier).toBe(false);
  });

  it("clamps a window larger than the input", () => {
    const all = rows();
    const window = tailWindow(all, { size: all.length + 100 });

    expect(window.rows).toEqual(all);
    expect(window.start).toBe(0);
    expect(window.hasEarlier).toBe(false);
  });

  it("returns an empty window at the beginning", () => {
    const all = rows();
    const window = tailWindow(all, { size: 5, before: 0 });

    expect(window.rows).toEqual([]);
    expect(window.start).toBe(0);
    expect(window.hasEarlier).toBe(false);
  });

  it("handles a zero-size window and an out-of-range before", () => {
    const all = rows();
    const zero = tailWindow(all, { size: 0 });
    const clamped = tailWindow(all, { size: 2, before: all.length + 50 });

    expect(zero.rows).toEqual([]);
    expect(zero.start).toBe(all.length);
    expect(zero.hasEarlier).toBe(true);
    expect(clamped.rows).toEqual(all.slice(-2));
  });
});
