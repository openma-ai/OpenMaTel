# `@openmatel/app`

The standalone OpenMaTel SPA. It uses React Router 7 and the vendored OpenMA
console shell from `@openmatel/oma-console-ui`:

- `/` redirects to `/sessions`
- `/sessions` is the cursor-paginated session list built on the console's
  `DataTable`, `FilterChip`, `FacetedFilter`, `Badge`, `StatusPill` and
  `EmptyState`, fed by `ObsClient`
- `/sessions/:id` is the console-shaped session detail: breadcrumb + title +
  chips, then the **Trajectory** view (the default): a fixed three-lane
  Input/Model/Tools minimap (duration modes, context watermark, wheel zoom,
  right-drag pan, brush filtering, visible-window rectangle), a virtualized
  fixed-height ledger with sticky turn headers, inline per-turn `TimelineView`
  waterfalls, tail loading and live follow, and a resizable Summary / Preview /
  Raw inspector. The layered **Turns** view keeps the segment grouping, turn
  summaries and per-turn waterfall; Conversation and the original full-session
  Timeline remain one toggle away.
  `src/adapter/to-managed-events.ts` adapts `oma.agentobs.v1` `AgentEvent`s to
  the managed event vocabulary; no trace renderer is forked.

```sh
pnpm --filter @openmatel/app build
```

Tailwind v4 is wired through `@tailwindcss/vite`; the console `index.css` is
imported verbatim from the vendored package, and this app's `src/index.css` only
adds `@source` roots for the vendored TSX and shims. Fonts are the same bundled
Geist Variable and JetBrains Mono Variable packages the console uses.

The build is a static `dist/` with relative asset URLs (`base: "./"`) plus a
root `<base>` element, so deep links such as `/sessions/ses_…` load their
assets. The CLI copies this directory into `packages/cli/dist/ui` and serves it
with no runtime dependencies.
