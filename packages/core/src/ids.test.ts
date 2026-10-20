import { describe, expect, it } from "vitest";

import { eventId, sessionId, stepId } from "./ids.js";

describe("eventId", () => {
  it("is deterministic", () => {
    const parts = ["claude-code", "session-1", 42];
    expect(eventId(parts)).toBe(eventId(["claude-code", "session-1", 42]));
  });

  it("is prefixed and 32 hex characters long", () => {
    expect(eventId(["a"])).toMatch(/^ev_[0-9a-f]{32}$/);
  });

  it("changes when a part changes", () => {
    expect(eventId(["a", 1])).not.toBe(eventId(["a", 2]));
    expect(eventId(["a", "b"])).not.toBe(eventId(["b", "a"]));
  });

  it("keeps part boundaries, so joined parts cannot collide", () => {
    expect(eventId(["a", "b"])).not.toBe(eventId(["ab"]));
  });

  it("treats a number and its decimal string as the same part", () => {
    expect(eventId([1, 2])).toBe(eventId(["1", "2"]));
  });
});

describe("sessionId", () => {
  it("is deterministic and prefixed", () => {
    expect(sessionId("claude-code", "s1")).toBe(sessionId("claude-code", "s1"));
    expect(sessionId("claude-code", "s1")).toMatch(/^ss_[0-9a-f]{32}$/);
  });

  it("differs per source and per source session", () => {
    expect(sessionId("claude-code", "s1")).not.toBe(sessionId("codex", "s1"));
    expect(sessionId("claude-code", "s1")).not.toBe(sessionId("claude-code", "s2"));
  });
});

describe("stepId", () => {
  it("is deterministic and prefixed", () => {
    expect(stepId(["claude-code", "s1", 7])).toBe(stepId(["claude-code", "s1", 7]));
    expect(stepId(["claude-code", "s1", 7])).toMatch(/^st_[0-9a-f]{32}$/);
  });

  it("differs per step", () => {
    expect(stepId(["claude-code", "s1", 7])).not.toBe(stepId(["claude-code", "s1", 8]));
  });
});
