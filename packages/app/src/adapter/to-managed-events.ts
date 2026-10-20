/**
 * Adapt OpenMaTel's canonical `oma.agentobs.v1` event stream to the managed
 * session event vocabulary the vendored OpenMA console understands.
 *
 * This module is deliberately pure: no React, no fetch, no store. It is the
 * only place that knows how an `AgentEvent` becomes a `user.message`,
 * `span.model_request_*`, `agent.tool_use`, … event, which is what lets the
 * *unmodified* `TimelineView` and `ManagedSessionConversation` render an
 * OpenMaTel session.
 *
 * Conventions required by the console:
 * - every event has `id`, `processed_at` (ISO, used by the timeline),
 *   `ts` (ISO, conversation/event vocabulary) and a monotonic `seq`;
 * - paired spans link through `model_request_start_id` /
 *   `tool_use_id` / `mcp_tool_use_id`;
 * - token usage is included field-by-field **only when reported** — a
 *   missing usage object is omitted entirely, never serialized as zero.
 */

import type {
  AgentEvent,
  EventContent,
  TurnNode,
  Usage,
} from "@openmatel/core";

import type { Event } from "../../../oma-console-ui/vendor/lib/events";

/** An event with the metadata the console relies on. */
export interface ManagedEvent extends Event {
  id: string;
  processed_at: string;
  ts: string;
  seq: number;
}

/** Structural subset of `ObsSessionDetail` the adapter needs. */
export interface ManagedEventSource {
  turns: readonly Pick<TurnNode, "events">[];
}

interface Draft {
  event: Event;
  at: number;
  rank: number;
  order: number;
}

const PRIMARY_THREAD = "sthr_primary";

/** Rank events that share a timestamp so pairs keep their start→end order. */
const RANK: Record<string, number> = {
  "user.message": 10,
  "session.status_running": 20,
  "span.model_request_start": 30,
  "span.compaction_summarize_start": 35,
  "agent.thinking": 40,
  "agent.message": 50,
  "agent.tool_use": 60,
  "agent.mcp_tool_use": 60,
  "agent.custom": 65,
  "session.thread_created": 65,
  "span.model_first_token": 70,
  "agent.tool_result": 80,
  "agent.mcp_tool_result": 80,
  "span.compaction_summarize_end": 85,
  "span.model_request_end": 90,
  "session.status_idle": 100,
};

const rankOf = (type: string): number => RANK[type] ?? 50;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

const asFiniteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** OpenMaTel records `<synthetic>` for internally-generated messages. */
export const isSyntheticModel = (model: string | undefined): boolean =>
  model !== undefined && model.trim().toLowerCase() === "<synthetic>";

/** ISO timestamp, normalised to UTC; falls back to the source event time. */
function iso(value: string | undefined, fallback: string): string {
  const parsed = Date.parse(value ?? fallback);
  if (Number.isNaN(parsed)) {
    const backup = Date.parse(fallback);
    return new Date(Number.isNaN(backup) ? 0 : backup).toISOString();
  }
  return new Date(parsed).toISOString();
}

function timeOf(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Plain text of one side of a captured payload. */
function contentText(
  content: EventContent | undefined,
  side: "input" | "output",
): string {
  const part = content?.[side];
  if (part === undefined) return "";
  if (typeof part.text === "string") return part.text;
  if (part.json !== undefined) return stringify(part.json);
  return "";
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function messageText(event: AgentEvent, preferred: "input" | "output"): string {
  const primary = contentText(event.content, preferred);
  if (primary !== "") return primary;
  return contentText(event.content, preferred === "input" ? "output" : "input");
}

/** Non-null token counters, mapped to the console's field names. */
export function modelUsage(usage: Usage | null | undefined): Record<string, number> | undefined {
  if (usage === null || usage === undefined) return undefined;
  const mapped: Record<string, number> = {};
  const fields: Array<[keyof Usage, string]> = [
    ["input_tokens", "input_tokens"],
    ["output_tokens", "output_tokens"],
    ["cache_read_tokens", "cache_read_input_tokens"],
    ["cache_write_tokens", "cache_creation_input_tokens"],
  ];
  for (const [source, target] of fields) {
    const value = asFiniteNumber(usage[source]);
    if (value !== undefined) mapped[target] = value;
  }
  return Object.keys(mapped).length === 0 ? undefined : mapped;
}

/** Raw input of a tool call: structured JSON when possible, else the string. */
function toolInput(event: AgentEvent): unknown {
  const part = event.content?.input;
  if (part === undefined) return undefined;
  if (part.json !== undefined) return part.json;
  if (typeof part.text === "string") {
    const trimmed = part.text.trim();
    if (trimmed.startsWith("{")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isObject(parsed)) return parsed;
      } catch {
        // Not JSON after all; keep the original text.
      }
    }
    return part.text;
  }
  return undefined;
}

