# `@openmatel/ui`

React 19 data boundary for OpenMaTel. It has no store, server or router
dependency: data arrives through the `ObsClient` injected by `<ObsProvider>`,
and navigation is a plain callback.

```tsx
import { ObsProvider, createObsClient } from "@openmatel/ui";

const client = createObsClient({ baseUrl: "http://127.0.0.1:4319" });

<ObsProvider client={client} navigate={(href) => history.pushState({}, "", href)}>
  …
</ObsProvider>;
```

Exports: `ObsProvider`, `createObsClient`, the `ObsClient` types, and the
dependency-free formatting helpers.

The old v0 `SessionDetail` and `StepTimeline` components (and their 800-line
stylesheet) were removed in openmatel#40 part B. Detail and timeline surfaces
are now the vendored OpenMA console components in
`@openmatel/oma-console-ui`. `styles.css` remains as a stable export but only
declares `color-scheme`, so no v0 component styling leaks into the console.
