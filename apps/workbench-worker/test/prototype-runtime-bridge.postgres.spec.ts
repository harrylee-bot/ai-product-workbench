import { fileURLToPath } from "node:url";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { createTemporalSdkActivities } from "../src/prototypes/temporal-sdk-activities.js";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { knowledgeToolResponseSchema, startRunRequestSchema, type RuntimeArtifactDraft } from "@workbench/workbench-contracts";
import { Prisma, PrismaClient } from "@workbench/workbench-db";
import { canonicalSha256, verifyKnowledgeToolGrant } from "@workbench/workbench-knowledge";
import { KnowledgeToolLedgerService } from "../../workbench-api/src/modules/knowledge/knowledge-tool-ledger.service.js";
import { workerRequirementFlow } from "./confirmed-run.fixture.js";
import { prototypeDocumentFixture, prototypeFrameNodeFixture } from "../../../packages/workbench-contracts/test/prototype-fixture.js";
import { seedReadyKnowledge } from "../../../scripts/test-support/knowledge-fixture.mjs";
import { preparePrototypeRuntime, PrototypeRuntimeBridge } from "../src/prototypes/prototype-runtime-bridge.js";
import { pinGeneratedPrototypeDraft, readPrototypeDraft, recordPrototypeBuild, commitPrototypeDraft } from "../src/prototypes/prototype-draft.js";
import { prototypeScreenProjectionChecksum } from "../src/runs/prototype-patch-applier.js";
import { RunEventStore } from "../src/runs/run-event.store.js";
import { RuntimeExecutionReconciler } from "../src/runs/runtime-execution-reconciler.js";
import { PrismaKnowledgeToolGrantIssuer } from "../src/runtime/knowledge-tool-grant.service.js";
import { PrismaCanvasToolGrantIssuer } from "../src/runtime/canvas-tool-grant.service.js";
import type { RuntimeExecution, RuntimeExecutionObserver, RuntimePort } from "../src/runtime/runtime.port.js";

// Deliberately has no general DATABASE_URL fallback: these fixtures belong in a
// disposable PostgreSQL database, with every migration and extension installed.
// Only the provider transport and retrieval scores are synthetic. RunProcessor,
// grant signing, retrieval ledger, publication, and PostgreSQL guards are real.
const databaseUrl = process.env.WORKBENCH_PROTOTYPE_BRIDGE_TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const secret = Buffer.alloc(32, 31);

