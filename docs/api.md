# OpenMaTel API v1

The HTTP Query API the UI (and any other client) uses to read OpenMaTel data.
The server is platform-agnostic: `@openmatel/server` exposes a Hono app, and
`@openmatel/server/node` adds a `node:http` listener. The machine-readable
description is [`packages/server/openapi.json`](../packages/server/openapi.json)
(OpenAPI 3.1).

Base URL in desktop mode: `http://127.0.0.1:4319`.

## Conventions

- All responses are `application/json; charset=utf-8`, except static assets.
- Errors always have the shape below and use the HTTP status of the failure:

  ```json
  { "error": { "code": "invalid_request", "message": "limit must be an integer between 1 and 200" } }
  ```

- `from` is an inclusive ISO 8601 lower bound. `to` is an exclusive upper
  bound. Invalid timestamps are a `400`.
- Lists are cursor-paginated. `limit` defaults to `50` and must be between `1`
  and `200`. Pass the opaque `next_cursor` of a page back as `cursor`; `null`
  means the last page was reached.
- Every response carries `X-Content-Type-Options: nosniff`.

## Authentication

Authentication is optional. When the server is created with
`createApp({ auth: { token } })`, every route except `GET /v1/health`
requires the token through exactly one of:

| Mechanism | Example |
| --- | --- |
| Bearer header | `Authorization: Bearer <token>` |
| Cookie | `Cookie: omt_token=<token>` |
| Query parameter | `GET /v1/query/sessions?token=<token>` |

The query-parameter form is a browser login flow: when the token matches, the
server responds with `302` to the same URL with `token` removed and sets a
cookie:

```http
Set-Cookie: omt_token=<token>; Path=/; HttpOnly; SameSite=Strict
Location: /v1/query/sessions
```

An invalid token returns `401` with `WWW-Authenticate: Bearer`. The token query
parameter is never reflected back in the redirect URL.

