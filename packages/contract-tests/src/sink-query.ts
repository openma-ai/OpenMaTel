/**
 * Sink and Query contract suite.
 *
 * Every store that reads and writes canonical events runs this suite. It is
 * the same suite for SQLite, Postgres, ClickHouse, D1, DuckDB and the
 * in-memory reference implementation, so two stores cannot quietly disagree
 * about idempotency, ordering, usage or pagination.
 *
 * What the suite pins down:
 *
 * - **round trip** — what was written comes back unchanged (event order does
 *   not matter, the event set does);
 * - **idempotency** — writing the same batch twice does not duplicate events;
 * - **convergence** — events that arrive out of order (a child step before
 *   its parent, `turn.end` before `turn.start`) produce the same session tree;
 * - **usage** — `null` stays `null`, `0` stays `0`, in the events *and* in the
 *   summaries, and the coverage is preserved;
 * - **queries** — the session list filters (source, error, text, time range),
 *   the cursor pagination is stable, projects never see each other's
 *   sessions, and steps can be filtered by kind and status;
 * - **content** — a step captured with `capture: "none"` comes back without
 *   any text;
 * - **unknown ids** — `getSession` returns `null` instead of throwing.
 */

import { describe, expect, it } from "vitest";

import {
  buildSessionTree,
  sessionId,
  type AgentEvent,
  type EventKind,
  type Query,
  type SessionDetail,
  type SessionSummary,
  type Sink,
  type StepNode,
  type TurnNode,
} from "@openmatel/core";

import { SAMPLE_STEPS, SAMPLE_TITLE, SAMPLE_TS, makeEvent, sampleSessions } from "./fixtures.js";

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/** What a store has to hand over to run the Sink + Query contract. */
export interface SinkQueryFixture {
  /** The write side. */
  sink: Sink;
  /** The read side. */
  query: Query;
  /** Release the resources of the store. */
  close(): Promise<void>;
}

/**
 * Register the Sink + Query contract for one store.
 *
 * @param name - name of the suite, usually the store id.
 * @param factory - creates a **fresh** store; it is called once per test, so
 *                  every test starts from an empty store.
 */
