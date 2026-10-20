/**
 * Automatic turn signals (design §15.6).
 *
 * Signals are heuristics, not verdicts: the UI shows them as hints and an
 * eval/human score can still disagree. Detection is pure and deterministic —
 * the same events always produce the same signals in the same order.
 *
 * The four signals are:
 *
 * - `repeated_tool_failure` — the same tool and (roughly) the same input fail
 *   consecutively at least three times;
 * - `loop` — the same tool/input runs at least three times in a turn, or a
 *   short step sequence repeats consecutively at least three times;
 * - `user_interrupt` — `control.interrupt` / `control.cancel`, or a turn that
 *   ended as `interrupted` / `cancelled`;
 * - `user_correction` — the first user message after an interrupted turn, or
 *   a user message that starts with a correction pattern.
 */

import type { AgentEvent } from "./schema.js";

/** The kind of an automatically detected signal. */
export type SignalKind =
  | "repeated_tool_failure"
  | "loop"
  | "user_interrupt"
  | "user_correction";

/** Runtime list of every known {@link SignalKind}, in presentation order. */
export const SIGNAL_KINDS = [
  "repeated_tool_failure",
  "loop",
  "user_interrupt",
  "user_correction",
] as const satisfies readonly SignalKind[];

/** A signal detected on one turn. */
export interface Signal {
  kind: SignalKind;
  turn_id: string;
  /** Steps the signal points at, in event order. */
  step_ids: string[];
  /** Number of repetitions for the repeated/loop signals. */
  count?: number;
  /** Confidence of the heuristic, for `user_correction`. */
  confidence?: number;
  /** Optional human-readable explanation. */
  detail?: string;
}

/** Turn id used for events that do not belong to a turn. */
const SYNTHETIC_TURN_ID = "turn_0";

/** How similar two tool inputs have to be when compared. */
const INPUT_COMPARE_LENGTH = 200;

/** Number of repetitions that turns a pattern into a signal. */
const SIGNAL_THRESHOLD = 3;

/** Consecutive failing tool calls required for `repeated_tool_failure`. */
const FAILURE_THRESHOLD = 3;

/**
 * A user message that starts with one of these is likely a correction.
 *
 * English and Chinese patterns are both supported. The expression is applied
 * to the trimmed, lower-cased message, so "No, use the other file" matches.
 */
const CORRECTION_PATTERN =
  /^(?:no\b|nope\b|stop\b|wrong\b|that(?:'s|’s| is)?\s+not\b|don(?:'t|’t)\b|do not\b|actually\b|instead\b|不对|不是|别|停|错了)/i;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

const turnOf = (event: AgentEvent): string => asString(event.turn_id) ?? SYNTHETIC_TURN_ID;

const stepOf = (event: AgentEvent): string | undefined => asString(event.step_id);

/** Remove duplicated events, keeping the last write for an `event_id`. */
function dedupe(events: AgentEvent[]): AgentEvent[] {
  const byId = new Map<string, AgentEvent>();
  for (const event of events) {
    if (!isObject(event)) continue;
    const id = event.event_id;
    if (typeof id !== "string" || id === "") continue;
    byId.set(id, event);
  }
  return [...byId.values()];
}

/** Stable timestamp order, with the event id as tie breaker. */
function sortEvents(events: AgentEvent[]): AgentEvent[] {
  return [...events].sort((left, right) => {
    const delta = Date.parse(left.ts) - Date.parse(right.ts);
    if (delta !== 0 && !Number.isNaN(delta)) return delta;
    if (left.ts !== right.ts) return left.ts < right.ts ? -1 : 1;
    if (left.event_id === right.event_id) return 0;
    return left.event_id < right.event_id ? -1 : 1;
  });
}

/** `JSON.stringify` with sorted object keys, so key order does not matter. */
function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}

/**
 * Normalize the input of a tool call for comparison.
 *
 * JSON is canonicalized (sorted keys, no insignificant whitespace), plain text
 * gets its whitespace collapsed. Only the first
 * {@link INPUT_COMPARE_LENGTH} characters take part in the comparison, so a
 * large but nearly identical edit still looks like the same call.
 */
function normalizedInput(event: AgentEvent): string {
  const content = isObject(event.content) ? event.content : undefined;
  const input = isObject(content?.input) ? content.input : undefined;
  let value: unknown = input?.json ?? input?.text ?? event.attrs.input;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        value = JSON.parse(trimmed) as unknown;
      } catch {
        // Not JSON after all: normalize it as text.
      }
    }
  }

  let text: string;
  if (typeof value === "string") {
    text = value.replace(/\s+/g, " ").trim();
  } else if (value === undefined) {
    text = "";
  } else {
    text = stableStringify(value);
  }
  return text.slice(0, INPUT_COMPARE_LENGTH);
}

