import { describe, expect, it } from "vitest";

import {
  SCHEMA_VERSION,
  type AgentEvent,
  type EventKind,
} from "@openmatel/core";

import {
  isSyntheticModel,
  modelUsage,
  toManagedEvents,
} from "./to-managed-events";

const event = (
  event_id: string,
  kind: EventKind,
  ts: string,
  overrides: Partial<AgentEvent> = {},
): AgentEvent => ({
  schema: SCHEMA_VERSION,
  event_id,
  project_id: "local",
  session_id: "ses_test",
  segment_id: "seg_0",
  kind,
  ts,
  attrs: {},
  source: { name: "claude-code", format: "claude-code.jsonl" },
  ...overrides,
});

const convert = (events: AgentEvent[]) => toManagedEvents({ turns: [{ events }] });
const byType = (events: ReturnType<typeof convert>, type: string) =>
  events.filter((entry) => entry.type === type);

describe("toManagedEvents", () => {
  it("stamps every event with id, processed_at, ISO ts and seq in time order", () => {
    const events = convert([
      event("u1", "message.user", "2026-10-20T10:00:00.000Z", {
        content: { input: { text: "hello" }, capture: "full" },
      }),
      event("a1", "message.agent", "2026-10-20T10:00:02.000Z", {
        content: { output: { text: "hi" }, capture: "full" },
      }),
    ]);

    expect(events.map((entry) => entry.type)).toEqual(["user.message", "agent.message"]);
    expect(events[0]).toMatchObject({
      id: "u1:user",
      ts: "2026-10-20T10:00:00.000Z",
      processed_at: "2026-10-20T10:00:00.000Z",
      seq: 1,
    });
    expect(events[1]?.seq).toBe(2);
    expect(events[0]?.content).toEqual([{ type: "text", text: "hello" }]);
    expect(events[1]?.content).toEqual([{ type: "text", text: "hi" }]);
  });

  it("puts the user message before the turn-status marker at the same timestamp", () => {
    const events = convert([
      event("t1", "turn.start", "2026-10-20T10:00:00.000Z"),
      event("u1", "message.user", "2026-10-20T10:00:00.000Z", {
        content: { input: { text: "hello" }, capture: "full" },
      }),
      event("t2", "turn.end", "2026-10-20T10:00:03.000Z"),
    ]);

    expect(events.map((entry) => entry.type)).toEqual([
      "user.message",
      "session.status_running",
      "session.status_idle",
    ]);
  });

  it("maps reasoning to agent.thinking", () => {
    const events = convert([
      event("r1", "reasoning", "2026-10-20T10:00:00.000Z", {
        content: { output: { text: "thinking..." }, capture: "full" },
      }),
    ]);
    expect(events[0]).toMatchObject({
      type: "agent.thinking",
      content: [{ type: "text", text: "thinking..." }],
    });
  });

  it("emits a model span pair with only the reported usage fields", () => {
    const events = convert([
      event("l1", "llm.call", "2026-10-20T10:00:00.000Z", {
        end_ts: "2026-10-20T10:00:03.000Z",
        attrs: {
          provider: null,
          model: "claude-opus-5-5",
          context_tokens: null,
          stop_reason: "stop",
          latency_ms: null,
          ttft_ms: 500,
        },
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_tokens: null,
          cache_write_tokens: 2,
          reasoning_tokens: null,
          source: "provider",
        },
      }),
    ]);

    expect(events.map((entry) => entry.type)).toEqual([
      "span.model_request_start",
      "span.model_first_token",
      "span.model_request_end",
    ]);
    const start = byType(events, "span.model_request_start")[0];
    const first = byType(events, "span.model_first_token")[0];
    const end = byType(events, "span.model_request_end")[0];

    expect(start?.id).toBe("l1:model_start");
    expect(end?.id).toBe("l1:model_end");
    expect(end?.model).toBe("claude-opus-5-5");
    expect(end?.finish_reason).toBe("stop");
    expect(end?.model_usage).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 2,
    });
    expect(end?.model_usage).not.toHaveProperty("cache_read_input_tokens");
    expect(first?.model_request_start_id).toBe("l1:model_start");
    expect(first?.processed_at).toBe("2026-10-20T10:00:00.500Z");
    expect(end?.processed_at).toBe("2026-10-20T10:00:03.000Z");
  });

  it("omits model_usage entirely when the call reported none", () => {
    const events = convert([
      event("l1", "llm.call", "2026-10-20T10:00:00.000Z", {
        attrs: {
          provider: null,
          model: "claude-opus-5-5",
          context_tokens: null,
          stop_reason: null,
          latency_ms: null,
          ttft_ms: null,
        },
        usage: null,
      }),
    ]);
    const end = byType(events, "span.model_request_end")[0];
    expect(end).toBeDefined();
    expect(end).not.toHaveProperty("model_usage");
    expect((end?.data as Record<string, unknown>)).not.toHaveProperty("model_usage");
  });

  it("never uses <synthetic> as the model of a call", () => {
    const events = convert([
      event("l1", "llm.call", "2026-10-20T10:00:00.000Z", {
        attrs: {
          provider: null,
          model: "<synthetic>",
          context_tokens: null,
          stop_reason: null,
          latency_ms: null,
          ttft_ms: null,
        },
      }),
    ]);
    for (const item of events) expect(item.model).toBeUndefined();
  });

  it("pairs a tool call with its result and folds env children", () => {
    const events = convert([
      event("tc1", "tool.call", "2026-10-20T10:00:00.000Z", {
        step_id: "st1",
        end_ts: "2026-10-20T10:00:02.000Z",
        status: "ok",
        attrs: { tool_name: "Bash", tool_kind: "execute", call_id: "call-1" },
        content: {
          input: { json: { command: "ls" } },
          output: { text: "a.txt" },
          capture: "full",
        },
      }),
      event("env1", "env.command", "2026-10-20T10:00:00.000Z", {
        parent_step_id: "st1",
        attrs: { command: "ls" },
      }),
      event("env2", "env.command", "2026-10-20T10:00:00.000Z", {
        parent_step_id: "st1",
        attrs: { command: "pwd" },
        content: { output: { text: "/tmp" }, capture: "full" },
      }),
    ]);

    expect(events.some((entry) => entry.type.startsWith("env."))).toBe(false);
    const use = byType(events, "agent.tool_use")[0];
    const result = byType(events, "agent.tool_result")[0];
    expect(use).toMatchObject({ id: "call-1", name: "Bash" });
    expect(use?.input).toMatchObject({ command: "ls", commands: ["ls", "pwd"] });
    expect(result).toMatchObject({ tool_use_id: "call-1", is_error: false });
    expect((result?.content as Array<{ text: string }>)[0]?.text).toContain("a.txt");
    expect((result?.content as Array<{ text: string }>)[0]?.text).toContain("/tmp");
  });

  it("marks a failed tool result as an error", () => {
    const events = convert([
      event("tc1", "tool.call", "2026-10-20T10:00:00.000Z", {
        status: "error",
        error: { type: "tool_error", message: "boom" },
        attrs: { tool_name: "Bash", tool_kind: "execute", call_id: "call-1" },
      }),
    ]);
    const result = byType(events, "agent.tool_result")[0];
    expect(result?.is_error).toBe(true);
    expect((result?.content as Array<{ text: string }>)[0]?.text).toBe("boom");
  });

  it("uses the MCP tool event family for MCP calls", () => {
    const events = convert([
      event("tc1", "tool.call", "2026-10-20T10:00:00.000Z", {
        end_ts: "2026-10-20T10:00:01.000Z",
        attrs: {
          tool_name: "mcp__github__search_issues",
          tool_kind: "mcp",
          call_id: "mcp-1",
        },
      }),
    ]);

    expect(events.map((entry) => entry.type)).toEqual([
      "agent.mcp_tool_use",
      "agent.mcp_tool_result",
    ]);
    expect(events[0]).toMatchObject({
      id: "mcp-1",
      name: "search_issues",
      mcp_server_name: "github",
    });
    expect(events[1]).toMatchObject({ mcp_tool_use_id: "mcp-1" });
  });

  it("maps plans, subagent spawns and compaction to timeline markers/spans", () => {
    const events = convert([
      event("p1", "plan.update", "2026-10-20T10:00:00.000Z", {
        attrs: { entries: [{ content: "step one", status: "pending" }] },
      }),
      event("s1", "subagent.spawn", "2026-10-20T10:00:01.000Z", {
        attrs: { agent_name: "explore", child_session_id: "ses_child" },
      }),
      event("c1", "control.compaction", "2026-10-20T10:00:02.000Z", {
        end_ts: "2026-10-20T10:00:03.000Z",
      }),
    ]);

    expect(byType(events, "agent.custom")[0]).toMatchObject({ name: "plan" });
    expect(byType(events, "session.thread_created")[0]).toMatchObject({
      thread_id: "ses_child",
      agent_name: "explore",
    });
    expect(events.map((entry) => entry.type)).toContain("span.compaction_summarize_start");
    expect(events.map((entry) => entry.type)).toContain("span.compaction_summarize_end");
  });

  it("deduplicates repeated event ids, keeping the last write", () => {
    const events = convert([
      event("u1", "message.user", "2026-10-20T10:00:00.000Z", {
        content: { input: { text: "first" }, capture: "full" },
      }),
      event("u1", "message.user", "2026-10-20T10:00:00.000Z", {
        content: { input: { text: "second" }, capture: "full" },
      }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]?.content).toEqual([{ type: "text", text: "second" }]);
  });
});

describe("modelUsage", () => {
  it("returns undefined for missing usage and keeps reported zeroes", () => {
    expect(modelUsage(null)).toBeUndefined();
    expect(modelUsage(undefined)).toBeUndefined();
    expect(
      modelUsage({
        input_tokens: 0,
        output_tokens: null,
        cache_read_tokens: null,
        cache_write_tokens: null,
        reasoning_tokens: null,
        source: "provider",
      }),
    ).toEqual({ input_tokens: 0 });
  });
});

describe("isSyntheticModel", () => {
  it("recognises the Claude Code sentinel", () => {
    expect(isSyntheticModel("<synthetic>")).toBe(true);
    expect(isSyntheticModel(" <SYNTHETIC> ")).toBe(true);
    expect(isSyntheticModel("claude-opus-5-5")).toBe(false);
    expect(isSyntheticModel(undefined)).toBe(false);
  });
});
