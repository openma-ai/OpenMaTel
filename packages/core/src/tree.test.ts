import { describe, expect, it } from "vitest";

import { SCHEMA_VERSION, type AgentEvent, type EventKind } from "./schema.js";
import { buildSessionTree, summarizeSession, SYNTHETIC_TURN_ID, type TurnNode } from "./tree.js";

const turnById = (turns: TurnNode[], turn_id: string): TurnNode => {
  const turn = turns.find((candidate) => candidate.turn_id === turn_id);
  if (!turn) throw new Error(`turn ${turn_id} not found`);
  return turn;
};

const event = (
  overrides: Partial<AgentEvent> & { event_id: string; kind: EventKind; ts: string },
): AgentEvent => ({
  schema: SCHEMA_VERSION,
  project_id: "proj_1",
  session_id: "ss_1",
  attrs: {},
  source: { name: "claude-code", format: "jsonl" },
  ...overrides,
});

const sessionStart = event({
  event_id: "ev_start",
  kind: "session.start",
  ts: "2026-01-02T03:00:00.000Z",
  attrs: { harness: { name: "claude-code", version: "2.0" }, model: "claude-opus", cwd: "/repo", title: "Fix the bug" },
});

const toolCall = event({
  event_id: "ev_tool",
  kind: "tool.call",
  turn_id: "turn_1",
  step_id: "st_tool",
  ts: "2026-01-02T03:00:01.000Z",
  end_ts: "2026-01-02T03:00:02.000Z",
  status: "ok",
  attrs: { tool_name: "read", tool_kind: "read", call_id: "call_1" },
});

const childStep = event({
  event_id: "ev_child",
  kind: "llm.call",
  turn_id: "turn_1",
  step_id: "st_child",
  parent_step_id: "st_tool",
  ts: "2026-01-02T03:00:03.000Z",
  status: "ok",
  attrs: { model: "claude-opus" },
  usage: {
    input_tokens: 10,
    output_tokens: 4,
    cache_read_tokens: null,
    cache_write_tokens: null,
    reasoning_tokens: null,
    source: "provider",
  },
});

describe("buildSessionTree", () => {
  it("nests steps by parent_step_id", () => {
    const { turns } = buildSessionTree([sessionStart, toolCall, childStep]);

    const turn = turnById(turns, "turn_1");
    expect(turn.steps).toHaveLength(1);
    expect(turn.steps[0].step_id).toBe("st_tool");
    expect(turn.steps[0].children.map((child) => child.step_id)).toEqual(["st_child"]);
  });

  it("is robust against out-of-order arrival", () => {
    const ordered = buildSessionTree([sessionStart, toolCall, childStep]);
    const shuffled = buildSessionTree([childStep, toolCall, sessionStart]);

    expect(shuffled.turns).toEqual(ordered.turns);
    expect(shuffled.session).toEqual(ordered.session);
  });

  it("collapses duplicated events, the last write wins", () => {
    const failed = event({
      event_id: "ev_tool",
      kind: "tool.call",
      turn_id: "turn_1",
      step_id: "st_tool",
      ts: "2026-01-02T03:00:01.000Z",
      status: "error",
      error: { type: "ENOENT", message: "no such file" },
      attrs: { tool_name: "read", tool_kind: "read", call_id: "call_1" },
    });

    const { session, turns } = buildSessionTree([sessionStart, toolCall, failed]);

    const turn = turnById(turns, "turn_1");
    expect(turn.steps).toHaveLength(1);
    expect(turn.steps[0].status).toBe("error");
    expect(session.step_count).toBe(1);
    expect(session.tool_call_count).toBe(1);
    expect(session.tool_error_count).toBe(1);
  });

  it("keeps orphan steps at the root of their turn", () => {
    const orphan = event({
      event_id: "ev_orphan",
      kind: "tool.call",
      turn_id: "turn_1",
      step_id: "st_orphan",
      parent_step_id: "st_never_seen",
      ts: "2026-01-02T03:00:04.000Z",
      attrs: { tool_name: "grep", tool_kind: "search", call_id: "call_2" },
    });

    const { turns, session } = buildSessionTree([sessionStart, toolCall, orphan]);

    expect(turnById(turns, "turn_1").steps.map((step) => step.step_id)).toEqual(["st_tool", "st_orphan"]);
    expect(session.step_count).toBe(2);
  });

  it("does not loop on a cycle in parent_step_id", () => {
    const a = event({
      event_id: "ev_a",
      kind: "tool.call",
      turn_id: "turn_1",
      step_id: "st_a",
      parent_step_id: "st_b",
      ts: "2026-01-02T03:00:05.000Z",
      attrs: {},
    });
    const b = event({
      event_id: "ev_b",
      kind: "tool.call",
      turn_id: "turn_1",
      step_id: "st_b",
      parent_step_id: "st_a",
      ts: "2026-01-02T03:00:06.000Z",
      attrs: {},
    });

    const { turns } = buildSessionTree([a, b]);

    expect(turns[0].steps).toHaveLength(2);
    expect(turns[0].steps.every((step) => step.children.length === 0)).toBe(true);
  });

  it("collects events without a turn in a synthetic turn", () => {
    const { turns } = buildSessionTree([sessionStart, { ...toolCall, turn_id: undefined }]);

    expect(turns.map((turn) => turn.turn_id)).toContain(SYNTHETIC_TURN_ID);
    expect(turns.find((turn) => turn.turn_id === SYNTHETIC_TURN_ID)?.events).toHaveLength(1);
  });

  it("counts the child sessions of a session", () => {
    const spawn = (id: string, child?: string) =>
      event({
        event_id: id,
        kind: "subagent.spawn",
        turn_id: "turn_1",
        step_id: `st_${id}`,
        ts: "2026-01-02T03:00:07.000Z",
        attrs: child ? { child_session_id: child, agent_name: "explore" } : { agent_name: "explore" },
      });

    const summary = summarizeSession([
      sessionStart,
      spawn("ev_spawn_1", "ss_child_1"),
      spawn("ev_spawn_2", "ss_child_2"),
      spawn("ev_spawn_3", "ss_child_1"),
      spawn("ev_spawn_4"),
    ]);

    expect(summary.subagent_count).toBe(3);
  });
});

