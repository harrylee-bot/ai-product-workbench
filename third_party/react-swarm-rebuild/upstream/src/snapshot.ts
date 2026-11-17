export interface TextUnit {
  end: number;
  startX: number; x: number; y: number; height: number;
}
export interface TextRun {
  node: HTMLElement; value: string; opacity: string; units: TextUnit[];
  /** Custom writer, used for form fields whose text lives in a cloned control. */
  write?: (value: string) => void;
  shown?: string;
}
/**
 * A coordinate frame in the stage. Layers inside a transformed element are
 * measured with that element's own transform neutralized, then placed inside
 * a group that re-applies the transform, so rotated/scaled UI is rebuilt in
 * place instead of straightening during the animation.
 */
export interface Container {
  id: number;
  node: HTMLElement;
  /** Page coordinate (in the measuring frame) of this container's origin. */
  ox: number; oy: number;
  /** Local → page affine mapping. Undefined means local coords are page coords. */
  matrix?: { a: number; b: number; c: number; d: number; e: number; f: number };
  /** Rotation of the frame in degrees, for carets and crosshairs. */
  angle: number;
  /** Nearest transformed group (or the stage) for selection outlines. */
  frame: Container;
}
export interface Layer {
  id: number;
  kind: 'box' | 'text' | 'media' | 'line';
  x: number; y: number; width: number; height: number;
  /** Final on-page center, after transforms. Used for scheduling. */
  cx: number; cy: number;
  element: HTMLElement;
  container: Container;
  text?: TextRun[];
  signature: string;
  master?: Layer;
  parent?: Layer;
  done: boolean;
  started: boolean;
  progress: number;
  opacity: string;
}
export interface Snapshot { layers: Layer[]; background: string; }

const boxProps = ['background', 'background-image', 'background-size', 'background-position', 'background-repeat', 'background-origin', 'background-clip', '-webkit-background-clip', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-radius', 'box-shadow', 'opacity', 'filter', 'backdrop-filter', '-webkit-backdrop-filter', 'mix-blend-mode', 'outline', 'outline-offset', 'clip-path'];
// Shorthands first so the longhands that follow win.
const textProps = ['font-family', 'font-size', 'font-weight', 'font-style', 'font-stretch', 'font-variant', 'font-variant-ligatures', 'font-variant-caps', 'font-variant-numeric', 'font-variant-east-asian', 'font-variant-position', 'font-feature-settings', 'font-variation-settings', 'font-kerning', 'font-optical-sizing', 'font-synthesis', 'font-size-adjust', 'text-rendering', '-webkit-font-smoothing', 'color', 'letter-spacing', 'word-spacing', 'text-transform', 'text-shadow', '-webkit-text-fill-color', '-webkit-text-stroke-width', '-webkit-text-stroke-color', 'paint-order', 'direction', 'unicode-bidi'];
const decorationProps = ['text-decoration-line', 'text-decoration-color', 'text-decoration-style', 'text-decoration-thickness', 'text-underline-offset', 'text-underline-position'];
const transparent = (value: string) => value === 'transparent' || value === 'rgba(0, 0, 0, 0)' || !value;
const ignoredTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'LINK', 'META', 'OPTION']);
const mediaTags = new Set(['IMG', 'SVG', 'VIDEO', 'CANVAS', 'IFRAME', 'INPUT', 'TEXTAREA', 'SELECT', 'PICTURE', 'OBJECT', 'EMBED']);
const typedInputs = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'number', 'password', 'button', 'submit', 'reset']);

