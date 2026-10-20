#!/usr/bin/env node
/**
 * Sync the vendored Open Managed Agents console sources.
 *
 * Usage:
 *   node scripts/sync-oma-console.mjs --from /path/to/open-managed-agents
 *   node scripts/sync-oma-console.mjs --check
 *
 * `--from` copies every path in packages/oma-console-ui/manifest.json from
 * `<from>/apps/console/src` into packages/oma-console-ui/vendor, applies the
 * patches listed in the manifest, then rewrites vendor/PROVENANCE.md with the
 * source commit and a SHA-256 for every file.
 *
 * `--check` is offline: it validates that vendor/ contains exactly the
 * manifest files, that PROVENANCE.md lists exactly those files, and that every
 * recorded SHA-256 matches the bytes on disk. CI runs this through
 * packages/oma-console-ui/sync.test.ts.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_URL = "https://github.com/openma-ai/open-managed-agents";
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const packageRoot = join(repoRoot, "packages", "oma-console-ui");
const manifestPath = join(packageRoot, "manifest.json");
const vendorDir = join(packageRoot, "vendor");
const provenancePath = join(vendorDir, "PROVENANCE.md");

const usage = () => {
  console.error("usage: node scripts/sync-oma-console.mjs --from <open-managed-agents> [--check]");
  console.error("       node scripts/sync-oma-console.mjs --check");
};

const fail = (message) => {
  throw new Error(message);
};

const sha256 = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");

/** Read and validate the manifest. */
function readManifest() {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    fail(`cannot read ${manifestPath}: ${error instanceof Error ? error.message : error}`);
  }
  if (!manifest || typeof manifest !== "object") fail("manifest.json must be a JSON object");
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    fail("manifest.json must list at least one file in `files`");
  }
  const files = manifest.files.map((file) => {
    if (typeof file !== "string" || file === "") fail("manifest.json `files` entries must be strings");
    const target = resolve(vendorDir, file);
    if (target !== vendorDir && !target.startsWith(`${vendorDir}${sep}`)) {
      fail(`manifest path escapes vendor/: ${file}`);
    }
    return file;
  });
  if (new Set(files).size !== files.length) fail("manifest.json lists a file more than once");
  const patches = Array.isArray(manifest.patches) ? manifest.patches : [];
  for (const patch of patches) {
    if (typeof patch !== "string" || patch === "") fail("manifest.json `patches` entries must be strings");
    if (!existsSync(join(packageRoot, "patches", patch))) {
      fail(`manifest patch does not exist: patches/${patch}`);
    }
  }
  const source = manifest.source;
  if (!source || typeof source.repo !== "string" || typeof source.consoleSrc !== "string") {
    fail("manifest.json `source` must have `repo` and `consoleSrc`");
  }
  return { source, files: [...files].sort(), patches: [...patches] };
}

/** Recursively list files below a directory, relative to it, POSIX-style. */
function listFiles(dir) {
  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(absolute.slice(dir.length + 1).split(sep).join("/"));
    }
  };
  visit(dir);
  return files.sort();
}

function sourceCommit(from) {
  const result = spawnSync("git", ["-C", from, "rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) fail(`cannot run git: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`git -C ${from} rev-parse HEAD failed: ${result.stderr.trim() || `exit ${result.status}`}`);
  }
  const commit = result.stdout.trim();
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commit)) {
    fail(`git returned an unexpected commit id: ${commit}`);
  }
  return commit;
}

/**
 * Apply one unified diff. This intentionally implements only the subset the
 * vendored patches use: one file per patch, normal `@@ -a,b +c,d @@` hunks,
 * context / removal / addition lines, and optional "No newline" markers.
 */
