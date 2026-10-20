/**
 * Canonical agent event schema — `oma.agentobs.v1`.
 *
 * This module is the heart of the OpenMaTel domain model: every source is
 * normalized into {@link AgentEvent}, every processor rewrites events of this
 * shape and every store persists them. See `docs/design.md` §4.
 *
 * Rules that this module encodes:
 *
 * - **"missing" is not "0"** (§4.5). Token fields are `number | null`; `null`
 *   means "the source did not tell us", `0` means "the source told us zero".
 *   A normalizer must never write `0` for an unknown value.
 * - **The schema is versioned.** {@link SCHEMA_VERSION} is part of every event
 *   so a store can reject foreign rows.
 * - **No IO, no dependencies.** This file is pure types plus hand-written
 *   validation; it must stay importable in a browser, a worker or a test.
 */

/** Version of the canonical agent event schema. */
export const SCHEMA_VERSION = "oma.agentobs.v1";

/**
 * Id of the first segment of every session.
 *
 * A session starts in segment `seg_0`; `segment.boundary` events open the
 * following segments. Normalizers that do not know about context boundaries
 * yet use this id for every event (design §15.1).
 */
export const FIRST_SEGMENT_ID = "seg_0";

/**
 * Every kind of observable agent activity.
 *
 * The list is intentionally coarse: it describes *what the agent did*, not
 * *which vendor did it*. Harness-specific details live in `attrs`.
 */
export type EventKind =
  | "session.start"
  | "session.end"
  | "turn.start"
  | "turn.end"
  | "message.user"
  | "message.agent"
  | "reasoning"
  | "llm.call"
  | "tool.call"
  | "env.command"
  | "env.file_edit"
  | "env.browser"
  | "subagent.spawn"
  | "handoff"
  | "plan.update"
  | "permission.request"
  | "permission.decision"
  | "control.interrupt"
  | "control.cancel"
  | "control.retry"
  | "control.compaction"
  | "control.resume"
  | "segment.boundary"
  | "memory.read"
  | "memory.write"
  | "skill.use"
  | "outcome"
  | "raw.unknown";

/** Runtime list of every known {@link EventKind}, in schema order. */
export const EVENT_KINDS = [
  "session.start",
  "session.end",
  "turn.start",
  "turn.end",
  "message.user",
  "message.agent",
  "reasoning",
  "llm.call",
  "tool.call",
  "env.command",
  "env.file_edit",
  "env.browser",
  "subagent.spawn",
  "handoff",
  "plan.update",
  "permission.request",
  "permission.decision",
  "control.interrupt",
  "control.cancel",
  "control.retry",
  "control.compaction",
  "control.resume",
  "segment.boundary",
  "memory.read",
  "memory.write",
  "skill.use",
  "outcome",
  "raw.unknown",
] as const satisfies readonly EventKind[];

/** Outcome of a step or of a whole session. */
export type StepStatus = "ok" | "error" | "cancelled" | "interrupted" | "denied" | "timeout";

/** Runtime list of every known {@link StepStatus}. */
export const STEP_STATUSES = [
  "ok",
  "error",
  "cancelled",
  "interrupted",
  "denied",
  "timeout",
] as const satisfies readonly StepStatus[];

/** How much of a step's content was kept, and whether it was sanitized. */
export type ContentCapture = "full" | "truncated" | "redacted" | "none";

/** Runtime list of every known {@link ContentCapture}. */
export const CONTENT_CAPTURES = [
  "full",
  "truncated",
  "redacted",
  "none",
] as const satisfies readonly ContentCapture[];

/** Payload of a step (tool output, command stdout, a diff, a message, …). */
export interface Content {
  /** Plain text payload. */
  text?: string;
  /** Structured payload, kept as-is (JSON-serializable in practice). */
  json?: unknown;
  /** `true` when the text was shortened to fit the capture budget. */
  truncated?: boolean;
  /** Length of the original payload before truncation. */
  original_length?: number;
}

/** Where a {@link Usage} record came from. */
export type UsageSource = "provider" | "harness" | "estimated" | "missing";

/** Runtime list of every known {@link UsageSource}. */
export const USAGE_SOURCES = [
  "provider",
  "harness",
  "estimated",
  "missing",
] as const satisfies readonly UsageSource[];