interface FoldedChildren {
  input: unknown;
  outputSuffix: string;
}

/**
 * Fold `env.command` / `env.file_edit` children into the parent tool call.
 * They are implementation detail of the tool call, not separate managed
 * events; keeping their commands/paths in the call input preserves what the
 * operator needs to understand the step.
 */
function foldChildren(input: unknown, children: readonly AgentEvent[]): FoldedChildren {
  if (children.length === 0) return { input, outputSuffix: "" };

  const object: Record<string, unknown> | undefined = isObject(input) ? { ...input } : undefined;
  const commands: string[] = [];
  const files: Array<{ path: string; op?: string }> = [];
  const outputs: string[] = [];

  for (const child of children) {
    if (child.kind === "env.command") {
      const command = asString(child.attrs.command);
      if (command !== undefined) {
        commands.push(command);
        if (object !== undefined && object.command === undefined) object.command = command;
      }
      const cwd = asString(child.attrs.cwd);
      if (object !== undefined && object.cwd === undefined && cwd !== undefined) object.cwd = cwd;
      const output = contentText(child.content, "output");
      if (output !== "") outputs.push(output);
    } else if (child.kind === "env.file_edit") {
      const path = asString(child.attrs.path);
      const op = asString(child.attrs.op);
      if (path !== undefined) {
        files.push(op === undefined ? { path } : { path, op });
        if (object !== undefined && object.file_path === undefined && object.path === undefined) {
          object.file_path = path;
        }
      }
      const diff = contentText(child.content, "output");
      if (diff !== "") outputs.push(diff);
    }
  }

  if (object !== undefined) {
    if (commands.length > 1) object.commands = commands;
    if (files.length > 0) object.files = files;
  }

  return {
    input: object ?? input,
    outputSuffix: outputs.join("\n\n"),
  };
}

/** Server name of a Claude-style `mcp__server__tool` name. */
function mcpParts(
  toolName: string,
  attrs: Record<string, unknown>,
): { name: string; server?: string; isMcp: boolean } {
  const explicitServer = asString(attrs.mcp_server_name) ?? asString(attrs.server);
  const kind = asString(attrs.tool_kind);
  if (explicitServer !== undefined) {
    return { name: toolName, server: explicitServer, isMcp: true };
  }
  if (kind === "mcp" || toolName.includes("mcp__")) {
    const parts = toolName.split("__");
    if (parts[0] === "mcp" && parts.length >= 3) {
      return { name: parts.slice(2).join("__"), server: parts[1], isMcp: true };
    }
    return { name: toolName, server: parts[1], isMcp: true };
  }
  return { name: toolName, isMcp: false };
}

/**
 * Convert one OpenMaTel session detail (summary + turns, each carrying its
 * canonical events) into console events.
 */