function applyPatch(patchFile) {
  const text = readFileSync(patchFile, "utf8");
  const lines = text.split(/\r?\n/);
  let index = 0;

  while (index < lines.length && !lines[index].startsWith("--- ")) index += 1;
  if (index >= lines.length) fail(`${patchFile}: missing --- header`);
  index += 1;
  if (!lines[index]?.startsWith("+++ ")) fail(`${patchFile}: missing +++ header`);

  const targetHeader = lines[index].slice(4).trim();
  const matchTarget = /^[ab]\/(.+)$/.exec(targetHeader);
  if (!matchTarget) fail(`${patchFile}: unsupported target header: ${targetHeader}`);
  const target = matchTarget[1];
  const absoluteTarget = resolve(vendorDir, target);
  if (absoluteTarget !== vendorDir && !absoluteTarget.startsWith(`${vendorDir}${sep}`)) {
    fail(`${patchFile}: target escapes vendor/: ${target}`);
  }
  index += 1;

  const original = readFileSync(absoluteTarget, "utf8");
  const hadFinalNewline = original.endsWith("\n");
  const content = original.split("\n");
  if (hadFinalNewline) content.pop();
  let cursor = 0;

  const readHunk = () => {
    const header = lines[index];
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
    if (!hunk) fail(`${patchFile}: expected a hunk header, got: ${header}`);
    const oldStart = Number(hunk[1]);
    const oldCount = hunk[2] === undefined ? 1 : Number(hunk[2]);
    const newCount = hunk[4] === undefined ? 1 : Number(hunk[4]);
    index += 1;

    const oldLines = [];
    const newLines = [];
    while (index < lines.length && !lines[index].startsWith("@@ ") && !lines[index].startsWith("--- ")) {
      const line = lines[index];
      if (line.startsWith("\\ No newline at end of file")) {
        index += 1;
        continue;
      }
      if (line === "" && index === lines.length - 1) break;
      const prefix = line[0] ?? " ";
      const body = line.slice(1);
      if (prefix === " ") {
        oldLines.push(body);
        newLines.push(body);
      } else if (prefix === "-") {
        oldLines.push(body);
      } else if (prefix === "+") {
        newLines.push(body);
      } else {
        fail(`${patchFile}: unsupported hunk line: ${line}`);
      }
      index += 1;
    }
    if (oldLines.length !== oldCount) {
      fail(`${patchFile}: hunk expected ${oldCount} old lines, found ${oldLines.length}`);
    }
    if (newLines.length !== newCount) {
      fail(`${patchFile}: hunk expected ${newCount} new lines, found ${newLines.length}`);
    }
    return { oldStart, oldLines, newLines };
  };

  while (index < lines.length) {
    if (lines[index] === "") {
      index += 1;
      continue;
    }
    if (lines[index].startsWith("--- ")) break;
    const { oldStart, oldLines, newLines } = readHunk();

    const expected = Math.max(0, oldStart - 1);
    let at = -1;
    if (oldLines.length === 0) {
      at = Math.min(expected, content.length);
    } else {
      const matchesAt = (start) =>
        start >= 0 &&
        start + oldLines.length <= content.length &&
        oldLines.every((line, offset) => content[start + offset] === line);
      if (matchesAt(expected) && expected >= cursor) at = expected;
      if (at === -1) {
        for (let start = Math.max(cursor, expected); start + oldLines.length <= content.length; start += 1) {
          if (matchesAt(start)) {
            at = start;
            break;
          }
        }
      }
      if (at === -1) {
        for (let start = expected - 1; start >= cursor; start -= 1) {
          if (matchesAt(start)) {
            at = start;
            break;
          }
        }
      }
    }
    if (at === -1) fail(`${patchFile}: cannot apply hunk at ${target}:${oldStart}`);

    content.splice(at, oldLines.length, ...newLines);
    cursor = at + newLines.length;
  }

  const next = content.join("\n") + (hadFinalNewline ? "\n" : "");
  writeFileSync(absoluteTarget, next);
}

function renderProvenance(commit, manifest) {
  const rows = manifest.files
    .map((file) => `| \`${file}\` | \`${sha256(join(vendorDir, file))}\` |`)
    .join("\n");
  const patches =
    manifest.patches.length === 0
      ? "_None._"
      : manifest.patches.map((patch) => `- \`patches/${patch}\``).join("\n");
  return `# Vendored Open Managed Agents console sources

This directory is generated by \`node scripts/sync-oma-console.mjs --from <open-managed-agents checkout>\`.
Do not edit these files by hand. Local changes belong in \`../patches/*.patch\`
and are applied by the sync script.

- Source: ${manifest.source.repo}
- Commit: ${commit}
- Console source path: \`${manifest.source.consoleSrc}\`
- License: Apache-2.0 (see \`../LICENSE\` and \`../NOTICE\`)

## Patches

${patches}

## Files

| Path | SHA-256 |
| --- | --- |
${rows}
`;
}

