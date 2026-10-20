/**
 * Schema migrations.
 *
 * The store owns its schema: every change is a numbered migration that runs
 * exactly once, inside a transaction, and is recorded in `_migrations`. A
 * database that was opened by an older version of the store is upgraded when
 * it is opened again — no manual step, no "did you run the migration?".
 *
 * Migration 1 creates the whole Phase 1 schema: the events, the sessions
 * summary, the cursor table and — when the SQLite build has FTS5 — the
 * full-text index over the session title and working directory.
 */

import type { SqliteDatabase } from "./db.js";

/** One numbered migration. */
export interface Migration {
  /** Version of the migration; the id is what `_migrations` records. */
  readonly id: number;
  /** Apply the migration. It runs inside a transaction. */
  readonly up: (db: SqliteDatabase) => void;
}

/**
 * How the full-text index of the store behaves.
 *
 * - `"trigram"` — the index answers substring queries, so searching for `ogin`
 *   finds "login". This is what the session search promises.
 * - `"default"` — the index answers word and word-prefix queries only. It is
 *   the fallback for a SQLite build without the trigram tokenizer.
 * - `"none"` — there is no full-text index; the search uses `LIKE`.
 */
export type FtsMode = "trigram" | "default" | "none";

/** The `sessions_fts` table with the trigram tokenizer. */
const CREATE_FTS_TRIGRAM = `
CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
  session_id UNINDEXED,
  title,
  cwd,
  tokenize = 'trigram'
);`;

/** The `sessions_fts` table with the default tokenizer. */
const CREATE_FTS_DEFAULT = `
CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
  session_id UNINDEXED,
  title,
  cwd
);`;

/**
 * Create the full-text index, with the best tokenizer the build supports.
 *
 * @returns the mode that was installed.
 */
const createFts = (db: SqliteDatabase): FtsMode => {
  try {
    db.exec(CREATE_FTS_TRIGRAM);
    return "trigram";
  } catch {
    // The trigram tokenizer needs SQLite 3.34 or newer.
  }
  try {
    db.exec(CREATE_FTS_DEFAULT);
    return "default";
  } catch {
    // No FTS5 in this build at all — the search falls back to LIKE.
  }
  return "none";
};

/** Migration 1: the initial schema. */
const migration1: Migration = {
  id: 1,
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn_id TEXT,
        step_id TEXT,
        parent_step_id TEXT,
        kind TEXT NOT NULL,
        status TEXT,
        ts TEXT NOT NULL,
        end_ts TEXT,
        source_name TEXT,
        attrs_json TEXT,
        content_json TEXT,
        usage_json TEXT,
        event_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS events_session_ts ON events (session_id, ts);
      CREATE INDEX IF NOT EXISTS events_project_kind_status ON events (project_id, kind, status);
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        project_id TEXT,
        source TEXT,
        harness TEXT,
        model TEXT,
        title TEXT,
        cwd TEXT,
        started_at TEXT,
        ended_at TEXT,
        status TEXT,
        turn_count INTEGER,
        step_count INTEGER,
        tool_call_count INTEGER,
        tool_error_count INTEGER,
        subagent_count INTEGER,
        input_tokens INTEGER NULL,
        output_tokens INTEGER NULL,
        cache_read_tokens INTEGER NULL,
        cache_write_tokens INTEGER NULL,
        llm_calls INTEGER,
        usage_covered INTEGER,
        summary_json TEXT
      );

      CREATE INDEX IF NOT EXISTS sessions_project_started
        ON sessions (project_id, started_at DESC, session_id);
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS cursors (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT
      );
    `);

    // FTS5 is optional: a SQLite build without it must still be able to run
    // the store, the search then falls back to LIKE.
    createFts(db);
  },
};

/** Every migration, in order. */
export const MIGRATIONS: readonly Migration[] = [migration1];

/**
 * Apply the pending migrations.
 *
 * The migration table is created first, so a fresh database and an existing
 * one take the same path.
 */
export const runMigrations = (db: SqliteDatabase): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    db.all<{ id: number }>("SELECT id FROM _migrations").map((row) => Number(row.id)),
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    db.transaction(() => {
      migration.up(db);
      db.run(
        "INSERT INTO _migrations (id, applied_at) VALUES (?, ?)",
        migration.id,
        new Date().toISOString(),
      );
    });
  }
};

/**
 * Detect the full-text index of the database.
 *
 * The index is detected instead of assumed: the migration may have been
 * applied by a SQLite build without FTS5, and the mode has to survive a
 * reopen of the same file.
 */
export const detectFts = (db: SqliteDatabase): FtsMode => {
  const row = db.get<{ sql: string | null }>(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions_fts'",
  );
  const sql = row?.sql;
  if (typeof sql !== "string" || !/USING\s+fts5/i.test(sql)) return "none";
  return /trigram/i.test(sql) ? "trigram" : "default";
};
