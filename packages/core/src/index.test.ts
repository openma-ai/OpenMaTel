import { describe, expect, it } from "vitest";

import * as core from "./index.js";

describe("@openmatel/core", () => {
  it("re-exports the schema", () => {
    expect(core.SCHEMA_VERSION).toBe("oma.agentobs.v1");
    expect(core.EVENT_KINDS).toHaveLength(28);
    expect(core.EVENT_KINDS).toContain("tool.call");
    expect(core.EVENT_KINDS).toContain("segment.boundary");
    expect(core.FIRST_SEGMENT_ID).toBe("seg_0");
    expect(core.STEP_STATUSES).toContain("error");
  });

  it("re-exports the id helpers", () => {
    expect(core.eventId(["a"])).toMatch(/^ev_[0-9a-f]{32}$/);
    expect(core.sessionId("a", "b")).toMatch(/^ss_[0-9a-f]{32}$/);
    expect(core.stepId(["a"])).toMatch(/^st_[0-9a-f]{32}$/);
  });

  it("re-exports the usage helpers", () => {
    expect(core.emptyUsage().source).toBe("missing");
    expect(core.sumUsage([]).coverage).toBeNull();
  });

  it("re-exports the tree helpers", () => {
    expect(core.SYNTHETIC_TURN_ID).toBe("turn_0");
    expect(core.buildSessionTree([]).turns).toEqual([]);
    expect(core.buildSessionTree([]).segments).toEqual([]);
    expect(core.summarizeSession([]).session_id).toBe("");
  });

  it("re-exports the llm, signal and idle helpers", () => {
    expect(core.contextTokens(core.emptyUsage())).toBeNull();
    expect(core.llmCallSeries([])).toEqual([]);
    expect(core.detectSignals([])).toEqual([]);
    expect(core.idleGaps([])).toEqual([]);
    expect(core.DEFAULT_IDLE_THRESHOLD_MS).toBe(30 * 60 * 1000);
  });

  it("re-exports the validator", () => {
    expect(core.validateEvent({}).ok).toBe(false);
  });
});
