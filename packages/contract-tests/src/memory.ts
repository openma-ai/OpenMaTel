/**
 * Reference implementations of the OpenMaTel ports.
 *
 * These are small, dependency-free implementations that behave like a real
 * adapter. They exist for two reasons:
 *
 * - the contract suites need a reference to be tested against — a contract
 *   that no implementation can pass is a broken contract;
 * - a new adapter can compare its own behaviour with the reference while it
 *   is being written.
 *
 * The store keeps the events in memory, keyed by session and event id, and
 * derives the session summaries and the turn/step tree with the pure
 * functions of `@openmatel/core` (`summarizeSession`, `buildSessionTree`), so
 * the reference behaves exactly like a store that stores the same events.
 */

import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";

import {
  buildSessionTree,
  summarizeSession,
  type AgentEvent,
  type AggQuery,
  type AggResult,
  type Bus,
  type Page,
  type Query,
  type SessionQuery,
  type SessionSummary,
  type Sink,
  type Source,
  type SourceCursor,
  type Step,
  type StepQuery,
  type StepNode,
  type Unsubscribe,
} from "@openmatel/core";

import { sleep } from "./support.js";

/* -------------------------------------------------------------------------- */
/* Store                                                                       */
/* -------------------------------------------------------------------------- */

/** An in-memory store: the Sink and the Query of one dataset. */
export interface MemoryStore {
  /** Write side. */
  sink: Sink;
  /** Read side. */
  query: Query;
  /** Drop everything the store holds. */
  close(): Promise<void>;
}

/**
 * Create an in-memory store.
 *
 * Writes are idempotent by `event_id` (the last write wins) and a step that
 * was captured with `capture: "none"` never keeps its text.
 */
export function createMemoryStore(): MemoryStore {
  /** session id → event id → event. */
  const sessions = new Map<string, Map<string, AgentEvent>>();

  const eventsOf = (session_id: string): AgentEvent[] => {
    const events = sessions.get(session_id);
    return events ? [...events.values()] : [];
  };

  const allSessions = (): Array<[string, AgentEvent[]]> =>
    [...sessions.entries()]
      .filter(([, events]) => events.size > 0)
      .map(([session_id, events]) => [session_id, [...events.values()]]);

  const sink: Sink = {
    id: "memory",
    write: async (batch) => {
      for (const event of batch) {
        if (!event || typeof event.event_id !== "string" || event.event_id === "") continue;
        let stored = sessions.get(event.session_id);
        if (!stored) {
          stored = new Map<string, AgentEvent>();
          sessions.set(event.session_id, stored);
        }
        stored.set(event.event_id, storeEvent(event));
      }
    },
  };

  const query: Query = {
    listSessions: async (q: SessionQuery) => listSessions(allSessions(), q),
    getSession: async (session_id: string) => {
      const events = eventsOf(session_id);
      if (events.length === 0) return null;
      const tree = buildSessionTree(events);
      return {
        summary: summarizeSession(events),
        events,
        turns: tree.turns,
        segments: tree.segments,
      };
    },
    listSteps: async (q: StepQuery) => listSteps(allSessions(), q),
    aggregate: async (q: AggQuery) => aggregate(allSessions(), q),
  };

  return {
    sink,
    query,
    close: async () => {
      sessions.clear();
    },
  };
}

/** Copy an event and drop the content of a step that was captured with "none". */
const storeEvent = (event: AgentEvent): AgentEvent => {
  const copy: AgentEvent = {
    ...event,
    attrs: { ...event.attrs },
    source: { ...event.source },
  };

  if (event.content) {
    copy.content =
      event.content.capture === "none"
        ? { capture: "none" }
        : {
            ...event.content,
            input: event.content.input ? { ...event.content.input } : undefined,
            output: event.content.output ? { ...event.content.output } : undefined,
          };
  }

  if (event.usage) copy.usage = { ...event.usage };
  if (event.error) copy.error = { ...event.error };
  if (event.links) copy.links = { ...event.links };

  return copy;
};

/* -------------------------------------------------------------------------- */
/* Queries                                                                     */
/* -------------------------------------------------------------------------- */

/** The order the session list uses: `started_at` desc, then session id. */
const compareSummaries = (left: SessionSummary, right: SessionSummary): number => {
  const leftAt = left.started_at ?? "";
  const rightAt = right.started_at ?? "";
  if (leftAt !== rightAt) return leftAt < rightAt ? 1 : -1;
  return left.session_id < right.session_id ? -1 : left.session_id > right.session_id ? 1 : 0;
};

