import { startTransition, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";

import {
  projectCanonicalChatTurns,
  type CanonicalChatTurn,
} from "@openma/common/session-events/managed";
import type { SessionStatus } from "@openmatel/core";
import {
  ObsProvider,
  durationBetween,
  formatCoverage,
  formatTokens,
  useObs,
  type ObsSessionDetail,
} from "@openmatel/ui";

import { Badge, StatusPill, type StatusTone } from "@/components/Badge";
import { BrandLoader } from "@/components/BrandLoader";
import { ClockIcon, DurationIcon } from "@/components/icons";
import { ManagedSessionConversation } from "@/components/session/ManagedSessionConversation";
import { TimelineView } from "@/components/timeline/TimelineView";
import { Button } from "@/components/ui/button";
import { formatDuration, formatRelative } from "@/lib/format";
import { useTheme } from "@console-shims/lib/theme";

import { client } from "../client";
import { isSyntheticModel, toManagedEvents } from "../adapter/to-managed-events";

type View = "conversation" | "timeline";

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const toneFor = (status: SessionStatus): StatusTone => {
  switch (status) {
    case "ok":
      return "completed";
    case "error":
    case "timeout":
    case "denied":
      return "errored";
    case "cancelled":
    case "interrupted":
      return "terminated";
    default:
      return "neutral";
  }
};

const relativeTo = (iso: string | null): string => {
  if (iso === null) return "—";
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return "—";
  return formatRelative(Date.now() - timestamp);
};

const absolute = (iso: string | null): string | undefined => {
  if (iso === null) return undefined;
  const timestamp = Date.parse(iso);
  return Number.isNaN(timestamp) ? undefined : new Date(timestamp).toLocaleString();
};

/**
 * Session detail, mirroring the OpenMA console's `pages/SessionDetail.tsx`
 * header/tabs/right-panel layout while feeding the vendored, unmodified
 * `TimelineView` and `ManagedSessionConversation` with adapted events.
 */
export function SessionDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { effective } = useTheme();

  if (id === undefined || id === "") {
    return <SessionNotFound onBack={() => navigate("/sessions")} />;
  }

  return (
    <ObsProvider
      client={client}
      navigate={(href) => navigate(href)}
      theme={effective}
      className="flex h-full min-h-0 flex-col"
    >
      <SessionDetailView key={id} sessionId={id} />
    </ObsProvider>
  );
}

