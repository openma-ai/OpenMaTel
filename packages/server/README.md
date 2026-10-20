# `@openmatel/server`

The platform-agnostic HTTP server of OpenMaTel: the Query API v1 on top of a
[`Query`](../core/src/ports.ts) port, built with [Hono](https://hono.dev).

The package never imports a store. The composition root opens a store and
passes its read side in, which keeps the same server usable in Node, in a
Cloudflare Worker and in tests. The Node listener is a separate entry so a
Worker bundle never pulls in `node:http`.

## Usage

```ts
import { openSqliteStore } from "@openmatel/store-sqlite";
import { createApp } from "@openmatel/server";
import { serveNode } from "@openmatel/server/node";

const store = openSqliteStore({ path: "./openmatel.db" });

const app = createApp({
  query: store.query,
  version: "0.1.0",
  auth: { token: process.env.OPENMATEL_TOKEN },
  staticAssets: async (path) => {
    // Resolve `path` (a pathname beginning with "/") against the built SPA;
    // return null when it does not exist so the server falls back to
    // /index.html.
    return null;
  },
});

const server = serveNode(app, { host: "127.0.0.1", port: 4319 });
```

- `createApp({ query, auth?, version, staticAssets? })` returns a Hono app.
- `serveNode(app, { host = "127.0.0.1", port = 4319 })` returns a listening
  `node:http` server using a small built-in fetch adapter.
- The API, auth flow and status codes are documented in
  [`docs/api.md`](../../docs/api.md).
- [`openapi.json`](./openapi.json) is the OpenAPI 3.1 description.

## Authentication

When `auth.token` is set, every route except `GET /v1/health` needs the token
as `Authorization: Bearer <token>`, as the `omt_token` cookie, or as `?token=`.
The query form sets an `HttpOnly; SameSite=Strict` cookie and redirects to the
same URL without the token.

## Security

- Loopback is the default bind address.
- `X-Content-Type-Options: nosniff` is set on every response.
- A present `Host` header must be `localhost`, `127.0.0.1` or `[::1]`
  (DNS-rebinding protection); other hosts get `403`.
