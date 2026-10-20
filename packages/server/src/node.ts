/**
 * Node.js entry point of `@openmatel/server`.
 *
 * This module is deliberately separate from the package root: it is the only
 * file that imports `node:http`, so a Worker or a browser bundle can import
 * `@openmatel/server` without pulling in Node built-ins.
 *
 * ```ts
 * import { createApp } from "@openmatel/server";
 * import { serveNode } from "@openmatel/server/node";
 *
 * const server = serveNode(createApp({ query: store.query, version: "0.1.0" }));
 * ```
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { Hono } from "hono";

/** Options of {@link serveNode}. Both have safe desktop defaults. */
export interface ServeNodeOptions {
  /** Interface to bind. Defaults to `127.0.0.1` (loopback only). */
  host?: string;
  /** TCP port to bind. Defaults to `4319`. */
  port?: number;
}

/**
 * Start an HTTP listener for a Hono app.
 *
 * The listener uses `node:http` directly and adapts each request to a WHATWG
 * `Request`, so the server package needs no Node-specific Hono adapter. The
 * returned server is already listening; call `server.close()` to stop it.
 *
 * @param app - the app returned by `createApp`.
 * @param options - host and port; loopback and 4319 by default.
 */
export function serveNode(app: Hono, options: ServeNodeOptions = {}): Server {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4319;

  const server = createServer((request, response) => {
    void handle(app, request, response);
  });
  server.listen(port, host);
  return server;
}

const handle = async (app: Hono, request: IncomingMessage, response: ServerResponse): Promise<void> => {
  try {
    const fetchRequest = await toFetchRequest(request);
    const fetchResponse = await app.fetch(fetchRequest);
    await writeResponse(fetchResponse, response, request.method === "HEAD");
  } catch {
    if (!response.headersSent) {
      response.statusCode = 500;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.end(
        JSON.stringify({
          error: { code: "internal_error", message: "Internal Server Error" },
        }),
      );
    } else {
      response.destroy();
    }
  }
};

const toFetchRequest = async (request: IncomingMessage): Promise<Request> => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }
  // A missing Host is legal for HTTP/1.0. The URL still needs an authority;
  // `localhost` keeps the server's own Host validation happy.
  if (!headers.has("host")) headers.set("host", "localhost");

  const url = new URL(request.url ?? "/", `http://${headers.get("host") ?? "localhost"}`);
  const method = request.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
  const body = hasBody ? await readBody(request) : undefined;

  return new Request(url, {
    method,
    headers,
    body: body && body.length > 0 ? (body as unknown as BodyInit) : undefined,
  });
};

const readBody = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
};

const writeResponse = async (
  response: Response,
  target: ServerResponse,
  headOnly: boolean,
): Promise<void> => {
  target.statusCode = response.status;

  const setCookies = response.headers.getSetCookie?.() ?? [];
  response.headers.forEach((value, name) => {
    if (name.toLowerCase() === "set-cookie") return;
    target.setHeader(name, value);
  });
  if (setCookies.length > 0) target.setHeader("Set-Cookie", setCookies);

  if (headOnly || !response.body) {
    target.end();
    return;
  }

  // Node 22 exposes the WHATWG ReadableStream on Response; bridge it to the
  // node:http writable without buffering large static assets in memory.
  await pipeline(
    Readable.fromWeb(
      response.body as unknown as import("node:stream/web").ReadableStream,
    ),
    target,
  );
};