describeWithPostgres("Prototype runtime bridge PostgreSQL integration", () => {
  let db: PrismaClient;
  let issuer: PrismaKnowledgeToolGrantIssuer;
  let knowledgeReleaseId: string;
  const fixtures: Fixture[] = [];
  const historicalBlobIds: string[] = [];

  beforeAll(async () => {
    db = new PrismaClient({ datasourceUrl: databaseUrl! });
    issuer = new PrismaKnowledgeToolGrantIssuer(db, {
      endpoint: "https://workbench.test/api/v1/runtime/knowledge/retrieve",
      secret,
      maximumTtlSeconds: 3_600,
    });
    // The builder creates append-only profile adoption evidence. Keep this
    // shared test release in the disposable database, as the other PG specs do.
    knowledgeReleaseId = await db.$transaction((tx) => seedReadyKnowledge(tx), { timeout: 60_000 });
  }, 90_000);

  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) {
      await db.knowledgeToolBudget.deleteMany({ where: { runtimeAttempt: { run: { projectId: fixture.projectId } } } });
      await db.requirementConfirmation.deleteMany({ where: { projectId: fixture.projectId } });
      await db.threadEntry.deleteMany({ where: { requirementSession: { projectId: fixture.projectId } } });
      await db.requirementSession.deleteMany({ where: { projectId: fixture.projectId } });
      await db.prototypePlan.deleteMany({ where: { projectId: fixture.projectId } });
      await db.workspace.delete({ where: { id: fixture.workspaceId } });
      await db.principal.delete({ where: { id: fixture.principalId } });
    }
    if (historicalBlobIds.length) await db.blob.deleteMany({ where: { id: { in: historicalBlobIds.splice(0) } } });
  });

  afterAll(async () => { await db?.$disconnect(); });

  async function fixture(bindRun = true) {
    const result = await seedFixture(db, bindRun);
    fixtures.push(result);
    return result;
  }

  async function historicalFixture(failure?: "foreign-version" | "missing-screen" | "checksum", capturedScreenCount = 1) {
    const ids = await fixture(false);
    const sourceIds = failure === "foreign-version" ? await fixture(false) : ids;
    const suffix = randomUUID();
    const board = await db.board.findUniqueOrThrow({ where: { projectId: ids.projectId } });
    const bytes = Buffer.from(`historical canvas image ${suffix}`);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const blob = await db.blob.create({ data: { sha256: digest, storageKey: `test/historical-canvas/${suffix}`, mediaType: "image/png", byteSize: BigInt(bytes.length), status: "ready", verifiedAt: new Date() } });
    historicalBlobIds.push(blob.id);
    const document = prototypeDocumentFixture();
    for (let index = document.screens.length; index < capturedScreenCount; index += 1) {
      const screenId = `historical-screen-${index}`, rootId = `historical-root-${index}`;
      document.screens.push({ id: screenId, name: `Historical ${index}`, route: `/historical-${index}`, rootNodeId: rootId, initialStateId: null, viewport: { width: 390, height: 844 } });
      document.nodes.push(prototypeFrameNodeFixture(rootId, screenId, null, []));
    }
    const asset = { id: "historical-image", kind: "image" as const, name: "Historical image", blobId: blob.id, mediaType: "image/png" as const, byteSize: bytes.length, sha256: digest, width: 1, height: 1 };
    document.assets.push(asset);
    const node = document.nodes.find(item => item.id === "node-a")!;
    if (node.kind !== "text") throw new Error("fixture text missing");
    const { text: _text, maxLines: _maxLines, ...base } = node;
    document.nodes.push({ ...base, id: "historical-image-node", kind: "image", assetId: asset.id, fit: "contain", alt: "Historical image" });
    const root = document.nodes.find(item => item.id === "node-root-a")!;
    if (root.kind !== "frame") throw new Error("fixture root missing");
    root.childIds.push("historical-image-node");
    const artifact = await db.artifact.create({ data: { projectId: sourceIds.projectId, kind: "prototype", title: "Fixed historical prototype" } });
    const version = await db.artifactVersion.create({ data: { projectId: sourceIds.projectId, artifactId: artifact.id, version: 1, schemaVersion: 1, status: "staging", content: document as Prisma.InputJsonValue, checksum: failure === "checksum" ? "b".repeat(64) : canonicalSha256(document), citations: [] } });
    await db.artifactVersionAsset.create({ data: { projectId: sourceIds.projectId, artifactId: artifact.id, artifactVersionId: version.id, assetId: asset.id, kind: asset.kind, blobId: blob.id, mediaType: asset.mediaType, byteSize: BigInt(asset.byteSize), sha256: asset.sha256, metadata: asset } });
    await db.artifactVersion.update({ where: { id: version.id }, data: { status: "ready" } });
    await db.artifact.update({ where: { id: artifact.id }, data: { currentVersionId: version.id } });
    const thread = await db.thread.create({ data: { projectId: ids.projectId, createdById: ids.principalId, title: "Delayed initial Canvas", entrySequence: 1, revision: 1 } });
    const screen = document.screens[0]!;
    const reference = { boardNodeId: `historical-node-${suffix}`, artifactId: artifact.id, artifactVersionId: version.id, screenId: failure === "missing-screen" ? "missing-screen" : screen.id };
    const captured = document.screens.slice(0, capturedScreenCount).map((item, index) => ({ reference: index === 0 ? reference : { ...reference, boardNodeId: `${reference.boardNodeId}-${index}`, screenId: item.id }, name: item.name, route: item.route, phase: "complete" as const, viewport: item.viewport }));
    const request = startRunRequestSchema.parse({ prompt: "Use the fixed historical Canvas as reference", modelId: "quality", workflow: "generate", generationIntent: null, targetSurface: "web", designStyle: { kind: "automatic" }, sourceIds: [], artifactTargets: [], requestedArtifactKinds: ["prototype"],
      canvasSnapshot: { protocol: "workbench.canvas-snapshot.v1", projectId: ids.projectId, threadId: thread.id, runId: null, boardId: board.id, clientSessionId: `historical-session-${suffix}`, projectSessionGeneration: 1, boardRevision: board.revision, canvasStateRevision: 0,
        capturedAt: "2020-01-01T00:00:00.000Z", expiresAt: "2020-01-01T00:01:00.000Z", viewport: { x: 1, y: 2, zoom: 1 }, screens: captured, visibleScreens: [reference], selectedScreens: [reference] } });
    const planId = `historical-plan-${suffix}`;
    const run = await db.run.create({ data: { projectId: ids.projectId, threadId: thread.id, createdById: ids.principalId, knowledgeReleaseId, idempotencyKey: `prototype:${planId}`, requestHash: canonicalSha256(request), request: request as Prisma.InputJsonValue, requestId: randomUUID(), traceId: randomUUID(), status: "queued", modelId: request.modelId } });
    await db.threadEntry.create({ data: { threadId: thread.id, sequence: 1, role: "user", kind: "message", content: { protocol: "workbench.entry.v1", type: "user.prompt", text: request.prompt, sourceIds: [] } } });
    await new RunEventStore().append(db, run.id, "run.queued", { position: null });
    await db.prototypePlan.create({ data: { id: planId, projectId: ids.projectId, createdById: ids.principalId, title: "Delayed initial Canvas", prompt: request.prompt, generationRequest: request as Prisma.InputJsonValue, runtimeRunId: run.id, status: "approved", idempotencyKey: suffix, requestHash: canonicalSha256(request) } });
    await db.board.update({ where: { id: board.id }, data: { revision: { increment: 1 } } });
    return { ...ids, planId, request, runId: run.id, version, artifact, asset };
  }


  // Existing records can be inspected. A pre-confirmation request cannot pass
  // generation, even if its Plan and Run are already bound in the database.
  function historicalProjection(ids: Awaited<ReturnType<typeof historicalFixture>>) {
    const runtime = fakeRuntime(async () => { throw Error("PROVIDER_MUST_NOT_EXECUTE"); });
    const bridge = new PrototypeRuntimeBridge(db, runtime, issuer);
    const input = { projectId: ids.projectId, threadId: ids.request.canvasSnapshot!.threadId, request: ids.request };
    return bridge["loadHistoricalCanvas"](input as RuntimeExecution, ids.principalId);
  }

  it.each([1, 20])("reads %s archived Canvas screens and pinned images without restarting the old Run", async capturedScreenCount => {
    const ids = await historicalFixture(undefined, capturedScreenCount);
    const { prototypes } = workerRequirementFlow(db, ids.principalId, ids.projectId);
    const archived = await prototypes.getPlanInput({ id: ids.principalId } as never, ids.projectId, ids.planId);
    expect(archived.request).toEqual(ids.request);
    expect(Date.parse(archived.request.canvasSnapshot!.expiresAt)).toBeLessThan(Date.now());
    const artifacts = await historicalProjection(ids);
    expect(artifacts).toHaveLength(Math.ceil(capturedScreenCount / 12));
    expect(artifacts.flatMap(source => source.screenIds)).toEqual(ids.request.canvasSnapshot!.screens.map(item => item.reference.screenId));
    expect(artifacts.every(source => source.screenIds.length <= 12)).toBe(true);
    const source = artifacts[0]!;
    expect(source).toMatchObject({ artifactId: ids.artifact.id, artifactVersionId: ids.version.id, checksum: ids.version.checksum, content: { mode: "inline" } });
    if (source.content.mode !== "inline") throw Error("expected inline source");
    const projection = source.content.value as { screens: Array<{ id: string }>; nodes: Array<{ id: string }> };
    expect(projection.screens.map(screen => screen.id)).toEqual(source.screenIds);
    expect(projection.nodes.some(node => node.id === "historical-image-node")).toBe(true);
    if (capturedScreenCount === 1) expect(projection.nodes.some(node => node.id === "node-b")).toBe(false);
    expect(source.assets).toMatchObject([{ assetId: ids.asset.id, sha256: ids.asset.sha256, metadata: ids.asset }]);
    await expect(preparePrototypeRuntime(db, ids)).rejects.toThrow("REQUIREMENT_CONFIRMATION_REQUIRED");
    expect(await db.runtimeAttempt.count({ where: { runId: ids.runId } })).toBe(0);
    expect(await db.canvasAgentSession.count({ where: { runId: ids.runId } })).toBe(0);
    expect(await db.canvasToolGrant.count({ where: { agentSession: { runId: ids.runId } } })).toBe(0);
  }, 90_000);

  it.each(["foreign-version", "missing-screen", "checksum", "access-revoked"] as const)("rejects %s while resolving fixed historical Canvas references", async failure => {
    const ids = await historicalFixture(failure === "access-revoked" ? undefined : failure);
    if (failure === "access-revoked") await db.principal.update({ where: { id: ids.principalId }, data: { status: "disabled" } });
    const code = { "foreign-version": "PROTOTYPE_CANVAS_REFERENCE_INVALID", "missing-screen": "RUNTIME_ARTIFACT_TARGET_SCREEN_INVALID", checksum: "RUNTIME_ARTIFACT_TARGET_CHECKSUM_INVALID", "access-revoked": "PROTOTYPE_CANVAS_REFERENCE_ACCESS_REVOKED" }[failure];
    await expect(historicalProjection(ids)).rejects.toThrow(code);
    expect(await db.runtimeAttempt.count({ where: { runId: ids.runId } })).toBe(0);
  }, 90_000);

  it("pins one Run and release across concurrent preparation and activity replay", async () => {
    const ids = await fixture();
    const seeded = await db.prototypePlan.findUniqueOrThrow({ where: { id: ids.planId } });
    const preparedRun = await db.run.findUniqueOrThrow({ where: { id: seeded.runtimeRunId! } });
    const entriesBeforeReplay = await db.threadEntry.count({ where: { threadId: preparedRun.threadId } });
    const inputs = await Promise.all(Array.from({ length: 4 }, () => preparePrototypeRuntime(db, ids)));
    expect(inputs.every((input) => JSON.stringify(input) === JSON.stringify(inputs[0]))).toBe(true);
    const plan = await db.prototypePlan.findUniqueOrThrow({ where: { id: ids.planId } });
    const run = await db.run.findUniqueOrThrow({ where: { id: plan.runtimeRunId! } });
    await db.$transaction((tx) => seedReadyKnowledge(tx), { timeout: 60_000 });
    await db.prototypeRevision.update({ where: { id: inputs[0]!.revisionId }, data: { status: "ready" } });
    await expect(preparePrototypeRuntime(db, ids)).resolves.toEqual(inputs[0]);
    await expect(db.run.findUniqueOrThrow({ where: { id: run.id } })).resolves.toMatchObject({
      id: preparedRun.id, modelId: "quality", knowledgeReleaseId: preparedRun.knowledgeReleaseId, requestHash: preparedRun.requestHash, request: preparedRun.request, status: "queued",
    });
    await expect(db.run.count({ where: { projectId: ids.projectId } })).resolves.toBe(1);
    await expect(db.thread.count({ where: { projectId: ids.projectId } })).resolves.toBe(1);
    await expect(db.threadEntry.count({ where: { threadId: run.threadId } })).resolves.toBe(entriesBeforeReplay);
    await expect(db.prototypeRevision.findUniqueOrThrow({ where: { id: inputs[0]!.revisionId } })).resolves.toMatchObject({ status: "ready" });
    await expect(db.prototypePlan.update({ where: { id: ids.planId }, data: { runtimeRunId: null } })).rejects.toThrow("PROTOTYPE_RUNTIME_RUN_IMMUTABLE");
    expect(JSON.stringify(inputs[0])).not.toContain("wbkg1.");
  }, 90_000);

  it("rejects an unbound approved plan without synthesizing a Run or request", async () => {
    const ids = await fixture(false);
    await expect(preparePrototypeRuntime(db, ids)).rejects.toThrow("PROTOTYPE_PREPARED_RUN_REQUIRED");
    expect(await db.run.count({ where: { projectId: ids.projectId } })).toBe(0);
    expect(await db.thread.count({ where: { projectId: ids.projectId } })).toBe(0);
    expect(await db.prototypeRevision.count({ where: { projectId: ids.projectId } })).toBe(0);
  });

  it.each(["transport failure", "activity heartbeat timeout"])("publishes retrieved citations and resumes the same provider attempt after %s", async (interruption) => {
    const ids = await fixture();
    const input = await preparePrototypeRuntime(db, ids);
    const executions: RuntimeExecution[] = [];
    const controller = new AbortController();
    let citation: Awaited<ReturnType<typeof retrieve>>["items"][number]["citation"];
    const runtime = fakeRuntime(async (execution, observer) => {
      executions.push(execution);
      if (executions.length === 1) {
        expect(execution.submission.mode).toBe("submit");
        expect(execution.knowledgeTool).not.toBeNull();
        await observer.onSubmissionStarted();
        await observer.onExternalRunCreated(`external-${execution.runId}`);
        const response = await retrieve(db, execution);
        citation = response.items[0]!.citation;
        if (interruption === "activity heartbeat timeout") {
          controller.abort(new Error("SIMULATED_ACTIVITY_HEARTBEAT_TIMEOUT"));
          throw controller.signal.reason;
        }
        throw new Error("SIMULATED_TRANSPORT_DISCONNECT");
      }
      expect(execution.submission.mode).toBe("join");
      expect(execution.knowledgeTool).toBeNull();
      return publishPrototype(execution, observer, [citation!]);
    });
    const bridge = new PrototypeRuntimeBridge(db, runtime, issuer);
    const code = interruption === "activity heartbeat timeout" ? "SIMULATED_ACTIVITY_HEARTBEAT_TIMEOUT" : "SIMULATED_TRANSPORT_DISCONNECT";
    await expect(bridge.generate(input, controller.signal, vi.fn(), { retryCount: 0, retryLimit: 1 })).rejects.toThrow(code);
    const first = executions[0]!;
    await expect(db.run.findUniqueOrThrow({ where: { id: first.runId } })).resolves.toMatchObject({ status: "running", attempt: 1 });
    await expect(db.runtimeAttempt.findUniqueOrThrow({ where: { id: first.runtimeAttemptId } })).resolves.toMatchObject({
      status: "running", externalRunId: `external-${first.runId}`, executionOwnerId: null,
    });
    expect(runtime.cancel).not.toHaveBeenCalled();
    await expect(db.runEvent.count({ where: { runId: first.runId, type: "run.cancel.requested" } })).resolves.toBe(0);
    await expect(db.prototypeWorkflowCommand.count({ where: { targetId: ids.planId, kind: "plan_cancel" } })).resolves.toBe(0);
    const heartbeat = vi.fn();
    const result = await bridge.generate(input, new AbortController().signal, heartbeat, { retryCount: 1, retryLimit: 1 });
    expect(result.pages.map((page) => page.route)).toEqual(["/a", "/b"]);
    expect(result.pages[0]!.content).toContain('data-wb-screen="screen-a"');
    expect(heartbeat).toHaveBeenCalledWith("deerflow:complete");
    expect(executions.map((execution) => [execution.runId, execution.runtimeAttemptId, execution.submission.providerIdempotencyKey])).toEqual([
      [first.runId, first.runtimeAttemptId, first.submission.providerIdempotencyKey],
      [first.runId, first.runtimeAttemptId, first.submission.providerIdempotencyKey],
    ]);
    await expect(db.runtimeAttempt.count({ where: { runId: first.runId } })).resolves.toBe(1);
    await expect(db.knowledgeToolGrant.count({ where: { runId: first.runId } })).resolves.toBe(1);
    const receipt = await db.knowledgeRetrievalInvocation.findFirstOrThrow({ where: { runtimeAttemptId: first.runtimeAttemptId } });
    expect(receipt).toMatchObject({ status: "succeeded", attemptCount: 1, responseSha256: canonicalSha256(knowledgeToolResponseSchema.parse(receipt.response)) });
    const artifact = await db.artifactVersion.findFirstOrThrow({ where: { createdByRunId: first.runId, status: "ready" } });
    expect(artifact.citations).toEqual([citation!]);
    await expect(db.knowledgeToolBudget.findUniqueOrThrow({ where: { runtimeAttemptId: first.runtimeAttemptId } })).resolves.toMatchObject({ totalStarts: 1 });
    await db.principal.update({ where: { id: ids.principalId }, data: { status: "disabled" } });
    await expect(preparePrototypeRuntime(db, ids)).rejects.toThrow("PROTOTYPE_PROJECT_ACCESS_REVOKED");
    // An already prepared activity replay reads the published result.
    await expect(bridge.generate(input, new AbortController().signal, vi.fn())).resolves.toEqual(result);
    expect(runtime.execute).toHaveBeenCalledTimes(2);
    expect(runtime.createThread).toHaveBeenCalledTimes(1);
    await bridge.cancelPlan(ids.planId);
    await expect(db.run.findUniqueOrThrow({ where: { id: first.runId } })).resolves.toMatchObject({ status: "succeeded" });
    await expect(db.runEvent.count({ where: { runId: first.runId, type: "run.cancel.requested" } })).resolves.toBe(0);
    const events = await db.runEvent.findMany({ where: { runId: first.runId } });
    expect(JSON.stringify({ result, events, receipt, artifact })).not.toContain(first.knowledgeTool!.token);
  }, 90_000);

  it.each(["missing receipt", "altered citation"] as const)("rejects artifact publication with %s", async (failure) => {
    const ids = await fixture();
    const input = await preparePrototypeRuntime(db, ids);
    const runtime = fakeRuntime(async (execution, observer) => {
      await observer.onSubmissionStarted();
      await observer.onExternalRunCreated(`external-${execution.runId}`);
      const response = await retrievalResponse(db, execution);
      if (failure === "altered citation") await retrieve(db, execution);
      const citation = { ...response.items[0]!.citation, ...(failure === "altered citation" ? { quote: "Invented source text" } : {}) };
      return publishPrototype(execution, observer, [citation]);
    });
    const bridge = new PrototypeRuntimeBridge(db, runtime, issuer);
    await expect(bridge.generate(input, new AbortController().signal, vi.fn())).rejects.toThrow(
      failure === "missing receipt" ? "KNOWLEDGE_RETRIEVAL_REQUIRED" : "KNOWLEDGE_CITATION_CURRENT_REQUIRED",
    );
    const plan = await db.prototypePlan.findUniqueOrThrow({ where: { id: ids.planId } });
    await expect(db.run.findUniqueOrThrow({ where: { id: plan.runtimeRunId! } })).resolves.toMatchObject({ status: "failed" });
    await expect(db.artifactVersion.count({ where: { projectId: ids.projectId, status: "ready" } })).resolves.toBe(0);
  }, 90_000);

  it.each(["failed", "cancelled"] as const)("retries a %s confirmed provider Run with the original request and no live Canvas capability", async terminalStatus => {
    const ids = await fixture();
    const sourcePlanId = ids.planId;
    const sourcePlan = await db.prototypePlan.findUniqueOrThrow({ where: { id: sourcePlanId } });
    const sourceRunId = sourcePlan.runtimeRunId!;
    const request = startRunRequestSchema.parse(sourcePlan.generationRequest);
    const { prototypes } = workerRequirementFlow(db, ids.principalId, ids.projectId);
    expect(request.requirementConfirmationId).toBeTruthy();
    const sourceInput = await preparePrototypeRuntime(db, { projectId: ids.projectId, planId: sourcePlanId });
    const controller = new AbortController();
    const sourceRuntime = fakeRuntime(async (execution, observer) => {
      await observer.onSubmissionStarted();
      await observer.onExternalRunCreated(`external-${execution.runId}`);
      if (terminalStatus === "cancelled") {
        await requestPrototypeStop(db, ids);
        controller.abort(new DOMException("Original generation cancelled", "AbortError"));
        throw controller.signal.reason;
      }
      throw new Error("ORIGINAL_PROVIDER_FAILED");
    });
    sourceRuntime.cancel.mockImplementation(async (scope) => ({ disposition: "cancelled", externalRunId: scope.externalRunId!, externalStatus: "interrupted" }));
    await expect(new PrototypeRuntimeBridge(db, sourceRuntime, issuer).generate(sourceInput, controller.signal, vi.fn())).rejects.toThrow();
    expect(await db.run.findUniqueOrThrow({ where: { id: sourceRunId } })).toMatchObject({ status: terminalStatus });
    expect(await db.runtimeAttempt.findFirstOrThrow({ where: { runId: sourceRunId } })).toMatchObject({ status: terminalStatus, externalRunId: `external-${sourceRunId}` });
    const stopped = await db.prototypePlan.update({ where: { id: sourcePlanId }, data: { status: terminalStatus } });
    await db.board.update({ where: { projectId: ids.projectId }, data: { revision: { increment: 1 } } });
    const retry = await prototypes.retryPlan({ id: ids.principalId } as never, ids.projectId, sourcePlanId, randomUUID(), '"' + stopped.revision + '"', {});
    const retryPlanId = retry.id;
    const retryRunId = (await db.prototypePlan.findUniqueOrThrow({ where: { id: retryPlanId } })).runtimeRunId!;
    expect(retryRunId).not.toBe(sourceRunId);
    const issueLiveCanvas = vi.spyOn(PrismaCanvasToolGrantIssuer.prototype, "issue");
    const executions: RuntimeExecution[] = [];
    const runtime = fakeRuntime(async (execution, observer) => {
      executions.push(execution);
      expect(execution.request).toEqual(request);
      expect(execution.canvasTool).toBeNull();
      expect(execution.historicalCanvasSnapshot ?? null).toBeNull();
      await observer.onSubmissionStarted();
      await observer.onExternalRunCreated(`external-${execution.runId}`);
      const response = await retrieve(db, execution);
      return publishPrototype(execution, observer, response.items.map(item => item.citation));
    });
    const input = await preparePrototypeRuntime(db, { projectId: ids.projectId, planId: retryPlanId });
    const bridge = new PrototypeRuntimeBridge(db, runtime, issuer);
    const generated = await bridge.generate(input, new AbortController().signal, vi.fn());
    expect(generated.pages.map(page => page.route)).toEqual(["/a", "/b"]);
    expect(issueLiveCanvas).not.toHaveBeenCalled();
    expect(await db.canvasAgentSession.count({ where: { runId: retryRunId } })).toBe(0);
    expect(await db.canvasToolGrant.count({ where: { agentSession: { runId: retryRunId } } })).toBe(0);
    expect(await db.run.findUniqueOrThrow({ where: { id: retryRunId } })).toMatchObject({ status: "succeeded", request });
    const receipt = await db.knowledgeRetrievalInvocation.findFirstOrThrow({ where: { runtimeAttemptId: executions[0]!.runtimeAttemptId } });
    expect(receipt.status).toBe("succeeded");
    expect(receipt.responseSha256).toBe(canonicalSha256(knowledgeToolResponseSchema.parse(receipt.response)));
    const artifact = await db.artifactVersion.findFirstOrThrow({ where: { createdByRunId: retryRunId, status: "ready" } });
    expect(artifact.citations).toEqual(knowledgeToolResponseSchema.parse(receipt.response).items.map(item => item.citation));
    await expect(bridge.generate(input, new AbortController().signal, vi.fn())).resolves.toEqual(generated);
    expect(runtime.execute).toHaveBeenCalledTimes(1);
    issueLiveCanvas.mockRestore();
  }, 90_000);

  it("cancels a queued plan exactly once without opening a provider thread", async () => {
    const ids = await fixture();
    await preparePrototypeRuntime(db, ids);
    const runtime = fakeRuntime(async () => { throw new Error("UNEXPECTED_PROVIDER_EXECUTION"); });
    const bridge = new PrototypeRuntimeBridge(db, runtime, issuer);
    await requestPrototypeStop(db, ids);
    await bridge.cancelPlan(ids.planId);
    await bridge.cancelPlan(ids.planId);
    const plan = await db.prototypePlan.findUniqueOrThrow({ where: { id: ids.planId } });
    await expect(db.run.findUniqueOrThrow({ where: { id: plan.runtimeRunId! } })).resolves.toMatchObject({ status: "cancelled", attempt: 0 });
    await expect(db.runEvent.count({ where: { runId: plan.runtimeRunId!, type: "run.cancel.requested" } })).resolves.toBe(1);
    expect(runtime.createThread).not.toHaveBeenCalled();
    expect(runtime.cancel).not.toHaveBeenCalled();
  });

  it("fails an exhausted activity and reconciles the same provider without recording a user stop", async () => {
    const ids = await fixture();
    const input = await preparePrototypeRuntime(db, ids);
    const controller = new AbortController();
    const runtime = fakeRuntime(async (execution, observer) => {
      await observer.onSubmissionStarted();
      await observer.onExternalRunCreated(`external-${execution.runId}`);
      controller.abort(new Error("SIMULATED_ACTIVITY_HEARTBEAT_TIMEOUT"));
      throw controller.signal.reason;
    });
    runtime.cancel.mockImplementation(async scope => ({
      disposition: "cancelled", externalRunId: scope.externalRunId!, externalStatus: "interrupted",
    }));
    const bridge = new PrototypeRuntimeBridge(db, runtime, issuer);
    await expect(bridge.generate(input, controller.signal, vi.fn(), { retryCount: 2, retryLimit: 2 })).rejects.toThrow("SIMULATED_ACTIVITY_HEARTBEAT_TIMEOUT");
    const execution = runtime.execute.mock.calls[0]![0];
    await expect(bridge.settlePlanFailure(ids.planId)).resolves.toBe("failed");
    await expect(bridge.settlePlanFailure(ids.planId)).resolves.toBe("failed");
    await expect(db.run.findUniqueOrThrow({ where: { id: execution.runId } })).resolves.toMatchObject({
      status: "failed", cancelRequestedAt: null, cancellationReason: null,
    });
    await expect(db.runtimeAttempt.findUniqueOrThrow({ where: { id: execution.runtimeAttemptId }, include: { providerCancellationResolution: true } })).resolves.toMatchObject({
      status: "failed", providerCancellationResolution: { externalRunId: `external-${execution.runId}` },
    });
    expect(runtime.cancel).toHaveBeenCalledTimes(1);
    const events = await db.runEvent.findMany({ where: { runId: execution.runId, type: { in: ["run.cancel.requested", "run.cancelled", "run.failed"] } }, select: { type: true } });
    expect(events).toEqual([{ type: "run.failed" }]);
  });

  it("lets the replacement activity wait for the previous activity's execution lease", async () => {
    const ids = await fixture();
    const input = await preparePrototypeRuntime(db, ids);
    const entered = deferred<void>();
    const controller = new AbortController();
    let citation: Awaited<ReturnType<typeof retrieve>>["items"][number]["citation"];
    const runtime = fakeRuntime(async (execution, observer, signal) => {
      if (execution.submission.mode === "join") return publishPrototype(execution, observer, [citation!]);
      expect(execution.submission.mode).toBe("submit");
      await observer.onSubmissionStarted();
      await observer.onExternalRunCreated(`external-${execution.runId}`);
      citation = (await retrieve(db, execution)).items[0]!.citation;
      return new Promise<never>((_resolve, reject) => {
        signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
        entered.resolve();
      });
    });
    const bridge = new PrototypeRuntimeBridge(db, runtime, issuer);
    const first = bridge.generate(input, controller.signal, vi.fn()).catch(error => error);
    try {
      await entered.promise;
      const replacement = bridge.generate(input, new AbortController().signal, vi.fn(), { retryCount: 1, retryLimit: 2 });
      const completed = expect(replacement).resolves.toMatchObject({ sourceArtifactVersionId: expect.any(String) });
      await delay(500);
      expect(runtime.execute).toHaveBeenCalledTimes(1);
      controller.abort(new Error("SIMULATED_ACTIVITY_HEARTBEAT_TIMEOUT"));
      expect(await first).toMatchObject({ message: "SIMULATED_ACTIVITY_HEARTBEAT_TIMEOUT" });
      await completed;
      const [initial, resumed] = runtime.execute.mock.calls.map(call => call[0]);
      expect(resumed).toMatchObject({
        runId: initial!.runId,
        runtimeAttemptId: initial!.runtimeAttemptId,
        submission: { mode: "join", externalRunId: `external-${initial!.runId}` },
      });
      expect(runtime.cancel).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      await first;
    }
  });

  it("commits cancelling before provider cleanup and awaits its acknowledgement on abort", async () => {
    const ids = await fixture();
    const input = await preparePrototypeRuntime(db, ids);
    const entered = deferred<void>();
    const cancelling = deferred<void>();
    const acknowledge = deferred<void>();
    const controller = new AbortController();
    const runtime = fakeRuntime(async (execution, observer, signal) => {
      await observer.onSubmissionStarted();
      await observer.onExternalRunCreated(`external-${execution.runId}`);
      return new Promise<never>((_resolve, reject) => {
        signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
        entered.resolve();
      });
    });
    runtime.cancel.mockImplementation(async (scope) => {
      await expect(db.run.findUniqueOrThrow({ where: { id: scope.runId } })).resolves.toMatchObject({ status: "cancelling" });
      cancelling.resolve();
      await acknowledge.promise;
      return { disposition: "cancelled", externalRunId: scope.externalRunId!, externalStatus: "interrupted" };
    });
    const bridge = new PrototypeRuntimeBridge(db, runtime, issuer);
    let settled = false;
    const generating = bridge.generate(input, controller.signal, vi.fn()).then(
      () => { settled = true; return null; },
      (error: unknown) => { settled = true; return error; },
    );
    try {
      await entered.promise;
      await requestPrototypeStop(db, ids);
      controller.abort(new DOMException("Temporal activity cancelled", "AbortError"));
      await cancelling.promise;
      expect(settled).toBe(false);
      acknowledge.resolve();
      expect(await generating).toMatchObject({ name: "AbortError" });
      const plan = await db.prototypePlan.findUniqueOrThrow({ where: { id: ids.planId } });
      await expect(db.run.findUniqueOrThrow({ where: { id: plan.runtimeRunId! } })).resolves.toMatchObject({ status: "cancelled" });
      await expect(db.runtimeAttempt.findFirstOrThrow({ where: { runId: plan.runtimeRunId! } })).resolves.toMatchObject({
        status: "cancelled", finishedAt: expect.any(Date), providerCancellationOperationEpoch: 1,
        providerCancellationOperationStartedAt: null, providerCancellationOperationDeadlineAt: null,
      });
      expect(runtime.cancel).toHaveBeenCalledTimes(1);
      await expect(db.runEvent.count({ where: { runId: plan.runtimeRunId!, type: "run.cancel.requested" } })).resolves.toBe(1);
      await expect(db.artifactVersion.count({ where: { projectId: ids.projectId, status: "ready" } })).resolves.toBe(0);
    } finally {
      acknowledge.resolve();
      controller.abort();
      await generating;
    }
  }, 90_000);

  it("pins a 50-page draft concurrently and commits only its verified compact reference", async () => {
    const ids = await fixture();
    const input = await preparePrototypeRuntime(db, ids);
    const pages = Array.from({ length: 50 }, (_, order) => {
      const content = `<p>${"x".repeat(60_000)}</p>`;
      return { id: `page-${order}`, slug: `page-${order}`, title: `Page ${order}`, route: `/page-${order}`, order, content, sha256: createHash("sha256").update(content).digest("hex") };
    });
    const references = await Promise.all(Array.from({ length: 3 }, () => pinGeneratedPrototypeDraft(db, input, { title: input.title, pages })));
    expect(references.every(ref => JSON.stringify(ref) === JSON.stringify(references[0]))).toBe(true);
    const reference = references[0]!;
    expect(reference.byteSize).toBeGreaterThan(3_000_000);
    expect(JSON.stringify(reference).length).toBeLessThan(900);
    // PostgreSQL JSONB changes object key order; canonical hashes must survive it.
    expect((await readPrototypeDraft(db, reference)).pages).toHaveLength(50);
    const pinned = await db.prototypeRevision.findUniqueOrThrow({ where: { id: input.revisionId } });
    expect(pinned.revision).toBe(2);
    await expect(pinGeneratedPrototypeDraft(db, input, { title: "different", pages })).rejects.toThrow("PROTOTYPE_DRAFT_INTEGRITY_FAILURE");
    const built = await recordPrototypeBuild(db, reference, { key: `${ids.projectId}/preview.html`, sha256: "c".repeat(64), byteSize: 3_100_000, mediaType: "text/html; charset=utf-8" });
    await Promise.all([commitPrototypeDraft(db, built), commitPrototypeDraft(db, built)]);
    expect(await db.prototypeRevision.findUniqueOrThrow({ where: { id: input.revisionId } })).toMatchObject({ status: "ready", revision: 4, documentSha256: reference.documentSha256 });
    await expect(db.prototypeRevision.update({ where: { id: input.revisionId }, data: { pages: [] } })).rejects.toThrow("immutable");
  }, 90_000);

  it.runIf(Boolean(process.env.WORKBENCH_TEMPORAL_TEST_ADDRESS))("keeps real Temporal V3 history bounded with a 50-page database draft", async () => {
    const ids = await fixture();
    const prepared = await preparePrototypeRuntime(db, ids);
    const pages = Array.from({ length: 50 }, (_, order) => {
      const content = `<p>${"h".repeat(60_000)}</p>`;
      return { id: `page-${order}`, slug: `page-${order}`, title: `Page ${order}`, route: `/page-${order}`, order, content, sha256: createHash("sha256").update(content).digest("hex") };
    });
    const address = process.env.WORKBENCH_TEMPORAL_TEST_ADDRESS!;
    const connection = await Connection.connect({ address });
    const native = await NativeConnection.connect({ address });
    const taskQueue = `prototype-payload-test-${randomUUID()}`;
    const activities = createTemporalSdkActivities({
      preparePrototypeGeneration: async () => prepared,
      generatePrototype: async () => pinGeneratedPrototypeDraft(db, prepared, { title: prepared.title, pages }),
      buildPrototype: async reference => { await readPrototypeDraft(db, reference); return recordPrototypeBuild(db, reference, { key: `${ids.projectId}/preview.html`, sha256: "c".repeat(64), byteSize: 3_100_000, mediaType: "text/html; charset=utf-8" }); },
      persistPrototypeRevision: reference => commitPrototypeDraft(db, reference),
      markPlanFailed: async () => undefined,
    } as never);
    const worker = await Worker.create({ connection: native, taskQueue, workflowsPath: fileURLToPath(new URL("../src/prototypes/temporal-sdk-workflows.ts", import.meta.url)), activities });
    try {
      const client = new Client({ connection });
      await worker.runUntil(async () => {
        const handle = await client.workflow.start("visualPrototypeGenerationV3", { taskQueue, workflowId: `prototype-payload-${randomUUID()}`, args: [{ projectId: ids.projectId, planId: ids.planId }] });
        await handle.result();
        const history = await handle.fetchHistory();
        const payloads: Uint8Array[] = [];
        const collect = (value: unknown): void => {
          if (value instanceof Uint8Array) { payloads.push(value); return; }
          if (value && typeof value === "object") for (const child of Object.values(value)) collect(child);
        };
        collect(history);
        expect(history.events!.length).toBeGreaterThan(15);
        expect(payloads.length).toBeGreaterThan(5);
        expect(Math.max(...payloads.map(data => data.byteLength))).toBeLessThan(2_000);
        expect(payloads.map(data => Buffer.from(data).toString("utf8")).join("\n")).not.toMatch(/"(?:pages|html|sourceDocument)":/u);
        expect(await db.prototypeRevision.findUniqueOrThrow({ where: { id: prepared.revisionId } })).toMatchObject({ status: "ready", revision: 4 });
      });
    } finally { await native.close(); await connection.close(); }
  }, 90_000);

  it("cannot publish a pinned draft after cancellation commits", async () => {
    const ids = await fixture();
    const input = await preparePrototypeRuntime(db, ids);
    const content = "<p>Ready</p>";
    const reference = await pinGeneratedPrototypeDraft(db, input, { title: input.title, pages: [{ id: "page-one", slug: "one", title: "One", route: "/", order: 0, content, sha256: createHash("sha256").update(content).digest("hex") }] });
    const built = await recordPrototypeBuild(db, reference, { key: `${ids.projectId}/preview.html`, sha256: "c".repeat(64), byteSize: 100, mediaType: "text/html; charset=utf-8" });
    await db.$transaction([
      db.prototypePlan.update({ where: { id: ids.planId }, data: { status: "cancelled" } }),
      db.prototypeRevision.update({ where: { id: input.revisionId }, data: { status: "cancelled" } }),
    ]);
    await expect(commitPrototypeDraft(db, built)).rejects.toThrow("PROTOTYPE_PLAN_NOT_ACTIVE");
    expect(await db.prototypeRevision.findUniqueOrThrow({ where: { id: input.revisionId } })).toMatchObject({ status: "cancelled", documentSha256: reference.documentSha256 });
  });

  it("excludes Temporal-owned Runs from both reconciler admission queries", async () => {
    const ids = await fixture();
    await preparePrototypeRuntime(db, ids);
    const plan = await db.prototypePlan.findUniqueOrThrow({ where: { id: ids.planId } });
    const temporal = await db.run.update({ where: { id: plan.runtimeRunId! }, data: { status: "running", attempt: 1, startedAt: new Date() } });
    const thread = await db.thread.create({ data: { projectId: ids.projectId, createdById: ids.principalId, title: "Ordinary runtime recovery" } });
    const ordinary = await db.run.create({ data: {
      projectId: ids.projectId, createdById: ids.principalId, threadId: thread.id,
      knowledgeReleaseId: temporal.knowledgeReleaseId, idempotencyKey: randomUUID(), requestHash: temporal.requestHash,
      request: temporal.request!, requestId: randomUUID(), traceId: randomUUID(), modelId: temporal.modelId,
      status: "running", attempt: 1, startedAt: new Date(),
    } });
    const queue = { send: vi.fn(async (_name: string, _data: { runId: string }) => randomUUID()) };
    const reconciler = new RuntimeExecutionReconciler(db, queue, 100, 60_000);
    await expect(reconciler.reconcileRun(temporal.id)).resolves.toBe(false);
    expect(queue.send).not.toHaveBeenCalled();
    await expect(reconciler.reconcileRun(ordinary.id)).resolves.toBe(true);
    queue.send.mockClear();
    await reconciler.runOnce();
    expect(queue.send.mock.calls.map((call) => call[1])).toEqual([{ runId: ordinary.id }]);
  });
});

