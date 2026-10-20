import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import type { LlmCallPoint, SegmentView, TurnView } from "@openmatel/core";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

import {
  buildOverviewModel,
  normalizeOverviewRange,
  OVERVIEW_MODES,
  overviewFraction,
  overviewSpanTooltip,
  timeRangeForRange,
  turnIdsForRange,
  type OverviewMode,
  type OverviewModel,
  type OverviewRange,
  type OverviewSpan,
  type OverviewTimeRange,
} from "../../lib/overview-timeline";
import {
  formatCompactTokens,
  formatIdleDuration,
} from "../../lib/session-format";
import {
  FULL_VIEWPORT,
  modelToScreenFraction,
  panViewport,
  screenToModelFraction,
  zoomViewport,
  type Viewport,
} from "../../lib/trajectory";

/** Pixels a pointer must travel before a press becomes a brush. */
const MINIMUM_DRAG_PX = 3;

/** Fixed SVG coordinate system of the watermark strip. */
const WATERMARK_WIDTH = 1_000;
const WATERMARK_HEIGHT = 32;
const WATERMARK_TOP = 4;
const WATERMARK_BOTTOM = 6;
const WATERMARK_PLOT = WATERMARK_HEIGHT - WATERMARK_TOP - WATERMARK_BOTTOM;

/** Everything the overview brush selects. */
export interface OverviewBrushSelection {
  turnIds: ReadonlySet<string>;
  /** Absolute wall-clock range, or `null` when it could not be mapped. */
  timeRange: OverviewTimeRange | null;
}

/** Alias kept for callers that prefer the shorter name. */
export type OverviewBrush = OverviewBrushSelection;

export interface SessionOverviewProps {
  turns: readonly TurnView[];
  calls: readonly LlmCallPoint[];
  segments: readonly SegmentView[];
  /**
   * Receives the turn ids overlapping the brush, or `null` when cleared.
   * The second argument is the same brush expressed as an absolute time range.
   */
  onFilterChange: (
    turnIds: ReadonlySet<string> | null,
    timeRange?: OverviewTimeRange | null,
  ) => void;
  /** Optional richer brush callback, including the time range. */
  onBrushChange?: (brush: OverviewBrushSelection | null) => void;
  idleThresholdMs?: number;
  className?: string;
  /** The ledger rows currently on screen, as a normalised `0..1` range. */
  windowFraction?: Viewport | null;
  /** Called when a lane bar is clicked; the parent scrolls its ledger. */
  onSpanActivate?: (span: OverviewSpan) => void;
  /** Controlled duration mode (the parent's toolbar can own the control). */
  mode?: OverviewMode;
  onModeChange?: (mode: OverviewMode) => void;
  /** Hide the built-in duration toggle when the toolbar owns it. */
  hideModeControl?: boolean;
}

/**
 * Three-lane session overview above the turn ledger (docs/design.md §16.2).
 *
 * Input messages, model calls (TTFT / decode split) and tool calls share one
 * horizontal domain. The context watermark sits directly under the Model lane
 * and segment boundaries are vertical markers. Dragging across the plot
 * brushes a range; the parent filters the ledger by the overlapping turns and
 * the equivalent absolute time range.
 */
