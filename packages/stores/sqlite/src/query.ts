/**
 * The read side of the store.
 *
 * Everything the UI asks for goes through this port:
 *
 * - **sessions** — filtered, ordered by `started_at` (descending) and
 *   paginated with a keyset cursor, so a page boundary never skips or
 *   duplicates a session;
 * - **one session** — its summary and its events, in timestamp order;
 * - **steps** — the flat step list of one or many sessions, filtered by kind
 *   and status;
 * - **content** — the payload of one step, loaded on demand;
 * - **aggregations** — error hotspots, usage and latency.
 *
 * The filters and the order follow the contract of `@openmatel/contract-tests`
 * exactly, so two stores cannot disagree about what a query means.
 */

import {
  buildSessionTree,
  summarizeSession,
  type AgentEvent,
  type AggGroup,
  type AggQuery,
  type AggResult,
  type Content,
  type ContentRef,
  type Page,
  type Query,
  type SessionDetail,
  type SessionQuery,
  type SessionSummary,
  type Step,
  type StepNode,
  type StepQuery,
} from "@openmatel/core";

import { decodeCursor, encodeCursor, type SessionCursor, type StepCursor } from "./cursor.js";
import type { SqliteDatabase, SqlValue } from "./db.js";
import { loadSessionEvents } from "./events.js";
import type { FtsMode } from "./migrations.js";
import { ftsPhrase, ftsPrefixPhrase, likePattern } from "./text.js";

/** What the query side needs to know about its store. */
export interface QueryContext {
  /** The database handle. */
  db: SqliteDatabase;
  /** The full-text index of the database. */
  fts: FtsMode;
}

/** The order of the session list: newest first, then by id. */
const SESSION_ORDER = "ORDER BY started_at DESC, session_id ASC";

/** Flatten a step tree into a list. */
const flattenSteps = (steps: StepNode[]): StepNode[] =>
  steps.flatMap((step) => [step, ...flattenSteps(step.children)]);

/** The SQL expression that computes the grouping key of an aggregation. */
const groupExpression = (group_by: AggQuery["group_by"]): string => {
  switch (group_by) {
    case "tool_name":
      return "COALESCE(json_extract(attrs_json, '$.tool_name'), 'unknown')";
    case "harness":
      return `CASE
        WHEN json_type(attrs_json, '$.harness') = 'object'
          THEN COALESCE(json_extract(attrs_json, '$.harness.name'), 'unknown')
        WHEN json_type(attrs_json, '$.harness') = 'text'
          THEN json_extract(attrs_json, '$.harness')
        ELSE 'unknown' END`;
    case "model":
      return "COALESCE(json_extract(attrs_json, '$.model'), 'unknown')";
    case "project":
      return "project_id";
    case "kind":
    default:
      return "kind";
  }
};

