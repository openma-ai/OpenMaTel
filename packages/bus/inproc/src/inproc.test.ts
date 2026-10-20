import { describe, expect, it, vi } from "vitest";

import { busContract } from "@openmatel/contract-tests";
import { makeEvent } from "@openmatel/contract-tests";

import { createInprocBus } from "./index.js";

busContract("inproc bus", async () =>
  createInprocBus({ maxAttempts: 3, retryDelayMs: 1 }),
);

describe("inproc bus lifecycle", () => {
  it("dead-letters a batch after maxAttempts", async () => {
    const onDeadLetter = vi.fn();
    const bus = createInprocBus({
      maxAttempts: 3,
      retryDelayMs: 1,
      onDeadLetter,
    });

    let attempts = 0;
    bus.subscribe(async () => {
      attempts += 1;
      throw new Error("still broken");
    });

    try {
      const batch = [makeEvent({ kind: "tool.call", event_id: "ev_dead" })];
      await bus.publish(batch);
      await bus.drain();

      expect(attempts).toBe(3);
      expect(onDeadLetter).toHaveBeenCalledTimes(1);
      expect(onDeadLetter.mock.calls[0]?.[0]).toEqual(batch);
      expect(onDeadLetter.mock.calls[0]?.[1]).toBeInstanceOf(Error);
    } finally {
      await bus.close();
    }
  });

  it("drain waits for a retry to succeed", async () => {
    const bus = createInprocBus({ maxAttempts: 3, retryDelayMs: 1 });
    const received: string[] = [];
    let attempts = 0;

    bus.subscribe(async (batch) => {
      attempts += 1;
      if (attempts < 3) throw new Error("not yet");
      received.push(...batch.map((event) => event.event_id));
    });

    try {
      await bus.publish([makeEvent({ kind: "session.start", event_id: "ev_retry" })]);
      await bus.drain();

      expect(attempts).toBe(3);
      expect(received).toEqual(["ev_retry"]);
    } finally {
      await bus.close();
    }
  });
});
