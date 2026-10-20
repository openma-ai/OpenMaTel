/**
 * Session and step tree.
 *
 * The canonical event stream is flat: every event carries `turn_id` and
 * `parent_step_id` instead of being nested. This module turns that flat
 * stream back into the agent-native shape — session → turn → step tree — with
 * the robustness the pipeline needs:
 *
 * - events may arrive **out of order** (a child before its parent);
 * - the same event may arrive **twice** (at-least-once delivery): the last
 *   write for an `event_id` wins;
 * - a step may reference a **parent that does not exist** (the parent event
 *   was never captured): the step is kept and attached to the turn root;
 * - events **without a turn** are collected in a synthetic `turn_0`.
 *
 * Pure functions, no IO, no state.
 */

import type {
  AgentEvent,
  EventContent,
  EventError,
  EventKind,
  EventSource,
  StepStatus,
  Usage,
} from "./schema.js";
import { sumUsage, type UsageTotal } from "./usage.js";

/** Turn used for events that do not belong to a turn. */
export const SYNTHETIC_TURN_ID = "turn_0";

/** Kinds that describe the session itself; they are kept on the session, not in a turn. */
export const SESSION_LEVEL_KINDS: ReadonlySet<string> = new Set(["session.start", "session.end"]);

/** Outcome of a whole session. */
export type SessionStatus = StepStatus | "unknown";

/** One step of a turn, with its nested child steps. */
export interface StepNode {
  step_id: string;
  kind: EventKind;
  status?: StepStatus;
  /** Start timestamp of the step. */
  ts: string;
  /** End timestamp, when the step reported one. */
  end_ts?: string;
  /** Short human-readable label, derived from the attrs. */
  title?: string;
  attrs: Record<string, unknown>;
  error?: EventError;
  usage?: Usage | null;
  content?: EventContent;
  source: EventSource;
  /** Nested steps, e.g. a tool call that spawned a subagent. */
  children: StepNode[];
}

/** One turn of a session. */
export interface TurnNode {
  turn_id: string;
  /** Start timestamp of the turn. */
  ts: string | null;
  /** End timestamp of the turn, when known. */
  end_ts: string | null;
  /** Status reported by `turn.end`, when known. */
  status?: StepStatus;
  /** Every event of the turn, in timestamp order. */
  events: AgentEvent[];
  /** Root steps of the turn, in timestamp order. */
  steps: StepNode[];
}

/** Aggregated view of a session, used by the session list and the header. */
export interface SessionSummary {
  session_id: string;
  project_id: string;
  /** Source that produced the session, e.g. `"claude-code"`. */
  source: string | null;
  /** Harness that produced the session, e.g. `"claude-code"`. */
  harness: string | null;
  /** Model of the session, when known. */
  model: string | null;
  /** Title of the session, when the source gave one. */
  title: string | null;
  /** Working directory of the session, when known. */
  cwd: string | null;
  /** Timestamp of the first event. */
  started_at: string | null;
  /** Timestamp of the last event (or of its `end_ts`). */
  ended_at: string | null;
  /** Number of real turns (the synthetic `turn_0` is not counted). */
  turn_count: number;
  step_count: number;
  tool_call_count: number;
  tool_error_count: number;
  /** Number of child sessions spawned by this session. */
  subagent_count: number;
  /** Token usage and its coverage. */
  usage: UsageTotal;
  /** Outcome of the session. */
  status: SessionStatus;
}

interface StepEntry {
  step_id: string;
  turn_id: string;
  parent_step_id?: string;
  events: AgentEvent[];
  node: StepNode;
}

