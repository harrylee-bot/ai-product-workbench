import assert from "node:assert/strict";
import test from "node:test";
import {
  assertMalformedScopeRefusal,
  cleanupOwnedRuns,
  loadStablePersistedSurfaces,
} from "./workbench-deerflow-secret-channel-validation.mjs";

const run = {
  run_id: "run",
  thread_id: "thread",
  status: "success",
  metadata: { workbench_runtime_attempt_id: "attempt" },
  created_at: "2026-11-04T00:00:00Z",
  updated_at: "2026-11-04T00:00:13Z",
};

function fixture(count, mutate = (page) => page) {
  const entries = Array.from({ length: count }, (_, index) => ({
    checkpoint_id: String(count - index),
    parent_checkpoint_id: index === count - 1 ? null : String(count - index - 1),
    metadata: { workbench_runtime_attempt_id: "attempt" },
  }));
  const requests = [];
  return {
    requests,
    client: {
      runs: { get: async () => run, list: async () => [run] },
      threads: {
        get: async () => ({}),
        getState: async () => ({}),
        getHistory: async (_thread, { before, limit }) => {
          requests.push(before);
          const start = before ? entries.findIndex((entry) => entry.checkpoint_id === before) : 0;
          return mutate(entries.slice(start, start + limit));
        },
      },
    },
  };
}

for (const count of [100, 201]) {
  test(`walks all ${count} checkpoints using inclusive parents`, async () => {
    const sample = fixture(count);
    const result = await loadStablePersistedSurfaces(sample.client, "thread", "run", "attempt");
    assert.equal(result.evidence.historyEntries, count);
    assert.equal(result.evidence.historyPages, Math.ceil(count / 100));
    assert.equal(result.evidence.providerStatus, "success");
    assert.equal(result.evidence.providerDurationMs, 13_000);
  });
}

test("rejects a broken parent chain", async () => {
  const sample = fixture(4, (page) => [page[0], ...page.slice(2)]);
  await assert.rejects(loadStablePersistedSurfaces(sample.client, "thread", "run", "attempt"), /CHAIN_GAP/);
});

test("rejects foreign run attribution", async () => {
  const sample = fixture(1, (page) => [{ ...page[0], metadata: { workbench_runtime_attempt_id: "other" } }]);
  await assert.rejects(loadStablePersistedSurfaces(sample.client, "thread", "run", "attempt"), /RUN_MISMATCH/);
});

test("does not scan a still-running provider", async () => {
  const sample = fixture(1);
  sample.client.runs.get = async () => ({ ...run, status: "running" });
  let clock = 0;
  await assert.rejects(loadStablePersistedSurfaces(sample.client, "thread", "run", "attempt", {
    now: () => clock,
    pause: async () => { clock += 1; },
    maximumWaitMs: 2,
  }), /NOT_TERMINAL/);
  assert.deepEqual(sample.requests, []);
});

test("bounds a hung provider status request and aborts its transport", async () => {
  const sample = fixture(1);
  let requestSignal;
  sample.client.runs.get = (_thread, _run, { signal }) => {
    requestSignal = signal;
    return new Promise(() => {});
  };
  await assert.rejects(loadStablePersistedSurfaces(sample.client, "thread", "run", "attempt", {
    maximumWaitMs: 10,
  }), /PROVIDER_STATUS_TIMEOUT/);
  assert.equal(requestSignal.aborted, true);
});

test("bounds a hung history request and aborts its transport", async () => {
  const sample = fixture(1);
  let requestSignal;
  sample.client.threads.getHistory = (_thread, { signal }) => {
    requestSignal = signal;
    return new Promise(() => {});
  };
  await assert.rejects(loadStablePersistedSurfaces(sample.client, "thread", "run", "attempt", {
    maximumScanMs: 10,
  }), /SCAN_TIMEOUT/);
  assert.equal(requestSignal.aborted, true);
});

const denialState = { values: { messages: [
  { type: "ai", tool_calls: [{ id: "call-1", name: "workbench_knowledge_retrieve" }] },
  {
    type: "tool",
    tool_call_id: "call-1",
    name: "workbench_knowledge_retrieve",
    status: "error",
    content: "Error: WORKBENCH_KNOWLEDGE_TOOL_NOT_AUTHORIZED",
  },
] } };

test("accepts a typed causal tool refusal", () => {
  assert.deepEqual(assertMalformedScopeRefusal(denialState).denialCodes, ["WORKBENCH_KNOWLEDGE_TOOL_NOT_AUTHORIZED"]);
});

test("does not mistake model text or absence of calls for refusal", () => {
  for (const messages of [
    [],
    [{ type: "ai", content: "Error: WORKBENCH_KNOWLEDGE_TOOL_NOT_AUTHORIZED" }],
    [denialState.values.messages[1]],
  ]) {
    assert.throws(() => assertMalformedScopeRefusal({ values: { messages } }), /NOT_FAIL_CLOSED/);
  }
});

test("rejects an unpaired tool denial", () => {
  const state = structuredClone(denialState);
  state.values.messages[1].tool_call_id = "unrelated";
  assert.throws(() => assertMalformedScopeRefusal(state), /NOT_FAIL_CLOSED/);
});

test("cleans up only recorded active runs and verifies interruption", async () => {
  const calls = [];
  let active = true;
  const client = { runs: {
    get: async (thread, id) => ({ thread_id: thread, run_id: id, status: active ? "running" : "interrupted" }),
    cancel: async (thread, id, wait, action) => {
      calls.push([thread, id, wait, action]);
      active = false;
    },
  } };
  const result = await cleanupOwnedRuns(client, [{ externalThreadId: "own-thread", externalRunId: "own-run" }]);
  assert.deepEqual(calls, [["own-thread", "own-run", true, "interrupt"]]);
  assert.deepEqual(result, { ownedRunsChecked: 1, cancelled: 1 });
});

test("does not cancel a mismatched or already terminal run", async () => {
  let cancellations = 0;
  const client = { runs: {
    get: async () => ({ thread_id: "own-thread", run_id: "own-run", status: "success" }),
    cancel: async () => { cancellations += 1; },
  } };
  await cleanupOwnedRuns(client, [{ externalThreadId: "own-thread", externalRunId: "own-run" }]);
  await assert.rejects(cleanupOwnedRuns(client, [{ externalThreadId: "other-thread", externalRunId: "other-run" }]), /CLEANUP_FAILED/);
  assert.equal(cancellations, 0);
});

test("bounds an unresponsive cleanup without exposing transport errors", async () => {
  const client = { runs: { get: () => new Promise(() => {}) } };
  await assert.rejects(cleanupOwnedRuns(client, [{ externalThreadId: "own-thread", externalRunId: "own-run" }], {
    timeoutMs: 10,
  }), /OWNED_RUN_CLEANUP_FAILED/);
});
