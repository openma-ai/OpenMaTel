/**
 * The session list: the home screen of the console.
 *
 * Rows are individual rounded cards separated by a gap — not a table — and
 * the scroll area gets a top/bottom edge fade only when it is actually cut
 * off. Filtering, search and cursor pagination all go through the injected
 * {@link ObsClient}.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import type { SessionSummary } from "@openmatel/core";

import type { ObsClient, SessionListParams } from "./client.js";
import {
  durationBetween,
  formatCoverage,
  formatDurationMs,
  formatTimestamp,
  formatTokens,
  singleLine,
} from "./format.js";
import { useObsOptional } from "./provider.js";
import { useEdgeFade } from "./useEdgeFade.js";

/** Sources offered as filter chips, in the order of docs/design.md. */
export const SESSION_SOURCES = ["claude-code", "codex", "dsh", "pi"] as const;

/** Props of {@link SessionList}. */
export interface SessionListProps {
  /** Override the client from the provider (useful for tests/embeds). */
  client?: ObsClient;
  /** Called instead of the provider's navigate when a row is activated. */
  onSelectSession?: (sessionId: string) => void;
  /** Shown when the query succeeds but returns no sessions. */
  emptyState?: ReactNode;
  /** Page size; the Query API allows 1..200. */
  limit?: number;
  /** Initial free-text query. */
  initialQuery?: string;
}