type Fixture = { principalId: string; workspaceId: string; projectId: string; planId: string };

async function requestPrototypeStop(db: PrismaClient, ids: Fixture) {
  const plan = await db.prototypePlan.findUniqueOrThrow({ where: { id: ids.planId } });
  const { prototypes } = workerRequirementFlow(db, ids.principalId, ids.projectId);
  await prototypes.cancelPlan({ id: ids.principalId } as never, ids.projectId, ids.planId, randomUUID(), `"${plan.revision}"`, {});
  expect(await db.prototypeWorkflowCommand.count({ where: { targetId: ids.planId, kind: "plan_cancel" } })).toBe(1);
}

async function seedFixture(db: PrismaClient, bindRun: boolean): Promise<Fixture> {
  const suffix = randomUUID();
  const ids = { principalId: `bridge-principal-${suffix}`, workspaceId: `bridge-workspace-${suffix}`, projectId: `bridge-project-${suffix}`, planId: `bridge-plan-${suffix}` };
  await db.$transaction(async (tx) => {
    await tx.principal.create({ data: { id: ids.principalId, issuer: "prototype-bridge-postgres-test", subject: suffix } });
    await tx.workspace.create({ data: { id: ids.workspaceId, slug: `bridge-${suffix}`, name: "Bridge integration test", createdById: ids.principalId } });
    await tx.workspaceMember.create({ data: { workspaceId: ids.workspaceId, principalId: ids.principalId, role: "owner" } });
    await tx.project.create({ data: { id: ids.projectId, workspaceId: ids.workspaceId, createdById: ids.principalId, title: "Bridge integration test" } });
    await tx.projectMember.create({ data: { projectId: ids.projectId, workspaceId: ids.workspaceId, principalId: ids.principalId, role: "owner" } });
    await tx.board.create({ data: { projectId: ids.projectId, viewport: { x: 0, y: 0, zoom: 1 } } });
  });
  const request = startRunRequestSchema.parse({ prompt: "Build two prototype screens", modelId: "quality", workflow: "generate", targetSurface: "web", designStyle: { kind: "automatic" }, requestedArtifactKinds: ["prototype"] });
  if (bindRun) {
    const flow = workerRequirementFlow(db, ids.principalId, ids.projectId);
    const { plan } = await flow.create(request);
    ids.planId = plan!.id;
  } else {
    await db.prototypePlan.create({ data: { id: ids.planId, projectId: ids.projectId, createdById: ids.principalId, title: "Unbound archived plan", prompt: request.prompt, generationRequest: request as Prisma.InputJsonValue, status: "approved", idempotencyKey: suffix, requestHash: canonicalSha256(request) } });
  }
  return ids;
}

