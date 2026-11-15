import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserExportService } from "../src/browser/browser-export.service.js";

const mocks = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock("playwright-core", () => ({ chromium: { launch: mocks.launch } }));
beforeEach(() => vi.resetAllMocks());

const service = new BrowserExportService({ chromiumExecutablePath: "/test/chromium", browserTimeoutMs: 1_000 });
const html = Buffer.from('<title>Export</title><div id="workbench-export-root"></div>');

describe("BrowserExportService cancellation", () => {
  it("does not launch a browser for an already cancelled export", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled before launch");
    controller.abort(reason);
    await expect(service.validateHtml(html, "seed", controller.signal)).rejects.toBe(reason);
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it("closes a browser returned after cancellation during launch without rendering", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled during launch");
    const page = {
      setDefaultTimeout: vi.fn(), on: vi.fn(), route: vi.fn(), setContent: vi.fn(), waitForTimeout: vi.fn(),
      evaluate: vi.fn().mockResolvedValue({ root: true, title: "Export", viewportWidth: 100, viewportHeight: 100 }),
    };
    const context = { addInitScript: vi.fn(), newPage: vi.fn().mockResolvedValue(page), close: vi.fn().mockResolvedValue(undefined) };
    const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
    mocks.launch.mockImplementation(async () => {
      controller.abort(reason);
      return browser;
    });
    await expect(service.validateHtml(html, "seed", controller.signal)).rejects.toBe(reason);
    expect(browser.newContext).not.toHaveBeenCalled();
    expect(page.setContent).not.toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("fails when generated HTML attempts an external network request", async () => {
    const page = {
      setDefaultTimeout: vi.fn(),
      on: vi.fn(),
      route: vi.fn(async (_pattern: unknown, handler: (route: { request(): { url(): string }; abort(reason: string): Promise<void> }) => Promise<void>) => {
        await handler({
          request: () => ({ url: () => "https://external.example.test/script.js" }),
          abort: vi.fn().mockResolvedValue(undefined),
        });
      }),
      setContent: vi.fn().mockResolvedValue(undefined),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue({ root: true, title: "Export", viewportWidth: 100, viewportHeight: 100 }),
    };
    const context = { addInitScript: vi.fn(), newPage: vi.fn().mockResolvedValue(page), close: vi.fn().mockResolvedValue(undefined) };
    const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
    mocks.launch.mockResolvedValue(browser);
    await expect(service.validateHtml(html, "seed")).rejects.toThrow("EXPORT_HTML_BROWSER_VALIDATION_FAILED");
    expect(browser.close).toHaveBeenCalledOnce();
  });
});
