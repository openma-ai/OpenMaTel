import type { LedgerRowKind } from "../../lib/ledger";

/**
 * Trajectory row badges.
 *
 * The vendored console `Badge` is deliberately neutral (it is used for
 * resource chips). The ledger needs the same geometry and typography with the
 * console's status tones, so this is the same badge recipe with the existing
 * `*-subtle` / `*` token pairs — no new palette.
 */
const LABELS: Record<LedgerRowKind, string> = {
  turn_header: "TURN",
  segment_boundary: "SEGMENT",
  compaction: "COMPACTION",
  idle_gap: "IDLE",
  request: "REQUEST",
  step: "STEP",
  user: "USER",
  assistant: "ASSISTANT",
  tool: "TOOL",
  subtool: "SUBTOOL",
  system_prompt: "SYSTEM",
  tools_updated: "TOOLS",
};

const TONES: Record<LedgerRowKind, string> = {
  turn_header: "border border-border bg-bg-surface text-fg-muted",
  segment_boundary: "border border-border bg-bg-surface text-fg-muted",
  compaction: "border border-border bg-bg-surface text-fg-muted",
  idle_gap: "border border-border bg-bg-surface text-fg-subtle",
  request: "border border-border bg-bg-surface text-fg-subtle",
  step: "border border-border bg-bg-surface text-fg-subtle",
  user: "bg-info-subtle text-info",
  assistant: "bg-accent-violet-subtle text-accent-violet",
  tool: "bg-warning-subtle text-warning",
  subtool: "bg-warning-subtle text-warning",
  system_prompt: "border border-border bg-bg-surface text-fg-muted",
  tools_updated: "border border-border bg-bg-surface text-fg-muted",
};

export function trajectoryKindLabel(kind: LedgerRowKind): string {
  return LABELS[kind] ?? kind.toUpperCase();
}

export function TrajectoryKindBadge({
  kind,
  className,
}: {
  kind: LedgerRowKind;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex h-4 shrink-0 items-center rounded px-1 font-mono text-xs leading-none ${TONES[kind]} ${
        className ?? ""
      }`.trim()}
      data-trajectory-kind={kind}
    >
      {trajectoryKindLabel(kind)}
    </span>
  );
}
