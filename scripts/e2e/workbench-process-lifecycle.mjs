const cleanupErrorClasses = new Set([
  "AbortError",
  "Error",
  "TimeoutError",
  "TypeError",
]);

export async function runBoundedCleanup(
  label,
  cleanup,
  timeoutMs,
  { setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {},
) {
  if (typeof label !== "string" || !label) {
    throw new TypeError("Cleanup label must be a non-empty string");
  }
  if (typeof cleanup !== "function") {
    throw new TypeError("Cleanup operation must be a function");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("Cleanup timeout must be a positive finite number");
  }

  let timeoutId;
  const operation = Promise.resolve()
    .then(cleanup)
    .then(
      () => ({ label, status: "closed" }),
      (error) => ({
        label,
        status: "failed",
        errorClass: cleanupErrorClass(error),
      }),
    );
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeoutImpl(
      () => resolve({ label, status: "timed-out" }),
      timeoutMs,
    );
  });

  const result = await Promise.race([operation, timeout]);
  clearTimeoutImpl(timeoutId);
  return result;
}

export async function stopProcessTree(
  child,
  exitPromise,
  {
    graceMs = 5_000,
    killWaitMs = 2_000,
    delayImpl = delay,
    isRunningImpl = isProcessTreeRunning,
    signalImpl = signalProcessTree,
  } = {},
) {
  if (!child?.pid || typeof exitPromise?.then !== "function") {
    return { forced: false, status: "not-started" };
  }
  if (!isRunningImpl(child)) {
    return { forced: false, status: "already-stopped" };
  }

  signalImpl(child, "SIGTERM");
  if (await waitForProcessTreeStop(child, graceMs, { delayImpl, isRunningImpl })) {
    return { forced: false, status: "stopped" };
  }

  signalImpl(child, "SIGKILL");
  const stopped = await waitForProcessTreeStop(child, killWaitMs, {
    delayImpl,
    isRunningImpl,
  });
  return {
    forced: true,
    status: stopped ? "stopped" : "timed-out",
  };
}

export function isProcessTreeRunning(child) {
  if (!child?.pid) return false;
  if (process.platform === "win32") {
    return child.exitCode === null && child.signalCode === null;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

export function signalProcessTree(child, signal) {
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function cleanupErrorClass(error) {
  const name = error instanceof Error ? error.name : "UnknownError";
  return cleanupErrorClasses.has(name) ? name : "UnknownError";
}

async function waitForProcessTreeStop(
  child,
  timeoutMs,
  { delayImpl, isRunningImpl },
) {
  if (!isRunningImpl(child)) return true;
  const intervalMs = 50;
  const attempts = Math.max(1, Math.ceil(timeoutMs / intervalMs));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await delayImpl(Math.min(intervalMs, timeoutMs));
    if (!isRunningImpl(child)) return true;
  }
  return false;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
