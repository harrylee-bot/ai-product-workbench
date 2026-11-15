# Onlook frontend derivative

Upstream: https://github.com/onlook-dev/onlook

Pinned commit: `423e2e924366419e418ee049093872d535eea41a`.
License: Apache-2.0, Copyright 2024 On Off, Inc. Full license in `LICENSE.md`.

This is a source derivative of Onlook's editor, integrated with Workbench business services. It does not run the full Onlook application or use its sandbox, Supabase, billing, code-indexing or AI orchestration services. Source imports are recorded with SHA-256 in `manifest.json`; `upstream/` preserves exact originals for reviewing patches and rebasing.

## Modified runtime modules

| Upstream component | Derived component under `apps/web/components/studio/onlook/` | Changes |
| --- | --- | --- |
| project Main | main.tsx | Component composition retained; bottom-center conversation; panels reserve visible space; authorization/loading owned by project route |
| DesignPanel | design-panel.tsx | Rail and exclusive context panel; business tabs; click/keyboard instead of hover-only expansion |
| Canvas | canvas.tsx | Bounded zoom and pan, coordinate transforms and wheel handling retained; one frozen frame; pointer capture; keyboard movement; exact zoom anchor replaces upstream empirical Y offset |
| BaseRect, HoverRect | base-rect.tsx, hover-rect.tsx | SVG geometry overlay; blue selection; geometry comes from validated opaque iframe messages |
| ChatInput | chat-input.tsx | IME and keyboard input, growth, drag/drop and clipboard file intake; domain controls; no queue or sandbox AI calls; preserves typing during generation |
| ProjectCardPresentation | project-card.tsx | Project card and action composition; backend project shape; semantic buttons; reduced-motion default |
| DeviceSelector + device constants | device-selector.tsx, devices.ts | Pinned device catalogue, controlled viewport size and orientation; native accessible selection; frozen-preview boundary |
| Input + DraftableInput | input.tsx, draftable-input.tsx | Shared input styles, draft/commit semantics; blur/Enter and IME; Escape restores without committing; auth and preview fields |

Other pinned files (layer row, action buttons and panel measurement) are reference source pending adaptation, not claimed as active runtime reuse. `hover-rect.tsx` is included but currently BaseRect handles both hover and selection.

Business-specific plan/approval/version/feedback/knowledge/export UI is implemented against this product's shared contracts. This derivative is not affiliated with or endorsed by Onlook. No upstream brand assets are used.

## Updating

Fetch upstream into a separate local checkout, inspect its license and changes, compare each original hash, then apply and test changes to the corresponding derivative. Do not replace the service boundary with upstream credentials or cloud endpoints. Update the manifest and this ledger with actual reused modules.

Run `npm run studio:source-check` to verify upstream hashes and derivative attribution.
