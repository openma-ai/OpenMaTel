# `@openmatel/store-sqlite`

The SQLite store of OpenMaTel: a **Sink** and a **Query** adapter on top of the
`node:sqlite` module of Node.js.

It is the desktop default of the product (design §6.2): the database is one file
next to the app, there is no server to run and **no native dependency** — the
SQLite engine ships with Node.js, so there is nothing to compile and nothing to
ship per platform.

Requires Node.js >= 22.13 (the version that unflagged `node:sqlite`).

## Usage

```ts
import { openSqliteStore } from "@openmatel/store-sqlite";

const store = openSqliteStore({ path: "./openmatel.db" });

await store.sink.write(events);
const page = await store.query.listSessions({ project_id: "proj_1", limit: 20 });

await store.close();
```

`openSqliteStore` takes `{ path }` — the path of the database file, or
`":memory:"` for a throw-away store. The parent directory is created when it
does not exist.

Besides the two ports, the store offers the housekeeping a pull source needs:

```ts
store.setCursor("claude-code:/repo/a.jsonl", "4096");
store.getCursor("claude-code:/repo/a.jsonl"); // → "4096"
```

The cursors live in the database, so a source resumes where it stopped after a
restart of the process.

## What it guarantees

- **Idempotent writes.** An event is stored under its `event_id`; writing it
  again replaces it. The at-least-once delivery of the bus cannot duplicate a
  trace.
- **"Missing" is not "0".** A token count nobody reported stays `null` — in the
  database (`NULL`) and in the summaries. It never becomes `0` (design §4.5).
- **No content without capture.** A step captured with `capture: "none"` is
  stored without its input and output text: the text never reaches the
  database, not in a column and not in the payload of the event.
- **A session is always consistent with its events.** Every write recomputes
  the summary of the sessions it touched with the pure functions of
  `@openmatel/core`, so the list and the detail view cannot drift apart.

## The database

The schema is owned by the store and migrated by itself: the migrations are
numbered, they run once, inside a transaction, and are recorded in
`_migrations`. A database that was written by an older version is upgraded when
it is opened again.

| Table        | Holds                                                        |
| ------------ | ------------------------------------------------------------ |
| `events`     | the canonical event (`event_json`) and its queryable columns   |
| `sessions`   | the derived summary of a session, recomputed on every write    |
| `cursors`    | the positions of the pull sources                             |
| `sessions_fts` | the full text index of the session title and directory      |

The connection runs with the pragmas of the desktop profile: `journal_mode=WAL`
(an in-memory database keeps the journal of SQLite itself), `synchronous=NORMAL`,
`foreign_keys=ON` and a busy timeout of five seconds.

The full text index needs FTS5. The store detects at runtime whether the SQLite
build has it: with FTS5 the session search uses the index — with the trigram
tokenizer, so a fragment of a word is found as well — and without it the search
falls back to `LIKE`.

## Pagination

The session list is ordered by `started_at` (descending) and then by
`session_id` (ascending), and paginated with a **keyset cursor**: the cursor
holds the position of the last session of the previous page, so a page never
skips and never repeats a session, even when new sessions arrive while the
list is read. A cursor is base64url JSON — opaque to the caller, readable by a
client that wants to.

## Tests

```sh
pnpm test
```

The suite of the repository runs the contract suite of
`@openmatel/contract-tests` against an in-memory database *and* against a file,
adds a reopen test (write, close, reopen, read back) and a performance smoke
test (20 000 events in 200 sessions; the session list has to stay below 200 ms
at the 95th percentile — the measurement always runs, the assertion is skipped
on CI).
