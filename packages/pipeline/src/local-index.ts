/**
 * Drive the local pull sources through a pipeline.
 *
 * The CLI's `index` command is exactly this loop: discover the session files
 * of every source, skip the files whose `size:mtimeMs` cursor is unchanged,
 * read and normalize the changed ones, ingest the resulting batch, and only
 * advance the file cursor once that batch was written.
 *
 * The module deliberately has no dependency on `@openmatel/source-local` or
 * `@openmatel/store-sqlite`: sources, the pipeline and the cursor store are
 * injected, so `packages/pipeline` only depends on `@openmatel/core`.
 */

import type { AgentEvent, RawRecord, Sink } from "@openmatel/core";

/** The file shape the local sources produce (`SessionFile` in source-local). */
export interface LocalIndexFile {
  /** Source the file belongs to. */
  source: string;
  /** Absolute path of the file. */
  path: string;
  /** Size in bytes, part of the incremental cursor. */
  size: number;
  /** Modification time in milliseconds, part of the incremental cursor. */
  mtimeMs: number;
  /** Harness-specific session id, when the source reports one. */
  sourceSessionId?: string;
}

/** One local source module, injected to avoid a core ⇄ adapter dependency. */
export interface LocalIndexSource {
  /** Name of the source, e.g. `"claude-code"`. */
  source: string;
  /** Find the session files of the source below a home directory. */
  discover(home?: string): Promise<readonly LocalIndexFile[]>;
  /** Parse one session file into raw records. */
  readRecords(file: LocalIndexFile): Promise<RawRecord[]>;
  /** Normalize the records of one file into canonical events. */
  normalizeFile(file: LocalIndexFile, records: RawRecord[]): AgentEvent[];
}

/** The part of a store the driver needs to persist cursors. */
export interface CursorStore {
  /** Read a cursor back; `null`/`undefined` means "never written". */
  getCursor(key: string): string | null | undefined | Promise<string | null | undefined>;
  /** Persist a cursor. */
  setCursor(key: string, value: string): void | Promise<void>;
}

/** A store that exposes a persistent cursor table. */
export interface LocalIndexStore extends CursorStore {
  /** The write side, when the caller wants to pass it along. */
  sink?: Sink;
}

/** The subset of {@link import("./pipeline.js").Pipeline} the driver uses. */
export interface LocalIndexPipeline {
  /** Publish the events of one file. */
  ingest(events: AgentEvent[]): Promise<void>;
  /** Wait until the published batch was written or dead-lettered. */
  drain(): Promise<void>;
  /** Live counters, used to detect a dead-lettered batch. */
  stats?: {
    deadLettered: number;
  };
}

/** Where a failure happened in the driver. */
export type LocalIndexStage = "discover" | "read" | "write";

/** Context handed to {@link RunLocalIndexOptions.onError}. */
export interface LocalIndexErrorContext {
  /** Name of the source that failed. */
  source: string;
  /** Which step failed. */
  stage: LocalIndexStage;
  /** The file that failed, when the failure was file-specific. */
  file?: LocalIndexFile;
}

/** The source modules to poll, as a list or a name → source record. */
export type LocalIndexSources =
  | readonly LocalIndexSource[]
  | Record<string, LocalIndexSource>;

/** Options of {@link runLocalIndex}. */
export interface RunLocalIndexOptions {
  /** The source modules to poll. */
  sources: LocalIndexSources;
  /** Home directory the sources discover below. Default: the source default. */
  home?: string;
  /** The pipeline that normalizes and writes the events. */
  pipeline: LocalIndexPipeline;
  /**
   * Where the file cursors live. When omitted, the store is used if it has
   * cursor methods.
   */
  cursorStore?: CursorStore;
  /**
   * The store of the run. It is accepted so a composition root can pass its
   * SQLite store unchanged; the pipeline already holds the sink.
   */
  store?: LocalIndexStore;
  /** Called for every discovery/read/write failure. */
  onError?: (error: unknown, context: LocalIndexErrorContext) => void;
}

