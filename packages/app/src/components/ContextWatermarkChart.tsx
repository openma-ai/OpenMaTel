import { useMemo, useState } from "react";

import type { LlmCallPoint } from "@openmatel/core";
import { formatTimestamp } from "@openmatel/ui";

import {
  buildWatermarkChart,
  type WatermarkChartSample,
} from "../lib/watermark-chart";
import {
  EM_DASH,
  formatCompactTokens,
  formatPercent,
  formatTokenDelta,
  formatTokens,
} from "../lib/session-format";

/**
 * Inline-SVG context watermark (design §15.7).
 *
 * One point per `llm.call`, plotted in call order. Segment boundaries are
 * vertical dashed lines; hovering a point shows its context size, the delta
 * against the previous call in the same segment, and the cache hit ratio.
 *
 * Deliberately dependency-free: no chart library, no canvas, no measurement
 * effect. Unknown context values are gaps in the line, never zeroes.
 */
export function ContextWatermarkChart({
  points,
  className,
  height = 190,
}: {
  points: readonly LlmCallPoint[];
  className?: string;
  height?: number;
}) {
  const geometry = useMemo(
    () => buildWatermarkChart(points, { height }),
    [points, height],
  );
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const hovered =
    hoveredIndex === null
      ? null
      : geometry.samples.find((sample) => sample.index === hoveredIndex) ?? null;

  const peak = geometry.samples.reduce<number | null>((current, sample) => {
    if (sample.value === null) return current;
    return current === null ? sample.value : Math.max(current, sample.value);
  }, null);

  return (
    <section
      className={`rounded-lg border border-border bg-bg-surface/20 p-3 ${
        className ?? ""
      }`.trim()}
      aria-label="Context watermark"
    >
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-xs font-medium text-fg">Context watermark</h3>
        <span className="font-mono text-xs text-fg-subtle">
          {geometry.samples.length} model call{geometry.samples.length === 1 ? "" : "s"}
        </span>
        <span className="font-mono text-xs text-fg-subtle">
          peak {formatTokens(peak)}
        </span>
        <span className="ml-auto font-mono text-xs text-fg-subtle">
          {formatCompactTokens(geometry.maxValue)} ceiling
        </span>
      </div>

      {!geometry.hasData ? (
        <div className="flex h-24 items-center justify-center text-sm text-fg-muted">
          No context tokens reported for this session.
        </div>
      ) : (
        <div className="relative">
          <svg
            viewBox={`0 0 ${geometry.width} ${geometry.height}`}
            className="h-auto w-full"
            role="img"
            aria-label="Context tokens per model call, with segment boundaries marked"
          >
            {/* Horizontal grid + y-axis labels */}
            {geometry.ticks.map((tick) => (
              <g key={tick.value} className="text-fg-subtle">
                <line
                  x1={geometry.plotLeft}
                  x2={geometry.plotLeft + geometry.plotWidth}
                  y1={tick.y}
                  y2={tick.y}
                  stroke="currentColor"
                  strokeWidth={1}
                  opacity={tick.value === 0 ? 0.45 : 0.14}
                />
                <text
                  x={geometry.plotLeft - 8}
                  y={tick.y + 3}
                  textAnchor="end"
                  fill="currentColor"
                  fontSize={10}
                  fontFamily="var(--font-mono)"
                >
                  {formatCompactTokens(tick.value)}
                </text>
              </g>
            ))}

            {/* Segment boundaries. Labels stay inside the top of the plot. */}
            {geometry.boundaries.map((boundary) => (
              <g key={`${boundary.segment_id}:${boundary.index}`} className="text-warning">
                <line
                  x1={boundary.x}
                  x2={boundary.x}
                  y1={geometry.plotTop}
                  y2={geometry.baselineY}
                  stroke="currentColor"
                  strokeWidth={1}
                  strokeDasharray="3 3"
                  opacity={0.65}
                />
                <text
                  x={boundary.x + 3}
                  y={geometry.plotTop + 9}
                  fill="currentColor"
                  fontSize={9}
                  fontFamily="var(--font-mono)"
                >
                  {boundary.segment_id}
                </text>
              </g>
            ))}

            {/* Lines are split at calls without a reported context size. */}
            {geometry.lines.map((line, index) => (
              <g key={`line:${index}`} className="text-info">
                {line.areaPath !== null && (
                  <path d={line.areaPath} fill="currentColor" opacity={0.08} />
                )}
                <path
                  d={line.path}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.8}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              </g>
            ))}

            {/* Points + generous invisible hit targets for the tooltip. */}
            {geometry.samples.map((sample) =>
              sample.y === null ? null : (
                <g key={sample.index}>
                  <circle
                    cx={sample.x}
                    cy={sample.y}
                    r={8}
                    fill="transparent"
                    onMouseEnter={() => setHoveredIndex(sample.index)}
                    onMouseLeave={() => setHoveredIndex(null)}
                    onFocus={() => setHoveredIndex(sample.index)}
                    onBlur={() => setHoveredIndex(null)}
                    tabIndex={0}
                    role="img"
                    aria-label={sampleLabel(sample)}
                  >
                    <title>{sampleLabel(sample)}</title>
                  </circle>
                  <circle
                    cx={sample.x}
                    cy={sample.y}
                    r={hoveredIndex === sample.index ? 4 : 2.5}
                    fill="currentColor"
                    className="pointer-events-none text-info"
                  />
                </g>
              ),
            )}
          </svg>

          {hovered !== null && hovered.y !== null && (
            <div
              className="pointer-events-none absolute z-20 w-52 -translate-x-1/2 -translate-y-full rounded border border-border bg-bg p-2 font-mono text-xs text-fg shadow-card-soft"
              style={{
                left: `${(hovered.x / geometry.width) * 100}%`,
                top: `calc(${(hovered.y / geometry.height) * 100}% - 8px)`,
              }}
              role="tooltip"
            >
              <div className="mb-1 flex items-center justify-between gap-2 text-fg-subtle">
                <span>{hovered.segment_id}</span>
                <span>call #{hovered.index + 1}</span>
              </div>
              <div className="text-fg">context {formatTokens(hovered.value)}</div>
              <div className="text-fg-muted">
                Δ prev {formatTokenDelta(hovered.point.context_delta)}
              </div>
              <div className="text-fg-muted">
                cache {formatPercent(hovered.point.cache_hit_ratio)}
              </div>
              <div className="mt-1 truncate text-fg-subtle" title={hovered.point.model ?? undefined}>
                {hovered.point.model ?? EM_DASH}
              </div>
              <div className="text-fg-subtle">{formatTimestamp(hovered.point.ts)}</div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function sampleLabel(sample: WatermarkChartSample): string {
  const value = formatTokens(sample.value);
  const delta = formatTokenDelta(sample.point.context_delta);
  const cache = formatPercent(sample.point.cache_hit_ratio);
  return `call ${sample.index + 1}, context ${value}, delta ${delta}, cache ${cache}`;
}