export function sinkQueryContract(
  name: string,
  factory: () => Promise<SinkQueryFixture>,
): void {
  describe(name, () => {
    it("returns the events that were written", async () => {
      await withStore(factory, async (store) => {
        const session = fixtureSessions().find((item) => item.key === "sample");
        if (!session) throw new Error("missing fixture session");

        await store.sink.write(session.events);

        const detail = await store.query.getSession(session.session_id);
        expect(detail, "the written session must be readable").not.toBeNull();

        expect(byEventId(detail?.events ?? [])).toEqual(byEventId(session.events));
      });
    });

    it("is idempotent: writing the same batch twice does not duplicate events", async () => {
      await withStore(factory, async (store) => {
        const session = fixtureSessions().find((item) => item.key === "sample");
        if (!session) throw new Error("missing fixture session");

        await store.sink.write(session.events);
        await store.sink.write(session.events);

        const detail = await store.query.getSession(session.session_id);
        const events = detail?.events ?? [];
        const ids = events.map((event) => event.event_id);

        expect(new Set(ids).size, "every event id must appear once").toBe(ids.length);
        expect(events.length).toBe(session.events.length);
        expect(byEventId(events)).toEqual(byEventId(session.events));
      });
    });

    it("round-trips segment_id and keeps llm.call attribute nulls null", async () => {
      await withStore(factory, async (store) => {
        const session = fixtureSessions().find((item) => item.key === "sample");
        if (!session) throw new Error("missing fixture session");

        await store.sink.write(session.events);

        const detail = await store.query.getSession(session.session_id);
        expect(detail).not.toBeNull();

        const stored = byEventId(detail?.events ?? []);
        const original = byEventId(session.events);
        expect(stored.map((event) => event.segment_id)).toEqual(
          original.map((event) => event.segment_id),
        );

        const storedBoundary = stored.find((event) => event.kind === "segment.boundary");
        expect(storedBoundary, "the segment.boundary fixture must round-trip").toBeDefined();
        expect(storedBoundary?.segment_id).toBe("seg_1");
        expect(storedBoundary?.attrs.reason).toBe("compaction");

        const originalCall = original.find((event) => event.event_id === "ev_sample_llm_3");
        const storedCall = stored.find((event) => event.event_id === "ev_sample_llm_3");
        expect(storedCall?.attrs).toEqual(originalCall?.attrs);
        expect(storedCall?.attrs.provider).toBeNull();
        expect(storedCall?.attrs.model).toBeNull();
        expect(storedCall?.attrs.context_tokens).toBeNull();
        expect(storedCall?.attrs.stop_reason).toBeNull();
        expect(storedCall?.attrs.latency_ms).toBeNull();
        expect(storedCall?.attrs.ttft_ms).toBeNull();
      });
    });

    it("converges to the same session tree when events arrive out of order", async () => {
      const session = fixtureSessions().find((item) => item.key === "sample");
      if (!session) throw new Error("missing fixture session");

      // A child step arrives before its parent and `turn.end` before
      // `turn.start`, in a separate batch.
      const child = session.events.find(
        (event) => event.step_id === SAMPLE_STEPS.tool_child,
      );
      const turnEnd = session.events.find((event) => event.event_id === "ev_sample_turn_1_end");
      if (!child || !turnEnd) throw new Error("missing fixture events");

      const first = session.events.filter((event) => event === child || event === turnEnd);
      const second = session.events.filter((event) => event !== child && event !== turnEnd);

      const inOrder = await withStore(factory, async (store) => {
        await store.sink.write(session.events);
        return store.query.getSession(session.session_id);
      });

      const outOfOrder = await withStore(factory, async (store) => {
        await store.sink.write(first);
        await store.sink.write(second);
        return store.query.getSession(session.session_id);
      });

      expect(outOfOrder, "the session must be readable after out-of-order writes").not.toBeNull();

      // The tree of the out-of-order store has to be the tree of the in-order
      // store — including the nesting of the child step.
      expect(treeShape(treeOf(outOfOrder))).toEqual(treeShape(treeOf(inOrder)));
      expect(summaryFields(outOfOrder?.summary)).toEqual(summaryFields(inOrder?.summary));

      const steps = flattenSteps(treeOf(outOfOrder));
      const parent = steps.find((step) => step.step_id === SAMPLE_STEPS.tool_ok);
      const nested = parent?.children.find((step) => step.step_id === SAMPLE_STEPS.tool_child);
      expect(nested, "the child step must stay nested in its parent").toBeDefined();
    });

    it("keeps usage nulls null and zeros zero", async () => {
      await withStore(factory, async (store) => {
        const sessions = fixtureSessions();
        const sample = sessions.find((item) => item.key === "sample");
        const zeros = sessions.find((item) => item.key === "usage-zero");
        const missing = sessions.find((item) => item.key === "usage-missing");
        if (!sample || !zeros || !missing) throw new Error("missing fixture sessions");

        await store.sink.write([...sample.events, ...zeros.events, ...missing.events]);

        const sampleDetail = await store.query.getSession(sample.session_id);
        const events = sampleDetail?.events ?? [];
        const byId = new Map(events.map((event) => [event.event_id, event]));

        // A field the source did not report stays null.
        expect(byId.get("ev_sample_llm_1")?.usage?.cache_read_tokens).toBeNull();
        // A field the source reported as zero stays zero.
        expect(byId.get("ev_sample_llm_2")?.usage?.input_tokens).toBe(0);
        // A call without usage keeps an explicit null, not `undefined`.
        const missingUsage = byId.get("ev_sample_llm_3")?.usage;
        expect(missingUsage, "ev_sample_llm_3 must be stored").toBeNull();

        const zerosDetail = await store.query.getSession(zeros.session_id);
        const zeroEvent = zerosDetail?.events.find((event) => event.kind === "llm.call");
        expect(zeroEvent?.usage?.input_tokens).toBe(0);
        expect(zeroEvent?.usage?.output_tokens).toBe(0);

        const missingDetail = await store.query.getSession(missing.session_id);
        const missingEvent = missingDetail?.events.find((event) => event.kind === "llm.call");
        expect(missingEvent?.usage?.input_tokens).toBeNull();

        // The summaries have to tell the same story.
        const page = await store.query.listSessions({ project_id: PROJECT_ID });
        const summaries = new Map(page.items.map((summary) => [summary.session_id, summary]));

        const sampleSummary = summaries.get(sample.session_id);
        expect(sampleSummary?.usage.total.input_tokens).toBe(130);
        expect(sampleSummary?.usage.total.output_tokens).toBe(45);
        // Nobody reported a cache read: the total stays null, it does not become 0.
        expect(sampleSummary?.usage.total.cache_read_tokens).toBeNull();
        expect(sampleSummary?.usage.total.reasoning_tokens).toBeNull();
        expect(sampleSummary?.usage.calls).toBe(4);
        expect(sampleSummary?.usage.covered).toBe(3);
        expect(sampleSummary?.usage.coverage).toBeCloseTo(0.75, 10);

        // Every call reported zero: the total is zero, not null.
        expect(summaries.get(zeros.session_id)?.usage.total.input_tokens).toBe(0);
        expect(summaries.get(zeros.session_id)?.usage.total.output_tokens).toBe(0);
        expect(summaries.get(zeros.session_id)?.usage.coverage).toBe(1);

        // Nobody reported anything: the total stays null and the coverage is 0.
        expect(summaries.get(missing.session_id)?.usage.total.input_tokens).toBeNull();
        expect(summaries.get(missing.session_id)?.usage.total.output_tokens).toBeNull();
        expect(summaries.get(missing.session_id)?.usage.coverage).toBe(0);
      });
    });

    it("filters the session list", async () => {
      await withStore(factory, async (store) => {
        const sessions = fixtureSessions();
        await store.sink.write(sessions.flatMap((session) => session.events));

        const all = await store.query.listSessions({});
        expect(all.items.length).toBe(sessions.length);

        // by source
        const acp = await store.query.listSessions({ source: "acp" });
        expect(acp.items.map((summary) => summary.session_id).sort()).toEqual(
          sessions.filter((session) => session.source === "acp").map((session) => session.session_id).sort(),
        );

        const otlp = await store.query.listSessions({ source: "otlp" });
        expect(otlp.items.map((summary) => summary.session_id)).toEqual([idOf("page-3")]);

        // by error
        const withError = await store.query.listSessions({ has_error: true });
        expect(withError.items.map((summary) => summary.session_id)).toEqual([idOf("sample")]);

        const withoutError = await store.query.listSessions({ has_error: false });
        expect(withoutError.items.map((summary) => summary.session_id).sort()).toEqual(
          sessions
            .filter((session) => session.key !== "sample")
            .map((session) => session.session_id)
            .sort(),
        );

        // by title
        const byText = await store.query.listSessions({ text: "alpha" });
        expect(byText.items.map((summary) => summary.session_id)).toEqual([idOf("page-1")]);

        // by time range: `from` is inclusive, `to` is exclusive
        const byTime = await store.query.listSessions({
          from: "2026-03-02T00:00:00.000Z",
          to: "2026-03-04T00:00:00.000Z",
        });
        expect(byTime.items.map((summary) => summary.session_id).sort()).toEqual(
          [idOf("page-2"), idOf("page-3")].sort(),
        );
      });
    });

    it("paginates the session list with a stable cursor", async () => {
      await withStore(factory, async (store) => {
        const pages = fixtureSessions().filter((session) => session.key.startsWith("page-"));
        await store.sink.write(pages.flatMap((session) => session.events));

        const expected = pages
          .map((session) => ({ session_id: session.session_id, started_at: session.started_at }))
          .sort(compareSessions);

        const collected: string[] = [];
        let cursor: string | undefined;
        let guard = 0;

        for (;;) {
          const page = await store.query.listSessions({ limit: 2, cursor });
          collected.push(...page.items.map((summary) => summary.session_id));
          if (!page.next_cursor) break;
          cursor = page.next_cursor;
          if (++guard > 20) throw new Error("the cursor never ends");
        }

        expect(collected.length).toBe(pages.length);
        expect(new Set(collected).size, "a session must not appear twice").toBe(pages.length);
        expect(collected, "the sessions are ordered by started_at desc, then session id").toEqual(
          expected.map((item) => item.session_id),
        );

        // The first page alone must be the beginning of that order.
        const first = await store.query.listSessions({ limit: 2 });
        expect(first.items.map((summary) => summary.session_id)).toEqual(
          expected.slice(0, 2).map((item) => item.session_id),
        );
      });
    });

    it("never returns the sessions of another project", async () => {
      await withStore(factory, async (store) => {
        const sessions = fixtureSessions();
        await store.sink.write(sessions.flatMap((session) => session.events));

        const mine = await store.query.listSessions({ project_id: PROJECT_ID });
        expect(mine.items.length).toBe(sessions.length - 1);
        expect(
          mine.items.every((summary) => summary.project_id === PROJECT_ID),
          "a project filter must not leak foreign sessions",
        ).toBe(true);

        const theirs = await store.query.listSessions({ project_id: OTHER_PROJECT_ID });
        expect(theirs.items.map((summary) => summary.session_id)).toEqual([idOf("other")]);
        expect(theirs.items.every((summary) => summary.project_id === OTHER_PROJECT_ID)).toBe(true);

        // Without a filter both projects are visible.
        const all = await store.query.listSessions({});
        expect(all.items.length).toBe(sessions.length);
      });
    });

    it("filters steps by kind and status", async () => {
      await withStore(factory, async (store) => {
        const session = fixtureSessions().find((item) => item.key === "sample");
        if (!session) throw new Error("missing fixture session");
        await store.sink.write(session.events);

        const all = await store.query.listSteps({ session_id: session.session_id });
        expect(new Set(all.items.map((step) => step.step_id))).toEqual(
          new Set(Object.values(SAMPLE_STEPS)),
        );

        const tools = await store.query.listSteps({
          session_id: session.session_id,
          kind: "tool.call",
        });
        expect(tools.items.every((step) => step.kind === "tool.call")).toBe(true);
        expect(new Set(tools.items.map((step) => step.step_id))).toEqual(
          new Set([SAMPLE_STEPS.tool_ok, SAMPLE_STEPS.tool_error, SAMPLE_STEPS.tool_child]),
        );

        const failed = await store.query.listSteps({
          session_id: session.session_id,
          status: "error",
        });
        expect(failed.items.every((step) => step.status === "error")).toBe(true);
        expect(new Set(failed.items.map((step) => step.step_id))).toEqual(
          new Set([SAMPLE_STEPS.tool_error]),
        );

        const both = await store.query.listSteps({
          session_id: session.session_id,
          kind: ["tool.call", "llm.call"],
        });
        expect(both.items.every((step) => step.kind === "tool.call" || step.kind === "llm.call")).toBe(
          true,
        );
      });
    });

    it("returns no content for a step captured with capture 'none'", async () => {
      await withStore(factory, async (store) => {
        const session = fixtureSessions().find((item) => item.key === "no-content");
        if (!session) throw new Error("missing fixture session");
        await store.sink.write(session.events);

        const detail = await store.query.getSession(session.session_id);
        const event = detail?.events.find((item) => item.kind === "tool.call");
        expect(event, "the event must be stored").toBeDefined();
        expect(event?.content?.input?.text).toBeUndefined();
        expect(event?.content?.output?.text).toBeUndefined();
        if (event?.content) expect(event.content.capture).toBe("none");
      });
    });

    it("returns null for an unknown session", async () => {
      await withStore(factory, async (store) => {
        expect(await store.query.getSession("ss_does_not_exist")).toBeNull();
      });
    });

    it("aggregates the events it stored", async () => {
      await withStore(factory, async (store) => {
        // `aggregate` is an optional part of the port: a store that does not
        // implement it has nothing to prove here.
        if (typeof store.query.aggregate !== "function") return;

        const session = fixtureSessions().find((item) => item.key === "sample");
        if (!session) throw new Error("missing fixture session");
        await store.sink.write(session.events);

        const detail = await store.query.getSession(session.session_id);
        const result = await store.query.aggregate({ group_by: "kind" });

        expect(result.total, "every stored event has to be aggregated").toBe(
          detail?.events.length,
        );
        expect(result.groups.reduce((sum, group) => sum + group.count, 0)).toBe(
          detail?.events.length,
        );
      });
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/** Project the contract writes most of its sessions to. */
const PROJECT_ID = "proj_contract";

/** Second project, used to check the project isolation. */
const OTHER_PROJECT_ID = "proj_contract_other";

interface FixtureSession {
  /** Short key of the session, used to look it up. */
  key: string;
  session_id: string;
  project_id: string;
  source: string;
  title: string;
  started_at: string;
  events: AgentEvent[];
}

const plus = (iso: string, seconds: number): string =>
  new Date(Date.parse(iso) + seconds * 1000).toISOString();

/**
 * A session with a start, a session end and the given extra events.
 */
const simpleSession = (options: {
  key: string;
  project_id: string;
  source: string;
  title: string;
  started_at: string;
  extra?: Array<Partial<AgentEvent> & { kind: EventKind }>;
}): FixtureSession => {
  const session_id = sessionId("contract", options.key);
  const source = { name: options.source, version: "1.0", format: "jsonl" };
  const common = { project_id: options.project_id, session_id, source };

  const extra = (options.extra ?? []).map((event, index) =>
    makeEvent({
      ...event,
      event_id: event.event_id ?? `ev_${options.key}_${index}`,
      project_id: options.project_id,
      session_id,
      source,
      ts: event.ts ?? plus(options.started_at, index + 1),
    }),
  );

  return {
    key: options.key,
    session_id,
    project_id: options.project_id,
    source: options.source,
    title: options.title,
    started_at: options.started_at,
    events: [
      makeEvent({
        ...common,
        event_id: `ev_${options.key}_session_start`,
        kind: "session.start",
        ts: options.started_at,
        attrs: {
          harness: { name: options.source, version: "1.0" },
          model: "model-x",
          cwd: `/repo/${options.key}`,
          title: options.title,
        },
      }),
      ...extra,
      makeEvent({
        ...common,
        event_id: `ev_${options.key}_session_end`,
        kind: "session.end",
        ts: plus(options.started_at, 3600),
        status: "ok",
        attrs: { end_reason: "completed" },
      }),
    ],
  };
};

/** The zero-usage and the missing-usage sessions. */
const usageZeroSession = (): FixtureSession =>
  simpleSession({
    key: "usage-zero",
    project_id: PROJECT_ID,
    source: "claude-code",
    title: "Zero usage session",
    started_at: "2026-02-01T09:00:00.000Z",
    extra: [
      {
        kind: "llm.call",
        step_id: "st_usage_zero_llm",
        end_ts: "2026-02-01T09:00:02.000Z",
        status: "ok",
        attrs: {
          provider: "anthropic",
          model: "claude-opus",
          context_tokens: null,
          stop_reason: null,
          latency_ms: null,
          ttft_ms: null,
        },
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: null,
          cache_write_tokens: null,
          reasoning_tokens: null,
          source: "provider",
        },
      },
    ],
  });

const usageMissingSession = (): FixtureSession =>
  simpleSession({
    key: "usage-missing",
    project_id: PROJECT_ID,
    source: "acp",
    title: "Missing usage session",
    started_at: "2026-02-02T09:00:00.000Z",
    extra: [
      {
        kind: "llm.call",
        step_id: "st_usage_missing_llm",
        end_ts: "2026-02-02T09:00:02.000Z",
        status: "ok",
        attrs: {
          provider: null,
          model: null,
          context_tokens: null,
          stop_reason: null,
          latency_ms: null,
          ttft_ms: null,
        },
        usage: {
          input_tokens: null,
          output_tokens: null,
          cache_read_tokens: null,
          cache_write_tokens: null,
          reasoning_tokens: null,
          source: "missing",
        },
      },
    ],
  });

const noContentSession = (): FixtureSession =>
  simpleSession({
    key: "no-content",
    project_id: PROJECT_ID,
    source: "sdk-http",
    title: "Captured without content",
    started_at: "2026-02-03T09:00:00.000Z",
    extra: [
      {
        kind: "tool.call",
        step_id: "st_no_content_tool",
        end_ts: "2026-02-03T09:00:02.000Z",
        status: "ok",
        attrs: { tool_name: "read", tool_kind: "read", call_id: "call_nc" },
        content: {
          capture: "none",
          input: { text: "secret input" },
          output: { text: "secret output" },
        },
      },
    ],
  });

/** Five sessions used by the pagination test. */
const pageSessions = (): FixtureSession[] => [
  simpleSession({
    key: "page-1",
    project_id: PROJECT_ID,
    source: "claude-code",
    title: "alpha session",
    started_at: "2026-03-01T10:00:00.000Z",
  }),
  simpleSession({
    key: "page-2",
    project_id: PROJECT_ID,
    source: "acp",
    title: "Beta session",
    started_at: "2026-03-02T10:00:00.000Z",
  }),
  simpleSession({
    key: "page-3",
    project_id: PROJECT_ID,
    source: "otlp",
    title: "Gamma session",
    started_at: "2026-03-03T10:00:00.000Z",
  }),
  simpleSession({
    key: "page-4",
    project_id: PROJECT_ID,
    source: "claude-code",
    title: "Delta session",
    started_at: "2026-03-04T10:00:00.000Z",
  }),
  simpleSession({
    key: "page-5",
    project_id: PROJECT_ID,
    source: "codex",
    title: "Epsilon session",
    started_at: "2026-03-04T10:00:00.000Z",
  }),
];

/** A session of the second project. */
const otherProjectSession = (): FixtureSession =>
  simpleSession({
    key: "other",
    project_id: OTHER_PROJECT_ID,
    source: "claude-code",
    title: "Zulu session",
    started_at: "2026-03-05T10:00:00.000Z",
  });

/** Every session of the contract fixture. */
const fixtureSessions = (): FixtureSession[] => {
  const sample: FixtureSession = {
    key: "sample",
    session_id: sessionId("contract", `sample-${PROJECT_ID}`),
    project_id: PROJECT_ID,
    source: "claude-code",
    title: SAMPLE_TITLE,
    started_at: SAMPLE_TS,
    events: sampleSessions(PROJECT_ID),
  };

  return [
    sample,
    usageZeroSession(),
    usageMissingSession(),
    noContentSession(),
    ...pageSessions(),
    otherProjectSession(),
  ];
};

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

const withStore = async <T>(
  factory: () => Promise<SinkQueryFixture>,
  body: (store: SinkQueryFixture) => Promise<T>,
): Promise<T> => {
  const store = await factory();
  try {
    return await body(store);
  } finally {
    if (typeof store.close === "function") await store.close();
  }
};

const byEventId = (events: AgentEvent[]): AgentEvent[] =>
  [...events].sort((left, right) =>
    left.event_id < right.event_id ? -1 : left.event_id > right.event_id ? 1 : 0,
  );

/** The session id of a fixture session, by key. */
const idOf = (key: string): string => {
  const session = fixtureSessions().find((item) => item.key === key);
  if (!session) throw new Error(`missing fixture session "${key}"`);
  return session.session_id;
};

/** The session order the contract expects: `started_at` desc, then session id. */
const compareSessions = (
  left: { session_id: string; started_at: string },
  right: { session_id: string; started_at: string },
): number => {
  if (left.started_at !== right.started_at) return left.started_at < right.started_at ? 1 : -1;
  return left.session_id < right.session_id ? -1 : left.session_id > right.session_id ? 1 : 0;
};

const summaryFields = (summary: SessionSummary | undefined) => ({
  session_id: summary?.session_id,
  project_id: summary?.project_id,
  source: summary?.source,
  harness: summary?.harness,
  model: summary?.model,
  title: summary?.title,
  cwd: summary?.cwd,
  started_at: summary?.started_at,
  ended_at: summary?.ended_at,
  turn_count: summary?.turn_count,
  segment_count: summary?.segment_count,
  step_count: summary?.step_count,
  tool_call_count: summary?.tool_call_count,
  tool_error_count: summary?.tool_error_count,
  subagent_count: summary?.subagent_count,
  status: summary?.status,
  usage: summary?.usage,
  signal_counts: summary?.signal_counts,
  context_tokens_peak: summary?.context_tokens_peak,
  cache_hit_ratio: summary?.cache_hit_ratio,
  tokens_in: summary?.tokens_in,
});

/** The turns of a session, whether the store builds them or not. */
const treeOf = (detail: SessionDetail | null): TurnNode[] => {
  if (!detail) return [];
  return detail.turns ?? buildSessionTree(detail.events).turns;
};

interface ShapeStep {
  step_id: string;
  kind: EventKind;
  status?: string;
  children: ShapeStep[];
}

const shapeOfSteps = (steps: StepNode[]): ShapeStep[] =>
  steps
    .map((step) => ({
      step_id: step.step_id,
      kind: step.kind,
      status: step.status,
      children: shapeOfSteps(step.children),
    }))
    .sort((left, right) => (left.step_id < right.step_id ? -1 : left.step_id > right.step_id ? 1 : 0));

const treeShape = (turns: TurnNode[]) =>
  turns
    .map((turn) => ({
      turn_id: turn.turn_id,
      segment_id: turn.segment_id,
      status: turn.status,
      steps: shapeOfSteps(turn.steps),
    }))
    .sort((left, right) => (left.turn_id < right.turn_id ? -1 : left.turn_id > right.turn_id ? 1 : 0));

const flattenSteps = (turns: TurnNode[]): StepNode[] =>
  turns.flatMap((turn) => {
    const walk = (steps: StepNode[]): StepNode[] =>
      steps.flatMap((step) => [step, ...walk(step.children)]);
    return walk(turn.steps);
  });
