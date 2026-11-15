import { describe, expect, it } from "vitest";
import { assertChromiumAvailable } from "../src/browser/chromium-health.js";

describe("export Chromium runtime gate", () => {
  it("fails closed when the configured executable is missing", async () => {
    await expect(assertChromiumAvailable({
      executablePath: "/definitely/missing/workbench-chromium",
      timeoutMs: 1_000,
    })).rejects.toThrow("EXPORT_CHROMIUM_EXECUTABLE_UNAVAILABLE");
  });
});
