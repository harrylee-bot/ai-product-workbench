import assert from "node:assert/strict";
import test from "node:test";

import {
  waitForWorkbenchWeb,
  warmWorkbenchProtectedRoutes,
  WORKBENCH_HOME_WARMUP_PATH,
  WORKBENCH_PROJECT_WARMUP_COOKIE,
  WORKBENCH_PROJECT_WARMUP_PATH,
} from "./workbench-web-startup.mjs";

test("waits for the managed Web login route to become ready", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init });
    if (requests.length === 1) throw new Error("connection refused");
    return new Response("ready", { status: 200 });
  };

  await waitForWorkbenchWeb("http://127.0.0.1:3000", null, {
    fetchImpl,
    retryDelayMs: 1,
    timeoutMs: 500,
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, "http://127.0.0.1:3000/login");
  assert.equal(requests[1].init.redirect, "manual");
});

test("warms every authenticated app entrypoint through the complete response", async () => {
  let completedBodies = 0;
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(new ReadableStream({
      start(controller) {
        setTimeout(() => {
          completedBodies += 1;
          controller.enqueue(new TextEncoder().encode("route ready"));
          controller.close();
        }, 10);
      },
    }), { status: 200 });
  };

  const warmedPaths = await warmWorkbenchProtectedRoutes("http://127.0.0.1:3000", null, {
    fetchImpl,
    timeoutMs: 500,
  });

  assert.deepEqual(
    requests.map(({ url }) => url),
    [
      `http://127.0.0.1:3000${WORKBENCH_PROJECT_WARMUP_PATH}`,
      `http://127.0.0.1:3000${WORKBENCH_HOME_WARMUP_PATH}`,
    ],
  );
  assert.deepEqual(warmedPaths, [WORKBENCH_PROJECT_WARMUP_PATH, WORKBENCH_HOME_WARMUP_PATH]);
  for (const request of requests) {
    assert.equal(request.init.redirect, "manual");
    assert.equal(request.init.headers.Cookie, WORKBENCH_PROJECT_WARMUP_COOKIE);
  }
  assert.equal(completedBodies, 2);
});

test("fails closed when home warmup redirects instead of compiling the protected route", async () => {
  let requestCount = 0;
  await assert.rejects(
    warmWorkbenchProtectedRoutes("http://127.0.0.1:3000", null, {
      fetchImpl: async () => {
        requestCount += 1;
        return requestCount === 1
          ? new Response(null, { status: 200 })
          : new Response(null, {
              status: 307,
              headers: { Location: "/login" },
            });
      },
      timeoutMs: 500,
    }),
    /home route warmup returned HTTP 307/,
  );
});

test("reports a protected route warmup failure when the response body cannot complete", async () => {
  await assert.rejects(
    warmWorkbenchProtectedRoutes("http://127.0.0.1:3000", null, {
      fetchImpl: async () => ({
        status: 200,
        async arrayBuffer() {
          throw new Error("response body interrupted");
        },
      }),
      timeoutMs: 500,
    }),
    (error) => {
      assert.match(error.message, /project route warmup request failed/);
      assert.match(error.cause.message, /response body interrupted/);
      return true;
    },
  );
});

test("aborts protected route warmup when the managed Web process exits", async () => {
  let resolveExit;
  let requestAborted = false;
  const exitPromise = new Promise((resolve) => {
    resolveExit = resolve;
  });
  const fetchImpl = async (_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => {
      requestAborted = true;
      reject(signal.reason);
    }, { once: true });
  });

  const warmup = warmWorkbenchProtectedRoutes("http://127.0.0.1:3000", exitPromise, {
    fetchImpl,
    timeoutMs: 500,
  });
  setTimeout(() => resolveExit({ code: 1, signal: null }), 10);

  await assert.rejects(warmup, /exited during E2E project route warmup/);
  assert.equal(requestAborted, true);
});
