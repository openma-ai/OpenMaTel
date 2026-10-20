import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentEvent } from "@openmatel/core";

import {
  createMemoryIO,
  formatTokens,
  openStore,
  resolveUiDir,
  runIndex,
  runSessions,
  runShow,
  runSources,
  startServe,
  type IndexResult,
  type SourceIndexStats,
} from "./index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const fixturesRoot = path.join(repoRoot, "packages", "sources", "_fixtures");

/** Where the fixture of a harness belongs inside a home directory. */
const HOME_LAYOUT: Record<string, string[]> = {
  "claude-code": [".claude", "projects"],
  codex: [".codex", "sessions"],
  dsh: [".dsh", "sessions"],
  pi: [".pi", "agent", "sessions"],
};

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Create a throw-away directory. */
function tempDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "oma-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}

/** Build a home directory with the same layout `discover` expects. */
function makeTempHome(): string {
  const home = tempDirectory();
  for (const [source, layout] of Object.entries(HOME_LAYOUT)) {
    cpSync(path.join(fixturesRoot, source), path.join(home, ...layout), { recursive: true });
  }
  return home;
}

/** Index the fixture home once and return the result together with the dirs. */
async function indexedFixture(): Promise<{
  home: string;
  dataDir: string;
  result: IndexResult;
}> {
  const home = makeTempHome();
  const dataDir = tempDirectory();
  const io = createMemoryIO();
  const result = await runIndex({ home, dataDir }, io);
  return { home, dataDir, result };
}

const statsOf = (result: IndexResult, source: string): SourceIndexStats => {
  const stats = result.sources.find((entry) => entry.source === source);
  if (stats === undefined) throw new Error(`no stats for ${source}`);
  return stats;
};

describe("openmatel index", () => {
  it("indexes the four fixture sessions into SQLite", async () => {
    const { dataDir, result } = await indexedFixture();

    expect(result.indexed).toBe(4);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.sessions).toBe(4);
    expect(result.events).toBeGreaterThan(0);
    expect(result.sources.map((entry) => entry.source)).toEqual([
      "claude-code",
      "codex",
      "dsh",
      "pi",
    ]);

    for (const source of ["claude-code", "codex", "dsh", "pi"]) {
      const stats = statsOf(result, source);
      expect(stats.filesSeen).toBe(1);
      expect(stats.indexed).toBe(1);
      expect(stats.skipped).toBe(0);
      expect(stats.failed).toBe(0);
      expect(stats.sessions).toBe(1);
      expect(stats.events).toBeGreaterThan(0);
    }

    const store = await openStore(dataDir);
    try {
      const page = await store.query.listSessions({ limit: 20 });
      expect(page.items).toHaveLength(4);
      expect(new Set(page.items.map((session) => session.source))).toEqual(
        new Set(["claude-code", "codex", "dsh", "pi"]),
      );
    } finally {
      await store.close();
    }
  });

  it("skips every file as unchanged on the second run", async () => {
    const { home, dataDir } = await indexedFixture();

    const io = createMemoryIO();
    const second = await runIndex({ home, dataDir }, io);

    expect(second.filesSeen).toBe(4);
    expect(second.indexed).toBe(0);
    expect(second.skipped).toBe(4);
    expect(second.failed).toBe(0);
    expect(second.events).toBe(0);
    for (const stats of second.sources) {
      expect(stats.indexed).toBe(0);
      expect(stats.skipped).toBe(1);
      expect(stats.failed).toBe(0);
    }
    expect(io.stderrText).toBe("");
  });
});

describe("openmatel sessions", () => {
  it("prints four JSON lines with the four sources", async () => {
    const { dataDir } = await indexedFixture();
    const io = createMemoryIO();

    const sessions = await runSessions({ dataDir, limit: 20, json: true }, io);
    const lines = io.stdoutText.trim().split("\n");
    expect(lines).toHaveLength(4);
    const parsed = lines.map((line) => JSON.parse(line) as { session_id: string; source: string });
    expect(parsed.map((session) => session.session_id).sort()).toEqual(
      sessions.map((session) => session.session_id).sort(),
    );
    expect(new Set(parsed.map((session) => session.source))).toEqual(
      new Set(["claude-code", "codex", "dsh", "pi"]),
    );
  });

  it("renders a missing token count as an em dash, never as zero", async () => {
    const { dataDir } = await indexedFixture();

    // Add one session that reported no usage at all, so the assertion covers
    // the actual `sessions` table rather than only the formatter.
    const withoutUsage: AgentEvent = {
      schema: "oma.agentobs.v1",
      event_id: "ev_test_without_usage",
      project_id: "local",
      session_id: "ss_00000000000000000000000000000000",
      ts: "2026-01-01T00:00:00.000Z",
      kind: "session.start",
      attrs: { harness: { name: "test" } },
      source: { name: "test", format: "test.jsonl" },
    };
    const store = await openStore(dataDir);
    try {
      await store.sink.write([withoutUsage]);
    } finally {
      await store.close();
    }

    const io = createMemoryIO();
    const sessions = await runSessions({ dataDir, limit: 20 }, io);

    expect(formatTokens(null)).toBe("—");
    expect(formatTokens(undefined)).toBe("—");
    expect(formatTokens(0)).toBe("0");
    const missing = sessions.find((session) => session.session_id === withoutUsage.session_id);
    expect(missing?.usage.total.input_tokens).toBeNull();
    expect(missing?.usage.total.output_tokens).toBeNull();
    expect(missing?.usage.coverage).toBeNull();
    expect(io.stdoutText).toContain("—");
    expect(io.stdoutText).not.toContain("null");
  });
});

