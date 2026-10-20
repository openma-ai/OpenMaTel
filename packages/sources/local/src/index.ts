/**
 * `@openmatel/source-local` — local-file sources for four coding agents.
 *
 * Every harness is read the same way:
 *
 * 1. `discover(home)` walks the directory the harness keeps its sessions in
 *    and reports the files it finds. A harness that is not installed on this
 *    machine simply yields an empty list.
 * 2. `readRecords(file)` parses the file into raw records — one per line, with
 *    the line number and a `path#L<line>` reference.
 * 3. `normalizeFile(file, records)` turns those records into canonical agent
 *    events (`oma.agentobs.v1`).
 *
 * The single-record `Normalizer` of every harness is exported as well; it is
 * the entry point for a streaming pipeline, where the records of a session
 * arrive one by one. Use `normalizeFile` when the whole file is at hand: some
 * of the mapping — the turn a record belongs to, the result of a tool call —
 * needs the context of the session.
 *
 * ```ts
 * import { localSources } from "@openmatel/source-local";
 *
 * for (const source of Object.values(localSources)) {
 *   for (const file of await source.discover()) {
 *     const records = await source.readRecords(file);
 *     const events = source.normalizeFile(file, records);
 *   }
 * }
 * ```
 *
 * The four harnesses:
 *
 * | source | location |
 * |---|---|
 * | `claude-code` | `~/.claude/projects/<slug>/<uuid>.jsonl` |
 * | `codex` | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` |
 * | `dsh` | `~/.dsh/sessions/<slug>/session-<uuid>/session.v4.jsonl.zstd` |
 * | `pi` | `~/.pi/agent/sessions/<slug>/*.jsonl` |
 */

import type { AgentEvent, Normalizer, RawRecord } from "@openmatel/core";

import type { SessionFile } from "./common.js";

import * as claudeCode from "./claude-code.js";
import * as codex from "./codex.js";
import * as dsh from "./dsh.js";
import * as pi from "./pi.js";

export * from "./common.js";

/** The Claude Code connector. */
export * as claudeCodeSource from "./claude-code.js";
/** The Codex connector. */
export * as codexSource from "./codex.js";
/** The dsh connector. */
export * as dshSource from "./dsh.js";
/** The pi connector. */
export * as piSource from "./pi.js";

export {
  claudeCodeNormalizer,
  discover as discoverClaudeCode,
  normalizeFile as normalizeClaudeCodeFile,
  readRecords as readClaudeCodeRecords,
} from "./claude-code.js";
export {
  codexNormalizer,
  discover as discoverCodex,
  normalizeFile as normalizeCodexFile,
  readRecords as readCodexRecords,
} from "./codex.js";
export {
  dshNormalizer,
  discover as discoverDsh,
  normalizeFile as normalizeDshFile,
  readRecords as readDshRecords,
} from "./dsh.js";
export {
  discover as discoverPi,
  normalizeFile as normalizePiFile,
  piNormalizer,
  readRecords as readPiRecords,
} from "./pi.js";

/** One harness this package can read. */
export interface LocalSource {
  /** Name of the source, e.g. `"claude-code"`. */
  source: string;
  /** Find the session files of this harness below a home directory. */
  discover: (home?: string) => Promise<SessionFile[]>;
  /** Read one session file into raw records. */
  readRecords: (file: SessionFile) => Promise<RawRecord[]>;
  /** Turn the records of one session file into canonical events. */
  normalizeFile: (file: SessionFile, records: RawRecord[]) => AgentEvent[];
  /** The single-record normalizer of this harness. */
  normalizer: Normalizer;
}

/**
 * Every harness this package can read, keyed by its source name.
 *
 * The order is the order the harnesses are listed in `docs/design.md` §5.1.
 */
export const localSources: Record<string, LocalSource> = {
  "claude-code": {
    source: "claude-code",
    discover: claudeCode.discover,
    readRecords: claudeCode.readRecords,
    normalizeFile: claudeCode.normalizeFile,
    normalizer: claudeCode.claudeCodeNormalizer,
  },
  codex: {
    source: "codex",
    discover: codex.discover,
    readRecords: codex.readRecords,
    normalizeFile: codex.normalizeFile,
    normalizer: codex.codexNormalizer,
  },
  dsh: {
    source: "dsh",
    discover: dsh.discover,
    readRecords: dsh.readRecords,
    normalizeFile: dsh.normalizeFile,
    normalizer: dsh.dshNormalizer,
  },
  pi: {
    source: "pi",
    discover: pi.discover,
    readRecords: pi.readRecords,
    normalizeFile: pi.normalizeFile,
    normalizer: pi.piNormalizer,
  },
};
