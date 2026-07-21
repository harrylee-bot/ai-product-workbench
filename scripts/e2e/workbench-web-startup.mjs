export const WORKBENCH_WEB_STARTUP_TIMEOUT_MS = 90_000;
export const WORKBENCH_PROJECT_WARMUP_PATH = "/projects/project-run-preview";
export const WORKBENCH_PROJECT_WARMUP_COOKIE =
  "workbench.session_token=workbench-project-route-warmup";

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

export async function warmWorkbenchProjectRoute(
  baseUrl,
  exitPromise,
  {
    fetchImpl = globalThis.fetch,
    timeoutMs = WORKBENCH_WEB_STARTUP_TIMEOUT_MS,
  } = {},
) {
  const warmupUrl = new URL(WORKBENCH_PROJECT_WARMUP_PATH, baseUrl);
  const state = await requestWithinStartupBudget({
    url: warmupUrl,
    init: {
      redirect: "manual",
      headers: { Cookie: WORKBENCH_PROJECT_WARMUP_COOKIE },
    },
    exitPromise,
    fetchImpl,
    deadline: startupDeadline(timeoutMs),
    phase: "project route warmup",
  });

  if (state.kind === "error") {
    throw new Error(
      `Workbench Web project route warmup request failed at ${warmupUrl}`,
      { cause: state.error },
    );
  }
  if (state.status !== 200) {
    throw new Error(
      `Workbench Web project route warmup returned HTTP ${state.status} at ${warmupUrl}`,
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
