import { describe, expect, it } from "vitest";
import path from "node:path";
import { readFileSync } from "node:fs";

import { normalizerContract } from "@openmatel/contract-tests";
import {
  sessionId,
  validateEvent,
  type AgentEvent,
  type RawRecord,
} from "@openmatel/core";

import {
  decompressZstdFrames,
  discover as discoverDsh,
  dshNormalizer,
  normalizeFile as normalizeDshFile,
  readRecords as readDshRecords,
  splitZstdFrames,
  type SessionFile,
} from "./dsh.js";
import { countOfKind, eventsOfKind, firstEventOfKind, makeTempHome } from "./test-support.js";

const temp = makeTempHome(["dsh"]);

const files = await discoverDsh(temp.home);
const file = files.find(
  (candidate) => candidate.sourceSessionId === "44444444-4444-4444-8444-444444444444",
);
if (file === undefined) throw new Error("the dsh fixture was not found");
const records = await readDshRecords(file);
const events = normalizeDshFile(file, records);

// These fixtures carry synthetic compaction/stream records and use a name
// that is not a dsh session log, so they stay out of `discover()` while the
// normalizer test can still read them like any other session file.
const streamFile: SessionFile = {
  source: "dsh",
  path: path.join(
    temp.home,
    ".dsh",
    "sessions",
    "--home-user-stream--",
    "session-55555555-5555-4555-8555-555555555555",
    "synthetic-stream.jsonl.zstd",
  ),
  size: 0,
  mtimeMs: 0,
  sourceSessionId: "55555555-5555-4555-8555-555555555555",
};
const streamRecords = await readDshRecords(streamFile);
const streamEvents = normalizeDshFile(streamFile, streamRecords);

const compactionFile: SessionFile = {
  source: "dsh",
  path: path.join(
    temp.home,
    ".dsh",
    "sessions",
    "--home-user-compaction--",
    "session-66666666-6666-4666-8666-666666666666",
    "synthetic-compaction.jsonl.zstd",
  ),
  size: 0,
  mtimeMs: 0,
  sourceSessionId: "66666666-6666-4666-8666-666666666666",
};
const compactionRecords = await readDshRecords(compactionFile);
const compactionEvents = normalizeDshFile(compactionFile, compactionRecords);

const checkpointFile: SessionFile = {
  source: "dsh",
  path: path.join(
    temp.home,
    ".dsh",
    "sessions",
    "--home-user-checkpoint--",
    "session-99999999-9999-4999-8999-999999999999",
    "synthetic-checkpoint.jsonl.zstd",
  ),
  size: 0,
  mtimeMs: 0,
  sourceSessionId: "99999999-9999-4999-8999-999999999999",
};
const checkpointRecords = await readDshRecords(checkpointFile);
const checkpointEvents = normalizeDshFile(checkpointFile, checkpointRecords);

const allRecords = [
  ...(await Promise.all(files.map((candidate) => readDshRecords(candidate)))).flat(),
  ...streamRecords,
  ...compactionRecords,
  ...checkpointRecords,
];

normalizerContract("dsh normalizer", dshNormalizer, allRecords);

const llmCalls = (all: AgentEvent[]): AgentEvent[] => eventsOfKind(all, "llm.call");

/** Build a session file for an in-memory normalization case. */
function syntheticFile(id: string, pathName = "/tmp/dsh-synthetic"): SessionFile {
  return {
    source: "dsh",
    path: `${pathName}/session-${id}/session.v4.jsonl.zstd`,
    size: 0,
    mtimeMs: 1700000200000,
    sourceSessionId: id,
  };
}

/** Turn a plain record into the shape the reader produces. */
function rawRecord(file: SessionFile, line: number, data: Record<string, unknown>): RawRecord {
  return {
    source: "dsh",
    ref: `${file.path}#L${line}`,
    line,
    data,
  };
}

