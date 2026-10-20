import { describe, expect, it } from "vitest";

import {
  hasRecentActivity,
  LIVE_WINDOW_MS,
  looksLive,
  sameSessionRevision,
  sessionRevision,
  shouldPoll,
  type RevisionSource,
} from "./live";

const NOW = Date.parse("2026-10-20T12:00:00.000Z");
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

const event = (event_id: string) => ({ event_id });

const detail = (
  events: string[],
  overrides: Partial<RevisionSource["summary"]> = {},
): RevisionSource => ({
  summary: {
    ended_at: events.length === 0 ? null : ago(1_000),
    status: "ok",
    ...overrides,
  },
  turns: [{ events: events.map(event) }],
});

describe("live session decision", () => {
  it("treats running and unknown sessions as live without a timestamp", () => {
    expect(looksLive({ status: "running", endedAt: null })).toBe(true);
    expect(looksLive({ status: "unknown", endedAt: null })).toBe(true);
    expect(
      looksLive({
        summary: { status: "ok", ended_at: ago(LIVE_WINDOW_MS - 1) },
        now: NOW,
      }),
    ).toBe(true);
  });

  it("keeps a finished session live for ten minutes after its last event", () => {
    expect(
      looksLive({ status: "ok", endedAt: ago(LIVE_WINDOW_MS - 1), now: NOW }),
    ).toBe(true);
    expect(
      looksLive({ status: "ok", endedAt: ago(LIVE_WINDOW_MS + 1), now: NOW }),
    ).toBe(false);
    expect(looksLive({ status: "ok", endedAt: null, now: NOW })).toBe(false);
    expect(looksLive({ status: "ok", endedAt: "not a date", now: NOW })).toBe(false);
  });

  it("does not poll while the document is hidden", () => {
    const base = {
      status: "running" as const,
      endedAt: null,
      now: NOW,
    };
    expect(shouldPoll({ ...base, visibilityState: "hidden" })).toBe(false);
    expect(shouldPoll({ ...base, visibilityState: "visible" })).toBe(true);
    expect(
      shouldPoll({
        status: "ok",
        endedAt: ago(LIVE_WINDOW_MS - 1),
        now: NOW,
        visibilityState: "visible",
      }),
    ).toBe(true);
  });

  it("uses the recency window for a custom window", () => {
    expect(hasRecentActivity(ago(500), NOW, 1_000)).toBe(true);
    expect(hasRecentActivity(ago(1_500), NOW, 1_000)).toBe(false);
  });
});

describe("session revision", () => {
  it("counts events and remembers the last event id", () => {
    expect(sessionRevision(detail(["ev_1", "ev_2"]))).toEqual({
      eventCount: 2,
      lastEventId: "ev_2",
      endedAt: ago(1_000),
      status: "ok",
    });
    expect(sessionRevision({ summary: { ended_at: null, status: "unknown" }, turns: [] }))
      .toEqual({
        eventCount: 0,
        lastEventId: null,
        endedAt: null,
        status: "unknown",
      });
  });

  it("detects new events and ignores an identical snapshot", () => {
    const before = sessionRevision(detail(["ev_1"]));
    expect(sameSessionRevision(before, sessionRevision(detail(["ev_1"])))).toBe(true);
    expect(sameSessionRevision(before, sessionRevision(detail(["ev_1", "ev_2"])))).toBe(
      false,
    );
  });

  it("treats a changed last event as a change", () => {
    const left = sessionRevision(detail(["ev_1", "ev_2"]));
    const right = sessionRevision(detail(["ev_1", "ev_3"]));
    expect(sameSessionRevision(left, right)).toBe(false);
  });
});