/** Where a cost figure came from. */
export type CostSource = "price_table" | "provider" | "harness";

/** Runtime list of every known {@link CostSource}. */
export const COST_SOURCES = ["price_table", "provider", "harness"] as const satisfies readonly CostSource[];

/**
 * Token accounting of one model call.
 *
 * Every token field is `number | null`:
 *
 * - `null` — the source did not report this number (missing, not zero);
 * - `0`    — the source reported zero.
 *
 * The distinction is load-bearing: a session that reports no usage must never
 * be presented as "0 tokens used" (§4.5).
 *
 * `input_tokens` is **uncached input**: the tokens that missed the prompt
 * cache. The full prompt size of the call is
 * `input_tokens + cache_read_tokens + cache_write_tokens`; that is what
 * `llm.call.attrs.context_tokens` and {@link contextTokens} report (§15.5).
 */
export interface Usage {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  reasoning_tokens: number | null;
  /** Where the numbers came from; `"missing"` when nothing was reported. */
  source: UsageSource;
  /** Cost in US dollars, when known. */
  cost_usd?: number | null;
  /** Where the cost came from. */
  cost_source?: CostSource;
}

/** The five token fields of {@link Usage}, in a stable order. */
export const USAGE_TOKEN_FIELDS = [
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "reasoning_tokens",
] as const satisfies readonly (keyof Usage)[];

/** Union of the token field names of {@link Usage}. */
export type UsageTokenField = (typeof USAGE_TOKEN_FIELDS)[number];

/** Structured error attached to a failed step. */
export interface EventError {
  type: string;
  message: string;
  retryable?: boolean;
}

/** Provenance of an event: which source produced it and where it was read. */
export interface EventSource {
  /** Source name, e.g. `"claude-code"`, `"otlp"`, `"acp"`. */
  name: string;
  /** Source version, e.g. the file format version. */
  version?: string;
  /** Concrete format of the payload, e.g. `"jsonl"`, `"otlp-protobuf"`. */
  format: string;
  /** Where the record was read from: file path + offset, span id, … */
  ref?: string;
}

/** Cross-references to other systems (OTel trace/span ids, openma ids, …). */
export interface EventLinks {
  trace_id?: string;
  span_id?: string;
  /** Free-form external identifiers, e.g. `openma.session_id`. */
  external?: Record<string, string>;
}

/** Content of a step, governed by the project capture level. */
export interface EventContent {
  input?: Content;
  output?: Content;
  /** How much of the content was captured. */
  capture: ContentCapture;
}

/**
 * The canonical event envelope.
 *
 * Every normalized event — whatever the source format was — has this shape.
 * It is flat on purpose: hierarchy is expressed with `parent_step_id` so that
 * out-of-order delivery is always representable.
 */
export interface AgentEvent {
  /** Always {@link SCHEMA_VERSION}. */
  schema: typeof SCHEMA_VERSION;
  /** Deterministic id: the same source record always yields the same id. */
  event_id: string;
  /** Tenant unit the event belongs to. */
  project_id: string;
  /** Canonical session id (a hash of source + source session id). */
  session_id: string;
  /**
   * Segment of the session this event belongs to (design §15.1).
   *
   * The first segment is {@link FIRST_SEGMENT_ID}; a `segment.boundary` event
   * opens the following segments. Required on every event so that the Query
   * API can filter and aggregate by context boundary.
   */
  segment_id: string;
  /** Canonical turn id, when the event belongs to a turn. */
  turn_id?: string;
  /** Canonical step id, when the event is a step. */
  step_id?: string;
  /** Step id of the parent step, for nested steps. */
  parent_step_id?: string;
  /** ISO-8601 start timestamp. */
  ts: string;
  /** ISO-8601 end timestamp, for steps that have a duration. */
  end_ts?: string;
  /** What the agent did. */
  kind: EventKind;
  /** Outcome of the step, when known. */
  status?: StepStatus;
  /** Failure detail, when the step failed. */
  error?: EventError;
  /** Kind-specific structured fields (see the `*Attrs` interfaces). */
  attrs: Record<string, unknown>;
  /** Captured content of the step. */
  content?: EventContent;
  /** Token accounting, when the source reported it. */
  usage?: Usage | null;
  /** Provenance of the event. */
  source: EventSource;
  /** Cross-references to other systems. */
  links?: EventLinks;
}

