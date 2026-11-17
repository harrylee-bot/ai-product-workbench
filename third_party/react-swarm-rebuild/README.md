# React Swarm Rebuild derivative

Upstream: https://github.com/nqcuongcnq/react-swarm-rebuild

Pinned commit: `0d3e04eba408ea7ad4fd47aecbd0b1a7c634a233` (package 0.3.1).
License: MIT, Copyright (c) 2026 Nguyễn Quốc Cường. Full license and upstream attribution are preserved here. The exact source originals and their hashes are in `upstream/` and `manifest.json`.

Workbench uses the upstream engine, spring/curved cursor movement, crosshair boxes and dimension badges, duplicate choreography, Unicode typing and caret measurement, alignment guides, scoped DOM snapshotting, and reduced-motion/lifecycle handling. Runtime derivatives are under `apps/web/components/studio/swarm/`.

Changes: source-node identity on measured layers; incremental projection reconciliation that retains unchanged in-flight cursor tasks; unchanged layers revealed immediately; latest pending snapshot replaces older pending work; noninteractive, aria-hidden drawing layer; no keyboard interception in projection mode; pause suspends animation frames. `DraftProjection` supplies actual validated generation nodes, lazy loads the engine, exposes a disable control, suspends background tabs and bounds each active burst to two seconds. The final sandboxed iframe is never snapshotted or modified. No model/API credentials, new service, or remote scripts are involved.

The upstream React wrapper is preserved only as original source. Workbench owns its integration wrapper. Audio and full playback controls remain in the attributed engine but are disabled in this integration. Cursor count is a visual worker pool, never a model or collaborator count.

The Swarm Cursors extension and original Swarm site are visual references only. Their code/assets are not imported; this package's MIT license does not cover them. See `NOTICE.md`.

Run `npm run studio:source-check` to verify pinned originals and runtime attribution. When updating, fetch a separate checkout, review license/source differences, update hashes and derivatives, and rerun browser projection/lifecycle tests.

Live text updates preserve a common grapheme prefix and reveal the first changed grapheme when the snapshot lands. Text cursor travel and the remaining typing are bounded separately (120/200 ms real time) and run alongside box drawing. The two-second burst cleanup does not relax the product's event-to-visible-frame P95 of 500 ms. Dimension badges convert measured zoomed geometry back to page CSS px. Performance evidence measures the visible overlay text plus paint opportunities separately from the covered underlying DOM.
