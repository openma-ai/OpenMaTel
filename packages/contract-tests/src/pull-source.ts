/**
 * Pull Source contract suite.
 *
 * A pull source reads local files: Claude Code, Codex, dsh, pi, oma. The
 * suite drives one against a temporary directory and checks the four
 * properties a file connector needs (§3.5):
 *
 * - **existing files** — the records of a file that is already there are
 *   emitted when the source starts;
 * - **appends** — lines appended after the start are emitted as well, without
 *   restarting the source;
 * - **checkpoints** — resuming from a checkpoint does not re-emit the records
 *   that were already read. A source that re-emits them is tolerated *only*
 *   when it re-emits the very same records, so the derived event ids stay
 *   stable and the idempotent sink can collapse them;
 * - **rotation** — a file that was truncated or rewritten is read again from
 *   the start.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { RawRecord, Source, SourceCursor } from "@openmatel/core";

import { sleep, waitUntil } from "./support.js";

/**
 * Writes the records the source has to read.
 *
 * @param dir - the directory handed to the source factory.
 * @param lines - the lines to write, one record per line.
 * @param mode - `"overwrite"` replaces the file, `"append"` adds to it.
 */
export type PullSourceWriter = (
  dir: string,
  lines: string[],
  mode?: "append" | "overwrite",
) => void | Promise<void>;

/** Options of {@link pullSourceContract}. */
export interface PullSourceContractOptions {
  /**
   * Builds a source that resumes from `cursor`.
   *
   * When it is given, the suite checks the strict variant of the checkpoint
   * rule: a resumed source must not emit the records it already read. When it
   * is missing, the suite only checks that a re-read produces the very same
   * records.
   */
  resume?: (dir: string, cursor: SourceCursor) => Source | Promise<Source>;
  /** How long the suite waits for a record. Default: 3000ms. */
  pollTimeoutMs?: number;
  /** How long the suite waits before it declares a resumed source quiet. Default: 500ms. */
  settleTimeoutMs?: number;
}

/**
 * Register the pull Source contract for one source.
 *
 * @param name - name of the suite, usually the source id.
 * @param factory - builds a source for a directory.
 * @param writeFile - writes records into the file the source reads.
 * @param options - optional behaviour of the suite.
 */
export function pullSourceContract(
  name: string,
  factory: (dir: string) => Source,
  writeFile: PullSourceWriter,
  options: PullSourceContractOptions = {},
): void {
  const pollTimeoutMs = options.pollTimeoutMs ?? 3000;
  const settleTimeoutMs = options.settleTimeoutMs ?? 500;

  describe(name, () => {
    it("emits the records of an existing file", async () => {
      await withTempDir(async (dir) => {
        await writeFile(dir, [line("one"), line("two")], "overwrite");

        const source = factory(dir);
        const controller = new AbortController();
        const records: RawRecord[] = [];
        const done = source.start(async (raw) => {
          records.push(raw);
        }, controller.signal);
        done.catch(() => undefined);

        try {
          await waitUntil(() => records.length >= 2, { timeoutMs: pollTimeoutMs });
          expect(markersOf(records)).toEqual(["one", "two"]);
        } finally {
          controller.abort();
        }
      });
    });

    it("emits the lines that are appended after the start", async () => {
      await withTempDir(async (dir) => {
        await writeFile(dir, [line("one")], "overwrite");

        const source = factory(dir);
        const controller = new AbortController();
        const records: RawRecord[] = [];
        const done = source.start(async (raw) => {
          records.push(raw);
        }, controller.signal);
        done.catch(() => undefined);

        try {
          await waitUntil(() => records.length >= 1, { timeoutMs: pollTimeoutMs });

          await writeFile(dir, [line("two")], "append");

          await waitUntil(() => records.length >= 2, { timeoutMs: pollTimeoutMs });
          expect(markersOf(records)).toEqual(["one", "two"]);
        } finally {
          controller.abort();
        }
      });
    });

    it("does not re-emit the records that were read before the checkpoint", async () => {
      await withTempDir(async (dir) => {
        await writeFile(dir, [line("one"), line("two")], "overwrite");

        const source = factory(dir);
        const controller = new AbortController();
        const records: RawRecord[] = [];
        const done = source.start(async (raw) => {
          records.push(raw);
        }, controller.signal);
        done.catch(() => undefined);

        let cursor: SourceCursor | undefined;
        try {
          await waitUntil(() => records.length >= 2, { timeoutMs: pollTimeoutMs });
          cursor = await source.checkpoint?.();
        } finally {
          controller.abort();
        }

        expect(cursor, "a pull source has to report a checkpoint").toBeDefined();

        const resumed = options.resume
          ? await options.resume(dir, cursor as SourceCursor)
          : factory(dir);

        const resumedController = new AbortController();
        const resumedRecords: RawRecord[] = [];
        const resumedDone = resumed.start(async (raw) => {
          resumedRecords.push(raw);
        }, resumedController.signal);
        resumedDone.catch(() => undefined);

        try {
          await settle(resumedRecords, settleTimeoutMs);

          if (options.resume) {
            expect(
              resumedRecords.length,
              "a resumed source must not emit the records it already read",
            ).toBe(0);
          } else {
            // Without a resume hook the source may read the file again — but
            // it has to be the very same records, so the event ids derived
            // from them do not change.
            const known = new Set(markersOf(records));
            for (const marker of markersOf(resumedRecords)) {
              expect(known.has(marker), `unexpected record "${marker}"`).toBe(true);
            }
          }
        } finally {
          resumedController.abort();
        }
      });
    });

    it("reads a truncated file again from the start", async () => {
      await withTempDir(async (dir) => {
        await writeFile(dir, [line("one"), line("two"), line("three")], "overwrite");

        const source = factory(dir);
        const controller = new AbortController();
        const records: RawRecord[] = [];
        const done = source.start(async (raw) => {
          records.push(raw);
        }, controller.signal);
        done.catch(() => undefined);

        let cursor: SourceCursor | undefined;
        try {
          await waitUntil(() => records.length >= 3, { timeoutMs: pollTimeoutMs });
          cursor = await source.checkpoint?.();
        } finally {
          controller.abort();
        }

        // The file is truncated and rewritten with other content.
        await writeFile(dir, [line("restart")], "overwrite");

        const resumed = options.resume
          ? await options.resume(dir, cursor as SourceCursor)
          : factory(dir);

        const resumedController = new AbortController();
        const resumedRecords: RawRecord[] = [];
        const resumedDone = resumed.start(async (raw) => {
          resumedRecords.push(raw);
        }, resumedController.signal);
        resumedDone.catch(() => undefined);

        try {
          await waitUntil(() => resumedRecords.length >= 1, { timeoutMs: pollTimeoutMs });
          expect(markersOf(resumedRecords)[0]).toBe("restart");
        } finally {
          resumedController.abort();
        }
      });
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** One record as a JSON line, tagged with a marker the suite can look for. */
const line = (marker: string): string => JSON.stringify({ marker, value: `${marker}-value` });

/** The markers of the emitted records, in the order they were emitted. */
const markersOf = (records: RawRecord[]): string[] =>
  records.map((record) => {
    const text = JSON.stringify(record?.data) ?? "";
    const match = /"marker":"([^"]+)"/.exec(text);
    return match ? match[1] : text;
  });

/** Wait until a record arrives, or until the source stays quiet. */
const settle = async (records: RawRecord[], timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (records.length > 0) return;
    await sleep(20);
  }
};

const withTempDir = async (body: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "omt-contract-"));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};
