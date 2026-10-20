# `@openmatel/ui`

React 19 component library for OpenMaTel. It has no store, server or router
dependency: data arrives through the `ObsClient` injected by `<ObsProvider>`,
and navigation is a plain callback.

```tsx
import { ObsProvider, SessionList, createObsClient } from "@openmatel/ui";
import "@openmatel/ui/styles.css";

const client = createObsClient({ baseUrl: "http://127.0.0.1:4319" });

<ObsProvider client={client} navigate={(href) => history.pushState({}, "", href)}>
  <SessionList />
</ObsProvider>;
```

Exports: `ObsProvider`, `SessionList`, `SessionDetail`, `StepTimeline`,
`createObsClient`, formatting helpers and the single `styles.css` stylesheet.
The stylesheet supports light and dark via `prefers-color-scheme`, uses rounded
rows with a 6px gap, and toggles `omt-fade-top` / `omt-fade-bottom` edge masks
only when a scroll area is cut off.
