/**
 * `@openmatel/server` — the platform-agnostic Query API v1.
 *
 * ```ts
 * import { createApp } from "@openmatel/server";
 *
 * const app = createApp({
 *   query: store.query,
 *   version: "0.1.0",
 *   auth: { token: process.env.OPENMATEL_TOKEN },
 * });
 * ```
 *
 * The Node.js listener lives in the separate `@openmatel/server/node` entry so
 * that a Worker bundle never pulls in `node:http`.
 */

export { createApp } from "./app.js";
export type {
  ApiErrorBody,
  ServerAuth,
  ServerContext,
  ServerOptions,
  StaticAssets,
} from "./app.js";
