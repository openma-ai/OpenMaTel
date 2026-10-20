import { describe, expect, it } from "vitest";
import path from "node:path";

import { normalizerContract } from "@openmatel/contract-tests";
import {
  buildSessionTree,
  contextTokens,
  sessionId,
  validateEvent,
  type RawRecord,
} from "@openmatel/core";

import {
  codexNormalizer,
  discover as discoverCodex,
  normalizeFile as normalizeCodexFile,
  readRecords as readCodexRecords,
  type SessionFile,
} from "./codex.js";
import {
  countOfKind,
  eventsOfKind,
  firstEventOfKind,
  fixturesRoot,
  makeTempHome,
} from "./test-support.js";

const temp = makeTempHome(["codex"]);

const files = await discoverCodex(temp.home);
const mainFile = files.find(
  (file) => file.sourceSessionId === "22222222-2222-4222-8222-222222222222",
);
if (mainFile === undefined) throw new Error("the Codex fixture was not found");

// The compaction fixture is synthetic. It deliberately does not use the
// `rollout-…` name, so production discovery only reports real rollout files.
const compactionFile: SessionFile = {
  source: "codex",
  path: path.join(
    fixturesRoot,
    "codex",
    "2026",
    "10",
    "20",
    "compaction-synthetic.jsonl",
  ),
  size: 0,
  mtimeMs: Date.parse("2026-10-19T11:00:00.000Z"),
  sourceSessionId: "44444444-4444-4444-8444-444444444444",
};

const mainRecords = await readCodexRecords(mainFile);
const mainEvents = normalizeCodexFile(mainFile, mainRecords);
const compactionRecords = await readCodexRecords(compactionFile);
const compactionEvents = normalizeCodexFile(compactionFile, compactionRecords);

normalizerContract("codex normalizer", codexNormalizer, [
  ...mainRecords,
  ...compactionRecords,
]);

/** A tiny file used by the synthetic missing-value cases below. */
const syntheticFile: SessionFile = {
  source: "codex",
  path: "/tmp/synthetic-codex.jsonl",
  size: 0,
  mtimeMs: 0,
  sourceSessionId: "55555555-5555-4555-8555-555555555555",
};

/** Build a minimal conversation around one usage report. */
function syntheticRecords(usage: Record<string, unknown>): RawRecord[] {
  return [
    {
      source: "codex",
      ref: `${syntheticFile.path}#L1`,
      line: 1,
      data: {
        timestamp: "2026-10-20T12:00:00.000Z",
        type: "session_meta",
        payload: {
          id: syntheticFile.sourceSessionId,
          cli_version: "0.162.1",
          model_provider: "openai",
          base_instructions: { provenance: { model: "synthetic-model" } },
        },
      },
    },
    {
      source: "codex",
      ref: `${syntheticFile.path}#L2`,
      line: 2,
      data: {
        timestamp: "2026-10-20T12:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "synthetic answer" }],
        },
      },
    },
    {
      source: "codex",
      ref: `${syntheticFile.path}#L3`,
      line: 3,
      data: {
        timestamp: "2026-10-20T12:00:02.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { last_token_usage: usage, model_context_window: 1234 },
        },
      },
    },
  ];
}

