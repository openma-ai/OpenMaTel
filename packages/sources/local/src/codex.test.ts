import { describe, expect, it } from "vitest";
import path from "node:path";

import { normalizerContract } from "@openmatel/contract-tests";
import { sessionId, validateEvent } from "@openmatel/core";

import {
  codexNormalizer,
  discover as discoverCodex,
  normalizeFile as normalizeCodexFile,
  readRecords as readCodexRecords,
} from "./codex.js";
import { countOfKind, eventsOfKind, firstEventOfKind, makeTempHome } from "./test-support.js";

const temp = makeTempHome(["codex"]);

const files = await discoverCodex(temp.home);
const file = files[0];
if (file === undefined) throw new Error("the Codex fixture was not found");
const records = await readCodexRecords(file);
const events = normalizeCodexFile(file, records);

normalizerContract("codex normalizer", codexNormalizer, records);

describe("@openmatel/source-local — Codex", () => {
  it("finds the session file of the fixture", () => {
    expect(files).toHaveLength(1);
    expect(file.source).toBe("codex");
    expect(file.sourceSessionId).toBe("22222222-2222-4222-8222-222222222222");
    expect(file.path).toContain(path.join(".codex", "sessions"));
    expect(file.path).toMatch(/rollout-.*\.jsonl$/);
  });

  it("reads every line of the file as a record", () => {
    expect(records).toHaveLength(80);
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
    expect(start?.session_id).toBe(sessionId("codex", file.sourceSessionId));
    expect(start?.source.name).toBe("codex");
    expect(start?.source.format).toBe("codex.jsonl");
    expect((start?.attrs.harness as { name?: string } | undefined)?.name).toBe("codex");
    expect((start?.attrs.harness as { version?: string } | undefined)?.version).toBe("0.162.1");
    expect(start?.attrs.cwd).toBe("/home/user/project");
    expect(start?.attrs.model).toBe("gpt-6.1-sol");
    expect((start?.attrs.git as { branch?: string } | undefined)?.branch).toBeDefined();
  });

  it("emits the user message once, not twice", () => {
    // Codex writes the prompt twice: as a response item and as the item of
    // the UI. The normalizer has to report it once.
    const users = eventsOfKind(events, "message.user");
    expect(users).toHaveLength(1);
    expect(users[0].content?.input?.text).toBe("redacted text");
  });

  it("emits at least one tool call, with its result", () => {
    const calls = eventsOfKind(events, "tool.call");
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls.length).toBe(11);

    for (const call of calls) {
      expect(call.attrs.tool_name).toBe("exec");
      expect(call.attrs.tool_kind).toBe("execute");
      expect(call.content?.output?.text).toBeDefined();
      expect(call.end_ts).toBeDefined();
    }
  });

  it("maps the token counters of the model, keeping a reported zero a zero", () => {
    const calls = eventsOfKind(events, "llm.call");
    expect(calls.length).toBeGreaterThanOrEqual(1);

    const usage = calls[0].usage;
    expect(usage?.source).toBe("harness");
    expect(usage?.input_tokens).toBe(15274);
    expect(usage?.output_tokens).toBe(124);
    expect(usage?.cache_read_tokens).toBe(12288);
    // Codex reported `cache_write_input_tokens: 0` — a reported zero stays a
    // zero and never becomes `null`.
    expect(usage?.cache_write_tokens).toBe(0);
    expect(usage?.reasoning_tokens).toBe(0);
  });

  it("keeps the ids of the events unique and stable", () => {
    const ids = events.map((event) => event.event_id);
    expect(new Set(ids).size).toBe(ids.length);

    const again = normalizeCodexFile(file, records);
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