interface Collected {
  ordered: AgentEvent[];
  turns: Map<string, TurnNode>;
  steps: Map<string, StepEntry>;
  summary: SessionSummary;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const attrString = (attrs: Record<string, unknown>, key: string): string | undefined =>
  asString(attrs[key]);

/**
 * Remove duplicated events: the last write for an `event_id` wins.
 *
 * Order of the surviving events follows the order of their first appearance.
 */
function dedupeEvents(events: AgentEvent[]): AgentEvent[] {
  const byId = new Map<string, AgentEvent>();
  for (const event of events) {
    if (!isObject(event)) continue;
    const id = event.event_id;
    if (typeof id !== "string" || id === "") continue;
    byId.set(id, event);
  }
  return [...byId.values()];
}

/** Sort events by timestamp, keeping a stable, deterministic order. */
function sortEvents(events: AgentEvent[]): AgentEvent[] {
  return [...events].sort((a, b) => {
    const delta = Date.parse(a.ts) - Date.parse(b.ts);
    if (delta !== 0 && !Number.isNaN(delta)) return delta;
    if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
    if (a.event_id === b.event_id) return 0;
    return a.event_id < b.event_id ? -1 : 1;
  });
}

const stepTitle = (event: AgentEvent): string | undefined => {
  const attrs = event.attrs;
  switch (event.kind) {
    case "tool.call":
      return attrString(attrs, "tool_name");
    case "llm.call":
      return attrString(attrs, "model");
    case "env.command":
      return attrString(attrs, "command");
    case "env.file_edit":
      return attrString(attrs, "path");
    case "subagent.spawn":
    case "handoff":
      return attrString(attrs, "agent_name");
    default:
      return undefined;
  }
};

const nodeFromEvent = (event: AgentEvent): StepNode => ({
  step_id: event.step_id as string,
  kind: event.kind,
  status: event.status,
  ts: event.ts,
  end_ts: event.end_ts,
  title: stepTitle(event),
  attrs: event.attrs,
  error: event.error,
  usage: event.usage,
  content: event.content,
  source: event.source,
  children: [],
});

/**
 * Merge a follow-up event of the same step into the step node.
 *
 * The newest event wins for the fields it carries; fields it does not carry
 * (a tool call that reports its result in a second event, for instance) are
 * inherited from the previous one.
 */
const mergeStepNode = (previous: StepNode, event: AgentEvent): StepNode => {
  const next = nodeFromEvent(event);
  next.children = previous.children;
  if (next.usage === undefined && previous.usage !== undefined) next.usage = previous.usage;
  if (next.content === undefined && previous.content !== undefined) next.content = previous.content;
  if (next.error === undefined && previous.error !== undefined) next.error = previous.error;
  if (next.status === undefined && previous.status !== undefined) next.status = previous.status;
  if (next.end_ts === undefined && previous.end_ts !== undefined) next.end_ts = previous.end_ts;
  if (next.title === undefined && previous.title !== undefined) next.title = previous.title;
  return next;
};

/** `true` when following the parent chain from `parentId` leads back to `stepId`. */
const createsCycle = (
  stepId: string,
  parentId: string,
  steps: Map<string, StepEntry>,
): boolean => {
  const seen = new Set<string>([stepId]);
  let current: string | undefined = parentId;
  while (current !== undefined) {
    if (seen.has(current)) return true;
    seen.add(current);
    current = steps.get(current)?.parent_step_id;
  }
  return false;
};

const harnessName = (attrs: Record<string, unknown>): string | undefined => {
  const harness = attrs.harness;
  if (typeof harness === "string") return harness;
  if (isObject(harness)) return asString(harness.name);
  return undefined;
};

const collect = (events: AgentEvent[]): Collected => {
  const ordered = sortEvents(dedupeEvents(events));

  const turns = new Map<string, TurnNode>();
  const steps = new Map<string, StepEntry>();

  const turnOf = (event: AgentEvent): TurnNode => {
    const turnId = event.turn_id ?? SYNTHETIC_TURN_ID;
    let turn = turns.get(turnId);
    if (!turn) {
      turn = { turn_id: turnId, ts: null, end_ts: null, status: undefined, events: [], steps: [] };
      turns.set(turnId, turn);
    }
    return turn;
  };

  for (const event of ordered) {
    // Session-level events never belong to a turn and must not create the synthetic turn.
    if (event.turn_id === undefined && SESSION_LEVEL_KINDS.has(event.kind)) continue;
    const turn = turnOf(event);
    turn.events.push(event);

    if (turn.ts === null) turn.ts = event.ts;
    if (event.end_ts !== undefined) {
      turn.end_ts = turn.end_ts === null ? event.end_ts : maxTimestamp(turn.end_ts, event.end_ts);
    }
    if (event.kind === "turn.end" && event.status !== undefined) {
      turn.status = event.status;
    }

    if (!event.step_id) continue;

    const stepId = event.step_id;
    let entry = steps.get(stepId);
    if (!entry) {
      entry = {
        step_id: stepId,
        turn_id: turn.turn_id,
        parent_step_id: event.parent_step_id,
        events: [],
        node: nodeFromEvent(event),
      };
      steps.set(stepId, entry);
    } else if (entry.parent_step_id === undefined && event.parent_step_id !== undefined) {
      entry.parent_step_id = event.parent_step_id;
    }
    entry.events.push(event);
    entry.node = mergeStepNode(entry.node, event);
  }

  // Link children to their parent. A parent that is missing, lives in another
  // turn or forms a cycle leaves the step at the root of its turn.
  const parentOf = new Map<string, string>();
  for (const entry of steps.values()) {
    const parentId = entry.parent_step_id;
    if (!parentId) continue;
    const parent = steps.get(parentId);
    if (!parent) continue;
    if (parent.turn_id !== entry.turn_id) continue;
    if (createsCycle(entry.step_id, parentId, steps)) continue;
    parentOf.set(entry.step_id, parentId);
  }

  for (const entry of steps.values()) {
    const parentId = parentOf.get(entry.step_id);
    if (parentId !== undefined) {
      const parent = steps.get(parentId);
      if (parent) {
        parent.node.children.push(entry.node);
        continue;
      }
    }
    const turn = turns.get(entry.turn_id);
    if (turn) turn.steps.push(entry.node);
  }

  const orderedTurns = [...turns.values()].sort((a, b) => {
    if (a.ts === null) return b.ts === null ? 0 : 1;
    if (b.ts === null) return -1;
    if (a.ts === b.ts) return a.turn_id < b.turn_id ? -1 : a.turn_id > b.turn_id ? 1 : 0;
    return a.ts < b.ts ? -1 : 1;
  });

  return { ordered, turns, steps, summary: summarize(ordered, turns, steps) };
};

const maxTimestamp = (a: string, b: string): string => {
  const left = Date.parse(a);
  const right = Date.parse(b);
  if (Number.isNaN(left)) return b;
  if (Number.isNaN(right)) return a;
  return right > left ? b : a;
};

/**
 * Summarize a session.
 *
 * @param events - every event of one session, in any order.
 */
export function summarizeSession(events: AgentEvent[]): SessionSummary {
  return collect(events).summary;
}

/**
 * Build the session summary and the turn/step tree of a session.
 *
 * @param events - every event of one session, in any order. Duplicated
 *                 `event_id`s are collapsed (last write wins).
 */
export function buildSessionTree(events: AgentEvent[]): { session: SessionSummary; turns: TurnNode[] } {
  const collected = collect(events);
  return {
    session: collected.summary,
    turns: [...collected.turns.values()].sort((a, b) => {
      if (a.ts === null) return b.ts === null ? 0 : 1;
      if (b.ts === null) return -1;
      if (a.ts === b.ts) return a.turn_id < b.turn_id ? -1 : a.turn_id > b.turn_id ? 1 : 0;
      return a.ts < b.ts ? -1 : 1;
    }),
  };
}

const summarize = (
  ordered: AgentEvent[],
  turns: Map<string, TurnNode>,
  steps: Map<string, StepEntry>,
): SessionSummary => {
  const first = ordered[0];

  let startedAt: string | null = null;
  let endedAt: string | null = null;
  for (const event of ordered) {
    if (startedAt === null) {
      startedAt = event.ts;
    } else {
      startedAt = minTimestamp(startedAt, event.ts);
    }
    const end = event.end_ts ?? event.ts;
    endedAt = endedAt === null ? end : maxTimestamp(endedAt, end);
  }

  const sessionStart = ordered.find((event) => event.kind === "session.start");
  const sessionEnd = ordered.find((event) => event.kind === "session.end");

  const model =
    (sessionStart ? attrString(sessionStart.attrs, "model") : undefined) ??
    ordered.find((event) => event.kind === "llm.call")?.attrs.model ??
    null;
  const title = sessionStart ? attrString(sessionStart.attrs, "title") : undefined;
  const cwd = sessionStart ? attrString(sessionStart.attrs, "cwd") : undefined;

  let toolCallCount = 0;
  let toolErrorCount = 0;
  const childSessions = new Set<string>();
  let childSessionsWithoutId = 0;

  for (const event of ordered) {
    if (event.kind === "tool.call") {
      toolCallCount += 1;
      if (event.status === "error" || event.error !== undefined) toolErrorCount += 1;
    }
    if (event.kind === "subagent.spawn" || event.kind === "handoff") {
      const childId = attrString(event.attrs, "child_session_id");
      if (childId) childSessions.add(childId);
      else childSessionsWithoutId += 1;
    }
  }

  const llmUsages = ordered.filter((event) => event.kind === "llm.call").map((event) => event.usage);
  const turnUsages = ordered.filter((event) => event.kind === "turn.end").map((event) => event.usage);
  const usage = sumUsage(llmUsages.length > 0 ? llmUsages : turnUsages);

  return {
    session_id: first?.session_id ?? "",
    project_id: first?.project_id ?? "",
    source: first?.source.name ?? null,
    harness: sessionStart ? (harnessName(sessionStart.attrs) ?? null) : null,
    model: typeof model === "string" ? model : null,
    title: title ?? null,
    cwd: cwd ?? null,
    started_at: startedAt,
    ended_at: endedAt,
    turn_count: [...turns.keys()].filter((id) => id !== SYNTHETIC_TURN_ID).length,
    step_count: steps.size,
    tool_call_count: toolCallCount,
    tool_error_count: toolErrorCount,
    subagent_count: childSessions.size + childSessionsWithoutId,
    usage,
    status: sessionStatus(ordered, sessionEnd),
  };
};

const minTimestamp = (a: string, b: string): string => {
  const left = Date.parse(a);
  const right = Date.parse(b);
  if (Number.isNaN(left)) return b;
  if (Number.isNaN(right)) return a;
  return right < left ? b : a;
};

const sessionStatus = (ordered: AgentEvent[], sessionEnd: AgentEvent | undefined): SessionStatus => {
  if (sessionEnd) return sessionEnd.status ?? "ok";
  // Step-level failures (e.g. a failing tool call) do not fail the session; only the
  // session end or the last turn end decides. Without either the status is unknown.
  const lastTurnEnd = [...ordered].reverse().find((event) => event.kind === "turn.end");
  if (lastTurnEnd) return lastTurnEnd.status ?? "ok";
  return "unknown";
};
