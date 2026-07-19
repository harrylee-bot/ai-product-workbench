import { createHash, type Hash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  workbenchPreviewRpcProtocol,
  workbenchPreviewRpcChannelForCapability,
  workbenchPreviewRpcVersion,
} from "@workbench/workbench-contracts";
import {
  defaultTreeAdapter,
  html as htmlNamespace,
  parse,
  serialize,
  type DefaultTreeAdapterTypes,
} from "parse5";
import { Parser } from "htmlparser2";

const bridgeAttribute = "data-workbench-preview-bridge";
const connectionTimeoutMs = 8_000;
const require = createRequire(import.meta.url);
const penpalEntryPath = require.resolve("penpal");
const penpalBrowserPath = join(dirname(penpalEntryPath), "penpal.min.js");
const penpalBrowserSource = readFileSync(penpalBrowserPath, "utf8")
  .replace(/\/\/# sourceMappingURL=.*$/u, "")
  .trim();

assertSafeInlineScript(penpalBrowserSource, "Penpal browser bundle");

export type WorkbenchPreviewHtmlInspection = {
  headEndOffset: number;
  scriptSha256: string[];
  styleSha256: string[];
};

export class WorkbenchPreviewHtmlInspector {
  private readonly parser: Parser;
  private readonly scriptSha256: string[] = [];
  private readonly styleSha256: string[] = [];
  private headEndOffset: number | null = null;
  private inline: { tagName: "script" | "style"; digest: Hash } | null = null;
  private sealed = false;

  constructor() {
    this.parser = new Parser({
      onopentag: (name, attributes) => this.onOpenTag(name, attributes),
      ontext: (value) => this.inline?.digest.update(value, "utf8"),
      onclosetag: (name) => {
        if (this.inline?.tagName === name) this.finishInline();
      },
    }, {
      decodeEntities: true,
      lowerCaseAttributeNames: true,
      lowerCaseTags: true,
      recognizeSelfClosing: true,
    });
  }

  async write(value: string) {
    if (this.sealed) throw new Error("PREVIEW_HTML_INSPECTOR_SEALED");
    this.parser.write(value);
  }

  async finish(): Promise<WorkbenchPreviewHtmlInspection> {
    if (this.sealed) throw new Error("PREVIEW_HTML_INSPECTOR_SEALED");
    this.sealed = true;
    this.parser.end();
    if (this.inline) this.finishInline();
    if (this.headEndOffset === null) throw new Error("PREVIEW_HTML_HEAD_MISSING");
    return {
      headEndOffset: this.headEndOffset,
      scriptSha256: this.scriptSha256,
      styleSha256: this.styleSha256,
    };
  }

  private onOpenTag(name: string, attributes: Record<string, string>) {
    if (Object.hasOwn(attributes, bridgeAttribute)) {
      throw new Error("PREVIEW_BRIDGE_MARKER_CONFLICT");
    }
    if (name === "head" && this.headEndOffset === null) {
      const offset = this.parser.endIndex + 1;
      if (!Number.isSafeInteger(offset) || offset <= 0) {
        throw new Error("PREVIEW_HTML_HEAD_LOCATION_INVALID");
      }
      this.headEndOffset = offset;
    }
    if (name === "script" || name === "style") {
      if (this.inline) this.finishInline();
      this.inline = { tagName: name, digest: createHash("sha256") };
    }
  }

  private finishInline() {
    if (!this.inline) return;
    const target = this.inline.tagName === "script" ? this.scriptSha256 : this.styleSha256;
    target.push(this.inline.digest.digest("base64"));
    this.inline = null;
  }
}

export function injectWorkbenchPreviewBridge(
  html: string,
  webOrigin: string,
  capabilityId: string,
) {
  const document = parse(html);
  if (findElement(document, (element) => hasAttribute(element, bridgeAttribute))) {
    throw new Error("PREVIEW_BRIDGE_MARKER_CONFLICT");
  }
  const head = findElement(document, (element) => element.tagName === "head");
  if (!head) throw new Error("PREVIEW_HTML_HEAD_MISSING");

  const bridge = createWorkbenchPreviewBridgeInjection(webOrigin, capabilityId);
  const script = defaultTreeAdapter.createElement("script", htmlNamespace.NS.HTML, [
    { name: bridgeAttribute, value: `v${workbenchPreviewRpcVersion}` },
  ]);
  defaultTreeAdapter.insertText(script, bridge.source);
  defaultTreeAdapter.appendChild(head, script);

  const transformedHtml = serialize(document);
  const bytes = new TextEncoder().encode(transformedHtml);
  return {
    bytes,
    etag: `"${createHash("sha256").update(bytes).digest("hex")}"`,
    html: transformedHtml,
  };
}

export function createWorkbenchPreviewBridgeInjection(
  webOrigin: string,
  capabilityId: string,
) {
  const source = `${penpalBrowserSource}\n;${bridgeBootstrapSource(webOrigin, capabilityId)}`;
  assertSafeInlineScript(source, "Preview bridge");
  return {
    markup: `<script ${bridgeAttribute}="v${workbenchPreviewRpcVersion}">${source}</script>`,
    source,
    scriptSha256: createHash("sha256").update(source, "utf8").digest("base64"),
  };
}

function bridgeBootstrapSource(webOrigin: string, capabilityId: string) {
  const allowedParentOrigin = JSON.stringify(assertOrigin(webOrigin));
  const protocol = JSON.stringify(workbenchPreviewRpcProtocol);
  const channel = JSON.stringify(workbenchPreviewRpcChannelForCapability(capabilityId));
  const version = JSON.stringify(workbenchPreviewRpcVersion);
  return `(()=>{"use strict";const api=Penpal;Penpal=undefined;if(window.parent===window)return;const protocol=${protocol};const version=${version};let state="loading";let runtimeFailed=false;let bridgeFailed=false;let connection;const failRuntime=()=>{runtimeFailed=true;if(state!=="loading")state="error"};addEventListener("error",failRuntime,{capture:true});addEventListener("unhandledrejection",failRuntime);addEventListener("load",()=>{state=bridgeFailed||runtimeFailed?"error":"ready"},{once:true});const exactHandshake=input=>{if(!input||typeof input!=="object"||Array.isArray(input)||Object.keys(input).sort().join(",")!=="protocol,version"||input.protocol!==protocol||input.version!==version)throw new TypeError("PREVIEW_RPC_HANDSHAKE_INVALID")};try{const messenger=new api.WindowMessenger({remoteWindow:window.parent,allowedOrigins:[${allowedParentOrigin}]});connection=api.connect({messenger,channel:${channel},timeout:${connectionTimeoutMs},methods:{handshake(input){exactHandshake(input);if(state==="loading")throw new Error("PREVIEW_NOT_READY");return state==="ready"?{protocol,version,state:"ready",errorCode:null}:{protocol,version,state:"error",errorCode:bridgeFailed?"PREVIEW_BRIDGE_ERROR":"PREVIEW_RUNTIME_ERROR"}}}});connection.promise.catch(()=>{bridgeFailed=true;state="error";connection.destroy()})}catch{bridgeFailed=true;state="error"}addEventListener("pagehide",()=>connection?.destroy(),{once:true})})();`;
}

function assertOrigin(value: string) {
  const url = new URL(value);
  if (
    !url.hostname
    || !["http:", "https:"].includes(url.protocol)
    || url.username
    || url.password
    || url.search
    || url.hash
    || (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error("PREVIEW_WEB_ORIGIN_INVALID");
  }
  return url.origin;
}

function assertSafeInlineScript(source: string, label: string) {
  if (/<\/script/i.test(source)) throw new Error(`${label} contains a closing script tag`);
}

function hasAttribute(element: DefaultTreeAdapterTypes.Element, name: string) {
  return element.attrs.some((attribute) => attribute.name === name);
}

function findElement(
  node: DefaultTreeAdapterTypes.Node,
  predicate: (element: DefaultTreeAdapterTypes.Element) => boolean,
): DefaultTreeAdapterTypes.Element | null {
  if ("tagName" in node && predicate(node)) return node;
  if (!("childNodes" in node)) return null;
  for (const child of node.childNodes) {
    const found = findElement(child, predicate);
    if (found) return found;
  }
  return null;
}
