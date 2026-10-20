/**
 * The platform-agnostic OpenMaTel HTTP server.
 *
 * `createApp` composes the Query API on top of the {@link Query} port and
 * returns a Hono app. It never imports a store: the composition root
 * (`runtime-node`, the CLI, a Worker, …) opens the store and passes its read
 * side in. That keeps the server usable in Node, on Cloudflare Workers and in
 * tests alike.
 */

import { Hono, type Context } from "hono";

import {
  EVENT_KINDS,
  SIGNAL_KINDS,
  STEP_STATUSES,
  buildSessionTree,
  llmCallSeries,
  segmentViews,
  turnViews,
  type AggQuery,
  type EventKind,
  type LlmCallFilter,
  type Query,
  type SessionDetail,
  type SessionQuery,
  type SignalKind,
  type StepQuery,
  type StepStatus,
  type TurnFilter,
} from "@openmatel/core";

/** Resolve a request path to a static asset, or `null` when it does not exist. */
export type StaticAssets = (path: string) => Promise<Response | null>;

/** Desktop token authentication. No token means the server is unauthenticated. */
export interface ServerAuth {
  /** Token required from every request except `GET /v1/health`. */
  token?: string;
}

/** Options of {@link createApp}. */
export interface ServerOptions {
  /** The read side of a store. The server never talks to a store directly. */
  query: Query;
  /** Optional desktop token authentication. */
  auth?: ServerAuth;
  /** Version reported by `GET /v1/health` and in the OpenAPI document. */
  version: string;
  /**
   * Static asset resolver used for every non-`/v1` GET request.
   *
   * It receives a pathname beginning with `/` (for example `/assets/app.js`)
   * and returns `null` when the asset does not exist. When an unknown path is
   * requested, the server tries `/index.html` afterwards, which gives the SPA
   * its client-side routing fallback.
   */
  staticAssets?: StaticAssets;
}

type ApiStatus = 400 | 401 | 403 | 404 | 500 | 501;

/** An error that is rendered as the `{ error: { code, message } }` API shape. */
class ApiError extends Error {
  readonly status: ApiStatus;
  readonly code: string;

  constructor(status: ApiStatus, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

const invalid = (message: string): ApiError => new ApiError(400, "invalid_request", message);
const notFound = (message = "Not Found"): ApiError => new ApiError(404, "not_found", message);

const errorBody = (code: string, message: string) => ({ error: { code, message } });

/** `GET /v1/health` is the only public route. */
const isPublic = (path: string): boolean => path === "/v1/health";

/**
 * Host values that are safe for a loopback deployment.
 *
 * DNS-rebinding attacks make a browser send a request to `127.0.0.1` with an
 * attacker-controlled `Host`; rejecting every Host that is not loopback stops
 * the browser from reading the response. A missing Host (an HTTP/1.0 client or
 * Hono's in-process `app.request`) is left alone.
 */
const isAllowedHost = (header: string): boolean => {
  let host = header.trim().toLowerCase();
  if (host === "") return false;

  // Bracketed IPv6, optionally with a port: [::1]:4319.
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end < 0) return false;
    const address = host.slice(1, end);
    const rest = host.slice(end + 1);
    if (rest !== "" && !/^:\d+$/.test(rest)) return false;
    return address === "::1";
  }

  // Bare IPv6 without a port.
  if (host === "::1") return true;

  // Strip a port from an IPv4 address or a host name.
  const colon = host.lastIndexOf(":");
  if (colon >= 0) {
    const port = host.slice(colon + 1);
    if (!/^\d+$/.test(port)) return false;
    host = host.slice(0, colon);
  }

  return host === "localhost" || host === "127.0.0.1";
};

/** Compare two tokens without an early exit on the first differing byte. */
const tokensEqual = (provided: string, expected: string): boolean => {
  if (provided.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < provided.length; index += 1) {
    difference |= provided.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
};

const readCookie = (header: string | undefined, name: string): string | undefined => {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return undefined;
};

const bearerToken = (header: string | undefined): string | undefined => {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
};

const authCookie = (token: string): string =>
  `omt_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict`;

const unauthorized = () =>
  new ApiError(401, "unauthorized", "Missing or invalid authentication token");

/* -------------------------------------------------------------------------- */
/* Query parameter parsing                                                     */
/* -------------------------------------------------------------------------- */

const stringParam = (params: URLSearchParams, name: string): string | undefined => {
  const value = params.get(name);
  return value === null || value === "" ? undefined : value;
};

const limitParam = (params: URLSearchParams, fallback = 50): number => {
  const raw = params.get("limit");
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw)) throw invalid("limit must be an integer between 1 and 200");
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw invalid("limit must be an integer between 1 and 200");
  }
  return limit;
};

