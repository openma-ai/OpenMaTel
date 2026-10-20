import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import { sessionId, type Query, type SessionDetail } from "@openmatel/core";
import {
  SAMPLE_SEGMENT_1,
  SAMPLE_SEGMENT_2,
  SAMPLE_STEPS,
  SAMPLE_TITLE,
  SAMPLE_TURN_1,
  SAMPLE_TURN_2,
  createMemoryStore,
  makeEvent,
  sampleSessionId,
  sampleSessions,
} from "@openmatel/contract-tests";

import { createApp } from "./index.js";
import { serveNode } from "./node.js";

const PROJECT_A = "proj_a";
const PROJECT_B = "proj_b";
const VERSION = "9.9.9";

const seeded = async () => {
  const store = createMemoryStore();
  await store.sink.write([...sampleSessions(PROJECT_A), ...sampleSessions(PROJECT_B)]);
  const app = createApp({ query: store.query, version: VERSION });
  return { store, app };
};

const request = (app: ReturnType<typeof createApp>, path: string, init?: RequestInit) =>
  app.request(`http://localhost${path}`, init);

const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;

describe("GET /v1/health", () => {
  it("reports ok and the version", async () => {
    const { app } = await seeded();
    const response = await request(app, "/v1/health");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await json(response)).toEqual({ ok: true, version: VERSION });
  });
});

describe("GET /v1/query/sessions", () => {
  it("lists sessions and filters by project, source, harness and text", async () => {
    const { app } = await seeded();

    const all = await json<{ items: Array<{ session_id: string }>; next_cursor: null }>(
      await request(app, "/v1/query/sessions"),
    );
    expect(all.items).toHaveLength(2);
    expect(all.next_cursor).toBeNull();

    const byProject = await json<{ items: Array<{ project_id: string }> }>(
      await request(app, `/v1/query/sessions?project=${PROJECT_A}`),
    );
    expect(byProject.items).toHaveLength(1);
    expect(byProject.items[0]?.project_id).toBe(PROJECT_A);

    for (const filter of ["source=claude-code", "harness=claude-code"]) {
      const page = await json<{ items: unknown[] }>(
        await request(app, `/v1/query/sessions?${filter}`),
      );
      expect(page.items).toHaveLength(2);
    }

    const byText = await json<{ items: Array<{ title: string }> }>(
      await request(app, `/v1/query/sessions?q=${encodeURIComponent(SAMPLE_TITLE)}`),
    );
    expect(byText.items).toHaveLength(2);
    expect(byText.items[0]?.title).toBe(SAMPLE_TITLE);

    const noMatch = await json<{ items: unknown[] }>(
      await request(app, "/v1/query/sessions?q=definitely-not-there"),
    );
    expect(noMatch.items).toHaveLength(0);
  });

  it("filters on has_error and on the time range", async () => {
    const { app } = await seeded();

    const withError = await json<{ items: Array<{ tool_error_count: number }> }>(
      await request(app, "/v1/query/sessions?has_error=true"),
    );
    expect(withError.items).toHaveLength(2);
    expect(withError.items.every((item) => item.tool_error_count > 0)).toBe(true);

    const withoutError = await json<{ items: unknown[] }>(
      await request(app, "/v1/query/sessions?has_error=false"),
    );
    expect(withoutError.items).toHaveLength(0);

    const from = encodeURIComponent("2026-01-02T03:00:00.000Z");
    const included = await json<{ items: unknown[] }>(
      await request(app, `/v1/query/sessions?from=${from}`),
    );
    expect(included.items).toHaveLength(2);

    const excluded = await json<{ items: unknown[] }>(
      await request(app, `/v1/query/sessions?to=${from}`),
    );
    expect(excluded.items).toHaveLength(0);
  });

  it("paginates with an opaque cursor", async () => {
    const { app } = await seeded();

    const first = await json<{ items: Array<{ session_id: string }>; next_cursor: string | null }>(
      await request(app, "/v1/query/sessions?limit=1"),
    );
    expect(first.items).toHaveLength(1);
    expect(first.next_cursor).not.toBeNull();

    const second = await json<{
      items: Array<{ session_id: string }>;
      next_cursor: string | null;
    }>(await request(app, `/v1/query/sessions?limit=1&cursor=${first.next_cursor}`));
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.session_id).not.toBe(first.items[0]?.session_id);
    expect(second.next_cursor).toBeNull();
  });

  it("rejects invalid filters with 400", async () => {
    const { app } = await seeded();

    for (const query of [
      "limit=0",
      "limit=201",
      "limit=abc",
      "has_error=yes",
      "from=not-a-date",
      "to=yesterday",
    ]) {
      const response = await request(app, `/v1/query/sessions?${query}`);
      expect(response.status, query).toBe(400);
      const body = await json<{ error: { code: string; message: string } }>(response);
      expect(body.error.code).toBe("invalid_request");
      expect(body.error.message.length).toBeGreaterThan(0);
    }
  });
});

