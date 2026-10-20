import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type UIEvent as ReactUIEvent,
} from "react";

import type { TurnView } from "@openmatel/core";

import { Button } from "@/components/ui/button";
import { TimelineView } from "@/components/timeline/TimelineView";

import { toManagedEvents } from "../../adapter/to-managed-events";
import type { LedgerRow } from "../../lib/ledger";
import {
  anchoredScrollTop,
  buildRowLayout,
  findVisibleRange,
  isNearBottom,
  LEDGER_ROW_HEIGHT,
  ledgerRowHeight,
  scrollTopForRow,
  WATERFALL_ROW_HEIGHT,
} from "../../lib/trajectory";
import { TrajectoryKindBadge } from "./TrajectoryKindBadge";

type LedgerItem =
  | { type: "load_earlier"; key: string; height: number }
  | {
      type: "row";
      key: string;
      height: number;
      row: LedgerRow;
      localIndex: number;
    }
  | {
      type: "waterfall";
      key: string;
      height: number;
      turnId: string;
      localIndex: number;
    };

export interface TrajectoryLedgerHandle {
  scrollToRowId(id: string): void;
  scrollToBottom(): void;
  focus(): void;
}

export interface TrajectoryLedgerProps {
  /** All filtered rows; the ledger only renders its tail window. */
  rows: readonly LedgerRow[];
  /** Index of the first loaded row in `rows`. */
  windowStart: number;
  turnNumbers: ReadonlyMap<string, number>;
  turnsById: ReadonlyMap<string, TurnView>;
  dimmed: ReadonlySet<string>;
  matches: ReadonlySet<string>;
  currentMatchId: string | null;
  collapsedTurns: ReadonlySet<string>;
  expandedWaterfallTurnId: string | null;
  selectedId: string | null;
  onSelect: (row: LedgerRow) => void;
  onToggleTurn: (turnId: string) => void;
  onToggleWaterfall: (turnId: string) => void;
  onLoadEarlier: () => void;
  onAtBottomChange: (atBottom: boolean) => void;
  onVisibleRangeChange: (range: { start: number; end: number }) => void;
  className?: string;
}

/**
 * Virtualized fixed-height Trajectory ledger.
 *
 * The list is rendered as three fixed blocks — a top spacer, the visible rows
 * (with overscan) and a bottom spacer — so a 10k-row session only mounts the
 * ~30 rows around the viewport. Inline turn waterfalls are the one variable
 * height; they participate in the same offset table, so scrolling stays
 * correct around them.
 */
export const TrajectoryLedger = forwardRef<
  TrajectoryLedgerHandle,
  TrajectoryLedgerProps
