import { describe, expect, it } from "vitest";

import { SCHEMA_VERSION, validateEvent, type AgentEvent } from "./schema.js";

const validEvent = (): AgentEvent => ({
  schema: SCHEMA_VERSION,
  event_id: "ev_0123456789abcdef0123456789abcdef",
  project_id: "proj_1",
  session_id: "ss_0123456789abcdef0123456789abcdef",
  turn_id: "turn_1",
  step_id: "st_0123456789abcdef0123456789abcdef",
  ts: "2026-01-02T03:04:05.000Z",
  end_ts: "2026-01-02T03:04:06.000Z",
  kind: "tool.call",
  status: "ok",
  attrs: { tool_name: "read", tool_kind: "read", call_id: "call_1" },
  content: {
    capture: "truncated",
    input: { text: "read the file" },
    output: { text: "…", truncated: true, original_length: 4096 },
  },
  usage: {
    input_tokens: 10,
    output_tokens: 0,
    cache_read_tokens: null,
    cache_write_tokens: null,
    reasoning_tokens: null,
    source: "provider",
    cost_usd: 0.001,
    cost_source: "provider",
  },
  source: { name: "claude-code", version: "1", format: "jsonl", ref: "/tmp/a.jsonl:3" },
  links: { trace_id: "t1", span_id: "s1", external: { "openma.session_id": "sesn_1" } },
});

const errorsOf = (event: unknown): string[] => {
  const result = validateEvent(event);
  if (result.ok) return [];
  return result.errors;
};

describe("validateEvent", () => {
  it("accepts a complete event", () => {
    expect(validateEvent(validEvent())).toEqual({ ok: true });
  });

  it("accepts a minimal event", () => {
    const event = validEvent();
    delete event.turn_id;
    delete event.step_id;
    delete event.end_ts;
    delete event.status;
    delete event.content;
    delete event.usage;
    delete event.links;
    expect(validateEvent(event)).toEqual({ ok: true });
  });

  it("accepts an explicit null usage", () => {
    const event = validEvent();
    event.usage = null;
    expect(validateEvent(event)).toEqual({ ok: true });
  });

  it("rejects values that are not events", () => {
    expect(errorsOf(null)).toEqual(["event: must be an object"]);
    expect(errorsOf("nope")).toEqual(["event: must be an object"]);
    expect(errorsOf([])).toEqual(["event: must be an object"]);
  });

  it("rejects a foreign schema version", () => {
    const event = { ...validEvent(), schema: "oma.agentobs.v2" };
    expect(errorsOf(event)).toContain('schema: must be "oma.agentobs.v1"');
  });

  it("requires the identity fields", () => {
    const event = validEvent() as unknown as Record<string, unknown>;
    delete event.event_id;
    delete event.project_id;
    delete event.session_id;
    const errors = errorsOf(event);
    expect(errors).toContain("event_id: must be a non-empty string");
    expect(errors).toContain("project_id: must be a non-empty string");
    expect(errors).toContain("session_id: must be a non-empty string");
  });

  it("requires an ISO timestamp", () => {
    expect(errorsOf({ ...validEvent(), ts: "2026-01-02" })).toContain("ts: must be an ISO-8601 timestamp");
    expect(errorsOf({ ...validEvent(), ts: "not a date" })).toContain("ts: must be an ISO-8601 timestamp");
    expect(errorsOf({ ...validEvent(), end_ts: "yesterday" })).toContain(
      "end_ts: must be an ISO-8601 timestamp when present",
    );
  });

  it("rejects an unknown kind", () => {
    const errors = errorsOf({ ...validEvent(), kind: "tool.think" });
    expect(errors.some((error) => error.startsWith("kind: must be one of "))).toBe(true);
  });

  it("rejects an unknown status", () => {
    expect(errorsOf({ ...validEvent(), status: "fine" })).toContain(
      "status: must be one of ok, error, cancelled, interrupted, denied, timeout when present",
    );
  });

  it("requires attrs to be an object", () => {
    expect(errorsOf({ ...validEvent(), attrs: [] })).toContain("attrs: must be an object");
  });

  it("checks the error object", () => {
    const errors = errorsOf({ ...validEvent(), error: { type: "boom" } });
    expect(errors).toContain("error.message: must be a string");
  });

  it("checks the content capture level", () => {
    const errors = errorsOf({ ...validEvent(), content: { capture: "some" } });
    expect(errors).toContain("content.capture: must be one of full, truncated, redacted, none");
  });

  it("requires every usage token field to be present, a number or null", () => {
    const usage = { ...validEvent().usage } as Record<string, unknown>;
    delete usage.input_tokens;
    expect(errorsOf({ ...validEvent(), usage })).toContain("usage.input_tokens: must be present and be a number or null");

    const stringTokens = { ...validEvent().usage, input_tokens: "10" } as unknown;
    expect(errorsOf({ ...validEvent(), usage: stringTokens })).toContain("usage.input_tokens: must be a number or null");
  });

  it("keeps zero and null apart in usage", () => {
    const zero = { ...validEvent().usage, output_tokens: 0 } as AgentEvent["usage"];
    expect(validateEvent({ ...validEvent(), usage: zero })).toEqual({ ok: true });

    const nulls = { ...validEvent().usage, output_tokens: null } as AgentEvent["usage"];
    expect(validateEvent({ ...validEvent(), usage: nulls })).toEqual({ ok: true });
  });

  it("rejects an unknown usage source", () => {
    const usage = { ...validEvent().usage, source: "guess" };
    expect(errorsOf({ ...validEvent(), usage })).toContain(
      "usage.source: must be one of provider, harness, estimated, missing",
    );
  });

  it("requires the source descriptor", () => {
    const errors = errorsOf({ ...validEvent(), source: { name: "claude-code" } });
    expect(errors).toContain("source.format: must be a non-empty string");
  });

  it("checks external links", () => {
    const links = { external: { "openma.session_id": 42 } };
    expect(errorsOf({ ...validEvent(), links })).toContain("links.external.openma.session_id: must be a string");
  });

  it("reports every problem at once", () => {
    const errors = errorsOf({ ...validEvent(), kind: "nope", status: "nope", attrs: "nope" });
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });
});