/** What one source contributed to an index run. */
export interface LocalIndexSourceStats {
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

/** Result of one {@link runLocalIndex} call. */
export interface LocalIndexResult {
  home?: string;
  sources: LocalIndexSourceStats[];
  filesSeen: number;
  indexed: number;
  skipped: number;
  failed: number;
  sessions: number;
  events: number;
  elapsedMs: number;
}

/** Use a store as cursor store when it exposes the cursor methods. */
const cursorStoreOf = (options: RunLocalIndexOptions): CursorStore | undefined => {
  if (options.cursorStore !== undefined) return options.cursorStore;
  const store = options.store;
  if (
    store !== undefined &&
    typeof store.getCursor === "function" &&
    typeof store.setCursor === "function"
  ) {
    return store;
  }
  return undefined;
};

/**
 * Discover, read, normalize and ingest the local session files.
 *
 * A file's cursor is written **after** `pipeline.drain()` confirmed the batch
 * settled. If the process dies before that write, the old cursor is still in
 * the database and the file is read again on the next run; the deterministic
 * event ids and the idempotent sinks make that replay harmless.
 */
export async function runLocalIndex(options: RunLocalIndexOptions): Promise<LocalIndexResult> {
  const started = Date.now();
  const cursorStore = cursorStoreOf(options);
  const sources: LocalIndexSourceStats[] = [];
  const sourceList: readonly LocalIndexSource[] = Array.isArray(options.sources)
    ? options.sources
    : Object.values(options.sources);

  for (const source of sourceList) {
    const sourceStarted = Date.now();
    const name = source.source;
    const stats: LocalIndexSourceStats = {
      source: name,
      filesSeen: 0,
      indexed: 0,
      skipped: 0,
      failed: 0,
      sessions: 0,
      events: 0,
      elapsedMs: 0,
    };
    const sessionIds = new Set<string>();

    let files: readonly LocalIndexFile[];
    try {
      files = await source.discover(options.home);
    } catch (error) {
      stats.failed += 1;
      options.onError?.(error, { source: name, stage: "discover" });
      stats.elapsedMs = Date.now() - sourceStarted;
      sources.push(stats);
      continue;
    }

    stats.filesSeen = files.length;

    for (const file of files) {
      const cursorKey = `file:${file.path}`;
      const cursor = `${file.size}:${file.mtimeMs}`;
      const stored = cursorStore !== undefined ? await cursorStore.getCursor(cursorKey) : null;

      if (stored === cursor) {
        stats.skipped += 1;
        continue;
      }

      try {
        const records = await source.readRecords(file);
        const events = source.normalizeFile(file, records);
        const deadLetteredBefore = options.pipeline.stats?.deadLettered ?? 0;

        await options.pipeline.ingest(events);
        await options.pipeline.drain();

        const deadLetteredAfter = options.pipeline.stats?.deadLettered ?? 0;
        if (deadLetteredAfter > deadLetteredBefore) {
          throw new Error(
            `pipeline dead-lettered the batch for ${file.path} (${deadLetteredAfter - deadLetteredBefore} event(s))`,
          );
        }

        // The write succeeded: only now may the file be skipped next time.
        if (cursorStore !== undefined) await cursorStore.setCursor(cursorKey, cursor);

        stats.indexed += 1;
        stats.events += events.length;
        for (const event of events) sessionIds.add(event.session_id);
      } catch (error) {
        stats.failed += 1;
        options.onError?.(error, { source: name, stage: "write", file });
      }
    }

    stats.sessions = sessionIds.size;
    stats.elapsedMs = Date.now() - sourceStarted;
    sources.push(stats);
  }

  return {
    ...(options.home !== undefined ? { home: options.home } : {}),
    sources,
    filesSeen: sources.reduce((total, source) => total + source.filesSeen, 0),
    indexed: sources.reduce((total, source) => total + source.indexed, 0),
    skipped: sources.reduce((total, source) => total + source.skipped, 0),
    failed: sources.reduce((total, source) => total + source.failed, 0),
    sessions: sources.reduce((total, source) => total + source.sessions, 0),
    events: sources.reduce((total, source) => total + source.events, 0),
    elapsedMs: Date.now() - started,
  };
}
