/**
 * The milestone-1 desktop CLI.
 *
 * Four commands, all local and all service-free:
 *
 * - `index` discovers the local session files of the enabled sources and
 *   writes them, incrementally, into `<data>/openmatel.db`;
 * - `sessions` lists the sessions of that database;
 * - `show` renders one session and its step timeline;
 * - `sources` only detects what is installed on this machine.
 *
 * Arguments are parsed by hand: the published package has no runtime
 * dependency, not even an argument parser.
 */

import os from "node:os";
import path from "node:path";
import * as zlib from "node:zlib";

import { createInprocBus } from "@openmatel/bus-inproc";
import type {
  SessionDetail,
  SessionSummary,
  StepNode,
  TurnNode,
} from "@openmatel/core";
import {
  createPipeline,
  runLocalIndex,
  type LocalIndexResult,
  type LocalIndexSourceStats,
} from "@openmatel/pipeline";
import { localSources, type LocalSource } from "@openmatel/source-local";

import {
  display,
  durationBetween,
  formatCoverage,
  formatDurationMs,
  formatLocalTimestamp,
  formatLocalTime,
  formatTokens,
  renderTable,
  shortSessionId,
  truncateText,
} from "./format.js";
import { err, out, processIO, type CommandIO } from "./io.js";
import { openBrowser, startServe, type ServeHandle } from "./serve.js";
import { databasePath, openStore } from "./store.js";
import { VERSION } from "./version.js";
import {
  createWatchIO,
  DEFAULT_WATCH_INTERVAL_MS,
  type IndexWatchOptions,
} from "./watch.js";

/** Every source of milestone 1, in the order they are listed in the design. */
export const ALL_SOURCES = ["claude-code", "codex", "dsh", "pi"] as const;

/** Name of one of the local sources. */
export type SourceName = (typeof ALL_SOURCES)[number];

/** A command-line usage error: reported without a stack trace. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/* -------------------------------------------------------------------------- */
/* Options                                                                     */
/* -------------------------------------------------------------------------- */

/** Options of `openmatel index`. */
export interface IndexOptions {
  /** Sources to index; every source by default. */
  sources?: readonly string[];
  /** Home directory to discover sessions in. */
  home?: string;
  /** Data directory; the database is `<dataDir>/openmatel.db`. */
  dataDir?: string;
}

/** Options of `openmatel sessions`. */
export interface SessionsOptions {
  source?: string;
  errors?: boolean;
  q?: string;
  limit?: number;
  json?: boolean;
  /**
   * Data directory override, for embedding and tests. The command line uses
   * `$OPENMATEL_HOME` / `~/.openmatel`; there is deliberately no `sessions
   * --data` flag in milestone 1.
   */
  dataDir?: string;
}

/** Options of `openmatel show`. */
export interface ShowOptions {
  json?: boolean;
  /** Data directory override, for embedding and tests. */
  dataDir?: string;
}

/** Options of `openmatel sources`. */
export interface SourcesOptions {
  home?: string;
}

/** Options of `openmatel serve` and of the no-argument default command. */
export interface ServeOptions {
  /** First port to try; the next ten ports are used when it is busy. */
  port?: number;
  /** Interface to bind. */
  host?: string;
  /** Open the browser (default `true`). */
  open?: boolean;
  /** Index local sessions before serving (default `true`). */
  index?: boolean;
  /** Data directory override. */
  dataDir?: string;
  /** Home directory to scan when indexing. */
  home?: string;
  /** Sources to index when indexing. */
  sources?: readonly string[];
  /**
   * Milliseconds between incremental re-index passes while serving. `0`
   * disables the periodic pass. Default: 3000.
   */
  watchInterval?: number;
}

/* -------------------------------------------------------------------------- */
/* Results                                                                     */
/* -------------------------------------------------------------------------- */

/** What one source contributed to an index run. */
export interface SourceIndexStats {
  source: string;
  filesSeen: number;
  indexed: number;
  skipped: number;
  failed: number;
  sessions: number;
  events: number;
  elapsedMs: number;
  /** Why the source was skipped as a whole, when it was. */
  note?: string;
}

/** Result of one `index` run. */
export interface IndexResult {
  home: string;
  dataDir: string;
  dbPath: string;
  sources: SourceIndexStats[];
  filesSeen: number;
  indexed: number;
  skipped: number;
  failed: number;
  sessions: number;
  events: number;
  elapsedMs: number;
}

