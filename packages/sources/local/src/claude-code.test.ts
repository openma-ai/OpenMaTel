import { describe, expect, it } from "vitest";
import path from "node:path";

import { normalizerContract } from "@openmatel/contract-tests";
import { sessionId, validateEvent, type RawRecord } from "@openmatel/core";

import {
  claudeCodeNormalizer,
  discover as discoverClaudeCode,
  normalizeFile as normalizeClaudeCodeFile,
  readRecords as readClaudeCodeRecords,
} from "./claude-code.js";
import {
  countOfKind,
  eventsOfKind,
  firstEventOfKind,
  makeTempHome,
  type SessionFile,
} from "./test-support.js";

const temp = makeTempHome(["claude-code"]);

const files = await discoverClaudeCode(temp.home);
const file = files[0];
if (file === undefined) throw new Error("the Claude Code fixture was not found");
const records = await readClaudeCodeRecords(file);
const events = normalizeClaudeCodeFile(file, records);

normalizerContract("claude-code normalizer", claudeCodeNormalizer, records);

describe("@openmatel/source-local — Claude Code", () => {
  it("finds the session file of the fixture", () => {
    expect(files).toHaveLength(1);
    expect(file.source).toBe("claude-code");
    expect(file.sourceSessionId).toBe("11111111-1111-4111-8111-111111111111");
    expect(file.path).toContain(path.join(".claude", "projects"));
    expect(file.size).toBeGreaterThan(0);
    expect(file.mtimeMs).toBeGreaterThan(0);
  });

  it("reads every line of the file as a record", () => {
    expect(records).toHaveLength(80);
    expect(records[0].ref).toBe(`${file.path}#L1`);
    expect(records[0].line).toBe(1);
    expect(records[0].source).toBe("claude-code");
  });

  it("produces one session with one turn", () => {
    expect(countOfKind(events, "session.start")).toBe(1);
    expect(countOfKind(events, "session.end")).toBe(1);
    expect(countOfKind(events, "turn.start")).toBe(1);
    expect(countOfKind(events, "turn.end")).toBe(1);
  });

  it("describes the session", () => {
    const start = firstEventOfKind(events, "session.start");
    expect(start).toBeDefined();
    expect(start?.project_id).toBe("local");
    expect(start?.session_id).toBe(sessionId("claude-code", file.sourceSessionId));
    expect(start?.source.name).toBe("claude-code");
    expect(start?.source.format).toBe("claude-code.jsonl");
    expect(start?.source.ref).toContain("#L");
    expect((start?.attrs.harness as { name?: string } | undefined)?.name).toBe("claude-code");
    expect((start?.attrs.harness as { version?: string } | undefined)?.version).toBe("2.1.302");
    expect(start?.attrs.cwd).toBe("/home/user/project");
    expect((start?.attrs.git as { branch?: string } | undefined)?.branch).toBe(
      "fix/presence-heartbeat-idle",
    );
    expect(start?.attrs.model).toBe("claude-opus-5-5");
    expect(typeof start?.attrs.title).toBe("string");
  });

  it("emits the user message and the answer of the agent", () => {
    const user = firstEventOfKind(events, "message.user");
    expect(user).toBeDefined();
    expect(user?.content?.input?.text).toBe("redacted text");

    const agent = firstEventOfKind(events, "message.agent");
    expect(agent).toBeDefined();
    expect(typeof agent?.content?.output?.text).toBe("string");
  });

  it("emits at least one tool call, with its result", () => {
    const calls = eventsOfKind(events, "tool.call");
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls.length).toBe(12);

    // Every call that got a result carries the output of that result.
    const withResult = calls.filter((call) => call.end_ts !== undefined);
    expect(withResult.length).toBeGreaterThanOrEqual(1);
    for (const call of withResult) {
      expect(call.content?.output?.text).toBeDefined();
    }
  });

  it("names the tool and guesses its kind", () => {
    const calls = eventsOfKind(events, "tool.call");
    const names = calls.map((call) => call.attrs.tool_name);
    expect(names).toContain("Bash");
    expect(names).toContain("Read");
    expect(names).toContain("Edit");

    const kindOf = (name: string): string | undefined =>
      calls.find((call) => call.attrs.tool_name === name)?.attrs.tool_kind as string | undefined;

    expect(kindOf("Bash")).toBe("execute");
    expect(kindOf("Read")).toBe("read");
    expect(kindOf("Edit")).toBe("edit");
  });

  it("nests the shell command and the file edits under the call", () => {
    const commands = eventsOfKind(events, "env.command");
    expect(commands.length).toBe(3);
    for (const command of commands) {
      expect(typeof command.attrs.command).toBe("string");
      expect(command.parent_step_id).toBeDefined();
    }

    const edits = eventsOfKind(events, "env.file_edit");
    expect(edits.length).toBe(5);
    for (const edit of edits) {
      expect(typeof edit.attrs.path).toBe("string");
      expect(["create", "modify", "delete"]).toContain(edit.attrs.op);
      expect(edit.parent_step_id).toBeDefined();
    }
  });

  it("maps the token counters of the model, keeping a reported zero a zero", () => {
    const calls = eventsOfKind(events, "llm.call");
    expect(calls.length).toBeGreaterThanOrEqual(1);

    const usage = calls[0].usage;
    expect(usage?.source).toBe("provider");
    expect(usage?.input_tokens).toBe(2);
    expect(usage?.output_tokens).toBe(215);
    expect(usage?.cache_read_tokens).toBe(10420);
    expect(usage?.cache_write_tokens).toBe(20746);
    // The harness reported `thinking_tokens: 0` — a reported zero stays a
    // zero and never becomes `null`.
    expect(usage?.reasoning_tokens).toBe(0);
  });

  it("keeps the ids of the events unique and stable", () => {
    const ids = events.map((event) => event.event_id);
    expect(new Set(ids).size).toBe(ids.length);

    const again = normalizeClaudeCodeFile(file, records);
    expect(again.map((event) => event.event_id)).toEqual(ids);
    expect(again).toEqual(events);
  });

  it("produces valid canonical events", () => {
    for (const event of events) {
      const result = validateEvent(event);
      expect(result.ok, result.ok ? "" : result.errors.join("; ")).toBe(true);
    }
  });
});