const listSessions = async (
  all: Array<[string, AgentEvent[]]>,
  q: SessionQuery,
): Promise<Page<SessionSummary>> => {
  let summaries = all.map(([, events]) => summarizeSession(events));

  if (q.project_id !== undefined) {
    summaries = summaries.filter((summary) => summary.project_id === q.project_id);
  }
  if (q.source !== undefined) {
    summaries = summaries.filter((summary) => summary.source === q.source);
  }
  if (q.harness !== undefined) {
    summaries = summaries.filter((summary) => summary.harness === q.harness);
  }
  if (q.has_error !== undefined) {
    const withError = new Set(
      all
        .filter(([, events]) => events.some((event) => event.status === "error" || event.error))
        .map(([session_id]) => session_id),
    );
    summaries = summaries.filter((summary) => withError.has(summary.session_id) === q.has_error);
  }
  if (q.text !== undefined && q.text !== "") {
    const needle = q.text.toLowerCase();
    const eventsBySession = new Map(all);
    summaries = summaries.filter((summary) => {
      if (summary.title && summary.title.toLowerCase().includes(needle)) return true;
      if (summary.cwd && summary.cwd.toLowerCase().includes(needle)) return true;
      const events = eventsBySession.get(summary.session_id) ?? [];
      return events.some((event) => {
        const text = `${event.content?.input?.text ?? ""} ${event.content?.output?.text ?? ""}`;
        return text.toLowerCase().includes(needle);
      });
    });
  }
  if (q.from !== undefined) {
    const from = q.from;
    summaries = summaries.filter(
      (summary) => summary.started_at !== null && summary.started_at >= from,
    );
  }
  if (q.to !== undefined) {
    const to = q.to;
    summaries = summaries.filter(
      (summary) => summary.started_at !== null && summary.started_at < to,
    );
  }

  summaries.sort(compareSummaries);

  const start = cursorIndex(summaries, q.cursor);
  const limit = q.limit !== undefined && q.limit > 0 ? q.limit : summaries.length;
  const items = summaries.slice(start, start + limit);
  const last = items[items.length - 1];
  const next_cursor = start + items.length < summaries.length && last ? encodeCursor(last) : null;

  return { items, next_cursor };
};

const listSteps = async (
  all: Array<[string, AgentEvent[]]>,
  q: StepQuery,
): Promise<Page<Step>> => {
  let steps: Step[] = [];

  for (const [session_id, events] of all) {
    if (q.session_id !== undefined && q.session_id !== session_id) continue;
    if (q.project_id !== undefined) {
      const project_id = events[0]?.project_id;
      if (project_id !== q.project_id) continue;
    }

    const { turns } = buildSessionTree(events);
    const meta = new Map<string, { turn_id?: string; parent_step_id?: string }>();
    for (const event of events) {
      if (!event.step_id) continue;
      const previous = meta.get(event.step_id);
      meta.set(event.step_id, {
        turn_id: event.turn_id ?? previous?.turn_id,
        parent_step_id: event.parent_step_id ?? previous?.parent_step_id,
      });
    }

    for (const turn of turns) {
      if (q.turn_id !== undefined && q.turn_id !== turn.turn_id) continue;
      for (const node of flattenSteps(turn.steps)) {
        const info = meta.get(node.step_id);
        steps.push({
          step_id: node.step_id,
          session_id,
          turn_id: info?.turn_id ?? turn.turn_id,
          parent_step_id: info?.parent_step_id,
          kind: node.kind,
          status: node.status,
          ts: node.ts,
          end_ts: node.end_ts,
          title: node.title,
          attrs: node.attrs,
          error: node.error,
          usage: node.usage,
          source: node.source,
        });
      }
    }
  }

  if (q.kind !== undefined) {
    const kinds = new Set(Array.isArray(q.kind) ? q.kind : [q.kind]);
    steps = steps.filter((step) => kinds.has(step.kind));
  }
  if (q.status !== undefined) {
    steps = steps.filter((step) => step.status === q.status);
  }
  if (q.tool_name !== undefined) {
    steps = steps.filter((step) => step.attrs.tool_name === q.tool_name);
  }
  if (q.harness !== undefined) {
    steps = steps.filter((step) => {
      const harness = step.attrs.harness;
      if (typeof harness === "string") return harness === q.harness;
      if (harness && typeof harness === "object") {
        return (harness as { name?: unknown }).name === q.harness;
      }
      return false;
    });
  }
  if (q.from !== undefined) {
    const from = q.from;
    steps = steps.filter((step) => step.ts >= from);
  }
  if (q.to !== undefined) {
    const to = q.to;
    steps = steps.filter((step) => step.ts < to);
  }

  steps.sort((left, right) => {
    if (left.ts !== right.ts) return left.ts < right.ts ? -1 : 1;
    return left.step_id < right.step_id ? -1 : left.step_id > right.step_id ? 1 : 0;
  });

  const limit = q.limit !== undefined && q.limit > 0 ? q.limit : steps.length;
  const start = q.cursor ? stepCursorIndex(steps, q.cursor) : 0;
  const items = steps.slice(start, start + limit);
  const last = items[items.length - 1];
  const next_cursor =
    start + items.length < steps.length && last
      ? Buffer.from(`${last.ts}${last.step_id}`, "utf8").toString("base64url")
      : null;

  return { items, next_cursor };
};

