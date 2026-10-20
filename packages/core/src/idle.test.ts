import { describe, expect, it } from "vitest";

import { DEFAULT_IDLE_THRESHOLD_MS, idleGaps } from "./idle.js";
import { SCHEMA_VERSION, type AgentEvent } from "./schema.js";

const event = (
  event_id: string,
  ts: string,
  end_ts?: string,
): AgentEvent => ({
  schema: SCHEMA_VERSION,
  event_id,
  project_id: "proj_1",
  session_id: "ss_1",
  segment_id: "seg_0",
  ts,
  ...(end_ts === undefined ? {} : { end_ts }),
  kind: "message.user",
  attrs: {},
  source: { name: "test", format: "json" },
});

describe("idleGaps", () => {
  it("returns the gaps that are strictly longer than the threshold", () => {
    const events = [
      event("ev_2", "2026-01-01T01:00:00.000Z"),
      event("ev_1", "2026-01-01T00:00:00.000Z", "2026-01-01T00:01:00.000Z"),
      event("ev_3", "2026-01-01T02:00:00.000Z", "2026-01-01T02:00:01.000Z"),
    ];

    expect(idleGaps(events)).toEqual([
      {
        after_event_id: "ev_1",
        before_event_id: "ev_2",
        start: "2026-01-01T00:01:00.000Z",
        end: "2026-01-01T01:00:00.000Z",
        duration_ms: 59 * 60 * 1000,
      },
      {
        after_event_id: "ev_2",
        before_event_id: "ev_3",
        start: "2026-01-01T01:00:00.000Z",
        end: "2026-01-01T02:00:00.000Z",
        duration_ms: 60 * 60 * 1000,
      },
    ]);
  });

  it("uses the end of a long event, not its start", () => {
    const events = [
      event("ev_1", "2026-01-01T00:00:00.000Z", "2026-01-01T00:50:00.000Z"),
      event("ev_2", "2026-01-01T01:30:00.000Z"),
    ];

    const [gap] = idleGaps(events);
    expect(gap?.start).toBe("2026-01-01T00:50:00.000Z");
    expect(gap?.duration_ms).toBe(40 * 60 * 1000);
  });

  it("does not report a gap at exactly the threshold or below it", () => {
    const atThreshold = [
      event("ev_1", "2026-01-01T00:00:00.000Z"),
      event("ev_2", "2026-01-01T00:30:00.000Z"),
    ];
    expect(idleGaps(atThreshold)).toEqual([]);

    const below = [
      event("ev_1", "2026-01-01T00:00:00.000Z"),
      event("ev_2", "2026-01-01T00:29:59.999Z"),
    ];
    expect(idleGaps(below)).toEqual([]);
  });

  it("honours a custom threshold and leaves a short stream alone", () => {
    const events = [
      event("ev_1", "2026-01-01T00:00:00.000Z"),
      event("ev_2", "2026-01-01T00:01:00.000Z"),
    ];
    expect(idleGaps(events, 30_000)).toHaveLength(1);
    expect(idleGaps([events[0]!])).toEqual([]);
    expect(DEFAULT_IDLE_THRESHOLD_MS).toBe(30 * 60 * 1000);
  });
});
