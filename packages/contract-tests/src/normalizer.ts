/**
 * Normalizer contract suite.
 *
 * A normalizer turns the raw records of one source into canonical agent
 * events. The suite pins down the four properties the pipeline relies on:
 *
 * - **validity** — every event it produces passes `validateEvent`, so a
 *   store never has to deal with a malformed row;
 * - **determinism** — the same record always yields the same `event_id` and
 *   the same event, which is what makes the sink idempotent and the pipeline
 *   safe to replay;
 * - **uniqueness** — two *different* events never share an `event_id`;
 * - **robustness** — an unknown or garbage record never throws; it is either
 *   dropped or kept as a `raw.unknown` event.
 *
 * On top of that the suite checks the "missing is not zero" rule of §4.5:
 * inside a usage object every token field is a number or `null`, never
 * `undefined`.
 */

import { describe, expect, it } from "vitest";

import {
  USAGE_SOURCES,
  USAGE_TOKEN_FIELDS,
  validateEvent,
  type AgentEvent,
  type Normalizer,
  type RawRecord,
} from "@openmatel/core";

/**
 * Register the Normalizer contract for one normalizer.
 *
 * @param name - name of the suite, usually `<source> <version>`.
 * @param normalizer - the normalizer under test.
 * @param fixtures - the raw records the normalizer has to handle.
 */
export function normalizerContract(
  name: string,
  normalizer: Normalizer,
  fixtures: RawRecord[],
): void {
  describe(name, () => {
    it("describes itself", () => {
      expect(typeof normalizer.schema?.source).toBe("string");
      expect(normalizer.schema.source.length).toBeGreaterThan(0);
      expect(typeof normalizer.schema?.version).toBe("string");
      expect(normalizer.schema.version.length).toBeGreaterThan(0);
      expect(() => normalizer.accepts(fixtures[0] as RawRecord)).not.toThrow();
    });

    it("produces valid canonical events", () => {
      for (const raw of fixtures) {
        const events = normalizeSafely(normalizer, raw);
        for (const event of events) {
          const result = validateEvent(event);
          expect(
            result.ok,
            result.ok ? "" : `invalid event ${event?.event_id}: ${result.errors.join("; ")}`,
          ).toBe(true);
        }
      }
    });

    it("is deterministic", () => {
      for (const raw of fixtures) {
        const first = normalizeSafely(normalizer, raw);
        const second = normalizeSafely(normalizer, raw);

        expect(second.map((event) => event.event_id)).toEqual(
          first.map((event) => event.event_id),
        );
        expect(second).toEqual(first);
      }
    });

    it("never gives two different events the same id", () => {
      const byId = new Map<string, AgentEvent[]>();

      for (const raw of fixtures) {
        for (const event of normalizeSafely(normalizer, raw)) {
          const known = byId.get(event.event_id) ?? [];
          known.push(event);
          byId.set(event.event_id, known);
        }
      }

      for (const [event_id, events] of byId) {
        const first = events[0];
        for (const event of events) {
          expect(
            event,
            `event id "${event_id}" is used by two different events`,
          ).toEqual(first);
        }
      }
    });

    it("never throws on an unknown or garbage record", () => {
      const garbage: RawRecord[] = [
        { source: normalizer.schema.source, ref: "contract:unknown", data: { type: "zzz_unknown" } },
        { source: normalizer.schema.source, ref: "contract:empty", data: {} },
        { source: normalizer.schema.source, ref: "contract:null", data: null },
        { source: normalizer.schema.source, ref: "contract:string", data: "not an object" },
        { source: normalizer.schema.source, ref: "contract:number", data: 42 },
      ];

      for (const raw of garbage) {
        const events = normalizeSafely(normalizer, raw);

        expect(
          events.length,
          "a garbage record is dropped or kept as a single raw.unknown event",
        ).toBeLessThanOrEqual(1);

        for (const event of events) {
          expect(event.kind).toBe("raw.unknown");
          const result = validateEvent(event);
          expect(result.ok, result.ok ? "" : result.errors.join("; ")).toBe(true);
        }
      }
    });

    it("never writes an undefined usage field", () => {
      for (const raw of fixtures) {
        for (const event of normalizeSafely(normalizer, raw)) {
          const usage = event.usage;
          if (usage === undefined || usage === null) continue;

          for (const field of USAGE_TOKEN_FIELDS) {
            const value = usage[field];
            expect(
              value === null || (typeof value === "number" && Number.isFinite(value)),
              `usage.${field} must be a number or null, got ${String(value)}`,
            ).toBe(true);
          }

          expect(USAGE_SOURCES).toContain(usage.source);
        }
      }
    });
  });
}

/**
 * Normalize a record and make sure the normalizer does not throw.
 *
 * A normalizer that throws is a broken normalizer, but the failure is much
 * easier to read when it is reported per record.
 */
const normalizeSafely = (normalizer: Normalizer, raw: RawRecord): AgentEvent[] => {
  let events: AgentEvent[];
  try {
    events = normalizer.normalize(raw);
  } catch (error) {
    throw new Error(
      `the normalizer threw on ${JSON.stringify(raw?.data)?.slice(0, 200)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  expect(Array.isArray(events), "normalize must return an array of events").toBe(true);
  return events ?? [];
};
