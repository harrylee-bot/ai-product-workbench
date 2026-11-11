import { execFileSync, spawn } from "node:child_process";

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
    const groupSignaled = await signalGroup(child, "SIGTERM");
    if (!groupSignaled) {
      await lifecycle.closed;
      return;
    }
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
      await signalGroup(child, "SIGKILL");
    }
    await lifecycle.closed;
  })();
  return lifecycle.stopping;
}

async function signalGroup(child, signal) {
  const pid = child.pid;
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    // Next build workers on macOS briefly remain as same-UID ?E (exiting)
    // members after the parent exits; signaling that group returns EPERM.
    // Wait only for this observed terminal transition, then require an empty
    // group. Never hide an error for live/unowned/unknown group members.
    if (error?.code === "EPERM" && process.platform === "darwin"
      && (child.exitCode !== null || child.signalCode !== null)) {
      try {
        const deadline = Date.now() + 500;
        while (Date.now() < deadline) {
          const snapshot = execFileSync("ps", ["-axo", "pgid=,uid=,stat="], { encoding: "utf8" });
          const state = processGroupExitState(snapshot, pid, process.getuid());
          if (state === "gone") return false;
          if (state !== "exiting") break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      } catch { /* Keep the signal failure below. */ }
    }
    if (error?.code !== "ESRCH") throw error;
    return false;
  }
}

export function processGroupExitState(snapshot, groupId, expectedUid) {
  if (!Number.isSafeInteger(groupId) || groupId < 1 || !Number.isSafeInteger(expectedUid)
    || expectedUid < 0 || typeof snapshot !== "string") return "unknown";
  let found = false;
  for (const line of snapshot.split("\n")) {
    if (!line.trim()) continue;
    // macOS reports the unrelated nobody account as UID -2. Parse that row
    // without invalidating the entire snapshot; target-group ownership still
    // has to match the current, non-negative process UID below.
    const match = /^\s*(\d+)\s+(-?\d+)\s+(\S+)\s*$/u.exec(line);
    if (!match) return "unknown";
    if (Number(match[1]) !== groupId) continue;
    found = true;
    if (Number(match[2]) !== expectedUid) return "unowned";
    if (match[3] !== "?E" && !/^Z[A-Za-z+<>-]*$/u.test(match[3])) return "live";
  }
  return found ? "exiting" : "gone";
}
