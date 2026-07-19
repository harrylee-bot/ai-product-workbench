# Prototype editor kernel boundary

This directory is the repository-owned boundary around the Selecto/Moveable editor adapter mounted by the production 产品工作台 Prototype renderer. The renderer and all exporters consume the same Prototype transform contract; third-party gesture state never becomes persisted product state.

- `react-selecto@1.26.3` owns hit testing and DOM selection behind the adapter.
- `react-moveable@0.56.0` owns drag, resize, rotate handles, snapping-capable geometry, mouse, and touch normalization behind the adapter.
- Both packages are MIT licensed and have no paid runtime or hosted service requirement.
- Neither package declares a React peer-version contract. The React 19 mount test passes, but that is compatibility evidence rather than an upstream guarantee.
- `react-kernel-adapter.tsx` is the only third-party boundary. It converts library events into repository-owned snapshots immediately.
- Gesture frames emit preview batches only. Drag/resize/rotate end emits one atomic repository-owned batch suitable for one persistence transaction and one undo entry.
- `model.ts` converts the renderer's centered translation and zoom into document coordinates, then deterministically maps snapshots to repository-owned `transform.patch` commands. No library event, CSS transform string, matrix array, or library type enters the IR.
- Selected node ids are filtered against the current document and screen before DOM targets are resolved. If an ancestor and descendant are both requested, only the top-level ancestor remains so a group transform cannot be applied twice.
- `@scena/matrix@1.1.1` is a direct dependency used only behind plain repository-owned geometry types. It composes nested parent transforms, calculates a stable group pivot, and projects each rotated world transform back into the node's parent-local `x`, `y`, and final angle.

`workbench.prototype.v1` is the first greenfield Prototype contract and requires `style.rotation` plus `style.transformOrigin` on every node. Rotation is a clockwise, parent-local, final absolute angle normalized to `[-180, 180)`. Transform origin is a pair of border-box fractions in `[0, 1]`. There are no missing-field defaults, v0/v1 upcasters, or CSS-string persistence paths.

Single-node rotation seeds Moveable at gesture start from the current IR angle and writes only the final static angle, so it also works for flow nodes. Group rotation freezes a versioned IR baseline, rotates the selected world-space bounds around one pivot, and atomically writes each absolute node's parent-local `x`, `y`, and angle. Group rotation fails closed before commit for screen roots, flow geometry, token-backed selected coordinates, missing nodes, or cross-screen input. `transformOrigin` is preserved by rotation commands.

The packages can directly own pointer capture, rectangle hit testing, multi-selection, transform handles, snapping, and mouse/touch gesture normalization. Persistence, coordinate conversion, atomic commands, undo boundaries, token policy, and IR validation must remain in the thin repository-owned adapter/model.

Before hard cut, browser gates must still verify nested React Flow pan/zoom arbitration, real mouse and touch gestures, scroll containers, snapping and guidelines, keyboard selection, and visual handle placement at desktop/mobile zoom extremes. Unit fixtures cover non-zero rotate starts, final absolute angles, sibling and differently rotated-parent group projection, atomic revision changes, canonical selection, and schema round trips. Upstream event-shape and geometry changes remain the main upgrade risk, so versions are exact and persistence mapping stays isolated here.

A production-grade hand-built equivalent would likely take roughly 4-8 engineer-weeks plus browser stabilization. Reusing these kernels should reduce this slice to roughly 1.5-3 engineer-weeks for the IR change, adapter, integration, and browser gates. This is a planning estimate, not measured delivery time.
