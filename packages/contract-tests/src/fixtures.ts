/**
 * Shared fixtures for the contract suites.
 *
 * Every adapter runs the same events through its own store, normalizer or
 * source, so the fixtures have to be *stable*: the same call always produces
 * the same ids, the same timestamps and the same payload. That is what makes
 * a contract failure reproducible instead of "it differed this time".
 *
 * The fixtures are built on top of `@openmatel/core`:
 *
 * - ids come from the deterministic helpers (`eventId`, `sessionId`, …);
 * - every event is a valid `oma.agentobs.v1` event (`validateEvent` passes);
 * - usage keeps the "missing is not zero" rule of §4.5 — a field the source
 *   did not report stays `null`, a field the source reported as `0` stays `0`.
 */

import {
  FIRST_SEGMENT_ID,
  SCHEMA_VERSION,
  eventId,
  sessionId,
  type AgentEvent,
  type EventKind,
  type Usage,
} from "@openmatel/core";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * `JSON.stringify` with a stable key order.
 *
 * Used to derive deterministic event ids from a partial event, so that two
 * calls with the same input produce the same id.
 */
export const stableStringify = (value: unknown): string => {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
};

/** The fields a caller may override when building an event. */
export type EventOverrides = Partial<Omit<AgentEvent, "schema" | "kind">> & {
  /** What the agent did. Required — there is no sensible default. */
  kind: EventKind;
  /** ISO timestamp of the event. Defaults to {@link DEFAULT_TS}. */
  ts?: string;
};

/** Timestamp used when a fixture does not care about time. */
export const DEFAULT_TS = "2026-01-01T00:00:00.000Z";

/** The provenance every fixture event carries. */
export const DEFAULT_SOURCE = { name: "contract", format: "json" } as const;

/**
 * Build one valid agent event.
 *
 * Every field except `kind` has a default, so a fixture only spells out what
 * the contract actually looks at. The default `event_id` is derived from the
 * partial itself: the same partial always yields the same id.
 */
export function makeEvent(partial: EventOverrides): AgentEvent {
  const defined = Object.fromEntries(
    Object.entries(partial).filter(([, value]) => value !== undefined),
  ) as EventOverrides;

  const event: AgentEvent = {
    schema: SCHEMA_VERSION,
    event_id: eventId(["contract", stableStringify(defined)]),
    project_id: "proj_contract",
    session_id: sessionId("contract", "default"),
    segment_id: FIRST_SEGMENT_ID,
    ts: DEFAULT_TS,
    attrs: {},
    source: { ...DEFAULT_SOURCE },
    ...defined,
    kind: partial.kind,
  };

  return event;
}

/* -------------------------------------------------------------------------- */
/* Usage fixtures                                                              */
/* -------------------------------------------------------------------------- */

/** Usage with every token reported: the "everything is known" case. */
export const fullUsage = (overrides: Partial<Usage> = {}): Usage => ({
  input_tokens: 120,
  output_tokens: 40,
  cache_read_tokens: null,
  cache_write_tokens: null,
  reasoning_tokens: null,
  source: "provider",
  ...overrides,
});

/** Usage where the source reported real zeros — not "missing". */
export const zeroUsage = (overrides: Partial<Usage> = {}): Usage => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: null,
  cache_write_tokens: null,
  reasoning_tokens: null,
  source: "provider",
  ...overrides,
});

/** Usage where the source reported nothing at all. */
export const missingUsage = (): Usage => ({
  input_tokens: null,
  output_tokens: null,
  cache_read_tokens: null,
  cache_write_tokens: null,
  reasoning_tokens: null,
  source: "missing",
});

/* -------------------------------------------------------------------------- */
/* The canonical sample session                                                */
/* -------------------------------------------------------------------------- */

/** Canonical session id of the sample session of a project. */
export const sampleSessionId = (projectId: string): string => sessionId("contract", `sample-${projectId}`);

/** Title of the sample session — unique enough to be used as a search term. */
export const SAMPLE_TITLE = "Fix the login bug";

/** First timestamp of the sample session. */
export const SAMPLE_TS = "2026-01-02T03:00:00.000Z";

/** Turn ids of the sample session. */
export const SAMPLE_TURN_1 = "turn_sample_1";
export const SAMPLE_TURN_2 = "turn_sample_2";

/** Segment ids of the sample session. */
export const SAMPLE_SEGMENT_1 = "seg_0";
export const SAMPLE_SEGMENT_2 = "seg_1";

