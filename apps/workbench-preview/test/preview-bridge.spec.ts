import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { injectWorkbenchPreviewBridge } from "../src/preview-bridge.js";

describe("Preview Penpal bridge", () => {
  it("injects one invisible, versioned bridge without changing product markup", () => {
    const source = "<!doctype html><html><head><title>产品工作台</title></head><body><main class=\"screen\">内容</main></body></html>";
    const result = injectWorkbenchPreviewBridge(source, "https://workbench.example.com", "wbpv1.payload.signature");

    expect(result.html).toContain("<title>产品工作台</title>");
    expect(result.html).toContain('<main class="screen">内容</main>');
    expect(result.html.match(/data-workbench-preview-bridge="v1"/gu)).toHaveLength(1);
    expect(result.html).toContain("workbench.preview.v1:wbpv1.payload.signature");
    expect(result.html).toContain("https://workbench.example.com");
    expect(result.html).toContain("PREVIEW_RPC_HANDSHAKE_INVALID");
    expect(result.html).toContain("if(window.parent===window)return");
    expect(result.html).not.toContain("sourceMappingURL=penpal.min.js.map");
    expect(result.etag).toBe(`"${createHash("sha256").update(result.bytes).digest("hex")}"`);
  });

  it("rejects ambiguous bridge markers and non-origin parent values", () => {
    expect(() => injectWorkbenchPreviewBridge(
      '<html><head><script data-workbench-preview-bridge="v1"></script></head><body></body></html>',
      "https://workbench.example.com",
      "token",
    )).toThrow("PREVIEW_BRIDGE_MARKER_CONFLICT");
    expect(() => injectWorkbenchPreviewBridge(
      "<html><head></head><body></body></html>",
      "https://workbench.example.com/path",
      "token",
    )).toThrow("PREVIEW_WEB_ORIGIN_INVALID");
    expect(() => injectWorkbenchPreviewBridge(
      "<html><head></head><body></body></html>",
      "https://workbench.example.com",
      "invalid/token",
    )).toThrow();
  });
});