export function toManagedEvents(detail: ManagedEventSource): ManagedEvent[] {
  const byId = new Map<string, AgentEvent>();
  for (const turn of detail.turns) {
    for (const event of turn.events) {
      if (!isObject(event) || typeof event.event_id !== "string" || event.event_id === "") continue;
      // At-least-once delivery: the last write for an event id wins.
      byId.set(event.event_id, event);
    }
  }

  const ordered = [...byId.values()].sort((a, b) => {
    const delta = timeOf(a.ts) - timeOf(b.ts);
    if (delta !== 0) return delta;
    return a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0;
  });

  const childrenByParent = new Map<string, AgentEvent[]>();
  for (const event of ordered) {
    if (event.kind !== "env.command" && event.kind !== "env.file_edit") continue;
    const parent = event.parent_step_id;
    if (parent === undefined) continue;
    const children = childrenByParent.get(parent) ?? [];
    children.push(event);
    childrenByParent.set(parent, children);
  }

  const drafts: Draft[] = [];
  let order = 0;

  const add = (
    type: string,
    at: string,
    fields: Record<string, unknown> = {},
    rank = rankOf(type),
  ): void => {
    const timestamp = iso(at, at);
    drafts.push({
      event: { type, ...fields, ts: timestamp, processed_at: timestamp },
      at: timeOf(timestamp),
      rank,
      order: order++,
    });
  };

  for (const event of ordered) {
    const start = iso(event.ts, event.ts);
    const end = iso(event.end_ts ?? event.ts, event.ts);
    const startId = event.event_id;

    switch (event.kind) {
      case "message.user":
        add("user.message", start, {
          id: `${startId}:user`,
          content: [{ type: "text", text: messageText(event, "input") }],
          session_thread_id: PRIMARY_THREAD,
        });
        break;

      case "message.agent":
        add("agent.message", start, {
          id: `${startId}:agent`,
          content: [{ type: "text", text: messageText(event, "output") }],
          session_thread_id: PRIMARY_THREAD,
        });
        break;

      case "reasoning":
        add("agent.thinking", start, {
          id: `${startId}:thinking`,
          content: [{ type: "text", text: messageText(event, "output") }],
          session_thread_id: PRIMARY_THREAD,
        });
        break;

      case "llm.call": {
        const model = isSyntheticModel(asString(event.attrs.model))
          ? undefined
          : asString(event.attrs.model);
        const usage = modelUsage(event.usage);
        const finishReason =
          asString(event.attrs.stop_reason) ?? asString(event.attrs.finish_reason);
        const modelStartId = `${startId}:model_start`;

        add("span.model_request_start", start, {
          id: modelStartId,
          ...(model === undefined ? {} : { model }),
        });

        const ttft = asFiniteNumber(event.attrs.ttft_ms);
        if (ttft !== undefined && ttft >= 0) {
          const firstTokenAt = Math.min(
            timeOf(start) + ttft,
            Math.max(timeOf(start), timeOf(end)),
          );
          add("span.model_first_token", new Date(firstTokenAt).toISOString(), {
            id: `${startId}:model_first_token`,
            model_request_start_id: modelStartId,
            data: { model_request_start_id: modelStartId },
          });
        }

        const data: Record<string, unknown> = { model_request_start_id: modelStartId };
        if (usage !== undefined) data.model_usage = usage;
        if (finishReason !== undefined) data.finish_reason = finishReason;
        if (event.status === "error" && event.error !== undefined) {
          data.finish_reason = "error";
          data.error_message = event.error.message;
        }

        add("span.model_request_end", end, {
          id: `${startId}:model_end`,
          model_request_start_id: modelStartId,
          ...(model === undefined ? {} : { model }),
          ...(usage === undefined ? {} : { model_usage: usage }),
          ...(finishReason === undefined ? {} : { finish_reason: finishReason }),
          data,
        });
        break;
      }

      case "tool.call": {
        const attrs = event.attrs;
        const callId = asString(attrs.call_id) ?? event.step_id ?? event.event_id;
        const toolName = asString(attrs.tool_name) ?? "tool";
        const mcp = mcpParts(toolName, attrs);
        const children = event.step_id === undefined
          ? []
          : childrenByParent.get(event.step_id) ?? [];
        const folded = foldChildren(toolInput(event), children);
        const output = contentText(event.content, "output");
        const resultText = [output, folded.outputSuffix].filter((part) => part !== "").join("\n\n");
        const isError = event.status === "error" || event.error !== undefined;
        const resultTextOrError = resultText !== ""
          ? resultText
          : event.error?.message ?? "";

        if (mcp.isMcp) {
          add("agent.mcp_tool_use", start, {
            id: callId,
            name: mcp.name,
            mcp_server_name: mcp.server,
            input: folded.input,
            session_thread_id: PRIMARY_THREAD,
          });
          add("agent.mcp_tool_result", end, {
            id: `${startId}:mcp_result`,
            mcp_tool_use_id: callId,
            content: [{ type: "text", text: resultTextOrError }],
            is_error: isError,
            session_thread_id: PRIMARY_THREAD,
          });
        } else {
          add("agent.tool_use", start, {
            id: callId,
            name: toolName,
            input: folded.input,
            session_thread_id: PRIMARY_THREAD,
          });
          add("agent.tool_result", end, {
            id: `${startId}:tool_result`,
            tool_use_id: callId,
            content: [{ type: "text", text: resultTextOrError }],
            is_error: isError,
            session_thread_id: PRIMARY_THREAD,
          });
        }
        break;
      }

      case "env.command":
      case "env.file_edit":
        // Folded into the parent tool call above; deliberately not emitted.
        break;

      case "turn.start":
        add("session.status_running", start, {
          id: `${startId}:running`,
          session_thread_id: PRIMARY_THREAD,
        });
        break;

      case "turn.end":
        add("session.status_idle", start, {
          id: `${startId}:idle`,
          session_thread_id: PRIMARY_THREAD,
        });
        break;

      case "control.compaction":
        add("span.compaction_summarize_start", start, {
          id: `${startId}:compaction_start`,
          session_thread_id: PRIMARY_THREAD,
        });
        add("span.compaction_summarize_end", end, {
          id: `${startId}:compaction_end`,
          session_thread_id: PRIMARY_THREAD,
        });
        break;

      case "plan.update": {
        const entries = Array.isArray(event.attrs.entries) ? event.attrs.entries : [];
        const text = entries
          .map((entry) => {
            if (!isObject(entry)) return "";
            const content = asString(entry.content) ?? "";
            const status = asString(entry.status);
            return status === undefined ? content : `${status}: ${content}`;
          })
          .filter((line) => line !== "")
          .join("\n");
        add("agent.custom", start, {
          id: `${startId}:plan`,
          name: "plan",
          content: [{ type: "text", text }],
          data: { entries },
          session_thread_id: PRIMARY_THREAD,
        });
        break;
      }

      case "subagent.spawn": {
        const threadId =
          asString(event.attrs.child_session_id) ?? `${event.event_id}:thread`;
        add("session.thread_created", start, {
          id: `${startId}:thread`,
          thread_id: threadId,
          parent_thread_id: PRIMARY_THREAD,
          ...(asString(event.attrs.agent_name) === undefined
            ? {}
            : { agent_name: asString(event.attrs.agent_name) }),
          ...(asString(event.attrs.task) === undefined
            ? {}
            : { task: asString(event.attrs.task) }),
          session_thread_id: PRIMARY_THREAD,
        });
        break;
      }

      // Session envelope + unsupported kinds have no managed counterpart.
      // (The session-level events are intentionally not rendered as turns.)
      default:
        break;
    }
  }

  drafts.sort((a, b) => {
    if (a.at !== b.at) return a.at - b.at;
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.order - b.order;
  });

  return drafts.map((draft, index) => ({
    ...draft.event,
    id: typeof draft.event.id === "string" ? draft.event.id : `managed-${index}`,
    processed_at:
      typeof draft.event.processed_at === "string"
        ? draft.event.processed_at
        : new Date(draft.at).toISOString(),
    ts: typeof draft.event.ts === "string" ? draft.event.ts : new Date(draft.at).toISOString(),
    seq: index + 1,
  }));
}

/** Convenience wrapper when only a flat event list is available. */
export function toManagedEventsFromEvents(events: readonly AgentEvent[]): ManagedEvent[] {
  return toManagedEvents({ turns: [{ events: [...events] }] });
}
