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
| `GET` | `/v1/query/sessions/{id}/segments` | Context segments, their boundaries, turns and metrics. |
| `GET` | `/v1/query/sessions/{id}/turns` | Turn summaries and detected signals. |
| `GET` | `/v1/query/sessions/{id}/llm-calls` | Per-call context, delta, watermark, cache and latency series. |
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
| `has_signal` | signal kind | Only sessions with this detected signal. |
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
      "segment_count": 2,
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
      "signal_counts": {},
      "context_tokens_peak": null,
      "cache_hit_ratio": null,
      "tokens_in": null,
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
          "segment_id": "seg_0",
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

### `GET /v1/query/sessions/{id}/segments`

Returns the context segments of a session in order. The first segment is
`seg_0` and has no boundary; every later segment is opened by a
`segment.boundary` event. A segment keeps its turns, so the UI can collapse a
single `seg_0` or render each boundary.

Response `200` is a page-shaped object; these lists are not paginated, so
`next_cursor` is always `null`:

```json
{
  "items": [
    {
      "segment_id": "seg_0",
      "turns": [],
      "turn_count": 1,
      "step_count": 8,
      "tool_call_count": 3,
      "tool_error_count": 1,
      "llm_calls": 3,
      "started_at": "2026-01-02T03:00:01.000Z",
      "ended_at": "2026-01-02T03:00:22.000Z",
      "status": "ok",
      "usage": {
        "total": {
          "input_tokens": 120,
          "output_tokens": 45,
          "cache_read_tokens": null,
          "cache_write_tokens": null,
          "reasoning_tokens": null,
          "cost_usd": null
        },
        "calls": 3,
        "covered": 2,
        "coverage": 0.6666666666666666
      },
      "context_tokens_peak": null,
      "cache_hit_ratio": null,
      "tokens_in": null,
      "signal_counts": {}
    },
    {
      "segment_id": "seg_1",
      "boundary": {
        "event_id": "ev_segment_boundary",
        "kind": "segment.boundary",
        "segment_id": "seg_1",
        "attrs": {
          "reason": "compaction",
          "context_tokens_before": 120,
          "context_tokens_after": 40,
          "tokens_removed": 80,
          "parent_segment_id": "seg_0"
        }
      },
      "turns": [],
      "turn_count": 1
    }
  ],
  "next_cursor": null
}
```

An unknown session is `404`.

### `GET /v1/query/sessions/{id}/turns`

| Parameter | Type | Meaning |
| --- | --- | --- |
| `segment_id` | string | Restrict to one context segment. |
| `turn_id` | string | Restrict to one turn (optional convenience). |

Response `200` is a page-shaped object with one row per turn. Each row is the
full `TurnNode` plus the summary fields flattened onto the row, `signals`, a
`prompt` preview and `tokens_in` / `output_tokens`. `summary.signals` and
`signals` contain the same detected signal list (`repeated_tool_failure`,
`loop`, `user_interrupt`, `user_correction`). Unknown numbers stay `null`.

```json
{
  "items": [
    {
      "turn_id": "turn_1",
      "segment_id": "seg_0",
      "ts": "2026-01-02T03:00:01.000Z",
      "end_ts": "2026-01-02T03:00:22.000Z",
      "status": "ok",
      "events": [],
      "steps": [],
      "summary": {
        "step_count": 8,
        "tool_call_count": 3,
        "tool_error_count": 1,
        "llm_calls": 3,
        "usage": {
          "total": {
            "input_tokens": 120,
            "output_tokens": 45,
            "cache_read_tokens": null,
            "cache_write_tokens": null,
            "reasoning_tokens": null,
            "cost_usd": null
          },
          "calls": 3,
          "covered": 2,
          "coverage": 0.6666666666666666
        },
        "context_tokens_peak": null,
        "wall_ms": 21000,
        "active_ms": 21000,
        "stop_reason": "end_turn",
        "signals": []
      },
      "signals": [],
      "prompt": "please fix the login bug",
      "tokens_in": null,
      "output_tokens": 45,
      "step_count": 8,
      "stop_reason": "end_turn"
    }
  ],
  "next_cursor": null
}
```

An unknown session is `404`.

### `GET /v1/query/sessions/{id}/llm-calls`

| Parameter | Type | Meaning |
| --- | --- | --- |
| `segment_id` | string | Restrict the series to one context segment. |
| `turn_id` | string | Restrict the series to one turn. |

Returns one row per `llm.call`, ordered by timestamp. `request_index` is the
1-based position of the call in its session, assigned in timestamp order (it
is never `null`). `purpose` is `chat` for a conversation call and `compaction`
for a call that summarized context. `context_delta` is computed against the
previous call **in the same segment** before filtering, so the first call of a
segment (and the first row of a filtered segment) has `context_delta: null`.
`watermark` is the call's `context_tokens` — the context-watermark chart uses
it. `cache_hit_ratio` is `cache_read / context_tokens`. `decode_ms` is
`latency_ms - ttft_ms` and `output_tokens_per_s` is the output rate over that
decode window; both are derived when their inputs are known and `null`
otherwise. `retry` carries `{ attempt, max_attempts, delay_ms, error_code }`
for a logical request that had to retry, or `null`; a retry never adds a row.
`derived` names the fields whose values were derived rather than reported.
Unknown values stay `null`; they are never `0`.

```json
{
  "items": [
    {
      "step_id": "st_llm_1",
      "turn_id": "turn_1",
      "segment_id": "seg_0",
      "ts": "2026-01-02T03:00:03.000Z",
      "request_index": 1,
      "purpose": "chat",
      "model": "claude-opus",
      "context_tokens": 160,
      "context_delta": null,
      "watermark": 160,
      "cache_hit_ratio": 0.3125,
      "input": 100,
      "cache_read": 50,
      "cache_write": 10,
      "output": 20,
      "reasoning": null,
      "stop_reason": "end_turn",
      "latency_ms": 2000,
      "ttft_ms": 300,
      "decode_ms": 1700,
      "output_tokens_per_s": 11.764705882352942,
      "retry": null,
      "derived": ["decode_ms", "output_tokens_per_s"],
      "usage": {
        "input_tokens": 100,
        "output_tokens": 20,
        "cache_read_tokens": 50,
        "cache_write_tokens": 10,
        "reasoning_tokens": null,
        "source": "provider"
      }
    }
  ],
  "next_cursor": null
}
```

An unknown session is `404`.

### `GET /v1/query/sessions/{id}/steps`

| Parameter | Type | Meaning |
| --- | --- | --- |
| `segment_id` | string | Only steps of this context segment. |
| `turn_id` | string | Only steps of this turn. |
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
| `404` | Unknown session or route (including the new segments/turns/llm-calls routes). |
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