/** `true` when a tool call failed. */
const isFailure = (event: AgentEvent): boolean =>
  event.status === "error" || event.error !== undefined;

/** Key of a tool call for "same tool and same input" comparisons. */
const toolKey = (event: AgentEvent): string => {
  const name = asString(event.attrs.tool_name) ?? "";
  return `${name}\u0000${normalizedInput(event)}`;
};

/** The token a step contributes to the repeated-sequence detector. */
function sequenceToken(event: AgentEvent): string {
  if (event.kind === "tool.call") {
    return `tool.call:${asString(event.attrs.tool_name) ?? ""}`;
  }
  return event.kind;
}

/** A step reduced to the information the sequence detector needs. */
interface SequenceStep {
  step_id: string;
  token: string;
}

/**
 * The steps of a turn, in first-seen order.
 *
 * Several events may describe the same step (a tool call and its result); the
 * last one wins for its token, but the step keeps the position of its first
 * event so the sequence stays the order the agent acted in.
 */
function stepsOfTurn(events: AgentEvent[]): SequenceStep[] {
  const byId = new Map<string, { token: string; order: number }>();
  for (const event of events) {
    if (event.kind === "segment.boundary") continue;
    const stepId = stepOf(event);
    if (stepId === undefined) continue;
    const previous = byId.get(stepId);
    byId.set(stepId, {
      token: sequenceToken(event),
      order: previous?.order ?? byId.size,
    });
  }
  return [...byId.entries()]
    .sort(([, left], [, right]) => left.order - right.order)
    .map(([step_id, entry]) => ({ step_id, token: entry.token }));
}

/** Find a sequence of 2–4 steps that repeats consecutively at least 3 times. */
function repeatedSequences(steps: SequenceStep[]): Array<{
  step_ids: string[];
  count: number;
  length: number;
}> {
  const matches: Array<{ step_ids: string[]; count: number; length: number }> = [];
  const tokens = steps.map((step) => step.token);

  for (let length = 2; length <= 4; length += 1) {
    for (let start = 0; start + length * SIGNAL_THRESHOLD <= tokens.length; start += 1) {
      let repeats = 1;
      while (
        start + length * (repeats + 1) <= tokens.length &&
        tokens
          .slice(start + length * repeats, start + length * (repeats + 1))
          .every((token, index) => token === tokens[start + index])
      ) {
        repeats += 1;
      }
      if (repeats < SIGNAL_THRESHOLD) continue;

      const ids = steps
        .slice(start, start + length * repeats)
        .map((step) => step.step_id);
      matches.push({ step_ids: ids, count: repeats, length });

      // Skip the whole repeated block so the same loop is reported once.
      start += length * repeats - 1;
    }
  }

  return matches;
}

/** Read the plain text of a user message. */
function userText(event: AgentEvent): string {
  const content = isObject(event.content) ? event.content : undefined;
  const input = isObject(content?.input) ? content.input : undefined;
  if (typeof input?.text === "string") return input.text;
  if (typeof event.attrs.text === "string") return event.attrs.text;
  return "";
}

/** `true` when a message starts with one of the correction patterns. */
function startsWithCorrection(text: string): boolean {
  return CORRECTION_PATTERN.test(text.trim());
}

/** Order the signals of one turn deterministically. */
const kindOrder = (kind: SignalKind): number => SIGNAL_KINDS.indexOf(kind);

/**
 * Detect the signals of a turn (or of a whole session).
 *
 * Pass the events of one turn to detect that turn's signals; pass a whole
 * session to also detect the "first user message of the next turn after an
 * interrupted turn" variant of `user_correction`.
 */
