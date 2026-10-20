/**
 * The data boundary of `@openmatel/ui`.
 *
 * Components never know where data is stored. They only call an injected
 * {@link ObsClient}, which is a tiny fetch wrapper over the HTTP Query API v1.
 * The same client works in the standalone desktop SPA, in an Electron shell
 * and in the openma console.
 */

import type { Page, SessionSummary, TurnNode } from "@openmatel/core";

/** Query parameters of `GET /v1/query/sessions`. */
export interface SessionListParams {
  project?: string;
  source?: string;
  harness?: string;
  has_error?: boolean;
  /** Free-text search over title, cwd and event content (`q` on the wire). */
  q?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}

/** The payload of `GET /v1/query/sessions/:id`. */
export interface ObsSessionDetail {
  summary: SessionSummary;
  turns: TurnNode[];
}

/** The only data access the UI components are allowed to use. */
export interface ObsClient {
  listSessions(params?: SessionListParams): Promise<Page<SessionSummary>>;
  getSession(id: string): Promise<ObsSessionDetail>;
}

/** Options of {@link createObsClient}. */
export interface ObsClientOptions {
  /** Origin of the server, e.g. `http://127.0.0.1:4319`. Empty means same origin. */
  baseUrl?: string;
  /** Optional bearer token. Browser sessions normally use the `omt_token` cookie. */
  token?: string;
  /** Injectable fetch, for tests and non-browser hosts. */
  fetch?: typeof fetch;
}

/** An error response of the Query API, preserving the HTTP status. */
export class ObsApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ObsApiError";
    this.status = status;
    this.code = code;
  }
}

const trimBase = (baseUrl: string): string => baseUrl.replace(/\/+$/, "");

const queryString = (params: SessionListParams): string => {
  const search = new URLSearchParams();
  if (params.project) search.set("project", params.project);
  if (params.source) search.set("source", params.source);
  if (params.harness) search.set("harness", params.harness);
  if (params.has_error !== undefined) search.set("has_error", String(params.has_error));
  if (params.q) search.set("q", params.q);
  if (params.from) search.set("from", params.from);
  if (params.to) search.set("to", params.to);
  if (params.cursor) search.set("cursor", params.cursor);
  if (params.limit !== undefined) search.set("limit", String(params.limit));
  const value = search.toString();
  return value === "" ? "" : `?${value}`;
};

/**
 * Create a fetch-backed {@link ObsClient}.
 *
 * The token query parameter is deliberately not used here: the CLI prints a
 * login URL once, the server exchanges `?token=` for an HttpOnly cookie, and
 * every later request is same-origin with that cookie.
 */
export function createObsClient(options: ObsClientOptions = {}): ObsClient {
  const baseUrl = trimBase(options.baseUrl ?? "");
  const token = options.token;
  const fetchImpl = options.fetch ?? (typeof fetch === "function" ? fetch.bind(globalThis) : undefined);

  const request = async <T>(path: string): Promise<T> => {
    if (fetchImpl === undefined) {
      throw new Error("createObsClient: no fetch implementation is available");
    }

    const headers: Record<string, string> = { accept: "application/json" };
    if (token !== undefined && token !== "") headers.authorization = `Bearer ${token}`;

    const response = await fetchImpl(`${baseUrl}${path}`, {
      headers,
      credentials: "same-origin",
    });

    if (!response.ok) {
      let code = "http_error";
      let message = `HTTP ${response.status}`;
      try {
        const body = (await response.json()) as {
          error?: { code?: unknown; message?: unknown };
        };
        if (typeof body.error?.code === "string") code = body.error.code;
        if (typeof body.error?.message === "string") message = body.error.message;
      } catch {
        // A proxy or an asset route may return a non-JSON error body.
      }
      throw new ObsApiError(response.status, code, message);
    }

    return (await response.json()) as T;
  };

  return {
    listSessions: (params = {}) =>
      request<Page<SessionSummary>>(`/v1/query/sessions${queryString(params)}`),
    getSession: (id) =>
      request<ObsSessionDetail>(`/v1/query/sessions/${encodeURIComponent(id)}`),
  };
}