/** Detection result of one source. */
export interface SourceDetection {
  source: string;
  files: number;
  status: "found" | "not found" | "error";
}

/* -------------------------------------------------------------------------- */
/* Paths and environment                                                       */
/* -------------------------------------------------------------------------- */

/** The home directory used when `--home` is not given. */
export function resolveHome(home?: string): string {
  return path.resolve(home !== undefined && home !== "" ? home : os.homedir());
}

/** The data directory used when `--data` is not given. */
export function resolveDataDir(
  dataDir?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (dataDir !== undefined && dataDir !== "") return path.resolve(dataDir);
  const fromEnv = env.OPENMATEL_HOME;
  if (fromEnv !== undefined && fromEnv !== "") return path.resolve(fromEnv);
  return path.resolve(path.join(os.homedir(), ".openmatel"));
}

/** `true` when this Node.js can decompress dsh's zstd session logs. */
export function hasZstdSupport(): boolean {
  return typeof (zlib as { zstdDecompressSync?: unknown }).zstdDecompressSync === "function";
}

/** Read an error message without assuming an Error. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/* -------------------------------------------------------------------------- */
/* Argument parsing                                                            */
/* -------------------------------------------------------------------------- */

interface LongOption {
  name: string;
  inlineValue?: string;
}

/** Split `--name=value` into its two parts. */
function parseLongOption(argument: string): LongOption {
  const equals = argument.indexOf("=");
  if (equals === -1) return { name: argument.slice(2) };
  return { name: argument.slice(2, equals), inlineValue: argument.slice(equals + 1) };
}

/** Read the value of an option, from `--name=value` or the next argument. */
function optionValue(
  args: readonly string[],
  index: number,
  option: LongOption,
): { value: string; next: number } {
  if (option.inlineValue !== undefined) {
    if (option.inlineValue === "") throw new UsageError(`--${option.name} requires a value`);
    return { value: option.inlineValue, next: index };
  }
  const next = args[index + 1];
  if (next === undefined || next.startsWith("--")) {
    throw new UsageError(`--${option.name} requires a value`);
  }
  return { value: next, next: index + 1 };
}

/** Parse a comma separated list of source names. */
export function parseSources(value: string): SourceName[] {
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (parts.length === 0) throw new UsageError("--sources requires at least one source");

  if (parts.length === 1 && parts[0] === "all") return [...ALL_SOURCES];

  const selected: SourceName[] = [];
  for (const part of parts) {
    if (!(ALL_SOURCES as readonly string[]).includes(part)) {
      throw new UsageError(
        `unknown source "${part}" (known: ${ALL_SOURCES.join(", ")})`,
      );
    }
    if (!selected.includes(part as SourceName)) selected.push(part as SourceName);
  }
  return selected;
}

/** Parse the arguments of `index`. */
export function parseIndexArgs(args: readonly string[]): IndexOptions {
  const options: IndexOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) {
      throw new UsageError(`unexpected argument "${argument}" for index`);
    }
    const option = parseLongOption(argument);
    switch (option.name) {
      case "sources": {
        const { value, next } = optionValue(args, index, option);
        options.sources = parseSources(value);
        index = next;
        break;
      }
      case "home": {
        const { value, next } = optionValue(args, index, option);
        options.home = value;
        index = next;
        break;
      }
      case "data": {
        const { value, next } = optionValue(args, index, option);
        options.dataDir = value;
        index = next;
        break;
      }
      default:
        throw new UsageError(`unknown option "--${option.name}" for index`);
    }
  }
  return options;
}

/** Parse the arguments of `sessions`. */
export function parseSessionsArgs(args: readonly string[]): SessionsOptions {
  const options: SessionsOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) {
      throw new UsageError(`unexpected argument "${argument}" for sessions`);
    }
    const option = parseLongOption(argument);
    switch (option.name) {
      case "source": {
        const { value, next } = optionValue(args, index, option);
        if (!(ALL_SOURCES as readonly string[]).includes(value)) {
          throw new UsageError(
            `unknown source "${value}" (known: ${ALL_SOURCES.join(", ")})`,
          );
        }
        options.source = value;
        index = next;
        break;
      }
      case "q": {
        const { value, next } = optionValue(args, index, option);
        options.q = value;
        index = next;
        break;
      }
      case "limit": {
        const { value, next } = optionValue(args, index, option);
        const limit = Number(value);
        if (!Number.isInteger(limit) || limit <= 0) {
          throw new UsageError(`--limit must be a positive integer (got "${value}")`);
        }
        options.limit = limit;
        index = next;
        break;
      }
      case "errors":
        if (option.inlineValue !== undefined) {
          throw new UsageError("--errors does not take a value");
        }
        options.errors = true;
        break;
      case "json":
        if (option.inlineValue !== undefined) {
          throw new UsageError("--json does not take a value");
        }
        options.json = true;
        break;
      default:
        throw new UsageError(`unknown option "--${option.name}" for sessions`);
    }
  }
  return options;
}