function fakeRuntime(execute: RuntimePort["execute"]) {
  return {
    adapter: "deerflow",
    createThread: vi.fn(async (metadata) => ({ externalThreadId: `external-thread-${metadata.workbenchThreadId}`, metadata })),
    execute: vi.fn(execute),
    cancel: vi.fn<RuntimePort["cancel"]>(async () => ({ disposition: "not_found", externalRunId: null, externalStatus: null })),
  } satisfies RuntimePort;
}

async function retrievalResponse(db: PrismaClient, execution: RuntimeExecution) {
  const run = await db.run.findUniqueOrThrow({ where: { id: execution.runId } });
  const release = await db.knowledgeRelease.findUniqueOrThrow({ where: { id: run.knowledgeReleaseId! } });
  const chunk = await db.knowledgeChunk.findFirstOrThrow({ where: { releaseId: release.id }, include: { document: true } });
  return knowledgeToolResponseSchema.parse({
    protocol: "workbench.knowledge-retrieval-result.v1",
    evidence: {
      schema: "workbench.knowledge-retrieval-evidence.v1", mode: "hybrid", routeScope: "production",
      release: { id: release.id, key: release.key, version: release.version },
      embeddingProfile: { id: release.embeddingProfileId, specSha256: release.embeddingProfileSpecSha256, dimension: release.embeddingDimension },
      retrievalProfile: { id: release.retrievalProfileId, specSha256: release.retrievalProfileSpecSha256 },
      candidateCounts: { lexical: 1, dense: 1, fused: 1 }, fusion: { algorithm: "rrf", k: 60 }, reranker: { status: "not_needed" }, degraded: false,
    },
    items: [{ rank: 1, rrfScore: 0.03, rerankerScore: null, citation: {
      id: `citation-${chunk.id}`, documentId: chunk.documentId, chunkId: chunk.id,
      sourcePath: chunk.document.sourcePath, title: chunk.document.title, quote: chunk.content,
      locator: { heading: "Rules", startLine: null, endLine: null },
    } }],
  });
}

