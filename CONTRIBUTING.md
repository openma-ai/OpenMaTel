# Contributing to OpenMaTel

Thanks for your interest in OpenMaTel. The project is **pre-alpha** — the design is settled, the code is not written yet — so early contributions that shape the foundations are especially welcome.

## Ground rules

- **Every change goes through an issue and a pull request.** Open an issue first, describe the problem and the proposed solution, then branch from `main` and open a PR that links the issue. Issues with a proposed approach get discussed before the code is written.
- **No direct pushes to `main`.** `main` is protected; every change lands via a pull request from a topic branch.
- **CI must be green before a PR is merged.** Every PR runs the full pipeline on Linux and macOS against Node 22 and Node 24: dependency-direction lint, build, typecheck and tests. A red CI run blocks the merge.
- **Squash merge.** PRs are merged as a single squashed commit with a clear message (`feat: …`, `fix: …`, `docs: …`, `chore: …`). The PR body is the place for detail; the squashed commit message is the place for the summary.

## Workflow

1. **Open an issue** describing the change, the motivation, and any API or schema impact.
2. **Branch** from an up-to-date `main`: `git checkout -b feat/short-description`.
3. **Implement** the change. Keep the diff focused on the issue; unrelated refactors belong in their own PR.
4. **Run the local checks** — they are the same ones CI runs:

   ```sh
   pnpm install
   pnpm lint
   pnpm build
   pnpm typecheck
   pnpm test
   ```

5. **Open the PR**, link the issue, explain what changed and how it was verified. Add a short note in the description if you changed a public API, an event schema or a contract-test expectation.
6. **Wait for CI.** A maintainer squash-merges once the pipeline is green and the review has no outstanding comments.

## Adapters must pass the contract tests

Any new adapter — a source, a normalizer, a sink, a store, a bus, an auth provider — must implement the corresponding port from `@openmatel/core` **and** pass the shared contract suite in [`packages/contract-tests`](./packages/contract-tests). The suite is the contract: it is grouped by port and every adapter runs the same expectations, so behaviour cannot silently diverge between implementations.

For example, a new store has to satisfy the Sink and Query contracts:

- **Sink** — writing the same batch twice yields the same result (idempotent by `event_id`); events arriving out of order (a child before its parent) converge to the same state; a `usage` value of `null` stays `null` and never becomes `0`.
- **Query** — the same fixtures produce the same results on every read/write store: session trees, step filtering, error hotspots, usage coverage, stable pagination; no content is returned when the capture level is `off`.

Add your adapter to the contract-test matrix in the same PR. A contract test that only runs in your own branch is not merged.

## Dependency rules (enforced by `pnpm lint`)

`scripts/check-deps.mjs` fails the build when the architecture is violated. These are hard rules, not style preferences:

- **`packages/core` has zero dependencies.** No runtime dependencies at all, and no dependency on any workspace package. Core holds the domain model and the ports; everything else depends on it, never the other way around.
- **No OpenMA internals.** No package may depend on a package whose name contains `openma` outside the `@openmatel/*` scope. OpenMaTel is a standalone product and must work without any OpenMA component.
- **The UI never touches a store.** `packages/ui` must not depend on any `@openmatel/store-*` package — it talks to the server over the HTTP Query API only.

## Commit messages and style

- Conventional-ish prefixes: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`, `build:`, `ci:`.
- Match the surrounding code style. The repository uses TypeScript in strict mode with ESM and NodeNext resolution; there is no formatter config yet, so keep your diff consistent with the file you are editing.
- Write tests for new behaviour. Tests live next to the code they cover and are picked up by the root Vitest configuration (`packages/**/*.test.ts`).

## Reporting bugs

Open an issue with the version, the platform, the tier you are on (desktop / team / scale) and the smallest reproduction you can manage. For a data problem, a redacted event or session excerpt is worth far more than a description.

## Security

Please do not open a public issue for a security problem. Contact the maintainers privately first and give them time to release a fix before disclosing it.

## License

Contributions are accepted under the [MIT License](./LICENSE). By submitting a pull request you agree that your contribution is licensed under it.