/** Parse the arguments of `show`, returning the session prefix and options. */
export function parseShowArgs(args: readonly string[]): {
  prefix: string;
  options: ShowOptions;
} {
  let prefix: string | undefined;
  const options: ShowOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      options.json = true;
      continue;
    }
    if (argument.startsWith("--")) {
      const option = parseLongOption(argument);
      throw new UsageError(`unknown option "--${option.name}" for show`);
    }
    if (prefix !== undefined) {
      throw new UsageError(`unexpected argument "${argument}" for show`);
    }
    prefix = argument;
  }
  if (prefix === undefined || prefix === "") {
    throw new UsageError("show requires a session id or id prefix");
  }
  return { prefix, options };
}

/** Parse the arguments of `sources`. */
export function parseSourcesArgs(args: readonly string[]): SourcesOptions {
  const options: SourcesOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) {
      throw new UsageError(`unexpected argument "${argument}" for sources`);
    }
    const option = parseLongOption(argument);
    if (option.name === "home") {
      const { value, next } = optionValue(args, index, option);
      options.home = value;
      index = next;
      continue;
    }
    throw new UsageError(`unknown option "--${option.name}" for sources`);
  }
  return options;
}

/** Parse the arguments of `serve`. */
export function parseServeArgs(args: readonly string[]): ServeOptions {
  const options: ServeOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) {
      throw new UsageError(`unexpected argument "${argument}" for serve`);
    }
    const option = parseLongOption(argument);
    switch (option.name) {
      case "port": {
        const { value, next } = optionValue(args, index, option);
        const port = Number(value);
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
          throw new UsageError(`--port must be an integer between 0 and 65535 (got "${value}")`);
        }
        options.port = port;
        index = next;
        break;
      }
      case "host": {
        const { value, next } = optionValue(args, index, option);
        if (value.trim() === "") throw new UsageError("--host must not be empty");
        options.host = value;
        index = next;
        break;
      }
      case "no-open":
        if (option.inlineValue !== undefined) {
          throw new UsageError("--no-open does not take a value");
        }
        options.open = false;
        break;
      case "no-index":
        if (option.inlineValue !== undefined) {
          throw new UsageError("--no-index does not take a value");
        }
        options.index = false;
        break;
      case "watch-interval": {
        const { value, next } = optionValue(args, index, option);
        const interval = Number(value);
        if (!Number.isInteger(interval) || interval < 0) {
          throw new UsageError(
            `--watch-interval must be a non-negative integer in milliseconds (got "${value}")`,
          );
        }
        options.watchInterval = interval;
        index = next;
        break;
      }
      case "data": {
        const { value, next } = optionValue(args, index, option);
        options.dataDir = value;
        index = next;
        break;
      }
      case "home": {
        const { value, next } = optionValue(args, index, option);
        options.home = value;
        index = next;
        break;
      }
      case "sources": {
        const { value, next } = optionValue(args, index, option);
        options.sources = parseSources(value);
        index = next;
        break;
      }
      default:
        throw new UsageError(`unknown option "--${option.name}" for serve`);
    }
  }
  return options;
}

/* -------------------------------------------------------------------------- */
/* index                                                                       */
/* -------------------------------------------------------------------------- */

/** One source to index. */
const sourceOf = (name: string): LocalSource => {
  const source = localSources[name];
  if (source === undefined) throw new UsageError(`unknown source "${name}"`);
  return source;
};

/**
 * Discover and index the local sessions.
 *
 * A file is skipped when its cursor (`size:mtimeMs`) is unchanged. A changed
 * file is read and normalized completely again; the deterministic ids make
 * the writes idempotent. An error in one file is reported and the run
 * continues.
 */
