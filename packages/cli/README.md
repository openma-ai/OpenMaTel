# openmatel

The minimal desktop CLI of OpenMaTel: read the local session files of Claude
Code, Codex, dsh and pi, index them into one SQLite database, and inspect the
result from the terminal.

**Zero services.** No network, no server, no Docker, no native dependency. The
only state is `~/.openmatel/openmatel.db` (or `$OPENMATEL_HOME/openmatel.db`).

Requires Node.js >= 22.13. The dsh source additionally needs the zstd API of
`node:zlib` (Node.js >= 22.15); when it is unavailable, `index` prints a warning
and skips dsh instead of failing.

## Commands

```sh
npx openmatel
# = index, then sessions --limit 20

npx openmatel index [--sources claude-code,codex,dsh,pi] [--home DIR] [--data DIR]
npx openmatel sessions [--source S] [--errors] [--q TEXT] [--limit N] [--json]
npx openmatel show <session-id-prefix> [--json]
npx openmatel sources [--home DIR]
npx openmatel --version
npx openmatel --help
```

`index` writes to `<data>/openmatel.db`. The data directory defaults to
`$OPENMATEL_HOME`, then `~/.openmatel`.

### Incremental indexing

Every file has a cursor `file:<path>` whose value is `${size}:${mtimeMs}`. An
unchanged file is skipped; a changed file is read and normalized completely
again. Ids are deterministic, so the store upserts are idempotent. A broken
file is reported on stderr and does not abort the other files.

The summary lists, per source, files seen / indexed / skipped (unchanged) /
failed, sessions, events and elapsed milliseconds.

### Sessions

The table is ordered newest first and contains the local start time, source,
title (50 characters), turns, steps, tool calls, tool errors, input/output
tokens, usage coverage and the first 12 characters of the session id. A token
count of `null` is rendered as `—`; it is never turned into `0`.

`--json` prints one session summary per line. `show --json` prints the session
detail (summary, events and turn/step tree) as one JSON object.

## Development

```sh
pnpm install
pnpm --filter openmatel build     # dist/openmatel.mjs (esbuild, bundled ESM)
pnpm --filter openmatel test
pnpm typecheck
```

The package has **no runtime dependencies**: `@openmatel/core`,
`@openmatel/source-local` and `@openmatel/store-sqlite` are devDependencies
(`workspace:*`) and are bundled into `dist/openmatel.mjs`. Node built-ins,
including `node:sqlite`, stay external.

The bundle routes `node:sqlite` through a lazy `createRequire` shim so the CLI
can suppress exactly Node's SQLite `ExperimentalWarning` before the built-in is
loaded; every other warning is re-emitted by the process.
