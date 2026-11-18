// During a hard navigation WebKit can still run React effects on the outgoing
// document after it has stopped allowing new fetches. A rendered frame (or a
// bfcache restore) means this document may issue reads again.
export function createDocumentReads() {
  let nextFrame: Promise<void> | undefined;
  const observe = () => {
    let release: (() => void) | undefined;
    let frame: number | undefined;
    const resume = () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      frame = undefined;
      nextFrame = undefined;
      release?.();
      release = undefined;
    };
    const leaving = () => {
      if (nextFrame) return;
      nextFrame = new Promise<void>((resolve) => {
        release = resolve;
      });
      frame = window.requestAnimationFrame(resume);
    };
    window.addEventListener("beforeunload", leaving);
    window.addEventListener("pageshow", resume);
    return () => {
      window.removeEventListener("beforeunload", leaving);
      window.removeEventListener("pageshow", resume);
      resume();
    };
  };
  return {
    observe,
    fetch: async (request: Request) => {
      if (request.method === "GET" && nextFrame) await nextFrame;
      return globalThis.fetch(request);
    },
  };
}
