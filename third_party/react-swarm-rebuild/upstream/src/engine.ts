import { SwarmAudio } from './audio';
import { backgroundColor, visibleBounds } from './bounds';
import { clamp, finite, stepSpring } from './math';
import { cursorMarkup, NAMES, PALETTE, styles } from './presentation';
import { layerPoint, snapshotSteps, type Layer, type Snapshot } from './snapshot';
import type { SwarmController, SwarmOptions, SwarmPhase, SwarmState } from './types';

interface Worker {
  node: HTMLDivElement; selection: HTMLDivElement; badge: HTMLSpanElement;
  index: number; angle: number; scale: number;
  x: number; y: number; vx: number; vy: number;
  fromX: number; fromY: number; fromVx: number; fromVy: number;
  travel: number; curve: number; elapsed: number; duration: number;
  idleX: number; idleY: number; idleTime: number; delay: number;
  exitX: number; exitY: number; exitCurveX: number; exitCurveY: number; exitAngle: number;
  task?: Layer; pending?: Layer; color: string; retiring: boolean; bornAt: number;
}
const smooth = (t: number) => { const x = clamp(t, 0, 1); return x * x * (3 - 2 * x); };
export const initialState = (options: SwarmOptions = {}): SwarmState => ({ phase: 'idle', completed: 0, total: 0, progress: 0, agents: 0, speed: finite(options.speed, 1, .25, 8), sound: options.sound ?? false, tour: options.tour ?? false });

