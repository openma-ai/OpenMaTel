import { describe, expect, it } from "vitest";
import path from "node:path";

import { normalizerContract } from "@openmatel/contract-tests";
import { sessionId, validateEvent, type AgentEvent, type RawRecord } from "@openmatel/core";

import {
  discover as discoverPi,
  normalizeFile as normalizePiFile,
  piNormalizer,
  readRecords as readPiRecords,
} from "./pi.js";
import { describeFile } from "./common.js";
import { countOfKind, eventsOfKind, firstEventOfKind, makeTempHome } from "./test-support.js";

const temp = makeTempHome(["pi"]);

const files = await discoverPi(temp.home);
const file = files.find(
  (candidate) => candidate.sourceSessionId === "33333333-3333-4333-8333-333333333333",
);
if (file === undefined) throw new Error("the pi fixture was not found");

// The synthetic compaction fixture has a non-`.jsonl` suffix on purpose: it
// is a normalizer fixture, not a second session of the machine-wide CLI scan.
const compactionPath = path.join(
  temp.home,
  ".pi",
  "agent",
  "sessions",
  "--home-user-project--",
  "2026-10-20T09-00-00-000Z_55555555-5555-4555-8555-555555555555.jsonl.synthetic",
);
const compactionFile = await describeFile(
  "pi",
  compactionPath,
  "55555555-5555-4555-8555-555555555555",
);
if (compactionFile === null) throw new Error("the pi compaction fixture was not found");

const records = await readPiRecords(file);
const events = normalizePiFile(file, records);
const compactionRecords = await readPiRecords(compactionFile);
const compactionEvents = normalizePiFile(compactionFile, compactionRecords);

normalizerContract("pi normalizer", piNormalizer, records);
normalizerContract("pi normalizer (compaction fixture)", piNormalizer, compactionRecords);

const SOURCE_USAGE_FIELDS = [
  ["input", "input_tokens"],
  ["output", "output_tokens"],
  ["cacheRead", "cache_read_tokens"],
  ["cacheWrite", "cache_write_tokens"],
  ["reasoning", "reasoning_tokens"],
] as const;

/** Raw assistant usages, in file order. */
function rawAssistantUsages(rawRecords: RawRecord[]): Record<string, unknown>[] {
  const usages: Record<string, unknown>[] = [];
  for (const record of rawRecords) {
    const data = record.data;
    if (typeof data !== "object" || data === null || Array.isArray(data)) continue;
    const entry = data as Record<string, unknown>;
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (typeof message !== "object" || message === null || Array.isArray(message)) continue;
    const fields = message as Record<string, unknown>;
    if (fields.role !== "assistant") continue;
    const usage = fields.usage;
    usages.push(
      typeof usage === "object" && usage !== null && !Array.isArray(usage)
        ? (usage as Record<string, unknown>)
        : {},
    );
  }
  return usages;
}

/**
 * Every token field the raw assistant message did not report must be null,
 * never 0; a value it did report must be kept exactly (including 0).
 */
function expectMissingStaysNull(rawRecords: RawRecord[], normalized: AgentEvent[]): void {
  const rawUsages = rawAssistantUsages(rawRecords);
  const calls = eventsOfKind(normalized, "llm.call");
  expect(calls).toHaveLength(rawUsages.length);

  calls.forEach((call, index) => {
    const raw = rawUsages[index] ?? {};
    const usage = call.usage;
    expect(usage).toBeDefined();
    if (usage === undefined || usage === null) return;

    for (const [sourceField, usageField] of SOURCE_USAGE_FIELDS) {
      const sourceValue = raw[sourceField];
      if (typeof sourceValue === "number") {
        expect(usage[usageField], `${usageField} was reported`).toBe(sourceValue);
        continue;
      }
      expect(usage[usageField], `${usageField} was not reported`).toBeNull();
      expect(usage[usageField], `${usageField} must not become 0`).not.toBe(0);
    }
  });
}

