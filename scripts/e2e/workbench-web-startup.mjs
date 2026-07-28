export const WORKBENCH_WEB_STARTUP_TIMEOUT_MS = 180_000;

export function managedWorkbenchWebDistDir(processId, port) {
  if (!Number.isSafeInteger(processId) || processId < 1) {
    throw new Error("Managed Workbench Web process id is invalid");
  }
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Managed Workbench Web port is invalid");
  }
  return `.next-fixture/e2e-${processId}-${port}`;
}
export const WORKBENCH_PROJECT_WARMUP_PATH = "/projects/project-run-preview";
export const WORKBENCH_HOME_WARMUP_PATH = "/";
export const WORKBENCH_PROJECT_WARMUP_COOKIE =
  "workbench.session_token=workbench-project-route-warmup";
export const WORKBENCH_PROTECTED_ROUTE_WARMUPS = Object.freeze([
  Object.freeze({ path: WORKBENCH_PROJECT_WARMUP_PATH, phase: "project route warmup" }),
  Object.freeze({ path: WORKBENCH_HOME_WARMUP_PATH, phase: "home route warmup" }),
]);

export async function waitForWorkbenchWeb(
  baseUrl,
  exitPromise,
  {
    fetchImpl = globalThis.fetch,
    timeoutMs = WORKBENCH_WEB_STARTUP_TIMEOUT_MS,
    retryDelayMs = 250,
  } = {},
) {
  const deadline = startupDeadline(timeoutMs);
  const loginUrl = new URL("/login", baseUrl);

  while (Date.now() < deadline) {
    const state = await requestWithinStartupBudget({
      url: loginUrl,
      init: { redirect: "manual" },
      exitPromise,
      fetchImpl,
      deadline,
      phase: "startup",
    });
    if (state.kind === "response" && state.status < 500) return;

    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) {
      await delay(Math.min(retryDelayMs, remainingMs));
    }
  }

  throw new Error(`Timed out waiting for Workbench Web at ${baseUrl}`);
}

export async function warmWorkbenchProtectedRoutes(
  baseUrl,
  exitPromise,
  {
    fetchImpl = globalThis.fetch,
    timeoutMs = WORKBENCH_WEB_STARTUP_TIMEOUT_MS,
  } = {},
) {
  const warmedPaths = [];
  for (const warmup of WORKBENCH_PROTECTED_ROUTE_WARMUPS) {
    await warmWorkbenchProtectedRoute(baseUrl, exitPromise, warmup, {
      fetchImpl,
      timeoutMs,
    });
    warmedPaths.push(warmup.path);
  }
  return warmedPaths;
}

async function warmWorkbenchProtectedRoute(
  baseUrl,
  exitPromise,
  warmup,
  { fetchImpl, timeoutMs },
) {
  const warmupUrl = new URL(warmup.path, baseUrl);
  const state = await requestWithinStartupBudget({
    url: warmupUrl,
    init: {
      redirect: "manual",
      headers: { Cookie: WORKBENCH_PROJECT_WARMUP_COOKIE },
    },
    exitPromise,
    fetchImpl,
    deadline: startupDeadline(timeoutMs),
    phase: warmup.phase,
  });

  if (state.kind === "error") {
    throw new Error(
      `Workbench Web ${warmup.phase} request failed at ${warmupUrl}`,
      { cause: state.error },
    );
  }
  if (state.status !== 200) {
    throw new Error(
      `Workbench Web ${warmup.phase} returned HTTP ${state.status} at ${warmupUrl}`,
    );
  }
}

async function requestWithinStartupBudget({
  url,
  init,
  exitPromise,
  fetchImpl,
  deadline,
  phase,
}) {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw new Error(`Timed out waiting for Workbench Web ${phase} at ${url}`);
  }

  const controller = new AbortController();
  let timeoutId;
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve({ kind: "timeout" }), remainingMs);
  });
  const request = Promise.resolve()
    .then(() => fetchImpl(url, { ...init, signal: controller.signal }))
    .then(async (response) => {
      await response.arrayBuffer();
      return { kind: "response", status: response.status };
    })
    .catch((error) => ({ kind: "error", error }));
  const probes = [request, timeout];
  if (exitPromise) {
    probes.push(exitPromise.then((result) => ({ kind: "exit", result })));
  }

  const state = await Promise.race(probes);
  clearTimeout(timeoutId);
  if (state.kind === "timeout" || state.kind === "exit") controller.abort();

  if (state.kind === "timeout") {
    throw new Error(`Timed out waiting for Workbench Web ${phase} at ${url}`);
  }
  if (state.kind === "exit") {
    throw new Error(
      `Workbench Web exited during E2E ${phase}: ${JSON.stringify(state.result)}`,
    );
  }
  return state;
}

function startupDeadline(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("Workbench Web startup timeout must be a positive finite number");
  }
  return Date.now() + timeoutMs;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
