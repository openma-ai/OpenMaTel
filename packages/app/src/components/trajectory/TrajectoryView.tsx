import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type {
  AgentEvent,
  LlmCallPoint,
  SegmentView,
  SessionSummary,
  TurnView,
} from "@openmatel/core";

import { Button } from "@/components/ui/button";

import { SessionOverview } from "../overview/SessionOverview";
import {
  buildLedger,
  filterLedger,
  firstRowIndexInTimeRange,
  tailWindow,
  type LedgerRow,
} from "../../lib/ledger";
import {
  ledgerWindowFraction,
  rowIndexForSpan,
  shouldFollowTail,
  stepMatch,
  turnNumbers,
} from "../../lib/trajectory";
import {
  OVERVIEW_MODES,
  type OverviewMode,
  type OverviewSpan,
  type OverviewTimeRange,
} from "../../lib/overview-timeline";
import {
  TrajectoryInspector,
} from "./TrajectoryInspector";
import {
  TrajectoryLedger,
  type TrajectoryLedgerHandle,
} from "./TrajectoryLedger";

/** Rows rendered initially and loaded per "Load earlier" click. */
const PAGE_SIZE = 400;

export interface TrajectoryViewProps {
  summary: SessionSummary;
  segments: readonly SegmentView[];
  turns: readonly TurnView[];
  calls: readonly LlmCallPoint[];
}

/**
 * The Trajectory tab: a fixed overview minimap, a virtualized ledger and a
 * right-hand inspector.
 *
 * Interaction summary:
 * - wheel over the overview zooms around the cursor; right-drag pans, and
 *   right-click resets both zoom and brush;
 * - the overview brush dims (or hides) rows outside the selected turns and
 *   time range, then reveals the first row inside that range;
 * - clicking an overview bar scrolls the ledger to the matching row;
 * - turn headers are sticky, clicking one collapses it, and its waterfall
 *   button expands the vendored TimelineView inline;
 * - the ledger starts at the tail and prepends earlier history without moving
 *   the reading position; a live session follows the tail while pinned.
 */