describe("GET /v1/query/sessions/:id", () => {
  it("returns the summary and the core buildSessionTree output", async () => {
    const { app, store } = await seeded();
    const id = sampleSessionId(PROJECT_A);

    const response = await request(app, `/v1/query/sessions/${id}`);
    expect(response.status).toBe(200);

    const body = await json<{
      summary: { session_id: string; turn_count: number };
      turns: Array<{
        turn_id: string;
        steps: Array<{
          step_id: string;
          children: Array<{ step_id: string }>;
          error?: { type: string };
        }>;
      }>;
    }>(response);

    const detail = await store.query.getSession(id);
    expect(detail).not.toBeNull();
    expect(body).toEqual({ summary: detail?.summary, turns: detail?.turns });

    expect(body.summary.session_id).toBe(id);
    expect(body.summary.turn_count).toBe(2);
    expect(body.turns).toHaveLength(2);

    const firstTurn = body.turns.find((turn) => turn.turn_id === "turn_sample_1");
    expect(firstTurn).toBeDefined();
    const parent = firstTurn?.steps.find((step) => step.step_id === SAMPLE_STEPS.tool_ok);
    expect(parent?.children.map((child) => child.step_id)).toEqual([SAMPLE_STEPS.tool_child]);
    const failed = firstTurn?.steps.find((step) => step.step_id === SAMPLE_STEPS.tool_error);
    expect(failed?.error?.type).toBe("ENOENT");
  });

  it("is exact-id only when the Query adapter does not support prefixes", async () => {
    const { app } = await seeded();
    const id = sampleSessionId(PROJECT_A);
    const response = await request(app, `/v1/query/sessions/${id.slice(0, 10)}`);
    expect(response.status).toBe(404);
    const body = await json<{ error: { code: string } }>(response);
    expect(body.error.code).toBe("not_found");
  });

  it("uses a prefix-aware adapter when one is provided", async () => {
    const store = createMemoryStore();
    await store.sink.write(sampleSessions(PROJECT_A));
    const id = sampleSessionId(PROJECT_A);
    const query: Query & {
      getSessionByPrefix: (prefix: string) => Promise<SessionDetail | null>;
    } = {
      ...store.query,
      getSessionByPrefix: async (prefix: string) =>
        prefix.length > 0 ? store.query.getSession(id) : null,
    };
    const app = createApp({ query, version: VERSION });
    const response = await request(app, `/v1/query/sessions/${id.slice(0, 10)}`);
    expect(response.status).toBe(200);
  });

  it("returns 404 for an unknown session", async () => {
    const { app } = await seeded();
    const response = await request(app, "/v1/query/sessions/does-not-exist");
    expect(response.status).toBe(404);
    const body = await json<{ error: { code: string; message: string } }>(response);
    expect(body.error.code).toBe("not_found");
  });
});

