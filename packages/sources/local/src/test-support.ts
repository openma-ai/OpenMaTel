/**
 * Test support for the local sources.
 *
 * The tests must not read the sessions of the machine they run on, so the
 * anonymized fixtures are copied into a throw-away home directory first. The
 * `discover()` of every harness is then exercised against that directory.
 */

import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentEvent, EventKind } from "@openmatel/core";

export type { SessionFile } from "./common.js";

/** The directory this file lives in. */
const here = path.dirname(fileURLToPath(import.meta.url));

/** The root of the monorepo. */
export const repoRoot = path.resolve(here, "../../../..");

/** Where the anonymized fixtures live. */
export const fixturesRoot = path.join(repoRoot, "packages", "sources", "_fixtures");

/** Where the fixture of a harness belongs inside a home directory. */
export const HOME_LAYOUT: Record<string, string[]> = {
  "claude-code": [".claude", "projects"],
  codex: [".codex", "sessions"],
  dsh: [".dsh", "sessions"],
  pi: [".pi", "agent", "sessions"],
};

/** A throw-away home directory. */
export interface TempHome {
  /** The home directory itself. */
  home: string;
  /** Remove the directory again. */
  cleanup: () => void;
}

/**
 * Copy the fixtures of the given harnesses into a fresh home directory.
 *
 * @param sources - the harnesses to install, e.g. `["dsh"]`.
 */
export function makeTempHome(sources: string[] = Object.keys(HOME_LAYOUT)): TempHome {
  const home = mkdtempSync(path.join(tmpdir(), "oma-source-local-"));

  for (const source of sources) {
    const layout = HOME_LAYOUT[source];
    if (layout === undefined) throw new Error(`unknown fixture source: ${source}`);
    cpSync(path.join(fixturesRoot, source), path.join(home, ...layout), { recursive: true });
  }

  return {
    home,
    cleanup: () => {
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** The path of a file inside a home directory. */
export function inHome(home: string, ...parts: string[]): string {
  return path.join(home, ...parts);
}

/** Every event of one kind. */
export function eventsOfKind(events: AgentEvent[], kind: EventKind): AgentEvent[] {
  return events.filter((event) => event.kind === kind);
}

/** The first event of one kind. */
export function firstEventOfKind(events: AgentEvent[], kind: EventKind): AgentEvent | undefined {
  return events.find((event) => event.kind === kind);
}

/** The number of events of one kind. */
export function countOfKind(events: AgentEvent[], kind: EventKind): number {
  return events.reduce((total, event) => (event.kind === kind ? total + 1 : total), 0);
}
