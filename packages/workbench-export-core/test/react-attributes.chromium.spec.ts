import { existsSync } from "node:fs";
import { unzipSync } from "fflate";
import { chromium } from "playwright-core";
import { describe, expect, it } from "vitest";
import { renderPrototypeDocumentHtml } from "../src/html-renderer.js";
import { prototypeDocumentReactOutput } from "../src/react-export.js";
import { interactivePrototypeFixture } from "./fixtures.js";

const executablePath = process.env.WORKBENCH_EXPORT_CHROMIUM_PATH ?? chromium.executablePath();
const label = String.raw`邮箱 "别名" & <测试> 🦊 C:\new\u90AE &#x41; &quot;`;

describe("React export string attributes", () => {
  it.runIf(existsSync(executablePath))("preserves Unicode, quotes, entities and literal backslashes in the compiled archive and shared HTML", async () => {
    const document = interactivePrototypeFixture();
    const email = document.nodes.find(node => node.id === "input-email")!;
    const plan = document.nodes.find(node => node.id === "input-plan")!;
    const terms = document.nodes.find(node => node.id === "input-terms")!;
    const button = document.nodes.find(node => node.id === "button-click")!;
    if (email.kind !== "input" || plan.kind !== "input" || terms.kind !== "input" || button.kind !== "button") throw new Error("Fixture structure changed");
    email.label = label;
    email.placeholder = label;
    email.style.typography = {
      fontFamily: { kind: "literal", value: '思源黑体 "UI" 字体' },
      fontSize: { kind: "literal", value: 16 }, fontWeight: { kind: "literal", value: 400 },
      lineHeight: { kind: "literal", value: 24 }, letterSpacing: { kind: "literal", value: 0 },
      align: "left", transform: "none", decoration: "none",
    };
    plan.label = "套餐";
    terms.label = "同意条款";
    terms.required = true;
    button.label = 'literal="保持文本" WORKBENCH_JSX_ATTRIBUTE_0';
    const output = await prototypeDocumentReactOutput(document);
    const archive = unzipSync(output.bytes);
    const app = new TextDecoder().decode(archive["src/App.jsx"]);
    expect(app).toContain("aria-label={");
    expect(app).not.toContain('aria-label="\\u');
    const browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: false, args: ["--no-sandbox"] });
    try {
      for (const html of [renderPrototypeDocumentHtml(document).document, new TextDecoder().decode(archive["dist/index.html"])]) {
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.setContent(html, { waitUntil: "load" });
        await page.locator('[data-wb-runtime-installed="true"]').waitFor();
        const input = page.getByLabel(label, { exact: true });
        expect(await input.getAttribute("placeholder")).toBe(label);
        expect(await input.evaluate(element => (element as HTMLElement).style.fontFamily)).toContain("思源黑体");
        expect(await input.isDisabled()).toBe(false);
        await input.fill("reader@example.test");
        expect(await page.locator('[data-wb-node="text-mirror"]').textContent()).toBe("reader@example.test");
        await page.getByLabel("套餐", { exact: true }).selectOption("basic");
        await page.getByLabel("同意条款", { exact: true }).check();
        expect(await page.getByLabel("套餐", { exact: true }).inputValue()).toBe("basic");
        expect(await page.getByLabel("同意条款", { exact: true }).isChecked()).toBe(true);
        expect(await page.getByLabel("同意条款", { exact: true }).getAttribute("required")).toBe("");
        expect(await page.locator('[data-wb-node="button-click"]').textContent()).toBe(button.label);
        expect(errors).toEqual([]);
        await page.close();
      }
    } finally { await browser.close(); }
  }, 30_000);
});