describe("GET /v1/query/sessions/:id/steps", () => {
  it("lists steps and filters by kind and status", async () => {
    const { app } = await seeded();
    const id = sampleSessionId(PROJECT_A);

    const all = await json<{ items: Array<{ step_id: string }>; next_cursor: null }>(
      await request(app, `/v1/query/sessions/${id}/steps`),
    );
    expect(all.items).toHaveLength(9);

    const tools = await json<{ items: Array<{ kind: string }> }>(
      await request(app, `/v1/query/sessions/${id}/steps?kind=tool.call`),
    );
    expect(tools.items).toHaveLength(3);
    expect(tools.items.every((step) => step.kind === "tool.call")).toBe(true);

    const failed = await json<{ items: Array<{ step_id: string; status: string }> }>(
      await request(app, `/v1/query/sessions/${id}/steps?status=error`),
    );
    expect(failed.items).toHaveLength(1);
    expect(failed.items[0]?.step_id).toBe(SAMPLE_STEPS.tool_error);
    expect(failed.items[0]?.status).toBe("error");
  });

  it("paginates steps", async () => {
    const { app } = await seeded();
    const id = sampleSessionId(PROJECT_A);

    const first = await json<{ items: Array<{ step_id: string }>; next_cursor: string | null }>(
      await request(app, `/v1/query/sessions/${id}/steps?limit=2`),
    );
    expect(first.items).toHaveLength(2);
    expect(first.next_cursor).not.toBeNull();

    const second = await json<{ items: Array<{ step_id: string }> }>(
      await request(app, `/v1/query/sessions/${id}/steps?limit=2&cursor=${first.next_cursor}`),
    );
    expect(second.items).toHaveLength(2);
    expect(second.items[0]?.step_id).not.toBe(first.items[0]?.step_id);
  });

  it("returns an empty page for an unknown session", async () => {
    const { app } = await seeded();
    const page = await json<{ items: unknown[]; next_cursor: null }>(
      await request(app, "/v1/query/sessions/nope/steps"),
    );
    expect(page).toEqual({ items: [], next_cursor: null });
  });

  it("rejects invalid kind, status and limit with 400", async () => {
    const { app } = await seeded();
    const id = sampleSessionId(PROJECT_A);
    for (const query of ["kind=nope", "status=nope", "limit=0", "limit=abc"]) {
      const response = await request(app, `/v1/query/sessions/${id}/steps?${query}`);
      expect(response.status, query).toBe(400);
    }
  });
});

