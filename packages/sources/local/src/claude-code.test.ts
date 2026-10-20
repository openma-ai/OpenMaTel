import { describe, expect, it } from "vitest";
import path from "node:path";

import { normalizerContract } from "@openmatel/contract-tests";
import { sessionId, validateEvent, type RawRecord } from "@openmatel/core";

import {
  claudeCodeNormalizer,
  discover as discoverClaudeCode,
  normalizeFile as normalizeClaudeCodeFile,
  readRecords as readClaudeCodeRecords,
} from "./claude-code.js";
import {
  countOfKind,
  eventsOfKind,
  firstEventOfKind,
  makeTempHome,
  type SessionFile,
} from "./test-support.js";

const temp = makeTempHome(["claude-code"]);

const files = await discoverClaudeCode(temp.home);
const file = files.find(
  (candidate) => candidate.sourceSessionId === "11111111-1111-4111-8111-111111111111",
);
if (file === undefined) throw new Error("the Claude Code fixture was not found");
const records = await readClaudeCodeRecords(file);
const events = normalizeClaudeCodeFile(file, records);

// The compaction fixture is not a normal session file (the `.fixture`
// suffix keeps discovery from counting it as a second session of the source),
// but it is read and normalized exactly like one.
const compactionFile: SessionFile = {
  source: "claude-code",
  path: path.join(
    path.dirname(file.path),
    "99999999-9999-4999-8999-999999999999.jsonl.fixture",
  ),
  size: 0,
  mtimeMs: 0,
  sourceSessionId: "99999999-9999-4999-8999-999999999999",
};
const compactionRecords = await readClaudeCodeRecords(compactionFile);
const compactionEvents = normalizeClaudeCodeFile(compactionFile, compactionRecords);

normalizerContract("claude-code normalizer", claudeCodeNormalizer, records);

