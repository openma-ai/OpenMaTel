/**
 * Opening the SQLite store.
 *
 * The store is imported dynamically so that
 * {@link suppressSqliteExperimentalWarning} is installed before `node:sqlite`
 * is loaded. In the bundled CLI the build routes `node:sqlite` through a lazy
 * shim for the same reason: a static import would be hoisted above the
 * warning filter.
 */

import path from "node:path";

import type { SqliteStore } from "@openmatel/store-sqlite";

import { suppressSqliteExperimentalWarning } from "./warnings.js";

/** The database file of a data directory. */
export function databasePath(dataDir: string): string {
  return path.join(dataDir, "openmatel.db");
}

/** Open (and migrate) the store of a data directory. */
export async function openStore(dataDir: string): Promise<SqliteStore> {
  suppressSqliteExperimentalWarning();
  const { openSqliteStore } = await import("@openmatel/store-sqlite");
  return openSqliteStore({ path: databasePath(dataDir) });
}
