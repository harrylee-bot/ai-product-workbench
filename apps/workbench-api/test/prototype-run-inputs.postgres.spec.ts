import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { canonicalJson, startRunRequestSchema } from "@workbench/workbench-contracts";
import { PrismaClient, type Prisma } from "@workbench/workbench-db";
import { seedKnowledgeReceipt, seedReadyKnowledge } from "../../../scripts/test-support/knowledge-fixture.mjs";
import { AccessService } from "../src/modules/access/access.service.js";
import { DesignPresetsService } from "../src/modules/design-presets/design-presets.service.js";
import { ImportSourcesService } from "../src/modules/import-sources/import-sources.service.js";
import { RunEventStore } from "../src/modules/runs/run-event.store.js";
import { prototypeDocumentFixture } from "../../../packages/workbench-contracts/test/prototype-fixture.js";
import { PrototypeV2Service } from "../src/modules/prototypes/prototype-v2.service.js";
import { preparePrototypeRuntime, PrototypeRuntimeBridge } from "../../workbench-worker/src/prototypes/prototype-runtime-bridge.js";
import { RunsService } from "../src/modules/runs/runs.service.js";

const url = process.env.WORKBENCH_TEST_DATABASE_URL;
(url ? describe : describe.skip)("Prototype composer input preparation on PostgreSQL", () => {
  let db: PrismaClient;
  beforeAll(async () => { db = new PrismaClient({ datasourceUrl: url! }); await db.$transaction(tx => seedReadyKnowledge(tx), { timeout: 60000 }); }, 90000);
  afterAll(async () => { await db?.$disconnect(); });
  async function fixture(action: (tx: Prisma.TransactionClient, f: Awaited<ReturnType<typeof seed>>) => Promise<void>) {
    const rollback = new Error("ROLLBACK_PROTOTYPE_INPUT_FIXTURE");
    await expect(db.$transaction(async tx => { await action(tx, await seed(tx)); throw rollback; }, { timeout: 60000 })).rejects.toBe(rollback);
  }
  it("pins model, attachment, design preset, canvas and knowledge using normal Run validation", async () => fixture(async (tx, f) => {
    const runId = await f.runs.preparePrototypeRun(tx, f.input);
    const run = await tx.run.findUniqueOrThrow({ where: { id: runId }, include: { sourceSnapshots: true } });
    expect(run.request).toEqual(f.input.request); expect(run.modelId).toBe("selected-model"); expect(run.knowledgeReleaseId).toBeTruthy();
    expect(run.threadId).toBe(f.threadId); expect(run.designStyleSnapshotSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(run.sourceSnapshots).toHaveLength(1);
    expect(run.sourceSnapshots[0]).toMatchObject({ sourceId: f.sourceId, checksum: f.sha256, position: 0, snapshot: { blobs: [{ blobId: f.blobId, sha256: f.sha256 }] } });
    expect(f.queue.sendInTransaction).not.toHaveBeenCalled();
    expect(f.models.assertAvailable).toHaveBeenCalledWith("selected-model", "generate");
    expect(await tx.runEvent.count({ where: { runId, type: "run.queued" } })).toBe(1);
  }), 90000);
  it("retries with original immutable source/design/knowledge snapshots", async () => fixture(async (tx, f) => {
    const originalId = await f.runs.preparePrototypeRun(tx, f.input);
    await tx.run.update({ where: { id: originalId }, data: { status: "cancelled", finishedAt: new Date() } });
    const original = await tx.run.findUniqueOrThrow({ where: { id: originalId } });
    const retryId = await f.runs.preparePrototypeRun(tx, { ...f.input, planId: `${f.input.planId}_retry`, pinnedRunId: originalId });
    const retry = await tx.run.findUniqueOrThrow({ where: { id: retryId }, include: { sourceSnapshots: true } });
    expect(retry.request).toEqual(original.request); expect(retry.knowledgeReleaseId).toBe(original.knowledgeReleaseId);
    expect(retry.designStyleSnapshotSha256).toBe(original.designStyleSnapshotSha256); expect(retry.sourceSnapshots[0]!.label).toBe("reference.md");
    await expect(f.runs.preparePrototypeRun(tx, { ...f.input, request: { ...f.input.request, prompt: "Changed" }, pinnedRunId: originalId })).rejects.toMatchObject({ status: 409 });
  }), 90000);
  it.each([{ combined: false, phase: "cancelled" }, { combined: true, phase: "cancelled" }, { combined: false, phase: "build-failed" }])("approves and retries through the API with pinned Run context (%j)", async ({ combined, phase }) => fixture(async (tx, f) => {
    if (combined) f.input.request = startRunRequestSchema.parse({ ...f.input.request, requestedArtifactKinds: ["prd", "prototype"] });
    const scopedDb = { ...tx, $transaction: (action: (client: Prisma.TransactionClient) => unknown) => action(tx) };
    const workflows = { configured: true, startPlan: vi.fn(), cancelPlan: vi.fn(), startExport: vi.fn(), cancelExport: vi.fn() };
    const api = new PrototypeV2Service(scopedDb as never, workflows, { get: () => undefined } as never, {} as never, f.runs);
    const principal = { id: f.input.principalId } as never;
    const plan = await api.createPlan(principal, f.input.projectId, { title: f.input.title, prompt: f.input.request.prompt, generationRequest: f.input.request }, "api-input-create");
    await api.approvePlan(principal, f.input.projectId, plan.id, "api-input-approve", '"0"', {});
    const bound = await tx.prototypePlan.findUniqueOrThrow({ where: { id: plan.id } });
    const original = await tx.run.findUniqueOrThrow({ where: { id: bound.runtimeRunId! } });
    expect(original.request).toEqual(f.input.request);
    if (phase === "build-failed") {
      await tx.run.update({ where: { id: original.id }, data: { status: "running", attempt: 1, startedAt: new Date() } });
      const binding = await tx.runtimeBinding.create({ data: { threadId: original.threadId, adapter: "deerflow", externalThreadId: `external-${original.id}`, metadata: {} } });
      const attempt = await tx.runtimeAttempt.create({ data: { runId: original.id, runtimeBindingId: binding.id, attempt: 1, adapter: "deerflow", externalThreadId: binding.externalThreadId } });
      await tx.runtimeAttempt.update({ where: { id: attempt.id }, data: { status: "submitting", startedAt: new Date(), providerIdempotencyKey: `wbrt:${createHash("sha256").update(attempt.id).digest("hex")}` } });
      const citations = await seedKnowledgeReceipt(tx, attempt.id);
      await tx.run.update({ where: { id: original.id }, data: { status: "succeeded", finishedAt: new Date() } });
      const document = prototypeDocumentFixture();
      const artifact = await tx.artifact.create({ data: { projectId: f.input.projectId, kind: "prototype", title: "Original generated result" } });
      const version = await tx.artifactVersion.create({ data: { artifactId: artifact.id, projectId: f.input.projectId, version: 1, schemaVersion: 1, status: "ready", content: document as never, checksum: createHash("sha256").update(canonicalJson(document)).digest("hex"), citations, knowledgeReleaseId: original.knowledgeReleaseId, createdByRunId: original.id } });
      await tx.artifact.update({ where: { id: artifact.id }, data: { currentVersionId: version.id } });
      await tx.board.update({ where: { projectId: f.input.projectId }, data: { revision: { increment: 1 } } });
      await tx.prototypePlan.update({ where: { id: plan.id }, data: { status: "failed", failureCode: "PROTOTYPE_BUILD_FAILED", failureDetail: "Storage unavailable after generation", revision: 2 } });
    } else {
      await tx.run.update({ where: { id: original.id }, data: { status: "cancelled", finishedAt: new Date() } });
      await tx.prototypePlan.update({ where: { id: plan.id }, data: { status: "cancelled", revision: 2 } });
    }
    const retried = await api.retryPlan(principal, f.input.projectId, plan.id, "api-input-retry", '"2"', {});
    expect(retried).toMatchObject({ rootPlanId: plan.id, contentVersion: 2, status: "approved" });
    const nextPlan = await tx.prototypePlan.findUniqueOrThrow({ where: { id: retried.id } });
    const nextRun = await tx.run.findUniqueOrThrow({ where: { id: (nextPlan.runtimeRunId ?? nextPlan.reusedRunId)! }, include: { sourceSnapshots: true } });
    if (phase === "build-failed") {
      expect(nextPlan.runtimeRunId).toBeNull(); expect(nextPlan.reusedRunId).toBe(original.id);
      const provider = { adapter: "deerflow" as const, createThread: vi.fn(), execute: vi.fn(), cancel: vi.fn() };
      const grants = { issue: vi.fn() };
      const bridge = new PrototypeRuntimeBridge(scopedDb as never, provider, grants);
      const prepared = await preparePrototypeRuntime(scopedDb as never, { projectId: f.input.projectId, planId: nextPlan.id });
      const result = await bridge.generate(prepared, new AbortController().signal, vi.fn());
      expect(result.sourceDocument).toEqual(prototypeDocumentFixture());
      expect(result.pages).toHaveLength(2); expect(provider.execute).not.toHaveBeenCalled(); expect(grants.issue).not.toHaveBeenCalled();
      await bridge.cancelPlan(nextPlan.id); expect(provider.cancel).not.toHaveBeenCalled();
      expect(await tx.run.count({ where: { projectId: f.input.projectId } })).toBe(1);
      const rebuilt = await tx.prototypeRevision.update({ where: { id: prepared.revisionId }, data: { status: "ready", title: result.title, pages: result.pages as never, sourceDocument: result.sourceDocument as never, documentSha256: createHash("sha256").update(canonicalJson(result.pages)).digest("hex"), revision: { increment: 1 } } });
      await tx.prototypePlan.update({ where: { id: nextPlan.id }, data: { status: "ready", revision: { increment: 1 } } });
      const comment = await api.createFeedback(principal, f.input.projectId, rebuilt.id, { body: "Refine the rebuilt result", anchor: { pageId: result.pages[0]!.id, selector: "main" } }, "rebuilt-comment");
      const revised = await api.revise(principal, f.input.projectId, rebuilt.id, { feedbackIds: [comment.id] }, "revise-rebuilt", `"${rebuilt.revision}"`);
      expect(revised).toMatchObject({ contentVersion: 3, sourceRevisionId: rebuilt.id });
      expect(await tx.prototypeRevision.findUniqueOrThrow({ where: { id: rebuilt.id } })).toMatchObject({ sourceDocument: result.sourceDocument, status: "ready" });
      await tx.$executeRawUnsafe("SAVEPOINT immutable_reuse");
      await expect(tx.prototypePlan.update({ where: { id: nextPlan.id }, data: { reusedRunId: null } })).rejects.toThrow("PROTOTYPE_RETRY_SOURCE_IMMUTABLE");
      await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT immutable_reuse");
      await tx.$executeRawUnsafe("RELEASE SAVEPOINT immutable_reuse");
    } else expect(nextRun.id).not.toBe(original.id);
    expect(nextRun.request).toEqual(original.request);
    expect(nextRun.knowledgeReleaseId).toBe(original.knowledgeReleaseId);
    expect(nextRun.designStyleSnapshotSha256).toBe(original.designStyleSnapshotSha256);
    expect(nextRun.sourceSnapshots[0]!.checksum).toBe(f.sha256);
    await expect(api.retryPlan(principal, f.input.projectId, plan.id, "api-input-retry", '"2"', {})).resolves.toEqual(retried);
    expect(await tx.prototypeWorkflowCommand.count({ where: { projectId: f.input.projectId, kind: "plan_start" } })).toBe(phase === "build-failed" ? 3 : 2);
  }), 90000);

  it("turns anchored feedback on a rejected version into one new generation with exact base artifact", async () => fixture(async (tx, f) => {
    const scopedDb = { ...tx, $transaction: (action: (client: Prisma.TransactionClient) => unknown) => action(tx) };
    const api = new PrototypeV2Service(scopedDb as never, { configured: true, startPlan: vi.fn(), cancelPlan: vi.fn(), startExport: vi.fn(), cancelExport: vi.fn() }, { get: () => undefined } as never, {} as never, f.runs);
    const principal = { id: f.input.principalId } as never;
    const plan = await api.createPlan(principal, f.input.projectId, { title: f.input.title, prompt: f.input.request.prompt, generationRequest: f.input.request }, "api-revise-create");
    await api.approvePlan(principal, f.input.projectId, plan.id, "api-revise-approve", '"0"', {});
    const bound = await tx.prototypePlan.findUniqueOrThrow({ where: { id: plan.id } });
    const sourceRun = await tx.run.update({ where: { id: bound.runtimeRunId! }, data: { status: "running", attempt: 1, startedAt: new Date() } });
    const binding = await tx.runtimeBinding.create({ data: { threadId: sourceRun.threadId, adapter: "deerflow", externalThreadId: `external-${sourceRun.id}`, metadata: {} } });
    const attempt = await tx.runtimeAttempt.create({ data: { runId: sourceRun.id, runtimeBindingId: binding.id, attempt: 1, adapter: "deerflow", externalThreadId: binding.externalThreadId } });
    await tx.runtimeAttempt.update({ where: { id: attempt.id }, data: { status: "submitting", startedAt: new Date(), providerIdempotencyKey: `wbrt:${createHash("sha256").update(attempt.id).digest("hex")}` } });
    const citations = await seedKnowledgeReceipt(tx, attempt.id);
    await tx.run.update({ where: { id: sourceRun.id }, data: { status: "succeeded", finishedAt: new Date() } });
    const document = prototypeDocumentFixture();
    const artifact = await tx.artifact.create({ data: { projectId: f.input.projectId, kind: "prototype", title: "Base" } });
    const version = await tx.artifactVersion.create({ data: { artifactId: artifact.id, projectId: f.input.projectId, version: 1, schemaVersion: 1, status: "ready", content: document as never, checksum: createHash("sha256").update(canonicalJson(document)).digest("hex"), citations, knowledgeReleaseId: sourceRun.knowledgeReleaseId, createdByRunId: bound.runtimeRunId } });
    await tx.artifact.update({ where: { id: artifact.id }, data: { currentVersionId: version.id } });
    const content = "<button>Review</button>";
    const source = await tx.prototypeRevision.create({ data: { projectId: f.input.projectId, planId: plan.id, createdById: f.input.principalId, version: 1, revision: 3, status: "rejected", title: "Base", sourceDocument: document as never, pages: [{ id: document.screens[0]!.id, slug: "home", title: "Home", route: "/", order: 0, content, sha256: createHash("sha256").update(content).digest("hex") }], documentSha256: createHash("sha256").update(content).digest("hex"), idempotencyKey: "seed-base-revision", requestHash: "a".repeat(64) } });
    const feedback = await api.createFeedback(principal, f.input.projectId, source.id, { body: "Change only the selected button label", anchor: { pageId: document.screens[0]!.id, selector: "button" } }, "api-revise-feedback");
    const child = await api.revise(principal, f.input.projectId, source.id, { feedbackIds: [feedback.id] }, "api-revise-child", '"3"');
    expect(child).toMatchObject({ rootPlanId: plan.id, sourceRevisionId: source.id, contentVersion: 2, status: "approved" });
    const childRow = await tx.prototypePlan.findUniqueOrThrow({ where: { id: child.id } });
    const run = await tx.run.findUniqueOrThrow({ where: { id: childRow.runtimeRunId! } });
    expect(run.request).toMatchObject({ modelId: f.input.request.modelId, workflow: "edit", canvasSnapshot: null, sourceIds: [f.sourceId], artifactTargets: [{ artifactId: artifact.id, artifactVersionId: version.id, screenIds: [] }], prompt: expect.stringContaining(feedback.body) });
    expect((run.request as { prompt: string }).prompt).toContain('"selector":"button"');
    expect(child.prompt).toContain(feedback.body);
    expect(child.prompt).toContain("Home");
    expect(child.prompt).not.toContain(feedback.id);
    expect(child.prompt).not.toContain('"selector"');
    expect(childRow.prompt).toBe(child.prompt);
    expect(childRow.generationRequest).toMatchObject({ prompt: (run.request as { prompt: string }).prompt });
    expect((await api.getPlanSnapshot(principal, f.input.projectId, child.id)).prompt).toBe(child.prompt);
    await expect(api.revise(principal, f.input.projectId, source.id, { feedbackIds: [feedback.id] }, "api-revise-child", '"0"')).resolves.toEqual(child);
    expect(await tx.prototypeRevision.findUnique({ where: { id: source.id } })).toMatchObject({ version: 1, revision: 3, status: "rejected", sourceDocument: document });
    await tx.run.update({ where: { id: run.id }, data: { status: "failed", errorCode: "TEST_PROVIDER_FAILURE", finishedAt: new Date() } });
    await tx.prototypePlan.update({ where: { id: child.id }, data: { status: "failed", revision: 1 } });
    const retry = await api.retryPlan(principal, f.input.projectId, child.id, "api-feedback-presentation-retry", '"1"', {});
    const retryRow = await tx.prototypePlan.findUniqueOrThrow({ where: { id: retry.id } });
    const retryRun = await tx.run.findUniqueOrThrow({ where: { id: retryRow.runtimeRunId! } });
    expect(retry.prompt).toBe(child.prompt);
    expect(retryRun.request).toEqual(run.request);
    expect(retryRow.feedbackIds).toEqual(childRow.feedbackIds);
    expect(retryRow.sourceRevisionId).toBe(source.id);
    const newer = await tx.artifactVersion.create({ data: { artifactId: artifact.id, projectId: f.input.projectId, version: 2, schemaVersion: 1, status: "ready", content: document as never, checksum: createHash("sha256").update(canonicalJson(document)).digest("hex"), citations, knowledgeReleaseId: sourceRun.knowledgeReleaseId } });
    await tx.artifact.update({ where: { id: artifact.id }, data: { currentVersionId: newer.id } });
    await expect(api.revise(principal, f.input.projectId, source.id, { feedbackIds: [feedback.id] }, "api-revise-old-base", '"3"')).rejects.toMatchObject({ status: 409 });
    expect(await tx.prototypeWorkflowCommand.count({ where: { projectId: f.input.projectId, kind: "plan_start" } })).toBe(3);
  }), 90000);

  it("approves a fixed Canvas context after expiry and Board changes without rewriting the original input", async () => fixture(async (tx, f) => {
    const source = await attachCanvasPrototype(tx, f);
    const { api, principal } = prototypeApi(tx, f);
    const request = { title: f.input.title, prompt: f.input.request.prompt, generationRequest: f.input.request };
    const plan = await api.createPlan(principal, f.input.projectId, request, "canvas-fixed-create");
    const originalRequest = structuredClone(f.input.request);
    const changedDocument = { ...source.document, title: "New current content", revision: source.document.revision + 1 };
    const next = await tx.artifactVersion.create({ data: { artifactId: source.artifact.id, projectId: f.input.projectId, version: 2, schemaVersion: 1, status: "ready", content: changedDocument as never, checksum: sha(changedDocument), citations: [] } });
    await tx.artifact.update({ where: { id: source.artifact.id }, data: { currentVersionId: next.id } });
    await tx.boardNode.update({ where: { id: source.node.id }, data: { artifactVersionId: next.id } });
    await tx.board.update({ where: { id: f.boardId }, data: { viewport: { x: 140, y: 80, zoom: 0.75 }, revision: { increment: 1 } } });
    const time = vi.spyOn(Date, "now").mockReturnValue(Date.parse(originalRequest.canvasSnapshot!.expiresAt) + 180_000);
    try {
      await expect(api.createPlan(principal, f.input.projectId, request, "canvas-fixed-create")).resolves.toEqual(plan);
      const approved = await api.approvePlan(principal, f.input.projectId, plan.id, "canvas-fixed-approve", '"0"', {});
      expect(approved.status).toBe("approved");
      await expect(api.approvePlan(principal, f.input.projectId, plan.id, "canvas-fixed-approve", '"0"', {})).resolves.toEqual(approved);
    } finally { time.mockRestore(); }
    const bound = await tx.prototypePlan.findUniqueOrThrow({ where: { id: plan.id } });
    const run = await tx.run.findUniqueOrThrow({ where: { id: bound.runtimeRunId! } });
    expect(bound.generationRequest).toEqual(originalRequest);
    expect(run.request).toEqual(originalRequest);
    expect((run.request as { artifactTargets: unknown[] }).artifactTargets).toEqual([]);
    expect(await tx.artifactVersion.findUniqueOrThrow({ where: { id: source.version.id } })).toMatchObject({ content: source.document, checksum: sha(source.document), status: "ready" });
    for (const data of [{ checksum: "f".repeat(64) }, { content: changedDocument }]) {
      await tx.$executeRawUnsafe("SAVEPOINT canvas_immutable_version");
      await expect(tx.artifactVersion.update({ where: { id: source.version.id }, data: data as never })).rejects.toThrow("ARTIFACT_TERMINAL_VERSION_IMMUTABLE");
      await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT canvas_immutable_version");
      await tx.$executeRawUnsafe("RELEASE SAVEPOINT canvas_immutable_version");
    }
  }), 90000);

  it("rejects initially expired Canvas snapshots instead of accepting them as a new plan", async () => fixture(async (tx, f) => {
    const { api, principal } = prototypeApi(tx, f);
    const time = vi.spyOn(Date, "now").mockReturnValue(Date.parse(f.input.request.canvasSnapshot!.expiresAt) + 180_000);
    try {
      await expect(api.createPlan(principal, f.input.projectId, { title: f.input.title, prompt: f.input.request.prompt, generationRequest: f.input.request }, "canvas-expired-create")).rejects.toMatchObject({ status: 400 });
      const scopedDb = { ...tx, $transaction: (action: (client: Prisma.TransactionClient) => unknown) => action(tx) };
      const ordinary = new RunsService(scopedDb as never, new AccessService(tx as never), new RunEventStore(), f.queue as never, f.models as never, new DesignPresetsService());
      await expect(ordinary.start(f.input.principalId, f.threadId, "ordinary-expired-canvas", f.input.request)).rejects.toMatchObject({ status: 400 });
    } finally { time.mockRestore(); }
    expect(await tx.prototypePlan.count({ where: { projectId: f.input.projectId } })).toBe(0);
  }), 90000);

  it("rejects corrupt fixed versions at creation and preparation", async () => fixture(async (tx, f) => {
    await attachCanvasPrototype(tx, f, "f".repeat(64));
    const { api, principal } = prototypeApi(tx, f);
    await expect(api.createPlan(principal, f.input.projectId, { title: f.input.title, prompt: f.input.request.prompt, generationRequest: f.input.request }, "canvas-corrupt-create")).rejects.toMatchObject({ status: 409 });
    await expect(f.runs.preparePrototypeRun(tx, f.input)).rejects.toMatchObject({ status: 409 });
    expect(await tx.run.count({ where: { projectId: f.input.projectId } })).toBe(0);
    expect(await tx.prototypePlan.count({ where: { projectId: f.input.projectId } })).toBe(0);
  }), 90000);

  it("rejects cross-project or missing fixed Canvas screen references", async () => fixture(async (tx, f) => {
    await attachCanvasPrototype(tx, f);
    const other = await seed(tx);
    const outside = await attachCanvasPrototype(tx, other);
    const snapshot = f.input.request.canvasSnapshot!;
    const reference = snapshot.screens[0]!.reference;
    for (const forged of [
      { ...reference, artifactId: outside.artifact.id, artifactVersionId: outside.version.id },
      { ...reference, screenId: "missing-screen" },
    ]) {
      const request = startRunRequestSchema.parse({ ...f.input.request, canvasSnapshot: { ...snapshot, screens: [{ ...snapshot.screens[0], reference: forged }], selectedScreens: [forged], visibleScreens: [forged] } });
      await expect(f.runs.preparePrototypeRun(tx, { ...f.input, request })).rejects.toMatchObject({ status: 404 });
      await expect(f.runs.validatePrototypePlanCanvas(tx, f.input.projectId, request)).rejects.toMatchObject({ status: 400 });
    }
    expect(await tx.run.count({ where: { projectId: f.input.projectId } })).toBe(0);
  }), 90000);

  it("rechecks current membership before approving accepted Canvas context", async () => fixture(async (tx, f) => {
    await attachCanvasPrototype(tx, f);
    const editor = await tx.principal.create({ data: { issuer: "canvas-approval-editor", subject: randomUUID() } });
    await tx.workspaceMember.create({ data: { workspaceId: f.workspaceId, principalId: editor.id, role: "member" } });
    await tx.projectMember.create({ data: { projectId: f.input.projectId, workspaceId: f.workspaceId, principalId: editor.id, role: "editor" } });
    const { api } = prototypeApi(tx, f);
    const principal = { id: editor.id } as never;
    const plan = await api.createPlan(principal, f.input.projectId, { title: f.input.title, prompt: f.input.request.prompt, generationRequest: f.input.request }, "canvas-member-create");
    await tx.projectMember.delete({ where: { projectId_principalId: { projectId: f.input.projectId, principalId: editor.id } } });
    await expect(api.approvePlan(principal, f.input.projectId, plan.id, "canvas-member-approve", '"0"', {})).rejects.toMatchObject({ status: 403 });
    expect(await tx.run.count({ where: { projectId: f.input.projectId } })).toBe(0);
    expect(await tx.prototypePlan.findUniqueOrThrow({ where: { id: plan.id } })).toMatchObject({ status: "draft", generationRequest: f.input.request });
  }), 90000);

  it("rejects forged sources, initially stale canvas and unavailable models before Run persistence", async () => fixture(async (tx, f) => {
    const request = f.input.request;
    await expect(f.runs.preparePrototypeRun(tx, { ...f.input, request: { ...request, sourceIds: ["outside-project"] } })).rejects.toMatchObject({ status: 409 });
    await expect(f.runs.validatePrototypePlanCanvas(tx, f.input.projectId, { ...request, canvasSnapshot: { ...request.canvasSnapshot!, boardRevision: 10 } })).rejects.toMatchObject({ status: 412 });
    f.models.assertAvailable.mockRejectedValueOnce(new Error("MODEL_UNAVAILABLE"));
    await expect(f.runs.preparePrototypeRun(tx, f.input)).rejects.toThrow("MODEL_UNAVAILABLE");
    expect(await tx.run.count({ where: { projectId: f.input.projectId } })).toBe(0);
  }), 90000);
});

async function seed(tx: Prisma.TransactionClient) {
  const suffix = randomUUID().replaceAll("-", "");
  const principalId = `principal_inputs_${suffix}`, workspaceId = `workspace_inputs_${suffix}`, projectId = `project_inputs_${suffix}`;
  const threadId = `thread_inputs_${suffix}`, boardId = `board_inputs_${suffix}`, blobId = `blob_inputs_${suffix}`, fileId = `file_inputs_${suffix}`;
  const bytes = Buffer.from(`# Reference ${suffix}`), sha256 = createHash("sha256").update(bytes).digest("hex"), now = new Date();
  await tx.principal.create({ data: { id: principalId, issuer: "prototype-input-test", subject: principalId } });
  await tx.workspace.create({ data: { id: workspaceId, slug: `prototype-input-${suffix}`, name: "Inputs", createdById: principalId } });
  await tx.workspaceMember.create({ data: { workspaceId, principalId, role: "owner" } });
  await tx.project.create({ data: { id: projectId, workspaceId, createdById: principalId, title: "Inputs" } });
  await tx.projectMember.create({ data: { projectId, workspaceId, principalId, role: "owner" } });
  await tx.thread.create({ data: { id: threadId, projectId, createdById: principalId, title: "Inputs" } });
  await tx.board.create({ data: { id: boardId, projectId, revision: 0, viewport: { x: 0, y: 0, zoom: 1 } } });
  await tx.blob.create({ data: { id: blobId, sha256, storageKey: `test/${suffix}`, mediaType: "text/markdown", byteSize: BigInt(bytes.length), status: "ready", verifiedAt: now } });
  await tx.blobScan.create({ data: { blobId, attempt: 1, status: "clean", scanner: "test", scannerVersion: "1", signatureVersion: "1", evidence: { result: "clean" }, startedAt: now, finishedAt: now } });
  await tx.fileAsset.create({ data: { id: fileId, projectId, blobId, uploadedById: principalId, originalName: "reference.md", declaredMediaType: "text/markdown", detectedMediaType: "text/markdown", byteSize: BigInt(bytes.length), status: "ready", verifiedAt: now } });
  const scopedDb = { ...tx, $transaction: (action: (client: Prisma.TransactionClient) => unknown) => action(tx) };
  const queue = { sendInTransaction: vi.fn() }; const access = new AccessService(tx as never);
  const source = await new ImportSourcesService(scopedDb as never, access, queue as never).create(principalId, projectId, `source:${suffix}`, { kind: "file", fileAssetId: fileId });
  const presets = new DesignPresetsService(); const preset = presets.list().items[0]!;
  const models = { assertAvailable: vi.fn(async () => undefined) };
  const runs = new RunsService(tx as never, access, new RunEventStore(), queue as never, models as never, presets);
  const request = startRunRequestSchema.parse({
    prompt: "Use the attached specification", modelId: "selected-model", workflow: "generate", generationIntent: null,
    targetSurface: "app", designStyle: { kind: "preset", presetId: preset.presetId, version: preset.version, checksum: preset.checksum },
    sourceIds: [source.id], artifactTargets: [], requestedArtifactKinds: ["prototype"],
    canvasSnapshot: { protocol: "workbench.canvas-snapshot.v1", projectId, threadId, runId: null, boardId,
      clientSessionId: `session-${suffix}`, projectSessionGeneration: 1, boardRevision: 0, canvasStateRevision: 0,
      capturedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60000).toISOString(), viewport: { x: 0, y: 0, zoom: 1 },
      screens: [], visibleScreens: [], selectedScreens: [] },
  });
  return { input: { projectId, principalId, planId: `plan_inputs_${suffix}`, title: "Inputs", request }, workspaceId, boardId, threadId, blobId, sourceId: source.id, sha256, queue, models, runs };
}

