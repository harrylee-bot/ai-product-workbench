import { spawn } from "node:child_process";

import { boundedDetail, TerminalExportError } from "./errors.js";
import type { ExportBuildExecution } from "./types.js";

const defaultTimeoutMs = 120_000;
const maximumStderrCharacters = 3_000;

export function runDocumentExportCommand(
  command: string,
  args: string[],
  execution: ExportBuildExecution | number = {},
): Promise<void> {
  const { signal, timeoutMs = defaultTimeoutMs } = typeof execution === "number"
    ? { timeoutMs: execution }
    : execution;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("EXPORT_ABORTED"));
      return;
    }
    const isolatedProcessGroup = process.platform !== "win32";
    const child = spawn(command, args, {
      detached: isolatedProcessGroup,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    const stopProcessGroup = () => {
      // soffice can launch its own process; stop the complete rendering group.
      try {
        if (isolatedProcessGroup && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const onAbort = () => {
      aborted = true;
      stopProcessGroup();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      stopProcessGroup();
    }, timeoutMs);
    timeout.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    };

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-maximumStderrCharacters);
    });
    child.on("error", (error) => {
      cleanup();
      reject(new TerminalExportError("EXPORT_RENDER_FAILED", boundedDetail(error)));
    });
    child.on("close", (code) => {
      cleanup();
      if (aborted) {
        // Wait for close before callers remove the renderer's temporary files.
        reject(signal?.reason ?? new Error("EXPORT_ABORTED"));
      } else if (timedOut) {
        reject(new TerminalExportError(
          "EXPORT_RENDER_TIMEOUT",
          `Document rendering exceeded ${timeoutMs} ms`,
        ));
      } else if (code === 0) {
        resolve();
      } else {
        reject(new TerminalExportError(
          "EXPORT_RENDER_FAILED",
          `Command failed with code ${code}: ${stderr}`,
        ));
      }
    });
  });
}
