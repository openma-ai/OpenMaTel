import type { AgentEvent } from "@openmatel/core";

import { Badge } from "@/components/Badge";

import { parseSegmentBoundary } from "../lib/session-view";
import { formatTokens } from "../lib/session-format";

/**
 * The node that opens a context segment (design §15.1).
 *
 * It is OpenMaTel-owned because the vendored console has no segment model at
 * all. Every unknown number stays an em dash; only a reported zero is `0`.
 */
export function SegmentBoundaryNode({
  boundary,
  className,
  summaryDefaultOpen = false,
}: {
  boundary: Pick<AgentEvent, "segment_id" | "attrs">;
  className?: string;
  summaryDefaultOpen?: boolean;
}) {
  const info = parseSegmentBoundary(boundary);
  const removed =
    info.tokens_removed === null ? "—" : `−${formatTokens(info.tokens_removed)}`;

  return (
    <div
      className={`rounded-md border border-border bg-bg-surface/40 px-3 py-2 text-xs ${
        className ?? ""
      }`.trim()}
      data-segment-boundary={info.segment_id}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Badge label={info.segment_id} title="Context segment opened by this boundary" />
        <Badge
          label={info.reason}
          title={
            info.derived
              ? "Segment boundary reason (values derived from neighbouring calls)"
              : "Segment boundary reason"
          }
        />
        {info.derived && <Badge label="derived" title="Some values were inferred from adjacent calls" />}
        <span className="font-mono text-fg-muted" title="Prompt size before and after the boundary">
          context {formatTokens(info.context_tokens_before)} →{" "}
          {formatTokens(info.context_tokens_after)}
        </span>
        <span className="font-mono text-fg-subtle" title="Tokens removed by compaction">
          {removed} removed
        </span>
        {info.parent_segment_id !== null && (
          <span className="font-mono text-fg-subtle">parent {info.parent_segment_id}</span>
        )}
      </div>

      {info.summary !== null && (
        <details className="mt-2" open={summaryDefaultOpen}>
          <summary className="cursor-pointer select-none font-mono text-fg-subtle hover:text-fg-muted">
            compaction summary
          </summary>
          <pre className="mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-border/60 bg-bg p-2 font-mono text-xs text-fg-muted">
            {info.summary}
          </pre>
        </details>
      )}
    </div>
  );
}