/* -------------------------------------------------------------------------- */
/* Typed attributes                                                            */
/* -------------------------------------------------------------------------- */

/** The harness (agent runtime) that produced the session. */
export interface HarnessInfo {
  name: string;
  version?: string;
}

/** Git context of the working directory. */
export interface GitInfo {
  branch?: string;
  commit?: string;
}

/** `session.start` attributes. */
export interface SessionStartAttrs {
  harness: HarnessInfo;
  model?: string;
  cwd?: string;
  git?: GitInfo;
  title?: string;
  /** Set when the session was spawned by another session (a subagent). */
  parent_session_id?: string;
  /** Step of the parent session that spawned this one. */
  parent_step_id?: string;
}

/** `session.end` attributes. */
export interface SessionEndAttrs {
  end_reason?: string;
  title?: string;
}

/** What triggered a turn. */
export type TurnTrigger = "user" | "schedule" | "handoff" | "system" | "other";

/** `turn.start` attributes. */
export interface TurnStartAttrs {
  trigger?: TurnTrigger;
  model?: string;
}

/** `turn.end` attributes. */
export interface TurnEndAttrs {
  stop_reason?: string;
  model?: string;
}

/** `message.*` and `reasoning` attributes. */
export interface MessageAttrs {
  role?: string;
  /** Attachment references (blob keys), when the message carried files. */
  attachments?: string[];
}

/** What a tool call did, in harness-neutral terms. */
export type ToolKind = "read" | "edit" | "execute" | "fetch" | "search" | "mcp" | "think" | "other";

/** `tool.call` attributes. */
export interface ToolCallAttrs {
  tool_name: string;
  tool_kind: ToolKind;
  /** Id of the call as issued by the harness; links tool_call to its result. */
  call_id: string;
  duration_ms?: number;
  /** Id of the tool call this one retries. */
  retry_of?: string;
}

/** `env.command` attributes. */
export interface EnvCommandAttrs {
  command: string;
  cwd?: string;
  exit_code?: number;
  duration_ms?: number;
}

/** What happened to a file. */
export type FileEditOp = "create" | "modify" | "delete";

/** `env.file_edit` attributes. */
export interface EnvFileEditAttrs {
  path: string;
  op: FileEditOp;
  /** Unified diff of the edit. */
  diff?: string;
  /** Number of bytes written. */
  bytes?: number;
}

/** What the agent did in the browser. */
export type BrowserAction = "navigate" | "click" | "type" | "screenshot" | "wait" | "other";

/** `env.browser` attributes. */
export interface EnvBrowserAttrs {
  action: BrowserAction;
  url?: string;
  selector?: string;
  /** Blob key of the screenshot, when one was captured. */
  screenshot_ref?: string;
}

/** `subagent.spawn` and `handoff` attributes. */
export interface SubagentSpawnAttrs {
  /** Canonical id of the child session. */
  child_session_id?: string;
  /** Name of the subagent, e.g. `"explore"`. */
  agent_name?: string;
  /** The task the subagent was given. */
  task?: string;
}

/** One entry of a plan / todo list. */
export interface PlanEntry {
  content: string;
  status: string;
  priority?: string;
}

/** `plan.update` attributes. */
export interface PlanUpdateAttrs {
  entries: PlanEntry[];
}

/**
 * `llm.call` attributes.
 *
 * `context_tokens` is the full prompt size the call saw:
 * `usage.input_tokens + usage.cache_read_tokens + usage.cache_write_tokens`
 * (all three must be known, otherwise it is `null`). `usage.input_tokens`
 * itself is always **uncached** input (design §15.5).
 *
 * The required keys are present even when the source did not report the value
 * — unknown is `null`, never a made-up zero.
 */
