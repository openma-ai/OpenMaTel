/**
 * The agent-native step timeline.
 *
 * Every turn gets a header, every step is an individual rounded row, and child
 * steps (`env.command` / `env.file_edit`, or any nested step) are indented
 * below the tool call that spawned them. Clicking/keyboard-activating a row
 * opens an inspector with the captured input, output and attrs.
 */

import { useRef, useState, type CSSProperties } from "react";

import type { EventContent, EventKind, StepNode, StepStatus, TurnNode } from "@openmatel/core";

import {
  durationBetween,
  formatClock,
  formatDurationMs,
  formatTimestamp,
  singleLine,
} from "./format.js";
import { useEdgeFade } from "./useEdgeFade.js";

/** Props of {@link StepTimeline}. */
export interface StepTimelineProps {
  /** Turns of one session, as returned by the Query API. */
  turns: TurnNode[];
  /** Follow a child session referenced by a `subagent.spawn` step. */
  onOpenSession?: (sessionId: string) => void;
}

interface KindInfo {
  icon: string;
  label: string;
}

const KIND_INFO: Partial<Record<EventKind, KindInfo>> = {
  "message.user": { icon: "›", label: "user message" },
  "message.agent": { icon: "‹", label: "agent message" },
  reasoning: { icon: "∴", label: "reasoning" },
  "llm.call": { icon: "✦", label: "llm call" },
  "tool.call": { icon: "⚙", label: "tool call" },
  "env.command": { icon: "❯", label: "command" },
  "env.file_edit": { icon: "✎", label: "file edit" },
  "env.browser": { icon: "◎", label: "browser" },
  "subagent.spawn": { icon: "⑂", label: "subagent" },
  handoff: { icon: "⇥", label: "handoff" },
  "plan.update": { icon: "☑", label: "plan" },
  "permission.request": { icon: "⚿", label: "permission" },
  "permission.decision": { icon: "⚿", label: "permission" },
  "control.interrupt": { icon: "⏸", label: "interrupt" },
  "control.cancel": { icon: "×", label: "cancel" },
  "control.retry": { icon: "↻", label: "retry" },
  "control.compaction": { icon: "≋", label: "compaction" },
  "control.resume": { icon: "▶", label: "resume" },
  "memory.read": { icon: "⌕", label: "memory read" },
  "memory.write": { icon: "⌘", label: "memory write" },
  "skill.use": { icon: "◇", label: "skill" },
  outcome: { icon: "✓", label: "outcome" },
  "raw.unknown": { icon: "?", label: "unknown" },
};

const kindInfo = (kind: EventKind): KindInfo =>
  KIND_INFO[kind] ?? { icon: "•", label: kind };

const attrString = (attrs: Record<string, unknown>, key: string): string | undefined => {
  const value = attrs[key];
  return typeof value === "string" && value !== "" ? value : undefined;
};

/** The primary text of a step: tool name, command, path, model, … */
export function stepLabel(step: StepNode): string {
  const attrs = step.attrs;
  switch (step.kind) {
    case "tool.call":
      return attrString(attrs, "tool_name") ?? step.title ?? "tool";
    case "env.command":
      return attrString(attrs, "command") ?? step.title ?? "command";
    case "env.file_edit":
      return attrString(attrs, "path") ?? step.title ?? "file edit";
    case "llm.call":
      return attrString(attrs, "model") ?? attrString(attrs, "provider") ?? step.title ?? "llm call";
    case "env.browser":
      return attrString(attrs, "action") ?? attrString(attrs, "url") ?? "browser";
    case "subagent.spawn":
    case "handoff":
      return attrString(attrs, "agent_name") ?? step.title ?? "subagent";
    case "plan.update": {
      const entries = attrs.entries;
      return Array.isArray(entries) ? `${entries.length} plan item${entries.length === 1 ? "" : "s"}` : "plan";
    }
    case "permission.request":
    case "permission.decision":
      return attrString(attrs, "tool") ?? "permission";
    case "memory.read":
    case "memory.write":
      return attrString(attrs, "key") ?? attrString(attrs, "store") ?? "memory";
    case "skill.use":
      return attrString(attrs, "skill_id") ?? "skill";
    default:
      return step.title ?? step.kind;
  }
};

const statusOf = (step: StepNode): StepStatus | undefined =>
  step.status ?? (step.error !== undefined ? "error" : undefined);

const durationOf = (step: StepNode): number | null => {
  const reported = step.attrs.duration_ms;
  if (typeof reported === "number" && Number.isFinite(reported)) return reported;
  return durationBetween(step.ts, step.end_ts);
};

const isErrorStatus = (status: StepStatus | undefined): boolean =>
  status === "error" || status === "timeout" || status === "denied";

const safeId = (value: string): string => value.replace(/[^a-zA-Z0-9_-]/g, "_");

/** Pretty-print a captured payload. */
function contentText(content: EventContent | undefined, side: "input" | "output"): string | null {
  const value = content?.[side];
  if (value === undefined) return null;
  if (typeof value.text === "string") return value.text;
  if (value.json !== undefined) {
    try {
      return JSON.stringify(value.json, null, 2);
    } catch {
      return String(value.json);
    }
  }
  return "";
}

/** A scrollable monospace block with its own edge fade. */
function TextBlock({ title, text }: { title: string; text: string }) {
  const ref = useRef<HTMLPreElement>(null);
  useEdgeFade(ref, text);

  return (
    <section className="omt-inspector-block">
      <h4 className="omt-inspector-label">{title}</h4>
      {text === "" ? (
        <p className="omt-inspector-empty">No content captured.</p>
      ) : (
        <pre className="omt-pre omt-scroll" ref={ref}>
          {text}
        </pre>
      )}
    </section>
  );
}