describe("@openmatel/source-local — dsh", () => {
  it("finds the session file of the fixture", () => {
    expect(files).toHaveLength(1);
    expect(file.source).toBe("dsh");
    expect(file.sourceSessionId).toBe("44444444-4444-4444-8444-444444444444");
    expect(file.path).toContain(path.join(".dsh", "sessions"));
    expect(file.path).toMatch(/session\.v4\.jsonl\.zstd$/);
    expect(streamFile.sourceSessionId).toBe("55555555-5555-4555-8555-555555555555");
    expect(compactionFile.sourceSessionId).toBe("66666666-6666-4666-8666-666666666666");
    expect(checkpointFile.sourceSessionId).toBe("99999999-9999-4999-8999-999999999999");
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

  it("closes the session at the last record, not at the file mtime", () => {
    // A later touch of the file must not fabricate an idle gap before the end.
    const touched = normalizeDshFile(
      { ...file, mtimeMs: Date.parse("2027-01-01T00:00:00.000Z") },
      records,
    );
    const lastRecordTs = "2026-10-19T03:01:25.419Z";
    expect(firstEventOfKind(touched, "session.end")?.ts).toBe(lastRecordTs);
    expect(firstEventOfKind(touched, "turn.end")?.ts).toBe(lastRecordTs);
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
    expect(countOfKind(streamEvents, "raw.unknown")).toBe(0);
    expect(countOfKind(compactionEvents, "raw.unknown")).toBe(0);
    expect(countOfKind(checkpointEvents, "raw.unknown")).toBe(0);
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
    const calls = llmCalls(events);
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
    for (const event of [...events, ...streamEvents, ...compactionEvents, ...checkpointEvents]) {
      const result = validateEvent(event);
      expect(result.ok, result.ok ? "" : result.errors.join("; ")).toBe(true);
    }
  });

  it("puts a segment id on every event", () => {
    for (const event of [...events, ...streamEvents, ...compactionEvents, ...checkpointEvents]) {
      expect(event.segment_id).toMatch(/^seg_\d+$/);
    }
  });

  it("emits exactly one llm.call per model call and keeps retries as control events", () => {
    expect(llmCalls(streamEvents)).toHaveLength(2);
    expect(countOfKind(streamEvents, "control.retry")).toBe(1);
    expect(countOfKind(streamEvents, "turn.start")).toBe(1);
    expect(countOfKind(streamEvents, "turn.end")).toBe(1);

    const calls = llmCalls(streamEvents);
    expect(calls.map((call) => call.attrs.request_index)).toEqual([1, 2]);
    expect(calls.map((call) => call.attrs.purpose)).toEqual(["chat", "chat"]);
    // The retry does not add a call: the settled call carries the attempt
    // facts of the failed attempt that preceded it.
    expect(calls[0]?.attrs.retry).toBeNull();
    expect(calls[1]?.attrs.retry).toEqual({
      attempt: 1,
      max_attempts: 2,
      delay_ms: 10,
      error_code: "TRANSPORT",
    });
  });

  it("derives latency and TTFT from the stream and marks them as derived", () => {
    const [first, second] = llmCalls(streamEvents);
    expect(first?.attrs).toMatchObject({
      provider: "synthetic-provider",
      model: "synthetic-model",
      context_tokens: 150,
      stop_reason: "stop",
      latency_ms: 500,
      ttft_ms: 150,
      request_id: null,
      context_window: 128000,
      derived: ["latency_ms", "ttft_ms"],
    });
    expect(second?.attrs).toMatchObject({
      provider: "synthetic-provider",
      model: "synthetic-model",
      context_tokens: null,
      stop_reason: "tool-calls",
      latency_ms: 500,
      ttft_ms: 150,
      request_id: null,
      context_window: 128000,
      derived: ["latency_ms", "ttft_ms"],
    });
  });

  it("keeps every unknown usage field null instead of turning it into zero", () => {
    const [, second] = llmCalls(streamEvents);
    expect(second?.usage).toMatchObject({
      input_tokens: 200,
      output_tokens: 30,
      cache_read_tokens: 100,
      cache_write_tokens: null,
      reasoning_tokens: null,
      source: "harness",
    });
    // The missing cache bucket makes the full context size unknown as well.
    expect(second?.attrs.context_tokens).toBeNull();

    for (const call of llmCalls([...events, ...streamEvents, ...compactionEvents])) {
      expect(call.attrs).toHaveProperty("request_id");
      expect(call.attrs).toHaveProperty("context_window");
      expect(Array.isArray(call.attrs.derived)).toBe(true);
      for (const field of [
        "input_tokens",
        "output_tokens",
        "cache_read_tokens",
        "cache_write_tokens",
        "reasoning_tokens",
      ] as const) {
        const value = call.usage?.[field];
        expect(value === null || typeof value === "number").toBe(true);
      }
    }
  });

  it("keeps latency, TTFT and stop reason null when the source did not provide them", () => {
    const first = llmCalls(events)[0];
    expect(first?.attrs.stop_reason).toBeNull();
    expect(first?.attrs.latency_ms).toBeNull();
    expect(first?.attrs.ttft_ms).toBeNull();
    expect(first?.attrs.request_id).toBeNull();
    expect(first?.attrs.context_window).toBe(1000000);
    expect(first?.attrs.context_tokens).toBe(10841);
    expect(first?.attrs.derived).toEqual([]);
  });

  it("opens a compaction segment with before/after/tokens_removed/summary", () => {
    const boundaries = eventsOfKind(compactionEvents, "segment.boundary");
    expect(boundaries).toHaveLength(1);

    const boundary = boundaries[0];
    expect(boundary.segment_id).toBe("seg_1");
    expect(boundary.ts).toBe("2023-11-14T22:15:01.700Z");
    expect(boundary.end_ts).toBe("2023-11-14T22:15:01.901Z");
    expect(boundary.attrs).toMatchObject({
      reason: "compaction",
      context_tokens_before: 1000,
      context_tokens_after: 150,
      tokens_removed: 850,
      summary: "Synthetic summary of the earlier synthetic context.",
      parent_segment_id: "seg_0",
      derived: true,
    });
    expect(boundary.content?.output?.text).toBe(
      "Synthetic summary of the earlier synthetic context.",
    );

    const calls = llmCalls(compactionEvents);
    expect(calls.map((call) => call.segment_id)).toEqual(["seg_0", "seg_1", "seg_1"]);
    expect(calls.map((call) => call.attrs.request_index)).toEqual([1, 2, 3]);
    expect(calls.map((call) => call.attrs.purpose)).toEqual([
      "chat",
      "compaction",
      "chat",
    ]);
    expect(calls.map((call) => call.attrs.context_tokens)).toEqual([1000, 1000, 150]);
    expect(calls[1]?.attrs).toMatchObject({
      provider: "synthetic-provider",
      model: "synthetic-summary-model",
      purpose: "compaction",
      request_index: 2,
    });
    expect(calls[1]?.usage).toMatchObject({
      input_tokens: 900,
      output_tokens: 20,
      cache_read_tokens: 100,
      cache_write_tokens: 0,
      source: "harness",
    });
  });

  it("maps request/header resume to a segment boundary", () => {
    const state = syntheticFile("77777777-7777-4777-8777-777777777777");
    const message = (time: number, input: number, output: number): Record<string, unknown> => ({
      type: "assistant/message",
      time,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Synthetic resume answer." }],
          source: {
            kind: "model",
            provider: "synthetic-provider",
            model: "synthetic-model",
          },
        },
        usage: {
          inputTokens: input,
          outputTokens: output,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        stream: [
          {
            type: "chunk",
            time,
            chunk: { type: "finish", reason: { kind: "stop" } },
          },
        ],
      },
    });

    const records: RawRecord[] = [
      rawRecord(state, 1, {
        type: "session",
        version: 4,
        id: `session-${state.sourceSessionId}`,
        createdAt: 1700000200000,
        cwd: "/home/user/resume-project",
        isSeeded: false,
        delegationDepth: 0,
      }),
      rawRecord(state, 2, { type: "turn/start", seq: 0, time: 1700000201000, data: { turn: 1 } }),
      rawRecord(state, 3, {
        type: "user/message",
        seq: 1,
        time: 1700000201001,
        data: {
          content: [{ type: "text", text: "Synthetic resume prompt." }],
          source: { kind: "user" },
          role: "user",
        },
      }),
      rawRecord(state, 4, message(1700000201600, 100, 10)),
      rawRecord(state, 5, {
        type: "request/header",
        seq: 3,
        time: 1700000201700,
        data: {
          header: {
            config: { provider: "synthetic-provider", model: "synthetic-model" },
          },
          reason: "resume",
        },
      }),
      rawRecord(state, 6, message(1700000202600, 40, 5)),
      rawRecord(state, 7, {
        type: "turn/end",
        seq: 5,
        time: 1700000202601,
        data: { turn: 1, reason: { kind: "completed" } },
      }),
    ];

    const normalized = normalizeDshFile(state, records);
    const boundaries = eventsOfKind(normalized, "segment.boundary");
    expect(boundaries).toHaveLength(1);
    expect(boundaries[0].attrs).toMatchObject({
      reason: "resume",
      context_tokens_before: 100,
      context_tokens_after: 40,
      tokens_removed: 60,
      parent_segment_id: "seg_0",
      derived: true,
    });
    expect(llmCalls(normalized).map((call) => call.segment_id)).toEqual(["seg_0", "seg_1"]);
  });

  it("maps compaction checkpoints to boundaries and keeps summary authoritative", () => {
    const boundaries = eventsOfKind(checkpointEvents, "segment.boundary");
    expect(boundaries).toHaveLength(2);
    expect(boundaries.map((boundary) => boundary.attrs.reason)).toEqual([
      "compaction",
      "compaction",
    ]);
    expect(boundaries[0]?.attrs.summary).toBe("Synthetic authoritative summary.");
    expect(boundaries[0]?.content?.output?.text).toBe("Synthetic authoritative summary.");
    expect(boundaries[0]?.ts).toBe("2023-11-14T22:20:01.700Z");
    expect(boundaries[0]?.end_ts).toBe("2023-11-14T22:20:01.900Z");
    // A checkpoint without a summary record carries the replacement body.
    expect(boundaries[1]?.attrs.summary).toBe("Synthetic checkpoint-only summary.");
    expect(boundaries[1]?.ts).toBe("2023-11-14T22:20:03.000Z");
    expect(boundaries[1]?.end_ts).toBe("2023-11-14T22:20:03.100Z");

    // The checkpoint is not a user turn and does not add a message.user.
    expect(countOfKind(checkpointEvents, "turn.start")).toBe(2);
    expect(
      eventsOfKind(checkpointEvents, "message.user").map(
        (event) => event.content?.input?.text,
      ),
    ).toEqual([
      "Synthetic checkpoint fixture prompt.",
      "Synthetic prompt after checkpoint compactions.",
    ]);

    const calls = llmCalls(checkpointEvents);
    expect(calls.map((call) => call.attrs.request_index)).toEqual([1, 2, 3, 4]);
    expect(calls.map((call) => call.attrs.purpose)).toEqual([
      "chat",
      "compaction",
      "chat",
      "chat",
    ]);
    expect(calls[1]?.attrs).toMatchObject({
      provider: "synthetic-summary-provider",
      model: "synthetic-summary-model",
    });
    expect(calls[1]?.usage?.output_tokens).toBe(10);
  });

  it("keeps the compaction start/end time and error on the boundary", () => {
    const state = syntheticFile("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const records: RawRecord[] = [
      rawRecord(state, 1, {
        type: "session",
        version: 4,
        id: `session-${state.sourceSessionId}`,
        createdAt: 1700000500000,
        cwd: "/home/user/error-compaction",
        delegationDepth: 0,
      }),
      rawRecord(state, 2, {
        type: "compaction/start",
        seq: 0,
        time: 1700000501000,
        data: { compactionId: "synthetic-failed", turn: null },
      }),
      rawRecord(state, 3, {
        type: "compaction/summary",
        seq: 1,
        time: 1700000501500,
        data: {
          compactionId: "synthetic-failed",
          turn: null,
          summary: [{ type: "text", text: "Synthetic failed summary." }],
          provider: "synthetic-provider",
          model: "synthetic-summary-model",
          usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
        },
      }),
      rawRecord(state, 4, {
        type: "compaction/end",
        seq: 2,
        time: 1700000502000,
        data: {
          compactionId: "synthetic-failed",
          turn: null,
          error: "Synthetic compaction failure",
        },
      }),
    ];

    const normalized = normalizeDshFile(state, records);
    const boundary = firstEventOfKind(normalized, "segment.boundary");
    expect(boundary?.ts).toBe("2023-11-14T22:21:41.000Z");
    expect(boundary?.end_ts).toBe("2023-11-14T22:21:42.000Z");
    expect(boundary?.status).toBe("error");
    expect(boundary?.error).toEqual({
      type: "compaction_error",
      message: "Synthetic compaction failure",
    });
    expect(boundary?.attrs.summary).toBe("Synthetic failed summary.");

    const call = firstEventOfKind(normalized, "llm.call");
    expect(call?.attrs.purpose).toBe("compaction");
    expect(call?.attrs.request_index).toBe(1);
  });

  it("maps an inherited session/end-seed marker to a fork boundary", () => {
    const state = syntheticFile("88888888-8888-4888-8888-888888888888");
    const records: RawRecord[] = [
      rawRecord(state, 1, {
        type: "session",
        version: 4,
        id: `session-${state.sourceSessionId}`,
        createdAt: 1700000300000,
        cwd: "/home/user/fork-project",
        isSeeded: true,
        parentSession: "session-synthetic-parent",
        delegationDepth: 0,
      }),
      rawRecord(state, 2, {
        type: "session/end-seed",
        seq: 0,
        time: 1700000301000,
        data: { inherited: true },
      }),
      rawRecord(state, 3, { type: "turn/start", seq: 1, time: 1700000302000, data: { turn: 1 } }),
      rawRecord(state, 4, {
        type: "user/message",
        seq: 2,
        time: 1700000302001,
        data: {
          content: [{ type: "text", text: "Synthetic fork prompt." }],
          source: { kind: "user" },
          role: "user",
        },
      }),
      rawRecord(state, 5, {
        type: "assistant/message",
        seq: 3,
        time: 1700000302500,
        data: {
          turn: 1,
          step: 1,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Synthetic fork answer." }],
            source: {
              kind: "model",
              provider: "synthetic-provider",
              model: "synthetic-model",
            },
          },
          usage: {
            inputTokens: 30,
            outputTokens: 3,
            cacheReadTokens: 10,
            cacheWriteTokens: 0,
          },
          stream: [
            {
              type: "chunk",
              time: 1700000302500,
              chunk: { type: "finish", reason: { kind: "stop" } },
            },
          ],
        },
      }),
      rawRecord(state, 6, {
        type: "turn/end",
        seq: 4,
        time: 1700000302501,
        data: { turn: 1, reason: { kind: "completed" } },
      }),
    ];

    const normalized = normalizeDshFile(state, records);
    const boundaries = eventsOfKind(normalized, "segment.boundary");
    expect(boundaries).toHaveLength(1);
    expect(boundaries[0].attrs).toMatchObject({
      reason: "fork",
      context_tokens_before: null,
      context_tokens_after: 40,
      parent_segment_id: "seg_0",
      derived: true,
    });
    expect(llmCalls(normalized)[0]?.segment_id).toBe("seg_1");
  });
});
