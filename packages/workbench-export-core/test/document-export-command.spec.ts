import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDocumentExportCommand } from "../src/document-export-command.js";

describe("document renderer subprocesses", () => {
  it("does not start a command when its signal was already aborted", async () => {
    const controller = new AbortController();
    const reason = new Error("queue stopped");
    controller.abort(reason);
    await expect(runDocumentExportCommand("/must-not-execute", [], { signal: controller.signal })).rejects.toBe(reason);
  });

  it.skipIf(process.platform === "win32")("aborts the whole renderer group and waits for its pipes to close", async () => {
    const directory = await mkdtemp(join(tmpdir(), "export-abort-"));
    const pidFile = join(directory, "child.pid");
    const controller = new AbortController();
    const reason = new Error("queue ownership lost");
    const childProgram = "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)";
    const parentProgram = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childProgram)}, process.argv[1]], {stdio: 'inherit'}); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`;
    const result = runDocumentExportCommand(process.execPath, ["-e", parentProgram, pidFile], {
      signal: controller.signal, timeoutMs: 5_000,
    }).catch((error) => error);
    let childPid: number | undefined;
    try {
      const deadline = Date.now() + 3_000;
      while (!childPid && Date.now() < deadline) {
        childPid = await readFile(pidFile, "utf8").then(Number).catch(() => undefined);
        if (!childPid) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(childPid).toBeGreaterThan(0);
      controller.abort(reason);
      expect(await result).toBe(reason);
      // A child ignoring SIGTERM must not survive the process-group abort.
      const deadlineGone = Date.now() + 1_000;
      let running = true;
      while (running && Date.now() < deadlineGone) {
        try { process.kill(childPid!, 0); } catch { running = false; }
        if (running) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(running).toBe(false);
    } finally {
      controller.abort(reason);
      await result;
      if (childPid) { try { process.kill(childPid, "SIGKILL"); } catch { /* already stopped */ } }
      await rm(directory, { recursive: true, force: true });
    }
  });
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
