// Playwright considers an opacity:0 heading visible. Do not include the Home
// page's initial entrance in the later Home-to-Project transition recording.
export async function waitForInitialHomeVisualReady(page, { expectedHref, timeoutMs = 8_000 } = {}) {
  return page.evaluate(({ expectedHref, timeoutMs }) => new Promise((resolve, reject) => {
    let animationFrame;
    let previousRoot = null;
    let previousHeader = null;
    let previous = null;
    let stableFrames = 0;
    let lastSnapshot = null;
    const timeout = setTimeout(() => {
      cancelAnimationFrame(animationFrame);
      reject(new Error(`INITIAL_HOME_VISUAL_NOT_READY: ${JSON.stringify(lastSnapshot)}`));
    }, timeoutMs);
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) < 0.99) return false;
      }
      return true;
    };
    const snapshot = (element) => {
      if (!(element instanceof HTMLElement)) return null;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        visible: visible(element),
        opacity: Number(style.opacity),
        transform: style.transform,
        transformSettled: style.transform === "none" || new DOMMatrixReadOnly(style.transform).isIdentity,
        rect: [rect.x, rect.y, rect.width, rect.height],
      };
    };
    const sample = () => {
      const stage = document.querySelector("[data-workbench-stage]");
      const heading = [...document.querySelectorAll("h1,h2,h3")]
        .find((element) => element.textContent?.includes("欢迎使用产品工作台"));
      let root = heading;
      while (root?.parentElement && root.parentElement !== stage) root = root.parentElement;
      if (root?.parentElement !== stage) root = null;
      const header = root?.querySelector("header") ?? null;
      lastSnapshot = { href: location.href, root: snapshot(root), header: snapshot(header) };
      const ready = (!expectedHref || location.href === expectedHref)
        && lastSnapshot.root?.visible && lastSnapshot.root.transformSettled
        && lastSnapshot.header?.visible && lastSnapshot.header.transformSettled;
      const fingerprint = JSON.stringify(lastSnapshot);
      stableFrames = ready && root === previousRoot && header === previousHeader && fingerprint === previous
        ? stableFrames + 1 : 0;
      previousRoot = root;
      previousHeader = header;
      previous = ready ? fingerprint : null;
      if (stableFrames >= 3) {
        clearTimeout(timeout);
        resolve({ stableFrames, ...lastSnapshot });
        return;
      }
      animationFrame = requestAnimationFrame(sample);
    };
    animationFrame = requestAnimationFrame(sample);
  }), { expectedHref, timeoutMs });
}
