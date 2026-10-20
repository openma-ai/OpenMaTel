/**
 * Geometry for the inline context-watermark chart (docs/design.md §15.7).
 *
 * The chart plots `context_tokens` per `llm.call` in call order, so a
 * compaction shows up as a visible drop and a segment boundary as a vertical
 * marker. Keeping the scale math here (instead of inside the SVG component)
 * makes it testable without a DOM and keeps the component a thin renderer.
 */

import type { LlmCallPoint } from "@openmatel/core";

/** Padding around the plot area, in SVG user units. */
export interface WatermarkChartPadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Options of {@link buildWatermarkChart}. */
export interface WatermarkChartOptions {
  width?: number;
  height?: number;
  padding?: Partial<WatermarkChartPadding>;
  /** Number of intervals between 0 and the ceiling. Defaults to 4. */
  tickIntervals?: number;
}

/** One plotted (or intentionally unplotted) call. */
export interface WatermarkChartSample {
  index: number;
  point: LlmCallPoint;
  segment_id: string;
  value: number | null;
  x: number;
  /** `null` when the call did not report `context_tokens`. */
  y: number | null;
}

/** A run of consecutive samples with a reported context size. */
export interface WatermarkLine {
  samples: WatermarkChartSample[];
  /** SVG path of the polyline. */
  path: string;
  /** SVG path closing the run at the baseline, for the subtle fill. */
  areaPath: string | null;
}

/** A vertical marker where a new context segment starts. */
export interface WatermarkBoundary {
  index: number;
  x: number;
  segment_id: string;
}

/** A horizontal value grid line. */
export interface WatermarkTick {
  value: number;
  y: number;
}

/** Everything the `ContextWatermarkChart` SVG needs. */
export interface WatermarkChartGeometry {
  width: number;
  height: number;
  padding: WatermarkChartPadding;
  plotLeft: number;
  plotTop: number;
  plotWidth: number;
  plotHeight: number;
  baselineY: number;
  /** Nice upper bound of the y axis; always > 0 so division is safe. */
  maxValue: number;
  samples: WatermarkChartSample[];
  lines: WatermarkLine[];
  boundaries: WatermarkBoundary[];
  ticks: WatermarkTick[];
  hasData: boolean;
}

const DEFAULT_PADDING: WatermarkChartPadding = {
  top: 16,
  right: 16,
  bottom: 26,
  left: 52,
};

const DEFAULT_WIDTH = 800;
const DEFAULT_HEIGHT = 190;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const positive = (value: number | undefined, fallback: number): number =>
  isFiniteNumber(value) && value > 0 ? value : fallback;

/**
 * Round a value up to a readable axis ceiling using the 1 / 2 / 5 × 10ⁿ
 * series. Unknown input stays `null`; zero stays `0` and the chart builder
 * substitutes a safe denominator.
 */
export function niceCeiling(value: number | null | undefined): number | null {
  if (!isFiniteNumber(value) || value < 0) return null;
  if (value === 0) return 0;

  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  const fraction = value / base;
  const step = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return Number((step * base).toPrecision(12));
}

/** Map a context size to its y coordinate (0 at the baseline, max at top). */
export function valueToY(
  value: number,
  maxValue: number,
  plotTop: number,
  plotHeight: number,
): number {
  if (!isFiniteNumber(value) || !isFiniteNumber(maxValue) || maxValue <= 0) {
    return plotTop + plotHeight;
  }
  return plotTop + plotHeight * (1 - value / maxValue);
}

/** Map a call index to its x coordinate; a single call is centred. */
export function indexToX(
  index: number,
  count: number,
  plotLeft: number,
  plotWidth: number,
): number {
  if (count <= 1) return plotLeft + plotWidth / 2;
  const clamped = Math.max(0, Math.min(count - 1, index));
  return plotLeft + (clamped / (count - 1)) * plotWidth;
}

/** The context value the chart consumes, preferring `context_tokens`. */
export function contextValue(point: LlmCallPoint): number | null {
  if (isFiniteNumber(point.context_tokens)) return point.context_tokens;
  if (isFiniteNumber(point.watermark)) return point.watermark;
  return null;
}

/** Build the SVG geometry of a series of LLM calls. */
export function buildWatermarkChart(
  points: readonly LlmCallPoint[],
  options: WatermarkChartOptions = {},
): WatermarkChartGeometry {
  const width = positive(options.width, DEFAULT_WIDTH);
  const height = positive(options.height, DEFAULT_HEIGHT);
  const padding: WatermarkChartPadding = {
    ...DEFAULT_PADDING,
    ...options.padding,
  };
  const plotLeft = padding.left;
  const plotTop = padding.top;
  const plotWidth = Math.max(1, width - padding.left - padding.right);
  const plotHeight = Math.max(1, height - padding.top - padding.bottom);
  const baselineY = plotTop + plotHeight;

  const values = points
    .map(contextValue)
    .filter((value): value is number => value !== null);
  const rawMax = values.length === 0 ? null : Math.max(...values);
  const ceiling = niceCeiling(rawMax);
  const maxValue = ceiling === null || ceiling <= 0 ? 1 : ceiling;

  const samples: WatermarkChartSample[] = points.map((point, index) => {
    const value = contextValue(point);
    return {
      index,
      point,
      segment_id: point.segment_id,
      value,
      x: indexToX(index, points.length, plotLeft, plotWidth),
      y:
        value === null
          ? null
          : valueToY(value, maxValue, plotTop, plotHeight),
    };
  });

  const lines: WatermarkLine[] = [];
  let run: WatermarkChartSample[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    const path = run
      .map((sample, index) =>
        `${index === 0 ? "M" : "L"} ${round(sample.x)} ${round(sample.y as number)}`,
      )
      .join(" ");
    const first = run[0] as WatermarkChartSample;
    const last = run[run.length - 1] as WatermarkChartSample;
    const areaPath =
      run.length < 2
        ? null
        : `${path} L ${round(last.x)} ${round(baselineY)} L ${round(first.x)} ${round(
            baselineY,
          )} Z`;
    lines.push({ samples: run, path, areaPath });
    run = [];
  };

  for (const sample of samples) {
    if (sample.y === null) {
      flush();
      continue;
    }
    run.push(sample);
  }
  flush();

  const boundaries: WatermarkBoundary[] = [];
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index] as WatermarkChartSample;
    const previous = index > 0 ? samples[index - 1] : undefined;
    const changed = previous !== undefined && previous.segment_id !== sample.segment_id;
    const startsOffFirstSegment = index === 0 && sample.segment_id !== "seg_0";
    if (!changed && !startsOffFirstSegment) continue;
    boundaries.push({
      index,
      x: sample.x,
      segment_id: sample.segment_id,
    });
  }

  const intervals = Math.max(1, Math.round(options.tickIntervals ?? 4));
  const ticks: WatermarkTick[] = [];
  for (let step = 0; step <= intervals; step += 1) {
    const value = (maxValue / intervals) * step;
    ticks.push({
      value,
      y: valueToY(value, maxValue, plotTop, plotHeight),
    });
  }

  return {
    width,
    height,
    padding,
    plotLeft,
    plotTop,
    plotWidth,
    plotHeight,
    baselineY,
    maxValue,
    samples,
    lines,
    boundaries,
    ticks,
    hasData: values.length > 0,
  };
}

const round = (value: number): number => Math.round(value * 100) / 100;
