/**
 * Shared event and session helpers.
 *
 * The sink writes, the query reads, and both need the same two operations:
 * load the events of a session and write the summary of a session. They live
 * here so that the write path and the read path can never drift apart.
 */

import { summarizeSession, type AgentEvent, type SessionSummary } from "@openmatel/core";

import type { SqliteDatabase } from "./db.js";
import { eventRow, sessionRow } from "./rows.js";

/** The insert statement of the `events` table. */
const INSERT_EVENT = `
INSERT INTO events (
  event_id, project_id, session_id, turn_id, step_id, parent_step_id,
  kind, status, ts, end_ts, source_name, attrs_json, content_json, usage_json, event_json
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(event_id) DO UPDATE SET
  project_id = excluded.project_id,
  session_id = excluded.session_id,
  turn_id = excluded.turn_id,
  step_id = excluded.step_id,
  parent_step_id = excluded.parent_step_id,
  kind = excluded.kind,
  status = excluded.status,
  ts = excluded.ts,
  end_ts = excluded.end_ts,
  source_name = excluded.source_name,
  attrs_json = excluded.attrs_json,
  content_json = excluded.content_json,
  usage_json = excluded.usage_json,
  event_json = excluded.event_json;`;

/** The insert statement of the `sessions` table. */
const INSERT_SESSION = `
INSERT INTO sessions (
  session_id, project_id, source, harness, model, title, cwd, started_at, ended_at,
  status, turn_count, step_count, tool_call_count, tool_error_count, subagent_count,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
  llm_calls, usage_covered, summary_json
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(session_id) DO UPDATE SET
  project_id = excluded.project_id,
  source = excluded.source,
  harness = excluded.harness,
  model = excluded.model,
  title = excluded.title,
  cwd = excluded.cwd,
  started_at = excluded.started_at,
  ended_at = excluded.ended_at,
  status = excluded.status,
  turn_count = excluded.turn_count,
  step_count = excluded.step_count,
  tool_call_count = excluded.tool_call_count,
  tool_error_count = excluded.tool_error_count,
  subagent_count = excluded.subagent_count,
  input_tokens = excluded.input_tokens,
  output_tokens = excluded.output_tokens,
  cache_read_tokens = excluded.cache_read_tokens,
  cache_write_tokens = excluded.cache_write_tokens,
  llm_calls = excluded.llm_calls,
  usage_covered = excluded.usage_covered,
  summary_json = excluded.summary_json;`;

/**
 * Store one event.
 *
 * The write is idempotent by `event_id`: the same event written twice keeps
 * one row, and the last write wins.
 */
export const insertEvent = (db: SqliteDatabase, event: AgentEvent): void => {
  const row = eventRow(event);
  db.run(
    INSERT_EVENT,
    row.event_id,
    row.project_id,
    row.session_id,
    row.turn_id,
    row.step_id,
    row.parent_step_id,
    row.kind,
    row.status,
    row.ts,
    row.end_ts,
    row.source_name,
    row.attrs_json,
    row.content_json,
    row.usage_json,
    row.event_json,
  );
};

/**
 * Load the events of one session, ordered by timestamp and event id.
 *
 * The order is the one the contract asks for: `ts` first, `event_id` as the
 * tie breaker, so two runs always produce the same sequence.
 */
export const loadSessionEvents = (db: SqliteDatabase, session_id: string): AgentEvent[] => {
  const rows = db.all<{ event_json: string }>(
    "SELECT event_json FROM events WHERE session_id = ? ORDER BY ts ASC, event_id ASC",
    session_id,
  );
  return rows.map((row) => JSON.parse(row.event_json) as AgentEvent);
};

/**
 * Recompute the summary of a session and store it.
 *
 * The summary is derived from *all* events of the session, not from the batch
 * that was just written: that is what makes out-of-order delivery converge
 * to the same result as an ordered one.
 */
export const refreshSessionSummary = (
  db: SqliteDatabase,
  session_id: string,
  withFts: boolean,
): SessionSummary => {
  const summary = summarizeSession(loadSessionEvents(db, session_id));
  writeSessionSummary(db, summary, withFts);
  return summary;
};

/** Store an already computed summary. */
export const writeSessionSummary = (
  db: SqliteDatabase,
  summary: SessionSummary,
  withFts: boolean,
): void => {
  const row = sessionRow(summary);
  db.run(
    INSERT_SESSION,
    row.session_id,
    row.project_id,
    row.source,
    row.harness,
    row.model,
    row.title,
    row.cwd,
    row.started_at,
    row.ended_at,
    row.status,
    row.turn_count,
    row.step_count,
    row.tool_call_count,
    row.tool_error_count,
    row.subagent_count,
    row.input_tokens,
    row.output_tokens,
    row.cache_read_tokens,
    row.cache_write_tokens,
    row.llm_calls,
    row.usage_covered,
    row.summary_json,
  );

  if (!withFts) return;

  // The FTS row shares the rowid of the session row, so it can be replaced
  // without scanning the whole index.
  const rowid = db.get<{ rowid: number }>(
    "SELECT rowid FROM sessions WHERE session_id = ?",
    summary.session_id,
  )?.rowid;
  if (rowid === undefined) return;

  db.run("DELETE FROM sessions_fts WHERE rowid = ?", rowid);
  db.run(
    "INSERT INTO sessions_fts (rowid, session_id, title, cwd) VALUES (?, ?, ?, ?)",
    rowid,
    summary.session_id,
    summary.title ?? "",
    summary.cwd ?? "",
  );
};
