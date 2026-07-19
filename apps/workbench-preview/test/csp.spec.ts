import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { previewContentSecurityPolicy } from "../src/csp.js";

describe("preview CSP", () => {
  it("hashes inline executable content and keeps the document in an opaque sandbox", () => {
    const script = "document.body.dataset.ready = 'yes';";
    const style = "body{color:#111}";
    const policy = previewContentSecurityPolicy(`<html><head><style>${style}</style></head><body style="margin:0"><script>${script}</script></body></html>`, "https://workbench.example.com");
    expect(policy).toContain(`'sha256-${createHash("sha256").update(script).digest("base64")}'`);
    expect(policy).toContain(`'sha256-${createHash("sha256").update(style).digest("base64")}'`);
    expect(policy).toContain("sandbox allow-scripts");
    expect(policy).not.toContain("allow-same-origin");
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain("frame-ancestors https://workbench.example.com");
  });
});
