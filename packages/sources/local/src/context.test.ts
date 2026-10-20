import { describe, expect, it } from "vitest";

import { buildSessionTree, validateEvent, type AgentEvent, type RawRecord } from "@openmatel/core";

import {
  contextHash,
  type SessionFile,
} from "./common.js";
import { normalizeFile as normalizeClaudeFile } from "./claude-code.js";
import { normalizeFile as normalizeCodexFile } from "./codex.js";
import { normalizeFile as normalizeDshFile } from "./dsh.js";
import { normalizeFile as normalizePiFile } from "./pi.js";
import { countOfKind, eventsOfKind } from "./test-support.js";

/** An anonymized in-memory session file used by the synthetic cases below. */
function sessionFile(source: string, id: string, pathName = `/tmp/${source}-context`): SessionFile {
  return {
    source,
    path: `${pathName}/session-${id}.jsonl`,
    size: 0,
    mtimeMs: Date.parse("2026-10-20T12:00:00.000Z"),
    sourceSessionId: id,
  };
}

/** Turn one synthetic JSON object into the raw record a reader would produce. */
function raw(file: SessionFile, line: number, data: Record<string, unknown>): RawRecord {
  return { source: file.source, ref: `${file.path}#L${line}`, line, data };
}

const expectValid = (events: AgentEvent[]): void => {
  for (const event of events) {
    const result = validateEvent(event);
    expect(result.ok, result.ok ? "" : result.errors.join("; ")).toBe(true);
  }
};

describe("context snapshots — dsh", () => {
  const file = sessionFile("dsh", "77777777-7777-4777-8777-777777777777");
  const prompt = (line: number, time: number, text: string): RawRecord =>
    raw(file, line, {
      type: "system/message",
      seq: line,
      time,
      data: {
        turn: 1,
        step: 1,
        message: { role: "system", content: [{ type: "text", text }] },
      },
    });
  const header = (line: number, time: number, names: string[]): RawRecord =>
    raw(file, line, {
      type: "request/header",
      seq: line,
      time,
      data: {
        header: {
          config: { provider: "synthetic-provider", model: "synthetic-model" },
          tools: names.map((name) => ({ name, description: "synthetic tool" })),
        },
      },
    });

  const records: RawRecord[] = [
    raw(file, 1, {
      type: "session",
      version: 4,
      id: `session-${file.sourceSessionId}`,
      createdAt: 1700000000000,
      cwd: "/home/user/context-project",
      delegationDepth: 0,
    }),
    prompt(2, 1700000001000, "Synthetic dsh system prompt A."),
    prompt(3, 1700000002000, "Synthetic dsh system prompt A."),
    header(4, 1700000003000, ["bash", "read"]),
    header(5, 1700000004000, ["read", "bash"]),
    prompt(6, 1700000005000, "Synthetic dsh system prompt B."),
    header(7, 1700000006000, ["read", "edit"]),
  ];

  const events = normalizeDshFile(file, records);

  it("emits the prompt on first sight and on change, not on an unchanged repeat", () => {
    const prompts = eventsOfKind(events, "context.system_prompt");
    expect(prompts).toHaveLength(2);
    expect(prompts.map((event) => event.attrs.change)).toEqual(["initial", "changed"]);
    expect(prompts.map((event) => event.attrs.hash)).toEqual([
      contextHash("Synthetic dsh system prompt A."),
      contextHash("Synthetic dsh system prompt B."),
    ]);
    expect(prompts[0].attrs.length_chars).toBe("Synthetic dsh system prompt A.".length);
    expect(prompts[0].content?.input?.text).toBe("Synthetic dsh system prompt A.");
  });

  it("emits the tool catalog on first sight and on change, not on reorder", () => {
    const catalogs = eventsOfKind(events, "context.tool_catalog");
    expect(catalogs).toHaveLength(2);
    expect(catalogs[0].attrs).toMatchObject({
      change: "initial",
      tool_count: 2,
      added: ["bash", "read"],
      removed: [],
    });
    expect(catalogs[1].attrs).toMatchObject({
      change: "changed",
      tool_count: 2,
      added: ["edit"],
      removed: ["bash"],
    });
    expect(catalogs[0].content).toBeUndefined();
  });

  it("does not count the snapshots as steps or as a turn", () => {
    const tree = buildSessionTree(events);
    expect(tree.session.turn_count).toBe(0);
    expect(tree.session.step_count).toBe(0);
    expect(tree.turns).toHaveLength(0);
    expectValid(events);
  });
});

describe("context snapshots — Codex", () => {
  const file = sessionFile("codex", "88888888-8888-4888-8888-888888888888");
  const meta = (line: number, text: string): RawRecord =>
    raw(file, line, {
      timestamp: `2026-10-20T12:00:0${line}.000Z`,
      type: "session_meta",
      payload: {
        id: file.sourceSessionId,
        cli_version: "synthetic",
        model_provider: "synthetic-provider",
        base_instructions: {
          text,
          provenance: { type: "model", model: "synthetic-model" },
        },
      },
    });

  const records: RawRecord[] = [
    meta(1, "Synthetic Codex base instructions A."),
    meta(2, "Synthetic Codex base instructions A."),
    raw(file, 3, {
      timestamp: "2026-10-20T12:00:03.000Z",
      type: "turn_context",
      payload: {
        model: "synthetic-model",
        base_instructions: { text: "Synthetic Codex base instructions B." },
      },
    }),
  ];
  const events = normalizeCodexFile(file, records);

  it("emits the base instructions on first sight and on change", () => {
    const prompts = eventsOfKind(events, "context.system_prompt");
    expect(prompts).toHaveLength(2);
    expect(prompts.map((event) => event.attrs.change)).toEqual(["initial", "changed"]);
    expect(prompts[0].content?.input?.text).toBe("Synthetic Codex base instructions A.");
    expectValid(events);
  });

  it("emits no tool catalog because Codex does not record one", () => {
    expect(countOfKind(events, "context.tool_catalog")).toBe(0);
  });
});

