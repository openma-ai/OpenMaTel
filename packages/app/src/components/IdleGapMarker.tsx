import { DEFAULT_IDLE_THRESHOLD_MS, type IdleGap } from "@openmatel/core/idle";

import { formatIdleGapLabel } from "../lib/session-format";

/**
 * A collapsed stretch of idle time between two turns (design §15.3).
 *
 * Idle gaps are not part of the schema: core `idleGaps` computes them at
 * render time, and this component only draws the divider. The default
 * threshold is core's 30 minutes; callers may pass a project/UI override.
 */
export function IdleGapMarker({
  gap,
  thresholdMs = DEFAULT_IDLE_THRESHOLD_MS,
  className,
}: {
  gap: IdleGap;
  thresholdMs?: number;
  className?: string;
}) {
  if (!Number.isFinite(gap.duration_ms) || gap.duration_ms <= thresholdMs) {
    return null;
  }

  const label = formatIdleGapLabel(gap.duration_ms);
  return (
    <div
      role="separator"
      aria-label={label}
      title={`Idle from ${new Date(gap.start).toLocaleString()} to ${new Date(
        gap.end,
      ).toLocaleString()}`}
      className={`flex items-center gap-3 py-1 font-mono text-xs text-fg-subtle ${
        className ?? ""
      }`.trim()}
      data-idle-gap-ms={gap.duration_ms}
    >
      <div className="flex-1 border-t border-dashed border-border" />
      <span className="whitespace-nowrap">{label}</span>
      <div className="flex-1 border-t border-dashed border-border" />
    </div>
  );
}
