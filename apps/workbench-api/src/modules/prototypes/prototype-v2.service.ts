import { feedbackAnchorIndex, resolveFeedbackLocation } from "./prototype-feedback-location.js";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Inject, Injectable, Optional, type OnModuleInit, type OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  canonicalJson,
  prototypePlanInputSchema, prototypeRevisionInputSchema, prototypeInputSnapshotSchema, updatePrototypePlanRequestSchema, createPrototypeRevisionPlanRequestSchema,
  type UpdatePrototypePlanRequest, type CreatePrototypeRevisionPlanRequest,
  prototypeProgressSchema, prototypeFeedbackLocationsSchema,
  runEventSchema,
  startRunRequestSchema,
  revisePrototypeRevisionRequestSchema,
  prototypeRevisionDiffSchema,
  prototypePlanListSchema,
  prototypeFeedbackListSchema,
  prototypeShareListSchema,
  prototypeExportListSchema,
  type RevisePrototypeRevisionRequest,
  createPrototypeExportRequestSchema,
  createPrototypeFeedbackRequestSchema,
  createPrototypePlanRequestSchema,
  createPrototypeShareRequestSchema,
  exportPreviewTokenResponseSchema,
  prototypeExportSchema,
  prototypeFeedbackSchema,
  prototypePublicShareSchema,
  prototypePlanSchema,
  prototypeRevisionSchema,
  prototypeRevisionSummarySchema,
  prototypeRevisionListSchema,
  prototypeShareSchema,
  prototypeWorkflowActionRequestSchema,
  type CreatePrototypeExportRequest,
  type CreatePrototypeFeedbackRequest,
  type CreatePrototypePlanRequest,
  type CreatePrototypeShareRequest,
  type PrototypeExport,
  type PrototypeFeedback,
  type PrototypePlan,
  type PrototypeRevision,
  type PrototypeRevisionSummary,
  type PrototypePublicShare,
  type PrototypeShare,
  type PrototypeWorkflowActionRequest,
} from "@workbench/workbench-contracts";
import { Prisma } from "@workbench/workbench-db";
import { forbiddenProblem, idempotencyConflictProblem, notFoundProblem, preconditionRequiredProblem, revisionConflictProblem, ProblemException } from "../../common/problem-details.js";
import { WorkbenchDbService } from "../../platform/database/workbench-db.service.js";
import type { AuthenticatedPrincipal } from "../identity/identity.types.js";
import { lockActiveProject } from "../projects/project-lock.js";
import { prototypeRevisionPageDifferences } from "./prototype-revision-diff.js";
import { formatPrototypeReviewPrompt, prototypePlanDisplayPrompt } from "./prototype-plan-presentation.js";
import { mapRun, orderedRunSourceSnapshots } from "../runs/run.mapper.js";
import { RunsService } from "../runs/runs.service.js";
import { enqueuePrototypeCommand, PrototypeWorkflowDispatcher } from "./prototype-workflow-dispatcher.js";
import { PrototypeArtifactStorageReader } from "./prototype-artifact-storage.reader.js";

const revisionSummarySelect = {
  id: true, projectId: true, planId: true, version: true, sourceRevisionId: true,
  revision: true, status: true, title: true, documentSha256: true, createdById: true,
  createdAt: true, updatedAt: true, failureCode: true, failureDetail: true,
} satisfies Prisma.PrototypeRevisionSelect;
const frozenPreviewSelect = { builtArtifactKey: true, builtArtifactSha256: true, builtArtifactByteSize: true, builtArtifactMediaType: true } satisfies Prisma.PrototypeRevisionSelect;
type RevisionSummaryRow = Prisma.PrototypeRevisionGetPayload<{ select: typeof revisionSummarySelect }>;
type FrozenPreviewManifest = {
  builtArtifactKey: string | null; builtArtifactSha256: string | null;
  builtArtifactByteSize: number | null; builtArtifactMediaType: string | null;
};

export interface PrototypeWorkflowClientPort {
  readonly configured: boolean;
  startPlan(input: { projectId: string; planId: string; principalId: string }): Promise<void>;
  cancelPlan(input: { projectId: string; planId: string }): Promise<void>;
  startExport(input: { projectId: string; exportId: string; revisionId: string; format: "html" | "react"; commandId: string }): Promise<void>;
  cancelExport(input: { projectId: string; exportId: string; commandId: string }): Promise<void>;
  executePreviewFreeze?: (input: { projectId: string; revisionId: string }) => Promise<{ ok: boolean; documentSha256?: string; code?: string }>;
  executeShareCreate?: (input: { projectId: string; revisionId: string; createdById: string; tokenHash: string; idempotencyKey: string; requestHash: string; expiresAt: string | null }) => Promise<{ id: string; revision: number; status: "active" | "revoked" | "expired" }>;
  executeShareRevoke?: (input: { projectId: string; shareId: string; expectedRevision: number; idempotencyKey: string; commandId: string; createdById: string }) => Promise<{ ok: boolean; revision?: number; status?: "revoked" | "active" }>;
}

@Injectable()
export class PrototypeWorkflowClient implements PrototypeWorkflowClientPort {
  private readonly startUrl: string | undefined;
  private readonly cancelUrl: string | undefined;
  private readonly executeUrl: string | undefined;

  constructor(config: ConfigService) {
    this.startUrl = config.get<string>("WORKBENCH_TEMPORAL_WORKFLOW_START_URL")?.trim() || undefined;
    this.cancelUrl = config.get<string>("WORKBENCH_TEMPORAL_WORKFLOW_CANCEL_URL")?.trim() || undefined;
    this.executeUrl = config.get<string>("WORKBENCH_TEMPORAL_WORKFLOW_EXECUTE_URL")?.trim()
      || (this.startUrl ? this.startUrl.replace(/\/workflows\/start$/u, "/workflows/execute") : undefined);
  }

  get configured(): boolean {
    return Boolean(this.startUrl && this.cancelUrl && this.executeUrl);
  }

  async startPlan(input: { projectId: string; planId: string; principalId: string }): Promise<void> {
    await this.post(this.startUrl, { workflow: "visualPrototypeGeneration", ...input });
  }

  async cancelPlan(input: { projectId: string; planId: string }): Promise<void> {
    await this.post(this.cancelUrl, { workflow: "visualPrototypeGeneration", ...input });
  }

  async startExport(input: { projectId: string; exportId: string; revisionId: string; format: "html" | "react"; commandId: string }): Promise<void> {
    await this.post(this.startUrl, { workflow: "visualPrototypeExport", ...input });
  }

  async cancelExport(input: { projectId: string; exportId: string; commandId: string }): Promise<void> {
    await this.post(this.cancelUrl, { workflow: "visualPrototypeExport", ...input });
  }

  async executePreviewFreeze(input: { projectId: string; revisionId: string }) {
    return this.execute({ workflow: "visualPrototypeShare", action: "freeze", ...input, idempotencyKey: `preview-freeze-${input.revisionId}` }) as Promise<{ ok: boolean; documentSha256?: string; code?: string }>;
  }

  async executeShareCreate(input: { projectId: string; revisionId: string; createdById: string; tokenHash: string; idempotencyKey: string; requestHash: string; expiresAt: string | null }) {
    return this.execute({ workflow: "visualPrototypeShare", action: "create", ...input }) as Promise<{ id: string; revision: number; status: "active" | "revoked" | "expired" }>;
  }

  async executeShareRevoke(input: { projectId: string; shareId: string; expectedRevision: number; idempotencyKey: string; commandId: string; createdById: string }) {
    return this.execute({ workflow: "visualPrototypeShare", action: "revoke", ...input }) as Promise<{ ok: boolean; revision?: number; status?: "revoked" | "active" }>;
  }

  private async post(url: string | undefined, payload: unknown): Promise<void> {
    if (!url) throw temporalUnavailable();
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(25_000) });
    if (!response.ok) throw new ProblemException({ title: "Temporal workflow unavailable", status: 503, detail: `Workflow gateway returned ${response.status}`, code: "TEMPORAL_WORKFLOW_UNAVAILABLE" });
  }

  private async execute(payload: unknown): Promise<unknown> {
    if (!this.executeUrl) throw temporalUnavailable();
    const response = await fetch(this.executeUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(25_000) });
    const text = await response.text();
    let value: unknown;
    try { value = JSON.parse(text); } catch { value = undefined; }
    if (!response.ok) throw new ProblemException({ title: "Temporal workflow unavailable", status: 503, detail: `Workflow gateway returned ${response.status}`, code: "TEMPORAL_WORKFLOW_UNAVAILABLE" });
    return value;
  }
}

@Injectable()
export class PrototypeV2Service implements OnModuleInit, OnModuleDestroy {
  private deliveryTimer?: ReturnType<typeof setInterval>;
  private delivery: Promise<void> | undefined;
  constructor(
    private readonly db: WorkbenchDbService,
    @Inject("PrototypeWorkflowClientPort") private readonly workflows: PrototypeWorkflowClientPort,
    private readonly config: ConfigService,
    private readonly artifactStorage: PrototypeArtifactStorageReader,
    @Optional() private readonly runs?: RunsService,
  ) {}

