import { describe, expect, it, vi } from "vitest";
import { canonicalJson, startRunRequestSchema } from "@workbench/workbench-contracts";
import type { RunProcessor } from "../src/runs/run-processor.js";
import type { RuntimePort } from "../src/runtime/runtime.port.js";
import { preparePrototypeRuntime, PrototypeRuntimeBridge } from "../src/prototypes/prototype-runtime-bridge.js";
import { prototypeDocumentFixture } from "../../../packages/workbench-contracts/test/prototype-fixture.js";

const input = { projectId: "project-1", planId: "plan-1", revisionId: "revision_plan-1", prompt: "Create signup", title: "Signup", createdById: "owner-1" };
function harness() {
  const plan = { id: input.planId, projectId: input.projectId, createdById: input.createdById, title: input.title, prompt: input.prompt, status: "approved", runtimeRunId: "run-1" as string | null, contentVersion: 1, rootPlanId: null, sourceRevisionId: null, requestHash: "a".repeat(64) };
  let run: Record<string, any> = { id: "run-1", projectId: input.projectId, threadId: "thread-1", requestId: "request-1", traceId: "trace-1", eventSequence: 0, status: "queued", errorCode: null, createdById: input.createdById, modelId: "first-model", knowledgeReleaseId: "release-original", request: startRunRequestSchema.parse({ prompt: input.prompt, modelId: "first-model", workflow: "generate", generationIntent: null, targetSurface: "web", designStyle: { kind: "automatic" }, sourceIds: [], artifactTargets: [], requestedArtifactKinds: ["prototype"], canvasSnapshot: null,requirementConfirmationId:"confirmation-1" }) };
  const baseline={summaryChecksum:"a".repeat(64),card:{goal:input.prompt},evidence:[],analysisContext:{},sourceContents:{readings:[]}};
  const tx = {
    requirementConfirmation:{findFirst:vi.fn(async()=>({id:"confirmation-1",principalId:input.createdById,sessionId:"session-1",summaryVersion:1,runId:run.id,generationRequest:run.request,baseline,inputSnapshot:{sources:[],designStyle:{artifactVersionId:null,snapshot:null,snapshotSha256:null},knowledgeReleaseId:run.knowledgeReleaseId}}))},
    requirementSummary:{findUnique:vi.fn(async()=>({version:1,checksum:baseline.summaryChecksum,card:baseline.card,evidence:baseline.evidence,contextSnapshot:baseline.analysisContext}))},
    $queryRaw: vi.fn(async () => [{ id: plan.id }]),
    prototypePlan: {
      findFirst: vi.fn(async () => plan), findUnique: vi.fn(async () => plan),
      update: vi.fn(async ({ data }: any) => Object.assign(plan, data)),
      updateMany: vi.fn(async ({ where, data }: any) => { if (where.status === plan.status) { Object.assign(plan, data); return { count: 1 }; } return { count: 0 }; }),
    },
    project: { findFirst: vi.fn(async () => ({ id: input.projectId, workspaceId: "workspace-1" })) },
    board: { findUnique: vi.fn(async () => ({ id: "board-1" })) },
    projectMember: { findFirst: vi.fn(async () => ({ role: "owner" })) },
    knowledgeRelease: { findFirst: vi.fn(async (_query?: any) => ({ id: "release-original" })) },
    thread: { create: vi.fn(async () => ({ id: "thread-1" })) },
    threadEntry: { create: vi.fn(async () => ({ id: "entry-1" })) },
    run: {
      findFirst:vi.fn(async()=>run),
      create: vi.fn(async ({ data }: any) => { run = { ...run, ...data }; return run; }),
      update: vi.fn(async ({ data }: any) => { run.eventSequence += data.eventSequence.increment; return run; }),
      updateMany: vi.fn(async ({ data }: any) => { Object.assign(run, data); return { count: 1 }; }),
      findUniqueOrThrow: vi.fn(async () => run),
    },
    runEvent: { create: vi.fn(async ({ data }: any) => ({ id: "event-1", ...data, occurredAt: new Date() })) },
    prototypeRevision: { upsert: vi.fn(async (_args?: any) => ({ id: input.revisionId, status: "generating" })) },
    artifactVersion: { findMany: vi.fn(async () => [{ id: "fixed-generated-prototype", schemaVersion: 1, content: prototypeDocumentFixture(), artifact: { title: "Generated signup" } }]) },
  };
  const db = { ...tx, $transaction: vi.fn(async (action: (tx: unknown) => Promise<unknown>) => action(tx)) };
  return { db, tx, plan, get run() { return run; } };
}
function runtime(): RuntimePort { return { adapter: "deerflow", createThread: vi.fn(), execute: vi.fn(), cancel: vi.fn() }; }
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function factory(execute: (...args: any[]) => Promise<unknown>, cancel: (...args: any[]) => Promise<unknown> = vi.fn(async () => ({ cancelled: true }))) {
  return () => ({ execute, cancel } as unknown as RunProcessor);
}