>(function TrajectoryLedger(
  {
    rows,
    windowStart,
    turnNumbers,
    turnsById,
    dimmed,
    matches,
    currentMatchId,
    collapsedTurns,
    expandedWaterfallTurnId,
    selectedId,
    onSelect,
    onToggleTurn,
    onToggleWaterfall,
    onLoadEarlier,
    onAtBottomChange,
    onVisibleRangeChange,
    className,
  },
  ref,
) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(480);
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(true);
  const pendingAnchorRef = useRef<{
    height: number;
    top: number;
  } | null>(null);

  const startIndex = Math.min(Math.max(0, windowStart), rows.length);
  const windowRows = useMemo(
    () => rows.slice(startIndex),
    [rows, startIndex],
  );
  const hasEarlier = startIndex > 0;

  const items = useMemo<LedgerItem[]>(() => {
    const next: LedgerItem[] = [];
    if (hasEarlier) {
      next.push({
        type: "load_earlier",
        key: "load-earlier",
        height: LEDGER_ROW_HEIGHT,
      });
    }
    windowRows.forEach((row, localIndex) => {
      next.push({
        type: "row",
        key: `row:${row.id}`,
        height: ledgerRowHeight(row.kind),
        row,
        localIndex,
      });
      if (
        row.kind === "turn_header" &&
        row.turn_id !== null &&
        row.turn_id === expandedWaterfallTurnId
      ) {
        next.push({
          type: "waterfall",
          key: `waterfall:${row.id}`,
          height: WATERFALL_ROW_HEIGHT,
          turnId: row.turn_id,
          localIndex,
        });
      }
    });
    return next;
  }, [hasEarlier, windowRows, expandedWaterfallTurnId]);

  const layout = useMemo(
    () => buildRowLayout(items.map((item) => item.height)),
    [items],
  );

  const visible = useMemo(
    () => findVisibleRange(layout, scrollTop, viewportHeight, 8),
    [layout, scrollTop, viewportHeight],
  );

  const emitAtBottom = useCallback(
    (next: boolean) => {
      if (atBottomRef.current === next) return;
      atBottomRef.current = next;
      setAtBottom(next);
      onAtBottomChange(next);
    },
    [onAtBottomChange],
  );

  // Keep the viewport height in sync with the real scroll container.
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (node === null) return;
    const update = (): void => setViewportHeight(node.clientHeight);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const onScroll = (event: ReactUIEvent<HTMLDivElement>): void => {
    const node = event.currentTarget;
    setScrollTop(node.scrollTop);
    emitAtBottom(isNearBottom(node.scrollTop, node.clientHeight, node.scrollHeight));
  };

  useImperativeHandle(
    ref,
    () => ({
      scrollToRowId(id: string): void {
        const node = scrollRef.current;
        if (node === null) return;
        const index = items.findIndex(
          (item) => item.type === "row" && item.row.id === id,
        );
        if (index < 0) return;
        const top = scrollTopForRow(layout, index);
        // Leave room for the pinned turn header so the revealed row is not
        // hidden underneath it.
        node.scrollTop = Math.max(0, top - (top > 0 ? LEDGER_ROW_HEIGHT : 0));
        setScrollTop(node.scrollTop);
      },
      scrollToBottom(): void {
        const node = scrollRef.current;
        if (node === null) return;
        node.scrollTop = node.scrollHeight;
        setScrollTop(node.scrollTop);
        emitAtBottom(true);
      },
      focus(): void {
        scrollRef.current?.focus();
      },
    }),
    [items, layout, emitAtBottom],
  );

  // Keep the first loaded row anchored when "Load earlier" prepends history.
  useLayoutEffect(() => {
    const pending = pendingAnchorRef.current;
    if (pending === null) return;
    const node = scrollRef.current;
    if (node === null) return;
    node.scrollTop = anchoredScrollTop(
      pending.height,
      pending.top,
      node.scrollHeight,
    );
    pendingAnchorRef.current = null;
    setScrollTop(node.scrollTop);
  }, [layout.total]);

  const handleLoadEarlier = (): void => {
    const node = scrollRef.current;
    if (node === null) return;
    pendingAnchorRef.current = {
      height: node.scrollHeight,
      top: node.scrollTop,
    };
    onLoadEarlier();
  };

  const visibleRows = useMemo(() => {
    let first = -1;
    let last = -1;
    for (let index = visible.start; index < visible.end; index += 1) {
      const item = items[index];
      if (item === undefined) continue;
      if (item.type === "row" || item.type === "waterfall") {
        if (first < 0 || item.localIndex < first) first = item.localIndex;
        if (last < 0 || item.localIndex > last) last = item.localIndex;
      }
    }
    if (first < 0) return { start: startIndex, end: startIndex };
    return {
      start: startIndex + first,
      end: startIndex + last + 1,
    };
  }, [items, visible.start, visible.end, startIndex]);

  useEffect(() => {
    onVisibleRangeChange(visibleRows);
  }, [onVisibleRangeChange, visibleRows.start, visibleRows.end]);

  const firstVisibleRow = visibleRows.start;
  const stickyRow = useMemo(() => {
    if (scrollTop <= 2 || rows.length === 0) return null;
    const ceiling = Math.min(firstVisibleRow, rows.length - 1);
    for (let index = ceiling; index >= 0; index -= 1) {
      const row = rows[index];
      if (row !== undefined && row.kind === "turn_header") return row;
    }
    return null;
  }, [scrollTop, rows, firstVisibleRow]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const direction = event.key === "ArrowDown" ? 1 : -1;
    const currentIndex =
      selectedId === null
        ? -1
        : rows.findIndex((row) => row.id === selectedId);
    const base =
      currentIndex < 0
        ? Math.min(firstVisibleRow, rows.length - 1) - direction
        : currentIndex;
    const nextIndex = Math.min(
      rows.length - 1,
      Math.max(0, base + direction),
    );
    const next = rows[nextIndex];
    if (next !== undefined) onSelect(next);
  };

  if (rows.length === 0) {
    return (
      <div
        className={`flex min-h-0 min-w-0 flex-1 items-center justify-center px-4 text-sm text-fg-muted ${
          className ?? ""
        }`.trim()}
      >
        This session has no trajectory rows.
      </div>
    );
  }

  const rendered = items.slice(visible.start, visible.end);
  const topHeight = layout.offsets[visible.start] ?? 0;
  const bottomHeight = Math.max(0, layout.total - (layout.offsets[visible.end] ?? 0));

  return (
    <div className={`relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${className ?? ""}`.trim()}>
      <div
        ref={scrollRef}
        role="listbox"
        aria-label="Trajectory ledger"
        tabIndex={0}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          scrollRef.current?.focus({ preventScroll: true });
        }}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden font-mono outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-fg/15"
        data-trajectory-ledger
      >
        <div style={{ height: topHeight }} aria-hidden="true" />
        {rendered.map((item) => {
          if (item.type === "load_earlier") {
            return (
              <button
                key={item.key}
                type="button"
                onClick={handleLoadEarlier}
                style={{ height: item.height }}
                className="flex w-full items-center justify-center gap-2 border-b border-dashed border-border bg-bg-surface/20 px-2 font-mono text-xs text-fg-muted hover:bg-bg-surface/50"
                title="Load earlier rows without moving the reading position"
              >
                <span aria-hidden="true">↑</span>
                Load earlier ({startIndex})
              </button>
            );
          }

          if (item.type === "waterfall") {
            const turn = turnsById.get(item.turnId);
            return (
              <TurnWaterfall
                key={item.key}
                height={item.height}
                turn={turn}
                turnNumber={turnNumbers.get(item.turnId) ?? null}
              />
            );
          }

          return (
            <LedgerRowView
              key={item.key}
              row={item.row}
              height={item.height}
              selected={selectedId === item.row.id}
              dimmed={dimmed.has(item.row.id)}
              matched={matches.has(item.row.id)}
              currentMatch={currentMatchId === item.row.id}
              collapsed={
                item.row.turn_id !== null &&
                collapsedTurns.has(item.row.turn_id)
              }
              turnNumber={
                item.row.turn_id === null
                  ? null
                  : turnNumbers.get(item.row.turn_id) ?? null
              }
              waterfallOpen={
                item.row.turn_id !== null &&
                expandedWaterfallTurnId === item.row.turn_id
              }
              onSelect={onSelect}
              onToggleTurn={onToggleTurn}
              onToggleWaterfall={onToggleWaterfall}
            />
          );
        })}
        <div style={{ height: bottomHeight }} aria-hidden="true" />
      </div>

      {stickyRow !== null && (
        <div className="absolute inset-x-0 top-0 z-30 border-b border-border bg-bg/95 shadow-sm">
          <LedgerRowView
            row={stickyRow}
            height={LEDGER_ROW_HEIGHT}
            sticky
            selected={selectedId === stickyRow.id}
            dimmed={dimmed.has(stickyRow.id)}
            matched={matches.has(stickyRow.id)}
            currentMatch={currentMatchId === stickyRow.id}
            collapsed={
              stickyRow.turn_id !== null &&
              collapsedTurns.has(stickyRow.turn_id)
            }
            turnNumber={
              stickyRow.turn_id === null
                ? null
                : turnNumbers.get(stickyRow.turn_id) ?? null
            }
            waterfallOpen={
              stickyRow.turn_id !== null &&
              expandedWaterfallTurnId === stickyRow.turn_id
            }
            onSelect={onSelect}
            onToggleTurn={onToggleTurn}
            onToggleWaterfall={onToggleWaterfall}
          />
        </div>
      )}

      {!atBottom && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 z-30 flex justify-center">
          <Button
            variant="ghost"
            size="xs"
            type="button"
            onClick={() => {
              const node = scrollRef.current;
              if (node === null) return;
              node.scrollTop = node.scrollHeight;
              setScrollTop(node.scrollTop);
              emitAtBottom(true);
            }}
            className="pointer-events-auto border border-border bg-bg-surface text-fg-muted shadow-sm hover:border-border-strong"
            title="Scroll to the newest row and follow the live tail"
          >
            Jump to latest ↓
          </Button>
        </div>
      )}
    </div>
  );
});

