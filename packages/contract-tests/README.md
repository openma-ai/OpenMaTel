# @openmatel/contract-tests

The contract suites every OpenMaTel adapter has to pass. One suite per port,
all of them driven by Vitest.

The point of a shared suite is that two stores cannot quietly disagree: the
SQLite store, the Postgres store, the ClickHouse store and the in-memory
reference implementation all run the *same* expectations, so a behaviour that
drifts apart shows up as a failing test instead of as a surprise in the UI.

## Install

```sh
pnpm add -D @openmatel/contract-tests vitest
```

The package depends on `@openmatel/core` and declares `vitest` as a peer
dependency: the suites register `describe` blocks in the test runner of the
adapter that uses them.

## Usage

Each contract function registers a `describe` block. Call it from the test
file of your adapter — there is nothing else to do.

### A store (Sink + Query)

```ts
import { describe, expect, it } from "vitest";
import { sinkQueryContract } from "@openmatel/contract-tests";
import { openSqliteStore } from "./store.js";

sinkQueryContract("sqlite", async () => {
  const store = await openSqliteStore(":memory:");
  return { sink: store.sink, query: store.query, close: () => store.close() };
});
```

The factory is called **once per test**, so every test starts with an empty
store. Return a fresh store every time.

### A normalizer

```ts
import { normalizerContract } from "@openmatel/contract-tests";
import { claudeCodeNormalizer } from "./normalizer.js";
import { fixtures } from "./fixtures.js";

normalizerContract("claude-code v1", claudeCodeNormalizer, fixtures);
```

`fixtures` are `RawRecord`s — the raw samples of your source, desensitized.

### A bus

```ts
import { busContract } from "@openmatel/contract-tests";
import { createPgBus } from "./bus.js";

busContract("pg", async () => createPgBus());
```

### A pull source

```ts
import { pullSourceContract } from "@openmatel/contract-tests";
import { readFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { claudeCodeSource } from "./source.js";

pullSourceContract(
  "claude-code",
  (dir) => claudeCodeSource(join(dir, "session.jsonl")),
  async (dir, lines, mode = "append") => {
    const path = join(dir, "session.jsonl");
    if (mode === "overwrite") await writeFile(path, lines.join("\n") + "\n");
    else await appendFile(path, lines.map((line) => line + "\n").join(""));
  },
);
```

The `writeFile` helper has to write into the file your source reads:

- `"overwrite"` replaces the file — the suite uses it to set a file up and to
  truncate or rewrite it;
- `"append"` adds the lines to the end of the file — the suite uses it to
  check that appended lines are picked up.

The suite passes `"overwrite"` when it sets a file up and when it truncates or
rewrites it, and `"append"` when it checks that appended lines are picked up.

## What the suites check

### Sink + Query (`sinkQueryContract`)

| Check | Meaning |
| --- | --- |
| Round trip | The events that were written come back unchanged (the order does not matter, the event set does). |
| Idempotency | Writing the same batch twice does not duplicate events. |
| Convergence | A child step written before its parent, and a `turn.end` written before its `turn.start`, produce the same session tree. |
| Usage | `null` stays `null` and `0` stays `0` — in the events *and* in the `listSessions` summaries. The coverage is preserved. |
| Session filters | `source`, `has_error`, `text` (title) and the `from`/`to` range (`from` inclusive, `to` exclusive). |
| Pagination | `limit` 2 over 5 sessions: no duplicates, no gaps, ordered by `started_at` descending and then by `session_id` ascending. The cursor is stable. |
| Project isolation | A `project_id` filter never returns the sessions of another project. |
| Step filters | `listSteps` filters by `kind` (one or many) and by `status`. |
| Content | A step captured with `capture: "none"` comes back without any input or output text. |
| Unknown id | `getSession` returns `null` for an id that does not exist. |
| Aggregation | When the store implements the optional `aggregate` port, every stored event is counted. |

### Normalizer (`normalizerContract`)

| Check | Meaning |
| --- | --- |
| Validity | Every event passes `validateEvent` of `@openmatel/core`. |
| Determinism | The same record always yields the same `event_id` and the same event. |
| Uniqueness | Two different events never share an `event_id`. |
| Robustness | An unknown or garbage record never throws; it is dropped or kept as a single `raw.unknown` event. |
| Usage | Inside a usage object every token field is a number or `null` — never `undefined`. |

### Bus (`busContract`)

| Check | Meaning |
| --- | --- |
| Delivery | Every published event reaches the subscriber. |
| At-least-once | A batch whose subscriber threw is delivered again. |
| No order | The suite never relies on the order of the batches — the bus does not promise one. |

### Pull source (`pullSourceContract`)

| Check | Meaning |
| --- | --- |
| Existing files | The records of a file that is already there are emitted when the source starts. |
| Appends | Lines appended after the start are emitted as well (the suite polls for up to 3 seconds). |
| Checkpoints | Resuming from a checkpoint does not re-emit the records that were read. |
| Rotation | A file that was truncated or rewritten is read again from the start. |

## Documented tolerances

Two rules are not absolute, and the suites are explicit about it:

- **Re-emission after a checkpoint.** A source that re-reads a file it already
  read is tolerated when it re-emits the *very same* records — the derived
  `event_id`s stay stable and the idempotent sink collapses the duplicates.
  To get the strict check ("a resumed source emits nothing"), pass a
  `resume` hook:

  ```ts
  pullSourceContract("claude-code", factory, writeRecords, {
    resume: (dir, cursor) => claudeCodeSource(join(dir, "session.jsonl"), cursor),
  });
  ```

- **Ordering.** Neither the bus nor the pull source promises an order, and
  the suites do not assert one. A store that wants a stable session order
  defines it itself: `started_at` descending, `session_id` ascending.

## Reference implementation

The package ships a reference implementation of the ports, so a new adapter
can be compared against a known-good behaviour:

```ts
import { createMemoryBus, createMemoryStore } from "@openmatel/contract-tests";

const store = createMemoryStore();
await store.sink.write(events);
const session = await store.query.getSession(session_id);
```

`createMemoryStore()` keeps the events in memory, is idempotent by
`event_id` and derives the summaries and the turn/step tree with
`summarizeSession` and `buildSessionTree` of `@openmatel/core`.
`createMemoryBus()` delivers at-least-once, with a bounded number of
retries so that a broken subscriber cannot keep a test process alive.
`createFileSource()` is a pull source that reads a JSONL file, polls it and
detects a truncated or rewritten file.

## Shared fixtures

`makeEvent(partial)` builds one valid `oma.agentobs.v1` event; the fields it
does not get are filled with stable defaults, and the default `event_id` is
derived from the partial itself.

`sampleSessions(projectId)` returns the events of the canonical sample
session: two turns, `llm.call` steps with usage that mixes known values,
real zeros and a completely missing usage, a successful and a failed
`tool.call`, a nested child step, a `subagent.spawn` and a `plan.update`.

## Running the suites in CI

The suites are ordinary Vitest tests, so the adapter's own `pnpm test` runs
them. Add the adapter to the contract-test matrix of the pull request — a
contract that only runs in a feature branch is not merged.
