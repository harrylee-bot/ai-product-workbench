import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { PreviewService } from "../../apps/workbench-preview/dist/preview.service.js";

const require = createRequire(import.meta.url);
const penpal = await readFile(join(dirname(require.resolve("penpal")), "penpal.min.js"), "utf8");
const capabilityToken = "wbsp1.fixture.signature";
const webOrigin = "https://workbench.test";

for (const fails of [false, true]) {
  test(`SourcePrototype reports ${fails ? "early runtime failure" : "readiness"} through its isolated bridge`, { timeout: 20_000 }, async () => {
    const script = fails ? 'throw new Error("SOURCE_EARLY_RUNTIME_ERROR")' : 'window.sourceReady=true';
    const sourceHtml = `<!doctype html><html><head></head><body><script>${script}</script><p>源码原型</p></body></html>`;
    const service = new PreviewService(null, null, { webOrigin });
    const rendered = await service.render({ sourceHtml, capabilityToken, etag: '"fixture"' });
    let html;
    try {
      const chunks = [];
      for await (const chunk of rendered.body) chunks.push(Buffer.from(chunk));
      html = Buffer.concat(chunks).toString("utf8");
    } finally {
      rendered.body.destroy();
      await rendered.dispose();
    }
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.route(`${webOrigin}/`, route => route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: "<!doctype html><html><body></body></html>",
      }));
      await page.route("https://preview.test/*", route => route.fulfill({
        contentType: "text/html; charset=utf-8",
        headers: { "content-security-policy": rendered.contentSecurityPolicy },
        body: html,
      }));
      await page.goto(webOrigin);
      await page.addScriptTag({ content: penpal });
      const status = await page.evaluate(async capability => {
        const frame = document.createElement("iframe");
        frame.src = "https://preview.test/capability";
        const loaded = new Promise(resolve => { frame.onload = resolve; });
        document.body.appendChild(frame);
        await loaded;
        // The CSP gives the child an opaque origin; bind the exact window and channel.
        const connection = Penpal.connect({
          messenger: new Penpal.WindowMessenger({ remoteWindow: frame.contentWindow, allowedOrigins: ["*"] }),
          channel: `workbench.preview.v1:${capability}`,
          timeout: 10_000,
        });
        try {
          const remote = await connection.promise;
          return await remote.handshake({ protocol: "workbench.preview", version: 1 });
        } finally {
          connection.destroy();
        }
      }, capabilityToken);
      assert.deepEqual(status, {
        protocol: "workbench.preview", version: 1,
        state: fails ? "error" : "ready",
        errorCode: fails ? "PREVIEW_RUNTIME_ERROR" : null,
      });
      assert.deepEqual(errors, fails ? ["SOURCE_EARLY_RUNTIME_ERROR"] : []);
    } finally {
      await browser.close();
    }
  });
}