describe("layered session query routes", () => {
  it("returns segments with boundaries and turns", async () => {
    const { app } = await seeded();
    const id = sampleSessionId(PROJECT_A);

    const response = await request(app, `/v1/query/sessions/${id}/segments`);
    expect(response.status).toBe(200);
    const body = await json<{
      items: Array<{
        segment_id: string;
        boundary?: { event_id: string };
        turn_count: number;
        turns: Array<{ turn_id: string }>;
      }>;
      next_cursor: null;
    }>(response);

    expect(body.next_cursor).toBeNull();
    expect(body.items.map((segment) => segment.segment_id)).toEqual([
      SAMPLE_SEGMENT_1,
      SAMPLE_SEGMENT_2,
    ]);
    expect(body.items[0]?.boundary).toBeUndefined();
    expect(body.items[1]?.boundary?.event_id).toBe("ev_sample_segment_boundary");
    expect(body.items[1]?.turn_count).toBe(1);
    expect(body.items[1]?.turns.map((turn) => turn.turn_id)).toEqual([SAMPLE_TURN_2]);
  });

  it("returns turns with summaries and signals, filtered by segment", async () => {
    const { app } = await seeded();
    const id = sampleSessionId(PROJECT_A);

    const response = await request(app, `/v1/query/sessions/${id}/turns`);
    expect(response.status).toBe(200);
    const body = await json<{
      items: Array<{
        turn_id: string;
        segment_id: string;
        prompt: string | null;
        signals: unknown[];
        summary: { step_count: number; signals: unknown[] };
        step_count: number;
      }>;
      next_cursor: null;
    }>(response);

    expect(body.items.map((turn) => turn.turn_id)).toEqual([SAMPLE_TURN_1, SAMPLE_TURN_2]);
    expect(body.items[0]?.prompt).toBe("please fix the login bug");
    expect(body.items[0]?.signals).toEqual(body.items[0]?.summary.signals);
    expect(body.items[0]?.step_count).toBe(body.items[0]?.summary.step_count);

    const filtered = await json<{ items: Array<{ turn_id: string }> }>(
      await request(
        app,
        `/v1/query/sessions/${id}/turns?segment_id=${SAMPLE_SEGMENT_2}`,
      ),
    );
    expect(filtered.items.map((turn) => turn.turn_id)).toEqual([SAMPLE_TURN_2]);
  });

  it("returns the LLM call series and applies both filters", async () => {
    const { app } = await seeded();
    const id = sampleSessionId(PROJECT_A);

    const all = await json<{
      items: Array<{
        step_id: string;
        segment_id: string;
        context_tokens: number | null;
        context_delta: number | null;
        watermark: number | null;
        cache_hit_ratio: number | null;
        usage: unknown;
      }>;
    }>(await request(app, `/v1/query/sessions/${id}/llm-calls`));
    expect(all.items.map((call) => call.step_id)).toEqual([
      SAMPLE_STEPS.llm_1,
      SAMPLE_STEPS.llm_2,
      SAMPLE_STEPS.llm_3,
      SAMPLE_STEPS.llm_4,
    ]);
    expect(all.items.every((call) => call.context_tokens === null)).toBe(true);
    expect(all.items.every((call) => call.watermark === null)).toBe(true);
    expect(all.items[2]?.usage).toBeNull();

    const byTurn = await json<{ items: Array<{ step_id: string }> }>(
      await request(
        app,
        `/v1/query/sessions/${id}/llm-calls?turn_id=${SAMPLE_TURN_1}`,
      ),
    );
    expect(byTurn.items.map((call) => call.step_id)).toEqual([
      SAMPLE_STEPS.llm_1,
      SAMPLE_STEPS.llm_2,
      SAMPLE_STEPS.llm_3,
    ]);

    const bySegment = await json<{ items: Array<{ step_id: string }> }>(
      await request(
        app,
        `/v1/query/sessions/${id}/llm-calls?segment_id=${SAMPLE_SEGMENT_2}`,
      ),
    );
    expect(bySegment.items.map((call) => call.step_id)).toEqual([SAMPLE_STEPS.llm_4]);
  });

  it("filters steps by segment and turn", async () => {
    const { app } = await seeded();
    const id = sampleSessionId(PROJECT_A);

    const bySegment = await json<{ items: Array<{ step_id: string; segment_id?: string }> }>(
      await request(
        app,
        `/v1/query/sessions/${id}/steps?segment_id=${SAMPLE_SEGMENT_2}`,
      ),
    );
    expect(bySegment.items.map((step) => step.step_id)).toEqual([SAMPLE_STEPS.llm_4]);

    const byTurn = await json<{ items: Array<{ step_id: string; turn_id?: string }> }>(
      await request(
        app,
        `/v1/query/sessions/${id}/steps?turn_id=${SAMPLE_TURN_1}`,
      ),
    );
    expect(byTurn.items.some((step) => step.step_id === SAMPLE_STEPS.llm_4)).toBe(false);
    expect(byTurn.items.every((step) => step.turn_id === SAMPLE_TURN_1)).toBe(true);
  });

  it("filters the session list by has_signal", async () => {
    const { app, store } = await seeded();
    const signalSession = sessionId("server", "signals");
    await store.sink.write([
      makeEvent({
        event_id: "ev_server_signal_start",
        project_id: PROJECT_A,
        session_id: signalSession,
        segment_id: "seg_0",
        kind: "session.start",
        ts: "2026-06-01T09:00:00.000Z",
        attrs: { harness: { name: "test" }, title: "signals" },
      }),
      makeEvent({
        event_id: "ev_server_signal_interrupt",
        project_id: PROJECT_A,
        session_id: signalSession,
        segment_id: "seg_0",
        kind: "control.interrupt",
        turn_id: "turn_server_signal_1",
        step_id: "st_server_signal_interrupt",
        ts: "2026-06-01T09:00:01.000Z",
        attrs: { reason: "user" },
      }),
      makeEvent({
        event_id: "ev_server_signal_correction",
        project_id: PROJECT_A,
        session_id: signalSession,
        segment_id: "seg_0",
        kind: "message.user",
        turn_id: "turn_server_signal_2",
        ts: "2026-06-01T09:00:02.000Z",
        attrs: { role: "user" },
        content: { capture: "full", input: { text: "actually, use the other file" } },
      }),
    ]);

    const interrupted = await json<{ items: Array<{ session_id: string }> }>(
      await request(app, "/v1/query/sessions?has_signal=user_interrupt"),
    );
    expect(interrupted.items.map((summary) => summary.session_id)).toEqual([signalSession]);

    const corrected = await json<{ items: Array<{ session_id: string }> }>(
      await request(app, "/v1/query/sessions?has_signal=user_correction"),
    );
    expect(corrected.items.map((summary) => summary.session_id)).toEqual([signalSession]);

    const loop = await json<{ items: unknown[] }>(
      await request(app, "/v1/query/sessions?has_signal=loop"),
    );
    expect(loop.items).toEqual([]);

    const invalid = await request(app, "/v1/query/sessions?has_signal=nope");
    expect(invalid.status).toBe(400);
  });

  it("returns 404 for an unknown session on every new route", async () => {
    const { app } = await seeded();
    for (const suffix of ["segments", "turns", "llm-calls"]) {
      const response = await request(app, `/v1/query/sessions/does-not-exist/${suffix}`);
      expect(response.status, suffix).toBe(404);
      const body = await json<{ error: { code: string } }>(response);
      expect(body.error.code).toBe("not_found");
    }
  });
});

