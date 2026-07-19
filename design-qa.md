**Comparison Target**

> 本文中的 Google Stitch 仅指外部视觉参考来源；`output/` 路径里的 `stitch` 是既有验收证据文件名，不是当前产品品牌。当前用户可见品牌为“产品工作台”，内部产品标识为 `workbench`。

- Source visual truth:
  - `/var/folders/fm/x3l8kw2d7qd5k5_mc6v9m_2c0000gn/T/codex-clipboard-9c510768-eeb9-4d2a-aff9-f615c1dbc411.png` (play/preview entry)
  - `output/stitch-video-keyframes/t000.jpg` (home)
  - `output/stitch-video-keyframes/t180.jpg` (generating)
  - `output/stitch-video-keyframes/t210.jpg` (refining)
  - `output/stitch-video-keyframes/t300.jpg` (complete)
  - `output/stitch-video-frames/frame-151.jpg` (compact working Agent plus expanded task history)
  - `output/stitch-motion-audit/agent-working-crop-126-142.jpg` (expanded Agent color-orbit sequence)
  - `/var/folders/fm/x3l8kw2d7qd5k5_mc6v9m_2c0000gn/T/codex-clipboard-401f449f-dd54-4652-adac-9275ed81c668.png` (reported compact Agent color mismatch)
  - `output/stitch-video-keyframes/t400.jpg` (document)
  - `output/playwright/live-stitch-project-export-1920.png` (export drawer empty state)
- Primary implementation screenshot: `output/playwright/pc-left-status-fixed-1501x855.png`
- Preview implementation screenshot: `output/browser/pc-project-preview-1280x720.png`
- Export implementation screenshots: `output/browser/pc-export-empty-1280x720.png` and `output/browser/pc-export-selected-1280x720.png`
- Latest Agent implementation sequence: `output/stitch-motion-qa/final-agent-compact-6frames.jpg`
- Viewport: `1501x855`, desktop, device scale factor 1.
- State: 产品工作台 complete state at 63% zoom. Additional home, generating, refining, document, and 1280-1920 desktop captures were checked.

**Full-View Comparison Evidence**

- Home: `output/playwright/comparison-home-final-source-left-local-right.png`
- Play entry and resulting preview state: `output/browser/comparison-project-preview-source-left-local-right.png`
- Generating: `output/playwright/comparison-generating-verified-source-left-local-right.png`
- Refining: `output/playwright/comparison-refining-verified-source-left-local-right.png`
- Complete: `output/playwright/comparison-complete-verified-source-left-local-right.png`
- Document: `output/playwright/comparison-document-final-source-left-local-right.png`

**Focused Comparison Evidence**

- Complete-state controls and composer: `output/playwright/comparison-complete-focused-controls.png`
- Generated screen composition: `output/playwright/comparison-complete-focused-screens.png`
- Home title and composer: `output/playwright/comparison-home-focused-composer.png`
- Left status source/local full-view comparison: `output/stitch-motion-audit/source-local-left-status-1501x855.jpg`
- Corrected left status expanded state: `output/playwright/pc-left-status-fixed-1501x855.png`
- Corrected left status at the minimum requested PC viewport: `output/playwright/pc-left-status-fixed-1280x720.png`
- Home pointer-grid idle state: `output/playwright/pc-home-pointer-idle-final-1501x855.png`
- Home pointer-grid focused state: `output/playwright/pc-home-pointer-focus-final-1501x855.png`
- Canvas after simulated horizontal trackpad pan: `output/playwright/pc-canvas-trackpad-pan-1501x855.png`
- Home composer after surface, style, model, and refresh interactions: `output/playwright/pc-home-composer-click-events-1501x855.png`
- Project preview at the sign-in success tab: `output/browser/pc-project-preview-1280x720.png`
- Document loading state: `output/browser/pc-document-loading-animation-1280x720.png`
- Document loaded state: `output/browser/pc-document-loaded-animation-1280x720.png`
- Document loading comparison: `output/browser/comparison-document-loading-source-left-local-right.png`
- UI generation sequence: `output/browser/pc-ui-generating-seq-0.png`, `output/browser/pc-ui-generating-seq-1.png`, `output/browser/pc-ui-generating-seq-2.png`
- Full motion sequence comparison, source on top and local on bottom: `output/browser/comparison-motion-sequence-source-top-local-bottom.png`
- Latest local sequence: `output/browser/pc-motion-0-of-3.png`, `output/browser/pc-motion-1-of-3.png`, `output/browser/pc-motion-2-of-3.png`, `output/browser/pc-motion-3-of-3.png`, `output/browser/pc-motion-complete.png`
- Export empty-state panel, source left and local right: `output/browser/comparison-export-panel-normalized-source-left-local-right.png`. The source's taller empty body was symmetrically cropped while preserving the 56px header and 58px footer so both responsive panels compare at the local 280x560 frame without scaling typography or controls.
- Compact Agent color state, source left and implementation right: `output/stitch-motion-qa/agent-compact-source-vs-implementation.jpg`.
- Compact Agent full-cycle implementation sequence: `output/stitch-motion-qa/final-agent-compact-6frames.jpg`.
- Final 1280x720 PC frame: `output/stitch-motion-qa/final-agent-1280x720.jpg`.
- Agent and task-panel border sequence at 1280x720: `output/stitch-motion-qa/border-motion-final-3frames.jpg`.

