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
 * - `loop` — the same tool, input and result run consecutively at least three
 *   times in a turn, or a short sequence of such calls repeats consecutively
 *   at least three times;
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
  /** Number of repetitions (or consecutive calls) for the repeated/loop signals. */
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
 * gets its whitespace collapsed. By default only the first
 * {@link INPUT_COMPARE_LENGTH} characters take part in the comparison, which
 * keeps the failure heuristic tolerant of large but nearly identical edits;
 * loop detection passes `truncate: false` so the full value has to match.
 */
function normalizedInput(event: AgentEvent, truncate = true): string {
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
  return truncate ? text.slice(0, INPUT_COMPARE_LENGTH) : text;
}

/** `true` when a tool call failed. */
const isFailure = (event: AgentEvent): boolean =>
  event.status === "error" || event.error !== undefined;

/** Key of a tool call for "same tool and same input" failure comparisons. */
const toolKey = (event: AgentEvent): string => {
  const name = asString(event.attrs.tool_name) ?? "";
  return `${name}\u0000${normalizedInput(event)}`;
};

/**
 * Normalize the result of a tool call for comparison.
 *
 * The result is the captured output or the error text; whitespace around each
 * part is ignored. A call without either has an unknown result and is never
 * treated as a loop, because two missing results do not prove the calls did
 * the same thing.
 */
function normalizedResult(event: AgentEvent): string | undefined {
  const content = isObject(event.content) ? event.content : undefined;
  const output = isObject(content?.output) ? content.output : undefined;
  const error = isObject(event.error) ? event.error : undefined;
  const parts: string[] = [];

  if (error !== undefined) {
    const message = typeof error.message === "string" ? error.message.trim() : "";
    parts.push(`error:${message}`);
  }
  if (output !== undefined) {
    if (typeof output.text === "string") {
      parts.push(`output:text:${output.text.trim()}`);
    }
    if (output.json !== undefined) {
      parts.push(`output:json:${stableStringify(output.json).trim()}`);
    }
  }

  return parts.length === 0 ? undefined : parts.join("\u0000");
}

/** Key of a tool call for loop comparisons; `undefined` when its result is unknown. */
const loopKey = (event: AgentEvent): string | undefined => {
  const result = normalizedResult(event);
  if (result === undefined) return undefined;
  const name = asString(event.attrs.tool_name) ?? "";
  return `${name}\u0000${normalizedInput(event, false)}\u0000${result}`;
};

/** A tool call reduced to the information the sequence detector needs. */
interface SequenceStep {
  step_id: string;
  token: string | undefined;
}

/** The tool calls of a turn, in order, with their full loop key. */
function toolSteps(toolCalls: AgentEvent[]): SequenceStep[] {
  const steps: SequenceStep[] = [];
  for (const call of toolCalls) {
    const stepId = stepOf(call);
    if (stepId === undefined) continue;
    steps.push({ step_id: stepId, token: loopKey(call) });
  }
  return steps;
}

/**
 * Find a sequence of 2–3 tool calls that repeats consecutively at least 3
 * times. Every repetition must have the same tool, full input and result; a
 * call with an unknown result never takes part in a sequence.
 */
function repeatedSequences(steps: SequenceStep[]): Array<{
  step_ids: string[];
  count: number;
  length: number;
}> {
  const matches: Array<{ step_ids: string[]; count: number; length: number }> = [];
  const tokens = steps.map((step) => step.token);

  for (let length = 2; length <= 3; length += 1) {
    for (let start = 0; start + length * SIGNAL_THRESHOLD <= tokens.length; start += 1) {
      const period = tokens.slice(start, start + length);
      if (period.some((token) => token === undefined)) continue;
      // An all-identical period is just a run of the same call, which the
      // run detector above already reports (with the maximal run length).
      if (period.every((token) => token === period[0])) continue;

      let repeats = 1;
      while (
        start + length * (repeats + 1) <= tokens.length &&
        tokens
          .slice(start + length * repeats, start + length * (repeats + 1))
          .every((token, index) => token !== undefined && token === period[index])
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
  const add = (signal: Signal, runKey?: string): void => {
    const key = `${signal.turn_id}\u0000${signal.kind}${
      runKey === undefined ? "" : `\u0000${runKey}`
    }`;
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

    // A run of consecutive calls with the same tool, full input and result.
    const loopRuns: Array<{ step_ids: string[]; count: number }> = [];
    let loopRun: { key: string; stepIds: string[]; count: number } | undefined;
    const flushLoopRun = (): void => {
      if (loopRun !== undefined && loopRun.count >= SIGNAL_THRESHOLD) {
        loopRuns.push({ step_ids: [...loopRun.stepIds], count: loopRun.count });
      }
      loopRun = undefined;
    };

    for (const call of toolCalls) {
      const key = loopKey(call);
      const stepId = stepOf(call);
      if (key !== undefined && loopRun !== undefined && loopRun.key === key) {
        loopRun.count += 1;
        if (stepId !== undefined) loopRun.stepIds.push(stepId);
        continue;
      }
      flushLoopRun();
      if (key !== undefined) {
        loopRun = { key, stepIds: stepId === undefined ? [] : [stepId], count: 1 };
      }
    }
    flushLoopRun();

    // A short tool-call sequence that repeats consecutively with the same
    // tool, full input and result each time.
    const repeated = repeatedSequences(toolSteps(toolCalls)).map((match) => ({
      step_ids: match.step_ids,
      count: match.count,
    }));

    // Every maximal run gets its own signal; do not merge separate runs of a
    // turn into one aggregate.
    const loops = [...loopRuns, ...repeated];
    for (let index = 0; index < loops.length; index += 1) {
      const loop = loops[index];
      if (loop === undefined) continue;
      add(
        {
          kind: "loop",
          turn_id: turnId,
          step_ids: loop.step_ids,
          count: loop.count,
        },
        `run_${index}`,
      );
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
