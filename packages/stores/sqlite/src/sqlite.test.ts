/**
 * The tests of the SQLite store.
 *
 * Four kinds of tests live here:
 *
 * - the **contract suite** of `@openmatel/contract-tests`, run against an
 *   in-memory database *and* against a file — the two configurations have to
 *   behave identically, the file is the one the desktop tier uses;
 * - a **reopen test**: what was written is still there after the process
 *   dropped the database and opened it again;
 * - a **performance smoke test**: the session list has to stay fast on a
 *   realistic amount of data;
 * - the checks that are specific to this adapter: the pragmas of the desktop
 *   profile, the migrations, the cursors and the two rules that must not be
 *   broken — "missing is not zero" and "no content without capture".
 */

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  SCHEMA_VERSION,
  type AgentEvent,
  type EventKind,
  type Usage,
} from "@openmatel/core";
import { sampleSessions, sinkQueryContract } from "@openmatel/contract-tests";
import { describe, expect, it } from "vitest";

import { openSqliteStore } from "./index.js";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/** A fresh in-memory store, for the contract suite. */
const memoryStore = async () => {
  const store = openSqliteStore({ path: ":memory:" });
  return {
    sink: store.sink,
    query: store.query,
    close: () => store.close(),
  };
};

/** A fresh store in its own temporary directory, for the contract suite. */
const fileStore = async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmatel-sqlite-contract-"));
  const store = openSqliteStore({ path: join(directory, "store.db") });
  return {
    sink: store.sink,
    query: store.query,
    close: async () => {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
};

/* -------------------------------------------------------------------------- */
/* Contract                                                                    */
/* -------------------------------------------------------------------------- */

sinkQueryContract("sqlite (:memory:)", memoryStore);
sinkQueryContract("sqlite (file)", fileStore);

/* -------------------------------------------------------------------------- */
/* Store                                                                       */
/* -------------------------------------------------------------------------- */

describe("sqlite store", () => {
  it("reads back what it wrote after the database was closed and reopened", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openmatel-sqlite-reopen-"));
    const path = join(directory, "store.db");

    try {
      const events = sampleSessions("proj_reopen");

      const first = openSqliteStore({ path });
      await first.sink.write(events);
      first.setCursor("source:claude-code", "offset-42");
      await first.close();

      const second = openSqliteStore({ path });

      const detail = await second.query.getSession(events[0]!.session_id);
      expect(detail, "the session must survive a reopen").not.toBeNull();
      expect(detail?.events.length).toBe(events.length);
      expect(detail?.summary.turn_count).toBe(2);
      expect(detail?.summary.step_count).toBe(9);
      expect(detail?.summary.usage.total.input_tokens).toBe(130);

      // The materialized summary survived as well.
      const page = await second.query.listSessions({ project_id: "proj_reopen" });
      expect(page.items.length).toBe(1);
      expect(page.items[0]?.usage.total.output_tokens).toBe(45);

      // … and so did the full-text index.
      const search = await second.query.listSessions({ text: "login" });
      expect(search.items.map((summary) => summary.session_id)).toEqual([
        events[0]!.session_id,
      ]);

      // The cursor is part of the database, not of the process.
      expect(second.getCursor("source:claude-code")).toBe("offset-42");
      expect(second.getCursor("source:never-written")).toBeNull();

      await second.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps the content of a step out of the store when the capture is 'none'", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openmatel-sqlite-capture-"));
    const path = join(directory, "store.db");

    try {
      const store = openSqliteStore({ path });
      const [event] = sampleSessions("proj_capture");

      await store.sink.write([
        {
          ...event!,
          event_id: "ev_capture_none",
          kind: "tool.call",
          step_id: "st_capture_none",
          content: {
            capture: "none",
            input: { text: "secret input" },
            output: { text: "secret output" },
          },
        },
      ]);

      const detail = await store.query.getSession(event!.session_id);
      const stored = detail?.events.find((item) => item.event_id === "ev_capture_none");
      expect(stored?.content?.capture).toBe("none");
      expect(stored?.content?.input?.text).toBeUndefined();
      expect(stored?.content?.output?.text).toBeUndefined();

      // The text must not be in the database at all — not in a column and not
      // in the payload of the event.
      const raw = new DatabaseSync(path);
      try {
        const rows = raw.prepare("SELECT content_json, event_json FROM events").all();
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
          expect(String(row.content_json)).not.toContain("secret");
          expect(String(row.event_json)).not.toContain("secret");
        }
      } finally {
        raw.close();
      }

      await store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps an unknown token count null instead of turning it into zero", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openmatel-sqlite-usage-"));
    const path = join(directory, "store.db");

    try {
      const store = openSqliteStore({ path });

      // The session of the fixtures reports every token but the cache read.
      await store.sink.write(sampleSessions("proj_usage"));

      const raw = new DatabaseSync(path);
      try {
        const row = raw
          .prepare(
            "SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_tokens FROM sessions",
          )
          .get();
        expect(row?.input_tokens).toBe(130);
        expect(row?.output_tokens).toBe(45);
        // Nobody reported a cache read: the column stays null.
        expect(row?.cache_read_tokens).toBeNull();
        expect(row?.cache_write_tokens).toBeNull();
      } finally {
        raw.close();
      }

      const page = await store.query.listSessions({ project_id: "proj_usage" });
      expect(page.items[0]?.usage.total.input_tokens).toBe(130);
      expect(page.items[0]?.usage.total.cache_read_tokens).toBeNull();
      expect(page.items[0]?.usage.calls).toBe(4);
      expect(page.items[0]?.usage.covered).toBe(3);

      await store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("applies the migrations once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openmatel-sqlite-migrations-"));
    const path = join(directory, "store.db");

    try {
      const first = openSqliteStore({ path });
      await first.close();

      const second = openSqliteStore({ path });
      await second.close();

      const raw = new DatabaseSync(path);
      try {
        const applied = raw.prepare("SELECT id FROM _migrations ORDER BY id").all();
        expect(applied.map((row) => Number(row.id))).toEqual([1]);
      } finally {
        raw.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses the write ahead log of the desktop profile", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openmatel-sqlite-wal-"));
    const path = join(directory, "store.db");

    try {
      const store = openSqliteStore({ path });

      // WAL is persistent, so a second connection reports it as well.
      const raw = new DatabaseSync(path);
      try {
        expect(raw.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
      } finally {
        raw.close();
      }

      // While the store is open, the journal of the write ahead log exists.
      expect(existsSync(`${path}-wal`), "the write ahead log has to exist").toBe(true);

      await store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps the cursors of the pull sources", async () => {
    const store = openSqliteStore({ path: ":memory:" });

    try {
      expect(store.getCursor("claude-code:/repo/a.jsonl")).toBeNull();

      store.setCursor("claude-code:/repo/a.jsonl", "4096");
      expect(store.getCursor("claude-code:/repo/a.jsonl")).toBe("4096");

      store.setCursor("claude-code:/repo/a.jsonl", "8192");
      expect(store.getCursor("claude-code:/repo/a.jsonl")).toBe("8192");
    } finally {
      await store.close();
    }
  });

  it("finds a session by its title and by its directory", async () => {
    const store = openSqliteStore({ path: ":memory:" });

    try {
      await store.sink.write([
        {
          schema: SCHEMA_VERSION,
          event_id: "ev_search",
          project_id: "proj_search",
          session_id: "ss_search",
          kind: "session.start",
          ts: "2026-05-04T10:00:00.000Z",
          attrs: {
            harness: { name: "claude-code" },
            title: "refactor the parser",
            cwd: "/repo/needle-directory",
          },
          source: { name: "test", format: "json" },
        },
      ]);

      const byTitle = await store.query.listSessions({ text: "parser" });
      expect(byTitle.items.map((summary) => summary.session_id)).toEqual(["ss_search"]);

      const byDirectory = await store.query.listSessions({ text: "needle" });
      expect(byDirectory.items.map((summary) => summary.session_id)).toEqual(["ss_search"]);

      // A fragment of a word is found as well.
      const fragment = await store.query.listSessions({ text: "eedl" });
      expect(fragment.items.map((summary) => summary.session_id)).toEqual(["ss_search"]);

      // A search of less than three characters falls back to LIKE.
      const short = await store.query.listSessions({ text: "re" });
      expect(short.items.map((summary) => summary.session_id)).toEqual(["ss_search"]);

      const nothing = await store.query.listSessions({ text: "nothing-matches-this" });
      expect(nothing.items).toEqual([]);
    } finally {
      await store.close();
    }
  });

  it("paginates the session list with a stable keyset cursor", async () => {
    const store = openSqliteStore({ path: ":memory:" });

    try {
      const events: AgentEvent[] = [];
      for (let index = 0; index < 5; index += 1) {
        events.push({
          schema: SCHEMA_VERSION,
          event_id: `ev_page_${index}`,
          project_id: "proj_page",
          session_id: `ss_page_${index}`,
          kind: "session.start",
          ts: new Date(Date.parse("2026-05-05T10:00:00.000Z") + index * 60_000).toISOString(),
          attrs: { harness: { name: "claude-code" }, title: `page ${index}` },
          source: { name: "test", format: "json" },
        });
      }
      await store.sink.write(events);

      const collected: string[] = [];
      let cursor: string | undefined;
      let guard = 0;

      for (;;) {
        const page = await store.query.listSessions({ project_id: "proj_page", limit: 2, cursor });
        collected.push(...page.items.map((summary) => summary.session_id));
        if (!page.next_cursor) break;
        cursor = page.next_cursor;
        if (++guard > 10) throw new Error("the cursor never ends");
      }

      expect(collected).toEqual([
        "ss_page_4",
        "ss_page_3",
        "ss_page_2",
        "ss_page_1",
        "ss_page_0",
      ]);

      // The cursor is base64url JSON, so a client can read it.
      const page = await store.query.listSessions({ project_id: "proj_page", limit: 2 });
      const decoded = JSON.parse(
        Buffer.from(page.next_cursor ?? "", "base64url").toString("utf8"),
      ) as { session_id: string; started_at: string };
      expect(decoded.session_id).toBe("ss_page_3");
      expect(typeof decoded.started_at).toBe("string");
    } finally {
      await store.close();
    }
  });

  it("filters the steps of a session and paginates them", async () => {
    const store = openSqliteStore({ path: ":memory:" });

    try {
      await store.sink.write([
        {
          schema: SCHEMA_VERSION,
          event_id: "ev_step_1",
          project_id: "proj_steps",
          session_id: "ss_steps",
          kind: "tool.call",
          ts: "2026-05-06T10:00:00.000Z",
          turn_id: "turn_steps",
          step_id: "st_1",
          status: "ok",
          attrs: { tool_name: "read", tool_kind: "read", call_id: "call_1" },
          source: { name: "test", format: "json" },
        },
        {
          schema: SCHEMA_VERSION,
          event_id: "ev_step_2",
          project_id: "proj_steps",
          session_id: "ss_steps",
          kind: "tool.call",
          ts: "2026-05-06T10:00:01.000Z",
          turn_id: "turn_steps",
          step_id: "st_2",
          status: "error",
          attrs: { tool_name: "bash", tool_kind: "execute", call_id: "call_2" },
          source: { name: "test", format: "json" },
        },
        {
          schema: SCHEMA_VERSION,
          event_id: "ev_step_3",
          project_id: "proj_steps",
          session_id: "ss_steps",
          kind: "llm.call",
          ts: "2026-05-06T10:00:02.000Z",
          turn_id: "turn_steps",
          step_id: "st_3",
          status: "ok",
          attrs: { provider: "anthropic", model: "claude-opus" },
          source: { name: "test", format: "json" },
        },
      ]);

      const all = await store.query.listSteps({ session_id: "ss_steps" });
      expect(all.items.map((step) => step.step_id)).toEqual(["st_1", "st_2", "st_3"]);

      const tools = await store.query.listSteps({ session_id: "ss_steps", kind: "tool.call" });
      expect(tools.items.map((step) => step.step_id)).toEqual(["st_1", "st_2"]);

      const failed = await store.query.listSteps({ session_id: "ss_steps", status: "error" });
      expect(failed.items.map((step) => step.step_id)).toEqual(["st_2"]);

      const first = await store.query.listSteps({ session_id: "ss_steps", limit: 2 });
      expect(first.items.map((step) => step.step_id)).toEqual(["st_1", "st_2"]);
      expect(first.next_cursor).not.toBeNull();

      const second = await store.query.listSteps({
        session_id: "ss_steps",
        limit: 2,
        cursor: first.next_cursor ?? undefined,
      });
      expect(second.items.map((step) => step.step_id)).toEqual(["st_3"]);
      expect(second.next_cursor).toBeNull();
    } finally {
      await store.close();
    }
  });

  it("loads the content of a step on demand", async () => {
    const store = openSqliteStore({ path: ":memory:" });

    try {
      await store.sink.write([
        {
          schema: SCHEMA_VERSION,
          event_id: "ev_content",
          project_id: "proj_content",
          session_id: "ss_content",
          kind: "tool.call",
          ts: "2026-05-07T10:00:00.000Z",
          step_id: "st_content",
          content: { capture: "full", input: { text: "the input" }, output: { text: "the output" } },
          attrs: {},
          source: { name: "test", format: "json" },
        },
      ]);

      const input = await store.query.getContent?.({
        project_id: "proj_content",
        session_id: "ss_content",
        step_id: "st_content",
        side: "input",
      });
      expect(input?.text).toBe("the input");

      const output = await store.query.getContent?.({
        session_id: "ss_content",
        step_id: "st_content",
        side: "output",
      });
      expect(output?.text).toBe("the output");

      const missing = await store.query.getContent?.({
        session_id: "ss_content",
        step_id: "st_unknown",
        side: "input",
      });
      expect(missing).toBeNull();
    } finally {
      await store.close();
    }
  });

  it("lists the sessions fast when the store holds a realistic amount of data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openmatel-sqlite-perf-"));

    try {
      const store = openSqliteStore({ path: join(directory, "store.db") });
      const events = perfEvents(200, 100);
      expect(events.length).toBe(20_000);

      const writeStart = performance.now();
      for (let index = 0; index < events.length; index += 1000) {
        await store.sink.write(events.slice(index, index + 1000));
      }
      const writeMs = performance.now() - writeStart;

      const durations: number[] = [];
      for (let call = 0; call < 50; call++) {
        const started = performance.now();
        const page = await store.query.listSessions({});
        durations.push(performance.now() - started);
        expect(page.items.length).toBe(200);
      }

      durations.sort((left, right) => left - right);
      const p95 = durations[Math.ceil(durations.length * 0.95) - 1] ?? 0;
      console.log(
        `sqlite: 20000 events in ${writeMs.toFixed(0)}ms, listSessions p95 ${p95.toFixed(1)}ms`,
      );

      // The measurement always runs; the assertion is skipped on CI, where
      // the machines are too noisy to hold a latency budget.
      if (!process.env.CI) {
        expect(p95, `p95 of listSessions was ${p95.toFixed(1)}ms`).toBeLessThan(200);
      }

      await store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** The usage of a model call that reported its numbers. */
const reportedUsage = (): Usage => ({
  input_tokens: 100,
  output_tokens: 20,
  cache_read_tokens: null,
  cache_write_tokens: null,
  reasoning_tokens: null,
  source: "provider",
});

/**
 * Build `sessions × perSession` events.
 *
 * The events are grouped by session, so a write batch touches a handful of
 * sessions — the way a real pipeline delivers them.
 */
const perfEvents = (sessions: number, perSession: number): AgentEvent[] => {
  const events: AgentEvent[] = [];
  const base = Date.parse("2026-01-01T00:00:00.000Z");

  for (let session = 0; session < sessions; session++) {
    const session_id = `ss_perf_${String(session).padStart(4, "0")}`;
    const offset = session * 60_000;

    const push = (index: number, event: Partial<AgentEvent> & { kind: EventKind }): void => {
      events.push({
        schema: SCHEMA_VERSION,
        event_id: `ev_perf_${session}_${index}`,
        project_id: "proj_perf",
        session_id,
        ts: new Date(base + offset + index * 1000).toISOString(),
        attrs: {},
        source: { name: "perf", format: "json" },
        ...event,
      });
    };

    push(0, {
      kind: "session.start",
      attrs: {
        harness: { name: "perf", version: "1.0" },
        model: "model-x",
        cwd: `/repo/perf/${session}`,
        title: `perf session ${session}`,
      },
    });

    for (let index = 1; index < perSession - 1; index++) {
      const kind: EventKind = index % 3 === 0 ? "tool.call" : "llm.call";
      push(index, {
        kind,
        turn_id: `turn_perf_${session}_${Math.floor(index / 10)}`,
        step_id: `st_perf_${session}_${index}`,
        end_ts: new Date(base + offset + index * 1000 + 500).toISOString(),
        status: "ok",
        attrs:
          kind === "tool.call"
            ? { tool_name: "read", tool_kind: "read", call_id: `call_${index}` }
            : { provider: "anthropic", model: "model-x" },
        usage: kind === "llm.call" ? reportedUsage() : null,
      });
    }

    push(perSession - 1, {
      kind: "session.end",
      status: "ok",
      attrs: { end_reason: "completed" },
    });
  }

  return events;
};
