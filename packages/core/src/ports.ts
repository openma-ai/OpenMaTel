/**
 * Ports — the interfaces every adapter implements.
 *
 * `core` owns the domain model and the ports; everything else is an adapter
 * that depends on `core` and never the other way around (§3.1, §3.4). The
 * pipeline is staged:
 *
 * ```
 * Source ──▶ Normalizer ──▶ Processor chain ──▶ Bus ──▶ Sink(s)
 *                                                │
 *                                                └──▶ Query (read side)
 * ```
 *
 * Writing (Sink) and reading (Query) are separate ports, so a store can be
 * write-only, read-only or both. These types are pure interfaces: no IO, no
 * platform specifics, no dependencies.
 */

import type {
  AgentEvent,
  Content,
  EventKind,
  StepStatus,
  Usage,
} from "./schema.js";
import type { SessionSummary, SegmentNode, TurnNode } from "./tree.js";
import type { UsageTotal } from "./usage.js";

/* -------------------------------------------------------------------------- */
/* Ingest side                                                                 */
/* -------------------------------------------------------------------------- */

/** One raw record as read from a source, before normalization. */
export interface RawRecord {
  /** Source the record came from, e.g. `"claude-code"`. */
  source: string;
  /** Where the record was read from: file path, offset, span id, … */
  ref: string;
  /** Line number, for line-oriented sources. */
  line?: number;
  /** The record itself, in the source's own format. */
  data: unknown;
}

/** A source of raw records: a pull connector (local files) or a push feed. */
export interface Source {
  /** Stable id of the source, e.g. `"claude-code"`. */
  id: string;
  /** Whether the source is polled (`pull`) or pushes records (`push`). */
  kind: "pull" | "push";
  /**
   * Start the source. Records are handed to `emit` as they are read.
   * The returned promise resolves when the source is exhausted or aborted.
   */
  start(emit: (raw: RawRecord) => Promise<void>, signal: AbortSignal): Promise<void>;
  /** Position of the last read record, so a pull source can resume. */
  checkpoint?(): Promise<SourceCursor>;
}

/** Position of a pull source, used to resume an interrupted read. */
export interface SourceCursor {
  /** Source the cursor belongs to. */
  source: string;
  /** File path or stream the cursor points into. */
  ref: string;
  /** Byte offset, for byte-oriented files. */
  offset?: number;
  /** Modification time, for files that can be rotated. */
  mtime?: string;
  /** Content hash, to detect that a file was rewritten. */
  hash?: string;
  /** Anything else a source needs to resume. */
  extra?: Record<string, unknown>;
}

/** Turns raw records of one source into canonical events. */
export interface Normalizer {
  /** `true` when this normalizer handles the record. */
  accepts(raw: RawRecord): boolean;
  /** The source and version this normalizer implements. */
  schema: { source: string; version: string };
  /**
   * Normalize one raw record into canonical events.
   * Must be deterministic: the same record always yields the same `event_id`.
   * Unknown record types must not throw; they become `raw.unknown` events.
   */
  normalize(raw: RawRecord): AgentEvent[];
}

/** A link in the processor chain. */
export interface Processor {
  /** Stable id of the processor, e.g. `"redaction"`. */
  id: string;
  /**
   * Transform one event. Returning `null` drops the event.
   * Processors must be deterministic and side-effect free.
   */
  process(e: AgentEvent, ctx: ProjectCtx): Promise<AgentEvent | null>;
}

/** Project context handed to every processor. */
export interface ProjectCtx {
  /** Tenant unit the event belongs to. */
  project_id: string;
  /** How much content may be kept. */
  capture_level: CaptureLevel;
}

/** How much of a step's content may be kept. */
export type CaptureLevel = "off" | "truncated" | "full";

/** Cancels a subscription. */
export type Unsubscribe = () => void;

/** Transport between the ingest stages. Delivery is at-least-once. */
export interface Bus {
  /** Publish a batch of events. */
  publish(batch: AgentEvent[]): Promise<void>;
  /** Subscribe to published batches. */
  subscribe(h: (b: AgentEvent[]) => Promise<void>): Unsubscribe;
}

