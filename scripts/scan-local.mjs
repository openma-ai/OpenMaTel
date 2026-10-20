#!/usr/bin/env node
/**
 * Scan the local sessions of this machine and report what the normalizers
 * make of them.
 *
 * This is a manual verification helper: it reads the sessions of the four
 * harnesses out of `$HOME`, normalizes them and prints how many events came
 * out of it. Nothing is written anywhere — the scan only reads.
 *
 * ```sh
 * node scripts/scan-local.mjs            # the real $HOME
 * node scripts/scan-local.mjs /tmp/home  # a home directory to try
 * ```
 *
 * The package has to be built first (`pnpm build`), because the script uses
 * the compiled sources.
 */

import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, "..", "packages", "sources", "local", "dist", "index.js");

if (!existsSync(entry)) {
  console.error("The local sources are not built yet. Run `pnpm build` first.");
  process.exit(1);
}

const { localSources } = await import(pathToFileURL(entry).href);

const home = process.argv[2] ?? os.homedir();

/** The counters of one source. */
const emptyStats = () => ({
  source: "",
  sessions: 0,
  events: 0,
  toolCalls: 0,
  toolErrors: 0,
  llmCalls: 0,
  llmWithUsage: 0,
  llmWithoutUsage: 0,
  failed: 0,
});

const rows = [];

for (const [name, source] of Object.entries(localSources)) {
  const stats = emptyStats();
  stats.source = name;

  let files = [];
  try {
    files = await source.discover(home);
  } catch (error) {
    console.error(`${name}: the sessions could not be found: ${error.message}`);
    rows.push(stats);
    continue;
  }

  for (const file of files) {
    try {
      const records = await source.readRecords(file);
      const events = source.normalizeFile(file, records);

      stats.sessions += 1;
      stats.events += events.length;

      for (const event of events) {
        if (event.kind === "tool.call") {
          stats.toolCalls += 1;
          if (event.status === "error") stats.toolErrors += 1;
        }
        if (event.kind === "llm.call") {
          stats.llmCalls += 1;
          const usage = event.usage;
          if (usage !== undefined && usage !== null && usage.source !== "missing") {
            stats.llmWithUsage += 1;
          } else {
            stats.llmWithoutUsage += 1;
          }
        }
      }
    } catch (error) {
      stats.failed += 1;
      console.error(`${name}: ${path.relative(home, file.path)}: ${error.message}`);
    }
  }

  rows.push(stats);
}

/** Print one row of the table. */
const columns = [
  ["source", (row) => row.source],
  ["sessions", (row) => row.sessions],
  ["events", (row) => row.events],
  ["tool calls", (row) => row.toolCalls],
  ["tool errors", (row) => row.toolErrors],
  ["llm calls", (row) => row.llmCalls],
  ["llm w/ usage", (row) => row.llmWithUsage],
  ["llm w/o usage", (row) => row.llmWithoutUsage],
  ["failed", (row) => row.failed],
];

const widths = columns.map(([title, value]) =>
  Math.max(title.length, ...rows.map((row) => String(value(row)).length)),
);

const line = (cells) => cells.map((cell, index) => String(cell).padEnd(widths[index])).join("  ");

console.log(`\nlocal session scan of ${home}\n`);
console.log(line(columns.map(([title]) => title)));
console.log(widths.map((width) => "-".repeat(width)).join("  "));
for (const row of rows) {
  console.log(line(columns.map(([, value]) => value(row))));
}

const totals = rows.reduce(
  (sum, row) => ({
    sessions: sum.sessions + row.sessions,
    events: sum.events + row.events,
    toolCalls: sum.toolCalls + row.toolCalls,
    toolErrors: sum.toolErrors + row.toolErrors,
    llmCalls: sum.llmCalls + row.llmCalls,
    llmWithUsage: sum.llmWithUsage + row.llmWithUsage,
    llmWithoutUsage: sum.llmWithoutUsage + row.llmWithoutUsage,
    failed: sum.failed + row.failed,
  }),
  {
    sessions: 0,
    events: 0,
    toolCalls: 0,
    toolErrors: 0,
    llmCalls: 0,
    llmWithUsage: 0,
    llmWithoutUsage: 0,
    failed: 0,
  },
);

console.log(
  `\ntotal: ${totals.sessions} sessions, ${totals.events} events, ${totals.toolCalls} tool calls ` +
    `(${totals.toolErrors} errors), ${totals.llmCalls} llm calls ` +
    `(${totals.llmWithUsage} with usage, ${totals.llmWithoutUsage} without)\n`,
);
