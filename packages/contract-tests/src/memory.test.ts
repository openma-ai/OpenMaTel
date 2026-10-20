/**
 * The contract suites, run against the reference implementation.
 *
 * A contract is only worth something when an implementation can pass it, so
 * the suites of this package are executed here against
 * `createMemoryStore()`, `createMemoryBus()` and `createFileSource()`. An
 * adapter that passes the same suites behaves like the reference.
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  SCHEMA_VERSION,
  eventId,
  validateEvent,
  type AgentEvent,
  type EventKind,
  type Normalizer,
  type RawRecord,
  type StepStatus,
  type Usage,
} from "@openmatel/core";

import { busContract } from "./bus.js";
import { makeEvent, sampleSessions } from "./fixtures.js";
import { createFileSource, createMemoryBus, createMemoryStore } from "./memory.js";
import { normalizerContract } from "./normalizer.js";
import { pullSourceContract, type PullSourceWriter } from "./pull-source.js";
import { sinkQueryContract } from "./sink-query.js";

/* -------------------------------------------------------------------------- */
/* The fixtures themselves                                                     */
/* -------------------------------------------------------------------------- */

describe("fixtures", () => {
  it("builds valid events", () => {
    for (const event of sampleSessions("proj_contract")) {
      const result = validateEvent(event);
      expect(result.ok, result.ok ? "" : result.errors.join("; ")).toBe(true);
    }
  });

  it("builds the same ids every time", () => {
    const first = sampleSessions("proj_contract").map((event) => event.event_id);
    const second = sampleSessions("proj_contract").map((event) => event.event_id);
    expect(second).toEqual(first);
  });

  it("keeps the sample session of two projects apart", () => {
    const mine = sampleSessions("proj_a");
    const theirs = sampleSessions("proj_b");
    expect(theirs[0]?.session_id).not.toBe(mine[0]?.session_id);
    expect(theirs[0]?.project_id).toBe("proj_b");
  });

  it("derives a stable id from the partial event", () => {
    const first = makeEvent({ kind: "tool.call", attrs: { tool_name: "read" } });
    const second = makeEvent({ kind: "tool.call", attrs: { tool_name: "read" } });
    const other = makeEvent({ kind: "tool.call", attrs: { tool_name: "write" } });

    expect(second.event_id).toBe(first.event_id);
    expect(other.event_id).not.toBe(first.event_id);
  });
});

/* -------------------------------------------------------------------------- */
/* A reference normalizer and its fixtures                                    */
/* -------------------------------------------------------------------------- */

const KNOWN_KINDS = new Set<EventKind>([
  "session.start",
  "turn.start",
  "llm.call",
  "tool.call",
  "turn.end",
  "session.end",
]);

const referenceNormalizer: Normalizer = {
  schema: { source: "contract", version: "1.0" },
  accepts: (raw) => raw?.source === "contract",
  normalize: (raw) => {
    const data = (raw?.data ?? {}) as Record<string, unknown>;
    const kind = typeof data.kind === "string" ? data.kind : "";

    if (!KNOWN_KINDS.has(kind as EventKind)) {
      return [
        {
          schema: SCHEMA_VERSION,
          event_id: eventId(["reference-normalizer", raw?.source ?? "", raw?.ref ?? "", "raw.unknown"]),
          project_id: "proj_contract",
          session_id: "ss_contract",
          ts: "2026-01-01T00:00:00.000Z",
          kind: "raw.unknown",
          attrs: { raw: raw?.data ?? null },
          source: { name: "contract", version: "1.0", format: "jsonl", ref: raw?.ref ?? "" },
        },
      ];
    }

    const event: AgentEvent = {
      schema: SCHEMA_VERSION,
      event_id: eventId(["reference-normalizer", raw.source, raw.ref, kind]),
      project_id: typeof data.project_id === "string" ? data.project_id : "proj_contract",
      session_id: typeof data.session === "string" ? data.session : "ss_contract",
      ts: typeof data.ts === "string" ? data.ts : "2026-01-01T00:00:00.000Z",
      kind: kind as EventKind,
      attrs:
        data.attrs && typeof data.attrs === "object"
          ? (data.attrs as Record<string, unknown>)
          : {},
      source: { name: "contract", version: "1.0", format: "jsonl", ref: raw.ref },
      usage: normalizeUsage(data.usage),
    };

    if (typeof data.status === "string") event.status = data.status as StepStatus;
    if (typeof data.turn_id === "string") event.turn_id = data.turn_id;
    if (typeof data.step_id === "string") event.step_id = data.step_id;

    return [event];
  },
};