const booleanParam = (params: URLSearchParams, name: string): boolean | undefined => {
  const value = params.get(name);
  if (value === null) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw invalid(`${name} must be either "true" or "false"`);
};

const dateParam = (params: URLSearchParams, name: string): string | undefined => {
  const value = stringParam(params, name);
  if (value === undefined) return undefined;
  const time = Date.parse(value);
  if (Number.isNaN(time)) throw invalid(`${name} must be an ISO 8601 timestamp`);
  return new Date(time).toISOString();
};

const eventKindParam = (params: URLSearchParams): EventKind | undefined => {
  const value = stringParam(params, "kind");
  if (value === undefined) return undefined;
  if (!(EVENT_KINDS as readonly string[]).includes(value)) {
    throw invalid(`kind must be one of ${EVENT_KINDS.join(", ")}`);
  }
  return value as EventKind;
};

const stepStatusParam = (params: URLSearchParams): StepStatus | undefined => {
  const value = stringParam(params, "status");
  if (value === undefined) return undefined;
  if (!(STEP_STATUSES as readonly string[]).includes(value)) {
    throw invalid(`status must be one of ${STEP_STATUSES.join(", ")}`);
  }
  return value as StepStatus;
};

const signalKindParam = (params: URLSearchParams): SignalKind | undefined => {
  const value = stringParam(params, "has_signal");
  if (value === undefined) return undefined;
  if (!(SIGNAL_KINDS as readonly string[]).includes(value)) {
    throw invalid(`has_signal must be one of ${SIGNAL_KINDS.join(", ")}`);
  }
  return value as SignalKind;
};

/* -------------------------------------------------------------------------- */
/* Session lookup                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The base port is exact-id only. An adapter may opt into prefix lookup by
 * implementing `getSessionByPrefix`; when it does not, this stays exact.
 */
type PrefixCapableQuery = Query & {
  getSessionByPrefix?: (idOrPrefix: string) => Promise<SessionDetail | null>;
};

const getSession = async (query: Query, idOrPrefix: string): Promise<SessionDetail | null> => {
  const byPrefix = (query as PrefixCapableQuery).getSessionByPrefix;
  if (typeof byPrefix === "function") return byPrefix.call(query, idOrPrefix);
  return query.getSession(idOrPrefix);
};

/* -------------------------------------------------------------------------- */
/* App                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Create the OpenMaTel HTTP app.
 *
 * @param options - the Query port, auth token, version and static resolver.
 * @returns a Hono app; call `.request()` in tests or `.fetch()` in a runtime.
 */