describe("summarizeSession", () => {
  it("summarizes a session", () => {
    const sessionEnd = event({
      event_id: "ev_end",
      kind: "session.end",
      turn_id: "turn_1",
      ts: "2026-01-02T03:10:00.000Z",
      status: "ok",
      attrs: { end_reason: "idle" },
    });

    const summary = summarizeSession([sessionStart, toolCall, childStep, sessionEnd]);

    expect(summary.session_id).toBe("ss_1");
    expect(summary.project_id).toBe("proj_1");
    expect(summary.source).toBe("claude-code");
    expect(summary.harness).toBe("claude-code");
    expect(summary.model).toBe("claude-opus");
    expect(summary.title).toBe("Fix the bug");
    expect(summary.cwd).toBe("/repo");
    expect(summary.started_at).toBe("2026-01-02T03:00:00.000Z");
    expect(summary.ended_at).toBe("2026-01-02T03:10:00.000Z");
    // session.start is session-level, so only the real turn is counted.
    expect(summary.turn_count).toBe(1);
    expect(summary.step_count).toBe(2);
    expect(summary.tool_call_count).toBe(1);
    expect(summary.tool_error_count).toBe(0);
    expect(summary.status).toBe("ok");
  });

  it("sums the usage of the model calls and reports its coverage", () => {
    const summary = summarizeSession([sessionStart, toolCall, childStep]);

    expect(summary.usage.total.input_tokens).toBe(10);
    expect(summary.usage.total.output_tokens).toBe(4);
    expect(summary.usage.total.cache_read_tokens).toBeNull();
    expect(summary.usage.calls).toBe(1);
    expect(summary.usage.covered).toBe(1);
    expect(summary.usage.coverage).toBe(1);
  });

  it("reports an unknown status for a session that never ended", () => {
    expect(summarizeSession([sessionStart, toolCall]).status).toBe("unknown");
  });

  it("does not fail the session because one step failed", () => {
    const failed = event({
      event_id: "ev_failed",
      kind: "tool.call",
      turn_id: "turn_1",
      step_id: "st_failed",
      ts: "2026-01-02T03:00:08.000Z",
      status: "error",
      attrs: { tool_name: "bash", tool_kind: "execute", call_id: "call_3" },
    });

    const summary = summarizeSession([sessionStart, failed]);
    expect(summary.status).toBe("unknown");
    expect(summary.tool_error_count).toBe(1);
  });

  it("summarizes an empty session without throwing", () => {
    const summary = summarizeSession([]);
    expect(summary.session_id).toBe("");
    expect(summary.turn_count).toBe(0);
    expect(summary.step_count).toBe(0);
    expect(summary.usage.calls).toBe(0);
    expect(summary.usage.coverage).toBeNull();
  });
});
