import { describe, expect, it } from "vitest";

import { SCHEMA_VERSION, type AgentEvent, type EventKind } from "./schema.js";
import { detectSignals, type Signal } from "./signals.js";

const event = (
  event_id: string,
  kind: EventKind,
  ts: string,
  options: {
    turn_id?: string;
    step_id?: string;
    status?: AgentEvent["status"];
    attrs?: Record<string, unknown>;
    content?: AgentEvent["content"];
  } = {},
): AgentEvent => ({
  schema: SCHEMA_VERSION,
  event_id,
  project_id: "proj_1",
  session_id: "ss_1",
  segment_id: "seg_0",
  turn_id: options.turn_id ?? "turn_1",
  step_id: options.step_id,
  ts,
  kind,
  status: options.status,
  attrs: options.attrs ?? {},
  content: options.content,
  source: { name: "test", format: "json" },
});

const tool = (
  event_id: string,
  step_id: string,
  ts: string,
  options: {
    turn_id?: string;
    status?: AgentEvent["status"];
    tool_name?: string;
    input?: string;
  } = {},
): AgentEvent =>
  event(event_id, "tool.call", ts, {
    turn_id: options.turn_id,
    step_id,
    status: options.status ?? "ok",
    attrs: {
      tool_name: options.tool_name ?? "bash",
      tool_kind: "execute",
      call_id: `call_${event_id}`,
    },
    content: { capture: "full", input: { text: options.input ?? "ls -la" } },
  });

const ofKind = (signals: Signal[], kind: Signal["kind"]): Signal[] =>
  signals.filter((signal) => signal.kind === kind);

