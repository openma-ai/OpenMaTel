# `@openmatel/oma-console-ui`

Source-only package containing the Open Managed Agents console UI that
OpenMaTel's web app reuses. The files under `vendor/` are copied **verbatim**
from `apps/console/src` in
[openma-ai/open-managed-agents](https://github.com/openma-ai/open-managed-agents)
(Apache-2.0); the files under `shims/` are small local replacements for
modules that expect OpenMA accounts, tenants, plugins or a hosted API.

`packages/app` consumes this package through Vite/TypeScript path aliases;
there is no JavaScript build step. Typecheck with:

```sh
pnpm --filter @openmatel/oma-console-ui typecheck
```

## Updating the vendored files

`manifest.json` is the complete file list. Regenerate the vendored tree from a
checkout of the upstream repository:

```sh
node scripts/sync-oma-console.mjs --from /path/to/open-managed-agents
```

The script copies every manifest path from `apps/console/src`, applies the
patches in `patches/`, and writes `vendor/PROVENANCE.md` with the upstream
commit and a SHA-256 for each file. Do not edit `vendor/` by hand.

Verify the checked-in tree without the upstream checkout (CI does this):

```sh
node scripts/sync-oma-console.mjs --check
```

## Vendored trace + conversation surface

Part B of openmatel#40 vendors the console's actual trace renderers rather
than reimplementing them:

- `components/timeline/TimelineView.tsx` (+ `derive.ts`, `eventTime.ts`,
  `types.ts`) — turn cards, waterfall spans, zoom auto/fit/± and the
  “source events” JSON side panel;
- `components/session/ManagedSessionConversation.tsx` and
  `CanonicalSessionTurn.tsx` — the conversation transcript built on the
  published `@openma/common/chat-ui` `AgentChatView`;
- `components/Badge.tsx` and `components/icons.tsx` — the header chips and
  status pill;
- `lib/events.ts` and `lib/format.ts` — the managed event shape plus
  `formatDuration` / `formatRelative` / `shortenId`.

The OpenMaTel data adaptation lives in `packages/app/src/adapter/to-managed-events.ts`;
no vendored trace file is modified to understand `oma.agentobs.v1`.

## Patches

- `patches/0001-sidebar-sessions-only.patch` — restricts the vendored
  `AppSidebar` to the one route OpenMaTel has (Sessions) and removes the
  now-empty command-palette trigger. Everything else in that file is upstream.

## Shims

The vendored files import these console modules; Vite aliases and TypeScript
`rootDirs` redirect them to `shims/` without changing the vendored bytes:

| Import | Shim | Purpose |
| --- | --- | --- |
| `../lib/auth` | `shims/lib/auth.tsx` | always-authenticated single local user |
| `../lib/branding` | `shims/lib/branding.ts` | product name `OpenMaTel`, no deployment logo |
| `../lib/theme` | `shims/lib/theme.ts` | class-based light/dark/system theme |
| `../lib/route-chords` | `shims/lib/route-chords.ts` | only `g s` → `/sessions` |
| `../i18n` | `shims/i18n/index.ts` | English strings from the vendored `i18n/en.ts` |
| `../plugins/registry` | `shims/plugins/registry.ts` | empty plugin registry |
| `./TenantSwitcher` | `shims/components/TenantSwitcher.tsx` | OpenMaTel / Local identity slot |
| `./UserProfile` | `shims/components/UserProfile.tsx` | Local footer + theme toggle |
| `./CommandPalette` | `shims/components/CommandPalette.tsx` | no palette in a single-route console |
| `../Markdown` | `shims/components/Markdown.tsx` | upstream needs `react-markdown` + `lowlight`; the shim renders through `@openma/common/chat-ui` `ChatMarkdown` |
| `../ai-elements/tool` | `shims/components/ai-elements/tool.tsx` | upstream needs `shiki` + shadcn select/collapsible + `ai` types; the shim keeps the same `Tool`/`ToolHeader`/`ToolContent`/`ToolInput`/`ToolOutput` surface with semantic markup |

Both renderer shims exist only because their upstream dependency stacks are
not part of OpenMaTel's app; the trace timeline and conversation controller
themselves are the unmodified upstream components.

## License

Apache-2.0. See [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE). Vendored
modifications are listed in `patches/` and recorded in
[`vendor/PROVENANCE.md`](./vendor/PROVENANCE.md).
