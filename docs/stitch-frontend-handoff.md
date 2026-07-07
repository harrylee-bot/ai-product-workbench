# Stitch Frontend Handoff

Date: 2026-07-07
Branch: `codex/stitch-frontend-handoff`

## Project State

The local frontend currently routes the chat surface to a Stitch-style prototype shell.

Implemented screens:

- Home screen
- Project board screen
- Selected frame / focused canvas screen

Implemented interactions:

- Home project item click opens the project board.
- Home prompt submit opens the focused canvas screen and runs a mock generation state.
- Project board thumbnails are ReactFlow nodes.
- Clicking a board thumbnail opens the focused canvas screen.
- Tool rail selection changes local active tool state.
- Share and Export buttons open local dialogs.

## Local Access

- Route: `/chat/local-stitch`
- Local URL: `http://localhost:3000/chat/local-stitch`
- Login fallback account: `stitch@local.dev`
- Login fallback password: `stitch123456`

## Main Files

- `apps/web/components/stitch/stitch-workbench.tsx`
  - Main Stitch prototype implementation.
- `apps/web/components/chat/shell.tsx`
  - Mounts the Stitch prototype.
- `apps/web/app/(chat)/layout.tsx`
  - Provides the fixed-size app surface wrapper.
- `apps/web/app/globals.css`
  - Contains Stitch-related tokens, fixed layout behavior, and scoped workbench styles.
- `apps/web/lib/auth/nest-auth.tsx`
  - Contains the local non-production login fallback.
- `apps/web/package.json`
  - Adds the ReactFlow dependency.
- `apps/web/tailwind.config.mjs`
  - Enables Tailwind `important: true`.

## Layout State

- Outer stage is fixed at `1440px x 900px`.
- The inner design plane is `1920px x 1200px` scaled by `0.75`.
- The page is centered on screens wider than `1440px`.
- Screens narrower than `1440px` use horizontal scrolling.

## Current Implementation Boundary

The prototype is frontend-only.

- Data is mocked in `apps/web/components/stitch/stitch-workbench.tsx`.
- Canvas behavior uses `@xyflow/react`.
- Generation states are local timers.
- Share/export actions are local UI only.

## Commands

```bash
npm --workspace @ai-product-workbench/web run dev
npm --workspace @ai-product-workbench/web run typecheck
npm --workspace @ai-product-workbench/web run lint
npm --workspace @ai-product-workbench/web run build
```
