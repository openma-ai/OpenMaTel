# `@openmatel/app`

The standalone OpenMaTel SPA. It wraps `@openmatel/ui` in a two-route shell
(`/` and `/sessions/:id`) using the History API and no router dependency.

```sh
pnpm --filter @openmatel/app build
```

The build is a static `dist/` with relative asset URLs (`base: "./"`) plus a
root `<base>` element, so deep links such as `/sessions/ss_…` load their
assets. The CLI copies this directory into `packages/cli/dist/ui` and serves it.
