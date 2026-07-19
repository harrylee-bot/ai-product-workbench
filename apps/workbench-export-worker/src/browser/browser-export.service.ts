import { createHash } from "node:crypto";
import { TerminalExportError } from "@workbench/workbench-export-core";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import type { ExportWorkerConfig } from "../config.js";

export class BrowserExportService {
  constructor(private readonly config: Pick<
    ExportWorkerConfig,
    "chromiumExecutablePath" | "browserTimeoutMs"
  >) {}

  async validateHtml(html: Uint8Array, seed: string, signal?: AbortSignal) {
    const value = new TextDecoder("utf-8", { fatal: true }).decode(html);
    await this.withPage(seed, signal, async (page, errors) => {
      await page.setContent(value, { waitUntil: "load", timeout: this.config.browserTimeoutMs });
      await page.waitForTimeout(50);
      const evidence = await page.evaluate(() => ({
        root: Boolean(document.getElementById("workbench-export-root")),
        title: document.title,
        artifactCount: document.querySelectorAll("[data-artifact-version-id]").length,
        viewportWidth: document.documentElement.scrollWidth,
        viewportHeight: document.documentElement.scrollHeight,
      }));
      if (!evidence.root || !evidence.title || evidence.viewportWidth <= 0 || evidence.viewportHeight <= 0 || errors.length > 0) {
        throw new TerminalExportError(
          "EXPORT_HTML_BROWSER_VALIDATION_FAILED",
          errors[0] ?? "Generated HTML did not produce a valid document",
        );
      }
    });
  }

  private async withPage<T>(
    seed: string,
    signal: AbortSignal | undefined,
    operation: (page: Page, errors: string[]) => Promise<T>,
  ) {
    if (signal?.aborted) throw abortError(signal);
    const browser = await chromium.launch({
      executablePath: this.config.chromiumExecutablePath,
      headless: true,
      chromiumSandbox: false,
      timeout: this.config.browserTimeoutMs,
      args: [
        "--disable-background-networking",
        "--disable-breakpad",
        "--disable-component-update",
        "--disable-dev-shm-usage",
        "--disable-extensions",
        "--disable-gpu",
        "--disable-sync",
        "--metrics-recording-only",
        "--no-first-run",
        "--no-sandbox",
      ],
    });
    let context: BrowserContext | undefined;
    const abort = () => void browser.close();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      context = await browser.newContext({
        javaScriptEnabled: true,
        serviceWorkers: "block",
        viewport: { width: 1440, height: 1000 },
        acceptDownloads: false,
      });
      await context.addInitScript(deterministicBrowserPrelude(seed));
      const page = await context.newPage();
      page.setDefaultTimeout(this.config.browserTimeoutMs);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message.slice(0, 1_000)));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text().slice(0, 1_000));
      });
      await page.route(/^(?:https?|wss?):/i, (route) => route.abort("blockedbyclient"));
      return await operation(page, errors);
    } finally {
      signal?.removeEventListener("abort", abort);
      await context?.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    }
  }
}

function deterministicBrowserPrelude(seed: string) {
  const initial = Number.parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 8), 16) || 1;
  return `(() => { let state=${initial}>>>0; const next=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state}; Math.random=()=>next()/4294967296; const fixed=Date.UTC(2026,0,1); Date.now=()=>fixed; const fill=(array)=>{const bytes=new Uint8Array(array.buffer,array.byteOffset,array.byteLength);for(let i=0;i<bytes.length;i++)bytes[i]=next()&255;return array}; try{Object.defineProperty(Crypto.prototype,"getRandomValues",{value:fill,configurable:true})}catch{} })();`;
}

function abortError(signal: AbortSignal) {
  return signal.reason instanceof Error ? signal.reason : new Error("EXPORT_ABORTED");
}