export function TrajectoryView({
  summary,
  segments,
  turns,
  calls,
}: TrajectoryViewProps) {
  const [mode, setMode] = useState<OverviewMode>("sequence");
  const [query, setQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(-1);
  const [collapsedTurns, setCollapsedTurns] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [collapseCalls, setCollapseCalls] = useState(false);
  const [hideOthers, setHideOthers] = useState(false);
  const [overviewTurnIds, setOverviewTurnIds] = useState<ReadonlySet<string> | null>(
    null,
  );
  const [overviewTimeRange, setOverviewTimeRange] =
    useState<OverviewTimeRange | null>(null);
  const [brushVersion, setBrushVersion] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [expandedWaterfallTurnId, setExpandedWaterfallTurnId] = useState<
    string | null
  >(null);
  const [windowStart, setWindowStart] = useState(0);
  const [atBottom, setAtBottom] = useState(true);
  const [visibleRange, setVisibleRange] = useState({ start: 0, end: 0 });
  const [revealTarget, setRevealTarget] = useState<{
    id: string;
    nonce: number;
  } | null>(null);

  const ledgerRef = useRef<TrajectoryLedgerHandle | null>(null);
  const initializedRef = useRef(false);
  const previousLengthRef = useRef(0);
  const handledBrushRef = useRef(0);

  const eventsById = useMemo(() => {
    const byId = new Map<string, AgentEvent>();
    for (const turn of turns) {
      for (const event of turn.events) {
        if (event.event_id !== "") byId.set(event.event_id, event);
      }
    }
    for (const segment of segments) {
      const boundary = segment.boundary;
      if (boundary !== undefined && boundary.event_id !== "") {
        byId.set(boundary.event_id, boundary);
      }
    }
    return byId;
  }, [segments, turns]);

  const turnsById = useMemo(() => {
    const byId = new Map<string, TurnView>();
    for (const turn of turns) byId.set(turn.turn_id, turn);
    return byId;
  }, [turns]);

  const allRows = useMemo(
    () => buildLedger({ segments, turns, calls }),
    [segments, turns, calls],
  );
  const turnNumberById = useMemo(() => turnNumbers(allRows), [allRows]);

  const filtered = useMemo(
    () =>
      filterLedger(allRows, {
        query,
        turnIds: overviewTurnIds,
        timeRange: overviewTimeRange,
        collapsedTurns,
        collapseCalls,
        hideDimmed:
          hideOthers &&
          (overviewTurnIds !== null || overviewTimeRange !== null),
      }),
    [
      allRows,
      query,
      overviewTurnIds,
      overviewTimeRange,
      collapsedTurns,
      collapseCalls,
      hideOthers,
    ],
  );
  const rows = filtered.rows;
  const filterActive =
    overviewTurnIds !== null || overviewTimeRange !== null;

  const matchIds = useMemo(
    () => rows.filter((row) => filtered.matches.has(row.id)).map((row) => row.id),
    [rows, filtered.matches],
  );
  const currentMatchId =
    matchIndex >= 0 && matchIndex < matchIds.length
      ? matchIds[matchIndex] ?? null
      : null;

  const selectedRow =
    selectedId === null
      ? null
      : rows.find((row) => row.id === selectedId) ?? null;

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      ledgerRef.current?.scrollToBottom();
      setAtBottom(true);
    });
  }, []);

  const handleOverviewFilter = useCallback(
    (
      turnIds: ReadonlySet<string> | null,
      timeRange?: OverviewTimeRange | null,
    ) => {
      setOverviewTurnIds(turnIds);
      setOverviewTimeRange(timeRange ?? null);
      if (turnIds !== null) setBrushVersion((version) => version + 1);
    },
    [],
  );

  // Initial tail window + live follow. A reload that adds rows while the
  // reader is at the bottom stays pinned; running/unknown sessions do too.
  useEffect(() => {
    if (rows.length === 0) {
      previousLengthRef.current = 0;
      setWindowStart(0);
      return;
    }
    const previous = previousLengthRef.current;
    const grew = rows.length > previous;
    previousLengthRef.current = rows.length;

    if (!initializedRef.current) {
      initializedRef.current = true;
      setWindowStart(tailWindow(rows, { size: PAGE_SIZE }).start);
      scrollToBottom();
      return;
    }

    if (
      grew &&
      shouldFollowTail({
        status: summary.status,
        atBottom,
        rowsGrew: grew,
      })
    ) {
      setWindowStart(tailWindow(rows, { size: PAGE_SIZE }).start);
      scrollToBottom();
    }
  }, [rows.length, atBottom, summary.status, scrollToBottom]);

  useEffect(() => {
    setWindowStart((start) =>
      start >= rows.length ? Math.max(0, rows.length - PAGE_SIZE) : start,
    );
  }, [rows.length]);

  useEffect(() => {
    setMatchIndex(-1);
  }, [query]);

  useEffect(() => {
    if (matchIndex >= matchIds.length) setMatchIndex(-1);
  }, [matchIds.length, matchIndex]);

  useEffect(() => {
    if (selectedId !== null && selectedRow === null) setSelectedId(null);
  }, [selectedId, selectedRow]);

  const ensureWindowIncludes = useCallback(
    (index: number) => {
      if (index < 0) return;
      setWindowStart((start) => {
        if (index < start) return Math.max(0, index - PAGE_SIZE / 2);
        if (index >= start + PAGE_SIZE) {
          return Math.max(0, index - PAGE_SIZE / 2);
        }
        return start;
      });
    },
    [],
  );

  const focusRow = useCallback(
    (row: LedgerRow) => {
      setSelectedId(row.id);
      setInspectorOpen(true);
      const index = rows.findIndex((candidate) => candidate.id === row.id);
      ensureWindowIncludes(index);
      setRevealTarget((previous) => ({
        id: row.id,
        nonce: (previous?.nonce ?? 0) + 1,
      }));
    },
    [rows, ensureWindowIncludes],
  );

  useEffect(() => {
    if (revealTarget === null) return;
    const frame = requestAnimationFrame(() => {
      ledgerRef.current?.scrollToRowId(revealTarget.id);
    });
    return () => cancelAnimationFrame(frame);
  }, [revealTarget]);

  // A new brush should reveal its first row even when it is outside the
  // current tail window (or hidden by "hide others").
  useEffect(() => {
    if (brushVersion === handledBrushRef.current) return;
    handledBrushRef.current = brushVersion;
    if (overviewTimeRange === null) return;
    const index = firstRowIndexInTimeRange(rows, overviewTimeRange);
    const row = rows[index];
    if (row === undefined) return;
    ensureWindowIncludes(index);
    setRevealTarget((previous) => ({
      id: row.id,
      nonce: (previous?.nonce ?? 0) + 1,
    }));
  }, [brushVersion, overviewTimeRange, rows, ensureWindowIncludes]);

  const handleSelect = useCallback(
    (row: LedgerRow) => {
      setSelectedId(row.id);
      setInspectorOpen(true);
      const index = rows.findIndex((candidate) => candidate.id === row.id);
      if (
        index >= 0 &&
        (index < visibleRange.start || index >= visibleRange.end)
      ) {
        ensureWindowIncludes(index);
        setRevealTarget((previous) => ({
          id: row.id,
          nonce: (previous?.nonce ?? 0) + 1,
        }));
      }
    },
    [rows, visibleRange.start, visibleRange.end, ensureWindowIncludes],
  );

  const toggleTurn = useCallback((turnId: string) => {
    setCollapsedTurns((previous) => {
      const next = new Set(previous);
      if (next.has(turnId)) next.delete(turnId);
      else next.add(turnId);
      return next;
    });
    setExpandedWaterfallTurnId((current) =>
      current === turnId ? null : current,
    );
  }, []);

  const toggleWaterfall = useCallback((turnId: string) => {
    setExpandedWaterfallTurnId((current) =>
      current === turnId ? null : turnId,
    );
  }, []);

  const turnIds = useMemo(() => turns.map((turn) => turn.turn_id), [turns]);
  const allTurnsCollapsed =
    turnIds.length > 0 && turnIds.every((id) => collapsedTurns.has(id));
  const toggleAllTurns = (): void => {
    setCollapsedTurns(allTurnsCollapsed ? new Set() : new Set(turnIds));
    if (!allTurnsCollapsed) setExpandedWaterfallTurnId(null);
  };

  const navigateMatch = (direction: 1 | -1): void => {
    if (matchIds.length === 0) return;
    const next = stepMatch(matchIndex, matchIds.length, direction);
    setMatchIndex(next);
    const id = matchIds[next];
    const row = rows.find((candidate) => candidate.id === id);
    if (row !== undefined) focusRow(row);
  };

  const handleSpanActivate = useCallback(
    (span: OverviewSpan) => {
      const index = rowIndexForSpan(rows, {
        id: span.id,
        kind: span.kind,
        turn_id: span.turn_id,
        request_index: span.call?.request_index ?? null,
      });
      const row = rows[index];
      if (row !== undefined) focusRow(row);
    },
    [rows, focusRow],
  );

  const handleVisibleRangeChange = useCallback(
    (range: { start: number; end: number }) => {
      setVisibleRange((previous) =>
        previous.start === range.start && previous.end === range.end
          ? previous
          : range,
      );
    },
    [],
  );

  const handleAtBottomChange = useCallback((next: boolean) => {
    setAtBottom(next);
  }, []);

  const safeWindowStart =
    rows.length === 0 ? 0 : Math.min(windowStart, rows.length - 1);

  const windowFraction = useMemo(
    () =>
      ledgerWindowFraction(
        visibleRange.start,
        visibleRange.end,
        rows.length,
      ),
    [visibleRange.start, visibleRange.end, rows.length],
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-border px-3 py-2">
        <span className="font-mono text-xs text-fg-subtle">Duration</span>
        <div
          role="group"
          aria-label="Trajectory duration mode"
          className="inline-flex items-center gap-0.5 rounded-md border border-border p-0.5"
        >
          {OVERVIEW_MODES.map((option) => (
            <Button
              key={option.value}
              variant="ghost"
              size="xs"
              type="button"
              aria-pressed={mode === option.value}
              title={option.title}
              onClick={() => setMode(option.value)}
              className={
                mode === option.value
                  ? "bg-bg-surface font-semibold text-brand"
                  : "text-fg-subtle hover:text-fg-muted"
              }
            >
              {option.label}
            </Button>
          ))}
        </div>

        <Button
          variant="ghost"
          size="xs"
          type="button"
          onClick={toggleAllTurns}
          aria-pressed={allTurnsCollapsed}
          title={allTurnsCollapsed ? "Expand all turns" : "Collapse all turns"}
          className="border border-border text-fg-muted"
        >
          <span aria-hidden="true">{allTurnsCollapsed ? "⊞" : "⊟"}</span>
          Turns
        </Button>
        <Button
          variant="ghost"
          size="xs"
          type="button"
          onClick={() => setCollapseCalls((value) => !value)}
          aria-pressed={collapseCalls}
          title={collapseCalls ? "Show tool calls" : "Collapse tool calls"}
          className="border border-border text-fg-muted"
        >
          <span aria-hidden="true">{collapseCalls ? "⊞" : "⊟"}</span>
          Calls
        </Button>
        {filterActive && (
          <Button
            variant="ghost"
            size="xs"
            type="button"
            onClick={() => setHideOthers((value) => !value)}
            aria-pressed={hideOthers}
            title={
              hideOthers
                ? "Show rows outside the brushed turns again"
                : "Hide rows outside the brushed turns"
            }
            className="border border-border text-fg-muted"
          >
            hide others
          </Button>
        )}

        <div className="ml-auto flex min-w-0 items-center gap-1.5">
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              navigateMatch(event.shiftKey ? -1 : 1);
            }}
            placeholder="Search ledger"
            aria-label="Search trajectory ledger"
            className="h-6 w-44 min-w-0 rounded-md border border-border bg-bg px-2 font-mono text-xs text-fg outline-none placeholder:text-fg-subtle focus:border-border-strong sm:w-56"
          />
          <span className="w-12 shrink-0 text-right font-mono text-xs text-fg-subtle">
            {query.trim() === ""
              ? ""
              : `${currentMatchId === null ? 0 : matchIndex + 1}/${matchIds.length}`}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            type="button"
            onClick={() => navigateMatch(-1)}
            disabled={matchIds.length === 0}
            title="Previous match (Shift+Enter)"
            aria-label="Previous search match"
            className="border border-border text-fg-subtle"
          >
            ‹
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            type="button"
            onClick={() => navigateMatch(1)}
            disabled={matchIds.length === 0}
            title="Next match (Enter)"
            aria-label="Next search match"
            className="border border-border text-fg-subtle"
          >
            ›
          </Button>
        </div>
      </div>

      <SessionOverview
        turns={turns}
        calls={calls}
        segments={segments}
        onFilterChange={handleOverviewFilter}
        mode={mode}
        onModeChange={setMode}
        hideModeControl
        windowFraction={windowFraction}
        onSpanActivate={handleSpanActivate}
        className="w-full shrink-0 rounded-none border-x-0 border-t-0"
      />

      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <TrajectoryLedger
          ref={ledgerRef}
          rows={rows}
          windowStart={safeWindowStart}
          turnNumbers={turnNumberById}
          turnsById={turnsById}
          dimmed={filtered.dimmed}
          matches={filtered.matches}
          currentMatchId={currentMatchId}
          collapsedTurns={collapsedTurns}
          expandedWaterfallTurnId={expandedWaterfallTurnId}
          selectedId={selectedId}
          onSelect={handleSelect}
          onToggleTurn={toggleTurn}
          onToggleWaterfall={toggleWaterfall}
          onLoadEarlier={() =>
            setWindowStart((start) =>
              Math.max(0, Math.min(start, safeWindowStart) - PAGE_SIZE),
            )
          }
          onAtBottomChange={handleAtBottomChange}
          onVisibleRangeChange={handleVisibleRangeChange}
        />
        {selectedRow !== null && inspectorOpen && (
          <TrajectoryInspector
            row={selectedRow}
            turnNumber={
              selectedRow.turn_id === null
                ? null
                : turnNumberById.get(selectedRow.turn_id) ?? null
            }
            calls={calls}
            sessionUsage={summary.usage}
            eventsById={eventsById}
            onClose={() => setInspectorOpen(false)}
          />
        )}
      </div>
    </div>
  );
}
