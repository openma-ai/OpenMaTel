import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../scripts/sync-oma-console.mjs", import.meta.url));

describe("vendored OpenMA console", () => {
  it("matches the manifest and PROVENANCE hashes without a source checkout", () => {
    const output = execFileSync(process.execPath, [script, "--check"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(output).toContain("vendored console ok");
  });
});
