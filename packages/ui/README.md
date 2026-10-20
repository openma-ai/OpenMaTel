# `@openmatel/ui`

React 19 data boundary and detail/timeline components for OpenMaTel. It has no
store, server or router dependency: data arrives through the `ObsClient`
injected by `<ObsProvider>`, and navigation is a plain callback.

```tsx
import { ObsProvider, SessionDetail, createObsClient } from "@openmatel/ui";
import "@openmatel/ui/styles.css";

const client = createObsClient({ baseUrl: "http://127.0.0.1:4319" });

<ObsProvider client={client} navigate={(href) => history.pushState({}, "", href)}>
  <SessionDetail sessionId="ses_…" />
</ObsProvider>;
```

Exports: `ObsProvider`, `SessionDetail`, `StepTimeline`, `createObsClient`,
formatting helpers and the single `styles.css` stylesheet. The session list is
now built by `@openmatel/oma-console-ui` on the vendored OpenMA console
`DataTable`; the old `SessionList` component and its custom list CSS were
removed. The remaining stylesheet supports light and dark via
`prefers-color-scheme` and toggles `omt-fade-top` / `omt-fade-bottom` edge masks
only when a scroll area is cut off.
