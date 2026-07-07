# Design QA

Date: 2026-07-07

## Target

Replicate the Stitch workbench UI from the provided video/screenshots inside the local Next app. The latest user direction supersedes the earlier generic three-column shell: follow Stitch directly, keep the layout fixed at a 1440px stage, use a real canvas library, remove unused prototype residue, and proceed from outer page style to inner canvas interactions.

## Current Implementation

- Live route: `/chat/local-stitch`
- Entry component: `apps/web/components/chat/shell.tsx`
- Stitch implementation: `apps/web/components/stitch/stitch-workbench.tsx`
- Canvas foundation: `@xyflow/react` / ReactFlow
- Animation: Framer Motion plus scoped CSS transitions
- Outer layout: `1440px × 900px` centered stage, with a `1920px × 1200px` Stitch design plane scaled by `0.75`
- Project interaction model: `home → project board → selected/focus`, with ReactFlow nodes for the canvas board.
- Current pass focuses on outer visual shell first: home page, canvas page top bar, left panel, right tool rail, and bottom composer.

## Cleanup Pass

- Removed old `apps/web/src` Stitch deliverables from the earlier plan.
- Removed old `/public/stitch-assets` and `/public/stitch-reference` screenshot/image artifacts.
- Removed the old `stitch:sync-reference` script and generated-reference pipeline.
- Live UI no longer mounts the old generic `Projects / Assets / Community` sidebar or right `Properties` panel.
- Live UI no longer mounts an iframe, a remote reference artboard, or a large copied screenshot as the canvas content.
- Removed the unused `ActiveChatProvider` wrapper from the Stitch preview route so the static UI does not poll conversation/message/runtime APIs.

## Verification

- `npm --workspace @ai-product-workbench/web run typecheck`: passed.
- `npm --workspace @ai-product-workbench/web run lint`: passed.
- `npm --workspace @ai-product-workbench/web run build`: passed.
- Playwright 1920x900 project state:
  - stage: `x=240`, `width=1440`, `height=900`
  - ReactFlow present: `true`
  - board state: `7` `stitchTile` nodes, `0` artboard nodes, zoom text `10%`
  - after clicking a tile: `0` tile nodes, `1` artboard node, zoom text `100%`
  - focus-state shader canvas present: `x=593`, `y=120`, `width=900`, `height=600`
  - iframe count: `0`
  - large image count: `0`
  - old generated DOM markers: `false`
  - old reference artboard marker: `false`
  - console errors after reload and project open: `0`
- Playwright 1440x900 project state:
  - stage: `x=0`, `width=1440`, `height=900`
  - document scroll width: `1440`
  - ReactFlow present: `true`
- Playwright 1366x900 project state:
  - document scroll width: `1440`
  - `window.scrollX` can move to `74`
  - ReactFlow present: `true`

## Artifacts

- 1920px project capture: `output/playwright/stitch-clean-reactflow-1920x900.png`
- 1920px board capture: `output/playwright/stitch-reactflow-board-1920x900.png`
- 1920px focus capture: `output/playwright/stitch-reactflow-focus-1920x900.png`
- 1920px home outer-style pass: `output/playwright/stitch-home-outer-v2-1920x900.png`
- 1920px canvas outer-style pass: `output/playwright/stitch-canvas-outer-v2-1920x900.png`
- 1366px scroll capture: `output/playwright/stitch-clean-reactflow-1366x900.png`

## Remaining Gaps

- Full Stitch parity is not complete yet. The current pass establishes the clean fixed-layout workbench and real canvas foundation.
- The next pass should continue from outer to inner: home composer/sidebar micro-spacing, canvas board thumbnail fidelity, then export/share panels, node context menus, drag/resize handles for board tiles, and more detailed canvas interactions.
- Live Stitch production JS/CSS bundles were not copied into this project. Public Stitch SDK/exported screen artifacts may be used as references, but the local implementation remains rewritten code.

Final result: foundation pass completed; full 1:1 all-pages/all-interactions replication remains in progress.