describe("GET /v1/query/aggregate/tool-errors", () => {
  it("delegates to Query.aggregate", async () => {
    const { app } = await seeded();
    const response = await request(app, "/v1/query/aggregate/tool-errors?group_by=tool_name");
    expect(response.status).toBe(200);
    const body = await json<{ groups: Array<{ key: string; count: number }>; total: number }>(
      response,
    );
    expect(body.total).toBeGreaterThan(0);
    expect(body.groups.find((group) => group.key === "bash")?.count).toBeGreaterThan(0);
  });

  it("applies the time range", async () => {
    const { app } = await seeded();
    const response = await request(
      app,
      "/v1/query/aggregate/tool-errors?from=2030-01-01T00:00:00.000Z",
    );
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ groups: [], total: 0 });
  });

  it("validates group_by", async () => {
    const { app } = await seeded();
    const response = await request(app, "/v1/query/aggregate/tool-errors?group_by=nope");
    expect(response.status).toBe(400);
  });

  it("returns 501 when the Query adapter has no aggregate()", async () => {
    const store = createMemoryStore();
    await store.sink.write(sampleSessions(PROJECT_A));
    const query: Query = {
      listSessions: store.query.listSessions,
      getSession: store.query.getSession,
      listSteps: store.query.listSteps,
      getSegments: store.query.getSegments,
      getTurns: store.query.getTurns,
      getLlmCalls: store.query.getLlmCalls,
    };
    const app = createApp({ query, version: VERSION });
    const response = await request(app, "/v1/query/aggregate/tool-errors");
    expect(response.status).toBe(501);
    const body = await json<{ error: { code: string } }>(response);
    expect(body.error.code).toBe("not_implemented");
  });
});

