import {
  Fragment,
  startTransition,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useNavigate, useParams } from "react-router";

import { llmCallSeries } from "@openmatel/core/llm";
import { segmentViews, turnViews } from "@openmatel/core/tree";
import type {
  LlmCallPoint,
  SegmentView,
  SessionStatus,
  TurnView,
} from "@openmatel/core";
import {
  projectCanonicalChatTurns,
  type CanonicalChatTurn,
} from "@openma/common/session-events/managed";
import {
  ObsProvider,
  durationBetween,
  formatCoverage,
  formatDurationMs,
  formatTokens,
  useObs,
  type ObsSessionDetail,
} from "@openmatel/ui";

import { Badge, StatusPill, type StatusTone } from "@/components/Badge";
import { BrandLoader } from "@/components/BrandLoader";
import { ChevronDownIcon, ClockIcon, DurationIcon } from "@/components/icons";
import { ManagedSessionConversation } from "@/components/session/ManagedSessionConversation";
import { TimelineView } from "@/components/timeline/TimelineView";
import { Button } from "@/components/ui/button";
import { formatDuration, formatRelative } from "@/lib/format";
import { useTheme } from "@console-shims/lib/theme";

import { client } from "../client";
import { isSyntheticModel, toManagedEvents } from "../adapter/to-managed-events";
import { CacheRatio } from "../components/CacheRatio";
import { IdleGapMarker } from "../components/IdleGapMarker";
import { SessionOverview } from "../components/overview/SessionOverview";
import { SegmentBoundaryNode } from "../components/SegmentBoundaryNode";
import { SubagentSteps } from "../components/SubagentSteps";
import { TrajectoryView } from "../components/trajectory/TrajectoryView";
import {
  EM_DASH,
  formatCount,
  formatIdleGapLabel,
  formatSignalLabel,
  formatSignalTitle,
  turnPromptPreview,
} from "../lib/session-format";
import {
  filterTurnGroups,
  groupTurnsBySegment,
  needsSegmentChrome,
  subagentSteps,
  type SegmentGroup,
  type TurnRow,
} from "../lib/session-view";

type View = "trajectory" | "turns" | "conversation" | "timeline";

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
  if (iso === null) return EM_DASH;
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return EM_DASH;
  return formatRelative(Date.now() - timestamp);
};

const absolute = (iso: string | null): string | undefined => {
  if (iso === null) return undefined;
  const timestamp = Date.parse(iso);
  return Number.isNaN(timestamp) ? undefined : new Date(timestamp).toLocaleString();
};