  onModuleInit(): void {
    this.deliveryTimer = setInterval(() => { if (!this.delivery) void this.dispatchPendingCommands().catch(() => undefined); }, 1_000);
    this.deliveryTimer.unref();
    void this.dispatchPendingCommands().catch(() => undefined);
  }
  onModuleDestroy(): void { if (this.deliveryTimer) clearInterval(this.deliveryTimer); }
  async dispatchPendingCommands(projectId?: string): Promise<void> {
    const operation = (this.delivery ?? Promise.resolve()).catch(() => undefined).then(() => new PrototypeWorkflowDispatcher(this.db, this.workflows).deliver(projectId));
    this.delivery = operation;
    try { await operation; } finally { if (this.delivery === operation) this.delivery = undefined; }
  }

  async createPlan(principal: AuthenticatedPrincipal, projectId: string, request: CreatePrototypePlanRequest, idempotencyKey: string): Promise<PrototypePlan> {
    request = createPrototypePlanRequestSchema.parse(request);
    await this.requireProjectMember(principal.id, projectId, "editor");
    return this.mutate(projectId, projectId, principal.id, "plan_create", idempotencyKey, request, async (tx, requestHash) => {
      const existing = await tx.prototypePlan.findFirst({ where: { projectId, idempotencyKey } });
      if (existing) { assertRequestHash(existing.requestHash, requestHash); return toPlan(existing); }
      if (request.generationRequest && request.generationRequest.prompt !== request.prompt) throw new ProblemException({ title: "Conflicting prompt", status: 400, detail: "The plan prompt must match its generation request", code: "PROTOTYPE_PROMPT_MISMATCH" });
      if (!this.runs) throw temporalUnavailable();
      const inputSnapshot=await this.runs.capturePrototypeInput(tx,projectId,request.generationRequest);
      const row = await tx.prototypePlan.create({ data: { id: `plan_${randomBytes(12).toString("hex")}`, projectId, createdById: principal.id, title: request.title, prompt: request.prompt, generationRequest: request.generationRequest as Prisma.InputJsonValue | undefined, inputSnapshot:inputSnapshot as Prisma.InputJsonValue, status: "draft", revision: 0, idempotencyKey, requestHash } });
      return toPlan(row);
    });
  }

  async getPlanSnapshot(principal: AuthenticatedPrincipal, projectId: string, planId: string): Promise<PrototypePlan> {
    await this.requireProjectMember(principal.id, projectId, "viewer");
    return toPlan(await this.getPlan(projectId, planId));
  }

  async getPlanInput(principal:AuthenticatedPrincipal,projectId:string,planId:string){
    await this.requireProjectMember(principal.id,projectId,"viewer");
    return this.db.$transaction(async tx=>{
      const plan=await tx.prototypePlan.findFirst({where:{id:planId,projectId}});
      if(!plan)throw notFoundProblem("Prototype plan");
      return this.readPlanInput(tx,plan);
    },{isolationLevel:Prisma.TransactionIsolationLevel.RepeatableRead});
  }

  async getRevisionInput(principal:AuthenticatedPrincipal,projectId:string,revisionId:string){
    await this.requireProjectMember(principal.id,projectId,"viewer");
    return this.db.$transaction(async tx=>{
      const source=await tx.prototypeRevision.findFirst({where:{id:revisionId,projectId}});
      if(!source)throw notFoundProblem("Prototype revision");
      const input=await this.readPlanInput(tx,await this.sourceGenerationPlan(tx,source));
      if(!this.runs)throw temporalUnavailable();
      const modificationRequest=await this.runs.resolvePrototypeRevisionRequest(tx,projectId,revisionId,input.request);
      return prototypeRevisionInputSchema.parse({...input,modificationRequest});
    },{isolationLevel:Prisma.TransactionIsolationLevel.RepeatableRead});
  }

  async updatePlan(principal:AuthenticatedPrincipal,projectId:string,planId:string,request:UpdatePrototypePlanRequest,key:string,ifMatch?:string){
    request=updatePrototypePlanRequestSchema.parse(request);
    await this.requireProjectMember(principal.id,projectId,"editor");
    return this.mutate(projectId,planId,principal.id,"plan_update",key,request,async tx=>{
      const plan=await tx.prototypePlan.findFirst({where:{id:planId,projectId}});
      if(!plan)throw notFoundProblem("Prototype plan");
      assertIfMatch(ifMatch,plan.revision);
      if(plan.status!=="draft"||plan.runtimeRunId)throw new ProblemException({title:"Plan input is frozen",status:409,code:"PROTOTYPE_PLAN_INPUT_FROZEN"});
      if(request.prompt!==request.generationRequest.prompt)throw new ProblemException({title:"Conflicting prompt",status:400,code:"PROTOTYPE_PROMPT_MISMATCH"});
      if(plan.sourceRevisionId&&canonicalJson(request.generationRequest.requestedArtifactKinds)!==canonicalJson(["prototype"]))throw new ProblemException({title:"Modification output must be prototype",status:400,code:"PROTOTYPE_REVISION_OUTPUT_MISMATCH"});
      if(!this.runs)throw temporalUnavailable();
      const previous=await this.readPlanInput(tx,plan);
      const effective=plan.sourceRevisionId?await this.runs.resolvePrototypeRevisionRequest(tx,projectId,plan.sourceRevisionId,request.generationRequest):request.generationRequest;
      const inputSnapshot=await this.runs.capturePrototypeInput(tx,projectId,effective,previous);
      const generationRequest=await this.withPlanFeedback(tx,projectId,plan.sourceRevisionId,plan.feedbackIds,effective);
      const updated=await tx.prototypePlan.updateMany({where:{id:planId,projectId,status:"draft",revision:plan.revision,runtimeRunId:null},data:{title:request.title,prompt:request.prompt,generationRequest:generationRequest as Prisma.InputJsonValue,inputSnapshot:inputSnapshot as Prisma.InputJsonValue,revision:{increment:1}}});
      if(updated.count!==1)throw revisionConflictProblem();
      return toPlan(await tx.prototypePlan.findUniqueOrThrow({where:{id:planId}}));
    });
  }

  async createRevisionPlan(principal:AuthenticatedPrincipal,projectId:string,revisionId:string,request:CreatePrototypeRevisionPlanRequest,key:string,ifMatch?:string){
    request=createPrototypeRevisionPlanRequestSchema.parse(request);
    await this.requireProjectMember(principal.id,projectId,"editor");
    return this.mutate(projectId,revisionId,principal.id,"revision_plan",key,request,async(tx,requestHash)=>{
      const source=await tx.prototypeRevision.findFirst({where:{id:revisionId,projectId}});
      if(!source)throw notFoundProblem("Prototype revision");
      assertIfMatch(ifMatch,source.revision);
      if(!["ready","confirmed","rejected"].includes(source.status))throw revisionConflictProblem();
      if(request.prompt!==request.generationRequest.prompt)throw new ProblemException({title:"Conflicting prompt",status:400,code:"PROTOTYPE_PROMPT_MISMATCH"});
      await tx.$queryRaw(Prisma.sql`SELECT id FROM prototype_plans WHERE id = ${source.planId} AND project_id = ${projectId} FOR UPDATE`);
      if(canonicalJson(request.generationRequest.requestedArtifactKinds)!==canonicalJson(["prototype"]))throw new ProblemException({title:"Modification output must be prototype",status:400,code:"PROTOTYPE_REVISION_OUTPUT_MISMATCH"});
      const original=await this.sourceGenerationPlan(tx,source),previous=await this.readPlanInput(tx,original);
      if(!this.runs)throw temporalUnavailable();
      const selected=await tx.prototypeFeedback.findMany({where:{id:{in:request.feedbackIds},projectId,revisionId,status:"open"}});
      if(selected.length!==request.feedbackIds.length)throw notFoundProblem("Open feedback on source revision");
      const effective=await this.runs.resolvePrototypeRevisionRequest(tx,projectId,revisionId,request.generationRequest);
      const inputSnapshot=await this.runs.capturePrototypeInput(tx,projectId,effective,previous);
      const latest=await tx.prototypePlan.aggregate({where:{projectId,OR:[{id:source.planId},{rootPlanId:source.planId}]},_max:{contentVersion:true}});
      const latestRevision=await tx.prototypeRevision.aggregate({where:{projectId,planId:source.planId},_max:{version:true}});
      const generationRequest=await this.withPlanFeedback(tx,projectId,revisionId,request.feedbackIds,effective);
      const row=await tx.prototypePlan.create({data:{id:`plan_${randomBytes(12).toString("hex")}`,projectId,createdById:principal.id,rootPlanId:source.planId,sourceRevisionId:revisionId,contentVersion:Math.max(latest._max.contentVersion??1,latestRevision._max.version??1)+1,title:request.title,prompt:request.prompt,feedbackIds:request.feedbackIds,generationRequest:generationRequest as Prisma.InputJsonValue,inputSnapshot:inputSnapshot as Prisma.InputJsonValue,status:"draft",revision:0,idempotencyKey:`revision-plan:${hashRequest({principalId:principal.id,revisionId,key}).slice(0,48)}`,requestHash}});
      return toPlan(row);
    });
  }

