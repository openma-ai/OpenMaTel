/**
 * Bus contract suite.
 *
 * The bus is the transport between the stages of the pipeline. Its delivery
 * semantics are **at-least-once**: a batch may be delivered more than once,
 * and a consumer that throws must see the batch again. That is why every
 * event carries a deterministic `event_id` and every sink is idempotent
 * (§3.1, §3.5).
 *
 * The suite checks:
 *
 * - **delivery** — every published event reaches the subscriber;
 * - **redelivery** — a batch whose subscriber threw is delivered again;
 * - **no ordering guarantee** — the suite never relies on the order of the
 *   batches, because the bus does not promise one.
 */

import { describe, expect, it } from "vitest";

import type { AgentEvent, Bus } from "@openmatel/core";

import { makeEvent } from "./fixtures.js";
import { waitUntil } from "./support.js";

/** How long the suite waits for a delivery before it gives up. */
const DELIVERY_TIMEOUT_MS = 3000;

/**
 * Register the Bus contract for one bus.
 *
 * @param name - name of the suite, usually the bus id.
 * @param factory - creates a **fresh** bus; it is called once per test.
 */
export function busContract(name: string, factory: () => Promise<Bus>): void {
  describe(name, () => {
    it("delivers every published event", async () => {
      const bus = await factory();
      const received: AgentEvent[] = [];

      const unsubscribe = bus.subscribe(async (batch) => {
        received.push(...batch);
      });

      try {
        const batches = sampleBatches();
        for (const batch of batches) await bus.publish(batch);

        await waitUntil(() => received.length >= 6, { timeoutMs: DELIVERY_TIMEOUT_MS });

        expect(new Set(received.map((event) => event.event_id))).toEqual(
          new Set(batches.flat().map((event) => event.event_id)),
        );
        expect(received.length).toBe(6);
      } finally {
        unsubscribe();
      }
    });

    it("redelivers a batch when the subscriber throws", async () => {
      const bus = await factory();

      let attempts = 0;
      let delivered: AgentEvent[] = [];

      const unsubscribe = bus.subscribe(async (batch) => {
        attempts += 1;
        if (attempts === 1) throw new Error("the consumer is broken");
        delivered = batch;
      });

      try {
        const batch = sampleBatches()[0];
        await bus.publish(batch);

        await waitUntil(() => delivered.length > 0, { timeoutMs: DELIVERY_TIMEOUT_MS });

        expect(attempts, "the failed batch must be delivered again").toBeGreaterThan(1);
        expect(new Set(delivered.map((event) => event.event_id))).toEqual(
          new Set(batch.map((event) => event.event_id)),
        );
      } finally {
        unsubscribe();
      }
    });

    it("does not depend on the order of the batches", async () => {
      const bus = await factory();
      const received: AgentEvent[] = [];

      const unsubscribe = bus.subscribe(async (batch) => {
        received.push(...batch);
      });

      try {
        const batches = sampleBatches();
        // Published back to front on purpose: the bus promises no order, so
        // the suite must not depend on one.
        for (const batch of [...batches].reverse()) await bus.publish(batch);

        await waitUntil(() => received.length >= 6, { timeoutMs: DELIVERY_TIMEOUT_MS });

        expect(new Set(received.map((event) => event.event_id))).toEqual(
          new Set(batches.flat().map((event) => event.event_id)),
        );
      } finally {
        unsubscribe();
      }
    });
  });
}

/** Three batches of two events, with stable ids. */
const sampleBatches = (): AgentEvent[][] => [
  [
    makeEvent({ event_id: "ev_bus_1", kind: "message.user", session_id: "ss_bus" }),
    makeEvent({ event_id: "ev_bus_2", kind: "message.agent", session_id: "ss_bus" }),
  ],
  [
    makeEvent({ event_id: "ev_bus_3", kind: "tool.call", session_id: "ss_bus" }),
    makeEvent({ event_id: "ev_bus_4", kind: "tool.call", session_id: "ss_bus" }),
  ],
  [
    makeEvent({ event_id: "ev_bus_5", kind: "llm.call", session_id: "ss_bus" }),
    makeEvent({ event_id: "ev_bus_6", kind: "session.end", session_id: "ss_bus" }),
  ],
];
