export type PrototypePreviewInteraction = {
  type: "workbench-prototype-v2:interaction";
  event: "click" | "focus" | "input" | "change" | "submit";
  target: string;
  tag: string;
  label: string;
  pageId?: string;
  value?: string;
};

const bridgeScript = `(() => {
  const selector = (node) => {
    if (!(node instanceof Element)) return "document";
    const stable = node.closest('[data-wb-node], [data-prototype-node]');
    if (stable) {
      const attribute = stable.hasAttribute('data-wb-node') ? 'data-wb-node' : 'data-prototype-node';
      const id = stable.getAttribute(attribute);
      if (/^[A-Za-z0-9_.:-]+$/.test(id || '')) return stable.tagName.toLowerCase() + '[' + attribute + '="' + id + '"]';
    }
    const parts = [];
    let current = node;
    while (current && current instanceof Element && parts.length < 5) {
      let part = current.tagName.toLowerCase();
      if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(current.id)) part += "#" + current.id;
      parts.unshift(part);
      current = current.parentElement;
    }
    return parts.join(" > ");
  };
  const report = (event, node) => {
    const target = node instanceof Element ? node : document.documentElement;
    const sensitive = target instanceof HTMLInputElement && target.type === "password";
    const value = sensitive ? "[redacted]"
      : target instanceof HTMLInputElement && ['checkbox', 'radio'].includes(target.type) ? String(target.checked)
      : target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement ? target.value.slice(0, 256) : undefined;
    const screen = target.closest('[data-wb-screen], [data-prototype-screen]');
    const pageId = screen?.getAttribute('data-wb-screen') || screen?.getAttribute('data-prototype-screen') || undefined;
    parent.postMessage({ type: "workbench-prototype-v2:interaction", event,
      target: selector(target), tag: target.tagName.toLowerCase(), pageId,
      label: (target.getAttribute("aria-label") || target.getAttribute("name") || target.textContent || "").trim().slice(0, 160),
      ...(value === undefined ? {} : { value }),
    }, "*");
  };
  document.addEventListener("click", (event) => report("click", event.target), true);
  document.addEventListener("focusin", (event) => report("focus", event.target), true);
  document.addEventListener("input", (event) => report("input", event.target), true);
  document.addEventListener("change", (event) => report("change", event.target), true);
  document.addEventListener("submit", (event) => { event.preventDefault(); report("submit", event.target); }, true);
  document.addEventListener('workbench:prototype-page', (event) => {
    if (typeof event.detail?.pageId === 'string') parent.postMessage({type:'workbench.prototype.page', pageId:event.detail.pageId}, '*');
  });
  window.addEventListener('message', (event) => {
    if (event.source !== parent || event.data?.type !== 'workbench.prototype.select-page' || typeof event.data.pageId !== 'string') return;
    document.dispatchEvent(new CustomEvent('workbench:prototype-select-page', {detail:{pageId:event.data.pageId}}));
  });
})();`;

const safetyHead = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; form-action 'none'; connect-src 'none'; frame-src 'none'; base-uri 'none';"><script>${bridgeScript}</script>`;

export function createPrototypeSandboxDocument(content: string): string {
  if (/<html[\s>]/iu.test(content)) {
    if (/<head(?:\s[^>]*)?>/iu.test(content)) return content.replace(/<head(?:\s[^>]*)?>/iu, (head) => `${head}${safetyHead}`);
    return content.replace(/<html(?:\s[^>]*)?>/iu, (html) => `${html}<head>${safetyHead}</head>`);
  }
  return `<!doctype html><html><head>${safetyHead}</head><body>${content}</body></html>`;
}

export function parsePrototypePreviewPage(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const message = value as Record<string, unknown>;
  return message.type === "workbench.prototype.page" && typeof message.pageId === "string" && message.pageId.length <= 160 ? message.pageId : undefined;
}

export function parsePrototypePreviewInteraction(value: unknown): PrototypePreviewInteraction | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== "workbench-prototype-v2:interaction") return undefined;
  if (!["click", "focus", "input", "change", "submit"].includes(candidate.event as string)) return undefined;
  if (!["string", "undefined"].includes(typeof candidate.value)) return undefined;
  if (!["string", "undefined"].includes(typeof candidate.pageId)) return undefined;
  if (typeof candidate.target !== "string" || typeof candidate.tag !== "string" || typeof candidate.label !== "string") return undefined;
  return {
    type: "workbench-prototype-v2:interaction",
    event: candidate.event as PrototypePreviewInteraction["event"],
    target: candidate.target.slice(0, 500), tag: candidate.tag.slice(0, 80), label: candidate.label.slice(0, 160),
    ...(typeof candidate.pageId === "string" ? { pageId: candidate.pageId.slice(0, 160) } : {}),
    ...(typeof candidate.value === "string" ? { value: candidate.value.slice(0, 256) } : {}),
  };
}