function Inspector({
  step,
  id,
  onOpenSession,
}: {
  step: StepNode;
  id: string;
  onOpenSession?: (sessionId: string) => void;
}) {
  const instruction = contentText(step.content, "input");
  const output = contentText(step.content, "output");
  const attrs = (() => {
    try {
      return JSON.stringify(step.attrs ?? {}, null, 2);
    } catch {
      return "{}";
    }
  })();
  const childSession = attrString(step.attrs, "child_session_id");

  return (
    <div className="omt-inspector" id={id} role="region" aria-label={`${step.kind} details`}>
      <div className="omt-inspector-meta">
        <span className="omt-source-badge">{step.source.name}</span>
        <span>{step.kind}</span>
        <span>{formatTimestamp(step.ts)}</span>
        {step.end_ts !== undefined ? <span>→ {formatClock(step.end_ts)}</span> : null}
        {durationOf(step) !== null ? <span>{formatDurationMs(durationOf(step))}</span> : null}
      </div>

      {step.error !== undefined ? (
        <div className="omt-notice omt-notice-error" role="alert">
          <div>
            <strong>{step.error.type}</strong>
            <p>{step.error.message}</p>
          </div>
        </div>
      ) : null}

      {childSession !== undefined && onOpenSession !== undefined ? (
        <button type="button" className="omt-button" onClick={() => onOpenSession(childSession)}>
          Open child session {childSession.slice(0, 12)}
        </button>
      ) : null}

      <TextBlock title="Input" text={instruction ?? ""} />
      <TextBlock title="Output" text={output ?? ""} />
      <TextBlock title="Attrs" text={attrs} />
    </div>
  );
}

interface StepRowsProps {
  steps: StepNode[];
  depth: number;
  expanded: ReadonlySet<string>;
  toggle: (stepId: string) => void;
  idPrefix: string;
  onOpenSession?: (sessionId: string) => void;
}

function StepRows({ steps, depth, expanded, toggle, idPrefix, onOpenSession }: StepRowsProps) {
  return (
    <ul className="omt-step-list">
      {steps.map((step) => {
        const info = kindInfo(step.kind);
        const status = statusOf(step);
        const duration = durationOf(step);
        const error = isErrorStatus(status);
        const open = expanded.has(step.step_id);
        const inspectorId = `${idPrefix}-${safeId(step.step_id)}`;
        const label = stepLabel(step);
        const style = { "--omt-step-depth": String(depth) } as CSSProperties;

        return (
          <li className="omt-step-item" key={step.step_id} style={style}>
            <button
              type="button"
              className={error ? "omt-step-row omt-step-row-error" : "omt-step-row"}
              onClick={() => toggle(step.step_id)}
              aria-expanded={open}
              aria-controls={inspectorId}
              title={label}
            >
              <span className="omt-step-time">{formatClock(step.ts)}</span>
              <span className="omt-step-icon" aria-hidden="true">
                {info.icon}
              </span>
              <span className="omt-step-main">
                <span className="omt-step-kind">{info.label}</span>
                <span className="omt-step-label">{singleLine(label, 240)}</span>
              </span>
              <span className={error ? "omt-status omt-status-error" : "omt-status"}>
                {status ?? "—"}
              </span>
              <span className="omt-step-duration">{formatDurationMs(duration)}</span>
              <span className={open ? "omt-chevron omt-chevron-open" : "omt-chevron"} aria-hidden="true">
                ⌄
              </span>
            </button>

            {open ? (
              <Inspector step={step} id={inspectorId} onOpenSession={onOpenSession} />
            ) : null}

            {step.children.length > 0 ? (
              <StepRows
                steps={step.children}
                depth={depth + 1}
                expanded={expanded}
                toggle={toggle}
                idPrefix={idPrefix}
                onOpenSession={onOpenSession}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** The timeline component. */
export function StepTimeline({ turns, onOpenSession }: StepTimelineProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  useEdgeFade(scrollRef, `${turns.length}:${expanded.size}`);
  const idPrefix = "omt-step";

  const toggle = (stepId: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(stepId)) next.delete(stepId);
      else next.add(stepId);
      return next;
    });
  };

  return (
    <div className="omt-timeline-scroll omt-scroll" ref={scrollRef}>
      {turns.length === 0 ? (
        <div className="omt-empty">
          <h2>No turns in this session</h2>
          <p>The session was indexed, but no turn or step events were captured.</p>
        </div>
      ) : (
        turns.map((turn, turnIndex) => (
          <section className="omt-turn" key={turn.turn_id} aria-labelledby={`${idPrefix}-turn-${turnIndex}`}>
            <header className="omt-turn-header">
              <div className="omt-turn-title">
                <h3 id={`${idPrefix}-turn-${turnIndex}`}>Turn {turnIndex + 1}</h3>
                <span className="omt-turn-id">{turn.turn_id}</span>
              </div>
              <div className="omt-turn-meta">
                <span>{formatTimestamp(turn.ts)}</span>
                <span>{turn.steps.length} root steps</span>
                {turn.status !== undefined ? (
                  <span className={isErrorStatus(turn.status) ? "omt-status omt-status-error" : "omt-status"}>
                    {turn.status}
                  </span>
                ) : null}
              </div>
            </header>

            {turn.steps.length === 0 ? (
              <p className="omt-turn-empty">No steps in this turn.</p>
            ) : (
              <StepRows
                steps={turn.steps}
                depth={0}
                expanded={expanded}
                toggle={toggle}
                idPrefix={`${idPrefix}-${turnIndex}`}
                onOpenSession={onOpenSession}
              />
            )}
          </section>
        ))
      )}
    </div>
  );
}
