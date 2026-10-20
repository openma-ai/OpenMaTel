/**
 * `@openmatel/store-sqlite` — the SQLite Sink + Query store of OpenMaTel.
 *
 * The store is built on the `node:sqlite` built-in of Node (>= 22.13), so it
 * has **no native dependency**: there is nothing to compile and nothing to
 * ship per platform. It is the default store of the desktop tier.
 *
 * ```ts
 * import { openSqliteStore } from "@openmatel/store-sqlite";
 *
 * const store = openSqliteStore({ path: "/tmp/openmatel.db" });
 * await store.sink.write(events);
 * const sessions = await store.query.listSessions({ limit: 20 });
 * await store.close();
 * ```
 */

export { openSqliteStore } from "./store.js";
export type { SqliteStore, SqliteStoreOptions } from "./store.js";
