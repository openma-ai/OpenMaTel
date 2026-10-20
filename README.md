# OpenMaTel

**Agent-native observability for AI agents.** OpenMaTel is a standalone, MIT-licensed product: it works on its own, without any OpenMA component, and it runs with or without Cloudflare.

> **Status: pre-alpha.** This repository currently holds the design and the monorepo scaffold. No product code has been written yet — the package layout below is the plan, not what exists on disk. The full design document lives in [`docs/design.md`](./docs/design.md) (written in Chinese).

## Why agent-native, not LLM-call-centric

Most LLM observability tools are built around the model call: a trace is a tree of generations and spans, and the interesting part is the prompt and the token count. That framing does not survive contact with a real agent. What an agent does is run a **session** made of many **turns**, each turn made of many **steps** — tool calls, sandbox actions, subagent handoffs, permission requests, plan updates. The model call is just one step type among many.

OpenMaTel models the agent, not the model:

```
session ── turn ── step
                 ├─ llm          model call (one step type, not the centre of the model)
                 ├─ tool_call    name, input, output, error, duration, retries, approval
                 ├─ sandbox      shell command (exit code, stdout/stderr), file edit (diff), browser action
                 ├─ subagent     a child session with its own turns and steps
                 └─ plan         plan/todo updates, interrupt, compaction, resume
```

First-class, agent-native concepts:

- **Tool calls** carry their input, output, error, duration, retry count, permission approval and the harness-specific tool kind.
- **Sandbox / environment actions** are first-class steps: commands with exit codes and captured output, file edits with diffs, browser actions with URLs and screenshots.
- **Subagents and handoffs are child sessions**, not nested spans — they have their own turns and steps and can be opened on their own.
- **Session metadata** records the harness name and version, the ACP agent, the model, the working directory and the git branch.
- **Message content is part of the trace** — prompts, tool input/output, command output and diffs live next to the step they belong to, governed by per-project capture levels (`off` / `truncated` / `full`) and a redaction processor in front of them.

Data is collected from OTLP, ATIF, ACP `session/update` streams, a thin native SDK, and — importantly — by **reading local session files directly** (Claude Code, Codex, dsh, pi, …). Nothing needs to be instrumented before you can see it.

OTel GenAI and OpenInference are treated as **interchange formats** (import and export), not as the internal model. The internal model is a canonical agent event schema (`oma.agentobs.v1`).

## Three deployment tiers

Every tier is the same architecture with a different adapter behind the storage port. Nothing else changes.

| Tier | Scenario | Bus | Store | Processes |
|---|---|---|---|---|
| **Desktop** (default) | one user, one machine | in-process | **SQLite** (`node:sqlite`, WAL, FTS5) — zero native dependencies, **zero services** | a single process (`npx openmatel`) |
| **Team** (self-hosted) | small team, intranet, k8s | Postgres table queue | **Postgres** | stateless Node containers + Postgres |
| **Scale / hosted** | managed SaaS, large volume | Cloudflare Queues or NATS/Kafka | **ClickHouse** (trace data) + Postgres or D1 (control plane) | Workers or Node containers |

**Cloudflare is optional.** The same code runs on Cloudflare Workers (`runtime-cloudflare`) or on plain Node/Docker (`runtime-node`). Cloudflare is a deployment target, not a requirement: local-file sources need a filesystem and are therefore unavailable on Workers, but everything else works either way.

## Architecture principles

1. `core` holds only the domain model and the ports — zero dependencies, no IO, no platform specifics.
2. Everything else is an adapter that depends on `core`; `core` never depends back.
3. The pipeline is staged: **Source → Normalizer → Processor chain → Sink(s)**, connected by a Bus. Delivery is at-least-once; every event has a deterministic `event_id` and sinks upsert idempotently.
4. Writing (Sink) and reading (Query) are separate ports — a store can be write-only, read-only, or both.
5. The UI only talks to the HTTP Query API; it never touches a store.
6. Authentication, tenancy, storage and migrations are the service's own business. OpenMA is one integration among many, not a dependency.

## Planned package layout

From [`docs/design.md`](./docs/design.md) §3.2. Packages are added over time; the dependency guard in `scripts/check-deps.mjs` keeps the direction of the arrows honest.

```
packages/
  core/                 # domain model + ports + schema version + pure functions (step tree, usage, cost)
  contract-tests/       # the contract suite every adapter must pass (vitest, grouped by port)
  sources/              # otlp, atif, acp, sdk-http, claude-code, codex, dsh, pi, oma-local, openma-events
  normalizers/          # one normalizer per source, registered by schema version
  processors/           # redaction, capture-level, enrich-cost, enrich-harness, score-hook
  bus/                  # inproc (desktop), pg (team), cf-queues, nats / kafka (scale)
  stores/               # sqlite, duckdb, postgres, clickhouse, d1
  sinks/                # otlp-forward, parquet, atif-export
  blob/                 # local-fs, s3, r2
  auth/                 # project keys, orgs, members + plugin interface
  server/               # Hono app: ingest + query + auth, platform-agnostic
  runtime-node/         # Node entry point (single process or server mode, Docker image)
  runtime-cloudflare/   # Workers entry point (fetch + queue consumer + cron)
  ui/                   # @openmatel/ui React component library
  app/                  # standalone web UI (Vite SPA, served by the server)
  cli/                  # `npx openmatel`: local server + UI + local session scan
  sdk-js/ sdk-py/       # thin SDKs for canonical events or OTel GenAI
```

Composition (the dependency-injection root) exists in exactly three places: `runtime-node`, `runtime-cloudflare` and `cli`.

## Repository layout

```
.
├── docs/design.md          # the design document (Chinese)
├── packages/               # workspace packages (created as they are implemented)
├── scripts/check-deps.mjs  # dependency-direction guard (pnpm lint)
├── .github/workflows/ci.yml
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── vitest.config.ts
```

## Development

Requires Node.js >= 22.13 and pnpm 10.

```sh
pnpm install

pnpm lint       # dependency-direction guard
pnpm build      # build all packages
pnpm typecheck  # tsc -b
pnpm test       # vitest run
```

`pnpm lint` enforces the architecture rules mechanically: `packages/core` must have zero dependencies, no package may pull in OpenMA internals, and the UI must not depend on a store implementation.

## License

[MIT](./LICENSE) © 2026 openma-ai contributors