describe("openmatel show", () => {
  it("finds a session by id prefix and prints its timeline", async () => {
    const { dataDir } = await indexedFixture();
    const listIO = createMemoryIO();
    const sessions = await runSessions({ dataDir, limit: 20, json: true }, listIO);
    const target = sessions[0];
    const prefix = target.session_id.slice(0, 10);
    const io = createMemoryIO();

    const detail = await runShow(prefix, { dataDir }, io);

    expect(detail.summary.session_id).toBe(target.session_id);
    expect(io.stdoutText).toContain(target.session_id);
    expect(io.stdoutText).toContain("Timeline");
    expect(io.stdoutText).toContain("Turn 1");
    expect(io.stdoutText).toContain(formatTokens(detail.summary.usage.total.input_tokens));
  });

  it("prints the detail as JSON", async () => {
    const { dataDir } = await indexedFixture();
    const listIO = createMemoryIO();
    const sessions = await runSessions({ dataDir, limit: 1, json: true }, listIO);
    const io = createMemoryIO();

    await runShow(sessions[0].session_id.slice(0, 12), { dataDir, json: true }, io);
    const parsed = JSON.parse(io.stdoutText) as {
      summary: { session_id: string };
      events: unknown[];
      turns: unknown[];
    };
    expect(parsed.summary.session_id).toBe(sessions[0].session_id);
    expect(parsed.events.length).toBeGreaterThan(0);
    expect(parsed.turns.length).toBeGreaterThan(0);
  });
});

describe("openmatel sources", () => {
  it("detects all four fixtures one file each", async () => {
    const home = makeTempHome();
    const io = createMemoryIO();

    const detections = await runSources({ home }, io);

    expect(detections.map((entry) => entry.source)).toEqual([
      "claude-code",
      "codex",
      "dsh",
      "pi",
    ]);
    for (const entry of detections) {
      expect(entry.files).toBe(1);
      expect(entry.status).toBe("found");
    }
    expect(io.stdoutText).toContain("claude-code");
  });
});

/** Use the real built assets when available, or a minimal fixture otherwise. */
function uiAssetsDir(): string {
  const resolved = resolveUiDir();
  if (existsSync(path.join(resolved, "index.html"))) return resolved;
  const directory = tempDirectory();
  writeFileSync(
    path.join(directory, "index.html"),
    "<!doctype html><html><head><title>OpenMaTel</title></head><body><div id=\"root\"></div></body></html>",
    "utf8",
  );
  return directory;
}

describe("openmatel serve", () => {
  it("serves the UI and the Query API with a per-run token", async () => {
    const { dataDir } = await indexedFixture();
    const handle = await startServe({
      dataDir,
      port: 0,
      host: "127.0.0.1",
      open: false,
      handleSignals: false,
      staticDir: uiAssetsDir(),
    });

    try {
      const url = new URL(handle.url);
      expect(url.searchParams.get("token")).toBe(handle.token);
      expect(handle.url.startsWith(`http://127.0.0.1:${handle.port}/?token=`)).toBe(true);

      const origin = url.origin;
      const auth = { authorization: `Bearer ${handle.token}` };

      const page = await fetch(`${origin}/`, { headers: auth });
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
      expect(await page.text()).toContain("OpenMaTel");

      const sessions = await fetch(`${origin}/v1/query/sessions`, { headers: auth });
      expect(sessions.status).toBe(200);
      const body = (await sessions.json()) as { items: Array<{ source: string }> };
      expect(body.items).toHaveLength(4);
      expect(new Set(body.items.map((item) => item.source))).toEqual(
        new Set(["claude-code", "codex", "dsh", "pi"]),
      );

      const anonymous = await fetch(`${origin}/v1/query/sessions`);
      expect(anonymous.status).toBe(401);
      expect(anonymous.headers.get("www-authenticate")).toBe("Bearer");
    } finally {
      await handle.close();
    }
  });
});