/** Copy the manifest, apply patches and write PROVENANCE.md. */
function sync(from) {
  const manifest = readManifest();
  const checkout = resolve(from);
  const sourceRoot = join(checkout, manifest.source.consoleSrc);
  if (!existsSync(sourceRoot)) fail(`console source not found: ${sourceRoot}`);
  if (!statSync(sourceRoot).isDirectory()) fail(`console source is not a directory: ${sourceRoot}`);
  const commit = sourceCommit(checkout);

  rmSync(vendorDir, { recursive: true, force: true });
  mkdirSync(vendorDir, { recursive: true });

  for (const file of manifest.files) {
    const source = join(sourceRoot, file);
    if (!existsSync(source)) fail(`manifest file is missing from the checkout: ${file}`);
    const target = join(vendorDir, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(source));
  }

  for (const patch of manifest.patches) applyPatch(join(packageRoot, "patches", patch));

  writeFileSync(provenancePath, renderProvenance(commit, manifest));
  console.log(
    `synced ${manifest.files.length} file(s) from ${checkout} at ${commit}` +
      (manifest.patches.length > 0 ? ` (${manifest.patches.length} patch(es) applied)` : ""),
  );
}

/** Offline verification used by CI. Returns the number of problems. */
export function check() {
  const problems = [];
  let manifest;
  try {
    manifest = readManifest();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 1;
  }

  if (!existsSync(vendorDir)) {
    console.error(`vendored directory is missing: ${vendorDir}`);
    return 1;
  }

  const actual = listFiles(vendorDir).filter((file) => file !== "PROVENANCE.md");
  const expected = manifest.files;
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);

  for (const file of expected) {
    if (!actualSet.has(file)) problems.push(`missing vendored file: ${file}`);
  }
  for (const file of actual) {
    if (!expectedSet.has(file)) problems.push(`unexpected vendored file: ${file}`);
  }

  if (!existsSync(provenancePath)) {
    problems.push("vendor/PROVENANCE.md is missing");
  } else {
    const provenance = readFileSync(provenancePath, "utf8");
    if (!provenance.includes(`- Source: ${REPO_URL}`)) {
      problems.push(`PROVENANCE.md does not name the source repository (${REPO_URL})`);
    }
    if (!/^- Commit: [0-9a-f]{40}(?:[0-9a-f]{24})?$/m.test(provenance)) {
      problems.push("PROVENANCE.md does not record a git commit");
    }

    const recorded = new Map();
    for (const line of provenance.split(/\r?\n/)) {
      const row = /^\| `([^`]+)` \| `([0-9a-f]{64})` \|$/.exec(line);
      if (row) recorded.set(row[1], row[2]);
    }
    for (const file of expected) {
      const hash = recorded.get(file);
      if (hash === undefined) {
        problems.push(`PROVENANCE.md is missing a hash for ${file}`);
        continue;
      }
      if (!actualSet.has(file)) continue;
      const onDisk = sha256(join(vendorDir, file));
      if (hash !== onDisk) problems.push(`sha256 mismatch for ${file}`);
    }
    for (const file of recorded.keys()) {
      if (!expectedSet.has(file)) problems.push(`PROVENANCE.md lists an unlisted file: ${file}`);
    }
  }

  if (problems.length > 0) {
    console.error("vendored console check failed:");
    for (const problem of problems) console.error(`  - ${problem}`);
    return problems.length;
  }
  console.log(`vendored console ok (${manifest.files.length} files)`);
  return 0;
}

function main(argv) {
  let from;
  let shouldCheck = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check") shouldCheck = true;
    else if (arg === "--from") {
      from = argv[i + 1];
      i += 1;
      if (from === undefined) {
        usage();
        return 2;
      }
    } else if (arg.startsWith("--from=")) from = arg.slice("--from=".length);
    else if (arg === "--help" || arg === "-h") {
      usage();
      return 0;
    } else {
      console.error(`unknown argument: ${arg}`);
      usage();
      return 2;
    }
  }

  try {
    if (shouldCheck) {
      // `--check` is offline by design; when `--from` is also present it is
      // accepted (matching the documented `--from ... [--check]` form) but
      // the verification itself never reads the checkout.
      return check();
    }
    if (from === undefined) {
      usage();
      return 2;
    }
    sync(from);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