/** Step ids of the sample session. */
export const SAMPLE_STEPS = {
  llm_1: "st_sample_llm_1",
  llm_2: "st_sample_llm_2",
  llm_3: "st_sample_llm_3",
  llm_4: "st_sample_llm_4",
  tool_ok: "st_sample_tool_1",
  tool_error: "st_sample_tool_2",
  tool_child: "st_sample_tool_3",
  subagent: "st_sample_sub_1",
  plan: "st_sample_plan_1",
} as const;

const at = (seconds: number): string =>
  new Date(Date.parse(SAMPLE_TS) + seconds * 1000).toISOString();

/**
 * The canonical sample session of a project.
 *
 * It contains everything a contract needs to look at:
 *
 * - two turns, so turn boundaries are exercised;
 * - three `llm.call` steps with usage that mixes known values (`120`/`40`),
 *   real zeros (`0`) and a completely missing usage (`null`), plus one more
 *   call in the second turn;
 * - a successful `tool.call`, a failed one and a nested child step that is
 *   written *after* its parent in the fixture but may arrive before it;
 * - a `subagent.spawn` and a `plan.update`.
 *
 * The ids are stable, so an adapter can assert on them directly.
 */
export function sampleSessions(projectId: string): AgentEvent[] {
  const session_id = sampleSessionId(projectId);
  const source = { name: "claude-code", version: "2.0", format: "jsonl" };
  const common = { project_id: projectId, session_id, source };

  return [
    makeEvent({
      ...common,
      event_id: "ev_sample_session_start",
      kind: "session.start",
      ts: at(0),
      attrs: {
        harness: { name: "claude-code", version: "2.0" },
        model: "claude-opus",
        cwd: "/repo",
        title: SAMPLE_TITLE,
      },
    }),
    makeEvent({
      ...common,
      event_id: "ev_sample_turn_1_start",
      kind: "turn.start",
      turn_id: SAMPLE_TURN_1,
      ts: at(1),
      attrs: { trigger: "user", model: "claude-opus" },
    }),
    makeEvent({
      ...common,
      event_id: "ev_sample_message_user",
      kind: "message.user",
      turn_id: SAMPLE_TURN_1,
      ts: at(2),
      attrs: { role: "user" },
      content: { capture: "full", input: { text: "please fix the login bug" } },
    }),
    makeEvent({
      ...common,
      event_id: "ev_sample_llm_1",
      kind: "llm.call",
      turn_id: SAMPLE_TURN_1,
      step_id: SAMPLE_STEPS.llm_1,
      ts: at(3),
      end_ts: at(5),
      status: "ok",
      attrs: {
        provider: "anthropic",
        model: "claude-opus",
        context_tokens: null,
        stop_reason: "end_turn",
        latency_ms: 2000,
        ttft_ms: null,
        request_id: "req_1",
      },
      usage: fullUsage(),
    }),
    makeEvent({
      ...common,
      event_id: "ev_sample_tool_ok",
      kind: "tool.call",
      turn_id: SAMPLE_TURN_1,
      step_id: SAMPLE_STEPS.tool_ok,
      ts: at(6),
      end_ts: at(7),
      status: "ok",
      attrs: { tool_name: "read", tool_kind: "read", call_id: "call_1", duration_ms: 1000 },
      content: { capture: "full", output: { text: "file contents" } },
    }),
    makeEvent({
      ...common,
      event_id: "ev_sample_tool_error",
      kind: "tool.call",
      turn_id: SAMPLE_TURN_1,
      step_id: SAMPLE_STEPS.tool_error,
      ts: at(8),
      end_ts: at(9),
      status: "error",
      error: { type: "ENOENT", message: "no such file", retryable: false },
      attrs: { tool_name: "bash", tool_kind: "execute", call_id: "call_2", duration_ms: 1000 },
    }),
    makeEvent({
      ...common,
      event_id: "ev_sample_tool_child",
      kind: "tool.call",
      turn_id: SAMPLE_TURN_1,
      step_id: SAMPLE_STEPS.tool_child,
      parent_step_id: SAMPLE_STEPS.tool_ok,
      ts: at(10),
      end_ts: at(11),
      status: "ok",
      attrs: { tool_name: "grep", tool_kind: "search", call_id: "call_3", duration_ms: 1000 },
    }),
    makeEvent({
      ...common,
      event_id: "ev_sample_llm_2",
      kind: "llm.call",
      turn_id: SAMPLE_TURN_1,
      step_id: SAMPLE_STEPS.llm_2,
      ts: at(12),
      end_ts: at(14),
      status: "ok",
      attrs: {
        provider: "anthropic",
        model: "claude-opus",
        context_tokens: null,
        stop_reason: "end_turn",
        latency_ms: 2000,
        ttft_ms: null,
        request_id: "req_2",
      },
      usage: zeroUsage(),
    }),
    makeEvent({
      ...common,
      event_id: "ev_sample_subagent",
      kind: "subagent.spawn",
      turn_id: SAMPLE_TURN_1,
      step_id: SAMPLE_STEPS.subagent,
      ts: at(15),
      status: "ok",
      attrs: { child_session_id: "ss_sample_child", agent_name: "explore", task: "find the bug" },
    }),
    makeEvent({
      ...common,
      event_id: "ev_sample_plan",
      kind: "plan.update",
      turn_id: SAMPLE_TURN_1,
      step_id: SAMPLE_STEPS.plan,
      ts: at(16),
      status: "ok",
      attrs: { entries: [{ content: "read the code", status: "done", priority: "high" }] },
    }),
    makeEvent({
      ...common,
      event_id: "ev_sample_llm_3",
      kind: "llm.call",
      turn_id: SAMPLE_TURN_1,
      step_id: SAMPLE_STEPS.llm_3,
      ts: at(17),
      end_ts: at(19),
      status: "ok",
      attrs: {
        provider: null,
        model: null,
        context_tokens: null,
        stop_reason: null,
        latency_ms: null,
        ttft_ms: null,
        request_id: null,
      },
      usage: null,
    }),
    makeEvent({
      ...common,
      event_id: "ev_sample_message_agent",
      kind: "message.agent",
      turn_id: SAMPLE_TURN_1,
      ts: at(20),
      attrs: { role: "assistant" },
      content: { capture: "full", output: { text: "the login bug is fixed" } },
    }),
    makeEvent({
      ...common,
      event_id: "ev_sample_turn_1_end",
      kind: "turn.end",
      turn_id: SAMPLE_TURN_1,
      ts: at(21),
      end_ts: at(22),
      status: "ok",
      attrs: { stop_reason: "end_turn" },
      usage: null,
    }),
    makeEvent({
      ...common,
      event_id: "ev_sample_segment_boundary",
      kind: "segment.boundary",
      segment_id: SAMPLE_SEGMENT_2,
      ts: at(30),
      attrs: {
        reason: "compaction",
        context_tokens_before: 120,
        context_tokens_after: 40,
        tokens_removed: 80,
        summary: "older turns compacted",
        parent_segment_id: SAMPLE_SEGMENT_1,
        derived: false,
      },
    }),
    makeEvent({
      ...common,
      event_id: "ev_sample_turn_2_start",
      kind: "turn.start",
      turn_id: SAMPLE_TURN_2,
      segment_id: SAMPLE_SEGMENT_2,
      ts: at(40),
      attrs: { trigger: "user", model: "claude-opus" },
    }),
    makeEvent({
      ...common,
      event_id: "ev_sample_llm_4",
      kind: "llm.call",
      turn_id: SAMPLE_TURN_2,
      segment_id: SAMPLE_SEGMENT_2,
      step_id: SAMPLE_STEPS.llm_4,
      ts: at(41),
      end_ts: at(43),
      status: "ok",
      attrs: {
        provider: "anthropic",
        model: "claude-opus",
        context_tokens: null,
        stop_reason: "end_turn",
        latency_ms: 2000,
        ttft_ms: null,
        request_id: "req_4",
      },
      usage: fullUsage({ input_tokens: 10, output_tokens: 5 }),
    }),
    makeEvent({
      ...common,
      event_id: "ev_sample_turn_2_end",
      kind: "turn.end",
      turn_id: SAMPLE_TURN_2,
      segment_id: SAMPLE_SEGMENT_2,
      ts: at(44),
      end_ts: at(45),
      status: "ok",
      attrs: { stop_reason: "end_turn" },
      usage: null,
    }),
    makeEvent({
      ...common,
      event_id: "ev_sample_session_end",
      kind: "session.end",
      segment_id: SAMPLE_SEGMENT_2,
      ts: at(50),
      status: "ok",
      attrs: { end_reason: "completed", title: SAMPLE_TITLE },
    }),
  ];
}