**Findings**

- No actionable P0, P1, or P2 mismatches remain for the requested PC-only frontend clone.
- Fonts and typography: size, weight, hierarchy, wrapping, and compact control labels track the reference closely. 产品工作台 uses the repository font stack rather than bundling the external reference service's proprietary font; visible drift is minor.
- Spacing and layout rhythm: top bar, 280px left panels, 580px project composer, generated screens, right rail, bottom utility controls, and 16px edge spacing align with the reference. No horizontal or vertical document overflow was detected at 1920x1080, 1501x855, 1440x900, 1366x768, or 1280x720.
- Colors and visual tokens: the canvas base is `RGB 30/30/32`, matching the sampled reference. Generating document brightness is within four RGB luminance points of the reference sample. The Agent card now stays on a near-black gray base and moves localized low-saturation blue-cyan and gray-purple light across the surface and border instead of retaining the reported fixed black-to-green split.
- Image quality and asset fidelity: the generated screen mockups remain sharp at all tested PC sizes. The home inspiration thumbnails intentionally use local synthetic mock visuals instead of copying source/reference assets into the app.
- Copy and content: product-specific labels are unified under 产品工作台, while the source reference's navigation, model, status, and canvas hierarchy is preserved where it affects interaction.
- Interaction states: home style/model menus, prompt submission, generating/refining/complete phases, document input, share/export drawers, zoom menu, 10% overview, node selection, pointer-grid highlight, the unified Agent-log disclosure, Agent-card disclosure, task cancellation, history selection, and prompt copy were exercised successfully. No application page errors were emitted.
- Left-panel state fidelity: source frames `31-37`, `151`, and `168-173` establish one bottom-anchored task/log disclosure plus an independent top Agent card. The implementation now follows that state machine: collapsed mode renders exactly one summary row, expanded mode renders the active pill, history rows, and a fixed Agent-log footer, and only the white double-dot control collapses the upper card. The prompt row no longer contains the non-source chevron.
- Left-panel sizing and motion: at `1501x855`, the lower panel settles at `52px` collapsed and `216px` with three history rows, while the upper card settles at `64x52` collapsed and `280x126` expanded. Runtime sampling captured lower-panel expansion at `52 -> 137.43 -> 195.70 -> 212.86 -> 216px` and upper-card expansion at `64x52 -> 95.40x62.76 -> 202x99.27 -> 256.76x118.03 -> 280x126`, proving visible intermediate frames rather than class-only animation.
- Task-history interaction: every history row is a real button with hover and pressed states. Selecting a row crossfades the corresponding transcript and expands the Agent card from `126px` to `326px`; selecting it again returns to the live task. The selected prompt exposes only the source-matched copy control.
- Preview interaction: the top-right play button opens a full-screen local preview, all three screen tabs switch, refresh replays the entrance motion, and both `Esc` and the explicit close/return controls exit to the editor. No backend, deployment, or remote preview service is involved.
- Agent working motion: checked against `output/stitch-motion-audit/agent-working-crop-126-142.jpg` and compact source frames `143-151`. The verified source motion is a localized blue-cyan/gray-purple surface wash plus a separately orbiting border highlight and the small rotating status ring; the white double-dot capsule and body copy remain stable. Six implementation frames sampled every `700ms` show the same dark-to-blue-cyan-to-gray-purple cycle, and the treatment remains active in generated complete state while `Creating prototype...` is visible.
- Left-panel border motion: the Agent card now uses a visible in-bounds `1.5px` cyan/purple conic highlight orbit, while the task/log panel uses a separate lower-contrast `1px` orbit with a slower period. Runtime sampling over `260ms` changed the Agent border angle from about `496deg` to `523deg` and the task-panel border from about `377deg` through the wrap to `35deg`. The task border continues animating in its collapsed `280x52` state.
- Document generation motion: checked against source frames `frame-023.jpg` through `frame-025.jpg`. The local flow now renders the source sequence: thinking/working state, selected empty document with a pulsing `Loading document...` label, then a short fade/vertical settle into the complete PRD. The adjacent Agent panel shows the source-matched working explanation and rotating `Saving updates` status during loading.
- Three-screen UI generation: checked against source frames `frame-128.jpg` through `frame-142.jpg`. The initial PRD surfaces now have a clearly visible gray/cyan/purple moving wash, then reveal dark screens in the source order: center at `1/3`, right at `2/3`, left at `3/3`. The first visible reveal starts after roughly 2.2 seconds instead of leaving a nearly static six-second interval.
- Runtime animation verification: continuous effects were tested through computed-style deltas rather than class presence. Across a 240ms sample, the Agent conic border changed from `293.926deg` to `358.535deg`, the generation beam moved from `-90.75px` to `156.79px`, the stage sweep moved from `-895.53px` to `-657.72px`, and the project composer border changed from `153.89deg` to `189.54deg`. In complete state, the screen ambient, trophy scale/y, and reward-button sheen all changed across the same sampling window. The document loading pulse changed opacity from `0.85962` to `0.932977`.
- Home submit motion: within the 760ms transition window, the composer border advanced from `143.053deg` to `158.113deg`, while the submit spinner transform changed from `matrix(0.402452, 0.915441, -0.915441, 0.402452, 0, 0)` to `matrix(-0.844257, 0.535938, -0.535938, -0.844257, 0, 0)`.
- Progress synchronization: `generationProgress` now directly controls screen mounting. Captured states are `generating/0`, `refining/1`, `refining/2`, `refining/3`, and `complete/3`; each progress state reveals exactly one additional screen in center, right, left order.
- Export drawer fidelity: source measurement at `1920x902` is `x=1568, y=80, width=280, height=742`, equivalent to `top/right/bottom = 80/72/80`. Runtime checks produced the same geometry at 1920, plus `280x695` at 1501x855 and `280x560` at 1280x720. The panel uses the sampled `#1c1d1f` surface, compact 14px header, 32px pill footer button, and has no backdrop or canvas blur.
- Export selection flow: opening the drawer initializes an independent empty export selection even when a canvas node already has a purple editing selection. While open, clicking a node or `全选` changes the drawer to the compact selected state without closing it; closing and reopening returns to empty. Figma, HTML/CSS, React, and MCP targets update the pressed state and CTA copy, and the CTA provides frontend-only completion feedback.
- Local simulated login: the development-only `模拟登录` control was exercised from `/login`; it creates the existing local preview session and navigates to the 产品工作台 home without calling the production authentication backend.

