import { Badge } from "@/components/Badge";
import { Button } from "@/components/ui/button";
import { shortenId } from "@/lib/format";

import { EM_DASH, turnPromptPreview } from "../lib/session-format";
import type { SubagentStep } from "../lib/session-view";

/**
 * Sub-agent steps of one turn.
 *
 * A sub-agent is a child session in OpenMaTel (design §15.4), not a nested
 * span. Clicking a step that carries a `child_session_id` opens the nested
 * session route. The vendored timeline has no drill-down hook, so this
 * OpenMaTel-owned list sits next to the per-turn `TimelineView`.
 */
export function SubagentSteps({
  steps,
  onOpen,
  className,
}: {
  steps: readonly SubagentStep[];
  onOpen: (childSessionId: string) => void;
  className?: string;
}) {
  if (steps.length === 0) return null;

  return (
    <div
      className={`flex flex-col gap-1.5 border-b border-border/60 px-3 py-2 ${
        className ?? ""
      }`.trim()}
      data-subagent-steps
    >
      <span className="font-mono text-xs text-fg-subtle">sub-agent steps</span>
      {steps.map((step) => {
        const label = step.agent_name ?? EM_DASH;
        const task = turnPromptPreview(step.task, 90);
        const child = step.child_session_id;
        return (
          <div key={step.event_id} className="flex min-w-0 flex-wrap items-center gap-2">
            <Badge label={label} title="Sub-agent name" />
            <span className="min-w-0 flex-1 truncate text-xs text-fg-muted" title={step.task ?? undefined}>
              {task}
            </span>
            {child === null ? (
              <Badge label={EM_DASH} title="No child session id was captured" />
            ) : (
              <Button
                variant="ghost"
                className="min-h-11 rounded border border-border px-2 py-0.5 font-mono text-xs text-fg-muted hover:border-border-strong hover:bg-bg-surface sm:min-h-0"
                onClick={() => onOpen(child)}
                title={`Open child session ${child}`}
              >
                open session {shortenId(child)}
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}
