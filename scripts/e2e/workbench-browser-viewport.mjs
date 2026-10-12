// Viewport emulation can acknowledge before responsive styles and ResizeObserver
// work have reached a painted frame. Never combine coordinates from that interval
// with a screenshot taken after Chromium has completed the resize.
export async function waitForStableViewportLayout(page, viewport, { selectors, timeoutMs = 5_000 } = {}) {
  return page.evaluate(({ width, height, selectors, timeoutMs }) => new Promise((resolve, reject) => {
    let previous = null;
    let stableFrames = 0;
    let animationFrame;
    const timeout = setTimeout(() => {
      cancelAnimationFrame(animationFrame);
      reject(new Error("VIEWPORT_LAYOUT_DID_NOT_SETTLE"));
    }, timeoutMs);
    const sample = () => {
      const matches = innerWidth === width && innerHeight === height
        && document.documentElement.clientWidth === width
        && document.documentElement.clientHeight === height
        && matchMedia(`(width: ${width}px) and (height: ${height}px)`).matches;
      const rectangles = selectors.map((selector) => {
        const element = document.querySelector(selector);
        if (!(element instanceof HTMLElement)) return null;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return [style.display, style.visibility, ...[rect.left, rect.top, rect.right, rect.bottom]
          .map((value) => Math.round(value * 1_000) / 1_000)];
      });
      const fingerprint = JSON.stringify(rectangles);
      stableFrames = matches && fingerprint === previous ? stableFrames + 1 : 0;
      previous = matches ? fingerprint : null;
      if (stableFrames >= 3) {
        clearTimeout(timeout);
        resolve({ width: innerWidth, height: innerHeight, stableFrames });
        return;
      }
      animationFrame = requestAnimationFrame(sample);
    };
    animationFrame = requestAnimationFrame(sample);
  }), { ...viewport, selectors: selectors ?? ["body"], timeoutMs });
}
