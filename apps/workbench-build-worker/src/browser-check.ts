import { chromium } from "playwright-core";

export type BrowserCheckOptions = {
  executablePath?: string;
  timeoutMs?: number;
  onProgress?: (details: string) => void;
};

export async function checkFrozenPrototypeHtml(html: string, options: BrowserCheckOptions = {}): Promise<void> {
  const executablePath = options.executablePath || process.env.WORKBENCH_EXPORT_CHROMIUM_PATH || chromium.executablePath();
  options.onProgress?.("chromium:launch");
  const browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: false, args: ["--no-sandbox"] }).catch((error) => {
    throw new Error(`BUILD_BROWSER_EXECUTABLE_REQUIRED: ${error instanceof Error ? error.message : "Chromium launch failed"}`);
  });
  try {
    const page = await browser.newPage({ javaScriptEnabled: true });
    const externalRequests: string[] = [];
    const scriptErrors: string[] = [];
    page.on("pageerror", (error) => scriptErrors.push(error.message));
    await page.context().route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
        externalRequests.push(url.toString());
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
    options.onProgress?.("chromium:load");
    await page.goto(`data:text/html;base64,${Buffer.from(html).toString("base64")}`, { waitUntil: "load", timeout: options.timeoutMs ?? 15_000 });
    if (externalRequests.length > 0) throw new Error(`BUILD_EXTERNAL_NETWORK_REQUEST: ${externalRequests[0]}`);
    options.onProgress?.("chromium:dom");
    if ((await page.locator("body").count()) !== 1) throw new Error("BUILD_BROWSER_DOM_INVALID");
    if (await page.locator("[data-prototype-build-error]").count()) throw new Error("BUILD_BROWSER_DOM_INVALID");
    if (html.includes("data-wb-prototype")) {
      await page.waitForFunction(() => Boolean(document.querySelector('[data-wb-runtime-installed="true"] [data-wb-screen]:not([hidden])')), undefined, { timeout: options.timeoutMs ?? 15_000 });
    }
    if (scriptErrors.length > 0) throw new Error(`BUILD_BROWSER_SCRIPT_ERROR: ${scriptErrors[0]}`);
  } finally {
    await browser.close();
  }
}
