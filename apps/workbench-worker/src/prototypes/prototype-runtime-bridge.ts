import { createHash } from "node:crypto";
import { canonicalJson, prototypeDocumentSchema, startRunRequestSchema } from "@workbench/workbench-contracts";
import { Prisma, type PrismaClient } from "@workbench/workbench-db";
import { RunProcessor, mapRuntimeArtifactTarget } from "../runs/run-processor.js";
import { RunEventStore } from "../runs/run-event.store.js";
import type { KnowledgeToolGrantIssuer } from "../runtime/knowledge-tool-grant.service.js";
import type { RuntimeArtifactTarget, RuntimeExecution, RuntimePort } from "../runtime/runtime.port.js";
import type { RuntimeReadyBlobReader } from "../storage/runtime-ready-blob-reader.port.js";
import { loadPrototypeAssets } from "./prototype-assets.js";
import { prototypeDocumentToPages } from "./prototype-pages.js";
import type { PrototypeGenerationInput, PrototypeGenerationStartInput, PrototypeGenerationResult, PrototypeHeartbeat } from "./temporal-worker.types.js";

/** Pin the model, request and Knowledge release once, in the same transaction
 * as API approval and its scheduler command. The worker only consumes that
 * binding; a retry must never invent a different input or provider Run. */
export async function preparePrototypeRuntime(
  db: PrismaClient,
  input: PrototypeGenerationStartInput,
): Promise<PrototypeGenerationInput> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "prototype_plans" WHERE "id" = ${input.planId} AND "project_id" = ${input.projectId} FOR UPDATE`);
    const plan = await tx.prototypePlan.findFirst({ where: { id: input.planId, projectId: input.projectId } });
    if (!plan) throw new Error("PROTOTYPE_PLAN_NOT_FOUND");
    if (!["approved", "generating", "ready"].includes(plan.status)) throw new Error("PROTOTYPE_PLAN_NOT_ACTIVE");
    const project = await tx.project.findFirst({ where: { id: plan.projectId, status: "active" } });
    const member = await tx.projectMember.findFirst({ where: { projectId: plan.projectId, principalId: plan.createdById, role: { in: ["owner", "editor"] }, principal: { status: "active" } } });
    if (!project || !member) throw new Error("PROTOTYPE_PROJECT_ACCESS_REVOKED");
    if (!await tx.board.findUnique({ where: { projectId: project.id }, select: { id: true } })) throw new Error("PROTOTYPE_PROJECT_BOARD_MISSING");
    const sourceRunId = plan.runtimeRunId ?? plan.reusedRunId;
    if (!sourceRunId) throw new Error("PROTOTYPE_PREPARED_RUN_REQUIRED");
    const run = await tx.run.findUniqueOrThrow({ where: { id: sourceRunId } });
    if (plan.reusedRunId && (run.status !== "succeeded" || !plan.retryOfPlanId || canonicalJson(run.request) !== canonicalJson(plan.generationRequest))) throw new Error("PROTOTYPE_REBUILD_SOURCE_INVALID");
    const request = startRunRequestSchema.parse(run.request);
    if (run.projectId !== project.id || (!plan.reusedRunId && run.createdById !== plan.createdById) || run.modelId !== request.modelId || !request.requestedArtifactKinds.includes("prototype")) {
      throw new Error("PROTOTYPE_PREPARED_RUN_SCOPE_INVALID");
    }
    const revisionId = `revision_${plan.id}`;
    // An activity replay may observe a ready revision. Never regress it to generating.
    await tx.prototypeRevision.upsert({ where: { id: revisionId }, create: {
      id: revisionId, projectId: project.id, planId: plan.rootPlanId ?? plan.id, createdById: plan.createdById,
      version: plan.contentVersion, sourceRevisionId: plan.sourceRevisionId, revision: 1, status: "generating", title: plan.title,
      pages: [{ id: `${revisionId}_pending`, slug: "pending", title: "Generating", route: "/", order: 0, content: "<p>Generating prototype…</p>", sha256: sha256("<p>Generating prototype…</p>") }], documentSha256: "0".repeat(64),
      idempotencyKey: `workflow:${plan.id}`, requestHash: plan.requestHash,
    }, update: {} });
    await tx.prototypePlan.updateMany({ where: { id: plan.id, status: "approved" }, data: { status: "generating", revision: { increment: 1 } } });
    return { projectId: project.id, planId: plan.id, revisionId, prompt: request.prompt, title: plan.title, createdById: plan.createdById };
  });
}

export class PrototypeRuntimeBridge {
  constructor(
    private readonly db: PrismaClient,
    private readonly runtime: RuntimePort,
    private readonly knowledgeGrants: KnowledgeToolGrantIssuer,
    private readonly processorFactory?: (runtime: RuntimePort) => RunProcessor,
    private readonly assetReader?: RuntimeReadyBlobReader,
  ) {}

  async generate(input: PrototypeGenerationInput, signal: AbortSignal, heartbeat: PrototypeHeartbeat, retry = { retryCount: 0, retryLimit: 0 }): Promise<PrototypeGenerationResult> {
    const plan = await this.db.prototypePlan.findFirst({ where: { id: input.planId, projectId: input.projectId } });
    if (!plan || !(plan.runtimeRunId ?? plan.reusedRunId)) throw new Error("PROTOTYPE_RUNTIME_RUN_MISSING");
    if (!["approved", "generating", "ready"].includes(plan.status)) throw new Error("PROTOTYPE_PLAN_NOT_ACTIVE");
    const runId = (plan.runtimeRunId ?? plan.reusedRunId)!;
    const rebuilding = Boolean(plan.reusedRunId);
    const processor = this.createProcessor(this.observedRuntime(heartbeat, input.createdById));
    let cancellation: Promise<void> | undefined;
    const cancel = () => {
      if (rebuilding) return;
      cancellation ??= this.cancelRun(runId, processor);
      // Awaited below; suppress an unhandled rejection while execute unwinds.
      void cancellation.catch(() => undefined);
    };
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    // Real model calls can be quiet for longer than Temporal's heartbeat timeout.
    // The provider adapter has its own bounded status/idle watchdog.
    const timer = setInterval(() => heartbeat("deerflow:waiting"), 10_000);
    timer.unref();
    try {
      heartbeat("deerflow:starting");
      if (!signal.aborted && !rebuilding) await processor.execute(runId, [], signal, retry);
      if (cancellation) await cancellation;
      if (signal.aborted) throw signal.reason ?? new DOMException("Workflow cancelled", "AbortError");
      const run = await this.db.run.findUniqueOrThrow({ where: { id: runId }, select: { status: true, errorCode: true } });
      if (run.status !== "succeeded") throw new Error(run.errorCode || `PROTOTYPE_RUNTIME_${run.status.toUpperCase()}`);
      const artifacts = await this.db.artifactVersion.findMany({ where: { createdByRunId: runId, projectId: input.projectId, status: "ready", artifact: { kind: "prototype" } }, select: { content: true, schemaVersion: true, artifact: { select: { title: true } } } });
      if (artifacts.length !== 1 || artifacts[0]!.schemaVersion !== 1) throw new Error("DEERFLOW_PROTOTYPE_ARTIFACT_MISSING");
      // RunProcessor has already checked exact retrieved citations, validated IR,
      // provider event identities and atomically published this artifact.
      const document = prototypeDocumentSchema.parse(artifacts[0]!.content);
      const assets = await loadPrototypeAssets(this.db, document, input.projectId, this.assetReader, signal);
      const pages = prototypeDocumentToPages(document, assets);
      if (pages.length < 1 || pages.length > 50) throw new Error("DEERFLOW_PROTOTYPE_PAGE_COUNT_INVALID");
      heartbeat("deerflow:complete");
      return { title: artifacts[0]!.artifact.title, pages, sourceDocument: document };
    } finally {
      clearInterval(timer);
      signal.removeEventListener("abort", cancel);
      // Even if execute throws, cancellation must reach the provider and persist
      // its acknowledgement. Temporal's cancelled signal is not passed to cleanup.
      if (cancellation) await cancellation;
    }
  }

  async cancelPlan(planId: string): Promise<void> {
    const plan = await this.db.prototypePlan.findUnique({ where: { id: planId }, select: { runtimeRunId: true } });
    if (plan?.runtimeRunId) await this.cancelRun(plan.runtimeRunId, this.createProcessor(this.runtime));
  }

  private createProcessor(runtime: RuntimePort): RunProcessor {
    // Durable plans use the original snapshot as reference, never a short-lived
    // capability to inspect or mutate the current live board.
    return this.processorFactory?.(runtime) ?? new RunProcessor(this.db, runtime, this.knowledgeGrants, { issue: async () => null }, undefined, undefined, { ownerPrefix: "prototype-temporal" });
  }

  private async cancelRun(runId: string, processor: Pick<RunProcessor, "cancel">): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const changed = await tx.run.updateMany({ where: { id: runId, status: { in: ["queued", "running", "waiting_input"] } }, data: { status: "cancelling", cancelRequestedAt: new Date() } });
      if (changed.count) await new RunEventStore().append(tx, runId, "run.cancel.requested", {});
    });
    const result = await processor.cancel(runId);
    const run = await this.db.run.findUniqueOrThrow({ where: { id: runId }, select: { status: true, errorCode: true } });
    if (run.status === "failed" && run.errorCode === "RUNTIME_PROVIDER_CANCELLATION_UNCONFIRMED" && !("cancellationConverged" in result && result.cancellationConverged)) throw new Error("PROTOTYPE_RUNTIME_CANCELLATION_PENDING");
    if (run.status === "cancelling" || (run.status !== "succeeded" && run.status !== "failed" && !result.cancelled)) throw new Error("PROTOTYPE_RUNTIME_CANCELLATION_PENDING");
  }

  private observedRuntime(heartbeat: PrototypeHeartbeat, principalId: string): RuntimePort {
    const runtime = this.runtime;
    return {
      adapter: runtime.adapter,
      createThread: (metadata, signal) => runtime.createThread(metadata, signal),
      cancel: (input, recovered, signal) => runtime.cancel(input, recovered, signal),
      execute: async (input, observer, signal) => runtime.execute(input.request.canvasSnapshot ? {
        ...input, canvasTool: null, historicalCanvasSnapshot: input.request.canvasSnapshot,
        historicalCanvasArtifacts: await this.loadHistoricalCanvas(input, principalId),
      } : { ...input, canvasTool: null }, {
        ...observer,
        onSubmissionStarted: async () => { await observer.onSubmissionStarted(); heartbeat("deerflow:submission"); },
        onExternalRunCreated: async (id) => { await observer.onExternalRunCreated(id); heartbeat("deerflow:run-created"); },
        onExternalEvent: async (part, effects) => { await observer.onExternalEvent(part, effects); heartbeat("deerflow:stream"); },
        onExternalFinalization: async (part, effects) => { await observer.onExternalFinalization(part, effects); heartbeat("deerflow:finalization"); },
      }, signal),
    };
  }

  private async loadHistoricalCanvas(input: RuntimeExecution, principalId: string): Promise<RuntimeArtifactTarget[]> {
    const snapshot = input.request.canvasSnapshot!;
    if (snapshot.projectId !== input.projectId || snapshot.threadId !== input.threadId) throw new Error("PROTOTYPE_CANVAS_REFERENCE_SCOPE_INVALID");
    return this.db.$transaction(async tx => {
      const project = await tx.project.findFirst({ where: { id: input.projectId, status: "active" }, select: { id: true } });
      const member = await tx.projectMember.findFirst({ where: { projectId: input.projectId, principalId, role: { in: ["owner", "editor"] }, principal: { status: "active" } }, select: { principalId: true } });
      const board = await tx.board.findFirst({ where: { id: snapshot.boardId, projectId: input.projectId }, select: { id: true } });
      const thread = await tx.thread.findFirst({ where: { id: snapshot.threadId, projectId: input.projectId }, select: { id: true } });
      if (!project || !member || !board || !thread) throw new Error("PROTOTYPE_CANVAS_REFERENCE_ACCESS_REVOKED");
      const targets = new Map<string, { artifactId: string; artifactVersionId: string; screenIds: string[] }>();
      for (const { reference } of snapshot.screens) {
        const prior = targets.get(reference.artifactVersionId);
        if (prior && prior.artifactId !== reference.artifactId) throw new Error("PROTOTYPE_CANVAS_REFERENCE_SCOPE_INVALID");
        if (prior) { if (!prior.screenIds.includes(reference.screenId)) prior.screenIds.push(reference.screenId); }
        else targets.set(reference.artifactVersionId, { artifactId: reference.artifactId, artifactVersionId: reference.artifactVersionId, screenIds: [reference.screenId] });
      }
      if (!targets.size) return [];
      const rows = await tx.artifactVersion.findMany({ where: { projectId: input.projectId, id: { in: [...targets.keys()] } }, include: {
        artifact: { select: { kind: true } }, contentBlob: true, assets: { include: { blob: true }, orderBy: { assetId: "asc" } },
      } });
      const byId = new Map(rows.map(row => [row.id, row]));
      const result: RuntimeArtifactTarget[] = [];
      for (const target of targets.values()) {
        const row = byId.get(target.artifactVersionId);
        if (!row || row.artifact.kind !== "prototype" || row.schemaVersion !== 1 || row.content === null) throw new Error("PROTOTYPE_CANVAS_REFERENCE_INVALID");
        // The existing source projection contract caps each projection at 12
        // screens. Preserve larger Canvas snapshots as bounded source groups.
        for (let offset = 0; offset < target.screenIds.length; offset += 12) result.push(mapRuntimeArtifactTarget(input.projectId, { ...target, screenIds: target.screenIds.slice(offset, offset + 12) }, row, "generate-source"));
      }
      return result;
    });
  }
}

function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