export function SessionOverview({
  turns,
  calls,
  segments,
  onFilterChange,
  onBrushChange,
  idleThresholdMs,
  className,
  windowFraction,
  onSpanActivate,
  mode: controlledMode,
  onModeChange,
  hideModeControl = false,
}: SessionOverviewProps) {
  const [internalMode, setInternalMode] = useState<OverviewMode>("sequence");
  const mode = controlledMode ?? internalMode;
  const [selection, setSelection] = useState<OverviewRange | null>(null);
  const [draft, setDraft] = useState<OverviewRange | null>(null);
  const [viewport, setViewport] = useState<Viewport>(FULL_VIEWPORT);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    anchor: number;
    anchor_client_x: number;
    moved: boolean;
  } | null>(null);
  const panRef = useRef<{
    pointerId: number;
    start_client_x: number;
    start_viewport: Viewport;
    moved: boolean;
  } | null>(null);
  const lastPanAtRef = useRef(0);

  const model = useMemo(
    () =>
      buildOverviewModel({
        turns,
        calls,
        segments,
        mode,
        idle_threshold_ms: idleThresholdMs,
      }),
    [turns, calls, segments, mode, idleThresholdMs],
  );

  const publishFilter = useCallback(
    (turnIds: ReadonlySet<string> | null, timeRange: OverviewTimeRange | null) => {
      onFilterChange(turnIds, timeRange);
      onBrushChange?.(turnIds === null ? null : { turnIds, timeRange });
    },
    [onFilterChange, onBrushChange],
  );

  const clear = useCallback(() => {
    setSelection(null);
    setDraft(null);
    dragRef.current = null;
    publishFilter(null, null);
  }, [publishFilter]);

  const resetView = useCallback(() => {
    setViewport(FULL_VIEWPORT);
    clear();
  }, [clear]);

  const changeMode = (next: OverviewMode): void => {
    if (next === mode) return;
    if (controlledMode === undefined) setInternalMode(next);
    onModeChange?.(next);
    setViewport(FULL_VIEWPORT);
    clear();
  };

  // A different duration projection is a different coordinate system: drop
  // the zoom and brush rather than mapping them onto the new domain. The
  // first render is not a mode change and must not notify the parent.
  const previousModeRef = useRef<OverviewMode | null>(null);
  useEffect(() => {
    if (previousModeRef.current === null) {
      previousModeRef.current = mode;
      return;
    }
    if (previousModeRef.current === mode) return;
    previousModeRef.current = mode;
    setViewport(FULL_VIEWPORT);
    setDraft(null);
    setSelection(null);
    publishFilter(null, null);
  }, [mode, publishFilter]);

  // React attaches wheel listeners passively; use a native non-passive one so
  // the page does not scroll while the overview zooms.
  useEffect(() => {
    const node = trackRef.current;
    if (node === null || !model.has_data) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const rect = node.getBoundingClientRect();
      const anchor =
        rect.width > 0
          ? Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
          : 0.5;
      setViewport((current) => zoomViewport(current, anchor, event.deltaY));
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [model.has_data]);

  const projectFraction = (fraction: number): number =>
    modelToScreenFraction(viewport, fraction);

  const projectValue = (value: number): number =>
    projectFraction(overviewFraction(model, value));

  const fractionAt = (event: ReactPointerEvent<HTMLDivElement>): number => {
    const rect = event.currentTarget.getBoundingClientRect();
    return Math.min(
      1,
      Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width)),
    );
  };

  const domainAt = (event: ReactPointerEvent<HTMLDivElement>): number => {
    const modelFraction = screenToModelFraction(viewport, fractionAt(event));
    return model.domain.start + modelFraction * model.domain.duration;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!model.has_data) return;
    if (event.button === 2) {
      panRef.current = {
        pointerId: event.pointerId,
        start_client_x: event.clientX,
        start_viewport: viewport,
        moved: false,
      };
      if (typeof event.currentTarget.setPointerCapture === "function") {
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      return;
    }
    if (event.button !== 0) return;
    const anchor = domainAt(event);
    dragRef.current = {
      pointerId: event.pointerId,
      anchor,
      anchor_client_x: event.clientX,
      moved: false,
    };
    setDraft({ start: anchor, end: anchor });
    if (typeof event.currentTarget.setPointerCapture === "function") {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const pan = panRef.current;
    if (pan !== null && pan.pointerId === event.pointerId) {
      const rect = event.currentTarget.getBoundingClientRect();
      const delta = (event.clientX - pan.start_client_x) / Math.max(1, rect.width);
      if (Math.abs(event.clientX - pan.start_client_x) >= MINIMUM_DRAG_PX) {
        pan.moved = true;
      }
      setViewport(panViewport(pan.start_viewport, -delta));
      return;
    }

    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    if (Math.abs(event.clientX - drag.anchor_client_x) >= MINIMUM_DRAG_PX) {
      drag.moved = true;
    }
    setDraft(normalizeOverviewRange(model, drag.anchor, domainAt(event)));
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const pan = panRef.current;
    if (pan !== null && pan.pointerId === event.pointerId) {
      panRef.current = null;
      if (pan.moved) lastPanAtRef.current = Date.now();
      return;
    }

    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    const range = normalizeOverviewRange(model, drag.anchor, domainAt(event));
    dragRef.current = null;
    setDraft(null);

    if (!drag.moved && Math.abs(event.clientX - drag.anchor_client_x) < MINIMUM_DRAG_PX) {
      clear();
      return;
    }
    setSelection(range);
    publishFilter(turnIdsForRange(model, range), timeRangeForRange(model, range));
  };

  const onPointerCancel = (): void => {
    dragRef.current = null;
    panRef.current = null;
    setDraft(null);
  };

  const onContextMenu = (event: ReactMouseEvent<HTMLDivElement>): void => {
    event.preventDefault();
    if (
      panRef.current?.moved === true ||
      Date.now() - lastPanAtRef.current < 400
    ) {
      return;
    }
    resetView();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Escape" || selection === null) return;
    event.preventDefault();
    clear();
  };

  const visible = draft ?? selection;
  const visibleLeft = visible === null ? 0 : projectValue(visible.start);
  const visibleWidth =
    visible === null
      ? 0
      : Math.max(0, projectValue(visible.end) - visibleLeft);
  const windowLeft =
    windowFraction === undefined || windowFraction === null
      ? null
      : projectFraction(windowFraction.start);
  const windowWidth =
    windowLeft === null
      ? 0
      : Math.max(0, projectFraction(windowFraction!.end) - windowLeft);

  return (
    <section
      className={`w-full min-w-0 overflow-hidden rounded-lg border border-border bg-bg-surface/20 p-3 ${
        className ?? ""
      }`.trim()}
      aria-label="Session overview"
      data-overview-mode={mode}
    >
      <TooltipProvider delayDuration={500}>
        <div className="mb-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <h3 className="text-xs font-medium text-fg">Session overview</h3>
          <span className="font-mono text-xs text-fg-subtle">
            {model.lanes.input.length} input · {model.lanes.model.length} model ·{" "}
            {model.lanes.tools.length} tools
          </span>
          <span className="font-mono text-xs text-fg-subtle">
            peak context{" "}
            {model.watermark.peak === null
              ? "unavailable"
              : formatCompactTokens(model.watermark.peak)}
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            {!hideModeControl && (
              <>
                <span className="font-mono text-xs text-fg-subtle">duration</span>
                <div
                  role="group"
                  aria-label="Duration mode"
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
                      onClick={() => changeMode(option.value)}
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
              </>
            )}
            {selection !== null && (
              <Button
                variant="ghost"
                size="xs"
                type="button"
                className="border border-border text-fg-muted"
                title="Clear the brushed range"
                onClick={clear}
              >
                clear range
              </Button>
            )}
          </div>
        </div>

        {!model.has_data ? (
          <div className="flex h-24 items-center justify-center text-sm text-fg-muted">
            No input, model or tool events to plot.
          </div>
        ) : (
          <div className="grid min-w-0 grid-cols-[44px_minmax(0,1fr)] gap-x-2">
            <div className="flex min-w-0 flex-col gap-1" aria-hidden="true">
              <LaneLabel label="Input" />
              <LaneLabel label="Model" />
              <LaneLabel label="Context" tall />
              <LaneLabel label="Tools" />
            </div>

            <div
              ref={trackRef}
              role="group"
              tabIndex={0}
              aria-label="Session overview timeline. Drag across the plot to filter turns; wheel to zoom, right-drag to pan, right-click to reset; press Escape or double-click to clear."
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerCancel}
              onContextMenu={onContextMenu}
              onDoubleClick={(event) => {
                event.preventDefault();
                clear();
              }}
              onKeyDown={onKeyDown}
              className="relative flex min-w-0 cursor-crosshair touch-none select-none flex-col gap-1 overflow-hidden rounded-md outline-none focus-visible:ring-1 focus-visible:ring-fg/20"
            >
              <LaneRow
                lane="input"
                spans={model.lanes.input}
                model={model}
                viewport={viewport}
                onSpanActivate={onSpanActivate}
              />
              <LaneRow
                lane="model"
                spans={model.lanes.model}
                model={model}
                viewport={viewport}
                onSpanActivate={onSpanActivate}
              />
              <WatermarkStrip model={model} viewport={viewport} />
              <LaneRow
                lane="tools"
                spans={model.lanes.tools}
                model={model}
                viewport={viewport}
                onSpanActivate={onSpanActivate}
              />

              {model.boundaries.map((boundary) => (
                <div
                  key={`${boundary.segment_id}:${boundary.ts}`}
                  className="pointer-events-none absolute inset-y-0 z-20 border-l border-dashed border-warning/70"
                  style={{ left: `${projectFraction(overviewFraction(model, boundary.x)) * 100}%` }}
                  title={`${boundary.segment_id} boundary · ${boundary.reason}`}
                  data-overview-boundary={boundary.segment_id}
                />
              ))}

              {model.breaks.map((gap) => {
                const left = projectFraction(overviewFraction(model, gap.start));
                const width = Math.max(
                  0.2,
                  projectFraction(overviewFraction(model, gap.end)) - left,
                );
                return (
                  <div
                    key={`${gap.real_start}:${gap.real_end}`}
                    className="pointer-events-none absolute inset-y-0 z-20"
                    style={{
                      left: `${left * 100}%`,
                      width: `${width * 100}%`,
                    }}
                    title={`${formatIdleDuration(gap.duration_ms)} idle gap collapsed`}
                    data-overview-break
                  >
                    <div className="absolute inset-y-0 left-0 border-l border-dashed border-border-strong/70" />
                    <div className="absolute inset-y-0 right-0 border-r border-dashed border-border-strong/70" />
                    <span className="absolute inset-0 flex items-center justify-center overflow-hidden font-mono text-xs text-fg-subtle">
                      ⋯
                    </span>
                  </div>
                );
              })}

              {windowLeft !== null && (
                <div
                  className="pointer-events-none absolute inset-y-0 z-20 border border-fg-muted/50 bg-fg/5"
                  style={{
                    left: `${windowLeft * 100}%`,
                    width: `${windowWidth * 100}%`,
                    minWidth: 1,
                  }}
                  title="Rows currently visible in the ledger"
                  data-overview-window
                />
              )}

              {visible !== null && (
                <>
                  <div
                    className="pointer-events-none absolute inset-y-0 z-30 bg-brand/10"
                    style={{
                      left: `${visibleLeft * 100}%`,
                      width: `${visibleWidth * 100}%`,
                      minWidth: 1,
                    }}
                    data-overview-selection
                    data-dragging={draft === null ? undefined : "true"}
                  />
                  <div
                    className="pointer-events-none absolute inset-y-0 z-30"
                    style={{
                      left: `${visibleLeft * 100}%`,
                      width: `${visibleWidth * 100}%`,
                      minWidth: 1,
                    }}
                    aria-hidden="true"
                  >
                    <div className="absolute inset-y-0 left-0 w-px bg-brand" />
                    <div className="absolute inset-y-0 right-0 w-px bg-brand" />
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </TooltipProvider>
    </section>
  );
}

function LaneLabel({ label, tall = false }: { label: string; tall?: boolean }) {
  return (
    <span
      className={`flex items-center justify-end pr-0.5 font-mono text-xs text-fg-subtle ${
        tall ? "h-5 items-center" : "h-3.5"
      }`}
    >
      {label}
    </span>
  );
}

function LaneRow({
  lane,
  spans,
  model,
  viewport,
  onSpanActivate,
}: {
  lane: "input" | "model" | "tools";
  spans: readonly OverviewSpan[];
  model: OverviewModel;
  viewport: Viewport;
  onSpanActivate?: (span: OverviewSpan) => void;
}) {
  return (
    <div
      className="relative h-3.5 min-w-0 overflow-hidden rounded-sm bg-bg/40"
      data-overview-lane={lane}
      aria-label={`${lane} lane`}
    >
      {spans.map((span) => (
        <OverviewSpanBar
          key={span.id}
          span={span}
          model={model}
          viewport={viewport}
          onActivate={onSpanActivate}
        />
      ))}
    </div>
  );
}

function OverviewSpanBar({
  span,
  model,
  viewport,
  onActivate,
}: {
  span: OverviewSpan;
  model: OverviewModel;
  viewport: Viewport;
  onActivate?: (span: OverviewSpan) => void;
}) {
  const tooltip = overviewSpanTooltip(span);
  const left = modelToScreenFraction(
    viewport,
    overviewFraction(model, span.start),
  );
  const right = modelToScreenFraction(
    viewport,
    overviewFraction(model, Math.max(span.start, span.end)),
  );
  const width = Math.max(0, right - left);

  const base =
    span.kind === "input"
      ? "bg-brand"
      : span.kind === "llm"
        ? "bg-accent-violet"
        : span.is_error
          ? "bg-danger"
          : "bg-warning";

  const call = span.call;
  const ttft = call?.ttft_ms ?? null;
  const decode = call?.decode_ms ?? null;
  const split =
    span.kind === "llm" &&
    !span.running &&
    ttft !== null &&
    decode !== null &&
    ttft >= 0 &&
    decode >= 0 &&
    ttft + decode > 0;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          role="img"
          aria-label={`${tooltip.title}. ${tooltip.lines.join(". ")}`}
          data-overview-span={span.kind}
          data-running={span.running || undefined}
          data-error={span.is_error || undefined}
          onClick={(event) => {
            event.stopPropagation();
            onActivate?.(span);
          }}
          onPointerDown={(event) => {
            if (event.button === 0) event.stopPropagation();
          }}
          onPointerUp={(event) => event.stopPropagation()}
          className={`absolute top-1 z-10 h-2 min-w-0.5 cursor-pointer rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-fg/40 ${
            span.running ? "w-0.5" : ""
          }`}
          style={
            span.running
              ? { left: `${left * 100}%` }
              : {
                  left: `${left * 100}%`,
                  width: `max(2px, ${width * 100}%)`,
                }
          }
        >
          {span.running ? (
            <span className={`block h-full w-full rounded-sm ${base}`} />
          ) : split ? (
            <span className="flex h-full w-full overflow-hidden rounded-sm">
              <span
                className="h-full bg-accent-violet/45"
                style={{
                  width: `${
                    ((ttft as number) / ((ttft as number) + (decode as number))) * 100
                  }%`,
                }}
              />
              <span className="h-full min-w-0 flex-1 bg-accent-violet" />
            </span>
          ) : (
            <span className={`block h-full w-full rounded-sm ${base}`} />
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        align="center"
        className="block max-w-xs whitespace-normal font-mono text-xs"
      >
        <span className="block font-semibold">{tooltip.title}</span>
        {tooltip.lines.map((line, index) => (
          <span key={`${index}:${line}`} className="block">
            {line}
          </span>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}

function WatermarkStrip({
  model,
  viewport,
}: {
  model: OverviewModel;
  viewport: Viewport;
}) {
  const watermark = model.watermark;
  if (!watermark.has_data) {
    return (
      <div className="flex h-5 items-center rounded-sm border border-border/40 bg-bg/30 px-2 font-mono text-xs text-fg-subtle">
        context unavailable
      </div>
    );
  }

  const denominator =
    watermark.ceiling !== null && watermark.ceiling > 0
      ? watermark.ceiling
      : 1;
  const yFor = (value: number): number =>
    WATERMARK_TOP + WATERMARK_PLOT * (1 - value / denominator);

  return (
    <div
      className="relative h-5 min-w-0 overflow-hidden rounded-sm border border-border/40 bg-bg/30"
      aria-label="Context watermark per model call"
      data-overview-watermark
    >
      <svg
        viewBox={`0 0 ${WATERMARK_WIDTH} ${WATERMARK_HEIGHT}`}
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full text-info"
        role="img"
        aria-label="Context tokens per model call, dropping at compaction"
      >
        <line
          x1={0}
          x2={WATERMARK_WIDTH}
          y1={WATERMARK_TOP + WATERMARK_PLOT}
          y2={WATERMARK_TOP + WATERMARK_PLOT}
          stroke="currentColor"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
          opacity={0.18}
        />
        {watermark.lines.map((line, index) => {
          const points = line.points.map((point) => ({
            x:
              modelToScreenFraction(
                viewport,
                overviewFraction(model, point.x),
              ) * WATERMARK_WIDTH,
            y: yFor(point.value as number),
          }));
          const first = points[0];
          const last = points[points.length - 1];
          if (first === undefined || last === undefined) return null;
          if (points.length === 1) {
            return (
              <line
                key={`dot:${index}`}
                x1={Math.max(0, first.x - 2)}
                x2={Math.min(WATERMARK_WIDTH, first.x + 2)}
                y1={first.y}
                y2={first.y}
                stroke="currentColor"
                strokeWidth={1.8}
                vectorEffect="non-scaling-stroke"
              />
            );
          }
          const path = points
            .map(
              (point, pointIndex) =>
                `${pointIndex === 0 ? "M" : "L"} ${round(point.x)} ${round(point.y)}`,
            )
            .join(" ");
          const area = `${path} L ${round(last.x)} ${
            WATERMARK_TOP + WATERMARK_PLOT
          } L ${round(first.x)} ${WATERMARK_TOP + WATERMARK_PLOT} Z`;
          return (
            <g key={`line:${index}`}>
              <path d={area} fill="currentColor" opacity={0.08} />
              <path
                d={path}
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

const round = (value: number): number => Math.round(value * 100) / 100;
