import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import type {
  AgentEvent,
  LlmCallPoint,
  UsageTotal,
} from "@openmatel/core";

import { Button } from "@/components/ui/button";

import {
  findCallForRow,
  requestTiming,
  usageFor,
  type LedgerRow,
} from "../../lib/ledger";
import {
  formatIdleDuration,
  formatTokens,
} from "../../lib/session-format";
import { TrajectoryKindBadge, trajectoryKindLabel } from "./TrajectoryKindBadge";

const MIN_WIDTH = 280;
const DEFAULT_WIDTH = 380;
const WIDTH_KEY = "openmatel.trajectory.inspectorWidth";

type InspectorTab = "summary" | "preview" | "raw";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

const pretty = (value: unknown): string => {
  try {
    const text = JSON.stringify(value, null, 2);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
};

/** Plain text of one side of a captured payload. */
function contentText(event: AgentEvent, side: "input" | "output"): string {
  const part = event.content?.[side];
  if (part === undefined) return "";
  if (typeof part.text === "string") return part.text;
  if (part.json !== undefined) return pretty(part.json);
  return "";
}

const eventTitle = (event: AgentEvent): string =>
  `${event.kind} · ${event.ts}`;

const formatTimestamp = (value: string | null): string | null => {
  if (value === null) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return new Date(parsed).toLocaleString();
};

const durationBetween = (start: string | null, end: string | null): number | null => {
  if (start === null || end === null) return null;
  const from = Date.parse(start);
  const to = Date.parse(end);
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return null;
  return to - from;
};

function Unavailable() {
  return <span className="text-fg-subtle">unavailable</span>;
}

function Value({ value }: { value: string | null | undefined }) {
  if (value === null || value === undefined || value === "") return <Unavailable />;
  return <>{value}</>;
}

function NumberValue({
  value,
  format,
}: {
  value: number | null | undefined;
  format: (value: number) => string;
}) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return <Unavailable />;
  }
  return <>{format(value)}</>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[92px_minmax(0,1fr)] items-start gap-2 py-0.5">
      <span className="font-mono text-xs text-fg-subtle">{label}</span>
      <span className="min-w-0 break-words font-mono text-xs text-fg-muted">
        {children}
      </span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-md border border-border bg-bg-surface/20 p-2.5">
      <h4 className="mb-1.5 font-mono text-xs font-semibold text-fg">{title}</h4>
      {children}
    </section>
  );
}

