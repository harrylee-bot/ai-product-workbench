import { unzipSync } from "fflate";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { buildExport } from "../src/index.js";
import { designSystemExportRequest } from "./fixtures.js";

describe("React export offline document", () => {
  it("mounts the prebuilt Design System without fetching sibling bundle files", async () => {
    const output = await buildExport(designSystemExportRequest("react"));
    const archive = unzipSync(output.bytes);
    const html = textEntry(archive, "dist/index.html");

    const dom = new JSDOM(html, { pretendToBeVisual: true, runScripts: "outside-only" });
    const script = dom.window.document.querySelector<HTMLScriptElement>('script[type="module"]');
    expect(script?.src).toBe("");
    expect(script?.textContent).toBeTruthy();

    dom.window.eval(script!.textContent!);

    await vi.waitFor(() => {
      expect(dom.window.document.querySelector('[data-wb-design-system="design-system-1"]')).not.toBeNull();
      expect(dom.window.document.querySelector('[data-wb-font-family="Workbench Brand"]')).not.toBeNull();
    });
    dom.window.close();
  }, 30_000);
});

function textEntry(archive: Record<string, Uint8Array>, name: string) {
  const entry = archive[name];
  if (!entry) throw new Error(`Missing archive entry: ${name}`);
  return new TextDecoder("utf-8", { fatal: true }).decode(entry);
}