export async function runIndex(
  options: IndexOptions = {},
  io: CommandIO = processIO,
): Promise<IndexResult> {
  const started = Date.now();
  const home = resolveHome(options.home);
  const dataDir = resolveDataDir(options.dataDir);
  const names = options.sources !== undefined ? [...options.sources] : [...ALL_SOURCES];

  const store = await openStore(dataDir);
  const bus = createInprocBus({ maxAttempts: 5, retryDelayMs: 50 });
  const pipeline = createPipeline({
    bus,
    sinks: [store.sink],
    ctx: { project_id: "local", capture_level: "full" },
  });

  const results: SourceIndexStats[] = [];

  try {
    const available: LocalSource[] = [];
    const skippedSources = new Map<string, SourceIndexStats>();

    for (const name of names) {
      if (name === "dsh" && !hasZstdSupport()) {
        err(
          io,
          "warning: dsh requires Node.js zstd support (node:zlib.zstdDecompressSync); skipping dsh",
        );
        skippedSources.set(name, {
          source: name,
          filesSeen: 0,
          indexed: 0,
          skipped: 0,
          failed: 0,
          sessions: 0,
          events: 0,
          elapsedMs: 0,
          note: "zstd unavailable",
        });
        continue;
      }
      available.push(sourceOf(name));
    }

    const run: LocalIndexResult = await runLocalIndex({
      home,
      sources: available,
      store,
      cursorStore: store,
      pipeline,
      onError: (error, context) => {
        if (context.stage === "discover") {
          err(io, `error: ${context.source}: discovery failed: ${messageOf(error)}`);
          return;
        }
        const where = context.file !== undefined ? `${context.file.path}: ` : "";
        err(io, `error: ${context.source}: ${where}${messageOf(error)}`);
      },
    });

    // Keep the result in the order the user selected, including sources that
    // were skipped as a whole (dsh without zstd support).
    for (const name of names) {
      const skipped = skippedSources.get(name);
      if (skipped !== undefined) {
        results.push(skipped);
        continue;
      }
      const stats = run.sources.find((source: LocalIndexSourceStats) => source.source === name);
      if (stats !== undefined) results.push(stats);
    }
  } finally {
    await pipeline.drain().catch(() => {});
    pipeline.close();
    await bus.close();
    await store.close();
  }

  const result: IndexResult = {
    home,
    dataDir,
    dbPath: databasePath(dataDir),
    sources: results,
    filesSeen: results.reduce((total, source) => total + source.filesSeen, 0),
    indexed: results.reduce((total, source) => total + source.indexed, 0),
    skipped: results.reduce((total, source) => total + source.skipped, 0),
    failed: results.reduce((total, source) => total + source.failed, 0),
    sessions: results.reduce((total, source) => total + source.sessions, 0),
    events: results.reduce((total, source) => total + source.events, 0),
    elapsedMs: Date.now() - started,
  };

  const rows = results.map((source) => [
    source.source,
    String(source.filesSeen),
    String(source.indexed),
    String(source.skipped),
    String(source.failed),
    String(source.sessions),
    String(source.events),
    String(source.elapsedMs),
  ]);
  rows.push([
    "TOTAL",
    String(result.filesSeen),
    String(result.indexed),
    String(result.skipped),
    String(result.failed),
    String(result.sessions),
    String(result.events),
    String(result.elapsedMs),
  ]);

  out(io, `indexed into ${result.dbPath}`);
  out(
    io,
    renderTable(
      ["SOURCE", "FILES SEEN", "INDEXED", "SKIPPED", "FAILED", "SESSIONS", "EVENTS", "ELAPSED MS"],
      rows,
      ["left", "right", "right", "right", "right", "right", "right", "right"],
    ),
  );
  return result;
}

/* -------------------------------------------------------------------------- */
/* sessions                                                                    */
/* -------------------------------------------------------------------------- */

