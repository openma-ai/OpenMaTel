#!/usr/bin/env node
/**
 * Dependency-direction guard for the OpenMaTel monorepo.
 *
 * Rules enforced:
 *   (a) packages/core must stay dependency-free: it may not depend on any
 *       runtime dependency at all, and not on any workspace package. `core`
 *       holds the domain model and the ports, so it must not pull in IO,
 *       platform or third-party code.
 *   (b) No package may depend on a package whose name contains "openma" other
 *       than in the @openmatel/* scope. OpenMA internals are not part of this
 *       product: OpenMaTel has to work standalone.
 *   (c) packages/ui and packages/server must not depend on any
 *       @openmatel/store-* package. The UI talks to the server through the
 *       HTTP Query API only, and the server gets a Query port injected; neither
 *       of them may touch a store directly.
 *
 * Exits 0 and prints "deps ok" when everything holds, exits 1 with a report
 * otherwise. Passes when the repository contains no packages at all.
 */

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = join(repoRoot, "packages");

/** Dependency fields that ship with the package at runtime. */
const RUNTIME_DEP_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"];
/** Every field that can express a dependency on another package. */
const ALL_DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

const OPENMATEL_SCOPE = "@openmatel/";
const OPENMATEL_STORE_SCOPE = "@openmatel/store-";

/** Protocols that always point at a package inside this repository. */
const LOCAL_PROTOCOL_PREFIXES = ["workspace:", "link:", "file:"];

const toPosix = (p) => p.split(sep).join("/");

/**
 * Collect every package.json below `root`, skipping node_modules and hidden
 * directories. Symlinked directories are followed, with a visited set so that
 * symlink cycles cannot trap the walk.
 */
function findManifests(root) {
  const found = [];
  const visited = new Set();

  const visit = (dir) => {
    let real;
    try {
      real = realpathSync(dir);
    } catch {
      return;
    }
    if (visited.has(real)) return;
    visited.add(real);

    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) found.push(manifest);

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;

      const child = join(dir, entry.name);
      let isDir = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          isDir = statSync(child).isDirectory();
        } catch {
          isDir = false;
        }
      }
      if (isDir) visit(child);
    }
  };

  visit(root);
  return found.sort();
}

/** Flatten a manifest's dependency fields into a list of { field, name, spec }. */
function collectDependencies(manifest) {
  const deps = [];
  for (const field of ALL_DEP_FIELDS) {
    const group = manifest[field];
    if (!group || typeof group !== "object") continue;
    for (const [name, spec] of Object.entries(group)) {
      if (typeof spec !== "string") continue;
      deps.push({ field, name, spec });
    }
  }
  return deps;
}

const isWorkspaceDependency = (dep, workspaceNames) =>
  workspaceNames.has(dep.name) || LOCAL_PROTOCOL_PREFIXES.some((prefix) => dep.spec.startsWith(prefix));

// The published CLI is literally named "openmatel"; that is the product, not
// an OpenMA internal. Everything else containing "openma" must stay out.
const isOpenmaInternal = (name) =>
  name.includes("openma") && name !== "openmatel" && !name.startsWith(OPENMATEL_SCOPE);

function main() {
  const problems = [];

  if (!existsSync(packagesRoot)) {
    console.log("deps ok");
    return 0;
  }

  const packages = [];

  for (const file of findManifests(packagesRoot)) {
    const dir = toPosix(relative(repoRoot, dirname(file)));

    let manifest;
    try {
      manifest = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      problems.push(`${dir}/package.json: cannot be parsed as JSON (${error.message})`);
      continue;
    }

    packages.push({
      dir,
      name: typeof manifest.name === "string" ? manifest.name : "",
      manifest,
    });
  }

  const workspaceNames = new Set(packages.map((pkg) => pkg.name).filter(Boolean));

  for (const pkg of packages) {
    const isCore = pkg.dir === "packages/core" || pkg.name === "@openmatel/core";
    const isUi = pkg.dir === "packages/ui" || pkg.name === "@openmatel/ui";
    const isServer = pkg.dir === "packages/server" || pkg.name === "@openmatel/server";
    const deps = collectDependencies(pkg.manifest);

    // (b) A workspace package must not be an OpenMA internal either.
    if (pkg.name && isOpenmaInternal(pkg.name)) {
      problems.push(
        `${pkg.dir}: package name "${pkg.name}" is an OpenMA internal — ` +
          `workspace packages must live in the ${OPENMATEL_SCOPE}* scope`,
      );
    }

    for (const dep of deps) {
      // (b) No OpenMA internals, in any dependency field.
      if (isOpenmaInternal(dep.name)) {
        problems.push(
          `${pkg.dir}: must not depend on "${dep.name}" (${dep.field}) — ` +
            `OpenMA internals are not allowed, use ${OPENMATEL_SCOPE}* packages instead`,
        );
      }

      // (c) Neither the UI nor the server may embed a store. The UI only
      // speaks the HTTP Query API; the server receives a Query port.
      if ((isUi || isServer) && dep.name.startsWith(OPENMATEL_STORE_SCOPE)) {
        problems.push(
          `${pkg.dir}: must not depend on "${dep.name}" (${dep.field}) — ` +
            `${isUi ? "the UI accesses data through the HTTP Query API only" : "the server depends on the Query port, not on a store"}`,
        );
      }
    }

    if (isCore) {
      for (const dep of deps) {
        if (RUNTIME_DEP_FIELDS.includes(dep.field)) {
          problems.push(
            `${pkg.dir}: must not have any runtime dependency ("${dep.name}" in ${dep.field}) — ` +
              `core stays dependency-free`,
          );
        }
        if (isWorkspaceDependency(dep, workspaceNames)) {
          problems.push(
            `${pkg.dir}: must not depend on workspace package "${dep.name}" (${dep.field}) — ` +
              `core is the base of the dependency graph and depends on nothing`,
          );
        }
      }
    }
  }

  if (problems.length > 0) {
    console.error("dependency-direction check failed:");
    console.error("");
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error("");
    console.error(`${problems.length} problem(s) found in ${packages.length} package(s).`);
    return 1;
  }

  console.log("deps ok");
  return 0;
}

process.exit(main());
