async function boundedCall(operation, timeoutMs, code) {
  if (timeoutMs <= 0) throw new Error(code);
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(code));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(code);
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export async function loadStablePersistedSurfaces(client, threadId, runId, runtimeAttemptId, options = {}) {
  const now = options.now ?? Date.now;
  const pause = options.pause ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const started = now();
  let run;
  for (;;) {
    if (run && now() - started >= (options.maximumWaitMs ?? 60_000)) throw new Error("SECRET_CHANNEL_PROVIDER_NOT_TERMINAL");
    run = await boundedCall(
      (signal) => client.runs.get(threadId, runId, { signal }),
      (options.maximumWaitMs ?? 60_000) - (now() - started),
      "SECRET_CHANNEL_PROVIDER_STATUS_TIMEOUT",
    );
    if (run.run_id !== runId || run.thread_id !== threadId
      || run.metadata?.workbench_runtime_attempt_id !== runtimeAttemptId) {
      throw new Error("SECRET_CHANNEL_RUN_BINDING_INVALID");
    }
    if (run.status === "success") break;
    if (["error", "timeout", "interrupted"].includes(run.status)) throw new Error("SECRET_CHANNEL_PROVIDER_NOT_SUCCESS");
    if (now() - started >= (options.maximumWaitMs ?? 60_000)) throw new Error("SECRET_CHANNEL_PROVIDER_NOT_TERMINAL");
    await pause(options.pollMs ?? 250);
  }
  const providerWaitMs = now() - started;
  const scanStarted = now();
  const scan = (operation) => boundedCall(
    operation,
    (options.maximumScanMs ?? 60_000) - (now() - scanStarted),
    "SECRET_CHANNEL_SCAN_TIMEOUT",
  );
  const [runs, thread, state] = await scan((signal) => Promise.all([
    client.runs.list(threadId, { limit: 100, signal }),
    client.threads.get(threadId, { include: ["values", "config", "context"], signal }),
    client.threads.getState(threadId, undefined, { subgraphs: true, signal }),
  ]));
  if (!Array.isArray(runs) || runs.length !== 1 || runs[0]?.run_id !== runId) throw new Error("SECRET_CHANNEL_THREAD_RUNS_INVALID");
  const history = [];
  const seen = new Set();
  let before;
  let boundCheckpoints = 0;
  let historyPages = 0;
  for (;;) {
    if (++historyPages > 100) throw new Error("SECRET_CHANNEL_HISTORY_PAGE_LIMIT");
    const page = await scan((signal) => client.threads.getHistory(threadId, { limit: 100, signal, ...(before ? { before } : {}) }));
    if (!Array.isArray(page) || page.length === 0 || page.length > 100) throw new Error("SECRET_CHANNEL_HISTORY_PAGE_INVALID");
    if (before && page[0]?.checkpoint_id !== before) throw new Error("SECRET_CHANNEL_HISTORY_CURSOR_INVALID");
    for (const entry of page) {
      const id = entry?.checkpoint_id;
      if (typeof id !== "string" || !id || seen.has(id)) throw new Error("SECRET_CHANNEL_HISTORY_ID_INVALID");
      if (history.length && history.at(-1).parent_checkpoint_id !== id) throw new Error("SECRET_CHANNEL_HISTORY_CHAIN_GAP");
      const attempt = entry.metadata?.workbench_runtime_attempt_id;
      if (attempt !== undefined && attempt !== runtimeAttemptId) throw new Error("SECRET_CHANNEL_HISTORY_RUN_MISMATCH");
      if (attempt === runtimeAttemptId) boundCheckpoints += 1;
      seen.add(id);
      history.push(entry);
      if (history.length > 10_000) throw new Error("SECRET_CHANNEL_HISTORY_LIMIT");
    }
    const parent = history.at(-1).parent_checkpoint_id;
    if (parent === null) break;
    if (typeof parent !== "string" || !parent || seen.has(parent)) throw new Error("SECRET_CHANNEL_HISTORY_PARENT_INVALID");
    // DeerFlow 2.1 before is an inclusive checkpoint anchor. Advancing to the
    // last entry's parent visits every checkpoint exactly once, including an
    // exact 100-entry history whose last parent is null.
    before = parent;
  }
  if (!boundCheckpoints) throw new Error("SECRET_CHANNEL_HISTORY_RUN_BINDING_MISSING");
  const finalRun = await scan((signal) => client.runs.get(threadId, runId, { signal }));
  if (finalRun.status !== "success" || finalRun.run_id !== runId || finalRun.thread_id !== threadId) throw new Error("SECRET_CHANNEL_PROVIDER_STATE_CHANGED");
  const providerDurationMs = Date.parse(run.updated_at) - Date.parse(run.created_at);
  if (!Number.isFinite(providerDurationMs) || providerDurationMs < 0) throw new Error("SECRET_CHANNEL_PROVIDER_DURATION_INVALID");
  return {
    surfaces: [{ label: "run", value: run }, { label: "run-list", value: runs }, { label: "thread", value: thread }, { label: "state", value: state }, { label: "history", value: history }],
    evidence: { providerStatus: run.status, providerWaitMs, providerDurationMs, historyEntries: history.length, historyPages, boundCheckpoints, completeParentChain: true },
  };
}