**Patches Made Since Previous QA Pass**

- Unified the home and project surfaces on `--workbench-bg` and passed the same background into both React Flow background layers.
- Corrected refining to reveal light generated screens before the dark complete state.
- Removed the transformed-canvas backdrop blur that caused mirrored Chromium texture artifacts.
- Calibrated generating document luminance against the source frame.
- Preserved independent project input drafts and input keyboard behavior.
- Replaced the incorrect independent task/history/log accordions with the source-matched unified, bottom-anchored task stack; the Agent-log footer now owns disclosure, collapsed mode renders only one summary bar, and the upper Agent card remains independently controlled by its white double-dot capsule.
- Replaced the non-visible task-stack height interpolation with an explicit browser height transition and verified multiple runtime intermediate dimensions in both directions.
- Added source-matched task-history selection, transcript crossfade, prompt-copy feedback, and active-task cancellation without introducing a backend dependency.
- Replaced the home hover fog with a 145px masked bright-dot layer aligned to the static 14px grid, scoped only to the interactive home backdrop.
- Enabled React Flow free-direction trackpad panning while preserving `Z + scroll` zoom and native trackpad pinch zoom.
- Completed the home composer click surface with mock attachment chips, command insertion, surface/style/model selection, prompt refresh, and submit feedback.
- Activated the project play control with a desktop preview shell, local screen navigation, refresh motion, and keyboard/visible exit paths.
- Extended the source-matched Agent border/status animation to every `generating` and `refining` phase and removed unverified dot/text motion experiments.
- Added the source-matched PRD loading node and content reveal transition instead of displaying the completed document immediately.
- Strengthened the source-matched PRD surface sweep and synchronized dark-screen reveal timing with the `0/3` through `3/3` progress states.
- Replaced non-running Framer infinite keyframes with native CSS animations for document wash, generation beam, loading pulse, generated-screen ambient drift, success trophy/points, and reward-button sheen.
- Bound generated-screen reveal directly to progress, animated progress text changes, kept the project composer border active while busy, strengthened Agent/stage/surface motion, and removed the complete-state loading spinner.
- Removed generated-node position/width jumps at completion; completion now settles through the React Flow viewport animation, selection treatment, and ready Toast.
- Rebuilt the export surface around the source-measured 280px right drawer, removed the blocking `bg-black/48` backdrop, and kept the canvas interactive while export is open.
- Decoupled export selection from the editor's existing node selection, added empty/select-all/node-select/reset behavior, and compressed the selected controls and CTA into the same narrow shell.
- Restored a development-only simulated login entry that uses the existing local preview credentials and session storage path without a backend dependency.
- Removed the stale utility background layers from the Agent card so the source-matched animated surface owns the rendered colors, then recalibrated the wash toward muted blue-cyan and gray-purple with smaller moving regions and an independent conic border orbit.
- Restarted the local preview after confirming the previous 3010 process was serving an older compiled stylesheet; the current page now loads the same Agent rules present on disk.
- Replaced the two left panels' static utility borders with masked in-bounds animated borders so overflow clipping cannot hide the moving highlights; the upper and lower panels use intentionally different intensity and duration.

