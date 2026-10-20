# openmatel

The desktop CLI of OpenMaTel: read the local session files of Claude Code,
Codex, dsh and pi, index them into one SQLite database, and inspect the result
in the terminal or in the bundled web UI.

**Zero external services.** The optional local server binds loopback only, and
the only state is `~/.openmatel/openmatel.db` (or
`$OPENMATEL_HOME/openmatel.db`). There is no Docker, no native dependency and
no cloud account.

Requires Node.js >= 22.13. The dsh source additionally needs the zstd API of
`node:zlib` (Node.js >= 22.15); when it is unavailable, `index` prints a warning
and skips dsh instead of failing.

## Commands

```sh
npx openmatel
# = index, then serve the web UI and open the browser

npx openmatel serve [--port 4319] [--host 127.0.0.1] [--no-open] [--no-index]
npx openmatel index [--sources claude-code,codex,dsh,pi] [--home DIR] [--data DIR]
npx openmatel sessions [--source S] [--errors] [--q TEXT] [--limit N] [--json]
npx openmatel show <session-id-prefix> [--json]
npx openmatel sources [--home DIR]
npx openmatel --version
npx openmatel --help
```

`serve` prints a URL such as
`http://127.0.0.1:4319/?token=…`. A random token is generated for each run; the
server exchanges it for an HttpOnly cookie, so every later request is
authenticated without putting the token in the browser history. If the port is
busy, the next ten ports are tried. `--no-index` serves the existing database
without scanning local files first. Ctrl-C shuts the listener and the SQLite
store down cleanly.

The web UI is the built `@openmatel/app` SPA, copied to `dist/ui` during the
CLI build and served from a path relative to the bundled
`dist/openmatel.mjs`.

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
pnpm build                        # builds @openmatel/app before the CLI
pnpm --filter openmatel pack      # tarball with dist/openmatel.mjs + dist/ui/
pnpm --filter openmatel test
pnpm typecheck
```

The package has **no runtime dependencies**: `@openmatel/core`,
`@openmatel/source-local`, `@openmatel/store-sqlite`, `@openmatel/server` and
Hono are devDependencies (`workspace:*` / npm) and are bundled into
`dist/openmatel.mjs`. Node built-ins, including `node:sqlite`, stay external.

The bundle routes `node:sqlite` through a lazy `createRequire` shim so the CLI
can suppress exactly Node's SQLite `ExperimentalWarning` before the built-in is
loaded; every other warning is re-emitted by the process.