describe("Prototype Runtime bridge preparation", () => {
  it("uses only the API-pinned Run and request across activity retries", async () => {
    const h = harness(); const original = structuredClone(h.run.request);
    h.plan.prompt = "Human-readable review summary without the internal anchor payload";
    expect((await preparePrototypeRuntime(h.db as never, input)).prompt).toBe(original.prompt);
    h.tx.knowledgeRelease.findFirst.mockResolvedValue({ id: "release-new" }); h.plan.status = "ready";
    await preparePrototypeRuntime(h.db as never, input);
    expect(h.tx.thread.create).not.toHaveBeenCalled(); expect(h.tx.run.create).not.toHaveBeenCalled();
    expect(h.tx.knowledgeRelease.findFirst).not.toHaveBeenCalled();
    expect(canonicalJson(h.run.request)).toBe(canonicalJson(original));
    expect(h.run.modelId).toBe("first-model"); expect(h.run.knowledgeReleaseId).toBe("release-original");
    expect(h.tx.prototypeRevision.upsert.mock.calls.at(-1)?.[0]).toMatchObject({ update: {} });
  });
  it.each(["approved", "generating", "ready"])("fails closed for an unbound %s plan without inventing inputs", async status => {
    const h = harness(); h.plan.runtimeRunId = null; h.plan.status = status;
    await expect(preparePrototypeRuntime(h.db as never, input)).rejects.toThrow("PROTOTYPE_PREPARED_RUN_REQUIRED");
    expect(h.tx.run.create).not.toHaveBeenCalled(); expect(h.tx.thread.create).not.toHaveBeenCalled();
    expect(h.tx.knowledgeRelease.findFirst).not.toHaveBeenCalled();
  });
  it.each(["cancelled", "failed", "draft"])("cannot resurrect a %s plan", async status => {
    const h = harness(); h.plan.status = status;
    await expect(preparePrototypeRuntime(h.db as never, input)).rejects.toThrow("PROTOTYPE_PLAN_NOT_ACTIVE");
    expect(h.tx.prototypeRevision.upsert).not.toHaveBeenCalled();
  });
  it("rejects an unconfirmed stored Run before creating a revision",async()=>{const h=harness();delete h.run.request.requirementConfirmationId;await expect(preparePrototypeRuntime(h.db as never,input)).rejects.toThrow("REQUIREMENT_CONFIRMATION_REQUIRED");expect(h.tx.prototypeRevision.upsert).not.toHaveBeenCalled();});
  it("rechecks editor access before starting generation", async () => {
    const h = harness(); h.tx.projectMember.findFirst.mockResolvedValue(null as never);
    await expect(preparePrototypeRuntime(h.db as never, input)).rejects.toThrow("PROTOTYPE_PROJECT_ACCESS_REVOKED");
    expect(h.tx.prototypeRevision.upsert).not.toHaveBeenCalled();
  });
  it("rejects a mismatched persisted Run instead of using another project's context", async () => {
    const h = harness(); h.run.projectId = "other-project";
    await expect(preparePrototypeRuntime(h.db as never, input)).rejects.toThrow("PROTOTYPE_PREPARED_RUN_SCOPE_INVALID");
    expect(h.tx.prototypeRevision.upsert).not.toHaveBeenCalled();
  });
});

