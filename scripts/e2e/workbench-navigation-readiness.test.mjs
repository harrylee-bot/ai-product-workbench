import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { waitForInitialHomeVisualReady } from "./workbench-navigation-readiness.mjs";

test("initial Home readiness separates entrance animation from navigation evidence", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const render = () => page.setContent(`<!doctype html><style>
    html, body, [data-workbench-stage], section { margin: 0; width: 100%; height: 100%; }
  </style><main data-workbench-stage><section><header><h1>欢迎使用产品工作台</h1></header></section></main>`);

  await t.test("waits for a transparent initial root and its delayed header entrance", async () => {
    await render();
    await page.evaluate(() => {
      const root = document.querySelector("section");
      const header = document.querySelector("header");
      root.style.opacity = "0";
      root.style.transform = "translateY(6px)";
      header.style.opacity = "0";
      header.style.transform = "translateY(-8px)";
      window.__homeEntranceFinished = false;
      window.__headerEntranceFinished = false;
      root.animate([
        { opacity: 0, transform: "translateY(6px)" },
        { opacity: 1, transform: "none" },
      ], { delay: 80, duration: 120, fill: "forwards" }).finished.then(() => { window.__homeEntranceFinished = true; });
      header.animate([
        { opacity: 0, transform: "translateY(-8px)" },
        { opacity: 1, transform: "none" },
      ], { delay: 160, duration: 150, fill: "forwards" }).finished.then(() => { window.__headerEntranceFinished = true; });
    });
    assert.equal(await page.getByRole("heading").isVisible(), true, "the old visibility precondition accepts a transparent ancestor");
    const result = await waitForInitialHomeVisualReady(page, { expectedHref: page.url() });
    assert.equal(result.stableFrames, 3);
    assert.equal(result.root.opacity, 1);
    assert.equal(result.header.opacity, 1);
    assert.deepEqual(await page.evaluate(() => [window.__homeEntranceFinished, window.__headerEntranceFinished]), [true, true]);
  });

  await t.test("a transparent ancestor cannot pass with stable opaque child geometry", async () => {
    await render();
    await page.locator("main").evaluate((element) => { element.style.opacity = "0"; });
    await assert.rejects(waitForInitialHomeVisualReady(page, { timeoutMs: 150 }), /INITIAL_HOME_VISUAL_NOT_READY/u);
  });

  await t.test("a root that never reaches its final transform times out", async () => {
    await render();
    await page.locator("section").evaluate((element) => { element.style.transform = "translateY(6px)"; });
    await assert.rejects(waitForInitialHomeVisualReady(page, { timeoutMs: 150 }), /INITIAL_HOME_VISUAL_NOT_READY/u);
  });
});
