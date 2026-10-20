import { describe, expect, it, vi } from "vitest";

import type { AgentEvent, RawRecord, Sink } from "@openmatel/core";

import { createInprocBus } from "@openmatel/bus-inproc";

import {
  runLocalIndex,
  type CursorStore,
  type LocalIndexFile,
  type LocalIndexPipeline,
  type LocalIndexSource,
} from "./local-index.js";
import { createPipeline } from "./pipeline.js";

const file: LocalIndexFile = {
  source: "test",
  path: "/tmp/session.jsonl",
  size: 10,
  mtimeMs: 1000,
};

const makeEvent = (event_id: string): AgentEvent => ({
  schema: "oma.agentobs.v1",
  event_id,
  project_id: "local",
  session_id: "ss_local",
  ts: "2026-01-01T00:00:00.000Z",
  kind: "message.user",
  attrs: {},
  source: { name: "test", format: "jsonl" },
});

const makeSource = (events: AgentEvent[] = [makeEvent("ev_file")]): LocalIndexSource & {
  reads: number;
} => {
  const source = {
    source: "test",
    reads: 0,
    discover: async () => [file],
    readRecords: async (): Promise<RawRecord[]> => {
      source.reads += 1;
      return [{ source: "test", ref: `${file.path}#L1`, line: 1, data: {} }];
    },
    normalizeFile: (): AgentEvent[] => events,
  };
  return source;
};

const memoryCursors = (): CursorStore & { values: Map<string, string> } => {
  const values = new Map<string, string>();
  return {
    values,
    getCursor: (key) => values.get(key) ?? null,
    setCursor: (key, value) => {
      values.set(key, value);
    },
  };
};

const memorySink = (): Sink & { events: Map<string, AgentEvent> } => {
  const events = new Map<string, AgentEvent>();
  return {
    id: "memory",
    events,
    write: async (batch) => {
      for (const event of batch) events.set(event.event_id, event);
    },
  };
};

const ctx = { project_id: "local", capture_level: "full" } as const;

describe("runLocalIndex", () => {
  it("advances the cursor and skips the file on the next run", async () => {
    const source = makeSource();
    const cursors = memoryCursors();
    const sink = memorySink();
    const bus = createInprocBus({ maxAttempts: 3, retryDelayMs: 1 });
    const pipeline = createPipeline({ bus, sinks: [sink], ctx });

    try {
      const first = await runLocalIndex({
        sources: [source],
        pipeline,
        cursorStore: cursors,
        store: { ...cursors, sink },
      });

      expect(first.indexed).toBe(1);
      expect(first.events).toBe(1);
      expect(cursors.values.get(`file:${file.path}`)).toBe(`${file.size}:${file.mtimeMs}`);
      expect(source.reads).toBe(1);

      const second = await runLocalIndex({
        sources: [source],
        pipeline,
        cursorStore: cursors,
      });

      expect(second.indexed).toBe(0);
      expect(second.skipped).toBe(1);
      expect(source.reads).toBe(1);
    } finally {
      pipeline.close();
      await bus.close();
    }
  });

  it("does not advance the cursor when the sink dead-letters the batch", async () => {
    const source = makeSource([makeEvent("ev_dead")]);
    const cursors = memoryCursors();
    const sink: Sink = {
      id: "broken",
      write: async () => {
        throw new Error("disk full");
      },
    };
    const bus = createInprocBus({ maxAttempts: 2, retryDelayMs: 1 });
    const pipeline = createPipeline({ bus, sinks: [sink], ctx });
    const onError = vi.fn();

    try {
      const result = await runLocalIndex({
        sources: [source],
        pipeline,
        cursorStore: cursors,
        onError,
      });

      expect(result.indexed).toBe(0);
      expect(result.failed).toBe(1);
      expect(cursors.values.size).toBe(0);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(pipeline.stats.deadLettered).toBe(1);

      // The file is picked up again once the sink works.
      const workingSink = memorySink();
      const retryBus = createInprocBus({ maxAttempts: 3, retryDelayMs: 1 });
      const retryPipeline = createPipeline({ bus: retryBus, sinks: [workingSink], ctx });
      try {
        const retry = await runLocalIndex({
          sources: [source],
          pipeline: retryPipeline,
          cursorStore: cursors,
        });
        expect(retry.indexed).toBe(1);
        expect(workingSink.events.has("ev_dead")).toBe(true);
        expect(cursors.values.get(`file:${file.path}`)).toBe(`${file.size}:${file.mtimeMs}`);
      } finally {
        retryPipeline.close();
        await retryBus.close();
      }
    } finally {
      pipeline.close();
      await bus.close();
    }
  });

  it("re-indexes after a simulated crash before the cursor was written", async () => {
    const source = makeSource([makeEvent("ev_crash")]);
    const cursors = memoryCursors();
    const sink = memorySink();

    const crashing: LocalIndexPipeline = {
      ingest: async (events) => {
        await sink.write(events);
        throw new Error("killed before the cursor was written");
      },
      drain: async () => {},
      stats: { deadLettered: 0 },
    };

    const crashed = await runLocalIndex({
      sources: [source],
      pipeline: crashing,
      cursorStore: cursors,
    });

    expect(crashed.failed).toBe(1);
    expect(crashed.indexed).toBe(0);
    expect(cursors.values.size).toBe(0);
    expect(sink.events.size).toBe(1);

    const bus = createInprocBus({ maxAttempts: 3, retryDelayMs: 1 });
    const pipeline = createPipeline({ bus, sinks: [sink], ctx });
    try {
      const restarted = await runLocalIndex({
        sources: [source],
        pipeline,
        cursorStore: cursors,
      });

      expect(restarted.indexed).toBe(1);
      expect(source.reads).toBe(2);
      // The deterministic event id collapses the replayed write.
      expect(sink.events.size).toBe(1);
      expect(cursors.values.get(`file:${file.path}`)).toBe(`${file.size}:${file.mtimeMs}`);
    } finally {
      pipeline.close();
      await bus.close();
    }
  });
});
