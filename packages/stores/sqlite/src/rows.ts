/**
 * Mapping between canonical events and database rows.
 *
 * Two rules drive everything in here:
 *
 * - **"missing" is not "0"** (§4.5 of the design). A token field nobody
 *   reported stays `null`; it never becomes `0`.
 * - **A step captured with `capture: "none"` keeps no text.** The content of
 *   such a step is replaced by the bare capture marker, so neither the row
 *   nor the event that comes back from the store carries the text.
 */

import type { AgentEvent, EventContent, SessionSummary, Usage } from "@openmatel/core";

/**
 * The content of a step as it is stored.
 *
 * `capture: "none"` means the capture level is `off`: the structure is kept,
 * the text is not. Everything else is stored as it was reported.
 */
export const storedContent = (content: EventContent | undefined): EventContent | undefined => {
  if (!content) return undefined;
  if (content.capture !== "none") return content;
  return { capture: "none" };
};

/**
 * The event as it is stored.
 *
 * Only the content is rewritten; everything else is the canonical event.
 */
export const storedEvent = (event: AgentEvent): AgentEvent => {
  const content = storedContent(event.content);
  if (content === event.content) return event;
  return { ...event, content };
};

/**
 * Encode the usage of an event for the `usage_json` column.
 *
 * The column has three states, and the difference between them matters:
 *
 * - SQL `NULL` — the event has no `usage` field at all;
 * - the JSON document `null` — the event reports `usage: null` (unknown);
 * - the JSON document of the usage — the numbers the source reported.
 */
export const encodeUsage = (usage: Usage | null | undefined): string | null => {
  if (usage === undefined) return null;
  return JSON.stringify(usage);
};

/**
 * Decode the `usage_json` column.
 *
 * @returns the usage, `null` when the event reported `null` and `undefined`
 *          when the event has no usage at all.
 */
export const decodeUsage = (json: string | null): Usage | null | undefined => {
  if (json === null) return undefined;
  const parsed = JSON.parse(json) as Usage | null;
  return parsed;
};

/** The columns of one `events` row, in the order of the insert statement. */
export interface EventRow {
  event_id: string;
  project_id: string;
  session_id: string;
  segment_id: string;
  turn_id: string | null;
  step_id: string | null;
  parent_step_id: string | null;
  kind: string;
  status: string | null;
  ts: string;
  end_ts: string | null;
  source_name: string | null;
  attrs_json: string;
  content_json: string | null;
  usage_json: string | null;
  event_json: string;
}

/** Build the row of one event. */
export const eventRow = (event: AgentEvent): EventRow => {
  const content = storedContent(event.content);

  return {
    event_id: event.event_id,
    project_id: event.project_id,
    session_id: event.session_id,
    segment_id: event.segment_id,
    turn_id: event.turn_id ?? null,
    step_id: event.step_id ?? null,
    parent_step_id: event.parent_step_id ?? null,
    kind: event.kind,
    status: event.status ?? null,
    ts: event.ts,
    end_ts: event.end_ts ?? null,
    source_name: event.source?.name ?? null,
    attrs_json: JSON.stringify(event.attrs ?? {}),
    content_json: content === undefined ? null : JSON.stringify(content),
    usage_json: encodeUsage(event.usage),
    event_json: JSON.stringify(storedEvent(event)),
  };
};

/** The columns of one `sessions` row, in the order of the insert statement. */
export interface SessionRow {
  session_id: string;
  project_id: string | null;
  source: string | null;
  harness: string | null;
  model: string | null;
  title: string | null;
  cwd: string | null;
  started_at: string;
  ended_at: string;
  status: string;
  turn_count: number;
  step_count: number;
  tool_call_count: number;
  tool_error_count: number;
  subagent_count: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  llm_calls: number;
  usage_covered: number;
  summary_json: string;
}

/**
 * Build the row of one session summary.
 *
 * The token columns keep the `null` of the summary: a session nobody reported
 * usage for has `input_tokens = NULL`, not `0`.
 */
export const sessionRow = (summary: SessionSummary): SessionRow => ({
  session_id: summary.session_id,
  project_id: summary.project_id,
  source: summary.source,
  harness: summary.harness,
  model: summary.model,
  title: summary.title,
  cwd: summary.cwd,
  // An empty string keeps the column sortable and comparable; a session
  // always has at least one event, so the value is a timestamp in practice.
  started_at: summary.started_at ?? "",
  ended_at: summary.ended_at ?? "",
  status: summary.status,
  turn_count: summary.turn_count,
  step_count: summary.step_count,
  tool_call_count: summary.tool_call_count,
  tool_error_count: summary.tool_error_count,
  subagent_count: summary.subagent_count,
  input_tokens: summary.usage.total.input_tokens,
  output_tokens: summary.usage.total.output_tokens,
  cache_read_tokens: summary.usage.total.cache_read_tokens,
  cache_write_tokens: summary.usage.total.cache_write_tokens,
  llm_calls: summary.usage.calls,
  usage_covered: summary.usage.covered,
  summary_json: JSON.stringify(summary),
});
