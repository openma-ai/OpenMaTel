import { describe, expect, it } from "vitest";
import path from "node:path";

import { normalizerContract } from "@openmatel/contract-tests";
import { sessionId, validateEvent } from "@openmatel/core";

import {
  discover as discoverPi,
  normalizeFile as normalizePiFile,
  piNormalizer,
  readRecords as readPiRecords,
} from "./pi.js";
import { countOfKind, eventsOfKind, firstEventOfKind, makeTempHome } from "./test-support.js";

const temp = makeTempHome(["pi"]);

const files = await discoverPi(temp.home);
const file = files[0];
if (file === undefined) throw new Error("the pi fixture was not found");
const records = await readPiRecords(file);
const events = normalizePiFile(file, records);

normalizerContract("pi normalizer", piNormalizer, records);

describe("@openmatel/source-local — pi", () => {
  it("finds the session file of the fixture", () => {
    expect(files).toHaveLength(1);
    expect(file.source).toBe("pi");
    expect(file.sourceSessionId).toBe("33333333-3333-4333-8333-333333333333");
    expect(file.path).toContain(path.join(".pi", "agent", "sessions"));
    expect(file.path).toMatch(/\.jsonl$/);
  });

  it("reads every line of the file as a record", () => {
    expect(records).toHaveLength(8);
    expect(records[0].ref).toBe(`${file.path}#L1`);
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

  it("keeps the ids of the events unique and stable", () => {
    const ids = events.map((event) => event.event_id);
    expect(new Set(ids).size).toBe(ids.length);

    const again = normalizePiFile(file, records);
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
