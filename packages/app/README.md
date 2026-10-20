# `@openmatel/app`

The standalone OpenMaTel SPA. It uses React Router 7 and the vendored OpenMA
console shell from `@openmatel/oma-console-ui`:

- `/` redirects to `/sessions`
- `/sessions` is the cursor-paginated session list built on the console's
  `DataTable`, `FilterChip`, `FacetedFilter`, `Badge`, `StatusPill` and
  `EmptyState`, fed by `ObsClient`
- `/sessions/:id` keeps the existing `@openmatel/ui` detail component inside the
  console `Page` shell until part B replaces it

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