/** Create the Query of the store. */
export const createQuery = ({ db, fts }: QueryContext): Query => {
  /* ---------------------------------------------------------------------- */
  /* Sessions                                                                */
  /* ---------------------------------------------------------------------- */

  const listSessions = async (q: SessionQuery): Promise<Page<SessionSummary>> => {
    const where: string[] = [];
    const params: SqlValue[] = [];

    if (q.project_id !== undefined) {
      where.push("project_id = ?");
      params.push(q.project_id);
    }
    if (q.source !== undefined) {
      where.push("source = ?");
      params.push(q.source);
    }
    if (q.harness !== undefined) {
      where.push("harness = ?");
      params.push(q.harness);
    }
    if (q.has_error === true) {
      where.push("tool_error_count > 0");
    } else if (q.has_error === false) {
      where.push("tool_error_count = 0");
    }
    if (q.from !== undefined) {
      where.push("started_at >= ?");
      params.push(q.from);
    }
    if (q.to !== undefined) {
      where.push("started_at < ?");
      params.push(q.to);
    }

    if (q.text !== undefined && q.text !== "") {
      // The title and the working directory are indexed; the content of the
      // steps is searched with LIKE, because the content lives in the events.
      const parts: string[] = [];

      if (fts === "trigram") {
        // The trigram index answers substring queries, but only from three
        // characters on — a shorter needle goes through LIKE.
        if (q.text.length >= 3) {
          parts.push(
            "session_id IN (SELECT session_id FROM sessions_fts WHERE sessions_fts MATCH ?)",
          );
          params.push(ftsPhrase(q.text));
        } else {
          parts.push("(title LIKE ? ESCAPE '\\' OR cwd LIKE ? ESCAPE '\\')");
          params.push(likePattern(q.text), likePattern(q.text));
        }
      } else if (fts === "default") {
        // The default tokenizer knows words, not substrings: the index gives
        // the word matches, LIKE the rest.
        parts.push(
          "session_id IN (SELECT session_id FROM sessions_fts WHERE sessions_fts MATCH ?)",
        );
        params.push(ftsPrefixPhrase(q.text));
        parts.push("(title LIKE ? ESCAPE '\\' OR cwd LIKE ? ESCAPE '\\')");
        params.push(likePattern(q.text), likePattern(q.text));
      } else {
        parts.push("(title LIKE ? ESCAPE '\\' OR cwd LIKE ? ESCAPE '\\')");
        params.push(likePattern(q.text), likePattern(q.text));
      }

      parts.push(
        "session_id IN (SELECT DISTINCT session_id FROM events WHERE content_json LIKE ? ESCAPE '\\')",
      );
      params.push(likePattern(q.text));
      where.push(`(${parts.join(" OR ")})`);
    }

    const cursor = decodeCursor<SessionCursor>(q.cursor);
    if (cursor) {
      // Keyset pagination: the next page starts after the last session of the
      // previous one, in the same order.
      where.push("(started_at < ? OR (started_at = ? AND session_id > ?))");
      params.push(cursor.started_at, cursor.started_at, cursor.session_id);
    }

    const limit = q.limit !== undefined && q.limit > 0 ? Math.floor(q.limit) : null;
    const sql = `SELECT summary_json FROM sessions ${
      where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""
    } ${SESSION_ORDER}${limit !== null ? " LIMIT ?" : ""}`;
    // One row more than asked for, to learn whether there is a next page.
    if (limit !== null) params.push(limit + 1);

    const rows = db.all<{ summary_json: string }>(sql, ...params);
    const hasMore = limit !== null && rows.length > limit;
    const visible = hasMore && limit !== null ? rows.slice(0, limit) : rows;
    const items = visible.map((row) => JSON.parse(row.summary_json) as SessionSummary);

    const last = items[items.length - 1];
    const next_cursor =
      hasMore && last
        ? encodeCursor({ started_at: last.started_at ?? "", session_id: last.session_id })
        : null;

    return { items, next_cursor };
  };

  /* ---------------------------------------------------------------------- */
  /* One session                                                             */
  /* ---------------------------------------------------------------------- */

  const getSession = async (session_id: string): Promise<SessionDetail | null> => {
    if (typeof session_id !== "string" || session_id === "") return null;

    const events = loadSessionEvents(db, session_id);
    if (events.length === 0) return null;

    const row = db.get<{ summary_json: string }>(
      "SELECT summary_json FROM sessions WHERE session_id = ?",
      session_id,
    );
    const summary = row
      ? (JSON.parse(row.summary_json) as SessionSummary)
      : summarizeSession(events);

    const { turns } = buildSessionTree(events);
    return { summary, events, turns };
  };

  /* ---------------------------------------------------------------------- */
  /* Steps                                                                   */
  /* ---------------------------------------------------------------------- */

  const listSteps = async (q: StepQuery): Promise<Page<Step>> => {
    // Only the structural filters run in SQL: the kind, the status and the
    // time range belong to the *merged* step, not to a single event.
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (q.session_id !== undefined) {
      where.push("session_id = ?");
      params.push(q.session_id);
    }
    if (q.project_id !== undefined) {
      where.push("project_id = ?");
      params.push(q.project_id);
    }

    const rows = db.all<{ event_json: string }>(
      `SELECT event_json FROM events ${
        where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""
      } ORDER BY session_id ASC, ts ASC, event_id ASC`,
      ...params,
    );

    const bySession = new Map<string, AgentEvent[]>();
    for (const row of rows) {
      const event = JSON.parse(row.event_json) as AgentEvent;
      const events = bySession.get(event.session_id);
      if (events) events.push(event);
      else bySession.set(event.session_id, [event]);
    }

    let steps: Step[] = [];
    for (const [session_id, events] of bySession) {
      const { turns } = buildSessionTree(events);

      // The turn and the parent of a step are remembered from the events, so
      // a step that never got a turn still reports the one it belongs to.
      const meta = new Map<string, { turn_id?: string; parent_step_id?: string }>();
      for (const event of events) {
        if (!event.step_id) continue;
        const previous = meta.get(event.step_id);
        meta.set(event.step_id, {
          turn_id: event.turn_id ?? previous?.turn_id,
          parent_step_id: event.parent_step_id ?? previous?.parent_step_id,
        });
      }

      for (const turn of turns) {
        if (q.turn_id !== undefined && q.turn_id !== turn.turn_id) continue;
        for (const node of flattenSteps(turn.steps)) {
          const info = meta.get(node.step_id);
          steps.push({
            step_id: node.step_id,
            session_id,
            turn_id: info?.turn_id ?? turn.turn_id,
            parent_step_id: info?.parent_step_id,
            kind: node.kind,
            status: node.status,
            ts: node.ts,
            end_ts: node.end_ts,
            title: node.title,
            attrs: node.attrs,
            error: node.error,
            usage: node.usage,
            source: node.source,
          });
        }
      }
    }

    if (q.kind !== undefined) {
      const kinds = new Set(Array.isArray(q.kind) ? q.kind : [q.kind]);
      steps = steps.filter((step) => kinds.has(step.kind));
    }
    if (q.status !== undefined) {
      const status = q.status;
      steps = steps.filter((step) => step.status === status);
    }
    if (q.tool_name !== undefined) {
      const tool_name = q.tool_name;
      steps = steps.filter((step) => step.attrs.tool_name === tool_name);
    }
    if (q.harness !== undefined) {
      const harness = q.harness;
      steps = steps.filter((step) => {
        const value = step.attrs.harness;
        if (typeof value === "string") return value === harness;
        if (value && typeof value === "object") {
          return (value as { name?: unknown }).name === harness;
        }
        return false;
      });
    }
    if (q.from !== undefined) {
      const from = q.from;
      steps = steps.filter((step) => step.ts >= from);
    }
    if (q.to !== undefined) {
      const to = q.to;
      steps = steps.filter((step) => step.ts < to);
    }

    steps.sort((left, right) => {
      if (left.ts !== right.ts) return left.ts < right.ts ? -1 : 1;
      return left.step_id < right.step_id ? -1 : left.step_id > right.step_id ? 1 : 0;
    });

    const limit = q.limit !== undefined && q.limit > 0 ? Math.floor(q.limit) : null;
    const cursor = decodeCursor<StepCursor>(q.cursor);
    const start = cursor
      ? steps.findIndex(
          (step) => step.ts > cursor.ts || (step.ts === cursor.ts && step.step_id > cursor.step_id),
        )
      : 0;
    const offset = start < 0 ? steps.length : start;

    const visible = limit !== null ? steps.slice(offset, offset + limit) : steps.slice(offset);
    const hasMore = limit !== null && offset + visible.length < steps.length;
    const last = visible[visible.length - 1];

    return {
      items: visible,
      next_cursor:
        hasMore && last ? encodeCursor({ ts: last.ts, step_id: last.step_id }) : null,
    };
  };

  /* ---------------------------------------------------------------------- */
  /* Content                                                                 */
  /* ---------------------------------------------------------------------- */

  const getContent = async (ref: ContentRef): Promise<Content | null> => {
    if (!ref || (ref.side !== "input" && ref.side !== "output")) return null;

    const where: string[] = [];
    const params: SqlValue[] = [];
    if (ref.step_id !== undefined) {
      where.push("step_id = ?");
      params.push(ref.step_id);
    }
    if (ref.session_id !== undefined) {
      where.push("session_id = ?");
      params.push(ref.session_id);
    }
    if (ref.project_id !== undefined) {
      where.push("project_id = ?");
      params.push(ref.project_id);
    }
    if (where.length === 0) return null;

    // The newest event of the step wins: a step that was updated carries the
    // newer content.
    const rows = db.all<{ event_json: string }>(
      `SELECT event_json FROM events WHERE ${where.join(" AND ")} ORDER BY ts DESC, event_id DESC`,
      ...params,
    );

    for (const row of rows) {
      const event = JSON.parse(row.event_json) as AgentEvent;
      const content = event.content?.[ref.side];
      if (content) return content;
    }
    return null;
  };

  /* ---------------------------------------------------------------------- */
  /* Aggregations                                                            */
  /* ---------------------------------------------------------------------- */

  const aggregate = async (q: AggQuery): Promise<AggResult> => {
    const where: string[] = [];
    const filters: SqlValue[] = [];
    if (q.project_id !== undefined) {
      where.push("project_id = ?");
      filters.push(q.project_id);
    }
    if (q.from !== undefined) {
      where.push("ts >= ?");
      filters.push(q.from);
    }
    if (q.to !== undefined) {
      where.push("ts < ?");
      filters.push(q.to);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    const metric = q.metric ?? "count";
    const selects: string[] = [`${groupExpression(q.group_by)} AS group_key`, "COUNT(*) AS group_count"];

    if (metric === "usage") {
      selects.push(
        "SUM(json_extract(usage_json, '$.input_tokens')) AS input_tokens",
        "SUM(json_extract(usage_json, '$.output_tokens')) AS output_tokens",
        "SUM(json_extract(usage_json, '$.cache_read_tokens')) AS cache_read_tokens",
        "SUM(json_extract(usage_json, '$.cache_write_tokens')) AS cache_write_tokens",
        "SUM(json_extract(usage_json, '$.reasoning_tokens')) AS reasoning_tokens",
        "COUNT(CASE WHEN kind = 'llm.call' THEN 1 END) AS calls",
        "COUNT(CASE WHEN kind = 'llm.call' AND json_type(usage_json) = 'object' THEN 1 END) AS covered",
      );
    }
    if (metric === "cost") {
      selects.push("SUM(json_extract(usage_json, '$.cost_usd')) AS cost_usd");
    }
    if (metric === "latency") {
      selects.push(
        "AVG(CASE WHEN end_ts IS NOT NULL THEN (julianday(end_ts) - julianday(ts)) * 86400000.0 END) AS latency_ms",
      );
    }

    const limit = q.limit !== undefined && q.limit > 0 ? Math.floor(q.limit) : null;
    const sql = `SELECT ${selects.join(", ")} FROM events ${clause}
    GROUP BY group_key ORDER BY group_count DESC, group_key ASC${
      limit !== null ? " LIMIT ?" : ""
    }`;
    const params = limit !== null ? [...filters, limit] : filters;

    const rows = db.all<Record<string, number | null>>(sql, ...params);

    const groups: AggGroup[] = rows.map((row) => {
      const group: AggGroup = {
        key: String(row.group_key ?? "unknown"),
        count: Number(row.group_count ?? 0),
      };

      if (metric === "usage") {
        const calls = Number(row.calls ?? 0);
        const covered = Number(row.covered ?? 0);
        group.usage = {
          total: {
            input_tokens: row.input_tokens ?? null,
            output_tokens: row.output_tokens ?? null,
            cache_read_tokens: row.cache_read_tokens ?? null,
            cache_write_tokens: row.cache_write_tokens ?? null,
            reasoning_tokens: row.reasoning_tokens ?? null,
            cost_usd: null,
          },
          calls,
          covered,
          coverage: calls === 0 ? null : covered / calls,
        };
      }
      if (metric === "cost") {
        group.cost_usd = row.cost_usd ?? null;
      }
      if (metric === "latency") {
        group.latency_ms = row.latency_ms ?? null;
      }

      return group;
    });

    // The total counts every event of the filter, not only the ones that made
    // it into the (possibly limited) list of groups.
    const total = Number(
      db.get<{ total: number }>(
        `SELECT COUNT(*) AS total FROM events ${clause}`,
        ...filters,
      )?.total ?? 0,
    );
    return { groups, total };
  };

  return { listSessions, getSession, listSteps, getContent, aggregate };
};
