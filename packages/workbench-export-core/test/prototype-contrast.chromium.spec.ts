import { existsSync } from "node:fs";
import { chromium, type Page } from "playwright-core";
import { describe, expect, it } from "vitest";
import type { PrototypeDocument, PrototypeNode } from "@workbench/workbench-contracts";
import { renderPrototypeDocumentHtml, renderPrototypeDocumentPages } from "../src/html-renderer.js";
import { prototypeDocumentReactOutput } from "../src/react-export.js";
import { prototypeFixture } from "./fixtures.js";

const executablePath = process.env.WORKBENCH_EXPORT_CHROMIUM_PATH ?? chromium.executablePath();
const literal = (value: string) => ({ kind: "literal" as const, value });
const typography = (value: string): NonNullable<PrototypeNode["style"]["typography"]> => ({
  color: literal(value), fontFamily: literal("sans-serif"),
  fontSize: { kind: "literal", value: 16 }, fontWeight: { kind: "literal", value: 400 },
  lineHeight: { kind: "literal", value: 24 }, letterSpacing: { kind: "literal", value: 0 },
  align: "left", transform: "none", decoration: "none",
});

function fixture(): PrototypeDocument {
  const document = prototypeFixture();
  const root = document.nodes[0]!;
  const button = document.nodes[1]!;
  if (root.kind !== "frame" || button.kind !== "button") throw new Error("Fixture structure changed");
  document.screens = [document.screens[0]!];
  document.actions = []; document.motions = [];
  document.tokens = [{ id: "fill-dark", name: "Dark fill", type: "color", value: "#111827" }, { id: "text-explicit", name: "Explicit text", type: "color", value: "#fef08a" }];
  root.style.fill = literal("#000000");
  root.style.typography = typography("#abcdef");
  const controls: Array<Extract<PrototypeNode, { kind: "button" }>> = [
    ["dark", "#111827"], ["blue", "#2563eb"], ["light", "#f8fafc"], ["middle", "#777777"],
    ["alpha", "#ffffff40"], ["transparent", "#ffffff00"], ["unfilled", null],
    ["explicit", "#ffffff"], ["token", "#ffffff"], ["stateful", "#111827"], ["disabled", "#111827"], ["reset", "#ffffff"],
  ].map(([id, fill], index) => ({
    ...structuredClone(button), id: id!, name: id!, label: id!, actionIds: [], motionIds: [],
    layout: { ...button.layout, y: { kind: "literal" as const, value: index * 50 }, x: { kind: "literal" as const, value: 0 } },
    style: { ...structuredClone(button.style), rotation: 0, fill: fill ? literal(fill) : null },
  }));
  controls.find(node => node.id === "explicit")!.style.typography = typography("#123456");
  controls.find(node => node.id === "token")!.style.fill = { kind: "token", tokenId: "fill-dark" };
  controls.find(node => node.id === "token")!.style.typography = { ...typography("#ffffff"), color: { kind: "token", tokenId: "text-explicit" } };
  controls.find(node => node.id === "disabled")!.disabled = true;
  const stateful = controls.find(node => node.id === "stateful")!;
  stateful.actionIds = ["to-light"];
  controls.find(node => node.id === "reset")!.actionIds = ["to-dark"];
  document.actions = [
    { id: "to-light", nodeId: stateful.id, event: "click", kind: "setState", targetStateId: "light-state" },
    { id: "to-dark", nodeId: "reset", event: "click", kind: "setState", targetStateId: "dark-state" },
  ];
  document.states = [
    { id: "light-state", screenId: root.screenId, name: "Light", values: {}, overrides: [
      { nodeId: root.id, style: { ...structuredClone(root.style), fill: literal("#ffffff") } },
      { nodeId: stateful.id, style: { ...structuredClone(stateful.style), fill: literal("#ffffff") } },
      { nodeId: "alpha", enabled: false },
    ] },
    { id: "dark-state", screenId: root.screenId, name: "Dark", values: {}, overrides: [{ nodeId: root.id, style: structuredClone(root.style) }] },
  ];
  const text: PrototypeNode = { ...structuredClone(button), id: "legacy-text", name: "Legacy text", kind: "text", text: "Explicit text fill", maxLines: null, actionIds: [], motionIds: [], style: { ...structuredClone(button.style), fill: literal("#ff00ff") } } as PrototypeNode;
  // Construct a strict text node, without the button-only fields.
  for (const key of ["label", "childIds", "buttonType", "disabled"]) delete (text as unknown as Record<string, unknown>)[key];
  const inputs: PrototypeNode[] = (["text", "textarea", "select"] as const).map((inputType, index) => {
    const { label: _label, childIds: _childIds, buttonType: _buttonType, ...base } = structuredClone(controls[0]!);
    document.variables.push({ path: `form.${inputType}`, initialValue: "value" });
    document.bindings.push({ id: `binding-${inputType}`, nodeId: `input-${inputType}`, property: "value", source: { kind: "variable", path: `form.${inputType}` } });
    return { ...base, id: `input-${inputType}`, name: inputType, kind: "input", inputType, fieldName: inputType, label: inputType, placeholder: inputType, bindingIds: [`binding-${inputType}`], optionValue: null, options: inputType === "select" ? [{ value: "value", label: "Value", disabled: false }] : [], required: false, style: { ...base.style, fill: literal(index === 1 ? "#ffffff" : "#111827") } };
  });
  root.childIds = [...controls.map(node => node.id), text.id, ...inputs.map(node => node.id)];
  document.nodes = [root, ...controls, text, ...inputs];
  return document;
}

