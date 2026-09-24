import { spawn } from "node:child_process";

import { boundedDetail, TerminalExportError } from "./errors.js";

const defaultTimeoutMs = 120_000;
const maximumStderrCharacters = 3_000;

export function runDocumentExportCommand(
  command: string,
  args: string[],
  timeoutMs = defaultTimeoutMs,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const isolatedProcessGroup = process.platform !== "win32";
    const child = spawn(command, args, {
      detached: isolatedProcessGroup,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      // soffice can launch its own process; stop the complete rendering group.
      try {
        if (isolatedProcessGroup && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    timeout.unref();

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-maximumStderrCharacters);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(new TerminalExportError("EXPORT_RENDER_FAILED", boundedDetail(error)));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) {
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
