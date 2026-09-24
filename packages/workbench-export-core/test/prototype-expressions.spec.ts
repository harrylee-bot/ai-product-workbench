import { existsSync } from "node:fs";
import type { PrototypeDocument } from "@workbench/workbench-contracts";
import { unzipSync } from "fflate";
import { JSDOM } from "jsdom";
import { chromium, type Page } from "playwright-core";
import { describe, expect, it } from "vitest";

import { buildExport, renderExportHtml } from "../src/index.js";
import type { ExportBuildRequest } from "../src/types.js";
import { catalogueExportRequest, interactiveExportRequest, numericExpressionExportRequest } from "./fixtures.js";

const executablePath = chromium.executablePath();
const chromiumAvailable = existsSync(executablePath);
const entryIds = ["entry-network", "entry-typescript", "entry-design"];

describe("computed Prototype export bindings", () => {
  it("renders initial expression values before JavaScript runs", () => {
    const rendered = renderExportHtml(catalogueExportRequest());
    const dom = new JSDOM(rendered.document);
    const node = (id: string) => dom.window.document.querySelector<HTMLElement>(`[data-wb-node="${id}"]`)!;

    expect(entryIds.map((id) => node(id).hidden)).toEqual([false, false, false]);
    expect(node("text-empty").hidden).toBe(true);
    expect(node("text-query").textContent).toBe("");
    expect((node("button-filter-reset") as HTMLButtonElement).disabled).toBe(true);
    dom.window.close();
  });

  it("uses non-default variable values for the initial filtered HTML", () => {
    const request = catalogueExportRequest();
    const content = request.source.artifacts[0]!.content as PrototypeDocument;
    content.variables = [
      { path: "filter.query", initialValue: "  TYPESCRIPT  " },
      { path: "filter.category", initialValue: "technology" },
    ];
    const dom = new JSDOM(renderExportHtml(request).document);
    const node = (id: string) => dom.window.document.querySelector<HTMLElement>(`[data-wb-node="${id}"]`)!;

    expect(entryIds.map((id) => node(id).hidden)).toEqual([true, false, true]);
    expect(node("text-empty").hidden).toBe(true);
    expect(node("text-query").textContent).toBe("  TYPESCRIPT  ");
    expect((node("input-query") as HTMLInputElement).value).toBe("  TYPESCRIPT  ");
    expect((node("input-category") as HTMLSelectElement).value).toBe("technology");
    expect((node("button-filter-reset") as HTMLButtonElement).disabled).toBe(false);
    dom.window.close();
  });

  it("limits editable text to 10000 characters without adding text constraints to other control types", () => {
    for (const inputType of ["text", "email", "password", "search", "textarea", "number", "date"] as const) {
      const request = interactiveExportRequest();
      const document = request.source.artifacts[0]!.content as PrototypeDocument;
      const input = document.nodes.find((node) => node.id === "input-email")!;
      if (input.kind !== "input") throw new Error("Input fixture is missing");
      input.inputType = inputType;
      document.variables.find((variable) => variable.path === "form.email")!.initialValue = inputType === "number" ? null : "";
      const dom = new JSDOM(renderExportHtml(request).document);
      const node = (id: string) => dom.window.document.querySelector<HTMLElement>(`[data-wb-node="${id}"]`)!;
      expect(node("input-email").getAttribute("maxlength")).toBe(inputType === "number" || inputType === "date" ? null : "10000");
      expect(node("input-notes").getAttribute("maxlength")).toBe("10000");
      for (const id of ["input-plan", "input-terms", "input-choice", "input-choice-no"]) {
        expect(node(id).hasAttribute("maxlength")).toBe(false);
      }
      dom.window.close();
    }
  });

  for (const format of ["html", "react"] as const) {
    it.runIf(chromiumAvailable)(`filters, combines conditions, shows empty results and resets in the offline ${format} export`, async () => {
      await withOfflineExportPage(catalogueExportRequest(format), async (page) => {
        const node = (id: string) => page.locator(`[data-wb-node="${id}"]`);
        const visibleEntries = async () => {
          const visible = await Promise.all(entryIds.map((id) => node(id).isVisible()));
          return entryIds.filter((_id, index) => visible[index]);
        };
        await expect.poll(visibleEntries).toEqual(entryIds);
        expect(await node("text-empty").isHidden()).toBe(true);
        expect(await node("button-filter-reset").isDisabled()).toBe(true);

        await node("input-query").fill("计算机");
        await expect.poll(visibleEntries).toEqual(["entry-network"]);
        expect(await node("text-query").textContent()).toBe("计算机");

        await node("input-category").selectOption("design");
        await expect.poll(visibleEntries).toEqual([]);
        expect(await node("text-empty").isVisible()).toBe(true);

        await node("input-query").fill("");
        await expect.poll(visibleEntries).toEqual(["entry-design"]);
        expect(await node("text-empty").isHidden()).toBe(true);

        await node("input-category").selectOption("technology");
        await expect.poll(visibleEntries).toEqual(["entry-network", "entry-typescript"]);
        await node("input-query").fill("  tYpEsCrIpT  ");
        await expect.poll(visibleEntries).toEqual(["entry-typescript"]);

        await node("input-query").fill("no results");
        await expect.poll(visibleEntries).toEqual([]);
        expect(await node("text-empty").isVisible()).toBe(true);

        await node("input-query").fill("x".repeat(10_001));
        expect((await node("input-query").inputValue()).length).toBe(10_000);
        expect((await node("text-query").textContent())?.length).toBe(10_000);
        await node("input-query").evaluate((element) => {
          const input = element as HTMLInputElement;
          input.value = "x".repeat(10_001);
          input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        expect((await node("text-query").textContent())?.length).toBe(10_001);
        await expect.poll(visibleEntries).toEqual([]);
        expect(await node("text-empty").isVisible()).toBe(true);

        await node("button-filter-reset").click();
        await expect.poll(visibleEntries).toEqual(entryIds);
        expect(await node("input-query").inputValue()).toBe("");
        expect(await node("input-category").inputValue()).toBe("all");
        expect(await node("text-query").textContent()).toBe("");
        expect(await node("text-empty").isHidden()).toBe(true);
        expect(await node("button-filter-reset").isDisabled()).toBe(true);
      });
    }, 30_000);

    it.runIf(chromiumAvailable)(`clears a numeric equality input safely and recovers in the offline ${format} export`, async () => {
      await withOfflineExportPage(numericExpressionExportRequest(format), async (page) => {
        const input = page.locator('[data-wb-node="input-email"]');
        const match = page.locator('[data-wb-node="text-mirror"]');
        await expect.poll(() => match.isVisible()).toBe(true);
        expect(await input.getAttribute("maxlength")).toBeNull();
        await input.fill("");
        await expect.poll(() => match.isHidden()).toBe(true);
        await input.fill("2");
        expect(await match.isHidden()).toBe(true);
        await input.fill("1");
        await expect.poll(() => match.isVisible()).toBe(true);

        await input.fill("");
        await page.evaluate(() => {
          document.addEventListener("workbench:prototype-submit", (event) => {
            const { values } = (event as CustomEvent).detail as { values: Array<{ fieldName: string; value: unknown }> };
            document.body.dataset.numericSubmit = JSON.stringify(values.find((value) => value.fieldName === "email")?.value);
          });
        });
        await page.locator('[data-wb-node="button-submit"]').click();
        await expect.poll(() => page.locator("body").getAttribute("data-numeric-submit")).toBe("null");
        await page.locator('[data-wb-node="button-reset"]').click();
        await expect.poll(() => input.inputValue()).toBe("1");
        await expect.poll(() => match.isVisible()).toBe(true);
      });
    }, 30_000);
  }
});

async function withOfflineExportPage(request: ExportBuildRequest, verify: (page: Page) => Promise<void>) {
  const output = await buildExport(request);
  const bytes = request.format === "html" ? output.bytes : unzipSync(output.bytes)["dist/index.html"];
  if (!bytes) throw new Error("React export is missing dist/index.html");
  const html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    chromiumSandbox: false,
    args: ["--disable-background-networking", "--no-sandbox"],
  });
  const context = await browser.newContext({
    javaScriptEnabled: true,
    serviceWorkers: "block",
    viewport: { width: 800, height: 900 },
  });
  const network: string[] = [];
  const errors: string[] = [];
  await context.route(/^(?:https?|wss?):/i, (route) => {
    network.push(route.request().url());
    return route.abort("blockedbyclient");
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  try {
    await page.setContent(html, { waitUntil: "load" });
    await expect.poll(() => page.locator('[data-wb-runtime-installed="true"]').count()).toBe(1);
    await verify(page);
    expect(network).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await browser.close();
  }
}
