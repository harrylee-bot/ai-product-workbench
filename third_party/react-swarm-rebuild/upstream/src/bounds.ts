/** Intersect a component with its viewport and any scrolling/clipping ancestors. */
export function visibleBounds(target: HTMLElement): DOMRect {
  const rect = target.getBoundingClientRect();
  let left = Math.max(0, rect.left), top = Math.max(0, rect.top);
  let right = Math.min(window.innerWidth, rect.right), bottom = Math.min(window.innerHeight, rect.bottom);
  for (let parent = target.parentElement; parent; parent = parent.parentElement) {
    const css = getComputedStyle(parent), box = parent.getBoundingClientRect();
    if (/^(hidden|clip|auto|scroll)$/.test(css.overflowX)) {
      left = Math.max(left, box.left + parent.clientLeft);
      right = Math.min(right, box.left + parent.clientLeft + parent.clientWidth);
    }
    if (/^(hidden|clip|auto|scroll)$/.test(css.overflowY)) {
      top = Math.max(top, box.top + parent.clientTop);
      bottom = Math.min(bottom, box.top + parent.clientTop + parent.clientHeight);
    }
  }
  return new DOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
}

export function backgroundColor(target: HTMLElement): string {
  for (let node: HTMLElement | null = target; node; node = node.parentElement) {
    const color = getComputedStyle(node).backgroundColor;
    if (color && color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)') return color;
  }
  return '#ffffff';
}