export function assertMalformedScopeRefusal(state) {
  const messages = state?.values?.messages;
  if (!Array.isArray(messages)) throw new Error("SECRET_CHANNEL_MALFORMED_SCOPE_EVIDENCE_INVALID");
  const calls = new Map();
  const denials = [];
  for (const message of messages) {
    if (["ai", "assistant", "AIMessage"].includes(message?.type)) {
      for (const call of message.tool_calls ?? []) {
        if (typeof call?.id === "string" && call.name === "workbench_knowledge_retrieve") calls.set(call.id, call.name);
      }
    }
    if (message?.type !== "tool" || message.name !== "workbench_knowledge_retrieve"
      || message.status !== "error" || calls.get(message.tool_call_id) !== message.name) continue;
    for (const code of ["WORKBENCH_KNOWLEDGE_TOOL_NOT_AUTHORIZED", "WORKBENCH_KNOWLEDGE_CAPABILITY_MISSING"]) {
      if (message.content === `Error: ${code}` || message.content === code) denials.push(code);
    }
  }
  if (!denials.length) throw new Error("SECRET_CHANNEL_MALFORMED_SCOPE_NOT_FAIL_CLOSED");
  return { failClosed: true, denialCount: denials.length, denialCodes: [...new Set(denials)], typedToolCallEvidence: true };
}

export async function cleanupOwnedRuns(client, ownedRuns, options = {}) {
  const unique = new Map(ownedRuns.map((run) => [`${run.externalThreadId}:${run.externalRunId}`, run]));
  let cancelled = 0;
  try {
    await boundedCall(async (signal) => {
      for (const { externalThreadId, externalRunId } of unique.values()) {
        const run = await client.runs.get(externalThreadId, externalRunId, { signal });
        if (run.run_id !== externalRunId || run.thread_id !== externalThreadId) throw new Error("RUN_MISMATCH");
        if (["pending", "running"].includes(run.status)) {
          await client.runs.cancel(externalThreadId, externalRunId, true, "interrupt", { signal });
          cancelled += 1;
          const final = await client.runs.get(externalThreadId, externalRunId, { signal });
          if (final.run_id !== externalRunId || final.thread_id !== externalThreadId
            || !["success", "error", "timeout", "interrupted"].includes(final.status)) throw new Error("CANCELLATION_UNCONFIRMED");
        } else if (!["success", "error", "timeout", "interrupted"].includes(run.status)) throw new Error("STATUS_INVALID");
      }
    }, options.timeoutMs ?? 30_000, "SECRET_CHANNEL_OWNED_RUN_CLEANUP_FAILED");
  } catch {
    // Never include SDK response bodies or request context in cleanup failures.
    throw new Error("SECRET_CHANNEL_OWNED_RUN_CLEANUP_FAILED");
  }
  return { ownedRunsChecked: unique.size, cancelled };
}