/** Destination of canonical events. Writes must be idempotent by `event_id`. */
export interface Sink {
  /** Stable id of the sink, e.g. `"sqlite"`. */
  id: string;
  /** Write a batch of events; writing the same batch twice is a no-op. */
  write(batch: AgentEvent[]): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Read side                                                                   */
/* -------------------------------------------------------------------------- */

/** Filter for the session list. */
export interface SessionQuery {
  project_id?: string;
  /** Source name, e.g. `"claude-code"`. */
  source?: string;
  /** Harness name, e.g. `"claude-code"`. */
  harness?: string;
  /** Only sessions that contain a failed step. */
  has_error?: boolean;
  /** Free-text search over title, cwd and event content. */
  text?: string;
  /** ISO timestamp, inclusive lower bound. */
  from?: string;
  /** ISO timestamp, exclusive upper bound. */
  to?: string;
  /** Opaque cursor of the previous page. */
  cursor?: string;
  /** Maximum number of items per page. */
  limit?: number;
}

/** Filter for the step list. */
export interface StepQuery {
  project_id?: string;
  session_id?: string;
  turn_id?: string;
  /** One or more kinds to include. */
  kind?: EventKind | EventKind[];
  /** Only steps with this status. */
  status?: StepStatus;
  /** Only steps of this tool. */
  tool_name?: string;
  /** Only steps of this harness. */
  harness?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}

/** One page of results plus the cursor of the next page. */
export interface Page<T> {
  items: T[];
  /** `null` when the last page was reached. */
  next_cursor: string | null;
}

/** A flat step, as returned by {@link Query.listSteps}. */
export interface Step {
  step_id: string;
  session_id: string;
  turn_id?: string;
  parent_step_id?: string;
  kind: EventKind;
  status?: StepStatus;
  ts: string;
  end_ts?: string;
  title?: string;
  attrs: Record<string, unknown>;
  error?: AgentEvent["error"];
  usage?: Usage | null;
  source: AgentEvent["source"];
}

/** A session with all of its events. */
export interface SessionDetail {
  summary: SessionSummary;
  events: AgentEvent[];
  /** The turn/step tree, when the store keeps one. */
  turns?: TurnNode[];
  /** The segment tree, when the store keeps one. */
  segments?: SegmentNode[];
}

/** Aggregation request, e.g. tool-error hotspots or usage per model. */
export interface AggQuery {
  project_id?: string;
  /** Dimension to group by. */
  group_by: "tool_name" | "harness" | "model" | "project" | "kind";
  /** Metric to aggregate. */
  metric?: "count" | "usage" | "cost" | "latency";
  from?: string;
  to?: string;
  limit?: number;
}

/** One group of an aggregation result. */
export interface AggGroup {
  /** Value of the grouping dimension. */
  key: string;
  /** Number of events in the group. */
  count: number;
  /** Token usage of the group, for the `usage` metric. */
  usage?: UsageTotal;
  /** Cost of the group, for the `cost` metric. */
  cost_usd?: number | null;
  /** Mean duration of the group, for the `latency` metric. */
  latency_ms?: number | null;
}

/** Result of an aggregation. */
export interface AggResult {
  groups: AggGroup[];
  /** Total number of events that were aggregated. */
  total: number;
}

/** Reference to a content blob that is too large to inline. */
export interface ContentRef {
  project_id?: string;
  session_id?: string;
  step_id?: string;
  /** Which side of the step the content belongs to. */
  side: "input" | "output";
}

/** The read port. A store implements it, the UI only talks to it over HTTP. */
export interface Query {
  /** List the sessions matching a query. */
  listSessions(q: SessionQuery): Promise<Page<SessionSummary>>;
  /** Load one session with its events, or `null` when it does not exist. */
  getSession(session_id: string): Promise<SessionDetail | null>;
  /** List the steps matching a query. */
  listSteps(q: StepQuery): Promise<Page<Step>>;
  /** Aggregations such as error hotspots, usage and latency. */
  aggregate?(q: AggQuery): Promise<AggResult>;
  /** Load the content of a step on demand, from the same store. */
  getContent?(ref: ContentRef): Promise<Content | null>;
}

/* -------------------------------------------------------------------------- */
/* Blobs and auth                                                              */
/* -------------------------------------------------------------------------- */

/** Binary payload. */
export type Bytes = Uint8Array;

/** Metadata of a stored blob. */
export interface BlobMeta {
  content_type?: string;
  size?: number;
  sha256?: string;
  created_at?: string;
  [key: string]: unknown;
}

/** Storage for large binary attachments (screenshots, files, exports). */
export interface BlobStore {
  /** Store a blob under `key`. */
  put(key: string, body: Bytes, meta?: BlobMeta): Promise<void>;
  /** Read a blob, or `null` when it does not exist. */
  get(key: string): Promise<Bytes | null>;
}

/** The authenticated caller. */
export interface Principal {
  /** Project the caller may read and write. */
  project_id: string;
  /** Organization the project belongs to, when the deployment has orgs. */
  org_id?: string;
  /** Stable subject of the caller. */
  subject?: string;
  /** Granted scopes. */
  scopes?: string[];
}

/** Authentication plugin. Adapters chain several of them. */
export interface AuthProvider {
  /** Resolve the principal of a request, or `null` when it is not allowed. */
  authenticate(req: Request): Promise<Principal | null>;
}