export function detectSignals(turnEvents: AgentEvent[]): Signal[] {
  const ordered = sortEvents(dedupe(turnEvents));

  const byTurn = new Map<string, AgentEvent[]>();
  const turnOrder = new Map<string, number>();
  for (const event of ordered) {
    const turnId = turnOf(event);
    const events = byTurn.get(turnId);
    if (events) {
      events.push(event);
    } else {
      byTurn.set(turnId, [event]);
      turnOrder.set(turnId, turnOrder.size);
    }
  }

  const signals = new Map<string, Signal>();
  const add = (signal: Signal): void => {
    const key = `${signal.turn_id}\u0000${signal.kind}`;
    const previous = signals.get(key);
    if (!previous) {
      signals.set(key, signal);
      return;
    }
    for (const stepId of signal.step_ids) {
      if (!previous.step_ids.includes(stepId)) previous.step_ids.push(stepId);
    }
    if (signal.count !== undefined) {
      previous.count = Math.max(previous.count ?? 0, signal.count);
    }
    if (signal.confidence !== undefined) {
      previous.confidence = Math.max(previous.confidence ?? 0, signal.confidence);
    }
    if (signal.detail !== undefined && previous.detail === undefined) {
      previous.detail = signal.detail;
    }
  };

  /* ---------------------------------------------------------------------- */
  /* Interrupts                                                              */
  /* ---------------------------------------------------------------------- */

  const interrupted = new Set<string>();
  for (const event of ordered) {
    const isInterrupt =
      event.kind === "control.interrupt" ||
      event.kind === "control.cancel" ||
      (event.kind === "turn.end" &&
        (event.status === "interrupted" || event.status === "cancelled"));
    if (!isInterrupt) continue;

    const turnId = turnOf(event);
    interrupted.add(turnId);
    const stepId = stepOf(event);
    add({
      kind: "user_interrupt",
      turn_id: turnId,
      step_ids: stepId === undefined ? [] : [stepId],
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Tool failures and loops                                                 */
  /* ---------------------------------------------------------------------- */

  for (const [turnId, events] of byTurn) {
    const toolCalls = events.filter((event) => event.kind === "tool.call");

    // Consecutive failing calls of the same tool and input.
    let run: { key: string; stepIds: string[] } | undefined;
    const flushRun = (): void => {
      if (run === undefined || run.stepIds.length < FAILURE_THRESHOLD) {
        run = undefined;
        return;
      }
      add({
        kind: "repeated_tool_failure",
        turn_id: turnId,
        step_ids: [...run.stepIds],
        count: run.stepIds.length,
      });
      run = undefined;
    };

    for (const call of toolCalls) {
      if (!isFailure(call)) {
        flushRun();
        continue;
      }
      const key = toolKey(call);
      const stepId = stepOf(call);
      if (run !== undefined && run.key === key) {
        if (stepId !== undefined) run.stepIds.push(stepId);
      } else {
        flushRun();
        run = { key, stepIds: stepId === undefined ? [] : [stepId] };
      }
    }
    flushRun();

    // The same tool and input repeated anywhere in the turn, regardless of
    // status. Failing repeats also match this rule by design.
    const occurrences = new Map<string, { stepIds: string[]; count: number }>();
    for (const call of toolCalls) {
      const key = toolKey(call);
      const entry = occurrences.get(key) ?? { stepIds: [], count: 0 };
      entry.count += 1;
      const stepId = stepOf(call);
      if (stepId !== undefined) entry.stepIds.push(stepId);
      occurrences.set(key, entry);
    }

    let loopCount = 0;
    const loopStepIds: string[] = [];
    for (const entry of occurrences.values()) {
      if (entry.count < SIGNAL_THRESHOLD) continue;
      loopCount = Math.max(loopCount, entry.count);
      for (const stepId of entry.stepIds) {
        if (!loopStepIds.includes(stepId)) loopStepIds.push(stepId);
      }
    }

    // A short step sequence that repeats consecutively.
    const repeated = repeatedSequences(stepsOfTurn(events));
    for (const match of repeated) {
      loopCount = Math.max(loopCount, match.count);
      for (const stepId of match.step_ids) {
        if (!loopStepIds.includes(stepId)) loopStepIds.push(stepId);
      }
    }

    if (loopStepIds.length > 0) {
      add({
        kind: "loop",
        turn_id: turnId,
        step_ids: loopStepIds,
        count: loopCount,
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* User corrections                                                        */
  /* ---------------------------------------------------------------------- */

  // The immediately following turn of every interrupted turn.
  const turnIds = [...turnOrder.entries()]
    .sort(([, left], [, right]) => left - right)
    .map(([turnId]) => turnId);
  const afterInterrupt = new Set<string>();
  for (let index = 0; index < turnIds.length - 1; index += 1) {
    if (interrupted.has(turnIds[index] as string)) {
      afterInterrupt.add(turnIds[index + 1] as string);
    }
  }

  for (const [turnId, events] of byTurn) {
    const userMessages = events.filter((event) => event.kind === "message.user");
    const firstUser = userMessages[0];
    if (firstUser === undefined) continue;

    const after = afterInterrupt.has(turnId);
    const matching = userMessages.find((event) => startsWithCorrection(userText(event)));
    if (!after && matching === undefined) continue;

    // After an interrupt even a polite first message counts (the user is
    // steering the agent again); otherwise only a correction pattern does.
    const anchor = after ? firstUser : (matching as AgentEvent);
    const stepId = stepOf(anchor);
    add({
      kind: "user_correction",
      turn_id: turnId,
      step_ids: stepId === undefined ? [] : [stepId],
      confidence: after ? 0.9 : 0.6,
    });
  }

  return [...signals.values()].sort((left, right) => {
    const leftOrder = turnOrder.get(left.turn_id) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = turnOrder.get(right.turn_id) ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    if (left.kind !== right.kind) return kindOrder(left.kind) - kindOrder(right.kind);
    return left.turn_id < right.turn_id ? -1 : left.turn_id > right.turn_id ? 1 : 0;
  });
}