  private async withPlanFeedback(tx:Prisma.TransactionClient,projectId:string,revisionId:string|null,feedbackIds:Prisma.JsonValue,request:import("@workbench/workbench-contracts").StartRunRequest){
    if(!revisionId||!Array.isArray(feedbackIds)||!feedbackIds.length)return request;
    const feedback=await tx.prototypeFeedback.findMany({where:{id:{in:feedbackIds as string[]},projectId,revisionId},orderBy:[{createdAt:"asc"},{id:"asc"}]});
    return startRunRequestSchema.parse({...request,prompt:[request.prompt,...feedback.map(item=>`Review ${item.id}: ${item.body} ${item.anchor?canonicalJson(item.anchor):""}`)].join("\n")});
  }

  private async sourceGenerationPlan(tx:Prisma.TransactionClient,source:{projectId:string;planId:string;version:number}){
    const plan=await tx.prototypePlan.findFirst({where:{projectId:source.projectId,contentVersion:source.version,OR:[{id:source.planId},{rootPlanId:source.planId}]}});
    if(!plan)throw notFoundProblem("Source generation plan");
    return plan;
  }

  private async readPlanInput(tx:Prisma.TransactionClient,plan:Prisma.PrototypePlanGetPayload<{}>){
    if(!plan.generationRequest)throw new ProblemException({title:"Generation context unavailable",status:409,code:"PROTOTYPE_PLAN_CONTEXT_MISSING"});
    const runId=plan.runtimeRunId??plan.reusedRunId;
    const bound=runId&&this.runs?await this.runs.prototypeInputFromRun(tx,plan.projectId,runId):null;
    const request=bound?.request??startRunRequestSchema.parse(plan.generationRequest);
    const snapshot=bound?.snapshot??(plan.inputSnapshot?prototypeInputSnapshotSchema.parse(plan.inputSnapshot):null);
    return prototypePlanInputSchema.parse({plan:toPlan(plan),request,snapshot,sha256:hashRequest({request,snapshot})});
  }