describe("Prototype Runtime bridge execution", () => {
  it("refuses an unconfirmed Run even when resuming past preparation",async()=>{const h=harness();delete h.run.request.requirementConfirmationId;const execute=vi.fn();const bridge=new PrototypeRuntimeBridge(h.db as never,runtime(),{issue:vi.fn()},factory(execute));await expect(bridge.generate(input,new AbortController().signal,vi.fn())).rejects.toThrow("REQUIREMENT_CONFIRMATION_REQUIRED");expect(execute).not.toHaveBeenCalled();expect(h.tx.artifactVersion.findMany).not.toHaveBeenCalled();});
  it("projects only the successful run's ready artifact during recovery", async () => {
    const h = harness(); h.plan.runtimeRunId = "run-1"; h.run.status = "succeeded";
    const provider = runtime(); const execute = vi.fn(async () => ({ runId: "run-1", artifactCount: 1 }));
    const bridge = new PrototypeRuntimeBridge(h.db as never, provider, { issue: vi.fn() }, factory(execute));
    const result = await bridge.generate(input, new AbortController().signal, vi.fn());
    expect(result.sourceArtifactVersionId).toBe("fixed-generated-prototype"); expect(result.pages.map(page => page.route)).toEqual(["/a", "/b"]); expect(result.title).toBe("Generated signup");
    expect(h.tx.artifactVersion.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { createdByRunId: "run-1", projectId: input.projectId, status: "ready", artifact: { kind: "prototype" } } }));
    expect(provider.execute).not.toHaveBeenCalled();
  });
  it.each(["running", "waiting_input", "failed", "cancelled"])("does not turn a %s outcome into a successful projection", async status => {
    const h = harness(); h.plan.runtimeRunId = "run-1"; h.run.status = status;
    const bridge = new PrototypeRuntimeBridge(h.db as never, runtime(), { issue: vi.fn() }, factory(vi.fn(async () => ({ runId: "run-1", skipped: true }))));
    await expect(bridge.generate(input, new AbortController().signal, vi.fn())).rejects.toThrow(`PROTOTYPE_RUNTIME_${status.toUpperCase()}`);
    expect(h.tx.artifactVersion.findMany).not.toHaveBeenCalled();
  });
  it("heartbeats stream events only after the durable observer accepts them", async () => {
    const h = harness(); h.plan.runtimeRunId = "run-1";
    const provider = runtime(); const durable = deferred(); const called = deferred(); const heartbeat = vi.fn();
    const observer = { onSubmissionStarted: vi.fn(async () => undefined), onExternalRunCreated: vi.fn(async () => undefined), isExternalEventProcessed: vi.fn(async () => false), onExternalEvent: vi.fn(() => { called.resolve(); return durable.promise; }), onExternalFinalization: vi.fn(async () => undefined) };
    vi.mocked(provider.execute).mockImplementation(async (_request, observed) => {
      await observed.onExternalEvent({ externalRunId: "external-1", externalEventId: "event-1", event: "values", payload: {} }, []);
      h.run.status = "succeeded";
      return { protocol: "workbench.runtime.result.v1", message: "done", artifacts: [] };
    });
    const processorFactory = (observed: RuntimePort) => ({ execute: () => observed.execute({ request: h.run.request } as never, observer), cancel: vi.fn() } as unknown as RunProcessor);
    const bridge = new PrototypeRuntimeBridge(h.db as never, provider, { issue: vi.fn() }, processorFactory);
    const operation = bridge.generate(input, new AbortController().signal, heartbeat);
    await called.promise; expect(heartbeat).not.toHaveBeenCalledWith("deerflow:stream");
    durable.resolve(); await operation; expect(heartbeat).toHaveBeenCalledWith("deerflow:stream");
  });
  it("waits for provider cancellation acknowledgement and durable cancelled state", async () => {
    const h = harness(); h.plan.runtimeRunId = "run-1"; h.run.status = "running";
    const started = deferred(); const cancelRequested = deferred(); const providerAck = deferred(); const controller = new AbortController();
    const cancel = vi.fn(async () => { cancelRequested.resolve(); await providerAck.promise; h.run.status = "cancelled"; return { runId: "run-1", cancelled: true }; });
    const execute = vi.fn(async (_run: string, _approvals: string[], signal: AbortSignal) => { started.resolve(); return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); });
    const bridge = new PrototypeRuntimeBridge(h.db as never, runtime(), { issue: vi.fn() }, factory(execute, cancel));
    let finished = false; const operation = bridge.generate(input, controller.signal, vi.fn()).finally(() => { finished = true; });
    const assertion = expect(operation).rejects.toMatchObject({ name: "AbortError" });
    await started.promise; controller.abort(); await cancelRequested.promise;
    expect(h.run.status).toBe("cancelling"); expect(finished).toBe(false); expect(cancel).toHaveBeenCalledWith("run-1");
    providerAck.resolve(); await assertion; expect(h.run.status).toBe("cancelled"); expect(h.tx.artifactVersion.findMany).not.toHaveBeenCalled();
  });
  it("keeps a failed run with unconfirmed provider cancellation pending until convergence", async () => {
    const h = harness(); h.plan.runtimeRunId = "run-1"; h.run.status = "failed";
    h.run.errorCode = "RUNTIME_PROVIDER_CANCELLATION_UNCONFIRMED";
    h.tx.run.updateMany.mockResolvedValue({ count: 0 });
    const cancel = vi.fn(async () => ({ runId: "run-1", cancelled: false, cancellationPending: true }));
    const bridge = new PrototypeRuntimeBridge(h.db as never, runtime(), { issue: vi.fn() }, factory(vi.fn(), cancel));
    await expect(bridge.cancelPlan(input.planId)).rejects.toThrow("PROTOTYPE_RUNTIME_CANCELLATION_PENDING");
    expect(h.run.status).toBe("failed");
  });
  it("does not claim cancellation succeeded while durable state is still cancelling", async () => {
    const h = harness(); h.plan.runtimeRunId = "run-1"; h.run.status = "running";
    const bridge = new PrototypeRuntimeBridge(h.db as never, runtime(), { issue: vi.fn() }, factory(vi.fn(), vi.fn(async () => ({ runId: "run-1", cancelled: false }))));
    await expect(bridge.cancelPlan(input.planId)).rejects.toThrow("PROTOTYPE_RUNTIME_CANCELLATION_PENDING");
    expect(h.run.status).toBe("cancelling");
  });
});
