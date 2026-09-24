import { describe, expect, it } from "vitest";

import { runDocumentExportCommand } from "../src/document-export-command.js";

describe("document renderer subprocesses", () => {
  it("drains successful commands without retaining stdout", async () => {
    await expect(runDocumentExportCommand(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(1024 * 1024))"],
      5_000,
    )).resolves.toBeUndefined();
  });

  it("reports bounded diagnostics for failed commands", async () => {
    const error = await runDocumentExportCommand(
      process.execPath,
      ["-e", "process.stderr.write('x'.repeat(10000), () => process.exit(7))"],
      5_000,
    ).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: "EXPORT_RENDER_FAILED" });
    expect((error as { safeDetail: string }).safeDetail.length).toBeLessThan(4_000);
    expect((error as { safeDetail: string }).safeDetail).toContain("code 7");
  });

  it("terminates a renderer that never completes", async () => {
    await expect(runDocumentExportCommand(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      100,
    )).rejects.toMatchObject({
      code: "EXPORT_RENDER_TIMEOUT",
      safeDetail: "Document rendering exceeded 100 ms",
    });
  });

  it("reports missing renderer commands immediately", async () => {
    await expect(runDocumentExportCommand(
      "/workbench-document-renderer-does-not-exist",
      [],
      5_000,
    )).rejects.toMatchObject({ code: "EXPORT_RENDER_FAILED" });
  });
});
