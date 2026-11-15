import {
  prototypeGeometryScript,
  type GeometryIdentity,
} from "./geometry-bridge";
export type PrototypePreviewInteraction = {
  nodeId: string;
  revisionId: string;
  target: string;
  tag: string;
  label: string;
  pageId: string;
};
/** An isolated, temporary viewing copy. No changes are persisted into the frozen export. */
export function createPrototypeSandboxDocument(
  content: string,
  identity: Omit<GeometryIdentity, "pageId">,
): string {
  const headContent = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; form-action 'none'; connect-src 'none'; frame-src 'none'; base-uri 'none';"><script>${prototypeGeometryScript(identity)}</script>`;
  if (/<html[\s>]/iu.test(content)) {
    if (/<head(?:\s[^>]*)?>/iu.test(content))
      return content.replace(
        /<head(?:\s[^>]*)?>/iu,
        (head) => `${head}${headContent}`,
      );
    return content.replace(
      /<html(?:\s[^>]*)?>/iu,
      (html) => `${html}<head>${headContent}</head>`,
    );
  }
  return `<!doctype html><html><head>${headContent}</head><body>${content}</body></html>`;
}
