import { existsSync } from "node:fs";
import { unzipSync } from "fflate";
import { chromium } from "playwright-core";
import { describe, expect, it } from "vitest";

import { buildExport, renderExportHtml } from "../src/index.js";
import { interactiveExportRequest } from "./fixtures.js";

const executablePath = chromium.executablePath();
const chromiumAvailable = existsSync(executablePath);

describe("Prototype HTML export runtime", () => {
  it("serializes the complete greenfield runtime model and semantic controls", () => {
    const rendered = renderExportHtml(interactiveExportRequest());
    const runtime = rendered.runtimeData as unknown as {
      prototypes: Array<{
        variables: Array<{ path: string; initialValue: unknown }>;
        states: Array<{ id: string; values: Record<string, unknown> }>;
        bindings: Array<{ id: string; source: Record<string, unknown> }>;
      }>;
    };
    const prototype = runtime.prototypes[0]!;

    expect(prototype.variables).toContainEqual({ path: "form.email", initialValue: "initial@example.test" });
    expect(prototype.states.find((state) => state.id === "state-ready")?.values).toEqual({ status: "Ready" });
    expect(prototype.bindings.find((binding) => binding.id === "binding-state")?.source).toEqual({
      kind: "state",
      stateId: "state-ready",
      field: "status",
    });
    expect(rendered.document).toMatch(/<div [^>]*data-wb-node="root-home"/);
    expect(rendered.document).toMatch(/<form [^>]*data-wb-node="form-home"/);
    expect(rendered.document).toMatch(/<input [^>]*data-wb-node="input-email"[^>]*type="text"/);
    expect(rendered.document).toMatch(/<textarea [^>]*data-wb-node="input-notes"/);
    expect(rendered.document).toMatch(/<select [^>]*data-wb-node="input-plan"/);
    expect(rendered.document).toContain('<option value="basic">Basic</option>');
    expect(rendered.document).toContain('<option value="pro" selected>Pro</option>');
    expect(rendered.document).toContain('<option value="legacy" disabled>Legacy</option>');
    expect(rendered.document).toMatch(/<input [^>]*data-wb-node="input-terms"[^>]*type="checkbox"/);
    expect(rendered.document).toMatch(/<input [^>]*data-wb-node="input-choice"[^>]*type="radio"/);
    expect(rendered.document).toMatch(/<button [^>]*data-wb-node="button-submit"[^>]*type="submit"/);
    expect(rendered.document).toMatch(/<button [^>]*data-wb-node="button-reset"[^>]*type="reset"/);
    expect(rendered.document).toMatch(/data-wb-node="icon-heart"[\s\S]*?<svg[^>]*class="lucide lucide-heart"/);
  });

  it.runIf(chromiumAvailable)("executes bindings, actions, submission, and every motion trigger without network", async () => {
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
      await page.evaluate(() => {
        const original = Element.prototype.animate;
        (window as unknown as { __workbenchAnimationCalls: unknown[] }).__workbenchAnimationCalls = [];
        Element.prototype.animate = function recordAnimation(
          keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
          options?: number | KeyframeAnimationOptions,
        ) {
          (window as unknown as { __workbenchAnimationCalls: unknown[] }).__workbenchAnimationCalls.push({
            nodeId: (this as HTMLElement).dataset.wbNode ?? null,
            keyframes: JSON.parse(JSON.stringify(keyframes)),
            options: JSON.parse(JSON.stringify(options)),
          });
          return original.call(this, keyframes, options);
        };
      });
      await page.setContent(renderExportHtml(interactiveExportRequest()).document, { waitUntil: "load" });

      await expect.poll(() => page.locator('[data-wb-node="text-mirror"]').textContent()).toBe("initial@example.test");
      await expect.poll(() => page.locator('[data-wb-node="text-literal"]').textContent()).toBe("Literal ready");
      await expect.poll(() => page.locator('[data-wb-node="text-state"]').textContent()).toBe("Waiting");
      await expect.poll(() => page.locator('[data-wb-node="input-choice"]').isChecked()).toBe(true);
      await expect.poll(() => page.locator('[data-wb-node="input-choice-no"]').isChecked()).toBe(false);
      expect(await page.locator('[data-wb-node="icon-heart"] svg.lucide-heart').count()).toBe(1);

      await page.locator('[data-wb-node="button-click"]').click();
      await expect.poll(() => page.locator('[data-wb-node="text-state"]').textContent()).toBe("Ready");
      await page.mouse.move(760, 860);
      await expect.poll(() => page.locator('[data-wb-node="button-click"]').evaluate((element) => element.getAnimations().length)).toBe(0);
      expect(await page.locator('[data-wb-node="button-click"]').getAttribute("style"))
        .toContain("transform:rotate(30deg)");

      await page.locator('[data-wb-node="button-press"]').click();
      await expect.poll(() => page.locator('[data-wb-node="text-state"]').textContent()).toBe("Waiting");

      await page.locator('[data-wb-node="input-email"]').focus();
      await expect.poll(() => page.locator('[data-wb-node="text-state"]').textContent()).toBe("Ready");
      await page.locator('[data-wb-node="input-email"]').blur();
      await expect.poll(() => page.locator('[data-wb-node="text-state"]').textContent()).toBe("Waiting");

      await page.locator('[data-wb-node="input-email"]').evaluate((element) => {
        const input = element as HTMLInputElement;
        input.value = "changed@example.test";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await expect.poll(() => page.locator('[data-wb-node="text-mirror"]').textContent()).toBe("changed@example.test");
      await page.locator('[data-wb-node="input-email"]').dispatchEvent("change");
      await expect.poll(() => page.locator('[data-wb-node="text-state"]').textContent()).toBe("Ready");

      await page.locator('[data-wb-node="button-reset"]').click();
      await expect.poll(() => page.locator('[data-wb-node="input-email"]').inputValue()).toBe("initial@example.test");
      await expect.poll(() => page.locator('[data-wb-node="text-mirror"]').textContent()).toBe("initial@example.test");

      await page.locator('[data-wb-node="button-click"]').dispatchEvent("pointerenter");
      await page.locator('[data-wb-node="button-click"]').dispatchEvent("pointerleave");
      await page.locator('[data-wb-node="button-press"]').dispatchEvent("pointerdown");
      await page.locator('[data-wb-node="button-press"]').dispatchEvent("pointerup");

      await page.locator('[data-wb-node="input-email"]').evaluate((element) => {
        const input = element as HTMLInputElement;
        input.value = "changed@example.test";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await page.locator('[data-wb-node="input-terms"]').check();
      await page.locator('[data-wb-node="input-choice-no"]').check();
      await expect.poll(() => page.locator('[data-wb-node="input-choice"]').isChecked()).toBe(false);
      await expect.poll(() => page.locator('[data-wb-node="input-choice-no"]').isChecked()).toBe(true);
      await page.evaluate(() => {
        (window as unknown as { __workbenchSubmitDetails: unknown[] }).__workbenchSubmitDetails = [];
        document.addEventListener("workbench:prototype-submit", (event) => {
          (window as unknown as { __workbenchSubmitDetails: unknown[] }).__workbenchSubmitDetails.push((event as CustomEvent).detail);
        });
      });
      await page.locator('[data-wb-node="button-submit"]').evaluate((element) => {
        (element as HTMLButtonElement).click();
        (element as HTMLButtonElement).click();
      });
      await expect.poll(() => page.evaluate(() => (window as unknown as { __workbenchSubmitDetails: unknown[] }).__workbenchSubmitDetails.length)).toBe(1);
      await expect.poll(() => page.evaluate(() => (window as unknown as { __workbenchSubmitDetails: unknown[] }).__workbenchSubmitDetails[0])).toEqual({
        protocol: "workbench.prototype-submit.v1",
        kind: "submit",
        documentId: "interactive-document",
        actionId: "action-submit",
        formNodeId: "form-home",
        screenId: "screen-home",
        values: [
          {
            bindingId: "binding-choice",
            nodeId: "input-choice",
            fieldName: "choice",
            value: "no",
          },
          {
            bindingId: "binding-email",
            nodeId: "input-email",
            fieldName: "email",
            value: "changed@example.test",
          },
          {
            bindingId: "binding-terms",
            nodeId: "input-terms",
            fieldName: "terms",
            value: true,
          },
        ],
      });
      await expect.poll(() => page.locator('[data-wb-node="text-state"]').textContent()).toBe("Submitted");
      await expect.poll(() => page.locator('[data-wb-node="text-state"]').evaluate((element) => element.getAnimations().length)).toBe(0);
      await page.locator('[data-wb-node="button-submit"]').click();
      await expect.poll(() => page.evaluate(() => (window as unknown as { __workbenchSubmitDetails: unknown[] }).__workbenchSubmitDetails.length)).toBe(2);

      await page.locator('[data-wb-node="button-navigate"]').click();
      await expect.poll(() => page.locator('[data-wb-screen="screen-success"]').isVisible()).toBe(true);
      await expect.poll(() => page.locator('[data-wb-screen="screen-home"]').isHidden()).toBe(true);

      const calls = await page.evaluate(() => (
        window as unknown as { __workbenchAnimationCalls: Array<{ nodeId: string; keyframes: Array<Record<string, unknown>> }> }
      ).__workbenchAnimationCalls);
      expect(calls.some((call) => call.nodeId === "root-home" && call.keyframes[0]?.opacity === 0.9 && call.keyframes[1]?.opacity === 1)).toBe(true);
      expect(calls.some((call) => call.nodeId === "root-home" && call.keyframes[0]?.opacity === 1 && call.keyframes[1]?.opacity === 0.9)).toBe(true);
      expect(calls.some((call) => call.nodeId === "button-click" && call.keyframes[1]?.transform === "scale(1.02)" && call.keyframes[1]?.composite === "add")).toBe(true);
      expect(calls.some((call) => call.nodeId === "button-press" && call.keyframes[1]?.transform === "scale(0.98)" && call.keyframes[1]?.composite === "add")).toBe(true);
      expect(calls.some((call) => call.nodeId === "text-state" && call.keyframes[1]?.transform === "translateX(4px)" && call.keyframes[1]?.composite === "add")).toBe(true);
      expect(calls.some((call) => call.nodeId === "button-click" && call.keyframes[1]?.transform === "rotate(5deg)" && call.keyframes[1]?.composite === "add")).toBe(true);
      expect(network).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
      await browser.close();
    }
  }, 30_000);

  it.runIf(chromiumAvailable)("executes the compiled React Prototype export fully offline", async () => {
    const output = await buildExport(interactiveExportRequest("react"));
    const archive = unzipSync(output.bytes);
    const entry = archive["dist/index.html"];
    if (!entry) throw new Error("React export is missing dist/index.html");
    const html = new TextDecoder("utf-8", { fatal: true }).decode(entry);
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
      await expect.poll(() => page.locator('[data-wb-node="text-mirror"]').textContent()).toBe("initial@example.test");
      await page.locator('[data-wb-node="input-email"]').evaluate((element) => {
        const input = element as HTMLInputElement;
        input.value = "react@example.test";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await expect.poll(() => page.locator('[data-wb-node="text-mirror"]').textContent()).toBe("react@example.test");
      await page.locator('[data-wb-node="button-reset"]').click();
      await expect.poll(() => page.locator('[data-wb-node="input-email"]').inputValue()).toBe("initial@example.test");
      await expect.poll(() => page.locator('[data-wb-node="text-mirror"]').textContent()).toBe("initial@example.test");
      await page.locator('[data-wb-node="input-email"]').evaluate((element) => {
        const input = element as HTMLInputElement;
        input.value = "react@example.test";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await page.locator('[data-wb-node="input-terms"]').check();
      await page.locator('[data-wb-node="button-submit"]').click();
      await expect.poll(() => page.locator('[data-wb-node="text-state"]').textContent()).toBe("Submitted");
      expect(await page.locator('[data-wb-prototype][data-wb-runtime-installed="true"]').count()).toBe(1);
      expect(network).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
      await browser.close();
    }
  }, 30_000);

  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    it.runIf(chromiumAvailable)(`keeps all screens navigable from the requested initial screen at ${viewport.width}px`, async () => {
      const request = interactiveExportRequest();
      const artifact = request.source.artifacts[0]!;
      request.selection = {
        kind: "artifact",
        artifactId: artifact.artifactId,
        artifactVersionId: artifact.artifactVersionId,
      };
      request.initialScreenId = "screen-success";
      const browser = await chromium.launch({
        executablePath,
        headless: true,
        chromiumSandbox: false,
        args: ["--disable-background-networking", "--no-sandbox"],
      });
      const context = await browser.newContext({
        javaScriptEnabled: true,
        serviceWorkers: "block",
        viewport,
      });
      const network: string[] = [];
      const errors: string[] = [];
      await context.route(/^(?:https?|wss?):/i, (route) => {
        network.push(route.request().url());
        return route.abort("blockedbyclient");
      });
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(error.message));

      try {
        await page.setContent(renderExportHtml(request).document, { waitUntil: "load" });
        expect(await page.locator("[data-wb-screen]").count()).toBe(2);
        await expect.poll(() => page.locator('[data-wb-screen="screen-success"]').isVisible()).toBe(true);
        await expect.poll(() => page.locator('[data-wb-screen="screen-home"]').isHidden()).toBe(true);
        expect(await page.locator('[data-wb-screen-target="screen-success"]').getAttribute("aria-selected")).toBe("true");

        await page.locator('[data-wb-screen-target="screen-home"]').click();
        await expect.poll(() => page.locator('[data-wb-screen="screen-home"]').isVisible()).toBe(true);
        await page.locator('[data-wb-node="input-email"]').fill("preview@example.test");
        await expect.poll(() => page.locator('[data-wb-node="text-mirror"]').textContent()).toBe("preview@example.test");
        await page.locator('[data-wb-node="button-navigate"]').click();
        await expect.poll(() => page.locator('[data-wb-screen="screen-success"]').isVisible()).toBe(true);
        await expect.poll(() => page.locator('[data-wb-screen="screen-home"]').isHidden()).toBe(true);
        expect(network).toEqual([]);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
        await browser.close();
      }
    }, 30_000);
  }
});
