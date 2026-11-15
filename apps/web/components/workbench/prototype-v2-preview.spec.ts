import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
const { JSDOM } = createRequire(import.meta.url)("jsdom") as { JSDOM: new (html: string, options: { runScripts: "dangerously" }) => { window: Window & typeof globalThis } };
import { createPrototypeSandboxDocument, parsePrototypePreviewInteraction, parsePrototypePreviewPage } from "./prototype-v2-preview";

describe("prototype V2 sandbox preview", () => {
  it("keeps the iframe isolated while reporting real control events", () => {
    const document = createPrototypeSandboxDocument("<button id=save>Save</button><form><input name=email /></form>");
    expect(document).toContain("connect-src 'none'");
    expect(document).toContain("form-action 'none'");
    expect(document).toContain("workbench-prototype-v2:interaction");
    expect(document).toContain("addEventListener(\"submit\"");
    expect(document).toContain("preventDefault");
    expect(document).toContain("focusin");
  });

  it("accepts only bounded interaction messages from the bridge", () => {
    expect(parsePrototypePreviewInteraction({ type: "workbench-prototype-v2:interaction", event: "input", target: "input#email", tag: "input", label: "email", value: "a@example.com" })).toMatchObject({ event: "input", target: "input#email" });
    expect(parsePrototypePreviewInteraction({ type: "workbench-prototype-v2:interaction", event: "focus", target: "button#save", tag: "button", label: "Save" })).toMatchObject({ event: "focus" });
    expect(parsePrototypePreviewInteraction({ type: "other", event: "input", target: "body", tag: "body", label: "" })).toBeUndefined();
    expect(parsePrototypePreviewInteraction({ type: "workbench-prototype-v2:interaction", event: "navigate", target: "body", tag: "body", label: "" })).toBeUndefined();
  });
  it("inserts isolation before scripts in a full generated document without nesting HTML", () => {
    const result = createPrototypeSandboxDocument('<!doctype html><html><head><title>Prototype</title><script>window.ready=true</script></head><body><button data-wb-node="save">Save</button></body></html>');
    expect(result.match(/<html>/gu)).toHaveLength(1);
    expect(result.indexOf("Content-Security-Policy")).toBeLessThan(result.indexOf("window.ready"));
    expect(result).toContain("base-uri 'none'");
  });

  it("captures stable node/page anchors and hides password values while preserving navigation events", () => {
    const dom = new JSDOM(createPrototypeSandboxDocument('<main data-wb-screen="screen-login"><input data-wb-node="password" type="password" aria-label="Password" value="secret"></main>'), { runScripts: "dangerously" });
    const posted = vi.spyOn(dom.window, "postMessage");
    const input = dom.window.document.querySelector("input")!;
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    expect(posted).toHaveBeenCalledWith(expect.objectContaining({ target: 'input[data-wb-node="password"]', pageId: "screen-login", value: "[redacted]" }), "*");
    dom.window.document.dispatchEvent(new dom.window.CustomEvent("workbench:prototype-page", { detail: { pageId: "screen-next" } }));
    expect(posted).toHaveBeenCalledWith({ type: "workbench.prototype.page", pageId: "screen-next" }, "*");
    expect(parsePrototypePreviewPage({ type: "workbench.prototype.page", pageId: "screen-next" })).toBe("screen-next");
    dom.window.close();
  });

});
