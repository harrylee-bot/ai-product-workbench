import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { chromium } from "playwright-core";

/**
 * Export jobs require a real Chromium process. Keep this probe separate from
 * document validation so the container healthcheck fails before it accepts
 * work when the executable or its runtime libraries are unavailable.
 */
export async function assertChromiumAvailable(input: {
  executablePath: string;
  timeoutMs: number;
}) {
  const executablePath = input.executablePath.trim();
  if (!executablePath) throw new Error("EXPORT_CHROMIUM_EXECUTABLE_REQUIRED");
  try {
    await access(executablePath, constants.X_OK);
  } catch {
    throw new Error("EXPORT_CHROMIUM_EXECUTABLE_UNAVAILABLE");
  }
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({
      executablePath,
      headless: true,
      chromiumSandbox: false,
      timeout: Math.min(input.timeoutMs, 15_000),
      args: ["--disable-dev-shm-usage", "--disable-gpu", "--no-sandbox", "--no-first-run"],
    });
  } catch (error) {
    throw new Error(
      `EXPORT_CHROMIUM_START_FAILED:${error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240)}`,
    );
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