type Segment = { segment: string; index: number };
type SegmenterCtor = new (locale?: string, options?: { granularity: string }) => { segment(text: string): Iterable<Segment> };
const Segmenter = typeof Intl !== 'undefined' ? (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter : undefined;
let graphemeSegmenter: { segment(text: string): Iterable<Segment> } | undefined;
/** Segment by grapheme so emoji, combining accents and Vietnamese are never split. */
export function graphemes(text: string): Iterable<Segment> {
  if (Segmenter) return (graphemeSegmenter ??= new Segmenter(undefined, { granularity: 'grapheme' })).segment(text);
  return codePoints(text);
}
function* codePoints(text: string) {
  let index = 0;
  for (const segment of text) {
    yield { segment, index };
    index += segment.length;
  }
}

function copyStyles(from: Element, to: Element) {
  if (!(to instanceof HTMLElement || to instanceof SVGElement)) return;
  const css = getComputedStyle(from);
  for (const property of css) to.style.setProperty(property, css.getPropertyValue(property));
  to.style.animation = 'none';
  to.style.transition = 'none';
  to.removeAttribute('id');
  // Snapshot content is inert. Never mount executable/custom-element DOM.
  for (const attr of Array.from(to.attributes)) {
    if (/^on/i.test(attr.name) || ['autofocus', 'autoplay', 'srcdoc'].includes(attr.name)) to.removeAttribute(attr.name);
  }
  Array.from(from.children).forEach((child, i) => {
    if (to.children[i]) copyStyles(child, to.children[i]);
  });
}

const near = (value: number, expected: number) => Math.abs(value - expected) < 1e-4;
/** True when a transform changes shape (rotate/scale/skew), not just position. */
function linearTransform(css: CSSStyleDeclaration) {
  const rotate = css.getPropertyValue('rotate'), scale = css.getPropertyValue('scale');
  if (rotate && rotate !== 'none' && !/^(0|0deg|0rad|0turn|0grad)$/.test(rotate.trim())) return true;
  if (scale && scale !== 'none' && scale.trim().split(/\s+/).some(value => parseFloat(value) !== 1)) return true;
  const transform = css.transform;
  if (!transform || transform === 'none') return false;
  try {
    const m = new DOMMatrixReadOnly(transform);
    if (!near(m.a, 1) || !near(m.b, 0) || !near(m.c, 0) || !near(m.d, 1)) return true;
    return !m.is2D && (!near(m.m13, 0) || !near(m.m23, 0) || !near(m.m31, 0) || !near(m.m32, 0) || !near(m.m33, 1) || !near(m.m14, 0) || !near(m.m24, 0) || !near(m.m34, 0));
  } catch { return false; }
}
function hasBoxSurface(css: CSSStyleDeclaration) {
  const hasBorder = ['top', 'right', 'bottom', 'left'].some(s => parseFloat(css.getPropertyValue(`border-${s}-width`)) > 0 && css.getPropertyValue(`border-${s}-style`) !== 'none');
  const textClip = css.getPropertyValue('-webkit-background-clip') === 'text' || css.getPropertyValue('background-clip') === 'text';
  const paints = !textClip && (!transparent(css.backgroundColor) || css.backgroundImage !== 'none');
  return paints || hasBorder || css.boxShadow !== 'none';
}
/**
 * Temporarily measure an element without its own transform. Layout is not
 * affected by transforms, so descendants keep their relative geometry. An
 * identity translate keeps the containing block and stacking context intact.
 * The application sits underneath the opaque cover while this happens.
 */
function neutralize(el: HTMLElement | SVGElement, hasKeyframe: boolean) {
  const style = el.style;
  const properties = hasKeyframe ? ['transform', 'rotate', 'scale', 'translate', 'animation'] : ['transform', 'rotate', 'scale', 'translate'];
  const values: Record<string, string> = { transform: 'translate(0px)', rotate: 'none', scale: 'none', translate: 'none', animation: 'none' };
  const saved = [...properties, 'transition'].map(name => [name, style.getPropertyValue(name), style.getPropertyPriority(name)] as const);
  style.setProperty('transition', 'none', 'important');
  for (const name of properties) style.setProperty(name, values[name], 'important');
  return () => {
    const restore = ([name, value, priority]: readonly [string, string, string]) => {
      if (style.getPropertyPriority(name) !== 'important') return;
      if (value) style.setProperty(name, value, priority); else style.removeProperty(name);
    };
    saved.filter(([name]) => name !== 'transition').forEach(entry => {
      if (style.getPropertyValue(entry[0]).replace(/\s/g, '') === values[entry[0]].replace(/\s/g, '')) restore(entry);
    });
    void getComputedStyle(el).transform; // Flush while transitions are off.
    const transition = saved.find(([name]) => name === 'transition')!;
    if (style.getPropertyValue('transition') === 'none') restore(transition);
  };
}

interface Flow {
  visual: HTMLDivElement;
  runs: TextRun[];
  left: number; top: number; right: number; bottom: number;
  originX: number; originY: number;
  owner?: Layer; clip?: DOMRect; container: Container; opacity: number;
}
interface FlowHolder {
  current?: Flow;
  owner?: Layer; clip?: DOMRect; container: Container;
  ellipsis?: { limit: number; width: number; done: boolean };
  flush: () => void;
}

/** A flat visual display list. Transforms are neutralized only while measuring. */
export function* snapshotSteps(target: HTMLElement, stage: HTMLElement, maxLayers: number, viewport?: DOMRect): Generator<void, Snapshot> {
  const layers: Layer[] = [];
  const masters = new Map<string, Layer>();
  const scrollX = window.scrollX, scrollY = window.scrollY;
  const rootStyle = getComputedStyle(target);
  let background = rootStyle.backgroundColor;
  if (transparent(background)) background = getComputedStyle(document.documentElement).backgroundColor;
  if (transparent(background)) background = '#ffffff';
  let containerId = 0, transformDepth = 0;
  const root: Container = { id: containerId++, node: stage, ox: 0, oy: 0, angle: 0, frame: undefined as unknown as Container };
  root.frame = root;
  const decorations = new Map<Element, CSSStyleDeclaration | null>();
  const clipSources = new Map<Element, Element | null>();
  let measure: CanvasRenderingContext2D | null | undefined;

  const visible = (rect: DOMRect, clip?: DOMRect) => !clip ||
    (rect.bottom > clip.top && rect.top < clip.bottom && rect.right > clip.left && rect.left < clip.right);
  const insetFor = (rect: { left: number; top: number; right: number; bottom: number }, clip: DOMRect) =>
    `inset(${Math.max(0, clip.top - rect.top)}px ${Math.max(0, rect.right - clip.right)}px ${Math.max(0, rect.bottom - clip.bottom)}px ${Math.max(0, clip.left - rect.left)}px)`;
  const toPage = (container: Container, x: number, y: number) => {
    const m = container.matrix;
    if (!m) return { x, y };
    const lx = x - container.ox, ly = y - container.oy;
    return { x: m.a * lx + m.c * ly + m.e, y: m.b * lx + m.d * ly + m.f };
  };
  /** Read a container's real on-page mapping, including every ancestor group. */
  const probe = (container: Container) => {
    const origin = stage.getBoundingClientRect();
    const points = [[0, 0], [100, 0], [0, 100]].map(([x, y]) => {
      const dot = document.createElement('i');
      dot.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:0;height:0;`;
      container.node.append(dot);
      const box = dot.getBoundingClientRect();
      dot.remove();
      return { x: box.left - origin.left, y: box.top - origin.top };
    });
    const [p0, p1, p2] = points;
    container.matrix = { a: (p1.x - p0.x) / 100, b: (p1.y - p0.y) / 100, c: (p2.x - p0.x) / 100, d: (p2.y - p0.y) / 100, e: p0.x, f: p0.y };
    container.angle = Math.atan2(container.matrix.b, container.matrix.a) * 180 / Math.PI;
  };
  const child = (parent: Container, node: HTMLElement, x: number, y: number, group: boolean): Container => {
    parent.node.append(node);
    const container: Container = { id: containerId++, node, ox: x, oy: y, angle: parent.angle, frame: parent.frame };
    if (group) container.frame = container;
    if (group || parent.matrix) probe(container);
    return container;
  };

  const add = (kind: Layer['kind'], rect: { left: number; top: number; width: number; height: number }, visual: HTMLElement, container: Container, parent?: Layer, signature = '') => {
    const element = document.createElement('div');
    element.dataset.swarmKind = kind;
    const x = rect.left + scrollX, y = rect.top + scrollY;
    // Computed SVG styles often explicitly set visibility:visible. Opacity
    // hides the entire composited subtree, which descendants cannot override.
    element.style.cssText = `position:absolute;left:${x - container.ox}px;top:${y - container.oy}px;width:${rect.width}px;height:${rect.height}px;visibility:hidden;opacity:0;pointer-events:none;box-sizing:border-box;`;
    element.append(visual);
    container.node.append(element);
    const center = toPage(container, x + rect.width / 2, y + rect.height / 2);
    const layer: Layer = { id: layers.length, kind, x, y, width: rect.width, height: rect.height, cx: center.x, cy: center.y, element, container, parent, signature, done: false, started: false, progress: 0, opacity: visual.style.opacity };
    if (kind === 'box' && signature) {
      const key = `${container.id}|${signature}`;
      layer.master = masters.get(key);
      if (!layer.master) masters.set(key, layer);
    }
    layers.push(layer);
    return layer;
  };

  /** Text decorations propagate from ancestors; computed values do not inherit. */
  const decoration = (el: Element): CSSStyleDeclaration | null => {
    if (decorations.has(el)) return decorations.get(el)!;
    let found: CSSStyleDeclaration | null = null;
    for (let node: Element | null = el, depth = 0; node && depth < 12; node = node.parentElement, depth++) {
      const css = getComputedStyle(node);
      if (css.textDecorationLine && css.textDecorationLine !== 'none') { found = css; break; }
      if (node === target || /^inline-|^table/.test(css.display) || css.float !== 'none' || css.position === 'absolute' || css.position === 'fixed') break;
    }
    decorations.set(el, found);
    return found;
  };
  /** Gradient text: the background paints through the glyphs of descendants. */
  const clipSource = (el: Element): Element | null => {
    if (clipSources.has(el)) return clipSources.get(el)!;
    let found: Element | null = null;
    for (let node: Element | null = el, depth = 0; node && depth < 6; node = node.parentElement, depth++) {
      const css = getComputedStyle(node);
      if (css.getPropertyValue('-webkit-background-clip') === 'text' || css.getPropertyValue('background-clip') === 'text') { found = node; break; }
      if (node === target) break;
    }
    clipSources.set(el, found);
    return found;
  };
  const runStyle = (span: HTMLElement, el: Element, css: CSSStyleDeclaration, opacity: number) => {
    for (const property of textProps) span.style.setProperty(property, css.getPropertyValue(property));
    const decorated = decoration(el);
    if (decorated) for (const property of decorationProps) span.style.setProperty(property, decorated.getPropertyValue(property));
    span.style.opacity = String(opacity);
  };
  const paintClip = (span: HTMLElement, el: Element, left: number, top: number) => {
    const source = clipSource(el);
    if (!source) return;
    const css = getComputedStyle(source), box = source.getBoundingClientRect();
    span.style.backgroundImage = css.backgroundImage;
    span.style.backgroundColor = css.backgroundColor;
    span.style.backgroundRepeat = css.backgroundRepeat;
    span.style.backgroundSize = /px/.test(css.backgroundSize) && !/auto|%|cover|contain/.test(css.backgroundSize) ? css.backgroundSize : `${box.width}px ${box.height}px`;
    span.style.backgroundPosition = `${box.left - left}px ${box.top - top}px`;
    span.style.setProperty('-webkit-background-clip', 'text');
    span.style.setProperty('background-clip', 'text');
    span.style.setProperty('-webkit-text-fill-color', css.getPropertyValue('-webkit-text-fill-color') || 'transparent');
  };

  const commit = (flow: Flow) => {
    if (!flow.runs.length || layers.length >= maxLayers) return;
    const rect = { left: flow.left, top: flow.top, width: flow.right - flow.left, height: flow.bottom - flow.top };
    flow.visual.style.cssText = `position:absolute;left:${flow.originX - flow.left}px;top:${flow.originY - flow.top}px;`;
    const layer = add('text', rect, flow.visual, flow.container, flow.owner);
    layer.text = flow.runs;
    if (flow.clip) layer.element.style.clipPath = insetFor(flow, flow.clip);
  };

  /** Measure one text node into the current paragraph-level flow. */
  function* measureText(node: Text, el: Element, css: CSSStyleDeclaration, opacity: number, holder: FlowHolder, whitespaceOnly = false): Generator<void> {
    const range = document.createRange();
    range.selectNodeContents(node);
    const bounds = range.getBoundingClientRect();
    if (!bounds.width || !bounds.height || !visible(bounds, holder.clip)) return;
    if (holder.ellipsis?.done) return;
    let flow = holder.current;
    if (!flow) {
      flow = holder.current = { visual: document.createElement('div'), runs: [], left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity, originX: bounds.left, originY: bounds.top, owner: holder.owner, clip: holder.clip, container: holder.container, opacity };
    }
    const rtl = css.direction === 'rtl';
    const justify = css.textAlign === 'justify';
    const preformatted = /^pre|break-spaces/.test(css.whiteSpace);
    const raw = (node.textContent ?? '').slice(0, 12000);
    let current: TextRun | undefined = whitespaceOnly ? flow.runs[flow.runs.length - 1] : undefined;
    let lastTop = -Infinity, lastEdge = NaN, afterSpace = false;
    let measured = 0;
    const ellipsis = holder.ellipsis;
    for (const { segment, index } of graphemes(raw)) {
      if (transformDepth === 0 && measured++ % 24 === 0) yield;
      range.setStart(node, index); range.setEnd(node, index + segment.length);
      const char = range.getBoundingClientRect();
      const space = /^\s+$/.test(segment);
      const token = !preformatted && space && segment.length === 1 && segment !== ' ' ? ' ' : segment;
      if (!char.width && space) {
        if (whitespaceOnly) continue;
        // Keep a wrapped/collapsed space in the text sequence without
        // moving its caret to the empty Range's (0, 0) rectangle.
        const previous = current?.units[current.units.length - 1];
        if (current && previous) {
          current.value += token;
          current.units.push({ ...previous, end: current.value.length });
          afterSpace = true;
        }
        continue;
      }
      if (!char.width && !char.height) continue;
      if (ellipsis && !rtl && char.right > ellipsis.limit + .5) {
        // Recreate text-overflow:ellipsis, which Range geometry ignores.
        ellipsis.done = true;
        if (current) {
          const previous = current.units[current.units.length - 1];
          current.value += '…';
          current.units.push({ end: current.value.length, startX: previous.x, x: previous.x + ellipsis.width, y: previous.y, height: previous.height });
        }
        break;
      }
      const edge = rtl ? char.right : char.left;
      const lineBreak = !whitespaceOnly && (Math.abs(char.top - lastTop) > 2 || (rtl ? edge > lastEdge + 2 : edge < lastEdge - 2));
      if (!current || lineBreak || (justify && afterSpace && !space)) {
        const span = document.createElement('span');
        runStyle(span, el, css, opacity);
        const x = char.left - flow.originX, y = char.top - flow.originY;
        span.style.cssText += rtl
          ? `;position:absolute;right:${flow.originX - char.right}px;top:${y}px;white-space:pre;line-height:${char.height}px;`
          : `;position:absolute;left:${x}px;top:${y}px;white-space:pre;line-height:${char.height}px;`;
        paintClip(span, el, char.left, char.top);
        flow.visual.append(span);
        current = { node: span, value: '', opacity: String(opacity), units: [] };
        flow.runs.push(current);
        afterSpace = false;
      }
      current.value += token;
      current.units.push({ end: current.value.length, startX: (rtl ? char.right : char.left) + scrollX, x: (rtl ? char.left : char.right) + scrollX, y: char.top + scrollY, height: char.height });
      if (space) afterSpace = true;
      flow.left = Math.min(flow.left, char.left); flow.top = Math.min(flow.top, char.top);
      flow.right = Math.max(flow.right, char.right); flow.bottom = Math.max(flow.bottom, char.bottom);
      lastTop = char.top; lastEdge = edge;
    }
  }

  /** Inputs reveal their empty control first, then type value or placeholder. */
  const fieldText = (el: HTMLInputElement | HTMLTextAreaElement, clone: HTMLInputElement | HTMLTextAreaElement, css: CSSStyleDeclaration, rect: DOMRect, layer: Layer) => {
    if (layers.length >= maxLayers) return;
    const isInput = el instanceof HTMLInputElement;
    if (isInput && !typedInputs.has(el.type)) return;
    const shownValue = isInput && el.type === 'password' && el.value ? '•'.repeat(Math.min(12, [...el.value].length)) : el.value;
    const attr: 'value' | 'placeholder' = shownValue ? 'value' : 'placeholder';
    const value = (shownValue || el.placeholder || '').slice(0, 2000);
    if (!value.trim()) return;
    clone.value = ''; clone.placeholder = '';
    measure ??= document.createElement('canvas').getContext('2d');
    const font = `${css.fontStyle} ${css.fontWeight} ${css.fontSize} ${css.fontFamily}`;
    if (measure) measure.font = font;
    const spacing = parseFloat(css.letterSpacing) || 0;
    const px = (name: string) => parseFloat(css.getPropertyValue(name)) || 0;
    const left = rect.left + px('border-left-width') + px('padding-left');
    const right = rect.right - px('border-right-width') - px('padding-right');
    const fontSize = px('font-size') || 14;
    const lineHeight = parseFloat(css.lineHeight) || fontSize * 1.25;
    const width = (text: string) => (measure ? measure.measureText(text).width : text.length * fontSize * .55) + [...text].length * spacing;
    const lines = isInput ? [value] : value.split('\n');
    const align = css.textAlign;
    const units: TextUnit[] = [];
    let offset = 0;
    lines.forEach((line, row) => {
      const total = width(line), available = right - left;
      const start = align === 'center' || (isInput && /button|submit|reset/.test(el.type) && align !== 'left' && align !== 'start')
        ? left + Math.max(0, available - total) / 2
        : align === 'right' || align === 'end' ? left + Math.max(0, available - total) : left;
      const top = isInput ? rect.top + (rect.height - lineHeight) / 2 : rect.top + px('border-top-width') + px('padding-top') + row * lineHeight;
      let prefix = '';
      for (const { segment } of graphemes(line)) {
        const startX = Math.min(right, start + width(prefix));
        prefix += segment;
        units.push({ end: offset + prefix.length, startX: startX + scrollX, x: Math.min(right, start + width(prefix)) + scrollX, y: Math.max(rect.top, top) + scrollY, height: Math.min(lineHeight, rect.height) });
      }
      offset += line.length + 1;
      if (row < lines.length - 1 && units.length) units[units.length - 1] = { ...units[units.length - 1], end: offset };
    });
    if (!units.length) return;
    const marker = document.createElement('div');
    const textLayer = add('text', rect, marker, layer.container, layer);
    textLayer.element.style.visibility = 'hidden';
    textLayer.text = [{ node: marker, value, opacity: '1', units, write: text => { clone[attr] = text; } }];
  };

  function* walk(el: Element, parent: Layer | undefined, opacity: number, clip: DOMRect | undefined, container: Container, inline?: FlowHolder): Generator<void> {
    if (transformDepth === 0) yield;
    if (layers.length >= maxLayers || ignoredTags.has(el.tagName.toUpperCase()) || el.hasAttribute('data-swarm-ignore') || el.hasAttribute('data-swarm-overlay')) return;
    const css = getComputedStyle(el);
    if (css.display === 'none' || css.visibility === 'hidden' || css.getPropertyValue('content-visibility') === 'hidden') return;
    opacity *= Number(css.opacity);
    if (opacity < .01) return;
    const tag = el.tagName.toUpperCase();
    const styled = el instanceof HTMLElement || el instanceof SVGElement;
    const transformed = !inline && styled && linearTransform(css);
    // Read live computed transform values before neutralizing them.
    const transform = transformed ? { transform: css.transform, rotate: css.getPropertyValue('rotate'), scale: css.getPropertyValue('scale'), translate: css.getPropertyValue('translate'), origin: css.transformOrigin } : undefined;
    const restore = transformed ? (transformDepth++, neutralize(el as HTMLElement | SVGElement, Boolean(css.animationName && css.animationName !== 'none'))) : undefined;
    try {
      const rect = el.getBoundingClientRect();
      if (rect.top + scrollY > 40000 || rect.bottom + scrollY < 0) return;
      if (transform && rect.width > 0 && rect.height > 0) {
        // Clip from outside the group lives in the parent frame.
        let host = container;
        if (clip) {
          const wrapper = document.createElement('div');
          wrapper.style.cssText = `position:absolute;left:${clip.left + scrollX - host.ox}px;top:${clip.top + scrollY - host.oy}px;width:${clip.width}px;height:${clip.height}px;overflow:hidden;pointer-events:none;`;
          host = child(host, wrapper, clip.left + scrollX, clip.top + scrollY, false);
          clip = undefined;
        }
        const group = document.createElement('div');
        const x = rect.left + scrollX, y = rect.top + scrollY;
        group.style.cssText = `position:absolute;left:${x - host.ox}px;top:${y - host.oy}px;width:${rect.width}px;height:${rect.height}px;pointer-events:none;transform-origin:${transform.origin};`;
        group.style.transform = transform.transform === 'none' ? '' : transform.transform;
        if (transform.translate && transform.translate !== 'none') group.style.setProperty('translate', transform.translate);
        if (transform.rotate && transform.rotate !== 'none') group.style.setProperty('rotate', transform.rotate);
        if (transform.scale && transform.scale !== 'none') group.style.setProperty('scale', transform.scale);
        group.dataset.swarmGroup = '';
        container = child(host, group, x, y, true);
      }
      let own = parent;
      const withClip = (layer: Layer) => { if (clip) layer.element.style.clipPath = insetFor(rect, clip); };
      if (rect.width > 0 && rect.height > 0 && visible(rect, clip)) {
        if (mediaTags.has(tag)) {
          const visual = document.createElement('div');
          visual.style.cssText = 'width:100%;height:100%;overflow:hidden;';
          let clone: Element;
          if (el instanceof HTMLCanvasElement) {
            const canvas = document.createElement('canvas');
            canvas.width = el.width; canvas.height = el.height;
            try { canvas.getContext('2d')?.drawImage(el, 0, 0); } catch { /* A protected drawing surface stays blank. */ }
            clone = canvas;
          } else if (el instanceof HTMLVideoElement) {
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, el.videoWidth); canvas.height = Math.max(1, el.videoHeight);
            try { canvas.getContext('2d')?.drawImage(el, 0, 0); } catch { /* Poster is used if the video cannot be read. */ }
            if (el.poster && el.readyState < 2) { const image = document.createElement('img'); image.src = el.poster; clone = image; } else clone = canvas;
          } else if (el instanceof HTMLIFrameElement || tag === 'OBJECT' || tag === 'EMBED') {
            clone = document.createElement('div');
            clone.textContent = 'Embedded content';
          } else {
            clone = el.cloneNode(true) as Element;
          }
          copyStyles(el, clone);
          if (clone instanceof HTMLElement || clone instanceof SVGElement) {
            clone.style.cssText += ';position:relative!important;inset:auto!important;margin:0!important;transform:none!important;rotate:none!important;scale:none!important;translate:none!important;width:100%!important;height:100%!important;box-sizing:border-box!important;';
            if (el instanceof HTMLInputElement && clone instanceof HTMLInputElement) {
              clone.value = el.type === 'password' ? '••••••' : el.value;
              clone.name = ''; clone.disabled = true;
            }
            if (el instanceof HTMLTextAreaElement && clone instanceof HTMLTextAreaElement) clone.value = el.value;
            if (el instanceof HTMLSelectElement && clone instanceof HTMLSelectElement) clone.selectedIndex = el.selectedIndex;
          }
          visual.append(clone);
          const layer = add('media', rect, visual, container, parent);
          withClip(layer);
          if ((el instanceof HTMLInputElement && clone instanceof HTMLInputElement) || (el instanceof HTMLTextAreaElement && clone instanceof HTMLTextAreaElement)) fieldText(el, clone, css, rect, layer);
          return;
        }
        if (hasBoxSurface(css)) {
          const visual = document.createElement('div');
          visual.style.cssText = 'width:100%;height:100%;box-sizing:border-box;';
          for (const property of boxProps) visual.style.setProperty(property, css.getPropertyValue(property));
          visual.style.opacity = String(opacity);
          const signature = `${Math.round(rect.width)}:${Math.round(rect.height)}:${css.background}:${css.border}:${css.borderRadius}`;
          own = add(rect.height <= 3 || rect.width <= 3 ? 'line' : 'box', rect, visual, container, parent, signature);
          withClip(own);
        }
      }
      const childClip = (() => {
        if (inline) return clip;
        if (!['hidden', 'clip', 'auto', 'scroll'].some(v => css.overflowX === v || css.overflowY === v)) return clip;
        if (el === document.body || el === document.documentElement) return clip;
        if (!clip) return rect;
        return new DOMRect(Math.max(clip.left, rect.left), Math.max(clip.top, rect.top), Math.max(0, Math.min(clip.right, rect.right) - Math.max(clip.left, rect.left)), Math.max(0, Math.min(clip.bottom, rect.bottom) - Math.max(clip.top, rect.top)));
      })();
      // Text in one inline formatting context, including text inside inline
      // links/spans/bold, becomes one sequential typing task in reading order.
      let holder = inline;
      if (!holder) {
        const ownHolder: FlowHolder = { owner: own, clip: childClip, container, flush: () => { if (ownHolder.current) commit(ownHolder.current); ownHolder.current = undefined; } };
        if (css.textOverflow === 'ellipsis' && css.overflowX !== 'visible' && el instanceof HTMLElement && el.scrollWidth > el.clientWidth + 1) {
          measure ??= document.createElement('canvas').getContext('2d');
          if (measure) measure.font = `${css.fontStyle} ${css.fontWeight} ${css.fontSize} ${css.fontFamily}`;
          const width = measure ? measure.measureText('…').width : parseFloat(css.fontSize) * .8;
          ownHolder.ellipsis = { limit: rect.right - (parseFloat(css.borderRightWidth) || 0) - (parseFloat(css.paddingRight) || 0) - width, width, done: false };
        }
        holder = ownHolder;
      }
      for (const node of Array.from(el.childNodes)) {
        if (layers.length >= maxLayers) break;
        if (node.nodeType === Node.ELEMENT_NODE) {
          const next = node as Element;
          const nextTag = next.tagName.toUpperCase();
          const nextCss = getComputedStyle(next);
          const continues = (nextCss.display === 'inline' || nextCss.display === 'contents') && !mediaTags.has(nextTag) && !hasBoxSurface(nextCss) && !linearTransform(nextCss);
          if (continues) yield* walk(next, own, opacity, childClip, container, holder);
          else { holder.flush(); yield* walk(next, own, opacity, childClip, container); }
          continue;
        }
        if (node.nodeType !== Node.TEXT_NODE || !node.textContent) continue;
        const trimmed = node.textContent.trim();
        if (!trimmed) {
          if (holder.current?.runs.length) yield* measureText(node as Text, el, css, opacity, holder, true);
          continue;
        }
        yield* measureText(node as Text, el, css, opacity, holder, false);
      }
      if (el.shadowRoot) {
        holder.flush();
        for (const shadowChild of Array.from(el.shadowRoot.children)) yield* walk(shadowChild, own, opacity, childClip, container);
      }
      if (!inline) holder.flush();
    } finally {
      if (restore) { transformDepth--; restore(); }
    }
  }
  yield* walk(target, undefined, 1, viewport, root);
  return { layers, background };
}

/** Map a point in a layer's measuring frame to its final page position. */
export function layerPoint(layer: Layer, x: number, y: number) {
  const m = layer.container.matrix;
  if (!m) return { x, y };
  const lx = x - layer.container.ox, ly = y - layer.container.oy;
  return { x: m.a * lx + m.c * ly + m.e, y: m.b * lx + m.d * ly + m.f };
}

/** Synchronous entry for callers that already own a scheduling budget. */
export function snapshot(target: HTMLElement, stage: HTMLElement, maxLayers: number, viewport?: DOMRect): Snapshot {
  const steps = snapshotSteps(target, stage, maxLayers, viewport);
  let next = steps.next();
  while (!next.done) next = steps.next();
  return next.value;
}