/** Create an imperative instance. Safe to import during SSR; call in the browser. */
export function createSwarmRebuild(options: SwarmOptions = {}): SwarmController {
  let state = initialState(options);
  let host: HTMLDivElement | undefined, shadow: ShadowRoot | undefined;
  let cover: HTMLDivElement, stage: HTMLDivElement, workersRoot: HTMLDivElement, intro: HTMLDivElement;
  let status: HTMLSpanElement, progress: HTMLDivElement, help: HTMLDivElement;
  let workers: Worker[] = [], layers: Layer[] = [];
  let frame = 0, last = 0, elapsed = 0, lastEmit = 0;
  let destroyed = false, active = false, previousFocus: HTMLElement | null = null;
  let savedPhase: SwarmPhase = 'building';
  let pointer = { x: 0, y: 0 }, cleanup: (() => void)[] = [];
  let viewportWidth = 0, viewportHeight = 0;
  let target: HTMLElement, scoped = false, ready = options.ready !== false;
  let bounds: DOMRect, capturedBounds: DOMRect | undefined;
  let snapshotTaken = false;
  let captureSteps: Generator<void, Snapshot> | undefined;
  let motionTime = 0, entranceTime = 0, transitionTime = 0, exitTime = 0;
  let desiredCount = Math.floor(finite(options.cursorCount, 16, 2, 48)), nextWorkerId = 0;
  const audio = new SwarmAudio();
  const getState = () => ({ ...state });
  const emit = () => {
    if (host) host.dataset.swarmPhase = state.phase;
    updateToolbar(); options.onStateChange?.(getState());
  };
  const listen = (target: EventTarget, name: string, handler: EventListener, settings?: AddEventListenerOptions) => {
    target.addEventListener(name, handler, settings);
    cleanup.push(() => target.removeEventListener(name, handler, settings));
  };
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent?: Node) => {
    const node = document.createElement(tag); node.className = className; parent?.appendChild(node); return node;
  };
  function setPhase(phase: SwarmPhase) { state.phase = phase; emit(); }
  function updateToolbar() {
    if (!shadow) return;
    if (status) status.textContent = state.phase === 'scanning' ? 'Scanning page…' : state.phase === 'intro' ? ready ? 'Gathering the swarm…' : 'Preparing content…' : state.phase === 'transition' ? 'Preparing the canvas…' : state.phase === 'exiting' ? 'Ready.' : state.phase === 'complete' ? 'Built.' : `${state.completed} / ${state.total} layers`;
    if (progress) progress.style.width = `${state.progress * 100}%`;
    const update = (action: string, text: string, pressed?: boolean) => {
      const button = shadow!.querySelector<HTMLButtonElement>(`[data-action="${action}"]`);
      if (button) { button.textContent = text; if (pressed !== undefined) button.setAttribute('aria-pressed', String(pressed)); }
    };
    update('speed', `${state.speed}×`);
    update('sound', state.sound ? '♪ On' : '♪ Off', state.sound);
    update('tour', 'Tour', state.tour);
    update('pause', state.phase === 'paused' ? 'Resume' : 'Pause', state.phase === 'paused');
    if (help) help.textContent = state.phase === 'complete' ? 'Move your mouse · Go live to use the page' : 'Scroll to build more · Esc to exit';
  }
  function dispose() {
    const restoreFocus = !!shadow?.activeElement;
    active = false;
    captureSteps?.return(undefined as never); captureSteps = undefined;
    if (frame) window.cancelAnimationFrame(frame);
    frame = 0;
    cleanup.splice(0).forEach(fn => fn());
    host?.remove(); host = undefined; shadow = undefined;
    workers = []; layers = [];
    audio.setEnabled(false);
    if (restoreFocus && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    previousFocus = null;
  }
  function stop() { dispose(); state.agents = 0; setPhase('idle'); }
  function goLive() { dispose(); state.agents = 0; setPhase('live'); }
  function pause() {
    if (!active || state.phase === 'paused' || state.phase === 'scanning') return;
    savedPhase = state.phase; setPhase('paused');
  }
  function resume() { if (state.phase === 'paused') { last = performance.now(); setPhase(savedPhase); } }
  function setSpeed(speed: number) { state.speed = finite(speed, state.speed, .25, 8); emit(); }
  function setSound(enabled: boolean) { state.sound = enabled; audio.setEnabled(enabled && active); emit(); }
  function setTour(enabled: boolean) { state.tour = enabled; emit(); }
  function setReady(value: boolean) {
    ready = value;
    if (!value && captureSteps) {
      captureSteps.return(undefined as never); captureSteps = undefined;
      capturedBounds = undefined;
      // Drop partial geometry if data became pending again before handoff.
      for (const node of Array.from(stage.children)) {
        if (!node.classList.contains('selection')) node.remove();
      }
    }
  }
  function toolbar() {
    if (!options.controls) return;
    const minimal = options.controls === 'minimal';
    const bar = element('div', minimal ? 'toolbar minimal' : 'toolbar', shadow);
    bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', 'Swarm rebuild controls');
    if (minimal) {
      bar.style.pointerEvents = 'none';
      status = element('span', 'status', bar);
      status.setAttribute('role', 'status');
      return;
    }
    const avatars = element('div', 'avatars', bar);
    PALETTE.slice(0, 5).forEach(color => { const avatar = element('span', 'avatar', avatars); avatar.style.background = color; });
    status = element('span', 'status', bar);
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const track = element('div', 'track', bar); progress = element('div', 'fill', track);
    element('div', 'divider', bar);
    const actions: [string, string, () => void][] = [
      ['pause', 'Pause / resume animation', () => state.phase === 'paused' ? resume() : pause()],
      ['tour', 'Toggle automatic scrolling', () => setTour(!state.tour)],
      ['speed', 'Change playback speed', () => setSpeed(state.speed >= 3 ? 1 : Math.floor(state.speed) + 1)],
      ['sound', 'Toggle sound', () => setSound(!state.sound)],
      ['replay', 'Replay animation', start],
      ['live', 'Go live', goLive],
      ['close', 'Close animation', stop],
    ];
    actions.forEach(([action, label, handler]) => {
      const button = element('button', action === 'live' ? 'live' : '', bar);
      button.type = 'button'; button.dataset.action = action;
      button.setAttribute('aria-label', label); button.title = label;
      button.textContent = ({ replay: 'Replay', live: 'Go live', close: '×' } as Record<string, string>)[action] ?? action;
      listen(button, 'click', handler);
    });
    help = element('div', 'help', shadow);
  }
  function resolveTarget(): HTMLElement {
    const target = options.target;
    const resolved = typeof target === 'string' ? document.querySelector(target) : target && 'current' in target ? target.current : target ?? document.body;
    if (!(resolved instanceof HTMLElement) || !resolved.isConnected) throw new Error('Swarm target must be a connected HTMLElement. Check your selector or ref.');
    return resolved;
  }
  function start() {
    if (destroyed) return;
    if (typeof window === 'undefined' || typeof document === 'undefined') throw new Error('Start Swarm Rebuild in a browser effect or event handler.');
    dispose();
    try { target = resolveTarget(); }
    catch (error) { setPhase('idle'); options.onError?.(error as Error); if (!options.onError) throw error; return; }
    state = { ...state, phase: 'scanning', completed: 0, total: 0, progress: 0, agents: 0 };
    if (options.respectReducedMotion !== false && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      state.progress = 1; setPhase('live'); options.onComplete?.(); return;
    }
    scoped = options.scope === 'target' || (options.scope !== 'viewport' && target !== document.body && target !== document.documentElement);
    viewportWidth = window.innerWidth; viewportHeight = window.innerHeight;
    bounds = scoped ? visibleBounds(target) : new DOMRect(0, 0, viewportWidth, viewportHeight);
    capturedBounds = undefined; snapshotTaken = false; captureSteps = undefined;
    motionTime = 0; entranceTime = 0; transitionTime = 0; exitTime = 0;
    pointer = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height * .46 };
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    host = document.createElement('div');
    host.setAttribute('data-swarm-overlay', '');
    host.style.cssText = `all:initial;position:fixed;inset:0;display:block;z-index:${finite(options.zIndex, 2147483000, 0, 2147483647)};isolation:isolate;`;
    host.style.pointerEvents = 'none';
    host.dataset.swarmScope = scoped ? 'target' : 'viewport';
    shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style'); style.textContent = styles; shadow.append(style);
    cover = element('div', 'cover', shadow);
    cover.style.background = options.background ?? backgroundColor(target);
    stage = element('div', 'stage', cover);
    stage.inert = true;
    stage.setAttribute('aria-hidden', 'true');
    workersRoot = element('div', 'workers', shadow);
    workersRoot.setAttribute('aria-hidden', 'true');
    intro = element('div', 'intro', shadow); intro.textContent = '↗';
    intro.setAttribute('aria-hidden', 'true');
    toolbar();
    document.documentElement.append(host);
    updateBounds();
    active = true; elapsed = 0; last = performance.now(); lastEmit = 0;
    listen(window, 'pointermove', ((event: PointerEvent) => { pointer = { x: event.clientX, y: event.clientY }; }) as EventListener, { passive: true });
    listen(window, 'keydown', ((event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); stop(); }
      if ((!scoped || shadow?.activeElement) && event.key.toLowerCase() === 'm' && !event.ctrlKey && !event.metaKey && !event.altKey) setSound(!state.sound);
      if (event.key === 'Tab' && shadow && !scoped) {
        const buttons = Array.from(shadow.querySelectorAll<HTMLButtonElement>('button'));
        if (!buttons.length) return;
        const index = buttons.indexOf(shadow.activeElement as HTMLButtonElement);
        event.preventDefault();
        buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus();
      }
    }) as EventListener);
    if (options.clickToSkip !== false) {
      cover.style.cursor = 'pointer';
      cover.tabIndex = 0;
      cover.setAttribute('role', 'button');
      cover.setAttribute('aria-label', 'Skip animation');
      listen(cover, 'click', event => {
        // Remove on click, not pointerdown, so the released click cannot
        // activate a link/button in the real application underneath.
        event.preventDefault(); event.stopPropagation(); goLive();
      });
      listen(cover, 'keydown', ((event: KeyboardEvent) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault(); event.stopPropagation(); goLive();
        }
      }) as EventListener);
    }
    // A fresh snapshot after layout changes avoids stale geometry. Ignore mobile browser chrome height changes.
    listen(window, 'resize', () => {
      if (Math.abs(window.innerWidth - viewportWidth) > 2) { if (scoped) goLive(); else start(); }
      else viewportHeight = window.innerHeight;
    }, { passive: true });
    audio.setEnabled(state.sound);
    emit();
    if (scoped) {
      // Once geometry is captured, scrolling reveals the real UI instead of
      // animating stale positions or blocking the surrounding application.
      listen(document, 'scroll', () => { if (snapshotTaken || captureSteps) goLive(); }, { capture: true, passive: true });
    }
    createWorkers();
    setPhase('intro');
    frame = window.requestAnimationFrame(tick);
  }
  function updateBounds() {
    if (!host) return;
    bounds = scoped ? visibleBounds(target) : new DOMRect(0, 0, window.innerWidth, window.innerHeight);
    if (scoped) {
      host.style.clipPath = `inset(${bounds.top}px ${Math.max(0, window.innerWidth - bounds.right)}px ${Math.max(0, window.innerHeight - bounds.bottom)}px ${bounds.left}px)`;
      host.style.setProperty('--swarm-left', `${bounds.left}px`);
      host.style.setProperty('--swarm-top', `${bounds.top}px`);
      host.style.setProperty('--swarm-width', `${bounds.width}px`);
      host.style.setProperty('--swarm-height', `${bounds.height}px`);
      host.style.setProperty('--swarm-center-x', `${bounds.left + bounds.width / 2}px`);
      host.style.setProperty('--swarm-center-y', `${bounds.top + bounds.height * .46}px`);
      host.style.setProperty('--swarm-bottom', `${window.innerHeight - bounds.bottom + 16}px`);
    }
  }
  function prepareSnapshot() {
    if (!captureSteps) {
      capturedBounds = bounds;
      captureSteps = snapshotSteps(target, stage, finite(options.maxLayers, 2500, 1, 10000), scoped ? bounds : undefined);
    }
    const deadline = performance.now() + finite(options.snapshotBudget, 4, 1, 12);
    try {
      do {
        const next = captureSteps.next();
        if (!next.done) continue;
        layers = next.value.layers;
        state.total = layers.length;
        snapshotTaken = true; captureSteps = undefined;
        workers.forEach(worker => {
          stage.append(worker.selection);
          worker.fromX = worker.x; worker.fromY = worker.y;
          worker.idleX = worker.x; worker.idleY = worker.y; worker.idleTime = 0;
          worker.delay = options.smoothTransition === false ? 0 : worker.index * .022;
        });
        if (options.showGuides === true) {
          const positions = [...new Set(layers.filter(layer => layer.kind === 'text').map(layer => Math.round(layer.x)))].slice(0, 5);
          positions.forEach(x => { const guide = element('div', 'guide', shadow); guide.style.left = `${x - window.scrollX}px`; });
        }
        intro.style.transition = options.smoothTransition === false ? 'none' : '';
        transitionTime = 0;
        setPhase(options.smoothTransition === false ? 'building' : 'transition');
        return;
      } while (performance.now() < deadline);
    } catch (error) {
      stop(); options.onError?.(error as Error);
      if (!options.onError) console.error('[react-swarm-rebuild]', error);
    }
  }
  function makeWorker(index: number, count: number): Worker {
    const colors = options.colors?.length ? options.colors : PALETTE;
    const names = options.names?.length ? options.names : NAMES;
    const color = colors[index % colors.length];
    const node = element('div', 'worker', workersRoot);
    node.style.setProperty('--color', color);
    node.innerHTML = cursorMarkup(color);
    if (options.showNames === true) { const name = element('span', 'name', node); name.textContent = names[index % names.length]; }
    const selection = element('div', 'selection', stage);
    selection.style.setProperty('--color', color); selection.hidden = true;
    const badge = element('span', 'badge', selection);
    const angle = index / count * Math.PI * 2;
    const ring = .72 + (index % 3) * .18;
    const x = bounds.left + bounds.width / 2 + Math.cos(angle) * Math.min(105, bounds.width * .26) * ring;
    const y = bounds.top + bounds.height * .46 + Math.sin(angle) * Math.min(74, bounds.height * .21) * ring;
    node.style.transform = `translate3d(${x}px,${y}px,0)`;
    node.dataset.motion = 'orbit';
    return { node, selection, badge, index, color, x, y, angle: 0, scale: 1, vx: 0, vy: 0,
      fromX: x, fromY: y, fromVx: 0, fromVy: 0, travel: .36, curve: 0,
      idleX: x, idleY: y, idleTime: 0, delay: 0,
      exitX: x, exitY: y, exitCurveX: 0, exitCurveY: 0, exitAngle: 0,
      elapsed: 0, duration: 1, retiring: false, bornAt: -Infinity };
  }
  function setCursorCount(count: number) {
    if (destroyed) return;
    desiredCount = Math.floor(finite(count, desiredCount, 2, 48));
    if (!active || state.phase === 'exiting' || (state.phase === 'paused' && savedPhase === 'exiting')) return;
    workers.forEach(worker => { worker.retiring = false; });
    while (workers.length > desiredCount) {
      const free = [...workers].reverse().find(worker => !worker.task);
      if (!free) break;
      free.node.remove(); free.selection.remove();
      workers = workers.filter(worker => worker !== free);
    }
    const surplus = Math.max(0, workers.length - desiredCount);
    if (surplus > 0) workers.slice(-surplus).forEach(worker => { worker.retiring = true; worker.pending = undefined; });
    while (workers.length < desiredCount) {
      const worker = makeWorker(nextWorkerId++, desiredCount);
      worker.bornAt = motionTime; worker.node.style.opacity = '0';
      workers.push(worker);
    }
    state.agents = workers.length; emit();
  }
  function retireWorkers() {
    const previous = workers.length;
    workers = workers.filter(worker => {
      if (!worker.retiring || worker.task) return true;
      worker.node.remove(); worker.selection.remove(); return false;
    });
    if (previous !== workers.length) { state.agents = workers.length; emit(); }
  }
  function createWorkers() {
    nextWorkerId = 0;
    workers = Array.from({ length: desiredCount }, () => makeWorker(nextWorkerId++, desiredCount));
    state.agents = workers.length;
    if (options.showRulers === true) {
      const ruler = element('div', 'ruler-x', shadow);
      ruler.textContent = '　 0　　　　 100　　　　 200　　　　 300　　　　 400　　　　 500　　　　 600　　　　 700　　　　 800　　　　 900';
      element('div', 'ruler-y', shadow);
    }
    const opacity = options.fadeIn === false ? '1' : '0';
    workersRoot.style.opacity = opacity; intro.style.opacity = opacity;
    const bar = shadow?.querySelector<HTMLElement>('.toolbar');
    if (bar) bar.style.opacity = opacity;
  }
  function dependenciesReady(layer: Layer) {
    if (options.parallelDrawing === false) return (!layer.parent || layer.parent.done) && (!layer.master || layer.master.done);
    // DOM order already fixes visual stacking. Begin details while their
    // backdrop is drawing, or once a duplicated parent has mostly landed.
    const parentThreshold = layer.parent?.master ? .68 : .15;
    return (!layer.parent || layer.parent.done || layer.parent.progress >= parentThreshold) &&
      (!layer.master || layer.master.done || layer.master.progress >= .35);
  }
  function choosePending(worker: Worker) {
    if (worker.pending && !worker.pending.started && !worker.pending.done) return;
    const claimed = new Set(workers.filter(other => other !== worker).map(other => other.pending));
    const next = layers.find(layer => !layer.started && !layer.done && !claimed.has(layer));
    if (next !== worker.pending) { worker.pending = next; worker.idleTime = 0; }
  }
  function assign(worker: Worker) {
    const top = window.scrollY, bottom = top + viewportHeight;
    let best: Layer | undefined, score = Infinity;
    for (const layer of layers) {
      if (layer.done || layer.started || !dependenciesReady(layer)) continue;
      if (layer.cy - layer.height * .5 > bottom + 80) continue;
      const priority = Math.max(0, layer.cy - layer.height * .5 - top) * .78 + Math.hypot(layer.cx - window.scrollX - worker.x, layer.cy - top - worker.y) * .22 - (worker.pending === layer ? 150 : 0);
      if (priority < score) { best = layer; score = priority; }
    }
    if (!best) { choosePending(worker); return; }
    worker.pending = undefined;
    best.started = true; worker.task = best; worker.elapsed = 0;
    worker.fromX = worker.x; worker.fromY = worker.y;
    worker.fromVx = worker.vx; worker.fromVy = worker.vy;
    const first = best.text?.[0]?.units[0];
    const startPt = layerPoint(best, first && options.typing !== false ? first.startX : best.master ? best.master.x : best.x, first && options.typing !== false ? first.y : best.master ? best.master.y : best.y);
    const dist = Math.hypot(startPt.x - window.scrollX - worker.x, startPt.y - window.scrollY - worker.y);
    worker.travel = clamp(.2 + Math.sqrt(dist) * .013, .2, .52);
    const sign = (worker.index + best.id) % 2 === 0 ? 1 : -1;
    worker.curve = sign * clamp(dist * (.11 + ((worker.index + best.id) % 4) * .03), 8, 64);
    const count = best.text?.reduce((sum, run) => sum + run.units.length, 0) ?? 0;
    const rawTyping = count / finite(options.typingSpeed, 45, 5, 300);
    worker.duration = best.kind === 'text'
      ? clamp(rawTyping < 1 ? .48 + rawTyping * .52 : rawTyping, .48, 8)
      : .45 + Math.min(1, (best.width + best.height) / 950);
    worker.node.dataset.motion = 'working';
    worker.node.dataset.tool = 'arrow';
    worker.node.style.setProperty('--caret-angle', `${best.container.angle.toFixed(2)}deg`);
    if (worker.selection.parentElement !== best.container.node) best.container.node.append(worker.selection);
    worker.selection.style.borderStyle = best.master ? 'dashed' : 'solid';
    if (best.master && options.showGuides === true) {
      const measure = element('span', 'measure', worker.selection);
      measure.textContent = `⌥ ${Math.round(Math.hypot(best.x - best.master.x, best.y - best.master.y))}`;
    }
  }
  function work(worker: Worker, dt: number) {
    const task = worker.task!;
    worker.elapsed += dt;
    const travel = worker.travel;
    const first = task.text?.[0]?.units[0];
    const rawStartX = first && options.typing !== false ? first.startX : task.master ? task.master.x : task.x;
    const rawStartY = first && options.typing !== false ? first.y : task.master ? task.master.y : task.y;
    const startPt = layerPoint(task, rawStartX, rawStartY);
    const startX = startPt.x - window.scrollX, startY = startPt.y - window.scrollY;
    if (worker.elapsed < travel) {
      const t = clamp(worker.elapsed / travel, 0, 1), blend = smooth(t);
      const dx = startX - worker.fromX, dy = startY - worker.fromY;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len, ny = dx / len;
      const arc = 4 * blend * (1 - blend) * worker.curve;
      // Hermite travel with a lateral Bezier arc retains departure velocity
      // and curves naturally like a human hand moving across a canvas.
      const tangent = t * (1 - t) * (1 - t) * travel / state.speed;
      const prevX = worker.x, prevY = worker.y;
      worker.x = worker.fromX + dx * blend + nx * arc + worker.fromVx * tangent;
      worker.y = worker.fromY + dy * blend + ny * arc + worker.fromVy * tangent;
      const stepDt = Math.max(.004, dt / state.speed);
      const vx = (worker.x - prevX) / stepDt, vy = (worker.y - prevY) / stepDt;
      const bank = clamp(vx * .026 - vy * .01, -26, 26) * (1 - blend * .65);
      worker.angle += (bank - worker.angle) * (1 - Math.exp(-14 * stepDt));
      return;
    }
    const t = clamp((worker.elapsed - travel) / worker.duration, 0, 1);
    const draw = smooth(t);
    task.progress = t;
    task.element.dataset.swarmProgress = String(t);
    const width = task.width * draw, height = task.height * draw;
    const duplicateX = task.master ? (task.master.x - task.x) * (1 - draw) : 0;
    const duplicateY = task.master ? (task.master.y - task.y) * (1 - draw) - Math.sin(draw * Math.PI) * 10 : 0;
    task.element.style.opacity = '1';
    task.element.style.visibility = 'visible';
    task.element.style.transform = task.master ? `translate(${duplicateX}px,${duplicateY}px)` : '';
    if (task.text) {
      worker.selection.hidden = true;
      const typing = options.typing !== false;
      worker.node.dataset.tool = typing ? 'type' : 'arrow';
      const count = task.text.reduce((sum, run) => sum + run.units.length, 0);
      // Modulate typing with a gentle human cadence while guaranteeing at
      // least the first grapheme is visible as soon as the caret arrives.
      const cadence = clamp(t + Math.sin(t * Math.PI * 3 + worker.index) * (.12 / Math.max(4, count)) * (1 - t), 0, 1);
      const totalTyped = typing ? (t >= 1 ? count : Math.min(count, Math.max(1, Math.floor(cadence * (count + .7))))) : count;
      let remaining = totalTyped;
      let caret = first;
      let typed = false;
      for (const run of task.text) {
        const shown = Math.min(run.units.length, Math.max(0, remaining));
        const value = run.value.slice(0, shown ? run.units[shown - 1].end : 0);
        if (run.write) {
          if (run.shown !== value) { run.shown = value; run.write(value); typed = true; }
        }
        if (run.node.textContent !== value) { run.node.textContent = value; typed = true; }
        if (shown) caret = run.units[shown - 1];
        remaining -= run.units.length;
        run.node.style.opacity = typing ? run.opacity : String(Number(run.opacity || 1) * draw);
      }
      const anyTyped = !typing || totalTyped > 0;
      const rawX = caret ? (anyTyped ? caret.x : caret.startX) : task.x;
      const rawY = caret ? caret.y : task.y;
      const pt = layerPoint(task, rawX, rawY);
      worker.x = pt.x - window.scrollX;
      worker.y = pt.y - window.scrollY;
      worker.node.style.setProperty('--caret-height', `${clamp(caret?.height ?? task.height, 12, 80)}px`);
      worker.node.style.setProperty('--caret-angle', `${task.container.angle.toFixed(2)}deg`);
      if (typing && typed) audio.play('type', worker.x / viewportWidth);
    } else {
      worker.node.dataset.tool = task.master ? 'duplicate' : task.kind === 'line' ? 'pen' : 'cross';
      worker.selection.hidden = false;
      const localLeft = task.x - task.container.ox + duplicateX;
      const localTop = task.y - task.container.oy + duplicateY;
      worker.selection.style.left = `${localLeft}px`; worker.selection.style.top = `${localTop}px`;
      worker.selection.style.width = `${Math.max(1, task.master ? task.width : width)}px`;
      worker.selection.style.height = `${Math.max(1, task.master ? task.height : height)}px`;
      worker.selection.style.background = task.kind === 'box' && !task.master && t < .65 ? '#a0a5ab18' : '';
      worker.badge.textContent = `${Math.round(width)} × ${Math.round(height)}`;
      const localX = task.master ? task.x + duplicateX : task.kind === 'line' && task.height > task.width ? task.x + task.width * .5 : task.x + width;
      const localY = task.master ? task.y + duplicateY : task.kind === 'line' && task.width >= task.height ? task.y + task.height * .5 : task.y + height;
      const pt = layerPoint(task, localX, localY);
      worker.x = pt.x - window.scrollX;
      worker.y = pt.y - window.scrollY;
      const visual = task.element.firstElementChild as HTMLElement;
      const clipRight = (1 - draw) * 100, clipBottom = (1 - draw) * 100;
      visual.style.clipPath = task.master || draw > .97
        ? ''
        : task.kind === 'line'
          ? (task.height > task.width ? `inset(0 0 ${clipBottom}% 0)` : `inset(0 ${clipRight}% 0 0)`)
          : `inset(0 ${clipRight}% ${clipBottom}% 0)`;
      visual.style.transform = task.master || task.kind === 'line' ? '' : `scale(${(.975 + .025 * draw).toFixed(4)})`;
      visual.style.opacity = String(Number(task.opacity || 1) * (.28 + .72 * draw));
    }
    if (t > .02 && t < .08) audio.play('draw', worker.x / viewportWidth);
    if (t >= 1) {
      task.done = true;
      const visual = task.element.firstElementChild as HTMLElement;
      visual.style.clipPath = ''; visual.style.opacity = task.opacity; visual.style.transform = '';
      task.element.style.transform = '';
      worker.selection.hidden = true; worker.selection.querySelector('.measure')?.remove();
      worker.node.dataset.tool = 'arrow'; worker.node.dataset.motion = 'idle';
      worker.node.style.setProperty('--caret-angle', '0deg');
      worker.task = undefined; worker.vx = 0; worker.vy = 0;
      worker.idleX = worker.x; worker.idleY = worker.y; worker.idleTime = 0;
      worker.delay = options.smoothTransition === false ? 0 : .06 + (worker.index % 5) * .022;
      state.completed++; state.progress = state.total ? state.completed / state.total : 1;
    }
  }
  function float(worker: Worker, dt: number, orbit: boolean) {
    const phase = worker.index * 2.399963;
    const rate = finite(options.floatSpeed, 1, .25, 3), amplitude = finite(options.floatAmplitude, 1, .25, 3);
    const time = motionTime * rate;
    let tx: number, ty: number;
    if (orbit) {
      const buoyant = options.floatingIntro !== false;
      const ring = buoyant ? .74 + (worker.index % 3) * .17 : 1;
      const direction = buoyant && worker.index % 4 === 3 ? -.72 : .85;
      const theta = worker.index / workers.length * Math.PI * 2 + time * direction;
      const breathe = buoyant ? Math.sin(time * 1.45 + phase) * 26 * amplitude : 0;
      const radius = Math.min((108 + breathe) * ring, bounds.width * .32, bounds.height * .32);
      tx = bounds.left + bounds.width / 2 + Math.cos(theta) * radius + (buoyant ? Math.sin(time * 1.65 + phase) * 20 * amplitude : 0);
      ty = bounds.top + bounds.height * .46 + Math.sin(theta) * radius * .72 + (buoyant ? Math.cos(time * 2.05 + phase) * 24 * amplitude : 0);
    } else if (options.floatingIdle !== false) {
      worker.idleTime += dt;
      const settle = smooth(worker.idleTime / .32);
      if (worker.pending && !worker.pending.started && !worker.pending.done) {
        const nextX = clamp(worker.pending.cx - window.scrollX, bounds.left + 25, Math.max(bounds.left + 25, bounds.right - 35));
        const nextY = clamp(worker.pending.cy - window.scrollY, bounds.top + 35, Math.max(bounds.top + 35, bounds.bottom - 45));
        const reposition = 1 - Math.exp(-3.1 * dt);
        worker.idleX += (nextX - worker.idleX) * reposition;
        worker.idleY += (nextY - worker.idleY) * reposition;
      }
      tx = worker.idleX + (Math.sin(time * 1.55 + phase) * 52 + Math.sin(time * 2.4 + phase * .7) * 16) * amplitude * settle;
      ty = worker.idleY + (Math.cos(time * 1.85 + phase) * 36 + Math.sin(time * 2.75 + phase * 1.3) * 12) * amplitude * settle;
    } else {
      const theta = worker.index / workers.length * Math.PI * 2 + time * .28;
      const radius = 55 + (worker.index % 4) * 23;
      tx = pointer.x + Math.cos(theta) * radius; ty = pointer.y + Math.sin(theta) * radius * .7;
    }
    // The waiting motion has energy and banks into turns while staying damped.
    const respond = (position: number, velocity: number, destination: number) => {
      const nextVelocity = (velocity + (destination - position) * 38 * dt) * Math.exp(-8 * dt);
      return { position: position + nextVelocity * dt, velocity: nextVelocity };
    };
    const sx = respond(worker.x, worker.vx, clamp(tx, bounds.left + 15, Math.max(bounds.left + 15, bounds.right - 25)));
    const sy = respond(worker.y, worker.vy, clamp(ty, bounds.top + 25, Math.max(bounds.top + 25, bounds.bottom - 35)));
    worker.x = sx.position; worker.vx = sx.velocity; worker.y = sy.position; worker.vy = sy.velocity;
    worker.node.dataset.motion = orbit ? 'orbit' : worker.pending && !worker.pending.started ? 'staging' : 'idle';
    const bank = clamp(worker.vx * .045 - worker.vy * .015, -24, 24);
    const tilt = Math.sin(time * 1.5 + phase) * 16 + bank;
    worker.angle += (tilt - worker.angle) * (1 - Math.exp(-8 * dt));
  }
  function beginExit() {
    if (options.burstOnComplete === false || finite(options.exitDuration, 700, 0, 3000) === 0) { goLive(); return; }
    const baseDistance = Math.hypot(bounds.width, bounds.height) + 120;
    // Shuffle sector indices so cursors scatter in random, uncorrelated
    // directions from their current spots rather than a uniform wheel.
    const indices = workers.map((_, i) => i);
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    workers.forEach((worker, i) => {
      const sector = indices[i] / Math.max(1, workers.length);
      const jitter = (Math.random() - .5) * (Math.PI * 1.35 / Math.max(1, workers.length) + .85);
      const angle = -Math.PI + sector * Math.PI * 2 + jitter;
      const distance = baseDistance * (.78 + Math.random() * .62);
      const dx = Math.cos(angle) * distance, dy = Math.sin(angle) * distance;
      const curve = (Math.random() - .5) * 220;
      worker.fromX = worker.x; worker.fromY = worker.y;
      worker.exitX = worker.x + dx;
      worker.exitY = worker.y + dy;
      worker.exitCurveX = -Math.sin(angle) * curve;
      worker.exitCurveY = Math.cos(angle) * curve;
      worker.exitAngle = clamp(Math.cos(angle) * 28 - Math.sin(angle) * 14 + (Math.random() - .5) * 18, -42, 42);
      worker.node.dataset.tool = 'arrow'; worker.node.dataset.motion = 'exit';
      worker.selection.hidden = true;
    });
    exitTime = 0; setPhase('exiting');
  }
  function drawWorker(worker: Worker) {
    if (state.phase !== 'exiting' && Number.isFinite(worker.bornAt)) worker.node.style.opacity = String(smooth((motionTime - worker.bornAt) / .25));
    worker.node.style.transform = `translate3d(${worker.x.toFixed(2)}px,${worker.y.toFixed(2)}px,0)`;
    const arrow = worker.node.querySelector<SVGElement>('.pointer');
    if (arrow) arrow.style.transform = `translate(-3px,-2.5px) rotate(${worker.angle.toFixed(2)}deg) scale(${worker.scale.toFixed(3)})`;
  }
  function tick(now: number) {
    if (!active) return;
    if (!target.isConnected) { stop(); return; }
    updateBounds();
    if (scoped && capturedBounds && ['left', 'top', 'width', 'height'].some(key =>
      Math.abs(bounds[key as keyof DOMRect] as number - (capturedBounds![key as keyof DOMRect] as number)) > 2)) {
      goLive(); return;
    }
    const realDt = Math.min(.05, Math.max(0, (now - last) / 1000)); last = now;
    stage.style.transform = `translate(${-window.scrollX}px,${-window.scrollY}px)`;
    if (state.phase !== 'paused') {
      const dt = realDt * state.speed;
      elapsed += dt; motionTime += realDt; entranceTime += realDt;
      const entrance = options.fadeIn === false ? 1 : smooth(entranceTime * 1000 / Math.max(1, finite(options.fadeInDuration, 360, 0, 3000)));
      workersRoot.style.opacity = String(entrance);
      const bar = shadow?.querySelector<HTMLElement>('.toolbar');
      if (bar) bar.style.opacity = String(entrance);
      if (state.phase === 'intro') {
        intro.style.opacity = String(entrance);
        const pulse = 1 + Math.sin(motionTime * 3.2) * .045;
        intro.style.transform = `translate(-50%,-50%) scale(${pulse.toFixed(3)})`;
        workers.forEach(worker => float(worker, realDt, true));
        if (ready && elapsed * 1000 >= finite(options.introDuration, 1600, 0, 15000)) prepareSnapshot();
        if (!active) return;
      } else if (state.phase === 'transition') {
        transitionTime += realDt;
        const t = smooth(transitionTime * 1000 / Math.max(1, finite(options.transitionDuration, 480, 0, 3000)));
        intro.style.opacity = String(1 - t);
        intro.style.transform = `translate(-50%,-50%) scale(${(1 - t * .18).toFixed(3)})`;
        workers.forEach(worker => {
          // Brake the existing orbit with the same spring, keeping velocity
          // continuous while workers settle into independent waiting spots.
          const phase = worker.index * 2.399963;
          const sx = stepSpring(worker.x, worker.vx, worker.fromX + Math.sin(phase) * 22 * t, realDt);
          const sy = stepSpring(worker.y, worker.vy, worker.fromY + Math.cos(phase) * 16 * t, realDt);
          worker.x = sx.position; worker.vx = sx.velocity;
          worker.y = sy.position; worker.vy = sy.velocity;
          worker.node.dataset.motion = 'handoff';
          worker.idleX = worker.x; worker.idleY = worker.y;
        });
        if (t >= 1) { intro.style.opacity = '0'; setPhase('building'); }
      } else if (state.phase === 'building') {
        intro.style.opacity = '0';
        workers.forEach(worker => {
          worker.delay = Math.max(0, worker.delay - realDt);
          if (worker.retiring && !worker.task) return;
          if (!worker.retiring && !worker.task && worker.delay <= 0) assign(worker);
          if (worker.task) {
            if (worker.elapsed >= worker.travel) worker.angle *= Math.exp(-10 * realDt);
            work(worker, dt);
          } else float(worker, realDt, false);
        });
        retireWorkers();
        if (state.tour && !scoped) {
          const next = layers.filter(layer => !layer.done).reduce((min, layer) => Math.min(min, layer.cy - layer.height * .5), Infinity);
          if (Number.isFinite(next)) {
            const goal = Math.max(0, next - viewportHeight * .35);
            if (goal > window.scrollY + 1) window.scrollBy(0, Math.min(goal - window.scrollY, 180 * dt));
          }
        }
        if (state.completed === state.total) {
          state.progress = 1; shadow?.querySelectorAll('.guide,.ruler-x,.ruler-y').forEach(node => node.remove());
          audio.play('complete'); setPhase('complete'); options.onComplete?.();
          if (!active) return;
          if (options.finishBehavior !== 'flock') beginExit();
          if (!active) return;
        }
      } else if (state.phase === 'exiting') {
        exitTime += realDt;
        const t = clamp(exitTime * 1000 / Math.max(1, finite(options.exitDuration, 700, 0, 3000)), 0, 1);
        const progress = t * (.36 + .64 * t);
        const arc = 4 * t * (1 - t);
        workers.forEach(worker => {
          worker.x = worker.fromX + (worker.exitX - worker.fromX) * progress + worker.exitCurveX * arc;
          worker.y = worker.fromY + (worker.exitY - worker.fromY) * progress + worker.exitCurveY * arc;
          worker.angle += (worker.exitAngle - worker.angle) * (1 - Math.exp(-12 * realDt));
          worker.scale = 1 - smooth(t) * .12;
          worker.node.style.opacity = String(1 - smooth((t - .42) / .58));
        });
        cover.style.opacity = String(1 - smooth((t - .42) / .58));
        if (bar) bar.style.opacity = String(1 - smooth(t));
        if (t >= 1) { goLive(); return; }
      } else if (state.phase === 'complete') {
        workers.forEach(worker => float(worker, realDt, false));
      }
      workers.forEach(drawWorker);
      if (now - lastEmit > 150) { lastEmit = now; emit(); }
    }
    if (active) frame = window.requestAnimationFrame(tick);
  }
  return { start, replay: start, pause, resume, goLive, stop, setSpeed, setSound, setTour, setReady, setCursorCount, getState, destroy() { dispose(); audio.destroy(); destroyed = true; state = { ...state, phase: 'idle', agents: 0 }; } };
}