async function retrieve(db: PrismaClient, execution: RuntimeExecution) {
  expect(execution.knowledgeTool).not.toBeNull();
  const grant = verifyKnowledgeToolGrant(execution.knowledgeTool!.token, secret, { maximumTtlSeconds: 3_600 });
  expect(grant).toMatchObject({ runId: execution.runId, runtimeAttemptId: execution.runtimeAttemptId, projectId: execution.projectId, mode: "hybrid", routeScope: "production" });
  const ledger = new KnowledgeToolLedgerService(db as never);
  const invocationId = `bridge-retrieval-${execution.runtimeAttemptId}`;
  const reservation = await ledger.reserve(grant, invocationId, "Source facts");
  if (reservation.kind !== "reserved") throw new Error("EXPECTED_NEW_RETRIEVAL_RESERVATION");
  const response = await ledger.commit(grant, reservation.reservation, await retrievalResponse(db, execution));
  await expect(ledger.reserve(grant, invocationId, "Source facts")).resolves.toEqual({ kind: "replay", response });
  return response;
}

async function publishPrototype(execution: RuntimeExecution, observer: RuntimeExecutionObserver, citations: RuntimeArtifactDraft["citations"]) {
  const document = prototypeDocumentFixture();
  const artifact = { kind: "prototype" as const, schemaVersion: 1 as const, title: "Retrieved prototype", operation: { kind: "create" as const }, content: document, citations };
  const externalRunId = `external-${execution.runId}`;
  for (const stage of ["design-system", "mapping-components", "creating-flows", "generating-ui"] as const) {
    await observer.onExternalEvent({ externalRunId, externalEventId: stage, event: "custom", payload: {} }, [
      { type: "generation.stage", stage, sourceEventId: `deerflow:${stage}` },
    ]);
  }
  await observer.onExternalEvent({ externalRunId, externalEventId: "prototype-draft", event: "custom", payload: {} }, [{
    type: "artifact.draft", artifactIndex: 0, sourceEventId: "deerflow:prototype-draft", draft: artifact,
    checkpointScreens: document.screens.map(({ id }) => ({ screenId: id, revision: 0, checksum: prototypeScreenProjectionChecksum(document, id, 0) })),
  }]);
  return { protocol: "workbench.runtime.result.v1" as const, message: "Prototype ready", artifacts: [artifact] };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
