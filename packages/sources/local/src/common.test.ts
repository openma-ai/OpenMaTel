import { describe, expect, it } from "vitest";

import { validateEvent } from "@openmatel/core";

import {
  parseExitCode,
  parseExitCodeFromJson,
  parseJsonlText,
  planEntriesFrom,
  toolKindFor,
  truncateTitle,
  usageFrom,
} from "./common.js";

describe("@openmatel/source-local — shared plumbing", () => {
  it("keeps a missing token count missing and a reported zero a zero", () => {
    const missing = usageFrom({});
    expect(missing.source).toBe("missing");
    expect(missing.input_tokens).toBeNull();
    expect(missing.output_tokens).toBeNull();
    expect(missing.cache_read_tokens).toBeNull();
    expect(missing.cache_write_tokens).toBeNull();
    expect(missing.reasoning_tokens).toBeNull();

    // A harness that reported a zero reported a zero — it is not a missing
    // number, and the usage is not "missing" either.
    const zero = usageFrom({ input_tokens: 0, cache_write_tokens: 0 });
    expect(zero.source).toBe("provider");
    expect(zero.input_tokens).toBe(0);
    expect(zero.cache_write_tokens).toBe(0);
    expect(zero.output_tokens).toBeNull();
  });

  it("guesses the kind of a tool from its name", () => {
    expect(toolKindFor("Bash")).toBe("execute");
    expect(toolKindFor("shell")).toBe("execute");
    expect(toolKindFor("exec_command")).toBe("execute");
    expect(toolKindFor("Read")).toBe("read");
    expect(toolKindFor("view")).toBe("read");
    expect(toolKindFor("cat")).toBe("read");
    expect(toolKindFor("Edit")).toBe("edit");
    expect(toolKindFor("Write")).toBe("edit");
    expect(toolKindFor("apply_patch")).toBe("edit");
    expect(toolKindFor("str_replace")).toBe("edit");
    expect(toolKindFor("Grep")).toBe("search");
    expect(toolKindFor("Glob")).toBe("search");
    expect(toolKindFor("search")).toBe("search");
    expect(toolKindFor("web_fetch")).toBe("fetch");
    expect(toolKindFor("fetch")).toBe("fetch");
    expect(toolKindFor("mcp__server__tool")).toBe("mcp");
    expect(toolKindFor("TodoWrite")).toBe("other");
    expect(toolKindFor("Task")).toBe("other");
  });

  it("reads the exit code of a shell result", () => {
    expect(parseExitCode("the job failed [exit code: 3]")).toBe(3);
    expect(parseExitCode("Process exited with code 1")).toBe(1);
    expect(parseExitCode("all good")).toBeUndefined();
    expect(parseExitCodeFromJson('{"exit_code": 2, "output": "boom"}')).toBe(2);
    expect(parseExitCodeFromJson("no code here")).toBeUndefined();
  });

  it("skips the blank and the broken lines of a file and counts them", () => {
    const text = ['{"type":"a"}', "", "   ", "not json", "[1,2]", '{"type":"b"}'].join("\n");
    const parsed = parseJsonlText(text, "claude-code", "/tmp/session.jsonl");

    expect(parsed.records).toHaveLength(2);
    expect(parsed.records[0].ref).toBe("/tmp/session.jsonl#L1");
    expect(parsed.records[1].ref).toBe("/tmp/session.jsonl#L6");
    expect(parsed.records[1].line).toBe(6);
    expect(parsed.stats.blank).toBe(2);
    expect(parsed.stats.invalid).toBe(2);
    expect(parsed.stats.skipped).toBe(4);
  });

  it("reads the entries of a plan", () => {
    const entries = planEntriesFrom({
      todos: [
        { content: "read the file", status: "completed" },
        { content: "write the file", status: "pending", priority: "high" },
        { status: "pending" },
      ],
    });

    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ content: "read the file", status: "completed" });
    expect(entries[1].priority).toBe("high");
  });

  it("shortens a title to 120 characters", () => {
    const title = truncateTitle(`  a\nb  ${"x".repeat(200)}`);
    expect(title.length).toBe(120);
    expect(title.startsWith("a b xxx")).toBe(true);
  });
});
