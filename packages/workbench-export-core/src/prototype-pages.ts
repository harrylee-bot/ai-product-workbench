import { createHash } from "node:crypto";
import { prototypePageSchema, type PrototypePage } from "@workbench/workbench-contracts";
import { escapeHtml, safeScriptJson } from "./encoding.js";
import { renderPrototypeDocumentHtml, renderPrototypeDocumentPages } from "./html-renderer.js";
import type { ExportBinaryAsset } from "./types.js";

const offlinePolicy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'self' data: blob:;";

/** Freeze one executable document from immutable IR and verified page bodies.
 * The runtime and all screens are rendered once, preserving navigation state.
 * Explicit HTML documents execute inside their own opaque sandbox. */
export function renderPrototypePagesHtml(revisionId: string, title: string, values: readonly PrototypePage[], source?: { document: unknown; assets?: ExportBinaryAsset[] }): string {
  const pages = values.map((value) => prototypePageSchema.parse(value)).sort((a, b) => a.order - b.order);
  if (pages.length === 0) throw new Error("PROTOTYPE_PAGES_EMPTY");
  for (const page of pages) {
    if (createHash("sha256").update(page.content).digest("hex") !== page.sha256) throw new Error("PROTOTYPE_PAGE_INTEGRITY_FAILURE");
  }
  if (source) {
    const expected = renderPrototypeDocumentPages(source.document, source.assets);
    if (expected.length !== pages.length || expected.some((page, index) => {
      const actual = pages[index]!;
      return page.id !== actual.id || page.route !== actual.route || page.title !== actual.title || page.order !== actual.order || page.slug !== actual.slug || page.sha256 !== actual.sha256;
    })) throw new Error("PROTOTYPE_PAGE_SOURCE_MISMATCH");
    return renderPrototypeDocumentHtml(source.document, { assets: source.assets, revisionId }).document
      .replace("<head>", `<head><meta http-equiv="Content-Security-Policy" content="${escapeHtml(offlinePolicy)}">`);
  }
  if (pages.some(page => page.content.includes('data-workbench-prototype-page="v2"'))) throw new Error("PROTOTYPE_SHARED_DOCUMENT_REQUIRED");
  // Explicit HTML revisions have no typed IR. Keep their scripts inside a new
  // opaque-origin document for each page; never evaluate them in the shell.
  const data = safeScriptJson(pages.map(({ id, title: pageTitle, content }) => ({ id, title: pageTitle, content })));
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${escapeHtml(offlinePolicy)}"><title>${escapeHtml(title)}</title><style>body{margin:0;font-family:system-ui}nav{display:flex;gap:8px;padding:8px}iframe{width:100%;height:calc(100vh - 52px);border:0}</style></head><body data-prototype-revision="${escapeHtml(revisionId)}"><nav aria-label="Prototype pages" data-prototype-pages></nav><iframe title="${escapeHtml(title)}" data-prototype-content sandbox="allow-scripts allow-forms"></iframe><script>const pages=${data};const frame=document.querySelector('iframe');const select=(id)=>{const page=pages.find(x=>x.id===id)||pages[0];frame.srcdoc=page.content;frame.title=page.title;for(const button of document.querySelectorAll('[data-page-id]'))button.setAttribute('aria-selected',String(button.dataset.pageId===page.id));};document.querySelector('nav').replaceChildren(...pages.map(page=>{const button=document.createElement('button');button.type='button';button.dataset.pageId=page.id;button.textContent=page.title;button.onclick=()=>select(page.id);return button;}));select(pages[0].id);</script></body></html>`;
}
