/**
 * `openmatel serve` — the local HTTP server and web UI.
 *
 * The CLI is the composition root: it opens the SQLite store, creates the Hono
 * app with the store's Query, mounts the static assets of `@openmatel/app`
 * (copied to `dist/ui` at build time) and listens on loopback. A random token
 * is generated for every run; the printed URL exchanges it for an HttpOnly
 * cookie.
 */

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import { readFile, stat } from "node:fs/promises";
import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createApp, type StaticAssets } from "@openmatel/server";
import { serveNode } from "@openmatel/server/node";

import { openStore } from "./store.js";
import { startIndexWatch, type IndexWatchOptions } from "./watch.js";
import { VERSION } from "./version.js";

/** Options of the low-level {@link startServe}. */
export interface StartServeOptions {
  /** Data directory containing `openmatel.db`. */
  dataDir?: string;
  /** Interface to bind; loopback by default. */
  host?: string;
  /** First port to try. `0` asks the OS for a free port. */
  port?: number;
  /** Open the browser after listening. */
  open?: boolean;
  /** Fixed token, mostly for tests. A random token is generated otherwise. */
  token?: string;
  /** Override the directory containing `index.html` and `assets/`. */
  staticDir?: string;
  /** Install SIGINT/SIGTERM handlers (default `true`). */
  handleSignals?: boolean;
  /**
   * Optional periodic incremental index while the server is running. The
   * higher-level `serve` command enables it unless `--no-index` was given.
   */
  watch?: IndexWatchOptions;
}

/** A running local server. */
export interface ServeHandle {
  /** The URL to open, including the one-time `?token=`. */
  url: string;
  /** Token required by every route except `/v1/health`. */
  token: string;
  host: string;
  port: number;
  /** HTTP listener, already listening. */
  server: Server;
  /** Close the listener, release the store and remove signal handlers. */
  close(): Promise<void>;
}

/** The default loopback port of the desktop server. */
export const DEFAULT_PORT = 4319;
/** The default loopback interface. */
export const DEFAULT_HOST = "127.0.0.1";

/** Generate the per-run desktop token. */
export function createToken(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * Find the built UI next to the bundled CLI.
 *
 * In the published tarball the only candidate that exists is `./ui/` next to
 * `dist/openmatel.mjs`. Running from source during development falls back to
 * `packages/cli/dist/ui` and finally `packages/app/dist`, so the integration
 * tests work before the CLI has been bundled.
 */
export function resolveUiDir(moduleUrl: string = import.meta.url): string {
  const candidates = [
    new URL("./ui/", moduleUrl),
    new URL("../dist/ui/", moduleUrl),
    new URL("../../app/dist/", moduleUrl),
  ].map((url) => fileURLToPath(url));

  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "index.html"))) return candidate;
  }
  return candidates[0] ?? "";
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const contentType = (file: string): string =>
  CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";

/**
 * Create the static resolver of the server.
 *
 * It only ever reads inside `root`; a path that escapes it returns `null`, so
 * the server's SPA fallback (`/index.html`) handles it instead.
 */
export function createStaticAssets(root: string): StaticAssets {
  const absoluteRoot = path.resolve(root);

  return async (pathname: string): Promise<Response | null> => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    if (decoded.includes("\0")) return null;

    const relative = decoded.replace(/^\/+/, "");
    const file = path.resolve(absoluteRoot, relative === "" ? "index.html" : relative);
    if (file !== absoluteRoot && !file.startsWith(`${absoluteRoot}${path.sep}`)) return null;

    try {
      const info = await stat(file);
      if (!info.isFile()) return null;
      const body = await readFile(file);
      const isIndex = path.basename(file) === "index.html";
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": contentType(file),
          "content-length": String(body.byteLength),
          "cache-control": isIndex ? "no-store" : "public, max-age=31536000, immutable",
        },
      });
    } catch {
      return null;
    }
  };
}

/** Open a URL in the platform browser. Failures are non-fatal. */
export function openBrowser(url: string): void {
  let command: string;
  let args: string[];
  if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else if (process.platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", url];
  } else {
    command = "xdg-open";
    args = [url];
  }

  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {
      // No desktop session / no xdg-open: the URL is printed anyway.
    });
    child.unref();
  } catch {
    // Same as above.
  }
}

const listen = (app: ReturnType<typeof createApp>, host: string, port: number): Promise<Server> =>
  new Promise<Server>((resolve, reject) => {
    const server = serveNode(app, { host, port });

    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve(server);
    };

    server.once("error", onError);
    server.once("listening", onListening);
  });

const isPortBusy = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "EADDRINUSE";

/**
 * Start the local server.
 *
 * A busy explicit port is retried on the next ten ports (`4319` → `4329`).
 * Port `0` is left to the OS and never retried.
 */
export async function startServe(options: StartServeOptions = {}): Promise<ServeHandle> {
  if (
    options.watch !== undefined &&
    (!Number.isFinite(options.watch.intervalMs) || options.watch.intervalMs < 0)
  ) {
    throw new TypeError("watch.intervalMs must be a non-negative finite number");
  }

  const host = options.host ?? DEFAULT_HOST;
  const requestedPort = options.port ?? DEFAULT_PORT;
  const token = options.token ?? createToken();
  const dataDir =
    options.dataDir !== undefined && options.dataDir !== ""
      ? path.resolve(options.dataDir)
      : process.env.OPENMATEL_HOME !== undefined && process.env.OPENMATEL_HOME !== ""
        ? path.resolve(process.env.OPENMATEL_HOME)
        : path.join(os.homedir(), ".openmatel");
  const uiDir = options.staticDir ?? resolveUiDir();

  const store = await openStore(dataDir);
  const app = createApp({
    query: store.query,
    auth: { token },
    version: VERSION,
    staticAssets: createStaticAssets(uiDir),
  });

  const candidates =
    requestedPort === 0
      ? [0]
      : Array.from({ length: 11 }, (_, offset) => requestedPort + offset);

  let server: Server | undefined;
  let lastError: unknown;
  for (const candidate of candidates) {
    if (candidate > 65535) break;
    try {
      server = await listen(app, host, candidate);
      break;
    } catch (error) {
      lastError = error;
      if (!isPortBusy(error)) break;
    }
  }

  if (server === undefined) {
    await store.close();
    if (isPortBusy(lastError)) {
      throw new Error(
        `no free port between ${requestedPort} and ${Math.min(requestedPort + 10, 65535)}`,
      );
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : requestedPort;
  const url = `http://${host}:${port}/?token=${encodeURIComponent(token)}`;

  const watcher = options.watch !== undefined ? startIndexWatch(options.watch) : undefined;

  let closed = false;
  const shutdown = (): void => {
    void close().finally(() => {
      process.exitCode = 0;
    });
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    if (options.handleSignals !== false) {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
    }
    await watcher?.stop();
    const stopped = new Promise<void>((resolve, reject) => {
      server?.close((error) => (error ? reject(error) : resolve()));
    });
    server?.closeAllConnections?.();
    await stopped.catch(() => {});
    await store.close();
  };

  if (options.handleSignals !== false) {
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }

  if (options.open === true) openBrowser(url);

  return { url, token, host, port, server, close };
}