/** List sessions from the store, newest first. */
export async function runSessions(
  options: SessionsOptions = {},
  io: CommandIO = processIO,
): Promise<SessionSummary[]> {
  const dataDir = resolveDataDir(options.dataDir);
  const store = await openStore(dataDir);
  let sessions: SessionSummary[];
  try {
    const page = await store.query.listSessions({
      ...(options.source !== undefined ? { source: options.source } : {}),
      ...(options.errors === true ? { has_error: true } : {}),
      ...(options.q !== undefined && options.q !== "" ? { text: options.q } : {}),
      limit: options.limit !== undefined ? options.limit : 20,
    });
    sessions = page.items;
  } finally {
    await store.close();
  }

  if (options.json === true) {
    for (const session of sessions) out(io, JSON.stringify(session));
    return sessions;
  }

  const rows = sessions.map((session) => [
    formatLocalTimestamp(session.started_at),
    display(session.source ?? session.harness),
    session.title !== null && session.title !== "" ? truncateText(session.title, 50) : "—",
    String(session.turn_count),
    String(session.step_count),
    String(session.tool_call_count),
    String(session.tool_error_count),
    formatTokens(session.usage.total.input_tokens),
    formatTokens(session.usage.total.output_tokens),
    formatCoverage(session.usage.coverage),
    shortSessionId(session.session_id),
  ]);

  out(
    io,
    renderTable(
      [
        "STARTED",
        "SOURCE",
        "TITLE",
        "TURNS",
        "STEPS",
        "TOOL CALLS",
        "TOOL ERRORS",
        "TOKENS IN",
        "TOKENS OUT",
        "COVERAGE",
        "SESSION",
      ],
      rows,
      [
        "left",
        "left",
        "left",
        "right",
        "right",
        "right",
        "right",
        "right",
        "right",
        "right",
        "left",
      ],
    ),
  );
  return sessions;
}

/* -------------------------------------------------------------------------- */
/* show                                                                        */
/* -------------------------------------------------------------------------- */

/** Find the one session whose id starts with `prefix`. */
async function resolveSession(
  prefix: string,
  query: {
    listSessions: (q: {
      limit?: number;
    }) => Promise<{ items: SessionSummary[] }>;
    getSession: (id: string) => Promise<SessionDetail | null>;
  },
): Promise<SessionDetail> {
  const page = await query.listSessions({});
  const matches = page.items.filter((session) => session.session_id.startsWith(prefix));
  if (matches.length === 0) throw new UsageError(`no session matches prefix "${prefix}"`);
  if (matches.length > 1) {
    const candidates = matches
      .slice(0, 5)
      .map((session) => session.session_id)
      .join(", ");
    throw new UsageError(
      `session prefix "${prefix}" is ambiguous (${matches.length} matches: ${candidates}${matches.length > 5 ? ", …" : ""})`,
    );
  }
  const detail = await query.getSession(matches[0].session_id);
  if (detail === null) throw new UsageError(`session "${matches[0].session_id}" not found`);
  return detail;
}

/** The label of a step: tool name, command, path, … */
function stepLabel(step: StepNode): string {
  const attrs = step.attrs;
  switch (step.kind) {
    case "tool.call":
      return typeof attrs.tool_name === "string" ? attrs.tool_name : display(step.title);
    case "env.command":
      return typeof attrs.command === "string" ? attrs.command : display(step.title);
    case "env.file_edit":
      return typeof attrs.path === "string" ? attrs.path : display(step.title);
    case "llm.call":
      return typeof attrs.model === "string" ? attrs.model : display(step.title);
    case "subagent.spawn":
    case "handoff":
      return typeof attrs.agent_name === "string" ? attrs.agent_name : display(step.title);
    default:
      return display(step.title);
  }
}

/** The duration of a step, from its attrs or from its two timestamps. */
function stepDuration(step: StepNode): number | null {
  const reported = step.attrs.duration_ms;
  if (typeof reported === "number" && Number.isFinite(reported)) return reported;
  return durationBetween(step.ts, step.end_ts);
}

/** Render one step and its children. */
function renderSteps(
  steps: readonly StepNode[],
  depth: number,
  lines: string[],
): void {
  for (const step of steps) {
    const indent = "  ".repeat(depth);
    const label = stepLabel(step);
    lines.push(
      `${indent}${formatLocalTime(step.ts)}  ${step.kind.padEnd(18)}  ${truncateText(label, 100)}  ` +
        `${step.status ?? "—"}  ${formatDurationMs(stepDuration(step))}`,
    );
    renderSteps(step.children, depth + 1, lines);
  }
}

/** Render a turn header and its steps. */
function renderTurn(turn: TurnNode, index: number, lines: string[]): void {
  const status = turn.status !== undefined ? `  ${turn.status}` : "";
  const timestamp = formatLocalTimestamp(turn.ts);
  lines.push("");
  lines.push(`Turn ${index + 1}  ${turn.turn_id}  ${timestamp}${status}`);
  if (turn.steps.length === 0) {
    lines.push("  (no steps)");
    return;
  }
  renderSteps(turn.steps, 1, lines);
}

