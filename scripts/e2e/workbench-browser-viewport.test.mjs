import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { waitForStableViewportLayout } from "./workbench-browser-viewport.mjs";

test("viewport evidence waits for responsive browser frames and refuses unsettled geometry", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
  await page.setContent(`<!doctype html><style>
    html, body { margin: 0; width: 100%; height: 100%; }
    #surface { position: absolute; left: 24px; top: 186px; width: calc(100vw - 64px); height: 100px; }
    @media (min-width: 768px) { #surface { left: 320px; top: 92px; width: calc(100vw - 400px); } }
    @media (min-width: 1024px) { #surface { left: calc(50vw - 247px); width: 494px; } }
  </style><main id="surface"></main>`);

  await t.test("normal and reduced motion follow repeated mobile/tablet/desktop breakpoint changes", async () => {
    for (const reducedMotion of ["no-preference", "reduce"]) {
      await page.emulateMedia({ reducedMotion });
      for (const viewport of [{ width: 375, height: 812 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }]) {
        await page.setViewportSize(viewport);
        const result = await waitForStableViewportLayout(page, viewport, { selectors: ["#surface"] });
        assert.deepEqual(result, { ...viewport, stableFrames: 3 });
        const rect = await page.locator("#surface").boundingBox();
        assert.equal(rect.x, viewport.width < 768 ? 24 : viewport.width < 1024 ? 320 : viewport.width / 2 - 247);
        assert.equal(rect.width, viewport.width < 768 ? viewport.width - 64 : viewport.width < 1024 ? viewport.width - 400 : 494);
      }
    }
  });

  await t.test("a ResizeObserver update followed by asynchronous frame work is included", async () => {
    await page.evaluate(() => {
      const element = document.querySelector("#surface");
      let changes = 0;
      new ResizeObserver(() => {
        if (changes++) return;
        requestAnimationFrame(() => {
          element.style.width = "151px";
          requestAnimationFrame(() => { element.style.width = "237px"; });
        });
      }).observe(element);
    });
    await waitForStableViewportLayout(page, { width: 1440, height: 900 }, { selectors: ["#surface"] });
    assert.equal((await page.locator("#surface").boundingBox()).width, 237);
  });

  await t.test("stable coordinates at the wrong viewport do not pass", async () => {
    await assert.rejects(waitForStableViewportLayout(page, { width: 768, height: 1024 }, {
      selectors: ["#surface"], timeoutMs: 150,
    }), /VIEWPORT_LAYOUT_DID_NOT_SETTLE/u);
  });

  await t.test("continuously changing geometry fails instead of yielding a misleading screenshot sample", async () => {
    await page.evaluate(() => {
      const element = document.querySelector("#surface");
      let frame = 0;
      const move = () => { element.style.left = `${frame++ % 2}px`; requestAnimationFrame(move); };
      requestAnimationFrame(move);
    });
    await assert.rejects(waitForStableViewportLayout(page, { width: 1440, height: 900 }, {
      selectors: ["#surface"], timeoutMs: 150,
    }), /VIEWPORT_LAYOUT_DID_NOT_SETTLE/u);
  });
});
