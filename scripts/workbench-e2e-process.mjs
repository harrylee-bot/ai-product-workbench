import { spawn } from "node:child_process";

const lifecycles = new WeakMap();

// npm and Next create grandchildren. Give every harness-owned process its own
// group so cleanup still reaches them after the immediate parent has exited.
export function spawnProcessTree(command, args, options) {
  const child = spawn(command, args, {
    ...options,
    detached: process.platform !== "win32",
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  lifecycles.set(child, { closed, stopping: null });
  return child;
}

export function stopProcessTree(child, { graceMs = 10_000 } = {}) {
  const lifecycle = lifecycles.get(child);
  if (!lifecycle) throw new Error("Cannot stop a process not owned by the E2E harness");
  lifecycle.stopping ??= (async () => {
    if (!child.pid) return;
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      await new Promise((resolve) => {
        killer.once("error", resolve);
        killer.once("close", resolve);
      });
      return;
    }
    signalGroup(child.pid, "SIGTERM");
    let timeout;
    try {
      await Promise.race([
        lifecycle.closed,
        new Promise((resolve) => { timeout = setTimeout(resolve, graceMs); }),
      ]);
    } finally {
      clearTimeout(timeout);
      // A detached descendant may close its inherited pipes before exiting.
      // Kill the remaining group even when the npm parent/stdio already closed.
      signalGroup(child.pid, "SIGKILL");
    }
    await lifecycle.closed;
  })();
  return lifecycle.stopping;
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}