export function createApp(options: ServerOptions): Hono {
  const { query, auth, version, staticAssets } = options;

  if (!query || typeof query.listSessions !== "function") {
    throw new TypeError("createApp: a Query implementation is required");
  }
  if (typeof version !== "string" || version === "") {
    throw new TypeError("createApp: a version string is required");
  }

  const token = auth?.token;
  const app = new Hono();

  // Security headers apply to every response, including errors and assets.
  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
  });

  // DNS-rebinding protection for the loopback deployment.
  app.use("*", async (c, next) => {
    const host = c.req.header("host");
    if (host !== undefined && !isAllowedHost(host)) {
      return c.json(errorBody("forbidden_host", "Host header is not allowed"), 403);
    }
    await next();
  });

  // Desktop token auth. `/v1/health` stays public.
  app.use("*", async (c, next) => {
    if (token === undefined || token === "" || isPublic(c.req.path)) {
      await next();
      return;
    }

    const url = new URL(c.req.url);
    const queryToken = url.searchParams.get("token");

    if (queryToken !== null) {
      if (!tokensEqual(queryToken, token)) {
        return c.json(errorBody(unauthorized().code, unauthorized().message), 401, {
          "WWW-Authenticate": "Bearer",
        });
      }

      // The browser lands on the same URL, but the token moves from the URL
      // (history, logs, referrers) into an HttpOnly cookie.
      url.searchParams.delete("token");
      const location = `${url.pathname}${url.search}`;
      const response = c.redirect(location, 302);
      response.headers.append("Set-Cookie", authCookie(token));
      response.headers.set("Cache-Control", "no-store");
      return response;
    }

    if (tokensEqual(bearerToken(c.req.header("authorization")) ?? "", token)) {
      await next();
      return;
    }

    if (tokensEqual(readCookie(c.req.header("cookie"), "omt_token") ?? "", token)) {
      await next();
      return;
    }

    return c.json(errorBody(unauthorized().code, unauthorized().message), 401, {
      "WWW-Authenticate": "Bearer",
    });
  });

  app.get("/v1/health", (c) => c.json({ ok: true, version }));

  app.get("/v1/query/sessions", async (c) => {
    const params = new URL(c.req.url).searchParams;
    const q: SessionQuery = {
      project_id: stringParam(params, "project"),
      source: stringParam(params, "source"),
      harness: stringParam(params, "harness"),
      has_error: booleanParam(params, "has_error"),
      has_signal: signalKindParam(params),
      text: stringParam(params, "q"),
      from: dateParam(params, "from"),
      to: dateParam(params, "to"),
      cursor: stringParam(params, "cursor"),
      limit: limitParam(params),
    };
    return c.json(await query.listSessions(q));
  });

  app.get("/v1/query/sessions/:id/steps", async (c) => {
    const params = new URL(c.req.url).searchParams;
    const q: StepQuery = {
      session_id: c.req.param("id"),
      turn_id: stringParam(params, "turn_id"),
      segment_id: stringParam(params, "segment_id"),
      kind: eventKindParam(params),
      status: stepStatusParam(params),
      cursor: stringParam(params, "cursor"),
      limit: limitParam(params),
    };
    return c.json(await query.listSteps(q));
  });

  const requireSession = async (id: string): Promise<SessionDetail> => {
    const detail = await getSession(query, id);
    if (!detail) throw notFound(`Session "${id}" was not found`);
    return detail;
  };

  app.get("/v1/query/sessions/:id/segments", async (c) => {
    const id = c.req.param("id");
    const detail = await requireSession(id);
    const items =
      typeof query.getSegments === "function"
        ? await query.getSegments(id)
        : segmentViews(detail.events);
    return c.json({ items, next_cursor: null });
  });

  app.get("/v1/query/sessions/:id/turns", async (c) => {
    const params = new URL(c.req.url).searchParams;
    const id = c.req.param("id");
    const detail = await requireSession(id);
    const filter: TurnFilter = {
      segment_id: stringParam(params, "segment_id"),
      turn_id: stringParam(params, "turn_id"),
    };
    const items =
      typeof query.getTurns === "function"
        ? await query.getTurns(id, filter)
        : turnViews(detail.events, filter);
    return c.json({ items, next_cursor: null });
  });

  app.get("/v1/query/sessions/:id/llm-calls", async (c) => {
    const params = new URL(c.req.url).searchParams;
    const id = c.req.param("id");
    const detail = await requireSession(id);
    const filter: LlmCallFilter = {
      segment_id: stringParam(params, "segment_id"),
      turn_id: stringParam(params, "turn_id"),
    };
    const items =
      typeof query.getLlmCalls === "function"
        ? await query.getLlmCalls(id, filter)
        : llmCallSeries(detail.events, filter);
    return c.json({ items, next_cursor: null });
  });

  app.get("/v1/query/sessions/:id", async (c) => {
    const id = c.req.param("id");
    const detail = await getSession(query, id);
    if (!detail) throw notFound(`Session "${id}" was not found`);

    const turns =
      detail.turns ?? (Array.isArray(detail.events) ? buildSessionTree(detail.events).turns : []);
    return c.json({ summary: detail.summary, turns });
  });

  app.get("/v1/query/aggregate/tool-errors", async (c) => {
    const params = new URL(c.req.url).searchParams;
    const groupBy = stringParam(params, "group_by") ?? "tool_name";
    if (groupBy !== "tool_name" && groupBy !== "harness" && groupBy !== "model") {
      throw invalid('group_by must be one of "tool_name", "harness" or "model"');
    }

    const q: AggQuery = {
      group_by: groupBy,
      project_id: stringParam(params, "project"),
      from: dateParam(params, "from"),
      to: dateParam(params, "to"),
    };

    if (typeof query.aggregate !== "function") {
      throw new ApiError(
        501,
        "not_implemented",
        "This Query implementation does not support aggregate()",
      );
    }

    return c.json(await query.aggregate(q));
  });

  // Static hosting and SPA fallback. `/v1` never falls through to the SPA.
  app.get("*", async (c) => {
    const pathname = new URL(c.req.url).pathname;
    if (pathname === "/v1" || pathname.startsWith("/v1/")) {
      throw notFound("Route not found");
    }
    if (!staticAssets) throw notFound("Static assets are not configured");

    let response = await staticAssets(pathname);
    if (!response) response = await staticAssets("/index.html");
    if (!response) throw notFound("Asset not found");
    return response;
  });

  app.notFound((c) => c.json(errorBody("not_found", "Route not found"), 404));

  app.onError((error, c) => {
    if (error instanceof ApiError) {
      return c.json(errorBody(error.code, error.message), error.status);
    }
    return c.json(errorBody("internal_error", "Internal Server Error"), 500);
  });

  return app;
}

/** The error shape every route returns. Exported for clients and tests. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}

/** Hono context type used by the handlers above (re-exported for convenience). */
export type ServerContext = Context;