describe("authentication", () => {
  const TOKEN = "s3cret-token";
  const authed = async () => {
    const store = createMemoryStore();
    await store.sink.write(sampleSessions(PROJECT_A));
    const app = createApp({
      query: store.query,
      version: VERSION,
      auth: { token: TOKEN },
    });
    return app;
  };

  it("keeps /v1/health public and protects every other route", async () => {
    const app = await authed();
    expect((await request(app, "/v1/health")).status).toBe(200);

    const id = sampleSessionId(PROJECT_A);
    for (const path of [
      "/v1/query/sessions",
      `/v1/query/sessions/${id}/segments`,
      `/v1/query/sessions/${id}/turns`,
      `/v1/query/sessions/${id}/llm-calls`,
    ]) {
      const response = await request(app, path);
      expect(response.status, path).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
      const body = await json<{ error: { code: string } }>(response);
      expect(body.error.code).toBe("unauthorized");
    }
  });

  it("accepts a bearer header", async () => {
    const app = await authed();
    const response = await request(app, "/v1/query/sessions", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);

    const wrong = await request(app, "/v1/query/sessions", {
      headers: { authorization: "Bearer wrong" },
    });
    expect(wrong.status).toBe(401);
  });

  it("accepts the omt_token cookie", async () => {
    const app = await authed();
    const response = await request(app, "/v1/query/sessions", {
      headers: { cookie: `other=1; omt_token=${TOKEN}` },
    });
    expect(response.status).toBe(200);
  });

  it("moves ?token= into an HttpOnly cookie and redirects without it", async () => {
    const app = await authed();
    const response = await request(
      app,
      `/v1/query/sessions?project=${PROJECT_A}&token=${TOKEN}`,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`/v1/query/sessions?project=${PROJECT_A}`);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`omt_token=${TOKEN}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");

    const followed = await request(app, response.headers.get("location") ?? "/", {
      headers: { cookie: cookie.split(";")[0] ?? "" },
    });
    expect(followed.status).toBe(200);
  });

  it("rejects an invalid ?token= without setting a cookie", async () => {
    const app = await authed();
    const response = await request(app, `/v1/query/sessions?token=wrong`);
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});

describe("security", () => {
  it("rejects a non-loopback Host header", async () => {
    const { app } = await seeded();

    for (const host of ["evil.example", "localhost.evil.example", "127.0.0.1.evil"]) {
      const response = await request(app, "/v1/health", { headers: { host } });
      expect(response.status, host).toBe(403);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      const body = await json<{ error: { code: string } }>(response);
      expect(body.error.code).toBe("forbidden_host");
    }
  });

  it("accepts loopback Host headers", async () => {
    const { app } = await seeded();
    for (const host of ["localhost", "localhost:4319", "127.0.0.1:4319", "[::1]:4319"]) {
      const response = await request(app, "/v1/health", { headers: { host } });
      expect(response.status, host).toBe(200);
    }
  });

  it("sets nosniff on JSON errors", async () => {
    const { app } = await seeded();
    const response = await request(app, "/v1/nope");
    expect(response.status).toBe(404);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("static assets and SPA fallback", () => {
  it("serves assets and falls back to index.html for unknown paths", async () => {
    const { store } = await seeded();
    const seen: string[] = [];
    const app = createApp({
      query: store.query,
      version: VERSION,
      staticAssets: async (path) => {
        seen.push(path);
        if (path === "/assets/app.js") {
          return new Response("console.log('app')", {
            headers: { "content-type": "text/javascript" },
          });
        }
        if (path === "/index.html") {
          return new Response("<html>app</html>", { headers: { "content-type": "text/html" } });
        }
        return null;
      },
    });

    const asset = await request(app, "/assets/app.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await asset.text()).toBe("console.log('app')");

    seen.length = 0;
    const page = await request(app, "/sessions/abc");
    expect(page.status).toBe(200);
    expect(await page.text()).toBe("<html>app</html>");
    expect(seen).toEqual(["/sessions/abc", "/index.html"]);

    seen.length = 0;
    const root = await request(app, "/");
    expect(root.status).toBe(200);
    expect(seen).toEqual(["/", "/index.html"]);
  });

  it("never sends /v1 requests to the SPA", async () => {
    const { store } = await seeded();
    let called = false;
    const app = createApp({
      query: store.query,
      version: VERSION,
      staticAssets: async () => {
        called = true;
        return new Response("spa");
      },
    });

    const response = await request(app, "/v1/does-not-exist");
    expect(response.status).toBe(404);
    expect(called).toBe(false);
  });

  it("returns 404 when no static resolver is configured", async () => {
    const { app } = await seeded();
    const response = await request(app, "/some/page");
    expect(response.status).toBe(404);
    const body = await json<{ error: { code: string } }>(response);
    expect(body.error.code).toBe("not_found");
  });

  it("protects static assets with the token", async () => {
    const { store } = await seeded();
    let called = false;
    const app = createApp({
      query: store.query,
      version: VERSION,
      auth: { token: "token" },
      staticAssets: async () => {
        called = true;
        return new Response("spa");
      },
    });

    const response = await request(app, "/");
    expect(response.status).toBe(401);
    expect(called).toBe(false);
  });
});

describe("@openmatel/server/node", () => {
  it("serves the app over node:http on loopback", async () => {
    const { app } = await seeded();
    const server = serveNode(app, { host: "127.0.0.1", port: 0 });
    try {
      await once(server, "listening");
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/v1/health`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, version: VERSION });
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