describe("@openmatel/source-local — Claude Code", () => {
  it("finds the session file of the fixture", () => {
    expect(files).toHaveLength(1);
    expect(file.source).toBe("claude-code");
    expect(file.sourceSessionId).toBe("11111111-1111-4111-8111-111111111111");
    expect(file.path).toContain(path.join(".claude", "projects"));
    expect(file.size).toBeGreaterThan(0);
    expect(file.mtimeMs).toBeGreaterThan(0);
  });

  it("reads every line of the file as a record", () => {
    expect(records).toHaveLength(80);
    expect(records[0].ref).toBe(`${file.path}#L1`);
    expect(records[0].line).toBe(1);
    expect(records[0].source).toBe("claude-code");
  });

  it("produces one session with one turn", () => {
    expect(countOfKind(events, "session.start")).toBe(1);
    expect(countOfKind(events, "session.end")).toBe(1);
    expect(countOfKind(events, "turn.start")).toBe(1);
    expect(countOfKind(events, "turn.end")).toBe(1);
  });

  it("closes the session at the last record, not at the file mtime", () => {
    // A later touch of the file must not fabricate an idle gap before the end.
    const touched = normalizeClaudeCodeFile(
      { ...file, mtimeMs: Date.parse("2027-01-01T00:00:00.000Z") },
      records,
    );
    const lastRecordTs = "2026-10-18T13:03:26.521Z";
    expect(firstEventOfKind(touched, "session.end")?.ts).toBe(lastRecordTs);
    expect(firstEventOfKind(touched, "turn.end")?.ts).toBe(lastRecordTs);
  });

  it("describes the session", () => {
    const start = firstEventOfKind(events, "session.start");
    expect(start).toBeDefined();
    expect(start?.project_id).toBe("local");
    expect(start?.session_id).toBe(sessionId("claude-code", file.sourceSessionId));
    expect(start?.source.name).toBe("claude-code");
    expect(start?.source.format).toBe("claude-code.jsonl");
    expect(start?.source.ref).toContain("#L");
    expect((start?.attrs.harness as { name?: string } | undefined)?.name).toBe("claude-code");
    expect((start?.attrs.harness as { version?: string } | undefined)?.version).toBe("2.1.302");
    expect(start?.attrs.cwd).toBe("/home/user/project");
    expect((start?.attrs.git as { branch?: string } | undefined)?.branch).toBe(
      "fix/presence-heartbeat-idle",
    );
    expect(start?.attrs.model).toBe("claude-opus-5-5");
    expect(typeof start?.attrs.title).toBe("string");
  });

  it("emits the user message and the answer of the agent", () => {
    const user = firstEventOfKind(events, "message.user");
    expect(user).toBeDefined();
    expect(user?.content?.input?.text).toBe("redacted text");

    const agent = firstEventOfKind(events, "message.agent");
    expect(agent).toBeDefined();
    expect(typeof agent?.content?.output?.text).toBe("string");
  });

  it("emits at least one tool call, with its result", () => {
    const calls = eventsOfKind(events, "tool.call");
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls.length).toBe(12);

    // Every call that got a result carries the output of that result.
    const withResult = calls.filter((call) => call.end_ts !== undefined);
    expect(withResult.length).toBeGreaterThanOrEqual(1);
    for (const call of withResult) {
      expect(call.content?.output?.text).toBeDefined();
    }
  });

  it("names the tool and guesses its kind", () => {
    const calls = eventsOfKind(events, "tool.call");
    const names = calls.map((call) => call.attrs.tool_name);
    expect(names).toContain("Bash");
    expect(names).toContain("Read");
    expect(names).toContain("Edit");

    const kindOf = (name: string): string | undefined =>
      calls.find((call) => call.attrs.tool_name === name)?.attrs.tool_kind as string | undefined;

    expect(kindOf("Bash")).toBe("execute");
    expect(kindOf("Read")).toBe("read");
    expect(kindOf("Edit")).toBe("edit");
  });

  it("nests the shell command and the file edits under the call", () => {
    const commands = eventsOfKind(events, "env.command");
    expect(commands.length).toBe(3);
    for (const command of commands) {
      expect(typeof command.attrs.command).toBe("string");
      expect(command.parent_step_id).toBeDefined();
    }

    const edits = eventsOfKind(events, "env.file_edit");
    expect(edits.length).toBe(5);
    for (const edit of edits) {
      expect(typeof edit.attrs.path).toBe("string");
      expect(["create", "modify", "delete"]).toContain(edit.attrs.op);
      expect(edit.parent_step_id).toBeDefined();
    }
  });

  it("maps the token counters of the model, keeping a reported zero a zero", () => {
    const calls = eventsOfKind(events, "llm.call");
    expect(calls.length).toBeGreaterThanOrEqual(1);

    const usage = calls[0].usage;
    expect(usage?.source).toBe("provider");
    expect(usage?.input_tokens).toBe(2);
    expect(usage?.output_tokens).toBe(215);
    expect(usage?.cache_read_tokens).toBe(10420);
    expect(usage?.cache_write_tokens).toBe(20746);
    // The harness reported `thinking_tokens: 0` — a reported zero stays a
    // zero and never becomes `null`.
    expect(usage?.reasoning_tokens).toBe(0);
  });

  it("emits exactly one llm.call per model response and describes it", () => {
    const calls = eventsOfKind(events, "llm.call");
    // The fixture has six distinct requestIds; the assistant records of one
    // streamed response share message.id and requestId and are one call.
    expect(calls).toHaveLength(6);
    expect(new Set(calls.map((call) => call.attrs.request_id)).size).toBe(6);

    const first = calls[0];
    expect(first.attrs).toMatchObject({
      provider: "anthropic",
      model: "claude-opus-5-5",
      context_tokens: 31168,
      stop_reason: "tool_use",
      latency_ms: 4750,
      ttft_ms: null,
      request_id: "req_011Cg9kHaopeX3fHZNpzZwGa",
      context_window: null,
      derived: ["latency_ms"],
    });
    expect(first.usage?.input_tokens).toBe(2);
    expect(first.usage?.cache_read_tokens).toBe(10420);
    expect(first.usage?.cache_write_tokens).toBe(20746);
    // context_tokens = uncached input + cache read + cache write.
    expect(first.attrs.context_tokens).toBe(2 + 10420 + 20746);

    // Each required key is present even when the source did not report it.
    for (const call of calls) {
      for (const key of [
        "provider",
        "model",
        "context_tokens",
        "stop_reason",
        "latency_ms",
        "ttft_ms",
        "request_id",
        "context_window",
        "derived",
      ]) {
        expect(Object.prototype.hasOwnProperty.call(call.attrs, key), key).toBe(true);
      }
      expect(call.segment_id).toMatch(/^seg_/);
      expect(call.turn_id).toBeDefined();
      expect(Array.isArray(call.attrs.derived)).toBe(true);
    }
  });

  it("takes the final usage of the records that share one requestId", () => {
    const calls = eventsOfKind(events, "llm.call");
    const streamed = calls.filter(
      (call) => call.attrs.request_id === "req_011Cg9kHwwJYnErWqj1dzkWK",
    );
    expect(streamed).toHaveLength(1);
    expect(streamed[0].usage?.output_tokens).toBe(333);
    expect(streamed[0].usage?.input_tokens).toBe(2);
    expect(streamed[0].end_ts).toBe("2026-10-18T13:02:25.886Z");
    expect(streamed[0].attrs.latency_ms).toBe(4489);
  });

  it("marks latency as derived and leaves TTFT and the context window unknown", () => {
    const call = eventsOfKind(events, "llm.call")[0];
    expect(call.attrs.latency_ms).toBe(4750);
    expect((call.attrs.derived as string[]).includes("latency_ms")).toBe(true);
    expect(call.attrs.ttft_ms).toBeNull();
    expect(call.attrs.context_window).toBeNull();
  });

  it("keeps the ids of the events unique and stable", () => {
    const ids = events.map((event) => event.event_id);
    expect(new Set(ids).size).toBe(ids.length);

    const again = normalizeClaudeCodeFile(file, records);
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

describe("@openmatel/source-local — Claude Code compaction", () => {
  it("maps a compact_boundary and its summary to one segment.boundary", () => {
    const boundaries = eventsOfKind(compactionEvents, "segment.boundary");
    expect(boundaries).toHaveLength(1);

    const boundary = boundaries[0];
    expect(boundary.segment_id).toBe("seg_1");
    expect(boundary.attrs).toMatchObject({
      reason: "compaction",
      context_tokens_before: 130,
      context_tokens_after: 10,
      tokens_removed: 120,
      parent_segment_id: "seg_0",
      derived: true,
      summary: "Synthetic summary of the earlier conversation.",
    });
    expect(boundary.content?.capture).toBe("full");
    expect(boundary.content?.output?.text).toBe(
      "Synthetic summary of the earlier conversation.",
    );

    // The first call opens seg_0; the first call after the boundary opens
    // seg_1 and supplies context_tokens_after.
    const calls = eventsOfKind(compactionEvents, "llm.call");
    expect(calls.map((call) => call.attrs.context_tokens)).toEqual([130, 10]);
    expect(calls.map((call) => call.segment_id)).toEqual(["seg_0", "seg_1"]);

    // The summary record is not a user turn.
    expect(countOfKind(compactionEvents, "turn.start")).toBe(1);
    expect(countOfKind(compactionEvents, "message.user")).toBe(1);

    for (const event of compactionEvents) {
      const result = validateEvent(event);
      expect(result.ok, result.ok ? "" : result.errors.join("; ")).toBe(true);
    }
  });
});

describe("@openmatel/source-local — Claude Code missing usage", () => {
  const file = (name: string): SessionFile => ({
    source: "claude-code",
    path: `/tmp/${name}.jsonl`,
    size: 0,
    mtimeMs: 0,
    sourceSessionId: name,
  });

  const assistant = (line: number, usage?: Record<string, unknown>): RawRecord => ({
    source: "claude-code",
    ref: `/tmp/missing.jsonl#L${line}`,
    line,
    data: {
      type: "assistant",
      uuid: `a${line}`,
      timestamp: `2026-10-19T10:00:0${line}.000Z`,
      message: {
        id: `msg-${line}`,
        role: "assistant",
        model: "claude-opus-5-5",
        content: [{ type: "text", text: `reply-${line}` }],
        stop_reason: "end_turn",
        ...(usage === undefined ? {} : { usage }),
      },
    },
  });

  it("never writes 0 for a token count the source did not report", () => {
    const events = normalizeClaudeCodeFile(file("missing"), [
      assistant(1, { output_tokens: 7 }),
      assistant(2),
    ]);
    const calls = eventsOfKind(events, "llm.call");
    expect(calls).toHaveLength(2);

    const partial = calls[0].usage;
    expect(partial).toMatchObject({
      input_tokens: null,
      output_tokens: 7,
      cache_read_tokens: null,
      cache_write_tokens: null,
      reasoning_tokens: null,
      source: "provider",
    });
    // The cache buckets are unknown, so the full context size is unknown too.
    expect(calls[0].attrs.context_tokens).toBeNull();

    const missing = calls[1].usage;
    expect(missing?.source).toBe("missing");
    for (const field of [
      "input_tokens",
      "output_tokens",
      "cache_read_tokens",
      "cache_write_tokens",
      "reasoning_tokens",
    ] as const) {
      expect(missing?.[field]).toBeNull();
    }
    expect(calls[1].attrs.context_tokens).toBeNull();
  });
});

describe("@openmatel/source-local — Claude Code resume", () => {
  const file = (name: string): SessionFile => ({
    source: "claude-code",
    path: `/tmp/${name}.jsonl`,
    size: 0,
    mtimeMs: 0,
    sourceSessionId: name,
  });

  it("opens a resume boundary when the sessionId changes in one file", () => {
    const records: RawRecord[] = [
      {
        source: "claude-code",
        ref: "/tmp/resume.jsonl#L1",
        line: 1,
        data: {
          type: "user",
          uuid: "u1",
          timestamp: "2026-10-19T10:00:00.000Z",
          sessionId: "session-a",
          message: { role: "user", content: "first" },
        },
      },
      {
        source: "claude-code",
        ref: "/tmp/resume.jsonl#L2",
        line: 2,
        data: {
          type: "assistant",
          uuid: "a1",
          parentUuid: "u1",
          timestamp: "2026-10-19T10:00:01.000Z",
          sessionId: "session-a",
          requestId: "req-a",
          message: {
            id: "msg-a",
            role: "assistant",
            model: "claude-opus-5-5",
            content: [{ type: "text", text: "first answer" }],
            stop_reason: "end_turn",
            usage: {
              input_tokens: 10,
              cache_creation_input_tokens: 30,
              cache_read_input_tokens: 20,
              output_tokens: 5,
            },
          },
        },
      },
      {
        source: "claude-code",
        ref: "/tmp/resume.jsonl#L3",
        line: 3,
        data: {
          type: "user",
          uuid: "u2",
          parentUuid: "a1",
          timestamp: "2026-10-19T10:01:00.000Z",
          sessionId: "session-b",
          message: { role: "user", content: "continue" },
        },
      },
      {
        source: "claude-code",
        ref: "/tmp/resume.jsonl#L4",
        line: 4,
        data: {
          type: "assistant",
          uuid: "a2",
          parentUuid: "u2",
          timestamp: "2026-10-19T10:01:01.000Z",
          sessionId: "session-b",
          requestId: "req-b",
          message: {
            id: "msg-b",
            role: "assistant",
            model: "claude-opus-5-5",
            content: [{ type: "text", text: "continued" }],
            stop_reason: "end_turn",
            usage: {
              input_tokens: 5,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 5,
              output_tokens: 2,
            },
          },
        },
      },
    ];

    const events = normalizeClaudeCodeFile(
      { ...file("resume"), sourceSessionId: "session-a" },
      records,
    );
    const boundaries = eventsOfKind(events, "segment.boundary");
    expect(boundaries).toHaveLength(1);
    expect(boundaries[0].attrs).toMatchObject({
      reason: "resume",
      context_tokens_before: 60,
      context_tokens_after: 10,
      tokens_removed: 50,
      parent_segment_id: "seg_0",
      derived: true,
    });
    expect(countOfKind(events, "turn.start")).toBe(2);
  });

  it("infers a resume from a leafUuid that points outside the file", () => {
    const records: RawRecord[] = [
      {
        source: "claude-code",
        ref: "/tmp/resume-chain.jsonl#L1",
        line: 1,
        data: {
          type: "last-prompt",
          sessionId: "resume-chain",
          leafUuid: "old-leaf",
          timestamp: "2026-10-19T10:00:00.000Z",
        },
      },
      {
        source: "claude-code",
        ref: "/tmp/resume-chain.jsonl#L2",
        line: 2,
        data: {
          type: "user",
          uuid: "u1",
          parentUuid: "old-leaf",
          timestamp: "2026-10-19T10:00:01.000Z",
          sessionId: "resume-chain",
          message: { role: "user", content: "after resume" },
        },
      },
      {
        source: "claude-code",
        ref: "/tmp/resume-chain.jsonl#L3",
        line: 3,
        data: {
          type: "assistant",
          uuid: "a1",
          parentUuid: "u1",
          timestamp: "2026-10-19T10:00:02.000Z",
          sessionId: "resume-chain",
          requestId: "req-chain",
          message: {
            id: "msg-chain",
            role: "assistant",
            model: "claude-opus-5-5",
            content: [{ type: "text", text: "loaded" }],
            stop_reason: "end_turn",
            usage: {
              input_tokens: 4,
              cache_creation_input_tokens: 6,
              cache_read_input_tokens: 20,
              output_tokens: 3,
            },
          },
        },
      },
    ];

    const events = normalizeClaudeCodeFile(file("resume-chain"), records);
    const boundaries = eventsOfKind(events, "segment.boundary");
    expect(boundaries).toHaveLength(1);
    expect(boundaries[0].attrs).toMatchObject({
      reason: "resume",
      context_tokens_before: null,
      context_tokens_after: 30,
      tokens_removed: null,
      parent_segment_id: "seg_0",
      derived: true,
    });
  });

  it("infers a resume when a new file starts with an older sessionId", () => {
    const records: RawRecord[] = [
      {
        source: "claude-code",
        ref: "/tmp/resume-file.jsonl#L1",
        line: 1,
        data: {
          type: "user",
          uuid: "u1",
          timestamp: "2026-10-19T10:00:00.000Z",
          sessionId: "older-session",
          message: { role: "user", content: "after loading the file" },
        },
      },
      {
        source: "claude-code",
        ref: "/tmp/resume-file.jsonl#L2",
        line: 2,
        data: {
          type: "assistant",
          uuid: "a1",
          parentUuid: "u1",
          timestamp: "2026-10-19T10:00:01.000Z",
          sessionId: "older-session",
          requestId: "req-file",
          message: {
            id: "msg-file",
            role: "assistant",
            model: "claude-opus-5-5",
            content: [{ type: "text", text: "loaded" }],
            stop_reason: "end_turn",
            usage: {
              input_tokens: 1,
              cache_creation_input_tokens: 2,
              cache_read_input_tokens: 3,
              output_tokens: 4,
            },
          },
        },
      },
    ];

    const events = normalizeClaudeCodeFile(file("new-file-name"), records);
    const boundaries = eventsOfKind(events, "segment.boundary");
    expect(boundaries).toHaveLength(1);
    expect(boundaries[0].attrs).toMatchObject({
      reason: "resume",
      context_tokens_before: null,
      context_tokens_after: 6,
      tokens_removed: null,
      parent_segment_id: "seg_0",
      derived: true,
    });
  });
});

describe("@openmatel/source-local — Claude Code side chains", () => {
  /** A session with a sub agent; the fixture does not contain one. */
  const sideChain: RawRecord[] = [
    {
      source: "claude-code",
      ref: "/tmp/sidechain.jsonl#L1",
      line: 1,
      data: {
        type: "user",
        uuid: "u0",
        timestamp: "2026-10-19T10:00:00.000Z",
        userType: "external",
        message: { role: "user", content: "look into it" },
      },
    },
    {
      source: "claude-code",
      ref: "/tmp/sidechain.jsonl#L2",
      line: 2,
      data: {
        type: "assistant",
        uuid: "u1",
        parentUuid: "u0",
        timestamp: "2026-10-19T10:00:01.000Z",
        message: {
          role: "assistant",
          model: "claude-opus-5-5",
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "Task",
              input: { subagent_type: "explorer", description: "look into it" },
            },
          ],
        },
      },
    },
    {
      source: "claude-code",
      ref: "/tmp/sidechain.jsonl#L3",
      line: 3,
      data: {
        type: "user",
        uuid: "u2",
        parentUuid: "u1",
        isSidechain: true,
        timestamp: "2026-10-19T10:00:02.000Z",
        message: { role: "user", content: "read the file" },
      },
    },
    {
      source: "claude-code",
      ref: "/tmp/sidechain.jsonl#L4",
      line: 4,
      data: {
        type: "assistant",
        uuid: "u3",
        parentUuid: "u2",
        isSidechain: true,
        timestamp: "2026-10-19T10:00:03.000Z",
        message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "done" }] },
      },
    },
  ];

  const file: SessionFile = {
    source: "claude-code",
    path: "/tmp/sidechain.jsonl",
    size: 0,
    mtimeMs: 0,
    sourceSessionId: "sidechain",
  };

  const sideEvents = normalizeClaudeCodeFile(file, sideChain);

  it("reports one spawn per side chain", () => {
    const spawns = eventsOfKind(sideEvents, "subagent.spawn");
    expect(spawns).toHaveLength(1);
    expect(spawns[0].attrs.agent_name).toBe("explorer");
    expect(spawns[0].attrs.task).toBe("look into it");
  });

  it("keeps the sub agent inside the turn of its parent", () => {
    // The prompt of the sub agent is not a new turn of the session.
    expect(countOfKind(sideEvents, "turn.start")).toBe(1);
    expect(countOfKind(sideEvents, "message.user")).toBe(2);
  });
});