/**
 * Session detail with the layered segment → turn view as the default.
 *
 * The header, tabs and conversation/timeline surfaces stay identical to the
 * vendored console. `getSegments`, `getTurns` and `getLlmCalls` provide the
 * layered rows and the context series; the local core projections are a
 * fallback when an older Query implementation does not expose them.
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
  const [segments, setSegments] = useState<SegmentView[]>([]);
  const [turns, setTurns] = useState<TurnView[]>([]);
  const [calls, setCalls] = useState<LlmCallPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [view, setView] = useState<View>("trajectory");
  const [overviewTurnIds, setOverviewTurnIds] = useState<ReadonlySet<string> | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSegments([]);
    setTurns([]);
    setCalls([]);
    setOverviewTurnIds(null);

    const load = async (): Promise<void> => {
      const value = await obsClient.getSession(sessionId);
      if (cancelled) return;
      setDetail(value);

      const events = value.turns.flatMap((turn) => turn.events);
      const [segmentPage, turnPage, callPage] = await Promise.all([
        obsClient.getSegments(sessionId).catch(() => null),
        obsClient.getTurns(sessionId).catch(() => null),
        obsClient.getLlmCalls(sessionId).catch(() => null),
      ]);
      if (cancelled) return;

      setSegments(segmentPage?.items ?? segmentViews(events));
      setTurns(turnPage?.items ?? turnViews(events));
      setCalls(callPage?.items ?? llmCallSeries(events));
    };

    load()
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

  // Lightweight live refresh: only while the session is running and only when
  // the injected client exposes the re-fetch methods. A failed poll is
  // deliberately silent — the previous snapshot stays on screen.
  useEffect(() => {
    if (detail === null) return;
    if ((detail.summary.status as string) !== "running") return;
    const client = obsClient as unknown as Record<string, unknown>;
    const canRefetch = [
      "getSession",
      "getSegments",
      "getTurns",
      "getLlmCalls",
    ].every((name) => typeof client[name] === "function");
    if (!canRefetch) return;

    let cancelled = false;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const value = await obsClient.getSession(sessionId);
          if (cancelled) return;
          const [segmentPage, turnPage, callPage] = await Promise.all([
            obsClient.getSegments(sessionId).catch(() => null),
            obsClient.getTurns(sessionId).catch(() => null),
            obsClient.getLlmCalls(sessionId).catch(() => null),
          ]);
          if (cancelled) return;
          const fetchedEvents = value.turns.flatMap((turn) => turn.events);
          startTransition(() => {
            setDetail(value);
            setSegments(segmentPage?.items ?? segmentViews(fetchedEvents));
            setTurns(turnPage?.items ?? turnViews(fetchedEvents));
            setCalls(callPage?.items ?? llmCallSeries(fetchedEvents));
          });
        } catch {
          // Best-effort polling: keep the last good snapshot.
        }
      })();
    }, 5_000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [obsClient, sessionId, detail?.summary.status]);

  const events = useMemo(
    () => (detail === null ? [] : toManagedEvents(detail)),
    [detail],
  );

  const chatTurns = useMemo<CanonicalChatTurn[]>(
    () => projectCanonicalChatTurns(events),
    [events],
  );

  const groups = useMemo(
    () => groupTurnsBySegment(segments, turns),
    [segments, turns],
  );
  const visibleGroups = useMemo(
    () =>
      overviewTurnIds === null
        ? groups
        : filterTurnGroups(groups, overviewTurnIds),
    [groups, overviewTurnIds],
  );
  const visibleTurnCount = visibleGroups.reduce(
    (total, group) => total + group.turns.length,
    0,
  );
  const showSegmentChrome = needsSegmentChrome(visibleGroups);
  const filterActive = overviewTurnIds !== null;

  const openChildSession = (childSessionId: string): void => {
    navigate(`/sessions/${encodeURIComponent(childSessionId)}`);
  };

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
      {/* Header: title + the console's badge strip. Tokens in is the full
          context size (input + cache read + cache write), not raw input. */}
      <div className="flex shrink-0 flex-col gap-2 py-3 pl-3 pr-4">
        <div className="flex min-h-8 min-w-0 items-center gap-2">
          <h2 className="min-w-0 truncate text-sm font-medium text-fg" title={summary.session_id}>
            {summary.title !== null && summary.title !== "" ? summary.title : "Untitled session"}
          </h2>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status={status} label={summary.status} />
          <Badge label={summary.source ?? EM_DASH} title="Source" />
          {summary.harness !== null && summary.harness !== summary.source && (
            <Badge label={summary.harness} title="Harness" />
          )}
          <Badge label={model ?? EM_DASH} title="Model" />
          <Badge label={summary.cwd ?? EM_DASH} title={summary.cwd ?? "Working directory"} />
          <Badge
            icon={<DurationIcon />}
            label={duration === null ? EM_DASH : formatDuration(duration)}
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
            label={`${formatCount(summary.tool_error_count)} tool error${
              summary.tool_error_count === 1 ? "" : "s"
            }`}
            title={`${formatCount(summary.tool_error_count)} of ${formatCount(
              summary.tool_call_count,
            )} tool calls failed`}
          />
          <Badge
            label={`tokens in ${formatTokens(summary.tokens_in)} · out ${formatTokens(
              usage.total.output_tokens,
            )} · ${formatCoverage(usage.coverage)}`}
            title={`tokens in is the sum of context_tokens (input + cache read + cache write); ${usage.covered} of ${usage.calls} model calls reported usage`}
          />
          <CacheRatio ratio={summary.cache_hit_ratio} />
          <Badge
            label={`peak context ${formatTokens(summary.context_tokens_peak)}`}
            title="Largest context_tokens of any model call in the session"
          />
        </div>
      </div>

      {/* View tabs — same controls and active treatment as the console.
          Trajectory is the default; Turns keeps the per-turn waterfall and
          Timeline keeps the original full-session waterfall. */}
      <div role="tablist" aria-label="Session view" className="flex shrink-0 items-center gap-1 pl-3 pr-4">
        <ViewTab
          label="Trajectory"
          active={view === "trajectory"}
          onClick={() => startTransition(() => setView("trajectory"))}
        />
        <ViewTab
          label="Turns"
          active={view === "turns"}
          onClick={() => startTransition(() => setView("turns"))}
        />
        <ViewTab
          label="Conversation"
          active={view === "conversation"}
          onClick={() => startTransition(() => setView("conversation"))}
        />
        <ViewTab
          label="Timeline"
          active={view === "timeline"}
          onClick={() => startTransition(() => setView("timeline"))}
        />
        {view === "timeline" && (
          <span className="ml-auto font-mono text-xs text-fg-subtle">{events.length} events</span>
        )}
        {view === "turns" && (
          <span className="ml-auto font-mono text-xs text-fg-subtle">
            {filterActive
              ? `${visibleTurnCount} of ${turns.length}`
              : turns.length}{" "}
            turn{turns.length === 1 ? "" : "s"} · {segments.length} segment
            {segments.length === 1 ? "" : "s"}
          </span>
        )}
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {view === "trajectory" ? (
          <TrajectoryView
            summary={summary}
            segments={segments}
            turns={turns}
            calls={calls}
          />
        ) : view === "turns" ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
            <div className="flex flex-col gap-3 px-3 pb-6 pt-1 sm:px-4">
              <SessionOverview
                turns={turns}
                calls={calls}
                segments={segments}
                onFilterChange={setOverviewTurnIds}
              />

              {groups.length === 0 ? (
                <div className="rounded-lg border border-border bg-bg-surface/30 px-4 py-8 text-center text-sm text-fg-muted">
                  This session has no turns.
                </div>
              ) : visibleGroups.length === 0 ? (
                <div className="rounded-lg border border-border bg-bg-surface/30 px-4 py-8 text-center text-sm text-fg-muted">
                  No turns overlap the brushed range.
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  {visibleGroups.map((group) => (
                    <SegmentSection
                      key={group.segment_id}
                      group={group}
                      showChrome={showSegmentChrome}
                      onOpenChild={openChildSession}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : view === "conversation" ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <ManagedSessionConversation
              empty={
                <p className="text-sm text-fg-muted">This session has no conversation events.</p>
              }
              composer={null}
              sessionId={sessionId}
              turns={chatTurns}
            />
          </div>
        ) : (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <TimelineView key={sessionId} events={events} />
          </div>
        )}
      </div>
    </div>
  );
}

/** One context segment: collapsible when the session has more than one. */
function SegmentSection({
  group,
  showChrome,
  onOpenChild,
}: {
  group: SegmentGroup;
  showChrome: boolean;
  onOpenChild: (childSessionId: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const segment = group.segment;
  const turnCount = segment?.turn_count ?? group.turns.length;
  const leadingGaps = group.leading_idle_gaps;

  const rows = (
    <>
      {group.turns.map((row) => (
        <Fragment key={row.turn.turn_id}>
          {row.preceding_idle_gaps.map((gap) => (
            <IdleGapMarker
              key={`${gap.after_event_id}:${gap.before_event_id}`}
              gap={gap}
            />
          ))}
          <TurnRowComponent row={row} onOpenChild={onOpenChild} />
        </Fragment>
      ))}
    </>
  );

  if (!showChrome) {
    return (
      <div className="flex flex-col gap-2">
        {leadingGaps.map((gap) => (
          <IdleGapMarker
            key={`${gap.after_event_id}:${gap.before_event_id}`}
            gap={gap}
          />
        ))}
        {rows}
      </div>
    );
  }

  return (
    <section className="overflow-hidden rounded-lg border border-border bg-bg-surface/20">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border/60 px-2 py-1.5">
        <Button
          variant="ghost"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          className="min-h-11 rounded px-1.5 py-1 font-mono text-xs text-fg-muted hover:bg-bg-surface sm:min-h-0"
          title={expanded ? "Collapse segment" : "Expand segment"}
        >
          <ChevronDownIcon
            className={`h-3 w-3 transition-transform ${expanded ? "" : "-rotate-90"}`}
          />
          {group.segment_id}
        </Button>
        <span className="font-mono text-xs text-fg-subtle">
          {formatCount(turnCount)} turn{turnCount === 1 ? "" : "s"}
        </span>
        <Badge
          label={`tokens in ${formatTokens(segment?.tokens_in)}`}
          title="Segment context tokens (input + cache read + cache write)"
        />
        <Badge
          label={`peak context ${formatTokens(segment?.context_tokens_peak)}`}
          title="Largest context_tokens of any model call in this segment"
        />
        <CacheRatio ratio={segment?.cache_hit_ratio ?? null} />
      </div>

      {expanded && (
        <div className="flex flex-col gap-2 p-2">
          {leadingGaps.map((gap) => (
            <IdleGapMarker
              key={`${gap.after_event_id}:${gap.before_event_id}`}
              gap={gap}
            />
          ))}
          {segment !== null && segment.boundary !== undefined && (
            <SegmentBoundaryNode boundary={segment.boundary} />
          )}
          {group.turns.length === 0 ? (
            <p className="px-1 py-2 text-xs text-fg-muted">This segment has no turns.</p>
          ) : (
            rows
          )}
        </div>
      )}
    </section>
  );
}

/**
 * One turn row. Collapsed, it carries the prompt preview, step count, active
 * duration, context/output tokens and signals. Expanded, it mounts the
 * vendored `TimelineView` with *only* this turn's adapted events.
 */
function TurnRowComponent({
  row,
  onOpenChild,
}: {
  row: TurnRow;
  onOpenChild: (childSessionId: string) => void;
}) {
  const { turn } = row;
  const [expanded, setExpanded] = useState(false);
  const turnEvents = useMemo(
    () => toManagedEvents({ turns: [{ events: turn.events }] }),
    [turn.events],
  );
  const subagents = useMemo(() => subagentSteps(turn), [turn]);
  const signals = turn.signals.length > 0 ? turn.signals : turn.summary.signals;
  const internalIdleGaps = row.internal_idle_gaps;
  const internalIdleMs = internalIdleGaps.reduce(
    (total, gap) => total + gap.duration_ms,
    0,
  );
  const internalIdleTitle =
    internalIdleGaps.length === 0
      ? undefined
      : internalIdleGaps
          .map(
            (gap) =>
              `${new Date(gap.start).toLocaleString()} · ${formatIdleGapLabel(
                gap.duration_ms,
              )}`,
          )
          .join("; ");

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-bg-surface/30">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="flex w-full items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-bg-surface/50"
        title={turn.prompt ?? undefined}
      >
        <span className="mt-0.5 w-3 shrink-0 font-mono text-xs text-fg-subtle">
          {expanded ? "▾" : "▸"}
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-fg">
            {turnPromptPreview(turn.prompt)}
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-xs text-fg-subtle">
            <span title="Turn id">{turn.turn_id}</span>
            <span aria-hidden="true">·</span>
            <span title="Reason the turn stopped">{turn.stop_reason ?? EM_DASH}</span>
            {turn.status !== undefined && (
              <>
                <span aria-hidden="true">·</span>
                <span title="Turn status">{turn.status}</span>
              </>
            )}
          </span>
        </span>

        <span className="flex max-w-full flex-wrap items-center justify-end gap-1.5">
          <Badge label={`${formatCount(turn.step_count)} steps`} title="Steps in this turn" />
          <Badge
            icon={<DurationIcon />}
            label={`active ${formatDurationMs(turn.active_ms)}`}
            title="Active duration excludes idle gaps longer than 30 minutes"
          />
          {internalIdleGaps.length > 0 && (
            <Badge
              icon={<ClockIcon />}
              label={formatIdleGapLabel(internalIdleMs)}
              title={`Idle gaps inside this turn: ${internalIdleTitle}`}
            />
          )}          <Badge
            label={`tokens in ${formatTokens(turn.tokens_in)}`}
            title="Sum of context_tokens over this turn's model calls (input + cache read + cache write)"
          />
          <Badge
            label={`out ${formatTokens(turn.output_tokens)}`}
            title="Output tokens reported by this turn's model calls"
          />
          {signals.map((signal) => (
            <Badge
              key={`${turn.turn_id}:${signal.kind}`}
              label={<span className="text-warning">{formatSignalLabel(signal)}</span>}
              title={formatSignalTitle(signal)}
            />
          ))}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-border/60">
          <SubagentSteps steps={subagents} onOpen={onOpenChild} />
          {internalIdleGaps.length > 0 && (
            <div className="flex flex-col gap-1 px-3 pt-2">
              {internalIdleGaps.map((gap) => (
                <IdleGapMarker
                  key={`${gap.after_event_id}:${gap.before_event_id}`}
                  gap={gap}
                  showStart
                />
              ))}
            </div>
          )}
          <div className="flex h-[26rem] min-h-0 flex-col">
            <div className="flex shrink-0 items-center gap-2 px-3 py-1 font-mono text-xs text-fg-subtle">
              <span>turn timeline</span>
              <span aria-hidden="true">·</span>
              <span>{turnEvents.length} events</span>
            </div>
            <div className="flex min-h-0 flex-1 flex-col">
              <TimelineView
                key={`${turn.turn_id}:${turnEvents.length}`}
                events={turnEvents}
              />
            </div>
          </div>
        </div>
      )}
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