describe("detectSignals", () => {
  it("detects three consecutive failing calls of the same tool and input", () => {
    const signals = detectSignals([
      tool("ev_1", "st_1", "2026-01-01T00:00:01.000Z", { status: "error", input: "  { \"b\": 2, \"a\": 1 } " }),
      tool("ev_2", "st_2", "2026-01-01T00:00:02.000Z", { status: "error", input: "{\"a\":1,\"b\":2}" }),
      tool("ev_3", "st_3", "2026-01-01T00:00:03.000Z", { status: "error", input: "{\"a\": 1, \"b\": 2}" }),
    ]);

    expect(ofKind(signals, "repeated_tool_failure")).toEqual([
      {
        kind: "repeated_tool_failure",
        turn_id: "turn_1",
        step_ids: ["st_1", "st_2", "st_3"],
        count: 3,
      },
    ]);
  });

  it("does not report repeated_tool_failure for only two failures or a different tool", () => {
    const signals = detectSignals([
      tool("ev_1", "st_1", "2026-01-01T00:00:01.000Z", { status: "error" }),
      tool("ev_2", "st_2", "2026-01-01T00:00:02.000Z", { status: "error", tool_name: "read" }),
      tool("ev_3", "st_3", "2026-01-01T00:00:03.000Z", { status: "error" }),
    ]);

    expect(ofKind(signals, "repeated_tool_failure")).toEqual([]);
  });

  it("detects a tool/input loop regardless of the call status", () => {
    const signals = detectSignals([
      tool("ev_1", "st_1", "2026-01-01T00:00:01.000Z", { status: "ok" }),
      tool("ev_2", "st_2", "2026-01-01T00:00:02.000Z", { status: "error" }),
      tool("ev_3", "st_3", "2026-01-01T00:00:03.000Z", { status: "ok" }),
    ]);

    expect(ofKind(signals, "loop")).toMatchObject([
      {
        kind: "loop",
        turn_id: "turn_1",
        step_ids: ["st_1", "st_2", "st_3"],
        count: 3,
      },
    ]);
  });

  it("detects a short step sequence repeated consecutively", () => {
    const steps = [
      event("ev_a1", "llm.call", "2026-01-01T00:00:01.000Z", { step_id: "st_a1" }),
      tool("ev_b1", "st_b1", "2026-01-01T00:00:02.000Z", { input: "one" }),
      event("ev_a2", "llm.call", "2026-01-01T00:00:03.000Z", { step_id: "st_a2" }),
      tool("ev_b2", "st_b2", "2026-01-01T00:00:04.000Z", { input: "two" }),
      event("ev_a3", "llm.call", "2026-01-01T00:00:05.000Z", { step_id: "st_a3" }),
      tool("ev_b3", "st_b3", "2026-01-01T00:00:06.000Z", { input: "three" }),
    ];

    const loops = ofKind(detectSignals(steps), "loop");
    expect(loops).toHaveLength(1);
    expect(loops[0]?.count).toBe(3);
    expect(loops[0]?.step_ids).toEqual(["st_a1", "st_b1", "st_a2", "st_b2", "st_a3", "st_b3"]);
  });

  it("detects control interrupts and interrupted/cancelled turn ends", () => {
    const signals = detectSignals([
      event("ev_int", "control.interrupt", "2026-01-01T00:00:01.000Z", {
        turn_id: "turn_1",
        step_id: "st_int",
        attrs: { reason: "user" },
      }),
      event("ev_end_1", "turn.end", "2026-01-01T00:00:02.000Z", {
        turn_id: "turn_1",
        status: "interrupted",
      }),
      event("ev_end_2", "turn.end", "2026-01-01T00:00:03.000Z", {
        turn_id: "turn_2",
        status: "cancelled",
      }),
    ]);

    expect(ofKind(signals, "user_interrupt")).toEqual([
      { kind: "user_interrupt", turn_id: "turn_1", step_ids: ["st_int"] },
      { kind: "user_interrupt", turn_id: "turn_2", step_ids: [] },
    ]);
  });

  it("flags the first user message of the next turn after an interrupt with high confidence", () => {
    const signals = detectSignals([
      event("ev_end", "turn.end", "2026-01-01T00:00:01.000Z", {
        turn_id: "turn_1",
        status: "interrupted",
      }),
      event("ev_user", "message.user", "2026-01-01T00:00:02.000Z", {
        turn_id: "turn_2",
        content: { capture: "full", input: { text: "Please use the other file" } },
      }),
      event("ev_user_2", "message.user", "2026-01-01T00:00:03.000Z", {
        turn_id: "turn_2",
        content: { capture: "full", input: { text: "wrong, not that one" } },
      }),
    ]);

    expect(ofKind(signals, "user_correction")).toEqual([
      { kind: "user_correction", turn_id: "turn_2", step_ids: [], confidence: 0.9 },
    ]);
  });

  it("flags correction patterns without an interrupt with lower confidence", () => {
    const cases: Array<[string, string]> = [
      ["ev_no", "No, use the other file"],
      ["ev_stop", "stop doing that"],
      ["ev_wrong", "wrong file"],
      ["ev_thats", "that's not what I asked"],
      ["ev_dont", "don't touch that"],
      ["ev_actually", "actually, run the tests"],
      ["ev_instead", "instead, check the logs"],
      ["ev_cn_budui", "不对，用另一个文件"],
      ["ev_cn_bushi", "不是这个"],
      ["ev_cn_bie", "别改这里"],
      ["ev_cn_ting", "停"],
      ["ev_cn_cuole", "错了"],
    ];

    for (const [id, text] of cases) {
      const signals = detectSignals([
        event(id, "message.user", "2026-01-01T00:00:01.000Z", {
          content: { capture: "full", input: { text } },
        }),
      ]);
      expect(ofKind(signals, "user_correction"), text).toEqual([
        { kind: "user_correction", turn_id: "turn_1", step_ids: [], confidence: 0.6 },
      ]);
    }
  });

  it("does not treat an ordinary message as a correction", () => {
    const signals = detectSignals([
      event("ev_ok", "message.user", "2026-01-01T00:00:01.000Z", {
        content: { capture: "full", input: { text: "nothing to see here" } },
      }),
    ]);
    expect(ofKind(signals, "user_correction")).toEqual([]);
  });

  it("is deterministic and ignores duplicate event ids", () => {
    const events = [
      tool("ev_1", "st_1", "2026-01-01T00:00:01.000Z", { input: "ls" }),
      tool("ev_2", "st_2", "2026-01-01T00:00:02.000Z", { input: "ls" }),
      tool("ev_3", "st_3", "2026-01-01T00:00:03.000Z", { input: "ls" }),
    ];
    expect(detectSignals(events)).toEqual(detectSignals([...events, ...events]));
  });
});