function readWidth(): number {
  if (typeof window === "undefined") return DEFAULT_WIDTH;
  try {
    const raw = window.localStorage.getItem(WIDTH_KEY);
    if (raw === null) return DEFAULT_WIDTH;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? Math.max(MIN_WIDTH, parsed) : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

export interface TrajectoryInspectorProps {
  row: LedgerRow;
  turnNumber: number | null;
  calls: readonly LlmCallPoint[];
  sessionUsage: UsageTotal | null | undefined;
  eventsById: ReadonlyMap<string, AgentEvent>;
  onClose: () => void;
}

/**
 * Right-hand Trajectory inspector.
 *
 * Follows the vendored timeline's side-panel conventions: a border-left
 * panel, a compact header with the row badge, "Turn N · Step M", a close
 * button, and Summary / Preview / Raw tabs. The left edge resizes between
 * 280px and 60% of the available width; that width is persisted in
 * localStorage.
 */
export function TrajectoryInspector({
  row,
  turnNumber,
  calls,
  sessionUsage,
  eventsById,
  onClose,
}: TrajectoryInspectorProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const [tab, setTab] = useState<InspectorTab>("summary");
  const [width, setWidth] = useState<number>(readWidth);

  const clampWidth = (next: number): number => {
    const available =
      panelRef.current?.parentElement?.getBoundingClientRect().width ??
      (typeof window === "undefined" ? DEFAULT_WIDTH * 2 : window.innerWidth);
    const maximum = Math.max(MIN_WIDTH, available * 0.6);
    return Math.min(maximum, Math.max(MIN_WIDTH, next));
  };

  useEffect(() => {
    const fit = (): void => setWidth((current) => clampWidth(current));
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
    // `clampWidth` reads the live parent width, so the listener stays correct.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(WIDTH_KEY, String(Math.round(width)));
    } catch {
      // Storage can be disabled; resizing still works for this session.
    }
  }, [width]);

  useEffect(() => {
    setTab("summary");
  }, [row.id]);

  const startResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const onMove = (move: PointerEvent): void => {
      setWidth(clampWidth(startWidth + (startX - move.clientX)));
    };
    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const events = row.event_ids
    .map((id) => eventsById.get(id))
    .filter((event): event is AgentEvent => event !== undefined);
  const call = findCallForRow(row, calls);
  const timing = requestTiming(call);
  const usage = usageFor(row, calls, sessionUsage);
  const tool = events.find(
    (event) =>
      event.kind === "tool.call" ||
      event.kind === "subagent.spawn" ||
      event.kind === "handoff",
  );
  const toolAttrs = tool !== undefined && isObject(tool.attrs) ? tool.attrs : {};
  const error =
    events.find((event) => event.error !== undefined)?.error ??
    (call?.retry?.error_code === null || call?.retry?.error_code === undefined
      ? undefined
      : { message: call.retry.error_code });
  const heading =
    turnNumber === null
      ? row.step === null
        ? "Row"
        : `Step ${row.step}`
      : row.step === null
        ? `Turn ${turnNumber}`
        : `Turn ${turnNumber} · Step ${row.step}`;

  return (
    <aside
      ref={panelRef}
      aria-label="Trajectory inspector"
      className="relative flex min-h-0 min-w-0 shrink-0 flex-col overflow-hidden border-l border-border bg-bg"
      style={{ width, maxWidth: "60%" }}
      data-trajectory-inspector
    >
      <div
        role="separator"
        aria-label="Resize inspector"
        aria-orientation="vertical"
        tabIndex={0}
        onPointerDown={startResize}
        className="absolute inset-y-0 left-0 z-10 w-1 cursor-col-resize touch-none hover:bg-brand/40"
      />

      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <TrajectoryKindBadge kind={row.kind} />
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-muted">
          {heading}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          type="button"
          onClick={onClose}
          title="Close inspector"
          aria-label="Close inspector"
          className="text-fg-subtle hover:text-fg-muted"
        >
          ×
        </Button>
      </div>

      <div
        role="tablist"
        aria-label="Inspector view"
        className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1"
      >
        {(
          [
            ["summary", "Summary"],
            ["preview", "Preview"],
            ["raw", "Raw"],
          ] as const
        ).map(([value, label]) => (
          <Button
            key={value}
            variant="ghost"
            size="xs"
            type="button"
            role="tab"
            aria-selected={tab === value}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => setTab(value)}
            className={
              tab === value
                ? "bg-bg-surface font-semibold text-brand"
                : "text-fg-subtle hover:text-fg-muted"
            }
          >
            {label}
          </Button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {tab === "summary" && (
          <Summary
            row={row}
            turnNumber={turnNumber}
            call={call}
            timing={timing}
            usage={usage}
            tool={tool}
            toolAttrs={toolAttrs}
            error={error}
          />
        )}
        {tab === "preview" && <Preview events={events} />}
        {tab === "raw" && <Raw events={events} />}
      </div>
    </aside>
  );
}

function Summary({
  row,
  turnNumber,
  call,
  timing,
  usage,
  tool,
  toolAttrs,
  error,
}: {
  row: LedgerRow;
  turnNumber: number | null;
  call: LlmCallPoint | undefined;
  timing: ReturnType<typeof requestTiming>;
  usage: ReturnType<typeof usageFor>;
  tool: AgentEvent | undefined;
  toolAttrs: Record<string, unknown>;
  error: { message: string } | undefined;
}) {
  const duration = durationBetween(row.start, row.end);
  const toolName =
    asString(toolAttrs.tool_name) ?? asString(toolAttrs.agent_name);
  const args =
    tool === undefined
      ? null
      : contentText(tool, "input") ||
        (asString(toolAttrs.task) ?? null);
  const result =
    tool === undefined ? null : contentText(tool, "output") || null;
  const isToolRow = row.kind === "tool" || row.kind === "subtool";

  return (
    <div className="flex flex-col gap-2.5">
      <Section title="Row">
        <Field label="Kind">{trajectoryKindLabel(row.kind)}</Field>
        <Field label="Status">
          <Value value={row.status} />
        </Field>
        <Field label="Start">
          <Value value={formatTimestamp(row.start)} />
        </Field>
        <Field label="End">
          <Value value={formatTimestamp(row.end)} />
        </Field>
        <Field label="Duration">
          <NumberValue value={duration} format={formatIdleDuration} />
        </Field>
        <Field label="Segment">{row.segment_id}</Field>
        <Field label="Turn">
          {turnNumber === null ? <Unavailable /> : `Turn ${turnNumber}`}
        </Field>
        <Field label="Step">
          {row.step === null ? <Unavailable /> : `Step ${row.step}`}
        </Field>
        <Field label="Request">
          {row.request_index === null ? <Unavailable /> : `#${row.request_index}`}
        </Field>
        <Field label="Summary">
          <Value value={row.summary} />
        </Field>
        <Field label="Events">{row.event_ids.length}</Field>
      </Section>

      {isToolRow && (
        <Section title="Tool">
          <Field label="Name">
            <Value value={toolName} />
          </Field>
          <Field label="Args">
            {args === null || args === "" ? <Unavailable /> : <Pre text={args} />}
          </Field>
          <Field label="Result">
            {result === null || result === "" ? <Unavailable /> : <Pre text={result} />}
          </Field>
          <Field label="Error">
            {tool?.error === undefined ? <Unavailable /> : tool.error.message}
          </Field>
        </Section>
      )}

      <Section title="Request Timing">
        <Field label="Start">
          <Value
            value={formatTimestamp(
              typeof timing.start === "string"
                ? timing.start
                : typeof timing.start === "number"
                  ? new Date(timing.start).toISOString()
                  : null,
            )}
          />
        </Field>
        <Field label="Total">
          <NumberValue
            value={typeof timing.total_ms === "number" ? timing.total_ms : null}
            format={formatIdleDuration}
          />
        </Field>
        <Field label="TTFT">
          <NumberValue
            value={typeof timing.ttft_ms === "number" ? timing.ttft_ms : null}
            format={formatIdleDuration}
          />
        </Field>
        <Field label="Generation">
          <NumberValue
            value={
              typeof timing.generation_ms === "number"
                ? timing.generation_ms
                : null
            }
            format={formatIdleDuration}
          />
        </Field>
        <Field label="Throughput">
          <NumberValue
            value={
              typeof timing.throughput_tps === "number"
                ? timing.throughput_tps
                : null
            }
            format={(value) => `${value.toFixed(2)} tok/s`}
          />
        </Field>
      </Section>

      <Section title="Token usage">
        <table className="w-full border-collapse font-mono text-xs">
          <thead>
            <tr className="text-fg-subtle">
              <th className="py-1 text-left font-normal">metric</th>
              <th className="py-1 text-right font-normal">request</th>
              <th className="py-1 text-right font-normal">session</th>
            </tr>
          </thead>
          <tbody className="text-fg-muted">
            {(
              [
                ["input", usage.request.input, usage.session.input],
                ["cache read", usage.request.cache_read, usage.session.cache_read],
                ["cache write", usage.request.cache_write, usage.session.cache_write],
                ["output", usage.request.output, usage.session.output],
                ["context", usage.request.context, usage.session.context],
              ] as const
            ).map(([label, request, session]) => (
              <tr key={label} className="border-t border-border/50">
                <td className="py-1 text-fg-subtle">{label}</td>
                <td className="py-1 text-right">
                  <NumberValue value={request} format={formatTokens} />
                </td>
                <td className="py-1 text-right">
                  <NumberValue value={session} format={formatTokens} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {call !== undefined && call.retry !== null && (
        <Section title="Retry">
          <Field label="Attempt">{call.retry.attempt}</Field>
          <Field label="Max">
            <NumberValue value={call.retry.max_attempts} format={String} />
          </Field>
          <Field label="Delay">
            <NumberValue value={call.retry.delay_ms} format={formatIdleDuration} />
          </Field>
          <Field label="Code">
            <Value value={call.retry.error_code} />
          </Field>
        </Section>
      )}

      {(row.error || error !== undefined) && (
        <Section title="Error">
          <Field label="Status">
            <Value value={row.status} />
          </Field>
          <Field label="Message">
            {error === undefined ? <Unavailable /> : error.message}
          </Field>
        </Section>
      )}
    </div>
  );
}

function Pre({ text }: { text: string }) {
  return (
    <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded border border-border/60 bg-bg p-1.5 font-mono text-xs text-fg-muted">
      {text}
    </pre>
  );
}

function Preview({ events }: { events: readonly AgentEvent[] }) {
  if (events.length === 0) {
    return (
      <p className="text-sm text-fg-muted">
        No captured content is linked to this row.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {events.map((event) => {
        const input = contentText(event, "input");
        const output = contentText(event, "output");
        return (
          <section
            key={event.event_id}
            className="rounded-md border border-border bg-bg-surface/20 p-2.5"
          >
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="rounded bg-bg-surface px-1.5 py-0.5 font-mono text-xs text-fg-muted">
                {event.kind}
              </span>
              <span className="font-mono text-xs text-fg-subtle">
                {eventTitle(event)}
              </span>
            </div>
            {input === "" && output === "" && event.error === undefined ? (
              <p className="font-mono text-xs text-fg-subtle">
                No text captured for this event.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {input !== "" && (
                  <div>
                    <div className="mb-1 font-mono text-xs text-fg-subtle">input</div>
                    <Pre text={input} />
                  </div>
                )}
                {output !== "" && (
                  <div>
                    <div className="mb-1 font-mono text-xs text-fg-subtle">output</div>
                    <Pre text={output} />
                  </div>
                )}
                {event.error !== undefined && (
                  <div>
                    <div className="mb-1 font-mono text-xs text-danger">error</div>
                    <Pre text={event.error.message} />
                  </div>
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function Raw({ events }: { events: readonly AgentEvent[] }) {
  if (events.length === 0) {
    return (
      <p className="text-sm text-fg-muted">
        No source events are linked to this row.
      </p>
    );
  }

  const text = JSON.stringify(events, null, 2);
  const capped =
    text.length <= 100_000
      ? text
      : `${text.slice(0, 100_000)}\n… truncated (${text.length - 100_000} more chars)`;

  return (
    <pre className="whitespace-pre-wrap break-words rounded-md border border-border bg-bg p-2 font-mono text-xs text-fg-muted">
      {capped}
    </pre>
  );
}