describe("@openmatel/source-local — Codex", () => {
  it("finds the real rollout and loads the synthetic compaction fixture", () => {
    // The synthetic fixture is not a production rollout file, so discovery
    // must still report exactly the one real Codex session.
    expect(files).toHaveLength(1);
    expect(mainFile.source).toBe("codex");
    expect(mainFile.path).toContain(path.join(".codex", "sessions"));
    expect(mainFile.path).toMatch(/rollout-.*\.jsonl$/);
    expect(compactionFile.source).toBe("codex");
    expect(compactionFile.path).toMatch(/compaction-synthetic\.jsonl$/);
  });

  it("reads every line of the fixtures as records", () => {
    expect(mainRecords).toHaveLength(80);
    expect(mainRecords[0].ref).toBe(`${mainFile.path}#L1`);
    expect(compactionRecords).toHaveLength(18);
  });

  it("produces one session with one turn for the main fixture", () => {
    expect(countOfKind(mainEvents, "session.start")).toBe(1);
    expect(countOfKind(mainEvents, "session.end")).toBe(1);
    expect(countOfKind(mainEvents, "turn.start")).toBe(1);
    expect(countOfKind(mainEvents, "turn.end")).toBe(1);
  });

  it("closes the session at the last record, not at the file mtime", () => {
    // A later touch of the file must not fabricate an idle gap before the end.
    const touched = normalizeCodexFile(
      { ...mainFile, mtimeMs: Date.parse("2027-01-01T00:00:00.000Z") },
      mainRecords,
    );
    expect(firstEventOfKind(touched, "session.end")?.ts).toBe(
      "2026-10-13T13:36:00.372Z",
    );
  });

  it("describes the session", () => {
    const start = firstEventOfKind(mainEvents, "session.start");
    expect(start?.project_id).toBe("local");
    expect(start?.session_id).toBe(sessionId("codex", mainFile.sourceSessionId));
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
    const users = eventsOfKind(mainEvents, "message.user");
    expect(users).toHaveLength(1);
    expect(users[0].content?.input?.text).toBe("redacted text");
  });

  it("emits at least one tool call, with its result", () => {
    const calls = eventsOfKind(mainEvents, "tool.call");
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls.length).toBe(11);

    for (const call of calls) {
      expect(call.attrs.tool_name).toBe("exec");
      expect(call.attrs.tool_kind).toBe("execute");
      expect(call.content?.output?.text).toBeDefined();
      expect(call.end_ts).toBeDefined();
      expect(call.segment_id).toBe("seg_0");
    }
  });

  it("maps the full Codex call contract: uncached input, context and metadata", () => {
    const calls = eventsOfKind(mainEvents, "llm.call");
    expect(calls).toHaveLength(11);

    const first = calls[0];
    expect(first.attrs.provider).toBe("redacted text");
    expect(first.attrs.model).toBe("gpt-6.1-sol");
    expect(first.attrs.context_tokens).toBe(15274);
    expect(first.attrs.context_window).toBe(475000);
    expect(first.attrs.request_id).toBe(
      "resp_002744f0f7c5cc82016ace3100b148819b8428b7d79c1495f1",
    );
    expect(first.attrs.stop_reason).toBeNull();
    expect(first.attrs.latency_ms).toBeNull();
    expect(first.attrs.ttft_ms).toBeNull();
    // Codex has no timestamps for a call boundary, so nothing is estimated.
    expect(first.attrs.derived).toEqual([]);

    const usage = first.usage;
    expect(usage?.source).toBe("harness");
    // Codex' input_tokens includes the cached part: 15274 - 12288 = 2986.
    expect(usage?.input_tokens).toBe(2986);
    expect(usage?.output_tokens).toBe(124);
    expect(usage?.cache_read_tokens).toBe(12288);
    // Codex reported `cache_write_input_tokens: 0` — a reported zero stays a
    // zero and never becomes `null`.
    expect(usage?.cache_write_tokens).toBe(0);
    expect(usage?.reasoning_tokens).toBe(0);

    for (const call of calls) {
      expect(call.segment_id).toBe("seg_0");
      expect(call.usage?.source).toBe("harness");
      expect(call.attrs.context_tokens).toBe(contextTokens(call.usage));
      expect(call.attrs).toHaveProperty("request_id");
      expect(call.attrs).toHaveProperty("context_window");
      expect(call.attrs).toHaveProperty("derived");
      expect(Array.isArray(call.attrs.derived)).toBe(true);
    }
  });

  it("opens a new segment at a compacted record and fills before/after", () => {
    const boundaries = eventsOfKind(compactionEvents, "segment.boundary");
    expect(boundaries).toHaveLength(1);

    const boundary = boundaries[0];
    expect(boundary.segment_id).toBe("seg_1");
    expect(boundary.attrs.reason).toBe("compaction");
    expect(boundary.attrs.parent_segment_id).toBe("seg_0");
    expect(boundary.attrs.context_tokens_before).toBe(1100);
    expect(boundary.attrs.context_tokens_after).toBe(300);
    expect(boundary.attrs.tokens_removed).toBe(800);
    expect(boundary.attrs.summary).toBe(
      "Synthetic compaction summary: the earlier context was summarized.",
    );
    expect(boundary.attrs.derived).toBe(true);
    expect(boundary.content?.output?.text).toBe(boundary.attrs.summary);
    expect(boundary.content?.capture).toBe("full");

    const calls = eventsOfKind(compactionEvents, "llm.call");
    expect(calls.map((call) => call.segment_id)).toEqual(["seg_0", "seg_1"]);
    expect(calls[0].attrs.context_tokens).toBe(1100);
    expect(calls[1].attrs.context_tokens).toBe(300);
    expect(calls[0].attrs.request_id).toBe("resp_synthetic_1");
    expect(calls[1].attrs.request_id).toBe("resp_synthetic_2");
    expect(calls[0].usage?.input_tokens).toBe(600);
    expect(calls[1].usage?.input_tokens).toBe(200);
    expect(calls[0].usage?.cache_read_tokens).toBe(400);
    expect(calls[1].usage?.cache_read_tokens).toBe(100);
    expect(calls[0].usage?.cache_write_tokens).toBe(100);
    expect(calls[1].usage?.cache_write_tokens).toBe(0);

    const tree = buildSessionTree(compactionEvents);
    expect(tree.segments.map((segment) => segment.segment_id)).toEqual(["seg_0", "seg_1"]);
    expect(tree.segments[1].boundary?.event_id).toBe(boundary.event_id);
    expect(tree.segments[0].turns).toHaveLength(1);
    expect(tree.segments[1].turns).toHaveLength(1);
  });

  it("keeps missing token values null instead of inventing zero", () => {
    const events = normalizeCodexFile(
      syntheticFile,
      syntheticRecords({ input_tokens: 10, output_tokens: 2 }),
    );
    const call = firstEventOfKind(events, "llm.call");
    const usage = call?.usage;

    expect(usage?.source).toBe("harness");
    // The uncached input cannot be known without the cached part.
    expect(usage?.input_tokens).toBeNull();
    expect(usage?.cache_read_tokens).toBeNull();
    expect(usage?.cache_write_tokens).toBeNull();
    expect(usage?.reasoning_tokens).toBeNull();
    expect(usage?.output_tokens).toBe(2);
    expect(call?.attrs.context_tokens).toBeNull();
    expect(call?.attrs.context_window).toBe(1234);

    const missing = [
      usage?.input_tokens,
      usage?.cache_read_tokens,
      usage?.cache_write_tokens,
      usage?.reasoning_tokens,
    ];
    expect(missing).not.toContain(0);
  });

  it("keeps a reported zero and computes uncached input when cache is known", () => {
    const events = normalizeCodexFile(
      syntheticFile,
      syntheticRecords({
        input_tokens: 10,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        output_tokens: 2,
        reasoning_output_tokens: 0,
      }),
    );
    const call = firstEventOfKind(events, "llm.call");

    expect(call?.usage?.input_tokens).toBe(10);
    expect(call?.usage?.cache_read_tokens).toBe(0);
    expect(call?.usage?.cache_write_tokens).toBe(0);
    expect(call?.usage?.reasoning_tokens).toBe(0);
    expect(call?.attrs.context_tokens).toBe(10);
  });

  it("keeps the ids of the events unique and stable", () => {
    for (const [file, records, events] of [
      [mainFile, mainRecords, mainEvents],
      [compactionFile, compactionRecords, compactionEvents],
    ] as const) {
      const ids = events.map((event) => event.event_id);
      expect(new Set(ids).size).toBe(ids.length);

      const again = normalizeCodexFile(file, records);
      expect(again.map((event) => event.event_id)).toEqual(ids);
      expect(again).toEqual(events);
    }
  });

  it("produces valid canonical events", () => {
    for (const event of [...mainEvents, ...compactionEvents]) {
      const result = validateEvent(event);
      expect(result.ok, result.ok ? "" : result.errors.join("; ")).toBe(true);
    }
  });
});