const aggregate = async (
  all: Array<[string, AgentEvent[]]>,
  q: AggQuery,
): Promise<AggResult> => {
  const groups = new Map<string, number>();
  let total = 0;

  for (const [, events] of all) {
    for (const event of events) {
      if (q.project_id !== undefined && event.project_id !== q.project_id) continue;
      if (q.from !== undefined && event.ts < q.from) continue;
      if (q.to !== undefined && event.ts >= q.to) continue;

      const key = groupKey(event, q.group_by);
      groups.set(key, (groups.get(key) ?? 0) + 1);
      total += 1;
    }
  }

  return {
    groups: [...groups.entries()]
      .map(([key, count]) => ({ key, count }))
      .sort((left, right) => right.count - left.count || (left.key < right.key ? -1 : 1)),
    total,
  };
};

const groupKey = (event: AgentEvent, group_by: AggQuery["group_by"]): string => {
  switch (group_by) {
    case "tool_name":
      return typeof event.attrs.tool_name === "string" ? event.attrs.tool_name : "unknown";
    case "harness": {
      const harness = event.attrs.harness;
      if (typeof harness === "string") return harness;
      if (harness && typeof harness === "object") {
        const name = (harness as { name?: unknown }).name;
        return typeof name === "string" ? name : "unknown";
      }
      return "unknown";
    }
    case "model":
      return typeof event.attrs.model === "string" ? event.attrs.model : "unknown";
    case "project":
      return event.project_id;
    case "kind":
    default:
      return event.kind;
  }
};

const flattenSteps = (steps: StepNode[]): StepNode[] =>
  steps.flatMap((step) => [step, ...flattenSteps(step.children)]);

/* -------------------------------------------------------------------------- */
/* Cursors                                                                     */
/* -------------------------------------------------------------------------- */

const encodeCursor = (summary: SessionSummary): string =>
  Buffer.from(
    JSON.stringify({ started_at: summary.started_at, session_id: summary.session_id }),
    "utf8",
  ).toString("base64url");

const decodeCursor = (cursor: string): { session_id: string } | null => {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      session_id?: unknown;
    };
    if (typeof parsed?.session_id !== "string") return null;
    return { session_id: parsed.session_id };
  } catch {
    return null;
  }
};

const cursorIndex = (summaries: SessionSummary[], cursor: string | undefined): number => {
  if (!cursor) return 0;
  const decoded = decodeCursor(cursor);
  if (!decoded) return 0;
  const index = summaries.findIndex((summary) => summary.session_id === decoded.session_id);
  return index < 0 ? 0 : index + 1;
};

const stepCursorIndex = (steps: Step[], cursor: string): number => {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const index = steps.findIndex((step) => `${step.ts}${step.step_id}` === decoded);
    return index < 0 ? 0 : index + 1;
  } catch {
    return 0;
  }
};

/* -------------------------------------------------------------------------- */
/* Bus                                                                         */
/* -------------------------------------------------------------------------- */

/** An in-memory bus with at-least-once delivery. */
export interface MemoryBus extends Bus {
  /** Stop the delivery loops. */
  close(): Promise<void>;
  /** Number of batches that are waiting for a redelivery. */
  pending(): number;
}

/** Options of {@link createMemoryBus}. */
export interface MemoryBusOptions {
  /** How long the bus waits before it delivers a batch again. Default: 5ms. */
  retryDelayMs?: number;
  /** How often a batch is delivered before it is dropped. Default: 10. */
  maxAttempts?: number;
}

/**
 * Create an in-memory bus.
 *
 * Every subscriber has its own queue: a subscriber that throws gets the
 * batch again, the other subscribers are not affected. The number of attempts
 * is bounded so that a permanently broken subscriber cannot keep a test
 * process alive — a production bus retries with a backoff instead.
 */
