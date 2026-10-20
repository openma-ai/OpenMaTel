/**
 * The SQLite store.
 *
 * `openSqliteStore` opens one database file (or an in-memory database) and
 * hands out the two ports of the store: the {@link Sink} that writes events
 * and the {@link Query} that reads them back.
 *
 * The store is the desktop default of OpenMaTel: it runs inside the Node
 * process, uses the `node:sqlite` built-in (no native dependency to compile,
 * nothing to install) and needs no service next to it.
 *
 * ```ts
 * const store = openSqliteStore({ path: "/tmp/openmatel.db" });
 * await store.sink.write(events);
 * const page = await store.query.listSessions({ limit: 20 });
 * await store.close();
 * ```
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { Query, Sink } from "@openmatel/core";

import { isMemoryPath, SqliteDatabase } from "./db.js";
import { detectFts, runMigrations } from "./migrations.js";
import { createQuery } from "./query.js";
import { createSink } from "./sink.js";

/** Options of {@link openSqliteStore}. */
export interface SqliteStoreOptions {
  /**
   * Path of the database file, or `":memory:"` for a throw-away store.
   *
   * The parent directory is created when it does not exist.
   */
  path: string | ":memory:";
}

/** The store: the write side, the read side and the housekeeping around it. */
export interface SqliteStore {
  /** The write side. Writes are idempotent by `event_id`. */
  sink: Sink;
  /** The read side. */
  query: Query;
  /** Close the database. The store cannot be used afterwards. */
  close(): Promise<void>;
  /**
   * Remember a cursor — the position of a pull source, a page token, …
   *
   * The cursor survives a restart of the process: it lives in the database.
   */
  setCursor(key: string, value: string): void;
  /**
   * Read a cursor back.
   *
   * @returns the value, or `null` when the key was never written.
   */
  getCursor(key: string): string | null;
}

/**
 * Open a SQLite store.
 *
 * The database is configured for the desktop use case: WAL journal (so a
 * reader does not block the writer), `synchronous = NORMAL` (fast enough for
 * a trace store, still safe against a crash of the process), foreign keys on
 * and a busy timeout of five seconds (so a second process waits instead of
 * failing). The in-memory database keeps the journal mode of SQLite itself —
 * WAL does not exist there.
 *
 * @param options - the path of the database, or the options object.
 */
export function openSqliteStore(options: SqliteStoreOptions | string): SqliteStore {
  const path = typeof options === "string" ? options : options.path;
  if (typeof path !== "string" || path === "") {
    throw new TypeError("openSqliteStore: a database path is required");
  }

  const memory = isMemoryPath(path);
  if (!memory) {
    const directory = dirname(path);
    if (directory && directory !== ".") {
      mkdirSync(directory, { recursive: true });
    }
  }

  const db = new SqliteDatabase(path);
  try {
    applyPragmas(db, memory);
    runMigrations(db);
  } catch (error) {
    db.close();
    throw error;
  }

  const fts = detectFts(db);
  const sink = createSink({ db, fts: fts !== "none" });
  const query = createQuery({ db, fts });

  let closed = false;

  return {
    sink,
    query,

    close: async (): Promise<void> => {
      if (closed) return;
      closed = true;
      db.close();
    },

    setCursor: (key: string, value: string): void => {
      db.run(
        "INSERT INTO cursors (key, value, updated_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        key,
        value,
        new Date().toISOString(),
      );
    },

    getCursor: (key: string): string | null => {
      const row = db.get<{ value: string | null }>(
        "SELECT value FROM cursors WHERE key = ?",
        key,
      );
      return typeof row?.value === "string" ? row.value : null;
    },
  };
}

/** Configure the connection for the desktop use case. */
const applyPragmas = (db: SqliteDatabase, memory: boolean): void => {
  // WAL keeps the readers out of the way of the writer. It does not exist for
  // an in-memory database — SQLite keeps the journal in memory there anyway.
  if (!memory) {
    db.exec("PRAGMA journal_mode = WAL;");
  }
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
};