/** Show one session and its step timeline. */
export async function runShow(
  sessionPrefix: string,
  options: ShowOptions = {},
  io: CommandIO = processIO,
): Promise<SessionDetail> {
  const dataDir = resolveDataDir(options.dataDir);
  const store = await openStore(dataDir);
  let detail: SessionDetail;
  try {
    detail = await resolveSession(sessionPrefix, store.query);
  } finally {
    await store.close();
  }

  if (options.json === true) {
    out(io, JSON.stringify(detail, null, 2));
    return detail;
  }

  const summary = detail.summary;
  const lines: string[] = [
    `Session      ${summary.session_id}`,
    `Source       ${display(summary.source)}`,
    `Harness      ${display(summary.harness)}`,
    `Model        ${display(summary.model)}`,
    `Title        ${display(summary.title)}`,
    `Started      ${formatLocalTimestamp(summary.started_at)}`,
    `Ended        ${formatLocalTimestamp(summary.ended_at)}`,
    `Cwd          ${display(summary.cwd)}`,
    `Turns        ${summary.turn_count}`,
    `Steps        ${summary.step_count}`,
    `Tool calls   ${summary.tool_call_count}`,
    `Tool errors  ${summary.tool_error_count}`,
    `Tokens       ${formatTokens(summary.usage.total.input_tokens)} in / ` +
      `${formatTokens(summary.usage.total.output_tokens)} out  ` +
      `(${formatCoverage(summary.usage.coverage)} coverage)`,
    `Status       ${summary.status}`,
  ];
  lines.push("");
  lines.push("Timeline");
  for (const [index, turn] of (detail.turns ?? []).entries()) renderTurn(turn, index, lines);
  out(io, lines.join("\n"));
  return detail;
}

/* -------------------------------------------------------------------------- */
/* sources                                                                     */
/* -------------------------------------------------------------------------- */

/** Detect the local sources and the number of session files each one has. */
export async function runSources(
  options: SourcesOptions = {},
  io: CommandIO = processIO,
): Promise<SourceDetection[]> {
  const home = resolveHome(options.home);
  const detections: SourceDetection[] = [];

  for (const [name, source] of Object.entries(localSources)) {
    try {
      const files = await source.discover(home);
      detections.push({
        source: name,
        files: files.length,
        status: files.length > 0 ? "found" : "not found",
      });
    } catch (error) {
      err(io, `error: ${name}: discovery failed: ${messageOf(error)}`);
      detections.push({ source: name, files: 0, status: "error" });
    }
  }

  out(
    io,
    renderTable(
      ["SOURCE", "FILES", "STATUS"],
      detections.map((detection) => [
        detection.source,
        String(detection.files),
        detection.status,
      ]),
      ["left", "right", "left"],
    ),
  );
  return detections;
}

/* -------------------------------------------------------------------------- */
/* serve                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Index (unless disabled) and serve the local web UI.
 *
 * The URL is printed before the browser is opened, because the token in it is
 * the only way into the UI. Ctrl-C is handled by the server handle.
 */
