import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import { describe, expect, it } from "vitest";
import { renderExportHtml } from "@workbench/workbench-export-core";
import { BrowserExportService } from "../src/browser/browser-export.service.js";
import { exportRequest } from "../../../packages/workbench-export-core/test/fixtures.js";

const executablePath = chromium.executablePath();
const available = process.env.WORKBENCH_RUN_BROWSER_INTEGRATION === "1"
  && existsSync(executablePath);

describe("isolated browser export", () => {
  it.runIf(available)("executes generated HTML without browser errors", async () => {
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
