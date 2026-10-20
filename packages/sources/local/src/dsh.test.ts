import { describe, expect, it } from "vitest";
import path from "node:path";
import { readFileSync } from "node:fs";

import { normalizerContract } from "@openmatel/contract-tests";
import { sessionId, validateEvent } from "@openmatel/core";

import {
  decompressZstdFrames,
  discover as discoverDsh,
  dshNormalizer,
  normalizeFile as normalizeDshFile,
  readRecords as readDshRecords,
  splitZstdFrames,
} from "./dsh.js";
import { countOfKind, eventsOfKind, firstEventOfKind, makeTempHome } from "./test-support.js";

const temp = makeTempHome(["dsh"]);

const files = await discoverDsh(temp.home);
const file = files[0];
if (file === undefined) throw new Error("the dsh fixture was not found");
const records = await readDshRecords(file);
const events = normalizeDshFile(file, records);

normalizerContract("dsh normalizer", dshNormalizer, records);

describe("@openmatel/source-local — dsh", () => {
  it("finds the session file of the fixture", () => {
    expect(files).toHaveLength(1);
    expect(file.source).toBe("dsh");
    expect(file.sourceSessionId).toBe("44444444-4444-4444-8444-444444444444");
    expect(file.path).toContain(path.join(".dsh", "sessions"));
    expect(file.path).toMatch(/session\.v4\.jsonl\.zstd$/);
  });

  it("decodes the file, which is a series of zstd frames", () => {
    // dsh appends one frame per write, so the file holds many frames and
    // `zstdDecompressSync` on the whole buffer would only see the first one.
    const buffer = readFileSync(file.path);
    const frames = splitZstdFrames(buffer);
    expect(frames.length).toBeGreaterThan(1);

    const text = decompressZstdFrames(buffer);
    expect(text.split("\n").filter((line) => line.trim() !== "").length).toBe(120);
  });

  it("reads every record of the file", () => {
    expect(records).toHaveLength(120);
    expect(records[0].ref).toBe(`${file.path}#L1`);
    expect(records[0].line).toBe(1);
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
    expect(start?.session_id).toBe(sessionId("dsh", file.sourceSessionId));
    expect(start?.source.name).toBe("dsh");
    expect(start?.source.format).toBe("dsh.jsonl.zstd");
    expect((start?.attrs.harness as { name?: string } | undefined)?.name).toBe("dsh");
    expect((start?.attrs.harness as { version?: string } | undefined)?.version).toBe("4");
    expect(start?.attrs.cwd).toBe("/home/user/project");
    expect(start?.attrs.model).toBe("deepseek-flash");
    expect(typeof start?.attrs.title).toBe("string");
  });

  it("does not report the bookkeeping of the runtime as unknown", () => {
    // The delivery records of the log are noise, not an unknown format.
    expect(countOfKind(events, "raw.unknown")).toBe(0);
  });

  it("emits at least one tool call, with its result", () => {
    const calls = eventsOfKind(events, "tool.call");
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls.length).toBe(22);

    const names = calls.map((call) => call.attrs.tool_name);
    expect(names).toContain("bash");
    expect(names).toContain("read");

    const bash = calls.find((call) => call.attrs.tool_name === "bash");
    expect(bash?.attrs.tool_kind).toBe("execute");
    expect(bash?.content?.output?.text).toBeDefined();
    expect(bash?.end_ts).toBeDefined();
  });

  it("reports the plan of the agent", () => {
    const plans = eventsOfKind(events, "plan.update");
    expect(plans).toHaveLength(1);
    const entries = plans[0].attrs.entries as { content: string; status: string }[];
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(typeof entries[0].content).toBe("string");
    expect(typeof entries[0].status).toBe("string");
  });

  it("maps the token counters of the model, keeping a missing count missing", () => {
    const calls = eventsOfKind(events, "llm.call");
    expect(calls.length).toBeGreaterThanOrEqual(1);

    const usage = calls[0].usage;
    expect(usage?.source).toBe("harness");
    expect(usage?.input_tokens).toBe(5593);
    expect(usage?.output_tokens).toBe(64);
    expect(usage?.cache_read_tokens).toBe(5248);
    // dsh reported `cacheWriteTokens: 0` — a reported zero stays a zero.
    expect(usage?.cache_write_tokens).toBe(0);
    // dsh does not report the reasoning tokens at all: they stay `null`
    // instead of becoming a zero.
    expect(usage?.reasoning_tokens).toBeNull();
  });

  it("keeps the ids of the events unique and stable", () => {
    const ids = events.map((event) => event.event_id);
    expect(new Set(ids).size).toBe(ids.length);

    const again = normalizeDshFile(file, records);
    expect(again.map((event) => event.event_id)).toEqual(ids);
    expect(again).toEqual(events);
  });

  it("produces valid canonical events", () => {
    for (const event of events) {
      const result = validateEvent(event);
      expect(result.ok, result.ok ? "" : result.errors.join("; ")).toBe(true);
    }
  });
});