export async function runServe(
  options: ServeOptions = {},
  io: CommandIO = processIO,
): Promise<ServeHandle> {
  const dataDir = resolveDataDir(options.dataDir);
  const indexOptions: IndexOptions = {
    ...(options.home !== undefined ? { home: options.home } : {}),
    ...(options.sources !== undefined ? { sources: options.sources } : {}),
    dataDir,
  };

  if (options.index !== false) {
    await runIndex(indexOptions, io);
  }

  const watchInterval = options.watchInterval ?? DEFAULT_WATCH_INTERVAL_MS;
  let watch: IndexWatchOptions | undefined;
  if (options.index !== false && watchInterval > 0) {
    const watchOutput = createWatchIO(io);
    watch = {
      intervalMs: watchInterval,
      run: () => runIndex(indexOptions, watchOutput),
      onError: (error) => err(watchOutput, `error: watch: ${messageOf(error)}`),
    };
  }

  const handle = await startServe({
    dataDir,
    ...(options.host !== undefined ? { host: options.host } : {}),
    ...(options.port !== undefined ? { port: options.port } : {}),
    ...(watch !== undefined ? { watch } : {}),
    open: false,
  });

  out(io, `OpenMaTel ${VERSION} — local mode`);
  out(io, `  ${handle.url}`);
  out(io, `  listening on ${handle.host}:${handle.port}; press Ctrl-C to stop`);

  if (options.open !== false) openBrowser(handle.url);
  return handle;
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

/** The text of `openmatel --help`. */
export const HELP_TEXT = `openmatel ${VERSION} — local agent observability, zero services

Usage:
  openmatel                              Index, then serve the web UI and open it
  openmatel serve [options]              Index (unless --no-index) and serve the web UI
  openmatel index [options]              Discover and index local sessions
  openmatel sessions [options]           List indexed sessions
  openmatel show <session-id-prefix>     Show one session and its step timeline
  openmatel sources [options]            Detect local sources and count files
  openmatel --version                    Print the version
  openmatel --help                       Print this help

index options:
  --sources <list>   Comma separated: ${ALL_SOURCES.join(", ")} (default: all)
  --home <dir>       Home directory to scan (default: ~)
  --data <dir>       Data directory (default: $OPENMATEL_HOME or ~/.openmatel)

sessions options:
  --source <name>    Only sessions of one source
  --errors           Only sessions with tool errors
  --q <text>         Search titles, working directories and content
  --limit <n>        Maximum number of sessions (default: 20)
  --json             Print one summary per line as JSON

show options:
  --json             Print the session detail as JSON

sources options:
  --home <dir>       Home directory to scan (default: ~)

serve options:
  --port <n>         First port to try (default: 4319; the next 10 are tried when busy)
  --host <addr>      Interface to bind (default: 127.0.0.1)
  --no-open          Do not open the browser
  --no-index         Serve the existing database without indexing first
  --watch-interval <ms>
                     Re-index changed files every <ms> while serving
                     (default: 3000; 0 disables periodic re-indexing)
  --data <dir>       Data directory (default: $OPENMATEL_HOME or ~/.openmatel)
  --home <dir>       Home directory to scan when indexing (default: ~)
  --sources <list>   Sources to index: ${ALL_SOURCES.join(", ")} (default: all)

Environment:
  OPENMATEL_HOME     Default data directory
`;

/**
 * Run the CLI.
 *
 * @param argv - the arguments after the executable name.
 * @returns the process exit code (0 on success, 1 on a usage/runtime error).
 */
export async function runCli(
  argv: readonly string[] = process.argv.slice(2),
  io: CommandIO = processIO,
): Promise<number> {
  try {
    const [command, ...rest] = argv;

    if (command === undefined) {
      await runServe({}, io);
      return 0;
    }

    if (command === "--help" || command === "-h" || command === "help") {
      out(io, HELP_TEXT);
      return 0;
    }
    if (command === "--version" || command === "-v") {
      out(io, VERSION);
      return 0;
    }
    if (command === "--json") {
      throw new UsageError("--json is an option of a command, not a global option");
    }
    if (command.startsWith("-")) {
      // Bare options (e.g. `openmatel --no-open --port 5000`) apply to the default serve command.
      await runServe(parseServeArgs(argv), io);
      return 0;
    }

    switch (command) {
      case "index":
        if (rest.includes("--help") || rest.includes("-h")) {
          out(io, HELP_TEXT);
          return 0;
        }
        await runIndex(parseIndexArgs(rest), io);
        return 0;
      case "serve":
        if (rest.includes("--help") || rest.includes("-h")) {
          out(io, HELP_TEXT);
          return 0;
        }
        await runServe(parseServeArgs(rest), io);
        return 0;
      case "sessions":
        if (rest.includes("--help") || rest.includes("-h")) {
          out(io, HELP_TEXT);
          return 0;
        }
        await runSessions(parseSessionsArgs(rest), io);
        return 0;
      case "show": {
        if (rest.includes("--help") || rest.includes("-h")) {
          out(io, HELP_TEXT);
          return 0;
        }
        const { prefix, options } = parseShowArgs(rest);
        await runShow(prefix, options, io);
        return 0;
      }
      case "sources":
        if (rest.includes("--help") || rest.includes("-h")) {
          out(io, HELP_TEXT);
          return 0;
        }
        await runSources(parseSourcesArgs(rest), io);
        return 0;
      default:
        throw new UsageError(`unknown command "${command}" (try --help)`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      err(io, `error: ${error.message}`);
    } else {
      err(io, `error: ${messageOf(error)}`);
      if (process.env.OPENMATEL_DEBUG === "1" && error instanceof Error && error.stack) {
        err(io, error.stack);
      }
    }
    return 1;
  }
}