const foreground = (page: Page, id: string) => page.locator(`[data-wb-node="${id}"]`).evaluate(element => getComputedStyle(element).color);

describe("Prototype control text contrast", () => {
  it("keeps actual per-page DOM and complete HTML on the same renderer", () => {
    const document = fixture();
    const full = renderPrototypeDocumentHtml(document);
    const pages = renderPrototypeDocumentPages(document);
    expect(full.document).toContain('background-color:#111827');
    expect(pages[0]!.content).toContain('color:#ffffff');
    expect(pages[0]!.content).toContain('color:#000000');
  });

  for (const format of ["html", "react"] as const) {
    it.runIf(existsSync(executablePath))(`renders explicit, inherited and contrasting control text in ${format}, including state changes`, async () => {
      const document = fixture();
      const html = format === "html" ? renderPrototypeDocumentHtml(document).document : Buffer.from((await prototypeDocumentReactOutput(document)).validationBytes).toString("utf8");
      const browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: false, args: ["--no-sandbox"] });
      try {
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.setContent(html, { waitUntil: "load" });
        await page.locator('[data-wb-runtime-installed="true"]').waitFor();
        for (const id of ["dark", "blue", "alpha", "stateful", "disabled"]) expect(await foreground(page, id)).toBe("rgb(255, 255, 255)");
        for (const id of ["light", "middle"]) expect(await foreground(page, id)).toBe("rgb(0, 0, 0)");
        for (const id of ["transparent", "unfilled"]) expect(await foreground(page, id)).toBe("rgb(171, 205, 239)");
        expect(await foreground(page, "explicit")).toBe("rgb(18, 52, 86)");
        expect(await foreground(page, "token")).toBe("rgb(254, 240, 138)");
        expect(await foreground(page, "legacy-text")).toBe("rgb(255, 0, 255)");
        expect(await foreground(page, "input-text")).toBe("rgb(255, 255, 255)");
        expect(await foreground(page, "input-select")).toBe("rgb(255, 255, 255)");
        expect(await foreground(page, "input-textarea")).toBe("rgb(0, 0, 0)");
        expect(await page.locator('[data-wb-node="dark"] [data-wb-content="label"]').evaluate(element => getComputedStyle(element).color)).toBe("rgb(255, 255, 255)");
        await page.locator('[data-wb-node="stateful"]').dispatchEvent("click");
        expect(await foreground(page, "stateful")).toBe("rgb(0, 0, 0)");
        expect(await foreground(page, "alpha")).toBe("rgb(0, 0, 0)");
        expect(await page.locator('[data-wb-node="alpha"]').isDisabled()).toBe(true);
        await page.locator('[data-wb-node="reset"]').dispatchEvent("click");
        expect(await foreground(page, "stateful")).toBe("rgb(255, 255, 255)");
        expect(await foreground(page, "alpha")).toBe("rgb(255, 255, 255)");
        expect(errors).toEqual([]);
      } finally { await browser.close(); }
    }, 30_000);
  }
});