function sha(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }

function prototypeApi(tx: Prisma.TransactionClient, f: Awaited<ReturnType<typeof seed>>) {
  const scopedDb = { ...tx, $transaction: (action: (client: Prisma.TransactionClient) => unknown) => action(tx) };
  const api = new PrototypeV2Service(scopedDb as never, { configured: true, startPlan: vi.fn(), cancelPlan: vi.fn(), startExport: vi.fn(), cancelExport: vi.fn() }, { get: () => undefined } as never, {} as never, f.runs);
  return { api, principal: { id: f.input.principalId } as never };
}

async function attachCanvasPrototype(tx: Prisma.TransactionClient, f: Awaited<ReturnType<typeof seed>>, checksum?: string) {
  const document = prototypeDocumentFixture();
  const artifact = await tx.artifact.create({ data: { projectId: f.input.projectId, kind: "prototype", title: "Canvas source" } });
  const version = await tx.artifactVersion.create({ data: { artifactId: artifact.id, projectId: f.input.projectId, version: 1, schemaVersion: 1, status: "ready", content: document as never, checksum: checksum ?? sha(document), citations: [] } });
  await tx.artifact.update({ where: { id: artifact.id }, data: { currentVersionId: version.id } });
  const screen = document.screens[0]!;
  const node = await tx.boardNode.create({ data: { boardId: f.boardId, projectId: f.input.projectId, nodeKey: `canvas-${randomUUID()}`, sortOrder: 0, kind: "artifact", position: { x: 0, y: 0 }, size: screen.viewport, artifactId: artifact.id, artifactVersionId: version.id, data: { protocol: "workbench.board-node.v1", nodeType: "artifact", artifactKind: "prototype", title: screen.name, screenId: screen.id, route: screen.route } } });
  const board = await tx.board.findUniqueOrThrow({ where: { id: f.boardId } });
  const reference = { boardNodeId: node.nodeKey, artifactId: artifact.id, artifactVersionId: version.id, screenId: screen.id };
  f.input.request = startRunRequestSchema.parse({ ...f.input.request, canvasSnapshot: { ...f.input.request.canvasSnapshot!, boardRevision: board.revision, screens: [{ reference, name: screen.name, route: screen.route, phase: "complete", viewport: screen.viewport }], visibleScreens: [reference], selectedScreens: [reference] } });
  return { artifact, version, node, document };
}