describe("context snapshots — Claude Code", () => {
  const file = sessionFile("claude-code", "99999999-9999-4999-8999-999999999999");
  const snapshot = (
    line: number,
    systemPrompt: string[],
    tools: string[],
  ): RawRecord =>
    raw(file, line, {
      type: "attachment",
      sessionId: file.sourceSessionId,
      version: "synthetic",
      cwd: "/home/user/context-project",
      timestamp: `2026-10-20T12:00:0${line}.000Z`,
      attachment: {
        type: "prompt_snapshot",
        systemPrompt,
        tools: tools.map((name) => ({ name, description: "synthetic tool" })),
      },
    });

  const records: RawRecord[] = [
    snapshot(1, ["Synthetic Claude system prompt A."], ["read", "bash"]),
    snapshot(2, ["Synthetic Claude system prompt A."], ["bash", "read"]),
    snapshot(3, ["Synthetic Claude system prompt B."], ["read", "edit"]),
  ];
  const events = normalizeClaudeFile(file, records);

  it("emits the prompt on first sight and on change only", () => {
    const prompts = eventsOfKind(events, "context.system_prompt");
    expect(prompts).toHaveLength(2);
    expect(prompts.map((event) => event.attrs.change)).toEqual(["initial", "changed"]);
    expect(prompts[0].content?.input?.text).toBe("Synthetic Claude system prompt A.");
    expectValid(events);
  });

  it("emits the prompt snapshot tool list on first sight and on change", () => {
    const catalogs = eventsOfKind(events, "context.tool_catalog");
    expect(catalogs).toHaveLength(2);
    expect(catalogs[0].attrs).toMatchObject({
      change: "initial",
      tool_count: 2,
      added: ["bash", "read"],
      removed: [],
    });
    expect(catalogs[1].attrs).toMatchObject({
      change: "changed",
      tool_count: 2,
      added: ["edit"],
      removed: ["bash"],
    });
  });

  it("falls back to api-request-shape when no snapshot carries the context", () => {
    const shapeFile = sessionFile("claude-code", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const shape = (line: number, system: string, tools: string[]): RawRecord =>
      raw(shapeFile, line, {
        type: "api-request-shape",
        sessionId: shapeFile.sourceSessionId,
        timestamp: `2026-10-20T12:00:0${line}.000Z`,
        shape: {
          system: [{ type: "text", text: system }],
          tools: tools.map((name) => ({ name, input_schema: { type: "object" } })),
        },
      });
    const normalized = normalizeClaudeFile(shapeFile, [
      shape(1, "Synthetic shape prompt A.", ["read"]),
      shape(2, "Synthetic shape prompt A.", ["read"]),
      shape(3, "Synthetic shape prompt B.", ["write"]),
    ]);
    expect(eventsOfKind(normalized, "context.system_prompt")).toHaveLength(2);
    expect(eventsOfKind(normalized, "context.tool_catalog")).toHaveLength(2);
    expectValid(normalized);
  });
});

describe("context snapshots — pi", () => {
  const file = sessionFile("pi", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  const system = (
    line: number,
    preamble: string,
    added: string[],
    removed: string[] = [],
  ): RawRecord =>
    raw(file, line, {
      type: "message",
      id: `m${line}`,
      parentId: line === 2 ? null : `m${line - 1}`,
      timestamp: `2026-10-20T12:00:0${line}.000Z`,
      message: {
        role: "system",
        content: "",
        sections: { preamble, tools: "synthetic tools", rules: "synthetic rules" },
        toolsAdded: added.map((name) => ({ name, description: "synthetic tool" })),
        toolsRemoved: removed,
      },
    });

  const records: RawRecord[] = [
    raw(file, 1, {
      type: "session",
      version: 3,
      id: file.sourceSessionId,
      timestamp: "2026-10-20T12:00:00.000Z",
      cwd: "/home/user/context-project",
    }),
    system(2, "Synthetic pi prompt A.", ["read", "bash"]),
    system(3, "Synthetic pi prompt A.", ["bash", "read"]),
    system(4, "Synthetic pi prompt B.", ["edit"], ["bash"]),
  ];
  const events = normalizePiFile(file, records);

  it("emits the section prompt on first sight and on change", () => {
    const prompts = eventsOfKind(events, "context.system_prompt");
    expect(prompts).toHaveLength(2);
    expect(prompts.map((event) => event.attrs.change)).toEqual(["initial", "changed"]);
    expect(prompts[0].content?.input?.text).toContain("Synthetic pi prompt A.");
    expectValid(events);
  });

  it("applies toolsAdded / toolsRemoved and emits only a changed catalog", () => {
    const catalogs = eventsOfKind(events, "context.tool_catalog");
    expect(catalogs).toHaveLength(2);
    expect(catalogs[0].attrs).toMatchObject({
      change: "initial",
      tool_count: 2,
      added: ["bash", "read"],
      removed: [],
    });
    expect(catalogs[1].attrs).toMatchObject({
      change: "changed",
      tool_count: 2,
      added: ["edit"],
      removed: ["bash"],
    });
  });

  it("does not count the snapshots as steps or as a turn", () => {
    const tree = buildSessionTree(events);
    expect(tree.session.turn_count).toBe(0);
    expect(tree.session.step_count).toBe(0);
  });
});
