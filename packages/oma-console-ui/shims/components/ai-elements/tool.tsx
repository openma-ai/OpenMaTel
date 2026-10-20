/**
 * Tool disclosure shim.
 *
 * `CanonicalSessionTurn` renders tool activity through the console's
 * `ai-elements/tool` components. The upstream implementation also pulls in
 * `shiki`, the shadcn select/collapsible primitives and the `ai` package's
 * UIMessage types — none of which OpenMaTel ships. This shim keeps the exact
 * component names and props used by the vendored turn renderer, with plain
 * semantic markup styled by the console tokens.
 *
 * Controlled by OpenMaTel, not vendored OpenMA code.
 */

import type { CSSProperties, ReactNode } from "react";

import { cn } from "@/lib/utils";

const STATE_LABEL: Record<string, string> = {
  "input-streaming": "preparing",
  "input-available": "running",
  "output-available": "completed",
  "output-error": "failed",
};

const STATE_CLASS: Record<string, string> = {
  "input-streaming": "text-info",
  "input-available": "text-info",
  "output-available": "text-success",
  "output-error": "text-danger",
};

export function Tool({
  children,
  defaultOpen = false,
  className,
}: {
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  return (
    <details
      open={defaultOpen}
      className={cn(
        "group/tool my-2 overflow-hidden rounded-md border border-border bg-bg-surface/30",
        className,
      )}
    >
      {children}
    </details>
  );
}

export function ToolHeader({
  state,
  title,
  toolName,
  className,
}: {
  state?: string;
  title: ReactNode;
  toolName?: string;
  type?: "dynamic-tool" | "tool";
  className?: string;
}) {
  const label = state === undefined ? "tool" : STATE_LABEL[state] ?? state;
  const tone = state === undefined ? "text-fg-subtle" : STATE_CLASS[state] ?? "text-fg-subtle";
  return (
    <summary
      className={cn(
        "flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs text-fg-muted",
        className,
      )}
    >
      <span className={cn("font-mono", tone)}>{label}</span>
      <span className="min-w-0 truncate font-medium text-fg">{title}</span>
      {toolName !== undefined && toolName !== "" && (
        <span className="ml-auto shrink-0 font-mono text-fg-subtle">{toolName}</span>
      )}
    </summary>
  );
}

export function ToolContent({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-2 border-t border-border/60 px-3 py-2", className)}>
      {children}
    </div>
  );
}

export function ToolInput({
  input,
  className,
}: {
  input: unknown;
  className?: string;
}) {
  return (
    <Payload label="Input" className={className}>
      {stringify(input)}
    </Payload>
  );
}

export function ToolOutput({
  output,
  errorText,
  className,
}: {
  output: unknown;
  errorText?: string;
  className?: string;
}) {
  const text = errorText ?? stringify(output);
  return (
    <Payload label={errorText === undefined ? "Output" : "Error"} tone={errorText === undefined ? undefined : "danger"} className={className}>
      {text}
    </Payload>
  );
}

function Payload({
  label,
  tone,
  className,
  children,
}: {
  label: string;
  tone?: "danger";
  className?: string;
  children: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <div
        className={cn(
          "mb-1 font-mono text-[11px] uppercase tracking-wide",
          tone === "danger" ? "text-danger" : "text-fg-subtle",
        )}
      >
        {label}
      </div>
      <pre
        className={cn(
          "max-h-72 overflow-auto whitespace-pre-wrap break-words rounded border border-border/60 bg-bg px-2 py-1.5 font-mono text-xs",
          tone === "danger" ? "text-danger" : "text-fg-muted",
        )}
        style={{ tabSize: 2 } as CSSProperties}
      >
        {children}
      </pre>
    </div>
  );
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