/** Build a usage record; a field the source did not report stays `null`. */
const normalizeUsage = (value: unknown): Usage | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;

  const raw = value as Record<string, unknown>;
  const read = (field: string): number | null =>
    typeof raw[field] === "number" && Number.isFinite(raw[field])
      ? (raw[field] as number)
      : null;

  const usage: Usage = {
    input_tokens: read("input_tokens"),
    output_tokens: read("output_tokens"),
    cache_read_tokens: read("cache_read_tokens"),
    cache_write_tokens: read("cache_write_tokens"),
    reasoning_tokens: read("reasoning_tokens"),
    source: "provider",
  };

  const reported = [
    usage.input_tokens,
    usage.output_tokens,
    usage.cache_read_tokens,
    usage.cache_write_tokens,
    usage.reasoning_tokens,
  ].some((field) => field !== null);

  usage.source = reported ? "provider" : "missing";
  return usage;
};

const rawFixtures: RawRecord[] = [
  {
    source: "contract",
    ref: "contract:1",
    line: 1,
    data: {
      kind: "session.start",
      session: "ss_contract",
      ts: "2026-01-02T03:00:00.000Z",
      attrs: { harness: { name: "reference" }, model: "model-x" },
    },
  },
  {
    source: "contract",
    ref: "contract:2",
    line: 2,
    data: {
      kind: "turn.start",
      session: "ss_contract",
      turn_id: "turn_1",
      ts: "2026-01-02T03:00:01.000Z",
    },
  },
  {
    source: "contract",
    ref: "contract:3",
    line: 3,
    data: {
      kind: "llm.call",
      session: "ss_contract",
      turn_id: "turn_1",
      step_id: "st_llm_1",
      ts: "2026-01-02T03:00:02.000Z",
      usage: { input_tokens: 10, output_tokens: null },
    },
  },
  {
    source: "contract",
    ref: "contract:4",
    line: 4,
    data: {
      kind: "tool.call",
      session: "ss_contract",
      turn_id: "turn_1",
      step_id: "st_tool_1",
      status: "error",
      ts: "2026-01-02T03:00:03.000Z",
      attrs: { tool_name: "read", tool_kind: "read", call_id: "call_1" },
    },
  },
  {
    source: "contract",
    ref: "contract:5",
    line: 5,
    data: {
      kind: "turn.end",
      session: "ss_contract",
      turn_id: "turn_1",
      ts: "2026-01-02T03:00:04.000Z",
    },
  },
  {
    source: "contract",
    ref: "contract:6",
    line: 6,
    data: {
      kind: "session.end",
      session: "ss_contract",
      ts: "2026-01-02T03:00:05.000Z",
    },
  },
];

/* -------------------------------------------------------------------------- */
/* The file the pull source reads                                              */
/* -------------------------------------------------------------------------- */

const filePath = (dir: string): string => join(dir, "records.jsonl");

const writeRecords: PullSourceWriter = (dir, lines, mode = "append") => {
  const path = filePath(dir);
  if (mode === "overwrite") {
    writeFileSync(path, lines.length > 0 ? `${lines.join("\n")}\n` : "");
    return;
  }
  appendFileSync(path, lines.map((line) => `${line}\n`).join(""));
};

/* -------------------------------------------------------------------------- */
/* The contracts, run against the reference implementation                    */
/* -------------------------------------------------------------------------- */

sinkQueryContract("memory store", async () => createMemoryStore());

busContract("memory bus", async () => createMemoryBus());

pullSourceContract(
  "memory file source",
  (dir) => createFileSource({ path: filePath(dir) }),
  writeRecords,
  {
    resume: (dir, cursor) =>
      createFileSource({
        path: filePath(dir),
        startOffset: cursor.offset,
        startHash: cursor.hash,
      }),
  },
);

normalizerContract("reference normalizer", referenceNormalizer, rawFixtures);
