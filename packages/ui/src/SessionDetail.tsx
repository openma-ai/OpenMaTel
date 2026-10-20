/**
 * One session: metadata header plus the turn/step timeline.
 *
 * The header is deliberately honest about missing data: token fields that the
 * source never reported render as `—`, and usage coverage is its own metric
 * instead of pretending a partial sum is complete.
 */

import { useEffect, useState } from "react";

import type { SessionSummary } from "@openmatel/core";

import type { ObsClient, ObsSessionDetail } from "./client.js";
import {
  durationBetween,
  formatCoverage,
  formatDurationMs,
  formatTimestamp,
  formatTokens,
} from "./format.js";
import { useObsOptional } from "./provider.js";
import { StepTimeline } from "./StepTimeline.js";

/** Props of {@link SessionDetail}. */
export interface SessionDetailProps {
  /** Id of the session to load. */
  sessionId: string;
  /** Override the client from the provider. */
  client?: ObsClient;
  /** Back navigation; defaults to the provider's navigate to `/`. */
  onBack?: () => void;
  /** Follow a child session; defaults to the provider's navigate. */
  onOpenSession?: (sessionId: string) => void;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

interface MetricProps {
  label: string;
  value: string;
  tone?: "error" | "muted";
  title?: string;
}

function Metric({ label, value, tone, title }: MetricProps) {
  return (
    <div className={tone === undefined ? "omt-metric-card" : `omt-metric-card omt-metric-${tone}`} title={title}>
      <span className="omt-metric-label">{label}</span>
      <span className="omt-metric-card-value">{value}</span>
    </div>
  );
}

const failed = (summary: SessionSummary): boolean =>
  summary.status === "error";

/** The session detail component. */
export function SessionDetail({
  sessionId,
  client: clientOverride,
  onBack,
  onOpenSession,
}: SessionDetailProps) {
  const context = useObsOptional();
  const client = clientOverride ?? context?.client;
  if (client === undefined) {
    throw new Error("SessionDetail requires an ObsClient via <ObsProvider> or the client prop");
  }

  const navigate =
    context?.navigate ??
    ((href: string) => {
      if (typeof window !== "undefined") window.location.assign(href);
    });
  const back = onBack ?? (() => navigate("/"));

  const [detail, setDetail] = useState<ObsSessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    client
      .getSession(sessionId)
      .then((value) => {
        if (!cancelled) setDetail(value);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setDetail(null);
        setError(messageOf(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [client, sessionId, reload]);

  if (loading && detail === null) {
    return (
      <div className="omt-loading" role="status">
        <span className="omt-spinner" aria-hidden="true" />
        Loading session…
      </div>
    );
  }

  if (detail === null) {
    return (
      <div className="omt-notice omt-notice-error" role="alert">
        <div>
          <strong>Could not load this session.</strong>
          <p>{error ?? "The session was not found."}</p>
        </div>
        <div className="omt-notice-actions">
          <button type="button" className="omt-button" onClick={back}>
            Back to sessions
          </button>
          <button type="button" className="omt-button" onClick={() => setReload((value) => value + 1)}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  const summary = detail.summary;
  const duration = durationBetween(summary.started_at, summary.ended_at);
  const isFailed = failed(summary);

  return (
    <article className="omt-session-detail" aria-labelledby="omt-session-title">
      <div className="omt-detail-back">
        <button type="button" className="omt-button omt-button-ghost" onClick={back}>
          ← Sessions
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

      <header className="omt-session-header">
        <div className="omt-session-header-top">
          <div className="omt-session-heading">
            <h1 className="omt-title" id="omt-session-title">
              {summary.title !== null && summary.title !== "" ? summary.title : "Untitled session"}
            </h1>
            <div className="omt-header-badges">
              <span className="omt-source-badge">{summary.source ?? "unknown"}</span>
              <span className="omt-badge">{summary.harness ?? "—"}</span>
              <span className="omt-badge">{summary.model ?? "—"}</span>
              <span className={isFailed ? "omt-status omt-status-error" : "omt-status"}>
                {isFailed ? "error" : summary.status}
              </span>
            </div>
            <code className="omt-session-id" title={summary.session_id}>
              {summary.session_id}
            </code>
          </div>
        </div>

        <div className="omt-cwd-line">
          <span className="omt-metric-label">cwd</span>
          <code>{summary.cwd ?? "—"}</code>
        </div>

        <div className="omt-metric-grid">
          <Metric label="started" value={formatTimestamp(summary.started_at)} />
          <Metric label="ended" value={formatTimestamp(summary.ended_at)} />
          <Metric label="duration" value={formatDurationMs(duration)} />
          <Metric label="turns" value={String(summary.turn_count)} />
          <Metric label="steps" value={String(summary.step_count)} />
          <Metric label="tool calls" value={String(summary.tool_call_count)} />
          <Metric
            label="tool errors"
            value={String(summary.tool_error_count)}
            tone={summary.tool_error_count > 0 ? "error" : undefined}
          />
          <Metric label="subagents" value={String(summary.subagent_count)} />
          <Metric
            label="tokens in"
            value={formatTokens(summary.usage.total.input_tokens)}
            tone="muted"
          />
          <Metric
            label="tokens out"
            value={formatTokens(summary.usage.total.output_tokens)}
            tone="muted"
          />
          <Metric
            label="usage coverage"
            value={formatCoverage(summary.usage.coverage)}
            title={`${summary.usage.covered} of ${summary.usage.calls} calls reported usage`}
            tone="muted"
          />
          <Metric label="status" value={isFailed ? "error" : summary.status} tone={isFailed ? "error" : undefined} />
        </div>
      </header>

      <section className="omt-timeline-section" aria-labelledby="omt-timeline-title">
        <div className="omt-section-heading omt-timeline-heading">
          <div>
            <h2 className="omt-section-title" id="omt-timeline-title">
              Step timeline
            </h2>
            <p className="omt-subtitle">
              Steps are grouped by turn. Expand a row to inspect its input, output and attributes.
            </p>
          </div>
        </div>
        <StepTimeline
          turns={detail.turns ?? []}
          onOpenSession={
            onOpenSession ??
            ((id) => {
              navigate(`/sessions/${encodeURIComponent(id)}`);
            })
          }
        />
      </section>
    </article>
  );
}