## Routes

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/v1/health` | Liveness and server version. Always public. |
| `GET` | `/v1/query/sessions` | Filtered, paginated session summaries. |
| `GET` | `/v1/query/sessions/{id}` | One session: summary plus the turn/step tree. |
| `GET` | `/v1/query/sessions/{id}/steps` | Flat step list of one session. |
| `GET` | `/v1/query/aggregate/tool-errors` | Tool-error aggregation (requires `Query.aggregate`). |
| `GET` | anything else not under `/v1` | Static assets, with SPA fallback to `index.html`. |

### `GET /v1/health`

Response `200`:

```json
{ "ok": true, "version": "0.1.0" }
```

### `GET /v1/query/sessions`

| Parameter | Type | Meaning |
| --- | --- | --- |
| `project` | string | Project id (`project_id`). |
| `source` | string | Source name, e.g. `claude-code`. |
| `harness` | string | Harness name, e.g. `claude-code`. |
| `has_error` | `true` \| `false` | Only sessions with/without a failed step. |
| `q` | string | Free-text search over title, cwd and event content. |
| `from` | ISO 8601 | Inclusive session start bound. |
| `to` | ISO 8601 | Exclusive session start bound. |
| `cursor` | string | `next_cursor` of the previous page. |
| `limit` | integer | Page size, `1..200`, default `50`. |

Response `200` is `Page<SessionSummary>`:

```json
{
  "items": [
    {
      "session_id": "ss_…",
      "project_id": "proj_1",
      "source": "claude-code",
      "harness": "claude-code",
      "model": "claude-opus",
      "title": "Fix the login bug",
      "cwd": "/repo",
      "started_at": "2026-01-02T03:00:00.000Z",
      "ended_at": "2026-01-02T03:00:50.000Z",
      "turn_count": 2,
      "step_count": 9,
      "tool_call_count": 3,
      "tool_error_count": 1,
      "subagent_count": 1,
      "usage": {
        "total": {
          "input_tokens": 130,
          "output_tokens": 45,
          "cache_read_tokens": null,
          "cache_write_tokens": null,
          "reasoning_tokens": null,
          "cost_usd": null
        },
        "calls": 4,
        "covered": 3,
        "coverage": 0.75
      },
      "status": "ok"
    }
  ],
  "next_cursor": null
}
```

### `GET /v1/query/sessions/{id}`

Returns the stored summary and the core `buildSessionTree` output. Steps are
nested through `children`; turn objects also carry their flat `events`.

```json
{
  "summary": { "session_id": "ss_…", "…": "…" },
  "turns": [
    {
      "turn_id": "turn_1",
      "ts": "2026-01-02T03:00:01.000Z",
      "end_ts": "2026-01-02T03:00:22.000Z",
      "status": "ok",
      "events": [],
      "steps": [
        {
          "step_id": "st_1",
          "kind": "tool.call",
          "status": "error",
          "ts": "2026-01-02T03:00:08.000Z",
          "end_ts": "2026-01-02T03:00:09.000Z",
          "title": "bash",
          "attrs": { "tool_name": "bash", "tool_kind": "execute" },
          "error": { "type": "ENOENT", "message": "no such file" },
          "usage": null,
          "source": { "name": "claude-code", "format": "jsonl" },
          "children": []
        }
      ]
    }
  ]
}
```

Lookup is exact by default. A store that implements the optional
`getSessionByPrefix(idOrPrefix)` capability opts into id-prefix lookup; all
other stores return exact matches only. A missing session is `404`.

### `GET /v1/query/sessions/{id}/steps`

| Parameter | Type | Meaning |
| --- | --- | --- |
| `kind` | `EventKind` | One canonical kind, e.g. `tool.call`, `llm.call`. |
| `status` | `StepStatus` | `ok`, `error`, `cancelled`, `interrupted`, `denied`, `timeout`. |
| `cursor` | string | `next_cursor` of the previous page. |
| `limit` | integer | Page size, `1..200`, default `50`. |

Response `200` is `Page<Step>`. An unknown session id yields an empty page.
Invalid `kind`, `status` or `limit` yields `400`.

### `GET /v1/query/aggregate/tool-errors`

| Parameter | Type | Meaning |
| --- | --- | --- |
| `group_by` | `tool_name` \| `harness` \| `model` | Grouping dimension. Default `tool_name`. |
| `project` | string | Restrict to one project. |
| `from` / `to` | ISO 8601 | Inclusive/exclusive event time bounds. |

The route delegates to `Query.aggregate` and returns its `AggResult`
(`{ groups, total }`). If the injected Query implementation has no
`aggregate()`, the response is `501 not_implemented`.

### Static assets

Any `GET` that does not start with `/v1` is handed to the optional
`staticAssets(path)` resolver with a leading-slash pathname. If it returns
`null`, `/index.html` is tried next, so a single-page app can own client-side
routes. Unknown `/v1` paths never fall through to the SPA and return the JSON
`404` shape instead. Static responses keep `X-Content-Type-Options: nosniff`
and are protected by token auth like every other non-health route.

## Status codes

| Status | When |
| --- | --- |
| `200` | Successful read. |
| `302` | Valid `?token=` login redirect (sets `omt_token`). |
| `400` | Invalid query parameter or timestamp. |
| `401` | Token configured and missing/invalid. |
| `403` | `Host` header is not `localhost`, `127.0.0.1` or `[::1]`. |
| `404` | Unknown session or route. |
| `500` | Unexpected server error. |
| `501` | Aggregation requested but `Query.aggregate` is not implemented. |

## Security and deployment

- `serveNode` binds `127.0.0.1:4319` by default; loopback is the desktop
  default. Opt into another interface explicitly with `{ host, port }`.
- Requests whose `Host` header is present and not a loopback name are rejected
  with `403` (DNS-rebinding protection). A missing `Host` is tolerated for
  HTTP/1.0 and for in-process `app.request()` tests.
- The server package depends only on `@openmatel/core` and `hono`. It never
  imports a store: the composition root passes a `Query` implementation in.