  async getProgress(principal: AuthenticatedPrincipal, projectId: string, planId: string) {
    await this.requireProjectMember(principal.id, projectId, "viewer");
    return this.db.$transaction(async (tx) => {
      const plan = await tx.prototypePlan.findFirst({ where: { id: planId, projectId } });
      if (!plan) throw notFoundProblem("Prototype plan");
      const request = plan.generationRequest ? startRunRequestSchema.safeParse(plan.generationRequest) : null;
      const input = request?.success ? request.data : null;
      const runId = plan.runtimeRunId ?? plan.reusedRunId;
      const row = runId ? await tx.run.findFirst({ where: { id: runId, projectId }, include: { sourceSnapshots: orderedRunSourceSnapshots } }) : null;
      if (runId && !row) throw notFoundProblem("Prototype run");
      const run = row ? mapRun(row) : null;
      const seeds = row ? await tx.$queryRaw<Array<{ id: string; sequence: number; type: string; payload: unknown; occurredAt: Date }>>(Prisma.sql`
        SELECT id, sequence, type, payload, occurred_at AS "occurredAt" FROM (
          SELECT DISTINCT ON (type, COALESCE(payload->'preview'->>'artifactIndex', payload->>'artifactIndex', payload->>'activityId', ''))
            id, sequence, type, payload, occurred_at
          FROM run_events WHERE run_id = ${row.id} AND sequence <= ${row.eventSequence}
            AND sequence >= COALESCE((SELECT MAX(sequence) FROM run_events WHERE run_id = ${row.id} AND type = 'run.started' AND payload->>'attempt' = ${String(row.attempt)} AND sequence <= ${row.eventSequence}), 0)
            AND type IN ('artifact.preview.updated', 'artifact.draft.created', 'run.generation.stage.changed', 'activity.changed')
            AND (payload->>'attempt' IS NULL OR payload->>'attempt' = ${String(row.attempt)})
          ORDER BY type, COALESCE(payload->'preview'->>'artifactIndex', payload->>'artifactIndex', payload->>'activityId', ''), sequence DESC
        ) latest ORDER BY CASE WHEN type = 'activity.changed' THEN 1 ELSE 0 END, sequence DESC LIMIT 64
      `) : [];
      const events = row ? seeds.map((event) => runEventSchema.parse({ ...event, occurredAt: event.occurredAt.toISOString(), protocol: "workbench.run.v1", runId: row.id, projectId, threadId: row.threadId, requestId: row.requestId, traceId: row.traceId })).sort((a, b) => a.sequence - b.sequence) : [];
      const revision = await tx.prototypeRevision.findFirst({ where: { projectId, planId: plan.rootPlanId ?? plan.id, version: plan.contentVersion }, select: { id: true } });
      return prototypeProgressSchema.parse({ projectId, planId, status: plan.status, input: {
        requestedArtifactKinds: input?.requestedArtifactKinds ?? run?.requestedArtifactKinds ?? [],
        modelId: input?.modelId ?? run?.modelId ?? null,
        targetSurface: input?.targetSurface ?? run?.targetSurface ?? null,
        sourceIds: input?.sourceIds ?? [],
        designStyle: input?.designStyle ? JSON.stringify(input.designStyle).slice(0, 160) : null,
      }, run, events, coverage: "window", finalRevisionId: revision?.id ?? null });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  async listRevisions(principal: AuthenticatedPrincipal, projectId: string, planId: string) {
    await this.requireProjectMember(principal.id, projectId, "viewer");
    const plan = await this.getPlan(projectId, planId);
    const rows = await this.db.prototypeRevision.findMany({ where: { projectId, planId: plan.rootPlanId ?? plan.id }, select: revisionSummarySelect, orderBy: { version: "desc" }, take: 50 });
    return prototypeRevisionListSchema.parse(rows.reverse().map(toRevisionSummary));
  }

  async listPlans(principal: AuthenticatedPrincipal, projectId: string) {
    await this.requireProjectMember(principal.id, projectId, "viewer");
    return prototypePlanListSchema.parse((await this.db.prototypePlan.findMany({ where: { projectId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 100 })).map(toPlan));
  }
  async getRevision(principal: AuthenticatedPrincipal, projectId: string, revisionId: string) {
    await this.requireProjectMember(principal.id, projectId, "viewer");
    return this.requireRevisionWithPreview(projectId, revisionId);
  }
  async listFeedback(principal: AuthenticatedPrincipal, projectId: string, revisionId: string) {
    await this.requireProjectMember(principal.id, projectId, "viewer");
    if (!await this.db.prototypeRevision.findFirst({ where: { id: revisionId, projectId }, select: { id: true } })) throw notFoundProblem("Prototype revision");
    return prototypeFeedbackListSchema.parse((await this.db.prototypeFeedback.findMany({ where: { projectId, revisionId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 100 })).map(toFeedback));
  }
  async feedbackLocations(principal:AuthenticatedPrincipal,projectId:string,sourceRevisionId:string,targetRevisionId:string){
    await this.requireProjectMember(principal.id,projectId,"viewer");
    return this.db.$transaction(async tx=>{
      const source=await tx.prototypeRevision.findFirst({where:{id:sourceRevisionId,projectId}}),target=await tx.prototypeRevision.findFirst({where:{id:targetRevisionId,projectId}});
      if(!source||!target||source.planId!==target.planId)throw notFoundProblem("Prototype revision family");
      const feedback=await tx.prototypeFeedback.findMany({where:{projectId,revisionId:sourceRevisionId},orderBy:[{createdAt:"asc"},{id:"asc"}],take:100});
      const index=feedbackAnchorIndex(target);
      return prototypeFeedbackLocationsSchema.parse({sourceRevisionId,targetRevisionId,items:feedback.map(item=>resolveFeedbackLocation(toFeedback(item),targetRevisionId,index))});
    },{isolationLevel:Prisma.TransactionIsolationLevel.RepeatableRead});
  }

  async listShares(principal: AuthenticatedPrincipal, projectId: string) {
    await this.requireProjectMember(principal.id, projectId, "viewer");
    const rows = await this.db.prototypeShare.findMany({ where: { projectId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 100 });
    return prototypeShareListSchema.parse(await Promise.all(rows.map(async (row) => {
      const revision = await this.db.prototypeRevision.findFirst({ where: { projectId, id: row.revisionId }, select: { id: true, documentSha256: true } });
      if (!revision) throw notFoundProblem("Prototype revision");
      return toShare(row, this.webOrigin(), this.shareToken(projectId, row.createdById, row.idempotencyKey, revision.id, revision.documentSha256));
    })));
  }
  async listExports(principal: AuthenticatedPrincipal, projectId: string) {
    await this.requireProjectMember(principal.id, projectId, "viewer");
    return prototypeExportListSchema.parse((await this.db.prototypeExport.findMany({ where: { projectId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 100 })).map((row) => toExport(row, this.webOrigin())));
  }

  async approvePlan(principal: AuthenticatedPrincipal, projectId: string, planId: string, idempotencyKey: string, ifMatch: string | undefined, request: PrototypeWorkflowActionRequest): Promise<PrototypePlan> {
    prototypeWorkflowActionRequestSchema.parse(request);
    await this.requireProjectMember(principal.id, projectId, "editor");
    const result = await this.mutate(projectId, planId, principal.id, "plan_approve", idempotencyKey, request, async (tx) => {
      if (!this.workflows.configured) throw temporalUnavailable();
      const plan = await tx.prototypePlan.findFirst({ where: { id: planId, projectId } });
      if (!plan) throw notFoundProblem("Prototype plan");
      assertIfMatch(ifMatch, plan.revision);
      const updated = await tx.prototypePlan.updateMany({ where: { id: planId, projectId, revision: plan.revision, status: "draft" }, data: { status: "approved", revision: { increment: 1 } } });
      if (updated.count !== 1) throw revisionConflictProblem();
      await this.prepareRun(tx, plan);
      await enqueuePrototypeCommand(tx, projectId, planId, "plan_start", { principalId: principal.id });
      return toPlan(await tx.prototypePlan.findUniqueOrThrow({ where: { id: planId } }));
    });
    await this.dispatchPendingCommands(projectId);
    return prototypePlanSchema.parse(result);
  }

  async cancelPlan(principal: AuthenticatedPrincipal, projectId: string, planId: string, idempotencyKey: string, ifMatch: string | undefined, request: PrototypeWorkflowActionRequest): Promise<PrototypePlan> {
    prototypeWorkflowActionRequestSchema.parse(request);
    await this.requireProjectMember(principal.id, projectId, "editor");
    const result = await this.mutate(projectId, planId, principal.id, "plan_cancel", idempotencyKey, request, async (tx) => {
      if (!this.workflows.configured) throw temporalUnavailable();
      const plan = await tx.prototypePlan.findFirst({ where: { id: planId, projectId } });
      if (!plan) throw notFoundProblem("Prototype plan");
      assertIfMatch(ifMatch, plan.revision);
      if (!["approved", "generating", "cancelled"].includes(plan.status)) throw revisionConflictProblem();
      if (plan.status !== "cancelled") await enqueuePrototypeCommand(tx, projectId, planId, "plan_cancel", {});
      // This immutable accepted response is not a cancellation acknowledgement.
      // The worker alone persists cancelled after provider cleanup converges.
      return toPlan(plan);
    });
    await this.dispatchPendingCommands(projectId);
    return prototypePlanSchema.parse(result);
  }

  async retryPlan(principal: AuthenticatedPrincipal, projectId: string, planId: string, idempotencyKey: string, ifMatch: string | undefined, request: PrototypeWorkflowActionRequest): Promise<PrototypePlan> {
    prototypeWorkflowActionRequestSchema.parse(request);
    await this.requireProjectMember(principal.id, projectId, "editor");
    const result = await this.mutate(projectId, planId, principal.id, "plan_retry", idempotencyKey, request, async (tx, requestHash) => {
      if (!this.workflows.configured || !this.runs) throw temporalUnavailable();
      const original = await tx.prototypePlan.findFirst({ where: { id: planId, projectId } });
      if (!original) throw notFoundProblem("Prototype plan");
      assertIfMatch(ifMatch, original.revision);
      if (!["failed", "cancelled"].includes(original.status) || !(original.runtimeRunId ?? original.reusedRunId)) throw revisionConflictProblem();
      const pinnedRun = await tx.run.findUniqueOrThrow({ where: { id: (original.runtimeRunId ?? original.reusedRunId)! } });
      const reuse = pinnedRun.status === "succeeded";
      if (reuse && await tx.artifactVersion.count({ where: { projectId, createdByRunId: pinnedRun.id, status: "ready", schemaVersion: 1, artifact: { kind: "prototype" } } }) !== 1) throw revisionConflictProblem();
      const rootPlanId = original.rootPlanId ?? original.id;
      await tx.$queryRaw(Prisma.sql`SELECT id FROM prototype_plans WHERE id = ${rootPlanId} AND project_id = ${projectId} FOR UPDATE`);
      const lastPlan = await tx.prototypePlan.findFirst({ where: { projectId, OR: [{ id: rootPlanId }, { rootPlanId }] }, orderBy: { contentVersion: "desc" } });
      const lastRevision = await tx.prototypeRevision.findFirst({ where: { projectId, planId: rootPlanId }, orderBy: { version: "desc" } });
      const generationRequest = startRunRequestSchema.parse(pinnedRun.request);
      const plan = await tx.prototypePlan.create({ data: { id: `plan_${randomBytes(12).toString("hex")}`, projectId, createdById: principal.id, rootPlanId, retryOfPlanId: original.id, reusedRunId: reuse ? pinnedRun.id : null, sourceRevisionId: original.sourceRevisionId, feedbackIds: original.feedbackIds as Prisma.InputJsonValue, contentVersion: Math.max(lastPlan?.contentVersion ?? 1, lastRevision?.version ?? 1) + 1, title: original.title, prompt: prototypePlanDisplayPrompt(original), generationRequest: generationRequest as Prisma.InputJsonValue, status: "approved", revision: 0, idempotencyKey: `retry:${hashRequest({ principalId: principal.id, planId, idempotencyKey }).slice(0, 48)}`, requestHash } });
      if (!reuse) {
      const runId = await this.runs.preparePrototypeRun(tx, { projectId, principalId: principal.id, planId: plan.id, title: plan.title, request: generationRequest, sourceRevisionId: plan.sourceRevisionId, pinnedRunId: pinnedRun.id });
      await tx.prototypePlan.update({ where: { id: plan.id }, data: { runtimeRunId: runId } });
      }
      await enqueuePrototypeCommand(tx, projectId, plan.id, "plan_start", { principalId: principal.id });
      return toPlan(plan);
    });
    await this.dispatchPendingCommands(projectId);
    return prototypePlanSchema.parse(result);
  }

  async getRevisionDiff(principal: AuthenticatedPrincipal, projectId: string, revisionId: string) {
    await this.requireProjectMember(principal.id, projectId, "viewer");
    const current = await this.db.prototypeRevision.findFirst({ where: { id: revisionId, projectId } });
    if (!current) throw notFoundProblem("Prototype revision");
    const base = current.sourceRevisionId ? await this.db.prototypeRevision.findFirst({ where: { id: current.sourceRevisionId, projectId } }) : null;
    return prototypeRevisionDiffSchema.parse({ sourceRevisionId: current.sourceRevisionId, pages: prototypeRevisionPageDifferences(base ? { sourceDocument: base.sourceDocument, pages: toRevision(base).pages } : null, { sourceDocument: current.sourceDocument, pages: toRevision(current).pages }) });
  }

  async revise(principal: AuthenticatedPrincipal, projectId: string, revisionId: string, request: RevisePrototypeRevisionRequest, idempotencyKey: string, ifMatch?: string): Promise<PrototypePlan> {
    request = revisePrototypeRevisionRequestSchema.parse(request);
    await this.requireProjectMember(principal.id, projectId, "editor");
    const result = await this.mutate(projectId, revisionId, principal.id, "revision_revise", idempotencyKey, request, async (tx, requestHash) => {
      if (!this.workflows.configured) throw temporalUnavailable();
      const source = await tx.prototypeRevision.findFirst({ where: { id: revisionId, projectId } });
      if (!source) throw notFoundProblem("Prototype revision");
      assertIfMatch(ifMatch, source.revision);
      if (!["ready", "confirmed", "rejected"].includes(source.status)) throw revisionConflictProblem();
      await tx.$queryRaw(Prisma.sql`SELECT id FROM prototype_plans WHERE id = ${source.planId} AND project_id = ${projectId} FOR UPDATE`);
      const root = await tx.prototypePlan.findUniqueOrThrow({ where: { id: source.planId } });
      const feedback = await tx.prototypeFeedback.findMany({ where: { id: { in: request.feedbackIds }, projectId, revisionId, status: "open" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
      if (feedback.length !== request.feedbackIds.length) throw notFoundProblem("Open feedback on source revision");
      const lastPlan = await tx.prototypePlan.findFirst({ where: { projectId, OR: [{ id: root.id }, { rootPlanId: root.id }] }, orderBy: { contentVersion: "desc" } });
      const lastRevision = await tx.prototypeRevision.findFirst({ where: { projectId, planId: root.id }, orderBy: { version: "desc" } });
      const contentVersion = Math.max(lastPlan?.contentVersion ?? 1, lastRevision?.version ?? 1) + 1;
      const prompt = [request.prompt ?? "Revise the prototype according to the following review feedback. Preserve unrelated screens and interactions.", ...feedback.map((item) => JSON.stringify({ id: item.id, body: item.body, anchor: item.anchor }))].join("\n");
      if (prompt.length > 20_000) throw new ProblemException({ title: "Feedback selection too large", status: 400, detail: "Choose fewer comments so the revision request fits 20,000 characters", code: "PROTOTYPE_REVISION_PROMPT_TOO_LARGE" });
      const sourcePlan=await this.sourceGenerationPlan(tx,source);
      const sourceInput=await this.readPlanInput(tx,sourcePlan);
      if (!sourcePlan.generationRequest) throw new ProblemException({ title: "Generation context unavailable", status: 409, detail: "This revision has no pinned generation context", code: "PROTOTYPE_REVISION_CONTEXT_MISSING" });
      const generationRequest = { ...sourceInput.request, prompt };
      const plan = await tx.prototypePlan.create({ data: { id: `plan_${randomBytes(12).toString("hex")}`, projectId, createdById: principal.id, rootPlanId: root.id, sourceRevisionId: revisionId, feedbackIds: request.feedbackIds, contentVersion, title: source.title, prompt: formatPrototypeReviewPrompt(request.prompt, feedback, source.pages), generationRequest: generationRequest as Prisma.InputJsonValue | undefined, inputSnapshot:(sourceInput.snapshot??undefined) as Prisma.InputJsonValue|undefined, status: "approved", revision: 0, idempotencyKey: `revise:${hashRequest({ principalId: principal.id, revisionId, idempotencyKey }).slice(0, 48)}`, requestHash } });
      await this.prepareRun(tx, plan);
      await enqueuePrototypeCommand(tx, projectId, plan.id, "plan_start", { principalId: principal.id });
      return toPlan(plan);
    });
    await this.dispatchPendingCommands(projectId);
    return prototypePlanSchema.parse(result);
  }

  async confirmRevision(principal: AuthenticatedPrincipal, projectId: string, revisionId: string, idempotencyKey: string, ifMatch: string | undefined, request: PrototypeWorkflowActionRequest): Promise<PrototypeRevision> {
    return this.reviewRevision(principal, projectId, revisionId, idempotencyKey, ifMatch, request, "confirmed");
  }

  async rejectRevision(principal: AuthenticatedPrincipal, projectId: string, revisionId: string, idempotencyKey: string, ifMatch: string | undefined, request: PrototypeWorkflowActionRequest): Promise<PrototypeRevision> {
    return this.reviewRevision(principal, projectId, revisionId, idempotencyKey, ifMatch, request, "rejected");
  }

  async createFeedback(principal: AuthenticatedPrincipal, projectId: string, revisionId: string, request: CreatePrototypeFeedbackRequest, idempotencyKey: string): Promise<PrototypeFeedback> {
    request=createPrototypeFeedbackRequestSchema.parse(request);
    await this.requireProjectMember(principal.id, projectId, "editor");
    return this.mutate(projectId, revisionId, principal.id, "feedback_create", idempotencyKey, { revisionId, ...request }, async (tx, requestHash) => {
      const revision = await tx.prototypeRevision.findFirst({ where: { id: revisionId, projectId } });
      if (!revision) throw notFoundProblem("Prototype revision");
      if (request.anchor) {
        if(request.anchor.sourceRevisionId!==revisionId)throw new ProblemException({title:"Feedback source revision does not match",status:400,code:"PROTOTYPE_FEEDBACK_SOURCE_MISMATCH"});
        const index=feedbackAnchorIndex(revision);
        if(!index.pages.has(request.anchor.pageId))throw notFoundProblem("Prototype feedback page");
        if(request.anchor.scope==="node"&&index.nodes?.get(request.anchor.nodeId)!==request.anchor.pageId)throw new ProblemException({title:"Prototype feedback element not found",status:404,code:"PROTOTYPE_FEEDBACK_NODE_NOT_FOUND"});
      }
      const existing = await tx.prototypeFeedback.findFirst({ where: { projectId, createdById: principal.id, idempotencyKey } });
      if (existing) { assertRequestHash(existing.requestHash, requestHash); return toFeedback(existing); }
      return toFeedback(await tx.prototypeFeedback.create({ data: { id: `feedback_${randomBytes(12).toString("hex")}`, projectId, revisionId, createdById: principal.id, body: request.body, anchor: request.anchor ? request.anchor as Prisma.InputJsonValue : Prisma.JsonNull, status: "open", revision: 0, idempotencyKey, requestHash } }));
    });
  }

  async resolveFeedback(principal: AuthenticatedPrincipal, projectId: string, feedbackId: string, idempotencyKey: string, ifMatch: string | undefined, request: PrototypeWorkflowActionRequest): Promise<PrototypeFeedback> {
    prototypeWorkflowActionRequestSchema.parse(request);
    await this.requireProjectMember(principal.id, projectId, "editor");
    return this.mutate(projectId, feedbackId, principal.id, "feedback_resolve", idempotencyKey, request, async (tx) => {
      const feedback = await tx.prototypeFeedback.findFirst({ where: { id: feedbackId, projectId } });
      if (!feedback) throw notFoundProblem("Prototype feedback");
      assertIfMatch(ifMatch, feedback.revision);
      const update = await tx.prototypeFeedback.updateMany({ where: { id: feedbackId, projectId, revision: feedback.revision, status: "open" }, data: { status: "resolved", resolvedAt: new Date(), revision: { increment: 1 } } });
      if (update.count !== 1) throw revisionConflictProblem();
      return toFeedback(await tx.prototypeFeedback.findUniqueOrThrow({ where: { id: feedbackId } }));
    });
  }

  async createShare(principal: AuthenticatedPrincipal, projectId: string, request: CreatePrototypeShareRequest, idempotencyKey: string): Promise<PrototypeShare> {
    createPrototypeShareRequestSchema.parse(request);
    await this.requireProjectMember(principal.id, projectId, "editor");
    const reserved = await this.reserveExternal(projectId, projectId, principal.id, "share_create", idempotencyKey, request, async (tx, requestHash) => {
      if (!this.workflows.configured || !this.workflows.executeShareCreate) throw temporalUnavailable();
      const revision = await tx.prototypeRevision.findFirst({ where: { id: request.revisionId, projectId } });
      if (!revision) throw notFoundProblem("Prototype revision");
      requireReadyRevision(revision.status);
      return { revisionId: request.revisionId, principalId: principal.id, tokenHash: hashSecret(this.shareToken(projectId, principal.id, idempotencyKey, revision.id, revision.documentSha256)), idempotencyKey, requestHash, expiresAt: request.expiresAt ?? "" };
    });
    if (reserved.replay) return prototypeShareSchema.parse(reserved.replay);
    await this.dispatchPendingCommands(projectId);
    const command = await this.db.prototypeWorkflowCommand.findUniqueOrThrow({ where: { id: reserved.commandId } });
    if (!command.deliveredAt) throw temporalUnavailable();
    const outcome = command.result as { id?: string; status?: string } | null;
    if (!outcome?.id) throw new ProblemException({ title: "Prototype share unavailable", status: 409, detail: "The frozen revision could not be shared", code: "PROTOTYPE_SHARE_WORKFLOW_INCOMPLETE" });
    return this.mutate(projectId, projectId, principal.id, "share_create", idempotencyKey, request, async (tx) => {
      const row = await tx.prototypeShare.findFirst({ where: { id: outcome.id, projectId, createdById: principal.id } });
      if (!row) throw notFoundProblem("Prototype share");
      const revision = await tx.prototypeRevision.findUniqueOrThrow({ where: { id: row.revisionId } });
      // Reconstruct the original creation response even if its acknowledgement
      // was lost and someone revoked the share before this retry.
      return toShare({ ...row, status: "active", revision: 0, revokedAt: null }, this.webOrigin(), this.shareToken(projectId, principal.id, idempotencyKey, revision.id, revision.documentSha256));
    });
  }

  async createPreviewToken(principal: AuthenticatedPrincipal, projectId: string, revisionId: string) {
    await this.requireProjectMember(principal.id, projectId, "viewer");
    const revision = await this.db.prototypeRevision.findFirst({ where: { id: revisionId, projectId }, select: { status: true, documentSha256: true } });
    if (!revision) throw notFoundProblem("Prototype revision");
    requireReadyRevision(revision.status);
    if (this.workflows.executePreviewFreeze) {
      const frozen = await this.workflows.executePreviewFreeze({ projectId, revisionId });
      if (!frozen.ok) throw new ProblemException({ title: "Prototype preview unavailable", status: 409, detail: frozen.code || "Prototype preview could not be frozen", code: frozen.code || "PROTOTYPE_PREVIEW_FREEZE_FAILED" });
    }
    const row = await this.db.prototypeRevision.findFirst({ where: { id: revisionId, projectId }, select: frozenPreviewSelect });
    if (!row?.builtArtifactKey || !row.builtArtifactSha256 || !row.builtArtifactByteSize || !row.builtArtifactMediaType) throw new ProblemException({ title: "Preview build unavailable", status: 409, detail: "The revision has no immutable checked preview artifact", code: "PROTOTYPE_PREVIEW_NOT_FROZEN" });
    const expiresAt = new Date(Date.now() + previewTokenTtlMs(this.config));
    const token = createPrototypePreviewToken({ projectId, revisionId, documentSha256: revision.documentSha256, artifactSha256: row.builtArtifactSha256, expiresAt }, this.previewTokenSecret());
    return exportPreviewTokenResponseSchema.parse({ url: `${this.webOrigin().replace(/\/$/u, "")}/api/v1/public/prototype-v2/previews/${token}`, expiresAt: expiresAt.toISOString() });
  }

  async getPreviewHtml(token: string): Promise<{ html: string; expiresAt: Date }> {
    const payload = verifyPrototypePreviewToken(token, this.previewTokenSecret());
    if (payload.expiresAt.getTime() <= Date.now()) throw notFoundProblem("Prototype preview");
    const project = await this.db.project.findFirst({ where: { id: payload.projectId, status: "active" }, select: { id: true } });
    const row = await this.db.prototypeRevision.findFirst({ where: { projectId: payload.projectId, id: payload.revisionId }, select: { ...frozenPreviewSelect, documentSha256: true, status: true } });
    if (!project || !row || row.documentSha256 !== payload.documentSha256 || row.builtArtifactSha256 !== payload.artifactSha256 || !row.builtArtifactKey || !row.builtArtifactByteSize || !["ready", "confirmed"].includes(row.status)) throw notFoundProblem("Prototype preview");
    return { html: await this.readFrozenPreview(row), expiresAt: payload.expiresAt };
  }

  private async readFrozenPreview(row: FrozenPreviewManifest): Promise<string> {
    if (!row.builtArtifactKey || !row.builtArtifactSha256 || !row.builtArtifactByteSize || !row.builtArtifactMediaType) throw new ProblemException({ title: "Preview build unavailable", status: 409, detail: "The revision has no immutable checked preview artifact", code: "PROTOTYPE_PREVIEW_NOT_FROZEN" });
    try {
      const object = await this.artifactStorage.getObject(row.builtArtifactKey);
      if (object.byteSize !== row.builtArtifactByteSize || object.sha256 !== row.builtArtifactSha256 || normalizeMediaType(object.mediaType) !== normalizeMediaType(row.builtArtifactMediaType)) throw new Error("PROTOTYPE_PREVIEW_INTEGRITY_FAILURE");
      const chunks: Buffer[] = []; let byteSize = 0;
      for await (const chunk of object.body) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        byteSize += bytes.length;
        if (byteSize > row.builtArtifactByteSize) throw new Error("PROTOTYPE_PREVIEW_SIZE_MISMATCH");
        chunks.push(bytes);
      }
      const body = Buffer.concat(chunks);
      if (body.length !== row.builtArtifactByteSize || createHash("sha256").update(body).digest("hex") !== row.builtArtifactSha256) throw new Error("PROTOTYPE_PREVIEW_INTEGRITY_FAILURE");
      return body.toString("utf8");
    } catch {
      throw new ProblemException({ title: "Preview artifact unavailable", status: 503, detail: "The immutable preview artifact could not be verified", code: "PROTOTYPE_PREVIEW_INTEGRITY_FAILURE" });
    }
  }

  /** Resolve an anonymous V2 share token without exposing stored token hashes. */
  async getPublicShare(token: string): Promise<PrototypePublicShare> {
    if (!/^wbp2_[A-Za-z0-9_-]{32,128}$/u.test(token)) throw notFoundProblem("Prototype share");
    const row = await this.db.prototypeShare.findFirst({ where: { tokenHash: hashSecret(token) } });
    if (!row || !(await this.db.project.findFirst({ where: { id: row.projectId, status: "active" }, select: { id: true } }))) throw notFoundProblem("Prototype share");
    if (row.status !== "active" || (row.expiresAt && row.expiresAt.getTime() <= Date.now())) {
      if (row.status === "active" && row.expiresAt) {
        await this.db.prototypeShare.updateMany({
          where: { id: row.id, status: "active", revision: row.revision },
          data: { status: "expired", revision: { increment: 1 } },
        });
      }
      throw notFoundProblem("Prototype share");
    }
    const revision = await this.requireRevisionWithPreview(row.projectId, row.revisionId);
    return prototypePublicShareSchema.parse({ share: toShare(row, this.webOrigin(), token), revision: toPublicRevision(revision) });
  }

  async revokeShare(principal: AuthenticatedPrincipal, projectId: string, shareId: string, idempotencyKey: string, ifMatch: string | undefined, request: PrototypeWorkflowActionRequest): Promise<PrototypeShare> {
    prototypeWorkflowActionRequestSchema.parse(request);
    await this.requireProjectMember(principal.id, projectId, "editor");
    const reserved = await this.reserveExternal(projectId, shareId, principal.id, "share_revoke", idempotencyKey, request, async (tx, requestHash) => {
      if (!this.workflows.configured || !this.workflows.executeShareRevoke) throw temporalUnavailable();
      const row = await tx.prototypeShare.findFirst({ where: { id: shareId, projectId } });
      if (!row) throw notFoundProblem("Prototype share");
      assertIfMatch(ifMatch, row.revision);
      if (row.status !== "active") throw revisionConflictProblem();
      return { principalId: principal.id, expectedRevision: String(row.revision), idempotencyKey, requestHash };
    });
    if (reserved.replay) return prototypeShareSchema.parse(reserved.replay);
    await this.dispatchPendingCommands(projectId);
    const command = await this.db.prototypeWorkflowCommand.findUniqueOrThrow({ where: { id: reserved.commandId } });
    if (!command.deliveredAt) throw temporalUnavailable();
    if (!(command.result as { ok?: boolean } | null)?.ok) throw revisionConflictProblem();
    return this.mutate(projectId, shareId, principal.id, "share_revoke", idempotencyKey, request, async (tx) => {
      const row = await tx.prototypeShare.findUniqueOrThrow({ where: { id: shareId } });
      const revision = await tx.prototypeRevision.findUniqueOrThrow({ where: { id: row.revisionId } });
      return toShare(row, this.webOrigin(), this.shareToken(projectId, row.createdById, row.idempotencyKey, revision.id, revision.documentSha256));
    });
  }

  async createExport(principal: AuthenticatedPrincipal, projectId: string, request: CreatePrototypeExportRequest, idempotencyKey: string): Promise<PrototypeExport> {
    createPrototypeExportRequestSchema.parse(request);
    await this.requireProjectMember(principal.id, projectId, "editor");
    const result = await this.mutate(projectId, projectId, principal.id, "export_create", idempotencyKey, request, async (tx, requestHash) => {
      if (!this.workflows.configured) throw temporalUnavailable();
      const revision = await tx.prototypeRevision.findFirst({ where: { id: request.revisionId, projectId } });
      if (!revision) throw notFoundProblem("Prototype revision");
      requireReadyRevision(revision.status);
      const exportId = `export_${randomBytes(12).toString("hex")}`;
      const activeCommandId = await enqueuePrototypeCommand(tx, projectId, exportId, "export_start", { revisionId: request.revisionId, format: request.format });
      const row = await tx.prototypeExport.create({ data: { id: exportId, projectId, revisionId: request.revisionId, createdById: principal.id, format: request.format, activeCommandId, status: "queued", revision: 0, idempotencyKey, requestHash } });
      return toExport(row, this.webOrigin());
    });
    await this.dispatchPendingCommands(projectId);
    return prototypeExportSchema.parse(result);
  }

  async getExport(principal: AuthenticatedPrincipal, projectId: string, exportId: string): Promise<PrototypeExport> {
    await this.requireProjectMember(principal.id, projectId, "viewer");
    return toExport(await this.requireExport(projectId, exportId), this.webOrigin());
  }

  async getExportContent(principal: AuthenticatedPrincipal, projectId: string, exportId: string) {
    await this.requireProjectMember(principal.id, projectId, "viewer");
    const row = await this.requireExport(projectId, exportId);
    if (row.status !== "succeeded" || !row.artifactKey || !row.byteSize || !row.mediaType) {
      throw new ProblemException({ title: "Export is not ready", status: 409, detail: "The prototype export has no downloadable artifact", code: "PROTOTYPE_EXPORT_NOT_READY" });
    }
    let object;
    try {
      object = await this.artifactStorage.getObject(row.artifactKey);
    } catch (error) {
      throw new ProblemException({ title: "Export artifact unavailable", status: 503, detail: error instanceof Error ? error.message : "The prototype artifact store is unavailable", code: "PROTOTYPE_EXPORT_STORAGE_UNAVAILABLE" });
    }
    if (object.byteSize !== row.byteSize || normalizeMediaType(object.mediaType) !== normalizeMediaType(row.mediaType) || object.sha256 !== row.artifactSha256) {
      throw new ProblemException({ title: "Export artifact integrity failure", status: 503, detail: "The immutable prototype artifact does not match its manifest", code: "PROTOTYPE_EXPORT_INTEGRITY_FAILURE" });
    }
    return { body: object.body, byteSize: object.byteSize, mediaType: row.mediaType, fileName: `${exportId}.${row.format === "react" ? "zip" : "html"}` };
  }

  async retryExport(principal: AuthenticatedPrincipal, projectId: string, exportId: string, idempotencyKey: string, ifMatch: string | undefined, request: PrototypeWorkflowActionRequest): Promise<PrototypeExport> {
    prototypeWorkflowActionRequestSchema.parse(request);
    await this.requireProjectMember(principal.id, projectId, "editor");
    const result = await this.mutate(projectId, exportId, principal.id, "export_retry", idempotencyKey, request, async (tx) => {
      if (!this.workflows.configured) throw temporalUnavailable();
      const row = await tx.prototypeExport.findFirst({ where: { id: exportId, projectId } });
      if (!row) throw notFoundProblem("Prototype export");
      assertIfMatch(ifMatch, row.revision);
      const activeCommandId = await enqueuePrototypeCommand(tx, projectId, row.id, "export_start", { revisionId: row.revisionId, format: row.format });
      const update = await tx.prototypeExport.updateMany({ where: { id: exportId, projectId, activeCommandId: row.activeCommandId, revision: row.revision, status: "failed" }, data: { activeCommandId, status: "queued", artifactKey: null, artifactSha256: null, byteSize: null, mediaType: null, failureCode: null, failureDetail: null, finishedAt: null, revision: { increment: 1 } } });
      if (update.count !== 1) throw revisionConflictProblem();
      return toExport(await tx.prototypeExport.findUniqueOrThrow({ where: { id: exportId } }), this.webOrigin());
    });
    await this.dispatchPendingCommands(projectId);
    return prototypeExportSchema.parse(result);
  }

  async cancelExport(principal: AuthenticatedPrincipal, projectId: string, exportId: string, idempotencyKey: string, ifMatch: string | undefined, request: PrototypeWorkflowActionRequest): Promise<PrototypeExport> {
    prototypeWorkflowActionRequestSchema.parse(request);
    await this.requireProjectMember(principal.id, projectId, "editor");
    const result = await this.mutate(projectId, exportId, principal.id, "export_cancel", idempotencyKey, request, async (tx) => {
      if (!this.workflows.configured) throw temporalUnavailable();
      const row = await tx.prototypeExport.findFirst({ where: { id: exportId, projectId } });
      if (!row) throw notFoundProblem("Prototype export");
      assertIfMatch(ifMatch, row.revision);
      if (!row.activeCommandId) throw new ProblemException({ title: "Export execution unavailable", status: 409, detail: "This export has no durable workflow command", code: "PROTOTYPE_EXPORT_EXECUTION_MISSING" });
      const update = await tx.prototypeExport.updateMany({ where: { id: exportId, projectId, activeCommandId: row.activeCommandId, revision: row.revision, status: { in: ["queued", "building"] } }, data: { status: "cancelled", artifactKey: null, artifactSha256: null, byteSize: null, mediaType: null, failureCode: null, failureDetail: null, finishedAt: new Date(), revision: { increment: 1 } } });
      if (update.count !== 1) throw revisionConflictProblem();
      await enqueuePrototypeCommand(tx, projectId, exportId, "export_cancel", { commandId: row.activeCommandId });
      return toExport(await tx.prototypeExport.findUniqueOrThrow({ where: { id: exportId } }), this.webOrigin());
    });
    await this.dispatchPendingCommands(projectId);
    return prototypeExportSchema.parse(result);
  }

  private async reviewRevision(principal: AuthenticatedPrincipal, projectId: string, revisionId: string, idempotencyKey: string, ifMatch: string | undefined, request: PrototypeWorkflowActionRequest, status: "confirmed" | "rejected"): Promise<PrototypeRevision> {
    prototypeWorkflowActionRequestSchema.parse(request);
    await this.requireProjectMember(principal.id, projectId, "editor");
    return this.mutate(projectId, revisionId, principal.id, `revision_${status}`, idempotencyKey, request, async (tx) => {
      const row = await tx.prototypeRevision.findFirst({ where: { id: revisionId, projectId } });
      if (!row) throw notFoundProblem("Prototype revision");
      assertIfMatch(ifMatch, row.revision);
      const update = await tx.prototypeRevision.updateMany({ where: { id: revisionId, projectId, revision: row.revision, status: "ready" }, data: { status, revision: { increment: 1 } } });
      if (update.count !== 1) throw revisionConflictProblem();
      return toRevision(await tx.prototypeRevision.findUniqueOrThrow({ where: { id: revisionId } }));
    });
  }

  private async prepareRun(tx: Prisma.TransactionClient, plan: { id: string; projectId: string; createdById: string; title: string; generationRequest: Prisma.JsonValue | null; sourceRevisionId: string | null; inputSnapshot?:Prisma.JsonValue|null; feedbackIds?:Prisma.JsonValue }): Promise<void> {
    if (!plan.generationRequest) throw new ProblemException({ title: "Generation context unavailable", status: 409, detail: "This plan has no pinned generation request", code: "PROTOTYPE_PLAN_CONTEXT_MISSING" });
    if (!this.runs) throw temporalUnavailable();
    const request=startRunRequestSchema.parse(plan.generationRequest);
    const runId = await this.runs.preparePrototypeRun(tx, { projectId: plan.projectId, principalId: plan.createdById, planId: plan.id, title: plan.title, request, sourceRevisionId: plan.sourceRevisionId,inputSnapshot:plan.inputSnapshot?prototypeInputSnapshotSchema.parse(plan.inputSnapshot):null });
    await tx.prototypePlan.update({ where: { id: plan.id }, data: { runtimeRunId: runId } });
  }

  private async reserveExternal(projectId: string, targetId: string, principalId: string, kind: "share_create" | "share_revoke", idempotencyKey: string, request: unknown, action: (tx: Prisma.TransactionClient, requestHash: string) => Promise<Record<string, string>>): Promise<{ commandId: string; replay?: unknown }> {
    const requestHash = hashRequest(request);
    const commandId = `prototype_command_${hashRequest({ projectId, targetId, principalId, kind, idempotencyKey })}`;
    return this.db.$transaction(async (tx) => {
      await lockActiveProject(tx, projectId, principalId, "edit");
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`prototype:${projectId}:${kind}:${idempotencyKey}`}, 0))`);
      const receipt = await tx.prototypeMutationReceipt.findFirst({ where: { projectId, targetId, createdById: principalId, kind, idempotencyKey } });
      if (receipt) { assertRequestHash(receipt.requestHash, requestHash); return { commandId, replay: receipt.response }; }
      const existing = await tx.prototypeWorkflowCommand.findUnique({ where: { id: commandId } });
      if (existing) { assertRequestHash((existing.payload as Record<string, string>).requestHash, requestHash); return { commandId }; }
      const payload = await action(tx, requestHash);
      await tx.prototypeWorkflowCommand.create({ data: { id: commandId, projectId, targetId, kind, payload } });
      return { commandId };
    });
  }

  private async mutate<T>(projectId: string, targetId: string, principalId: string, kind: Prisma.PrototypeMutationReceiptCreateInput["kind"], idempotencyKey: string, request: unknown, action: (tx: Prisma.TransactionClient, requestHash: string) => Promise<T>): Promise<T> {
    const requestHash = hashRequest(request);
    return this.db.$transaction(async (tx) => {
      await lockActiveProject(tx, projectId, principalId, "edit");
      // Shared by all requests of this key, including different target ids. A
      // unique-key race never escapes as a 500; the loser replays or conflicts.
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`prototype:${projectId}:${kind}:${idempotencyKey}`}, 0))`);
      const replay = await tx.prototypeMutationReceipt.findFirst({ where: { projectId, targetId, createdById: principalId, kind, idempotencyKey } });
      if (replay) { assertRequestHash(replay.requestHash, requestHash); return replay.response as T; }
      const result = await action(tx, requestHash);
      await tx.prototypeMutationReceipt.create({ data: { id: `receipt_${randomBytes(12).toString("hex")}`, projectId, targetId, createdById: principalId, kind, idempotencyKey, requestHash, response: result as Prisma.InputJsonValue } });
      return result;
    }, { timeout: 30_000 });
  }

  private async requireProjectMember(principalId: string, projectId: string, minimum: "viewer" | "editor"): Promise<void> {
    const member = await this.db.projectMember.findFirst({ where: { projectId, principalId, project: { status: "active" } }, select: { role: true } });
    if (!member || (minimum === "editor" && !["owner", "editor"].includes(member.role))) throw forbiddenProblem();
  }

  private async getPlan(projectId: string, planId: string) { const row = await this.db.prototypePlan.findFirst({ where: { id: planId, projectId } }); if (!row) throw notFoundProblem("Prototype plan"); return row; }
  private async requireRevision(projectId: string, id: string) { const row = await this.db.prototypeRevision.findFirst({ where: { id, projectId } }); if (!row) throw notFoundProblem("Prototype revision"); const parsed = prototypeRevisionSchema.safeParse(toRevision(row)); if (!parsed.success) throw notFoundProblem("Prototype revision"); return parsed.data; }
  private async requireRevisionWithPreview(projectId: string, id: string): Promise<PrototypeRevision> {
    const row = await this.db.prototypeRevision.findFirst({ where: { id, projectId }, select: { ...revisionSummarySelect, ...frozenPreviewSelect, pages: true } });
    if (!row) throw notFoundProblem("Prototype revision");
    const previewHtml = ["ready", "confirmed", "rejected"].includes(row.status) ? await this.readFrozenPreview(row) : null;
    return prototypeRevisionSchema.parse({ ...toRevision(row), previewHtml });
  }
  private async requireExport(projectId: string, id: string) { const row = await this.db.prototypeExport.findFirst({ where: { id, projectId } }); if (!row) throw notFoundProblem("Prototype export"); return row; }
  private webOrigin(): string { return this.config.get<string>("WORKBENCH_WEB_ORIGIN")?.split(",")[0]?.trim() || "http://localhost:3000"; }
  private previewTokenSecret(): string {
    const secret = this.config.get<string>("WORKBENCH_PREVIEW_TOKEN_SECRET")?.trim();
    if (!secret) throw new ProblemException({ title: "Preview token unavailable", status: 503, detail: "WORKBENCH_PREVIEW_TOKEN_SECRET is required", code: "PREVIEW_TOKEN_UNAVAILABLE" });
    return secret;
  }
  private shareToken(projectId: string, principalId: string, idempotencyKey: string, revisionId: string, documentSha256: string): string {
    const secret = this.config.get<string>("WORKBENCH_PREVIEW_TOKEN_SECRET")?.trim();
    if (!secret) throw new ProblemException({ title: "Share token unavailable", status: 503, detail: "WORKBENCH_PREVIEW_TOKEN_SECRET is required", code: "SHARE_TOKEN_UNAVAILABLE" });
    return `wbp2_${createHmac("sha256", secret).update(`workbench.prototype-share.v2\0${projectId}\0${principalId}\0${idempotencyKey}\0${revisionId}\0${documentSha256}`, "utf8").digest("base64url")}`;
  }


}

function hashRequest(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
function normalizeMediaType(value: string | null): string { return (value ?? "").replace(/\s*;\s*/gu, ";").trim().toLowerCase(); }
function hashSecret(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function previewTokenTtlMs(config: ConfigService): number {
  const raw = Number(config.get<string>("WORKBENCH_PREVIEW_TOKEN_MAX_TTL_SECONDS") || 900);
  const seconds = Number.isSafeInteger(raw) && raw >= 60 && raw <= 3_600 ? raw : 900;
  return seconds * 1_000;
}
function createPrototypePreviewToken(payload: { projectId: string; revisionId: string; documentSha256: string; artifactSha256: string; expiresAt: Date }, secret: string): string {
  const encoded = Buffer.from(JSON.stringify({ v: 3, projectId: payload.projectId, revisionId: payload.revisionId, documentSha256: payload.documentSha256, artifactSha256: payload.artifactSha256, exp: Math.floor(payload.expiresAt.getTime() / 1_000) }), "utf8").toString("base64url");
  const unsigned = `wbpv3p.${encoded}`;
  return `${unsigned}.${createHmac("sha256", secret).update(unsigned, "utf8").digest("base64url")}`;
}
function verifyPrototypePreviewToken(token: string, secret: string): { projectId: string; revisionId: string; documentSha256: string; artifactSha256: string; expiresAt: Date } {
  if (token.length > 4_096) throw notFoundProblem("Prototype preview");
  const match = /^wbpv3p\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/u.exec(token);
  if (!match) throw notFoundProblem("Prototype preview");
  const unsigned = `wbpv3p.${match[1]}`;
  const expected = Buffer.from(createHmac("sha256", secret).update(unsigned, "utf8").digest("base64url"), "base64url");
  const supplied = Buffer.from(match[2], "base64url");
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw notFoundProblem("Prototype preview");
  let value: unknown;
  try { value = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8")); } catch { throw notFoundProblem("Prototype preview"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw notFoundProblem("Prototype preview");
  const candidate = value as Record<string, unknown>;
  if (candidate.v !== 3 || typeof candidate.projectId !== "string" || typeof candidate.revisionId !== "string" || typeof candidate.documentSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(candidate.documentSha256) || typeof candidate.artifactSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(candidate.artifactSha256) || typeof candidate.exp !== "number" || !Number.isSafeInteger(candidate.exp)) throw notFoundProblem("Prototype preview");
  return { projectId: candidate.projectId, revisionId: candidate.revisionId, documentSha256: candidate.documentSha256, artifactSha256: candidate.artifactSha256, expiresAt: new Date(candidate.exp * 1_000) };
}
function assertRequestHash(actual: string, expected: string): void { if (actual !== expected) throw idempotencyConflictProblem(); }
function assertIfMatch(value: string | undefined, revision: number): void {
  if (!value) throw preconditionRequiredProblem();
  const normalized = value.replace(/^W\//, "").replace(/^\"|\"$/g, "");
  if (normalized !== `v${revision}` && normalized !== String(revision)) throw revisionConflictProblem();
}
function temporalUnavailable(): ProblemException { return new ProblemException({ title: "Temporal workflow unavailable", status: 503, detail: "The visual prototype Temporal workflow gateway is not ready", code: "TEMPORAL_WORKFLOW_UNAVAILABLE" }); }
function requireReadyRevision(status: PrototypeRevision["status"]): void {
  if (status !== "ready" && status !== "confirmed") throw new ProblemException({ title: "Prototype revision is not ready", status: 409, detail: "Only ready or confirmed revisions can be shared or exported", code: "PROTOTYPE_REVISION_NOT_READY" });
}
function toPlan(row: any): PrototypePlan { return prototypePlanSchema.parse({ id: row.id, projectId: row.projectId, rootPlanId: row.rootPlanId ?? null, sourceRevisionId: row.sourceRevisionId ?? null, contentVersion: row.contentVersion ?? 1, status: row.status, prompt: prototypePlanDisplayPrompt(row), title: row.title, revision: row.revision, createdById: row.createdById, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), failure: row.failureCode ? { code: row.failureCode, detail: row.failureDetail || row.failureCode } : null }); }
function toRevisionSummary(row: RevisionSummaryRow): PrototypeRevisionSummary { return prototypeRevisionSummarySchema.parse({ id: row.id, projectId: row.projectId, planId: row.planId, version: row.version ?? 1, sourceRevisionId: row.sourceRevisionId ?? null, revision: row.revision, status: row.status, title: row.title, documentSha256: row.documentSha256, createdById: row.createdById, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), failure: row.failureCode ? { code: row.failureCode, detail: row.failureDetail || row.failureCode } : null }); }
function toRevision(row: RevisionSummaryRow & { pages: unknown }): PrototypeRevision { return prototypeRevisionSchema.parse({ ...toRevisionSummary(row), pages: row.pages, previewHtml: null }); }
function toPublicRevision(value: PrototypeRevision) { return { id: value.id, projectId: value.projectId, planId: value.planId, version: value.version, sourceRevisionId: value.sourceRevisionId, revision: value.revision, status: value.status, title: value.title, pages: value.pages, previewHtml: value.previewHtml, documentSha256: value.documentSha256, createdAt: value.createdAt, updatedAt: value.updatedAt, failure: value.failure }; }
function toFeedback(row: any): PrototypeFeedback { return prototypeFeedbackSchema.parse({ id: row.id, projectId: row.projectId, revisionId: row.revisionId, createdById: row.createdById, body: row.body, anchor: row.anchor, status: row.status, revision: row.revision, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), resolvedAt: row.resolvedAt?.toISOString() || null }); }
function toShare(row: any, origin: string, token?: string): PrototypeShare { return prototypeShareSchema.parse({ id: row.id, projectId: row.projectId, revisionId: row.revisionId, revision: row.revision, status: row.status, url: token ? `${origin}/prototype-share/${token}` : `${origin}/prototype-share/${row.id}`, expiresAt: row.expiresAt?.toISOString() || null, createdAt: row.createdAt.toISOString(), revokedAt: row.revokedAt?.toISOString() || null }); }
function toExport(row: any, origin: string): PrototypeExport { return prototypeExportSchema.parse({ id: row.id, projectId: row.projectId, revisionId: row.revisionId, format: row.format, status: row.status, revision: row.revision, artifact: row.artifactKey && row.artifactSha256 && row.byteSize && row.mediaType ? { downloadUrl: `${origin}/api/v1/projects/${row.projectId}/prototype-v2/exports/${row.id}/download`, artifactSha256: row.artifactSha256, byteSize: row.byteSize, mediaType: row.mediaType } : null, failure: row.failureCode ? { code: row.failureCode, detail: row.failureDetail || row.failureCode } : null, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), finishedAt: row.finishedAt?.toISOString() || null }); }