describe("@openmatel/source-local — Claude Code side chains", () => {
  /** A session with a sub agent; the fixture does not contain one. */
  const sideChain: RawRecord[] = [
    {
      source: "claude-code",
      ref: "/tmp/sidechain.jsonl#L1",
      line: 1,
      data: {
        type: "user",
        uuid: "u0",
        timestamp: "2026-10-19T10:00:00.000Z",
        userType: "external",
        message: { role: "user", content: "look into it" },
      },
    },
    {
      source: "claude-code",
      ref: "/tmp/sidechain.jsonl#L2",
      line: 2,
      data: {
        type: "assistant",
        uuid: "u1",
        parentUuid: "u0",
        timestamp: "2026-10-19T10:00:01.000Z",
        message: {
          role: "assistant",
          model: "claude-opus-5-5",
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "Task",
              input: { subagent_type: "explorer", description: "look into it" },
            },
          ],
        },
      },
    },
    {
      source: "claude-code",
      ref: "/tmp/sidechain.jsonl#L3",
      line: 3,
      data: {
        type: "user",
        uuid: "u2",
        parentUuid: "u1",
        isSidechain: true,
        timestamp: "2026-10-19T10:00:02.000Z",
        message: { role: "user", content: "read the file" },
      },
    },
    {
      source: "claude-code",
      ref: "/tmp/sidechain.jsonl#L4",
      line: 4,
      data: {
        type: "assistant",
        uuid: "u3",
        parentUuid: "u2",
        isSidechain: true,
        timestamp: "2026-10-19T10:00:03.000Z",
        message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "done" }] },
      },
    },
  ];

  const file: SessionFile = {
    source: "claude-code",
    path: "/tmp/sidechain.jsonl",
    size: 0,
    mtimeMs: 0,
    sourceSessionId: "sidechain",
  };

  const sideEvents = normalizeClaudeCodeFile(file, sideChain);

  it("reports one spawn per side chain", () => {
    const spawns = eventsOfKind(sideEvents, "subagent.spawn");
    expect(spawns).toHaveLength(1);
    expect(spawns[0].attrs.agent_name).toBe("explorer");
    expect(spawns[0].attrs.task).toBe("look into it");
  });

  it("keeps the sub agent inside the turn of its parent", () => {
    // The prompt of the sub agent is not a new turn of the session.
    expect(countOfKind(sideEvents, "turn.start")).toBe(1);
    expect(countOfKind(sideEvents, "message.user")).toBe(2);
  });
});
