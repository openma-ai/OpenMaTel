import { describe, expect, it, vi } from "vitest";

import type { AgentEvent, Processor, Sink } from "@openmatel/core";

import { createInprocBus } from "@openmatel/bus-inproc";

import { createPipeline } from "./pipeline.js";

const event = (event_id: string, kind: AgentEvent["kind"] = "message.user"): AgentEvent => ({
  schema: "oma.agentobs.v1",
  event_id,
  project_id: "local",
  session_id: "ss_pipeline",
  ts: "2026-01-01T00:00:00.000Z",
  kind,
  attrs: {},
  source: { name: "test", format: "jsonl" },
});

interface TestSink {
  sink: Sink;
  attempts: number;
  writes: AgentEvent[][];
  stored: () => AgentEvent[];
}

const createTestSink = (failures = 0): TestSink => {
  const byId = new Map<string, AgentEvent>();
  const writes: AgentEvent[][] = [];
  const result: TestSink = {
    sink: {
      id: "test",
      write: async (batch) => {
        result.attempts += 1;
        if (result.attempts <= failures) throw new Error("sink is down");
        writes.push(batch);
        for (const item of batch) byId.set(item.event_id, item);
      },
    },
    attempts: 0,
    writes,
    stored: () => [...byId.values()],
  };
  return result;
};

const ctx = { project_id: "local", capture_level: "full" } as const;

describe("createPipeline", () => {
  it("drops an event when a processor returns null", async () => {
    const bus = createInprocBus({ maxAttempts: 3, retryDelayMs: 1 });
    const sink = createTestSink();
    const drop: Processor = {
      id: "drop-user",
      process: async (item) => (item.kind === "message.user" ? null : item),
    };
    const pipeline = createPipeline({ bus, processors: [drop], sinks: [sink.sink], ctx });

    try {
      await pipeline.ingest([
        event("ev_drop", "message.user"),
        event("ev_keep", "tool.call"),
      ]);
      await pipeline.drain();

      expect(sink.stored().map((item) => item.event_id)).toEqual(["ev_keep"]);
      expect(pipeline.stats).toMatchObject({
        published: 2,
        written: 1,
        dropped: 1,
        failed: 0,
        deadLettered: 0,
      });
    } finally {
      pipeline.close();
      await bus.close();
    }
  });

  it("redelivers when a sink fails and writes the batch eventually", async () => {
    const bus = createInprocBus({ maxAttempts: 3, retryDelayMs: 1 });
    const sink = createTestSink(1);
    const onError = vi.fn();
    const pipeline = createPipeline({ bus, sinks: [sink.sink], ctx, onError });

    try {
      await pipeline.ingest([event("ev_retry_write")]);
      await pipeline.drain();

      expect(sink.attempts).toBe(2);
      expect(sink.stored().map((item) => item.event_id)).toEqual(["ev_retry_write"]);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(pipeline.stats).toMatchObject({
        published: 1,
        written: 1,
        dropped: 0,
        failed: 1,
        deadLettered: 0,
      });
    } finally {
      pipeline.close();
      await bus.close();
    }
  });

  it("dead-letters after the bus exhausted its attempts", async () => {
    const onDeadLetter = vi.fn();
    const bus = createInprocBus({ maxAttempts: 2, retryDelayMs: 1, onDeadLetter });
    const sink = createTestSink(Number.MAX_SAFE_INTEGER);
    const pipeline = createPipeline({ bus, sinks: [sink.sink], ctx });

    try {
      await pipeline.ingest([event("ev_dead")]);
      await pipeline.drain();

      expect(sink.attempts).toBe(2);
      expect(sink.stored()).toEqual([]);
      expect(onDeadLetter).toHaveBeenCalledTimes(1);
      expect(pipeline.stats).toMatchObject({
        published: 1,
        written: 0,
        failed: 2,
        deadLettered: 1,
      });
    } finally {
      pipeline.close();
      await bus.close();
    }
  });

  it("keeps an idempotent sink at one row when the same event is ingested twice", async () => {
    const bus = createInprocBus({ maxAttempts: 3, retryDelayMs: 1 });
    const sink = createTestSink();
    const pipeline = createPipeline({ bus, sinks: [sink.sink], ctx });

    try {
      await pipeline.ingest([event("ev_same")]);
      await pipeline.drain();
      await pipeline.ingest([event("ev_same")]);
      await pipeline.drain();

      expect(sink.stored()).toHaveLength(1);
      expect(sink.stored()[0]?.event_id).toBe("ev_same");
      expect(pipeline.stats.published).toBe(2);
      expect(pipeline.stats.written).toBe(2);
    } finally {
      pipeline.close();
      await bus.close();
    }
  });
});