function LedgerRowView({
  row,
  height,
  selected,
  dimmed,
  matched,
  currentMatch,
  collapsed,
  turnNumber,
  waterfallOpen,
  sticky = false,
  onSelect,
  onToggleTurn,
  onToggleWaterfall,
}: {
  row: LedgerRow;
  height: number;
  selected: boolean;
  dimmed: boolean;
  matched: boolean;
  currentMatch: boolean;
  collapsed: boolean;
  turnNumber: number | null;
  waterfallOpen: boolean;
  sticky?: boolean;
  onSelect: (row: LedgerRow) => void;
  onToggleTurn: (turnId: string) => void;
  onToggleWaterfall: (turnId: string) => void;
}) {
  const isHeader = row.kind === "turn_header";
  const background = row.error
    ? "bg-danger-subtle/35"
    : selected
      ? "bg-bg-surface"
      : currentMatch
        ? "bg-warning/15"
        : matched
          ? "bg-warning/5"
          : "hover:bg-bg-surface/40";
  const wrapper = `w-full min-w-0 overflow-hidden border-l-2 ${
    selected ? "border-brand" : "border-transparent"
  } ${dimmed ? "opacity-40" : ""} ${
    sticky && !selected && !row.error ? "bg-bg" : ""
  }`;

  const select = (): void => {
    onSelect(row);
    if (isHeader && row.turn_id !== null) onToggleTurn(row.turn_id);
  };

  const errorDot = row.error ? (
    <span
      role="img"
      aria-label="error"
      title="error"
      className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger"
    />
  ) : null;

  if (row.kind === "request") {
    return (
      <div
        role="option"
        aria-selected={selected}
        data-ledger-row-id={row.id}
        data-row-kind={row.kind}
        className={`${wrapper} ${background} cursor-pointer`}
        style={{ height }}
        onClick={() => onSelect(row)}
        title={row.summary}
      >
        <div className="flex h-full min-w-0 items-center gap-1.5 border-t border-border/60 px-2">
          <span
            className={`min-w-0 flex-1 truncate text-right font-mono text-[10px] leading-none ${
              row.error ? "text-danger" : "text-fg-subtle"
            }`}
          >
            {row.summary}
          </span>
          {errorDot}
        </div>
      </div>
    );
  }

  return (
    <div
      role="option"
      aria-selected={selected}
      aria-expanded={isHeader ? !collapsed : undefined}
      data-ledger-row-id={row.id}
      data-row-kind={row.kind}
      data-current-match={currentMatch || undefined}
      data-matched={matched || undefined}
      className={`${wrapper} ${background} cursor-pointer`}
      style={{ height }}
      onClick={select}
      title={row.summary}
    >
      <div
        className={`flex h-full min-w-0 items-center gap-2 px-2 text-xs ${
          isHeader ? "border-b border-border/50" : ""
        }`}
      >
        <span className="flex w-9 shrink-0 items-center justify-end pr-0.5 font-mono text-xs tabular-nums text-fg-subtle">
          {isHeader ? (
            <span aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
          ) : (
            (row.step ?? "")
          )}
        </span>
        <span className="flex w-[76px] shrink-0 items-center justify-end gap-1">
          <TrajectoryKindBadge kind={row.kind} />
          {errorDot}
        </span>
        <span
          className={`min-w-0 flex-1 truncate text-xs ${
            isHeader ? "text-fg" : row.error ? "text-danger" : "text-fg-muted"
          }`}
        >
          {row.summary}
        </span>
        {isHeader && turnNumber !== null && (
          <span className="shrink-0 text-xs text-fg-subtle">
            Turn {turnNumber}
          </span>
        )}
        {isHeader && row.turn_id !== null && (
          <Button
            variant="ghost"
            size="xs"
            type="button"
            aria-pressed={waterfallOpen}
            title={waterfallOpen ? "Hide turn waterfall" : "Show turn waterfall"}
            onClick={(event) => {
              event.stopPropagation();
              onToggleWaterfall(row.turn_id as string);
            }}
            className="h-5 shrink-0 border border-border px-1.5 text-xs text-fg-subtle hover:border-border-strong hover:text-fg-muted"
          >
            waterfall
          </Button>
        )}
      </div>
    </div>
  );
}

function TurnWaterfall({
  turn,
  turnNumber,
  height,
}: {
  turn: TurnView | undefined;
  turnNumber: number | null;
  height: number;
}) {
  const events = useMemo(
    () =>
      turn === undefined
        ? []
        : toManagedEvents({ turns: [{ events: turn.events }] }),
    [turn],
  );

  return (
    <div
      className="flex flex-col border-y border-border/60 bg-bg-surface/20"
      style={{ height }}
      data-trajectory-waterfall
    >
      <div className="flex shrink-0 items-center gap-2 px-3 py-1 font-mono text-xs text-fg-subtle">
        <span>turn timeline</span>
        <span aria-hidden="true">·</span>
        <span>{turnNumber === null ? "turn" : `Turn ${turnNumber}`}</span>
        <span aria-hidden="true">·</span>
        <span>{events.length} events</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <TimelineView
          key={`${turn?.turn_id ?? "unknown"}:${events.length}`}
          events={events}
        />
      </div>
    </div>
  );
}