**Implementation Checklist**

- [x] Same-state 1501x855 source/implementation comparisons.
- [x] Focused composer, controls, and generated-screen comparisons.
- [x] Five PC viewport captures from 1280 to 1920.
- [x] Frontend-only interaction smoke test.
- [x] Play/preview open, tab switch, refresh, and Escape-close browser checks.
- [x] Export empty, canvas-select, select-all, target switch, completion, close, and reopen-reset browser checks.
- [x] Development simulated-login navigation check.
- [x] Left-panel collapsed/expanded runtime dimension sampling and 1280x720 overlap check.
- [x] History selection, transcript crossfade, prompt copy, and upper Agent disclosure checks.
- [x] Compact Agent six-frame color-cycle capture and same-size source/implementation comparison.
- [x] Upper Agent collapse/re-expand check after color changes (`280x126 -> 64x52 -> 280x126`).
- [x] Agent and task/log border-angle delta checks, three-frame visual capture, and collapsed task-border continuity check.
- [x] TypeScript check and `git diff --check`.

**Follow-up Polish**

- P3: Replace the synthetic home inspiration thumbnails with separately generated bitmap artwork if closer content-level resemblance becomes a priority.
- P3: Capture more exact source timestamps if frame-perfect progress-counter timing is required beyond the current middle-right-left reveal order.
- P3: Capture the live original after selecting an exportable screen when the Google Stitch reference is reachable again; the supplied original evidence proves the drawer shell and empty state, but not the internal selected-state target list.

final result: passed