export interface LlmCallAttrs {
  provider: string | null;
  model: string | null;
  context_tokens: number | null;
  stop_reason: string | null;
  /** Latency of the whole call, in milliseconds. */
  latency_ms: number | null;
  /** Time to first token, in milliseconds. */
  ttft_ms: number | null;
  request_id?: string | null;
  /** Context window of the model, when the source reported it. */
  context_window?: number | null;
  /** Names of the fields whose values were estimated rather than reported. */
  derived?: string[];
}

/** Why a new segment was opened (design §15.1). */
export type SegmentBoundaryReason = "compaction" | "resume" | "fork" | "unknown";

/** `segment.boundary` attributes: the node that opens a new segment. */
export interface SegmentBoundaryAttrs {
  reason: SegmentBoundaryReason;
  context_tokens_before: number | null;
  context_tokens_after: number | null;
  tokens_removed: number | null;
  /** Compaction summary, subject to the project capture level. */
  summary?: string | null;
  parent_segment_id: string | null;
  /** `true` when the values were derived from neighbouring calls. */
  derived?: boolean;
}

/** `permission.request` attributes. */
export interface PermissionRequestAttrs {
  tool?: string;
  options?: string[];
}

/** How a permission request was answered. */
export type PermissionDecision = "allow_once" | "always" | "deny";

/** `permission.decision` attributes. */
export interface PermissionDecisionAttrs {
  tool?: string;
  decision?: PermissionDecision;
  decided_by?: string;
}

/** `control.*` attributes. */
export interface ControlAttrs {
  reason?: string;
  summary_tokens?: number;
}

/** `memory.read` / `memory.write` attributes. */
export interface MemoryAttrs {
  store?: string;
  key?: string;
  version?: string;
}

/** `skill.use` attributes. */
export interface SkillAttrs {
  skill_id?: string;
  version?: string;
}

/** `outcome` attributes. */
export interface OutcomeAttrs {
  rubric_id?: string;
  verdict?: string;
  iterations?: number;
}

/** Maps a kind to the shape of its structured attributes. */
export interface AttrsByKind {
  "session.start": SessionStartAttrs;
  "session.end": SessionEndAttrs;
  "turn.start": TurnStartAttrs;
  "turn.end": TurnEndAttrs;
  "message.user": MessageAttrs;
  "message.agent": MessageAttrs;
  reasoning: MessageAttrs;
  "llm.call": LlmCallAttrs;
  "tool.call": ToolCallAttrs;
  "env.command": EnvCommandAttrs;
  "env.file_edit": EnvFileEditAttrs;
  "env.browser": EnvBrowserAttrs;
  "subagent.spawn": SubagentSpawnAttrs;
  handoff: SubagentSpawnAttrs;
  "plan.update": PlanUpdateAttrs;
  "permission.request": PermissionRequestAttrs;
  "permission.decision": PermissionDecisionAttrs;
  "control.interrupt": ControlAttrs;
  "control.cancel": ControlAttrs;
  "control.retry": ControlAttrs;
  "control.compaction": ControlAttrs;
  "control.resume": ControlAttrs;
  "segment.boundary": SegmentBoundaryAttrs;
  "memory.read": MemoryAttrs;
  "memory.write": MemoryAttrs;
  "skill.use": SkillAttrs;
  outcome: OutcomeAttrs;
  "raw.unknown": Record<string, unknown>;
}

/** The attributes type of a given kind. */
export type AttrsFor<K extends EventKind> = AttrsByKind[K];

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

/** Result of {@link validateEvent}. */
export type ValidationResult = { ok: true } | { ok: false; errors: string[] };

const EVENT_KIND_SET: ReadonlySet<string> = new Set(EVENT_KINDS);
const STEP_STATUS_SET: ReadonlySet<string> = new Set(STEP_STATUSES);
const CONTENT_CAPTURE_SET: ReadonlySet<string> = new Set(CONTENT_CAPTURES);
const USAGE_SOURCE_SET: ReadonlySet<string> = new Set(USAGE_SOURCES);
const COST_SOURCE_SET: ReadonlySet<string> = new Set(COST_SOURCES);

/** ISO-8601 instant: `2026-01-02T03:04:05Z`, with optional fraction and offset. */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** `true` when the value is an ISO-8601 timestamp this runtime can parse. */
export const isIsoTimestamp = (value: unknown): value is string =>
  typeof value === "string" && ISO_TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value));

