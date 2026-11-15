import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PreviewService } from "../src/preview.service.js";
import { PreviewStorage } from "../src/storage.js";
import { renderPreviewHtmlFixture } from "../../../scripts/test-support/preview-html-fixture.mjs";

const renderPreview = (html: string, webOrigin: string, capabilityId: string) =>
  renderPreviewHtmlFixture({ PreviewService, PreviewStorage, html, webOrigin, capabilityId });

describe("Preview Penpal bridge", () => {
  it("injects one invisible, versioned bridge without changing product markup", async () => {
    const source = "<!doctype html><html><head><title>产品工作台</title></head><body><main class=\"screen\">内容</main></body></html>";
    const result = await renderPreview(source, "https://workbench.example.com", "wbpv2.payload.signature");

    expect(result.html).toContain("<title>产品工作台</title>");
    expect(result.html).toContain('<main class="screen">内容</main>');
    expect(result.html.match(/data-workbench-preview-bridge="v1"/gu)).toHaveLength(1);
    expect(result.html).toContain("workbench.preview.v1:wbpv2.payload.signature");
    expect(result.html).toContain("https://workbench.example.com");
    expect(result.html).toContain("PREVIEW_RPC_HANDSHAKE_INVALID");
    expect(result.html).toContain("if(window.parent===window)return");
    expect(result.html).not.toContain("sourceMappingURL=penpal.min.js.map");
    const bridge = result.html.match(/<script data-workbench-preview-bridge="v1">([\s\S]*?)<\/script>/u)?.[1];
    expect(bridge).toBeTruthy();
    expect(result.contentSecurityPolicy).toContain(`'sha256-${createHash("sha256").update(bridge!).digest("base64")}'`);
  });

  it("rejects ambiguous bridge markers and non-origin parent values", async () => {
    await expect(renderPreview(
      '<html><head><script data-workbench-preview-bridge="v1"></script></head><body></body></html>',
      "https://workbench.example.com",
      "token",
    )).rejects.toThrow("PREVIEW_BRIDGE_MARKER_CONFLICT");
    await expect(renderPreview(
      "<html><head></head><body></body></html>",
      "https://workbench.example.com/path",
      "token",
    )).rejects.toThrow("PREVIEW_WEB_ORIGIN_INVALID");
    await expect(renderPreview(
      "<html><head></head><body></body></html>",
      "https://workbench.example.com",
      "invalid/token",
    )).rejects.toThrow();
  });
});
