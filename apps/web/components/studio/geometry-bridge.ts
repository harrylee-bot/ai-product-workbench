import {
  prototypeGeometryMessageSchema,
  type PrototypeGeometryMessage,
} from "@workbench/workbench-contracts";

export type GeometryIdentity = {
  sessionId: string;
  revisionId: string;
  pageId: string;
};
export function acceptPrototypeGeometry(
  data: unknown,
  identity: GeometryIdentity,
  lastSequence: number,
): PrototypeGeometryMessage | null {
  const parsed = prototypeGeometryMessageSchema.safeParse(data);
  if (!parsed.success) return null;
  const message = parsed.data;
  return message.sessionId === identity.sessionId &&
    message.revisionId === identity.revisionId &&
    message.pageId === identity.pageId &&
    message.sequence > lastSequence
    ? message
    : null;
}

/** Runs only inside an opaque-origin temporary document. Never alters frozen bytes. */
export function prototypeGeometryScript(
  identity: Omit<GeometryIdentity, "pageId">,
): string {
  const config = JSON.stringify(identity).replace(/</g, "\\u003c");
  return `(() => {
    const identity = ${config};
    let pageId = '', sequence = 0, mode = 'browse', selected = null, hovered = null, raf = 0, pendingSelection = false, pendingHover = false, pendingMeasure = false;
    const page = () => [...document.querySelectorAll('[data-wb-screen]')].find(e => e.getAttribute('data-wb-screen') === pageId);
    const selector = (element) => {
      if (!(element instanceof Element)) return null;
      const id = element.getAttribute('data-wb-node');
      return id && /^[A-Za-z0-9_.:-]+$/.test(id) ? element.tagName.toLowerCase()+'[data-wb-node="'+id+'"]' : null;
    };
    const geometry = (element) => {
      if (!(element instanceof Element) || !element.isConnected || !page()?.contains(element)) return null;
      const rect = element.getBoundingClientRect(), target = selector(element);
      if (!target || !rect.width || !rect.height || rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) return null;
      const numbers = [rect.x,rect.y,rect.width,rect.height]; if (numbers.some(n => !Number.isFinite(n) || Math.abs(n) > 32768)) return null;
      return { nodeId: element.getAttribute('data-wb-node'),
        selector: target, parentSelector: selector(element.parentElement), tag: element.tagName.toLowerCase(),
        label: (element.getAttribute('aria-label') || element.getAttribute('name') || element.textContent || element.tagName).trim().slice(0,160),
        x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    const send = (kind, node, layers = []) => {
      if (!pageId) return;
      parent.postMessage({ protocol: 'workbench.studio.frame.v1', ...identity, pageId, sequence: ++sequence, kind, node, layers,
        viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY } }, '*');
    };
    const measure = () => {
      raf = 0;
      const selection = pendingSelection, hover = pendingHover, measurement = pendingMeasure;
      pendingSelection = false; pendingHover = false; pendingMeasure = false;
      // Selection is semantic state, not a geometry notification. Never let a
      // subsequent scroll, mutation or hover in the same frame replace it.
      if (selection) send('selection', geometry(selected));
      else if (measurement) send('measure', geometry(selected));
      if (hover) send('hover', geometry(hovered));
    };
    const schedule = (kind = 'measure') => {
      if (kind === 'selection') pendingSelection = true;
      else if (kind === 'hover') pendingHover = true;
      else pendingMeasure = true;
      if (!raf) raf = requestAnimationFrame(measure);
    };
    const layers = () => [...(page()?.querySelectorAll('[data-wb-node]') || [])].slice(0,120).map(e => {
      const result = geometry(e); if (result) return result;
      const target = selector(e); return target ? { nodeId: e.getAttribute('data-wb-node'), selector:target, parentSelector:selector(e.parentElement), tag:e.tagName.toLowerCase(), label:(e.getAttribute('aria-label') || e.textContent || e.tagName).trim().slice(0,160), x:0,y:0,width:0,height:0 } : null;
    }).filter(Boolean);
    const query = (target) => { try { return typeof target === 'string' && target.length <= 500 ? page()?.querySelector(target) || (page()?.matches(target) ? page() : null) : null; } catch { return null; } };
    window.addEventListener('message', e => {
      const d = e.data; if (e.source !== parent || d?.protocol !== 'workbench.studio.frame.v1' || d.sessionId !== identity.sessionId || d.revisionId !== identity.revisionId) return;
      if (typeof d.pageId !== 'string' || !d.pageId || d.pageId.length > 160) return;
      if (pageId !== d.pageId) { pageId = d.pageId; selected = null; hovered = null; }
      if (d.command === 'page') { document.dispatchEvent(new CustomEvent('workbench:prototype-select-page',{detail:{pageId}})); send('page',null); }
      if (d.command === 'mode' && ['browse','select'].includes(d.mode)) { mode = d.mode; if (mode === 'browse') { selected = null; send('selection', null); } }
      if (d.command === 'selectNode') { selected = typeof d.nodeId === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/.test(d.nodeId) ? query('[data-wb-node="'+d.nodeId+'"]') : null; if (selected) { selected.scrollIntoView({block:'center',inline:'nearest'}); schedule('selection'); } else send('missing',null); }
      if (d.command === 'select') { selected = query(d.selector); if (selected) { selected.scrollIntoView({block:'center',inline:'nearest'}); schedule('selection'); } else send('missing',null); }
      if (d.command === 'parent' && selected) { selected = selected.parentElement?.closest('[data-wb-node]') || null; schedule('selection'); }
      if (d.command === 'layers' || d.command === 'mode') send('layers',geometry(selected),layers());
      schedule();
    });
    document.addEventListener('pointermove', e => { if (mode === 'select') { hovered = e.target instanceof Element ? e.target.closest('[data-wb-node]') : null; schedule('hover'); } }, true);
    for (const type of ['pointerdown','pointerup','click','dblclick','submit','keydown']) document.addEventListener(type, e => {
      if (mode !== 'select') return;
      if (type === 'keydown' && e.key === 'Escape') { mode = 'browse'; selected = null; send('exit',null); return; }
      if (type === 'keydown' && !['Enter',' '].includes(e.key)) return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (type === 'click' || type === 'keydown') { selected = e.target instanceof Element ? e.target.closest('[data-wb-node]') : null; if (selected) schedule('selection'); else send('missing',null); }
    }, true);
    document.addEventListener('workbench:prototype-page', e => { const next = e.detail?.pageId; if (typeof next !== 'string' || !next || next.length > 160) return; pageId = next; selected = null; send('page',null); });
    document.addEventListener('submit',e=>e.preventDefault(),true);
    document.addEventListener('scroll', () => schedule(), true);
    window.addEventListener('resize', () => schedule());
    new MutationObserver(() => schedule()).observe(document.documentElement,{childList:true,subtree:true,attributes:true});
    window.addEventListener('load', () => { send('ready',null); schedule(); });
  })();`;
}
