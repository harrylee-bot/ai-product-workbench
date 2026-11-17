# react-swarm-rebuild

A swarm of colorful cursors reconstructs your React UI. React 18 / 19, TypeScript, ESM and CommonJS. MIT, Nguyễn Quốc Cường.

![React Swarm Rebuild — animated reconstruction demo](https://raw.githubusercontent.com/nqcuongcnq/react-swarm-rebuild/master/assets/demo.gif)

[Source code](https://github.com/nqcuongcnq/react-swarm-rebuild) · [npm](https://www.npmjs.com/package/react-swarm-rebuild) · [Report an issue](https://github.com/nqcuongcnq/react-swarm-rebuild/issues)

## Quick start

```tsx
import { useRef } from 'react';
import { SwarmRebuild } from 'react-swarm-rebuild';

export function Dashboard({ loading, children }) {
  const content = useRef<HTMLDivElement>(null);
  return <>
    <div ref={content}>{children}</div>
    <SwarmRebuild target={content} ready={!loading} />
  </>;
}
```

By default, cursors fade into a buoyant orbit, wait for your content, then reconstruct it with colored typing carets and parallel workers. Workers waiting for another task move toward upcoming work areas and float there instead of gathering around the user's mouse. After the last task, they fan radially out of the covered area and the real UI is revealed. There is no default toolbar or visible skip button. Click/tap anywhere inside the effect, or press **Esc**, to skip immediately.

Rulers and red alignment/measurement guides are **off by default**. Component targets only cover their own visible area; the surrounding header, sidebar and controls remain available.

## Loading and the transition into reconstruction

1. The overlay covers the target immediately. Cursors fade in while your original React tree stays mounted and loads underneath.
2. `ready={false}` keeps the cursors orbiting. Set it to `true` after your data and fonts have settled; this does not restart the orbit.
3. Once ready and the minimum intro has elapsed, the library measures the DOM cooperatively across animation frames. The cursors keep floating during this work.
4. A short handoff slows the orbit. Workers depart with staggered timing and retain their departure velocity instead of snapping to a new trajectory.
5. Boxes/media are drawn and text is typed. Idle workers gently drift near their previous position while waiting for their next assignment.
6. All cursors leave directly from their current positions in a radial burst. They do not regroup at the center. The cover fades back to the live UI and is removed.

`snapshotBudget` controls the approximate measurement budget per frame. Smaller budgets leave more time for cursor movement but take more frames to prepare the snapshot. A single DOM/media operation may exceed that budget. It is a scheduling budget, not a guaranteed frame-time limit.

For an application entrance with no initial content flash, start the imperative controller in `useLayoutEffect`, after the DOM has mounted and before the first browser paint:

```tsx
import { useLayoutEffect, useRef } from 'react';
import { createSwarmRebuild } from 'react-swarm-rebuild';
import type { SwarmController } from 'react-swarm-rebuild';

export function Overview({ ready, children }) {
  const target = useRef<HTMLDivElement>(null);
  const controller = useRef<SwarmController | null>(null);

  useLayoutEffect(() => {
    const swarm = createSwarmRebuild({ target, ready: false });
    controller.current = swarm;
    swarm.start();
    return () => {
      swarm.destroy();
      controller.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    let cancelled = false;
    controller.current?.setReady(false);
    if (!ready) return;
    Promise.resolve(document.fonts?.ready).then(() => {
      if (!cancelled) controller.current?.setReady(true);
    });
    return () => { cancelled = true; };
  }, [ready]);

  return <div ref={target}>{children}</div>;
}
```

The declarative `SwarmRebuild` component uses `useEffect` for server-rendering compatibility. The opaque cover is installed synchronously by `start()`. `fadeIn` fades the cursors/decorations over that cover, so the real page does not flash through while it loads.

## Motion options

All of these work as React props or imperative/hook options. The visual enhancements default to **on**; the two measuring aids default to **off**.

| Option | Default | Behavior |
| --- | --- | --- |
| `showRulers` | `false` | Horizontal and vertical rulers along the covered area |
| `showGuides` | `false` | Red alignment guides and red duplicate-distance measurements |
| `clickToSkip` | `true` | Click/tap the covered area to reveal the UI immediately |
| `floatingIntro` | `true` | Slowly rotating orbit with independent bobbing and breathing motion |
| `floatingIdle` | `true` | Idle workers drift near their last position or next queued task; `false` restores mouse-following flock behavior |
| `floatAmplitude` | `1` | Intro/idle movement amplitude multiplier, 0.25–3; defaults to stronger, wider oscillations |
| `floatSpeed` | `1` | Intro/idle movement speed multiplier, 0.25–3; defaults to faster independent oscillations |
| `parallelDrawing` | `true` | Start child/duplicate tasks while their backing surfaces are underway; `false` waits for complete ancestors |
| `smoothTransition` | `true` | Soft orbit-to-work handoff and staggered departures |
| `transitionDuration` | `480` | Handoff duration, real milliseconds, 0–3,000 |
| `fadeIn` | `true` | Fade in cursors, the intro symbol and optional controls |
| `fadeInDuration` | `360` | Entrance duration, real milliseconds, 0–3,000 |
| `typing` | `true` | Reveal text by grapheme and use each worker's colored I-beam cursor |
| `typingSpeed` | `45` | Graphemes per animation second, 5–300, multiplied by `speed` |
| `burstOnComplete` | `true` | Radial cursor exit before automatically going live |
| `exitDuration` | `700` | Radial exit duration, real milliseconds, 0–3,000 |
| `snapshotBudget` | `4` | Approximate DOM measurement budget per frame, milliseconds, 1–12 |

Typing carets use measured glyph positions and move to the next line as text wraps. Where `Intl.Segmenter` is available, combining marks, Vietnamese accents and emoji sequences are typed as complete graphemes. Other browsers fall back to Unicode code points. Text keeps its original font size throughout; there are no stepped heading-size changes. Individual text-task durations are clamped to 0.35–8 animation seconds to keep unusually long nodes bounded. With `typing={false}`, text fades into place with an arrow cursor.

Colorful selection outlines around boxes/media are independent of rulers and red guides. They remain part of the reconstruction when `showRulers` and `showGuides` are off.

A full configuration, showing the defaults explicitly:

```tsx
<SwarmRebuild
  target={content}
  ready={!loading}
  showRulers={false}
  showGuides={false}
  clickToSkip
  floatingIntro
  floatingIdle
  smoothTransition
  transitionDuration={480}
  fadeIn
  fadeInDuration={360}
  typing
  typingSpeed={45}
  burstOnComplete
  exitDuration={700}
  snapshotBudget={4}
/>
```

Disable enhancements independently, or turn the measuring aids back on:

```ts
const swarm = createSwarmRebuild({
  target: '#overview',
  showRulers: true,
  showGuides: true,
  floatingIntro: false,       // Uniform orbit.
  floatingIdle: false,        // Follow the user's mouse while idle.
  smoothTransition: false,    // Skip the handoff and staggered delays.
  fadeIn: false,              // Cursors appear immediately.
  typing: false,              // Fade complete text instead of typing.
  burstOnComplete: false,     // Remove the overlay immediately on completion.
  clickToSkip: false,         // Esc and imperative goLive() still work.
});
```

A component-scoped burst is clipped at the component's boundary. Cursors never fly across its header/sidebar or block other components. Explicit `finishBehavior: 'flock'` keeps the workers floating after completion and bypasses the automatic burst/removal; click/tap or `goLive()` ends that mode.

## Concurrent work and cursor count

`cursorCount` sets the worker-pool size, independently of playback `speed`. It is available on `SwarmRebuild`, `useSwarmRebuild`, and `createSwarmRebuild`. The default is 16; values are constrained to whole numbers from 2 to 48.

```tsx
<SwarmRebuild
  target={content}
  ready={!loading}
  cursorCount={24}
  parallelDrawing
  floatAmplitude={1.2}
  floatSpeed={1.15}
/>
```

```ts
const swarm = createSwarmRebuild({ target: '#overview', cursorCount: 24 });
swarm.start();
swarm.setCursorCount(32); // Add workers without restarting the overlay.
swarm.setCursorCount(8);  // Free workers leave; busy excess workers finish first.
```

Changing the React `cursorCount` prop also resizes the existing pool. Growing the pool fades in the new workers. Shrinking it preserves any drawings already in flight, so the actual `state.agents` count can temporarily exceed the requested count until those workers finish. Changes during the radial exit apply to the next run.

The scheduler preserves DOM stacking order while allowing more work to overlap. With `parallelDrawing: true`, a child becomes eligible after its backing surface reaches 15% draw progress; duplicate tasks become eligible after their source reaches 35%. Text and media still remain hidden until their own cursor reaches them and starts drawing. Set `parallelDrawing: false` to restore strict parent/source completion ordering.

The number actually drawing at once depends on available tasks and their dependencies. Workers with no eligible task stage near distinct upcoming tasks, with wider, faster, independently phased floating motion. They do not paint fake content while waiting. `floatAmplitude` and `floatSpeed` tune the waiting motion independently of reconstruction playback speed.

In the Lexor Admin integration, **Theme → Concurrent cursors** chooses 2–48 workers (default 24), saves the value in `localStorage`, and updates the running effect without restarting it. No account or server setting is changed.

## Other options

| Option | Default | Purpose |
| --- | --- | --- |
| `target` | `document.body` | Selector, HTMLElement or React ref |
| `scope` | `target` for components, `viewport` for body | Component clipping or full-viewport effect |
| `ready` | `true` | Wait for application content before measuring |
| `finishBehavior` | `live` | Burst and remove automatically, or keep `flock` |
| `controls` | `false` | `true` for a full playback toolbar; `minimal` for status only, without a skip button |
| `cursorCount` | `16` | 2–48 concurrent workers; can change during a run |
| `speed` | `1` | Reconstruction/typing multiplier, 0.25–8 |
| `introDuration` | `1600` | Minimum orbit time in animation milliseconds; also waits for `ready` |
| `sound` | `false` | Optional synthesized audio, subject to browser audio policy |
| `tour` | `false` | Auto-scroll the document in viewport mode |
| `showNames` | `false` | Optional collaborator names |
| `names`, `colors` | Built-in palette | Custom nonempty arrays |
| `maxLayers` | `2500` | Snapshot limit, 1–10,000 |
| `background` | Nearest opaque ancestor | Cover background color |
| `zIndex` | `2147483000` | Overlay stacking order |
| `respectReducedMotion` | `true` | Skip all motion when the user requests reduced motion |
| `active` | `true` | React component only: start/stop when this changes |

Entrance, handoff, floating motion and radial exit use real time. `speed` affects reconstruction, typing and the minimum intro clock; it does not make the buoyant drift or radial exit abruptly faster.

`ready`, `cursorCount`, `speed`, `sound`, and `tour` update an existing React instance. Other options apply to the next start/replay. Use one active instance per target.

## Scope, skipping and cleanup

A component target is intersected with its viewport and scrolling/clipping ancestors. The cover intercepts clicks only inside that area. Header/sidebar clicks outside it keep their normal behavior and do not skip the effect. Clicking the cover removes it on the click event, so the same click cannot activate a covered application link/button.

With `clickToSkip`, the covered area is also keyboard-focusable and supports **Enter**/**Space**. **Esc** always closes the effect. There is no focus trap for component-scoped effects. Full-toolbar buttons still perform their own actions rather than triggering click-to-skip.

Offscreen content is omitted from component snapshots, so an inner scrolling container cannot prevent completion. Scrolling, changing the viewport width, removing the target, or changing scoped geometry during reconstruction reveals the live UI or disposes the run. This avoids stale geometry. The next start captures the new layout.

`stop()`, `goLive()`, `destroy()`, React unmount and `active={false}` cancel measurement and animation, including an in-progress handoff or radial exit. Reduced motion skips directly to the live UI without creating an overlay.

## Controller and callbacks

```ts
const swarm = createSwarmRebuild({ target: '#overview', ready: false });
swarm.start();
// Render/load data in parallel, then:
swarm.setReady(true);
// On navigation:
swarm.destroy();
```

`useSwarmRebuild(options)` exposes the same controller plus reactive `state`. Methods: `start`, `replay`, `stop`, `goLive`, `pause`, `resume`, `setReady`, `setCursorCount`, `setSpeed`, `setSound`, `setTour`, `getState`, `destroy`. A destroyed imperative instance cannot be restarted. The React hook handles Strict Mode and unmount cleanup.

Callbacks:

- `onStateChange(state)`: phase/progress updates, limited to roughly seven per second during animation, plus phase transitions.
- `onComplete()`: called once when all captured layers have been reconstructed, **before** the radial exit. Also called when reduced motion skips reconstruction.
- `onError(error)`: target or snapshot errors. The overlay is removed on snapshot failure.

State fields: `phase`, `progress`, `completed`, `total`, `agents`, `speed`, `sound`, `tour`. Phases: `idle`, `scanning`, `intro`, `transition`, `building`, `paused`, `complete`, `exiting`, `live`.

Watch `phase === 'live'` to know that the automatic exit has finished and the overlay is gone. A skipped run does not call `onComplete()`. `pause()` freezes the animation, including a handoff or exit; `resume()` continues it.

## 0.3.0

- Fix SVG/media descendants escaping hidden snapshot layers before their own drawing starts.
- Preserve CSS `rotate`, `scale` and 2D/3D `transform` groups during reconstruction so tilted/scaled elements and their text are drawn and typed in place without snapping at completion.
- Merge inline formatting flows (`<strong>`, `<em>`, `<a>`, `<br>`, adjacent JSX text nodes), gradient-clipped text (`background-clip: text`), ellipsis clipping and form field values into cohesive typing tasks.
- Curved cursor flight paths with velocity banking, diagonal 2D surface reveal, human typing cadence, and randomized scatter trajectories on completion.
- Resize the cursor pool during a run with `setCursorCount` or the React prop.
- Parallelize work across partially drawn surfaces and stage waiting cursors near upcoming tasks.
- Stronger, faster floating motion with `floatAmplitude` and `floatSpeed` controls.
- Lexor Admin adds a local-only concurrent cursor count in Theme.

## 0.2.0

- Rulers/red guides are opt-in; toolbar is hidden by default.
- Click/tap the effect to skip, without a visible skip button or click-through.
- Buoyant intro and local idle drift; smooth, staggered handoff with cooperative snapshots.
- Grapheme-aware typewriter text and colored carets that follow actual line geometry.
- Fade-in entrance and radial cursor exit, with independent options and durations.

## 0.1.1

- Component-scoped overlays preserve surrounding layout and interactions.
- Orbit before snapshot; readiness can change while data renders in parallel.
- Automatic cleanup on completion, including inner scrolling containers.

Inspired by Swarm by Joel Califa and Swarm Cursors by Dhvanil Patel. This is an independent implementation; no upstream code or artwork is bundled. See [NOTICE.md](./NOTICE.md).