export function createMemoryBus(options: MemoryBusOptions = {}): MemoryBus {
  const retryDelayMs = options.retryDelayMs ?? 5;
  const maxAttempts = options.maxAttempts ?? 10;

  interface Subscription {
    handler: (batch: AgentEvent[]) => Promise<void>;
    queue: Array<{ batch: AgentEvent[]; attempts: number }>;
    running: boolean;
  }

  const subscriptions = new Set<Subscription>();
  let closed = false;

  const drain = async (subscription: Subscription): Promise<void> => {
    subscription.running = false;
    while (!closed && subscription.queue.length > 0) {
      const item = subscription.queue.shift();
      if (!item) break;
      try {
        await subscription.handler(item.batch);
      } catch {
        if (item.attempts + 1 < maxAttempts) {
          subscription.queue.push({ batch: item.batch, attempts: item.attempts + 1 });
          await sleep(retryDelayMs);
        }
      }
    }
  };

  const bus: MemoryBus = {
    publish: async (batch) => {
      if (closed) return;
      for (const subscription of subscriptions) {
        subscription.queue.push({ batch: [...batch], attempts: 0 });
        if (!subscription.running) {
          subscription.running = true;
          void drain(subscription);
        }
      }
    },
    subscribe: (handler): Unsubscribe => {
      const subscription: Subscription = { handler, queue: [], running: false };
      subscriptions.add(subscription);
      return () => {
        subscriptions.delete(subscription);
        subscription.queue = [];
      };
    },
    close: async () => {
      closed = true;
      for (const subscription of subscriptions) subscription.queue = [];
      subscriptions.clear();
    },
    pending: () =>
      [...subscriptions].reduce((sum, subscription) => sum + subscription.queue.length, 0),
  };

  return bus;
}

/* -------------------------------------------------------------------------- */
/* Pull source                                                                 */
/* -------------------------------------------------------------------------- */

/** Options of {@link createFileSource}. */
export interface FileSourceOptions {
  /** Path of the file to read. */
  path: string;
  /** Offset the source starts at. */
  startOffset?: number;
  /** Hash of the first `startOffset` bytes, to detect a rewritten file. */
  startHash?: string;
  /** How often the file is polled. Default: 20ms. */
  pollIntervalMs?: number;
  /** Name of the source in the emitted records. Default: "file". */
  sourceName?: string;
}

/**
 * Create a pull source that reads a JSONL file.
 *
 * The source polls the file, emits every complete line it finds and reports
 * its position through `checkpoint()`. A file that was truncated or rewritten
 * is read again from the start.
 */
export function createFileSource(options: FileSourceOptions): Source {
  const pollIntervalMs = options.pollIntervalMs ?? 20;
  const sourceName = options.sourceName ?? "file";

  let offset = options.startOffset ?? 0;
  let pending = "";
  let lineNumber = 0;
  let expectedHash = options.startHash;

  const source: Source = {
    id: sourceName,
    kind: "pull",
    start: async (emit, signal) => {
      // The file may have been rewritten since the checkpoint: compare the
      // bytes of the checkpoint with the bytes that are there now.
      if (expectedHash !== undefined && offset > 0) {
        const hash = await hashPrefix(options.path, offset);
        if (hash !== expectedHash) {
          offset = 0;
          pending = "";
          lineNumber = 0;
        }
      }
      expectedHash = undefined;

      while (!signal.aborted) {
        const stats = await stat(options.path).catch(() => null);

        if (stats && stats.isFile()) {
          if (stats.size < offset) {
            // The file was truncated: read it again from the start.
            offset = 0;
            pending = "";
            lineNumber = 0;
          }

          if (stats.size > offset) {
            const chunk = await readFrom(options.path, offset, stats.size);
            offset += Buffer.byteLength(chunk, "utf8");
            pending += chunk;

            const lines = pending.split("\n");
            pending = lines.pop() ?? "";

            for (const line of lines) {
              if (line.trim() === "") continue;
              lineNumber += 1;
              const data = parseLine(line);
              await emit({
                source: sourceName,
                ref: `${options.path}#${lineNumber}`,
                line: lineNumber,
                data,
              });
            }
          }
        }

        await sleep(pollIntervalMs);
      }
    },
    checkpoint: async (): Promise<SourceCursor> => {
      const stats = await stat(options.path).catch(() => null);
      return {
        source: sourceName,
        ref: options.path,
        offset,
        mtime: stats ? stats.mtime.toISOString() : undefined,
        hash: await hashPrefix(options.path, offset),
      };
    },
  };

  return source;
}

const readFrom = async (path: string, offset: number, size: number): Promise<string> => {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(Math.max(0, size - offset));
    if (buffer.length > 0) await handle.read(buffer, 0, buffer.length, offset);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
};

const hashPrefix = async (path: string, length: number): Promise<string | undefined> => {
  if (length <= 0) return undefined;
  try {
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      return createHash("sha256").update(buffer.subarray(0, bytesRead)).digest("hex");
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
};

const parseLine = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    return line;
  }
};