describe("@openmatel/source-local — pi", () => {
  it("finds the session file of the fixture", () => {
    expect(files).toHaveLength(1);
    expect(file.source).toBe("pi");
    expect(file.sourceSessionId).toBe("33333333-3333-4333-8333-333333333333");
    expect(file.path).toContain(path.join(".pi", "agent", "sessions"));
    expect(file.path).toMatch(/\.jsonl$/);
    expect(compactionFile.path).toMatch(/\.jsonl\.synthetic$/);
  });

  it("reads every line of the files as records", () => {
    expect(records).toHaveLength(8);
    expect(records[0].ref).toBe(`${file.path}#L1`);
    expect(compactionRecords).toHaveLength(14);
    expect(compactionRecords[0].ref).toBe(`${compactionFile.path}#L1`);
  });

  it("produces one session with one turn", () => {
    expect(countOfKind(events, "session.start")).toBe(1);
    expect(countOfKind(events, "session.end")).toBe(1);
    expect(countOfKind(events, "turn.start")).toBe(1);
    expect(countOfKind(events, "turn.end")).toBe(1);
  });

  it("describes the session", () => {
    const start = firstEventOfKind(events, "session.start");
    expect(start?.project_id).toBe("local");
    expect(start?.session_id).toBe(sessionId("pi", file.sourceSessionId));
    expect(start?.source.name).toBe("pi");
    expect(start?.source.format).toBe("pi.jsonl");
    expect((start?.attrs.harness as { name?: string } | undefined)?.name).toBe("pi");
    expect((start?.attrs.harness as { version?: string } | undefined)?.version).toBe("3");
    expect(start?.attrs.cwd).toBe("/home/user/project");
    expect(start?.attrs.model).toBe("deepseek-v4-pro");
    expect(typeof start?.attrs.title).toBe("string");
  });

  it("emits the user message, the reasoning and the answer", () => {
    expect(eventsOfKind(events, "message.user")).toHaveLength(1);
    expect(eventsOfKind(events, "reasoning")).toHaveLength(1);
    expect(eventsOfKind(events, "message.agent")).toHaveLength(1);
  });

  it("emits at least one tool call, with its result", () => {
    const calls = eventsOfKind(events, "tool.call");
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls.length).toBe(1);

    const call = calls[0];
    expect(call.attrs.tool_name).toBe("bash");
    expect(call.attrs.tool_kind).toBe("execute");
    expect(call.content?.output?.text).toBeDefined();
    expect(call.end_ts).toBeDefined();
  });

  it("nests the shell command under the call", () => {
    const commands = eventsOfKind(events, "env.command");
    expect(commands).toHaveLength(1);
    expect(commands[0].attrs.command).toBe("redacted text");
    expect(commands[0].parent_step_id).toBeDefined();
  });

  it("maps the token counters of the model, keeping a reported zero a zero", () => {
    const calls = eventsOfKind(events, "llm.call");
    expect(calls.length).toBeGreaterThanOrEqual(1);

    const usage = calls[0].usage;
    expect(usage?.source).toBe("harness");
    expect(usage?.input_tokens).toBe(1416);
    expect(usage?.output_tokens).toBe(88);
    expect(usage?.cache_read_tokens).toBe(384);
    // pi reported `cacheWrite: 0` — a reported zero stays a zero.
    expect(usage?.cache_write_tokens).toBe(0);
    expect(usage?.reasoning_tokens).toBe(24);
    // pi knows the price of the call.
    expect(typeof usage?.cost_usd).toBe("number");
  });

  it("reports every llm.call field, with null for what pi does not expose", () => {
    const calls = eventsOfKind(events, "llm.call");
    expect(calls).toHaveLength(2);

    const first = calls[0];
    expect(first.segment_id).toBe("seg_0");
    expect(first.turn_id).toBeDefined();
    expect(first.attrs).toMatchObject({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      context_tokens: 1416 + 384 + 0,
      stop_reason: "toolUse",
      latency_ms: null,
      ttft_ms: null,
      request_id: "3a007498-d1b6-4240-991d-eed1e0691619",
      context_window: null,
      derived: [],
    });

    const second = calls[1];
    expect(second.segment_id).toBe("seg_0");
    expect(second.attrs.context_tokens).toBe(110 + 1792 + 0);
    expect(second.attrs.stop_reason).toBe("stop");
    expect(second.attrs.latency_ms).toBeNull();
    expect(second.attrs.ttft_ms).toBeNull();
    expect(second.attrs.request_id).toBe("f84e2cd9-4988-4009-8efd-5aec9d2de836");
    expect(second.attrs.context_window).toBeNull();
    expect(second.attrs.derived).toEqual([]);
  });

  it("emits exactly one llm.call per assistant message", () => {
    expect(eventsOfKind(events, "llm.call")).toHaveLength(2);
    expect(compactionEvents.filter((event) => event.kind === "llm.call")).toHaveLength(5);
  });

  it("starts a turn at each real user message and ends it when the agent yields", () => {
    expect(countOfKind(compactionEvents, "turn.start")).toBe(5);
    expect(countOfKind(compactionEvents, "turn.end")).toBe(5);

    const ends = eventsOfKind(compactionEvents, "turn.end");
    for (const end of ends) {
      expect(end.attrs.stop_reason).toBe("stop");
    }
    expect(new Set(ends.map((event) => event.turn_id)).size).toBe(5);

    const baseEnd = firstEventOfKind(events, "turn.end");
    expect(baseEnd?.attrs.stop_reason).toBe("stop");
  });

  it("opens compacted and forked segments with derived boundary numbers", () => {
    const boundaries = eventsOfKind(compactionEvents, "segment.boundary");
    expect(boundaries).toHaveLength(2);

    const [compaction, fork] = boundaries;
    expect(compaction.segment_id).toBe("seg_1");
    expect(compaction.attrs).toMatchObject({
      reason: "compaction",
      context_tokens_before: 160,
      context_tokens_after: 50,
      tokens_removed: 110,
      parent_segment_id: "seg_0",
      summary: "Synthetic summary of the first turn.",
      derived: true,
    });
    expect(compaction.content?.output?.text).toBe("Synthetic summary of the first turn.");
    expect(compaction.turn_id).toBeUndefined();

    expect(fork.segment_id).toBe("seg_2");
    expect(fork.attrs).toMatchObject({
      reason: "fork",
      context_tokens_before: 50,
      context_tokens_after: 10,
      tokens_removed: 40,
      parent_segment_id: "seg_1",
      summary: "Synthetic summary of the abandoned branch.",
      derived: true,
    });
    expect(fork.content?.output?.text).toBe("Synthetic summary of the abandoned branch.");

    const calls = eventsOfKind(compactionEvents, "llm.call");
    expect(calls.map((call) => call.segment_id)).toEqual([
      "seg_0",
      "seg_1",
      "seg_2",
      "seg_2",
      "seg_2",
    ]);
    expect(firstEventOfKind(compactionEvents, "session.start")?.segment_id).toBe("seg_0");
    expect(firstEventOfKind(compactionEvents, "session.end")?.segment_id).toBe("seg_2");
  });

  it("puts a segment_id on every event and does not turn missing numbers into zero", () => {
    for (const event of [...events, ...compactionEvents]) {
      expect(typeof event.segment_id).toBe("string");
      expect(event.segment_id.length).toBeGreaterThan(0);
    }

    expectMissingStaysNull(records, events);
    expectMissingStaysNull(compactionRecords, compactionEvents);

    const calls = eventsOfKind(compactionEvents, "llm.call");
    expect(calls[1]?.usage).toMatchObject({
      input_tokens: 30,
      output_tokens: 5,
      cache_read_tokens: 20,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      source: "harness",
    });
    expect(calls[2]?.usage).toMatchObject({
      input_tokens: 7,
      output_tokens: 1,
      cache_read_tokens: 3,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
    });
    expect(calls[3]?.usage).toMatchObject({
      input_tokens: 4,
      output_tokens: 1,
      cache_read_tokens: null,
      cache_write_tokens: null,
      reasoning_tokens: null,
    });
    expect(calls[3]?.attrs.context_tokens).toBeNull();
    expect(calls[4]?.usage).toMatchObject({
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_write_tokens: null,
      reasoning_tokens: null,
      source: "missing",
    });
    expect(calls[4]?.attrs.context_tokens).toBeNull();
  });

  it("keeps the ids of the events unique and stable", () => {
    for (const [sessionFile, sessionRecords, sessionEvents] of [
      [file, records, events],
      [compactionFile, compactionRecords, compactionEvents],
    ] as const) {
      const ids = sessionEvents.map((event) => event.event_id);
      expect(new Set(ids).size).toBe(ids.length);

      const again = normalizePiFile(sessionFile, sessionRecords);
      expect(again.map((event) => event.event_id)).toEqual(ids);
      expect(again).toEqual(sessionEvents);
    }
  });

  it("produces valid canonical events", () => {
    for (const event of [...events, ...compactionEvents]) {
      const result = validateEvent(event);
      expect(result.ok, result.ok ? "" : result.errors.join("; ")).toBe(true);
    }
  });
});
