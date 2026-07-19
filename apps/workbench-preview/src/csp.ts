import { createHash } from "node:crypto";
import { parse } from "parse5";

type HtmlNode = {
  nodeName?: string;
  tagName?: string;
  value?: string;
  childNodes?: HtmlNode[];
};

export function previewContentSecurityPolicy(html: string, webOrigin: string) {
  const document = parse(html) as HtmlNode;
  const scripts: string[] = [];
  const styles: string[] = [];
  visit(document, (node) => {
    if (node.tagName === "script") scripts.push(textContent(node));
    if (node.tagName === "style") styles.push(textContent(node));
  });
  return previewContentSecurityPolicyFromHashes({
    scriptSha256: scripts.map(inlineSourceSha256),
    styleSha256: styles.map(inlineSourceSha256),
  }, webOrigin);
}

export function previewContentSecurityPolicyFromHashes(
  hashes: {
    scriptSha256: Iterable<string>;
    styleSha256: Iterable<string>;
  },
  webOrigin: string,
) {
  const scriptSources = cspSources(hashes.scriptSha256);
  const styleSources = cspSources(hashes.styleSha256);
  return [
    "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox",
    "default-src 'none'",
    `script-src-elem ${scriptSources.length ? scriptSources.join(" ") : "'none'"}`,
    "script-src-attr 'none'",
    `style-src-elem ${styleSources.length ? styleSources.join(" ") : "'none'"}`,
    "style-src-attr 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "media-src data: blob:",
    "connect-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${webOrigin}`,
  ].join("; ");
}

export function inlineSourceSha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("base64");
}

function cspSources(values: Iterable<string>) {
  return [...new Set(values)].sort().map((value) => `'sha256-${value}'`);
}

function textContent(node: HtmlNode): string {
  if (node.nodeName === "#text") return node.value ?? "";
  return (node.childNodes ?? []).map(textContent).join("");
}

function visit(node: HtmlNode, callback: (node: HtmlNode) => void) {
  callback(node);
  for (const child of node.childNodes ?? []) visit(child, callback);
}
