import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import { describe, expect, it } from "vitest";
import { renderExportHtml } from "@workbench/workbench-export-core";
import { BrowserExportService } from "../src/browser/browser-export.service.js";
import { exportRequest } from "../../../packages/workbench-export-core/test/fixtures.js";

const executablePath = process.env.WORKBENCH_EXPORT_CHROMIUM_PATH ?? chromium.executablePath();
const available = existsSync(executablePath);

describe("isolated browser export", () => {
  it("does not silently skip a requested browser integration", async () => {
    if (!available) {
      // The release gate sets this flag. A missing executable must fail the
      // test run instead of turning the browser acceptance into a skip.
      expect(process.env.WORKBENCH_RUN_BROWSER_INTEGRATION).not.toBe("1");
      return;
    }
    const browser = service();
    const html = Buffer.from(renderExportHtml(exportRequest("html")).document, "utf8");
    await expect(browser.validateHtml(html, "release-1")).resolves.toBeUndefined();
  }, 30_000);
});

function service() {
  return new BrowserExportService({
    chromiumExecutablePath: executablePath,
    browserTimeoutMs: 30_000,
  });
}