const isError = (session: SessionSummary): boolean =>
  session.status === "error"; // tool errors are shown separately as "N failed"

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The session list component. */
export function SessionList({
  client: clientOverride,
  onSelectSession,
  emptyState,
  limit = 20,
  initialQuery = "",
}: SessionListProps) {
  const context = useObsOptional();
  const client = clientOverride ?? context?.client;
  if (client === undefined) {
    throw new Error("SessionList requires an ObsClient via <ObsProvider> or the client prop");
  }

  const navigate =
    context?.navigate ??
    ((href: string) => {
      if (typeof window !== "undefined") window.location.assign(href);
    });

  const [search, setSearch] = useState(initialQuery);
  const [query, setQuery] = useState(initialQuery);
  const [source, setSource] = useState<string | undefined>(undefined);
  const [hasErrors, setHasErrors] = useState(false);
  const [items, setItems] = useState<SessionSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEdgeFade(scrollRef, `${items.length}:${loading}:${reload}`);

  // Debounce typing so a search does not fire one request per keystroke.
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  const params = (): SessionListParams => ({
    limit,
    ...(query !== "" ? { q: query } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(hasErrors ? { has_error: true } : {}),
  });

  // Load the first page whenever a filter changes. A stale response is ignored.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNextCursor(null);

    client
      .listSessions(params())
      .then((page) => {
        if (cancelled) return;
        setItems(page.items);
        setNextCursor(page.next_cursor);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setItems([]);
        setError(messageOf(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // `params()` is derived from these values; client identity is the contract.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, query, source, hasErrors, limit, reload]);

  const loadMore = async (): Promise<void> => {
    if (nextCursor === null || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await client.listSessions({ ...params(), cursor: nextCursor });
      setItems((current) => [...current, ...page.items]);
      setNextCursor(page.next_cursor);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLoadingMore(false);
    }
  };

  const toggleSource = (name: string): void => {
    setSource((current) => (current === name ? undefined : name));
  };

  const open = (session: SessionSummary): void => {
    // onSelectSession receives a session id; navigate receives an application path.
    if (onSelectSession) onSelectSession(session.session_id);
    else navigate(`/sessions/${encodeURIComponent(session.session_id)}`);
  };

  const filterActive = source !== undefined || hasErrors || query !== "";

  return (
    <section className="omt-session-list" aria-labelledby={`${listId}-title`}>
      <div className="omt-section-heading">
        <div>
          <h1 className="omt-title" id={`${listId}-title`}>
            Sessions
          </h1>
          <p className="omt-subtitle">
            Agent sessions indexed on this machine. Every row opens the turn and step timeline.
          </p>
        </div>
        <span className="omt-count" aria-live="polite">
          {loading ? "loading…" : `${items.length}${nextCursor !== null ? "+" : ""} shown`}
        </span>
      </div>

      <div className="omt-toolbar">
        <div className="omt-search">
          <label className="omt-visually-hidden" htmlFor={`${listId}-search`}>
            Search sessions
          </label>
          <span className="omt-search-icon" aria-hidden="true">
            ⌕
          </span>
          <input
            id={`${listId}-search`}
            className="omt-input"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search titles, cwd and content…"
            autoComplete="off"
          />
        </div>

        <div className="omt-chips" role="group" aria-label="Filter by source">
          {SESSION_SOURCES.map((name) => (
            <button
              key={name}
              type="button"
              className="omt-chip"
              aria-pressed={source === name}
              onClick={() => toggleSource(name)}
            >
              {name}
            </button>
          ))}
        </div>

        <button
          type="button"
          className="omt-toggle"
          aria-pressed={hasErrors}
          onClick={() => setHasErrors((value) => !value)}
        >
          <span className={hasErrors ? "omt-toggle-dot omt-toggle-dot-on" : "omt-toggle-dot"} />
          has errors
        </button>
      </div>

      {error !== null ? (
        <div className="omt-notice omt-notice-error" role="alert">
          <span>{error}</span>
          <button type="button" className="omt-button" onClick={() => setReload((value) => value + 1)}>
            Retry
          </button>
        </div>
      ) : null}

      <div className="omt-session-scroll omt-scroll" ref={scrollRef}>
        {loading && items.length === 0 ? (
          <div className="omt-loading" role="status">
            <span className="omt-spinner" aria-hidden="true" />
            Loading sessions…
          </div>
        ) : items.length === 0 ? (
          <div className="omt-empty">
            {filterActive ? (
              <>
                <h2>No sessions match these filters</h2>
                <p>Clear the search, the source chip or the “has errors” toggle and try again.</p>
                <button
                  type="button"
                  className="omt-button"
                  onClick={() => {
                    setSearch("");
                    setQuery("");
                    setSource(undefined);
                    setHasErrors(false);
                  }}
                >
                  Clear filters
                </button>
              </>
            ) : (
              emptyState ?? (
                <>
                  <h2>No sessions yet</h2>
                  <p>
                    Index the local Claude Code, Codex, dsh and pi session files with{" "}
                    <code>openmatel index</code>, then reload this page.
                  </p>
                </>
              )
            )}
          </div>
        ) : (
          <ul className="omt-session-rows">
            {items.map((session) => {
              const duration = durationBetween(session.started_at, session.ended_at);
              const failed = isError(session);
              return (
                <li key={session.session_id}>
                  <button
                    type="button"
                    className="omt-session-row"
                    onClick={() => open(session)}
                    aria-label={`Open session ${session.title ?? session.session_id}`}
                  >
                    <span className="omt-session-main">
                      <span className="omt-session-title">
                        {session.title !== null && session.title !== ""
                          ? singleLine(session.title, 140)
                          : "Untitled session"}
                      </span>
                      <span className="omt-session-meta">
                        <span className="omt-source-badge">{session.source ?? "unknown"}</span>
                        <span>{session.harness ?? "—"}</span>
                        <span className="omt-dot-separator" aria-hidden="true">
                          ·
                        </span>
                        <span>{session.model ?? "—"}</span>
                        <span className="omt-dot-separator" aria-hidden="true">
                          ·
                        </span>
                        <span className="omt-cwd">{session.cwd ?? "—"}</span>
                      </span>
                    </span>

                    <span className="omt-session-metrics">
                      <span className="omt-metric">
                        <span className="omt-metric-label">started</span>
                        <span className="omt-metric-value">{formatTimestamp(session.started_at)}</span>
                      </span>
                      <span className="omt-metric">
                        <span className="omt-metric-label">duration</span>
                        <span className="omt-metric-value">{formatDurationMs(duration)}</span>
                      </span>
                      <span className="omt-metric">
                        <span className="omt-metric-label">turns / steps</span>
                        <span className="omt-metric-value">
                          {session.turn_count} / {session.step_count}
                        </span>
                      </span>
                      <span className="omt-metric">
                        <span className="omt-metric-label">tools</span>
                        <span className="omt-metric-value">
                          {session.tool_call_count}
                          {session.tool_error_count > 0 ? (
                            <span className="omt-error-text"> · {session.tool_error_count} failed</span>
                          ) : null}
                        </span>
                      </span>
                      <span className="omt-metric">
                        <span className="omt-metric-label">tokens in / out</span>
                        <span className="omt-metric-value">
                          {formatTokens(session.usage.total.input_tokens)} /{" "}
                          {formatTokens(session.usage.total.output_tokens)}
                        </span>
                      </span>
                      <span className="omt-metric">
                        <span className="omt-metric-label">coverage</span>
                        <span className="omt-metric-value">
                          {formatCoverage(session.usage.coverage)}
                        </span>
                      </span>
                      <span className={failed ? "omt-status omt-status-error" : "omt-status"}>
                        {failed ? "error" : session.status}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {nextCursor !== null ? (
          <div className="omt-load-more">
            <button
              type="button"
              className="omt-button"
              onClick={() => void loadMore()}
              disabled={loadingMore}
            >
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