const requireString = (
  obj: Record<string, unknown>,
  key: string,
  errors: string[],
  path = key,
): void => {
  const value = obj[key];
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${path}: must be a non-empty string`);
  }
};

const optionalString = (
  obj: Record<string, unknown>,
  key: string,
  errors: string[],
  path = key,
): void => {
  const value = obj[key];
  if (value === undefined) return;
  if (typeof value !== "string") errors.push(`${path}: must be a string when present`);
};

const validateContent = (value: unknown, path: string, errors: string[]): void => {
  if (!isPlainObject(value)) {
    errors.push(`${path}: must be an object`);
    return;
  }
  if (value.text !== undefined && typeof value.text !== "string") {
    errors.push(`${path}.text: must be a string when present`);
  }
  if (value.truncated !== undefined && typeof value.truncated !== "boolean") {
    errors.push(`${path}.truncated: must be a boolean when present`);
  }
  if (value.original_length !== undefined && !isFiniteNumber(value.original_length)) {
    errors.push(`${path}.original_length: must be a number when present`);
  }
};

const validateUsage = (usage: unknown, errors: string[]): void => {
  if (usage === null) return;
  if (!isPlainObject(usage)) {
    errors.push("usage: must be an object or null");
    return;
  }
  for (const field of USAGE_TOKEN_FIELDS) {
    const value = usage[field];
    if (value === undefined) {
      // `null` means "unknown"; a missing key would silently become `undefined`.
      errors.push(`usage.${field}: must be present and be a number or null`);
      continue;
    }
    if (value !== null && !isFiniteNumber(value)) {
      errors.push(`usage.${field}: must be a number or null`);
    }
  }
  if (typeof usage.source !== "string" || !USAGE_SOURCE_SET.has(usage.source)) {
    errors.push(`usage.source: must be one of ${USAGE_SOURCES.join(", ")}`);
  }
  if (usage.cost_usd !== undefined && usage.cost_usd !== null && !isFiniteNumber(usage.cost_usd)) {
    errors.push("usage.cost_usd: must be a number or null when present");
  }
  if (usage.cost_source !== undefined && (typeof usage.cost_source !== "string" || !COST_SOURCE_SET.has(usage.cost_source))) {
    errors.push(`usage.cost_source: must be one of ${COST_SOURCES.join(", ")} when present`);
  }
};

/** Keys of {@link LlmCallAttrs} that every `llm.call` must carry. */
const REQUIRED_LLM_ATTRS = [
  "provider",
  "model",
  "context_tokens",
  "stop_reason",
  "latency_ms",
  "ttft_ms",
] as const;

const validateLlmCallAttrs = (attrs: Record<string, unknown>, errors: string[]): void => {
  const numericKeys = new Set<string>(["context_tokens", "latency_ms", "ttft_ms"]);

  for (const key of REQUIRED_LLM_ATTRS) {
    const expected = numericKeys.has(key) ? "a number or null" : "a string or null";
    if (!Object.prototype.hasOwnProperty.call(attrs, key)) {
      errors.push(`attrs.${key}: must be present and be ${expected}`);
      continue;
    }
    const value = attrs[key];
    if (value === null) continue;
    if (numericKeys.has(key)) {
      if (!isFiniteNumber(value)) errors.push(`attrs.${key}: must be ${expected}`);
    } else if (typeof value !== "string") {
      errors.push(`attrs.${key}: must be ${expected}`);
    }
  }

  // The optional fields may be absent, but when they are present they must
  // have the documented type (`undefined` is not a value a JSON producer can
  // send, so it is not accepted as "unknown").
  const requestId = attrs.request_id;
  if (requestId !== undefined && requestId !== null && typeof requestId !== "string") {
    errors.push("attrs.request_id: must be a string or null when present");
  }
  const contextWindow = attrs.context_window;
  if (contextWindow !== undefined && contextWindow !== null && !isFiniteNumber(contextWindow)) {
    errors.push("attrs.context_window: must be a number or null when present");
  }
  const derived = attrs.derived;
  if (derived !== undefined) {
    if (!Array.isArray(derived) || derived.some((field) => typeof field !== "string")) {
      errors.push("attrs.derived: must be an array of strings when present");
    }
  }
};

/**
 * Validate an unknown value against the canonical event schema.
 *
 * Hand-written on purpose: `core` has no dependencies, so no schema library.
 * The validator is strict about the things that silently corrupt a store
 * (missing timestamps, unknown kinds, `undefined` token counts) and lenient
 * about unknown extra fields, so that a newer producer can add information
 * without breaking an older consumer.
 *
 * @returns `{ ok: true }` or `{ ok: false, errors }` with one message per problem.
 */
export function validateEvent(event: unknown): ValidationResult {
  if (!isPlainObject(event)) {
    return { ok: false, errors: ["event: must be an object"] };
  }

  const errors: string[] = [];

  if (event.schema !== SCHEMA_VERSION) {
    errors.push(`schema: must be "${SCHEMA_VERSION}"`);
  }
  requireString(event, "event_id", errors);
  requireString(event, "project_id", errors);
  requireString(event, "session_id", errors);
  requireString(event, "segment_id", errors);
  optionalString(event, "turn_id", errors);
  optionalString(event, "step_id", errors);
  optionalString(event, "parent_step_id", errors);

  if (!isIsoTimestamp(event.ts)) {
    errors.push("ts: must be an ISO-8601 timestamp");
  }
  if (event.end_ts !== undefined && !isIsoTimestamp(event.end_ts)) {
    errors.push("end_ts: must be an ISO-8601 timestamp when present");
  }

  if (typeof event.kind !== "string" || !EVENT_KIND_SET.has(event.kind)) {
    errors.push(`kind: must be one of ${EVENT_KINDS.join(", ")}`);
  }

  if (event.status !== undefined && (typeof event.status !== "string" || !STEP_STATUS_SET.has(event.status))) {
    errors.push(`status: must be one of ${STEP_STATUSES.join(", ")} when present`);
  }

  if (event.error !== undefined) {
    if (!isPlainObject(event.error)) {
      errors.push("error: must be an object when present");
    } else {
      if (typeof event.error.type !== "string" || event.error.type.trim() === "") {
        errors.push("error.type: must be a non-empty string");
      }
      if (typeof event.error.message !== "string") {
        errors.push("error.message: must be a string");
      }
      if (event.error.retryable !== undefined && typeof event.error.retryable !== "boolean") {
        errors.push("error.retryable: must be a boolean when present");
      }
    }
  }

  if (!isPlainObject(event.attrs)) {
    errors.push("attrs: must be an object");
  } else if (event.kind === "llm.call") {
    validateLlmCallAttrs(event.attrs, errors);
  }

  if (event.content !== undefined) {
    if (!isPlainObject(event.content)) {
      errors.push("content: must be an object when present");
    } else {
      if (typeof event.content.capture !== "string" || !CONTENT_CAPTURE_SET.has(event.content.capture)) {
        errors.push(`content.capture: must be one of ${CONTENT_CAPTURES.join(", ")}`);
      }
      if (event.content.input !== undefined) validateContent(event.content.input, "content.input", errors);
      if (event.content.output !== undefined) validateContent(event.content.output, "content.output", errors);
    }
  }

  if (event.usage !== undefined) {
    validateUsage(event.usage, errors);
  }

  if (!isPlainObject(event.source)) {
    errors.push("source: must be an object");
  } else {
    requireString(event.source, "name", errors, "source.name");
    requireString(event.source, "format", errors, "source.format");
    optionalString(event.source, "version", errors, "source.version");
    optionalString(event.source, "ref", errors, "source.ref");
  }

  if (event.links !== undefined) {
    if (!isPlainObject(event.links)) {
      errors.push("links: must be an object when present");
    } else {
      optionalString(event.links, "trace_id", errors);
      optionalString(event.links, "span_id", errors);
      if (event.links.external !== undefined) {
        if (!isPlainObject(event.links.external)) {
          errors.push("links.external: must be an object when present");
        } else {
          for (const [key, value] of Object.entries(event.links.external)) {
            if (typeof value !== "string") {
              errors.push(`links.external.${key}: must be a string`);
            }
          }
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true };
}