describe("@openmatel/source-local — Claude Code synthetic models", () => {
  const record = (line: number, model: string): RawRecord => ({
    source: "claude-code",
    ref: `/tmp/synthetic.jsonl#L${line}`,
    line,
    data: {
      type: "assistant",
      uuid: `a${line}`,
      timestamp: `2026-10-19T10:00:0${line}.000Z`,
      message: {
        role: "assistant",
        model,
        content: [{ type: "text", text: `reply-${line}` }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
  });

  const file = (name: string): SessionFile => ({
    source: "claude-code",
    path: `/tmp/${name}.jsonl`,
    size: 0,
    mtimeMs: 0,
    sourceSessionId: name,
  });

  it("ignores <synthetic> and keeps the last real model", () => {
    const events = normalizeClaudeCodeFile(file("mixed"), [
      record(1, "<synthetic>"),
      record(2, "claude-opus-5-5"),
    ]);

    expect(firstEventOfKind(events, "session.start")?.attrs.model).toBe("claude-opus-5-5");
    const llmModels = eventsOfKind(events, "llm.call")
      .map((call) => call.attrs.model)
      .filter((model) => model !== undefined && model !== null);
    expect(llmModels).toEqual(["claude-opus-5-5"]);
  });

  it("leaves the session model unknown when only <synthetic> was reported", () => {
    const events = normalizeClaudeCodeFile(file("synthetic-only"), [record(1, "<synthetic>")]);

    expect(firstEventOfKind(events, "session.start")?.attrs.model).toBeUndefined();
    // `<synthetic>` is not a model call at all.
    expect(eventsOfKind(events, "llm.call")).toHaveLength(0);
  });
});