function SessionDetailView({ sessionId }: { sessionId: string }) {
  const { client: obsClient } = useObs();
  const navigate = useNavigate();

  const [detail, setDetail] = useState<ObsSessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [view, setView] = useState<View>("timeline");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    obsClient
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
  }, [obsClient, sessionId, reload]);

  const events = useMemo(
    () => (detail === null ? [] : toManagedEvents(detail)),
    [detail],
  );

  const turns = useMemo<CanonicalChatTurn[]>(
    () => projectCanonicalChatTurns(events),
    [events],
  );

  if (loading && detail === null) {
    return (
      <div className="flex flex-1 items-center justify-center" role="status">
        <BrandLoader size="lg" label="Loading session" />
      </div>
    );
  }

  if (detail === null) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="max-w-md space-y-3 rounded-lg border border-border bg-bg-surface/30 p-5 text-center">
          <h2 className="text-sm font-semibold text-fg">Could not load this session.</h2>
          <p className="text-sm text-fg-muted">{error ?? "The session was not found."}</p>
          <div className="flex items-center justify-center gap-2">
            <Button variant="ghost" className="border border-border px-2.5 py-1 text-xs" onClick={() => navigate("/sessions")}>
              Back to sessions
            </Button>
            <Button variant="ghost" className="border border-border px-2.5 py-1 text-xs" onClick={() => setReload((value) => value + 1)}>
              Retry
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const summary = detail.summary;
  const model = isSyntheticModel(summary.model ?? undefined) ? null : summary.model;
  const duration = durationBetween(summary.started_at, summary.ended_at);
  const status = toneFor(summary.status);
  const usage = summary.usage;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header: title + the console's badge strip. Everything below wraps;
          time values are short (formatRelative/formatDuration) and carry the
          exact timestamp in the tooltip instead of being sliced. */}
      <div className="flex shrink-0 flex-col gap-2 py-3 pl-3 pr-4">
        <div className="flex min-h-8 min-w-0 items-center gap-2">
          <h2 className="min-w-0 truncate text-sm font-medium text-fg" title={summary.session_id}>
            {summary.title !== null && summary.title !== "" ? summary.title : "Untitled session"}
          </h2>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status={status} label={summary.status} />
          <Badge label={summary.source ?? "—"} title="Source" />
          {summary.harness !== null && summary.harness !== summary.source && (
            <Badge label={summary.harness} title="Harness" />
          )}
          <Badge label={model ?? "—"} title="Model" />
          <Badge label={summary.cwd ?? "—"} title={summary.cwd ?? "Working directory"} />
          <Badge
            icon={<DurationIcon />}
            label={duration === null ? "—" : formatDuration(duration)}
            title="Wall-clock duration of the session"
          />
          <Badge
            icon={<ClockIcon />}
            label={`started ${relativeTo(summary.started_at)}`}
            title={absolute(summary.started_at)}
          />
          {summary.ended_at !== null && (
            <Badge
              icon={<ClockIcon />}
              label={`ended ${relativeTo(summary.ended_at)}`}
              title={absolute(summary.ended_at)}
            />
          )}
          <Badge
            label={`${summary.tool_error_count} tool error${summary.tool_error_count === 1 ? "" : "s"}`}
            title={`${summary.tool_error_count} of ${summary.tool_call_count} tool calls failed`}
          />
          <Badge
            label={`tokens ${formatTokens(summary.tokens_in)}↓ ${formatTokens(usage.total.output_tokens)}↑ · ${formatCoverage(usage.coverage)}`}
            title={`${usage.covered} of ${usage.calls} model calls reported usage; tokens in is the full context (including cache)`}
          />
        </div>
      </div>

      {/* View tabs — same controls and active treatment as the console. */}
      <div role="tablist" aria-label="Session view" className="flex shrink-0 items-center gap-1 pl-3 pr-4">
        <ViewTab
          label="Conversation"
          active={view === "conversation"}
          onClick={() => setView("conversation")}
        />
        <ViewTab
          label="Timeline"
          active={view === "timeline"}
          onClick={() => startTransition(() => setView("timeline"))}
        />
        {view === "timeline" && (
          <span className="ml-auto font-mono text-xs text-fg-subtle">{events.length} events</span>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {view === "conversation" ? (
            <ManagedSessionConversation
              empty={
                <p className="text-sm text-fg-muted">This session has no conversation events.</p>
              }
              composer={null}
              sessionId={sessionId}
              turns={turns}
            />
          ) : (
            <TimelineView key={sessionId} events={events} />
          )}
        </div>
      </div>
    </div>
  );
}

function ViewTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      onClick={onClick}
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      className={`my-1.5 inline-flex min-h-11 items-center justify-center rounded-md px-3 py-2 text-sm transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] sm:min-h-0 ${
        active
          ? "bg-bg-surface font-semibold text-brand"
          : "text-fg-subtle hover:bg-bg-surface/60 hover:text-fg-muted"
      }`}
    >
      {label}
    </Button>
  );
}

function SessionNotFound({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="space-y-3 rounded-lg border border-border bg-bg-surface/30 p-5 text-center">
        <p className="text-sm text-fg-muted">Session not found.</p>
        <Button variant="ghost" className="border border-border px-2.5 py-1 text-xs" onClick={onBack}>
          Back to sessions
        </Button>
      </div>
    </div>
  );
}
