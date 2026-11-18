import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { PrismaClient } from "@workbench/workbench-db";
import { afterEach, beforeEach, beforeAll, describe, expect, it, vi } from "vitest";
import { startRunRequestSchema, type PrototypeDocument } from "@workbench/workbench-contracts";
import { prototypeDocumentFixture } from "../../../packages/workbench-contracts/test/prototype-fixture.js";
import { seedReadyKnowledge } from "../../../scripts/test-support/knowledge-fixture.mjs";
import { AccessService } from "../src/modules/access/access.service.js";
import { DesignPresetsService } from "../src/modules/design-presets/design-presets.service.js";
import { RunEventStore } from "../src/modules/runs/run-event.store.js";
import { RunsService } from "../src/modules/runs/runs.service.js";
import { PrototypeV2Service, type PrototypeWorkflowClientPort } from "../src/modules/prototypes/prototype-v2.service.js";
import { requirementFlow } from './fixtures/requirement-flow.js';
const databaseUrl = process.env.WORKBENCH_TEST_DATABASE_URL;
const describePg = databaseUrl ? describe : describe.skip;
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
const content = "<button>Save</button>";
const page = { id: "page_home", slug: "home", title: "Home", route: "/", order: 0, content, sha256: hash(content) };
const generationRequest = (prompt: string) => startRunRequestSchema.parse({ prompt, modelId: "test-selected-model", workflow: "generate", generationIntent: null, targetSurface: "app", designStyle: { kind: "automatic" }, sourceIds: [], artifactTargets: [], requestedArtifactKinds: ["prototype"], canvasSnapshot: null });
const config = { get: (key: string) => ({ WORKBENCH_PREVIEW_TOKEN_SECRET: "local-test-secret", WORKBENCH_WEB_ORIGIN: "https://workbench.test" } as Record<string, string>)[key] };

describePg("Prototype V2 durable PostgreSQL lifecycle (workflow transport simulated)", () => {
  let db: PrismaClient, ownerId: string, workspaceId: string, projectId: string;
  let workflows: PrototypeWorkflowClientPort & { startPlan: ReturnType<typeof vi.fn>; startExport: ReturnType<typeof vi.fn>; cancelPlan: ReturnType<typeof vi.fn>; cancelExport: ReturnType<typeof vi.fn> };
  let service: PrototypeV2Service,runs:RunsService;
  const frozenArtifacts = new Map<string, string>();
  const storage = { getObject: vi.fn(async (key: string) => {
    const html = frozenArtifacts.get(key);
    if (html === undefined) throw new Error("MISSING_TEST_ARTIFACT");
    return { body: Readable.from(html), byteSize: Buffer.byteLength(html), sha256: hash(html), mediaType: "text/html; charset=utf-8" };
  }) };
  const principal = () => ({ id: ownerId }) as never;
  const recreate = () => {runs=new RunsService(db as never,new AccessService(db as never),new RunEventStore(),{sendInTransaction:vi.fn()} as never,{assertAvailable:vi.fn()} as never,new DesignPresetsService());return new PrototypeV2Service(db as never,workflows,config as never,storage as never,runs);};
  // Existing saved plans seed history/feedback/share/export tests. New generation
  // below uses actual discussion and single confirmation, never old approval.
  const makePlan = () => db.prototypePlan.create({data:{projectId,createdById:ownerId,status:'ready',title:'Saved generated version',prompt:'Confirmed business increment',generationRequest:generationRequest('Confirmed business increment') as never,idempotencyKey:randomUUID(),requestHash:hash('historical-fixture')}});
  const flow=()=>requirementFlow(db,runs,service,ownerId,projectId);
  const due = () => db.prototypeWorkflowCommand.updateMany({ where: { projectId, deliveredAt: null }, data: { availableAt: new Date(0), leaseUntil: null } });
  const makeRevision = (planId: string, version = 1, sourceRevisionId?: string, document?: PrototypeDocument) => db.prototypeRevision.create({ data: { id: `revision_${randomUUID()}`, projectId, planId, createdById: ownerId, version, sourceRevisionId, revision: 0, status: "ready", title: "Review", sourceDocument: document as never, pages: document ? document.screens.map((screen,index)=>({...page,id:screen.id,route:screen.route,order:index})) : [page], documentSha256: hash(JSON.stringify([page])), idempotencyKey: `seed-${randomUUID()}`, requestHash: hash("seed") } });

  beforeAll(async () => { const seed = new PrismaClient({ datasourceUrl: databaseUrl! }); try { await seed.$transaction(tx => seedReadyKnowledge(tx), { timeout: 60_000 }); } finally { await seed.$disconnect(); } }, 90_000);
  beforeEach(async () => {
    frozenArtifacts.clear(); storage.getObject.mockClear();
    db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const id = randomUUID().replaceAll("-", "");
    ownerId = `v2_owner_${id}`; workspaceId = `v2_workspace_${id}`; projectId = `v2_project_${id}`;
    await db.$transaction(async tx => {
      await tx.principal.create({ data: { id: ownerId, issuer: `v2-${id}`, subject: ownerId } });
      await tx.workspace.create({ data: { id: workspaceId, slug: `v2-${id}`, name: "V2", createdById: ownerId } });
      await tx.workspaceMember.create({ data: { workspaceId, principalId: ownerId, role: "owner" } });
      await tx.project.create({ data: { id: projectId, workspaceId, createdById: ownerId, title: "V2" } });
      await tx.projectMember.create({ data: { projectId, workspaceId, principalId: ownerId, role: "owner" } });
    });
    workflows = { configured: true, startPlan: vi.fn(), cancelPlan: vi.fn(), startExport: vi.fn(), cancelExport: vi.fn(),
      executeShareCreate: vi.fn(async input => {
        const existing = await db.prototypeShare.findFirst({ where: { projectId, createdById: ownerId, idempotencyKey: input.idempotencyKey } });
        const row = existing ?? await db.prototypeShare.create({ data: { id: `share_${randomUUID()}`, projectId, revisionId: input.revisionId, createdById: ownerId, tokenHash: input.tokenHash, idempotencyKey: input.idempotencyKey, requestHash: input.requestHash, expiresAt: input.expiresAt ? new Date(input.expiresAt) : null } });
        return { id: row.id, revision: row.revision, status: row.status };
      }),
      executeShareRevoke: vi.fn(async input => {
        const row = await db.prototypeShare.updateMany({ where: { id: input.shareId, projectId, status: "active", revision: input.expectedRevision }, data: { status: "revoked", revision: { increment: 1 }, revokedAt: new Date() } });
        return { ok: row.count === 1, status: row.count ? "revoked" as const : "active" as const, revision: input.expectedRevision + 1 };
      }),
    };
    service = recreate();
  });
  afterEach(async () => {
    service?.onModuleDestroy();
    await db.requirementConfirmation.deleteMany({where:{projectId}});
    await db.threadEntry.deleteMany({where:{requirementSession:{projectId}}});
    await db.requirementSession.deleteMany({where:{projectId}});
    await db.prototypePlan.deleteMany({ where: { projectId } });
    await db.project.delete({ where: { id: projectId } });
    await db.workspace.delete({ where: { id: workspaceId } });
    await db.principal.delete({ where: { id: ownerId } });
    await db.$disconnect();
  });

  it("recovers bounded latest previews from only the bound Run and current attempt", async () => {
    const plan=(await flow().create(generationRequest('Create a reviewable prototype'))).plan!;
    const row = await db.prototypePlan.findUniqueOrThrow({ where: { id: plan.id } });
    const runId = row.runtimeRunId!;
    const store = new RunEventStore();
    const preview = (title: string) => ({ artifactIndex: 0, kind: "prototype", title, markdown: "", screens: [] });
    await db.$transaction(async tx => {
      await tx.run.update({ where: { id: runId }, data: { attempt: 1 } });
      await store.append(tx, runId, "run.started", { attempt: 1 });
      await store.append(tx, runId, "artifact.preview.updated", { attempt: 1, preview: preview("first content") });
      await store.append(tx, runId, "artifact.preview.updated", { attempt: 1, preview: preview("second content") });
    });
    const first = await service.getProgress(principal(), projectId, plan.id);
    expect(first.run?.id).toBe(runId);
    expect(first.events.filter(event => event.type === "artifact.preview.updated")).toHaveLength(1);
    expect(first.events.at(-1)?.payload).toMatchObject({ preview: { title: "second content" } });
    await db.$transaction(async tx => {
      await tx.run.update({ where: { id: runId }, data: { attempt: 2 } });
      await store.append(tx, runId, "run.started", { attempt: 2 });
      await store.append(tx, runId, "artifact.preview.updated", { attempt: 2, preview: preview("current attempt") });
      await store.append(tx, runId, "artifact.preview.updated", { attempt: 1, preview: preview("late stale content") });
      for (let index = 0; index < 70; index++) await store.append(tx, runId, "activity.changed", {activityId: `activity-${index}`,status:"running",label:"Processing",detail:null});
    });
    const recovered = await service.getProgress(principal(), projectId, plan.id);
    expect(recovered.events).toHaveLength(64);
    expect(recovered.events.find(event => event.type === "artifact.preview.updated")?.payload).toMatchObject({attempt:2,preview:{title:"current attempt"}});
    expect(recovered.events.every(event => event.sequence <= recovered.run!.lastEventSequence)).toBe(true);
  });

  it("serializes confirmed dispatch and replays the original result", async () => {
    const discussion=await flow().prepare(generationRequest('A prototype')),analysis=await discussion.analyze(),confirmed=await analysis.confirm();
    const results=await Promise.all(Array.from({length:6},()=>service.createConfirmedRequirementPlan(ownerId,projectId,confirmed.confirmation!.id)));
    for(const result of results)expect(result).toEqual(results[0]);
    expect(await db.prototypePlan.count({where:{projectId}})).toBe(1);
    expect(await db.run.count({where:{projectId}})).toBe(1);
    await expect(service.createConfirmedRequirementPlan(ownerId,projectId,confirmed.confirmation!.id)).resolves.toEqual(results[0]);
  });

  it("survives confirmed generation acknowledgement loss and API restart without a false failed state", async () => {
    const harness=flow(),discussion=await harness.prepare(generationRequest('Reviewable incremental prototype')),analysis=await discussion.analyze();
    const accepted=await analysis.confirm('confirm-lost-ack');workflows.startPlan.mockRejectedValueOnce(new Error('ack lost'));await analysis.processor.tick(accepted.id);
    const started=await harness.sessions.get(ownerId,accepted.id),planId=started.confirmation!.planId!;
    expect(await db.prototypePlan.findUnique({ where: { id: planId } })).toMatchObject({ status: "approved", failureCode: null });
    const pending = await db.prototypeWorkflowCommand.findFirstOrThrow({ where: { projectId, kind: "plan_start" } });
    expect(pending).toMatchObject({ deliveredAt: null, attempts: 1, lastErrorCode: "TEMPORAL_DELIVERY_PENDING" });
    service = recreate(); await due(); await service.dispatchPendingCommands(projectId);
    expect(workflows.startPlan).toHaveBeenCalledTimes(2);
    expect(workflows.startPlan.mock.calls[0]).toEqual(workflows.startPlan.mock.calls[1]);
    expect(await db.prototypeWorkflowCommand.findUnique({ where: { id: pending.id } })).toMatchObject({ attempts: 2, deliveredAt: expect.any(Date) });
    expect((await analysis.confirm('confirm-lost-ack')).confirmation?.runId).toBe(started.confirmation!.runId);
    await expect(harness.sessions.confirm(ownerId,accepted.id,'confirm-lost-ack',analysis.ready.revision,{summaryVersion:analysis.ready.summaryVersion,summaryChecksum:analysis.ready.summaryChecksum!,acceptedAssumptionIds:[],acceptedPlatformChanges:true})).rejects.toMatchObject({status:409});
  });

  it("keeps content versions independent of CAS and rejects changes to ready content", async () => {
    const plan = await makePlan(), first = await makeRevision(plan.id);
    const confirmed = await service.confirmRevision(principal(), projectId, first.id, "confirm-first", '"0"', {});
    expect(confirmed).toMatchObject({ version: 1, revision: 1, status: "confirmed" });
    const second = await makeRevision(plan.id, 2, first.id);
    await expect(service.confirmRevision(principal(), projectId, first.id, "confirm-first", '"0"', {})).resolves.toEqual(confirmed);
    await expect(service.rejectRevision(principal(), projectId, first.id, "reject-stale", '"0"', {})).rejects.toMatchObject({ status: 412 });
    await expect(db.prototypeRevision.update({ where: { id: first.id }, data: { title: "Overwrite" } })).rejects.toThrow(/immutable/u);
    await expect(db.prototypeRevision.update({ where: { id: first.id }, data: { version: 3 } })).rejects.toThrow(/immutable/u);
    await expect(db.prototypeRevision.update({ where: { id: first.id }, data: { builtArtifactKey: "test/frozen.html", builtArtifactSha256: "a".repeat(64), builtArtifactByteSize: 20 } })).rejects.toThrow(/prototype_frozen_manifest_complete/u);
    await db.prototypeRevision.update({ where: { id: first.id }, data: { builtArtifactKey: "test/frozen.html", builtArtifactSha256: "a".repeat(64), builtArtifactByteSize: 20, builtArtifactMediaType: "text/html; charset=utf-8" } });
    await expect(db.prototypeRevision.update({ where: { id: first.id }, data: { builtArtifactSha256: "b".repeat(64) } })).rejects.toThrow(/immutable/u);
    expect((await service.listRevisions(principal(), projectId, plan.id)).map(row => row.version)).toEqual([1, 2]);
    expect(await service.getRevisionDiff(principal(), projectId, second.id)).toMatchObject({ sourceRevisionId: first.id, pages: [{ pageId: page.id, change: "unchanged" }] });
  });

  it("binds concurrent feedback to exact revision and anchor and atomically resolves it", async () => {
    const plan = await makePlan(), revision = await makeRevision(plan.id);
    const request = { body: "Change this button", anchor: { pageId: page.id, sourceRevisionId: revision.id, scope: "page" as const } };
    const [one, two] = await Promise.all([service.createFeedback(principal(), projectId, revision.id, request, "feedback-concurrent"), service.createFeedback(principal(), projectId, revision.id, request, "feedback-concurrent")]);
    expect(two).toEqual(one);
    const another = await makeRevision(plan.id, 2);
    await expect(service.createFeedback(principal(), projectId, another.id, { ...request, anchor: { ...request.anchor, sourceRevisionId: another.id } }, "feedback-concurrent")).rejects.toMatchObject({ status: 409 });
    await expect(service.createFeedback(principal(), projectId, revision.id, { ...request, anchor: { pageId: "missing_page", sourceRevisionId: revision.id, scope: "page" as const } }, "feedback-invalid")).rejects.toMatchObject({ status: 404 });
    const resolved = await service.resolveFeedback(principal(), projectId, one.id, "resolve-feedback", '"0"', {});
    await expect(service.resolveFeedback(principal(), projectId, one.id, "resolve-feedback", '"0"', {})).resolves.toEqual(resolved);
    expect(await service.listFeedback(principal(), projectId, revision.id)).toEqual({items:[resolved],nextCursor:null});
    expect(await service.listFeedback(principal(), projectId, another.id)).toEqual({items:[],nextCursor:null});
  });

  it("pages all feedback with server filters, scoped cursors and stable ties; different anchors require a new command", async () => {
    const plan = await makePlan(), source = await makeRevision(plan.id), target = await makeRevision(plan.id, 2, source.id);
    const createdAt = new Date("2026-01-01T00:00:00Z");
    await db.prototypeFeedback.createMany({data:Array.from({length:131},(_,index)=>({
      id:`paging-${projectId}-${String(index).padStart(3,"0")}`, projectId, revisionId:source.id, createdById:ownerId,
      body:`Stored feedback ${index}`, status:index<125?"resolved" as const:"open" as const,
      createdAt, resolvedAt:index<125?createdAt:null, idempotencyKey:`paging-${index}`, requestHash:hash(`paging-${index}`),
    }))});
    const collected:string[]=[];let cursor:string|undefined;
    do {
      const result=await service.feedbackLocations(principal(),projectId,source.id,target.id,{limit:50,cursor});
      expect(result.items.length).toBeLessThanOrEqual(50);collected.push(...result.items.map(item=>item.feedback.id));
      cursor=result.nextCursor??undefined;
    } while(cursor);
    expect(collected).toHaveLength(131);expect(new Set(collected).size).toBe(131);
    const open=await service.feedbackLocations(principal(),projectId,source.id,target.id,{status:"open"});expect(open.items).toHaveLength(6);
    const first=await service.listFeedback(principal(),projectId,source.id,{limit:50});
    await expect(service.listFeedback(principal(),projectId,source.id,{cursor:first.nextCursor!,status:"open"})).rejects.toMatchObject({status:400});
    await expect(service.feedbackLocations(principal(),projectId,source.id,target.id,{cursor:first.nextCursor!})).rejects.toMatchObject({status:400});
    await expect(service.listFeedback(principal(),projectId,source.id,{cursor:"invalid"})).rejects.toMatchObject({status:400});
    const request={body:"New page review",anchor:{scope:"page" as const,sourceRevisionId:source.id,pageId:page.id}};
    const saved=await service.createFeedback(principal(),projectId,source.id,request,"lost-page-response");
    expect(await service.createFeedback(principal(),projectId,source.id,request,"lost-page-response")).toEqual(saved);
    await expect(service.createFeedback(principal(),projectId,source.id,{...request,anchor:null},"lost-page-response")).rejects.toMatchObject({status:409});
    const changed=await service.createFeedback(principal(),projectId,source.id,{...request,anchor:null},"new-whole-version-intent");
    expect(changed.id).not.toBe(saved.id);
    const filtered=await service.feedbackLocations(principal(),projectId,source.id,target.id,{pageId:page.id,status:"open"});
    expect(filtered.items.map(item=>item.feedback.id)).toEqual([saved.id]);
    const refreshed=await service.listFeedback(principal(),projectId,source.id,{status:"open"});
    expect(refreshed.items.slice(0,2).map(item=>item.id)).toEqual([changed.id,saved.id]);
  });

  it("persists exact stable nodes, rejects forged scope, and resolves missing nodes without rebinding across versions", async () => {
    const plan = await makePlan(), document = prototypeDocumentFixture();
    const source = await makeRevision(plan.id, 1, undefined, document);
    const anchor = { sourceRevisionId: source.id, scope: "node" as const, pageId: "screen-a", nodeId: "node-a", quote: "Original A" };
    const request = { body: "Keep this review even if the element is removed", anchor };
    const [one, replay] = await Promise.all([service.createFeedback(principal(), projectId, source.id, request, "node-feedback-concurrent"),service.createFeedback(principal(), projectId, source.id, request, "node-feedback-concurrent")]);
    expect(replay).toEqual(one); expect((await db.prototypeFeedback.findUniqueOrThrow({where:{id:one.id}})).anchor).toEqual(anchor);
    await expect(service.createFeedback(principal(),projectId,source.id,{...request,anchor:{...anchor,sourceRevisionId:"another-revision"}},"node-wrong-source")).rejects.toMatchObject({status:400});
    await expect(service.createFeedback(principal(),projectId,source.id,{...request,anchor:{...anchor,nodeId:"node-b"}},"node-wrong-page")).rejects.toMatchObject({status:404});
    await expect(service.createFeedback(principal(),projectId,source.id,{...request,anchor:{...anchor,nodeId:"missing-node"}},"node-not-found")).rejects.toMatchObject({status:404});
    const removed=structuredClone(document);removed.nodes=removed.nodes.filter(node=>node.id!=="node-a");
    for(const node of removed.nodes)if(node.kind==="frame")node.childIds=node.childIds.filter(id=>id!=="node-a");
    const target=await makeRevision(plan.id,2,source.id,removed);
    const same=await service.feedbackLocations(principal(),projectId,source.id,source.id);
    expect(same.items[0]).toMatchObject({status:"resolved",pageId:"screen-a",nodeId:"node-a",reason:null});
    const missing=await service.feedbackLocations(principal(),projectId,source.id,target.id);
    expect(missing.items[0]).toEqual({feedback:one,targetRevisionId:target.id,status:"missing",pageId:null,nodeId:null,reason:"node_missing"});
    const pageComment=await service.createFeedback(principal(),projectId,source.id,{body:"Page review",anchor:{sourceRevisionId:source.id,scope:"page",pageId:"screen-a"}},"node-page-review");
    expect((await service.feedbackLocations(principal(),projectId,source.id,target.id)).items.find(item=>item.feedback.id===pageComment.id)).toMatchObject({status:"resolved",pageId:"screen-a",nodeId:null});
    const otherPlan=await makePlan(),other=await makeRevision(otherPlan.id,1,undefined,document);
    await expect(service.feedbackLocations(principal(),projectId,source.id,other.id)).rejects.toMatchObject({status:404});
    await expect(service.feedbackLocations({id:"outsider"} as never,projectId,source.id,target.id)).rejects.toMatchObject({status:403});
    await expect(db.prototypeFeedback.update({where:{id:one.id},data:{anchor:{...anchor,nodeId:"node-b"}}})).rejects.toThrow(/IMMUTABLE/);
    await expect(db.prototypeFeedback.create({data:{projectId,revisionId:source.id,createdById:ownerId,body:"Direct forged anchor",anchor:{...anchor,nodeId:"node-b"},idempotencyKey:"direct-forged-anchor",requestHash:hash("forged")}})).rejects.toThrow(/NODE_NOT_FOUND/);
    const viewerId=`viewer_${randomUUID()}`;
    await db.principal.create({data:{id:viewerId,issuer:viewerId,subject:viewerId}});
    try {
      await db.workspaceMember.create({data:{workspaceId,principalId:viewerId,role:"member"}});
      await db.projectMember.create({data:{projectId,workspaceId,principalId:viewerId,role:"viewer"}});
      await expect(service.feedbackLocations({id:viewerId} as never,projectId,source.id,target.id)).resolves.toMatchObject({items:expect.arrayContaining([expect.objectContaining({status:"missing"})])});
      await expect(service.createFeedback({id:viewerId} as never,projectId,source.id,request,"viewer-cannot-comment")).rejects.toMatchObject({status:403});
    } finally {
      await db.projectMember.deleteMany({where:{principalId:viewerId}});await db.workspaceMember.deleteMany({where:{principalId:viewerId}});await db.principal.delete({where:{id:viewerId}});
    }
  });

  it("keeps multi-version history small and fetches only the selected frozen document", async () => {
    const plan = await makePlan();
    const pages = Array.from({ length: 20 }, (_, order) => {
      const content = `<section data-page="${order}">${"page-content ".repeat(16_000)}</section>`;
      return { id: `page_${order}`, slug: `page-${order}`, title: `Page ${order}`, route: `/page-${order}`, order, content, sha256: hash(content) };
    });
    const frozen = `<!doctype html><html><body>${pages.map(item => item.content).join("")}</body></html>`;
    const ids = Array.from({ length: 5 }, () => `revision_${randomUUID()}`);
    await db.prototypeRevision.createMany({ data: ids.map((id, index) => ({
      id, projectId, planId: plan.id, createdById: ownerId, version: index + 1, revision: 0,
      status: "ready", title: `Large version ${index + 1}`, pages, documentSha256: hash(JSON.stringify(pages)),
      idempotencyKey: `seed-${id}`, requestHash: hash(id), builtArtifactKey: `private/${id}.html`,
      builtArtifactSha256: hash(frozen), builtArtifactByteSize: Buffer.byteLength(frozen), builtArtifactMediaType: "text/html; charset=utf-8",
    })) });
    for (const id of ids) frozenArtifacts.set(`private/${id}.html`, frozen);
    const history = await service.listRevisions(principal(), projectId, plan.id);
    const historyBytes = Buffer.byteLength(JSON.stringify(history));
    const storedPagesBytes = Buffer.byteLength(JSON.stringify(pages)) * ids.length;
    expect(history.map(item => item.version)).toEqual([1, 2, 3, 4, 5]);
    expect(history.every(item => !("pages" in item) && !("previewHtml" in item))).toBe(true);
    expect(storedPagesBytes).toBeGreaterThan(20_000_000);
    expect(historyBytes).toBeLessThan(8_192);
    expect(storage.getObject).not.toHaveBeenCalled();
    const selected = await service.getRevision(principal(), projectId, ids[2]!);
    expect(selected.pages).toEqual(pages);
    expect(selected.previewHtml).toBe(frozen);
    expect(storage.getObject.mock.calls).toEqual([[`private/${ids[2]}.html`]]);
    process.stdout.write(`${JSON.stringify({ case: "prototype-history-response", versions: ids.length, pagesPerVersion: pages.length, storedPagesBytes, historyBytes, selectedBytes: Buffer.byteLength(JSON.stringify(selected)) })}\n`);
  });

  it("persists cancellation obligation without claiming provider acknowledgement", async () => {
    const plan = await makePlan();
    await db.prototypePlan.update({ where: { id: plan.id }, data: { status: "generating", revision: 4 } });
    workflows.cancelPlan.mockRejectedValueOnce(new Error("provider pending"));
    const accepted = await service.cancelPlan(principal(), projectId, plan.id, "cancel-durable", '"4"', {});
    expect(accepted.status).toBe("generating");
    expect(await db.prototypePlan.findUnique({ where: { id: plan.id } })).toMatchObject({ status: "generating" });
    workflows.cancelPlan.mockImplementationOnce(async () => { await db.prototypePlan.update({ where: { id: plan.id }, data: { status: "cancelled", revision: 5 } }); });
    service = recreate(); await due(); await service.dispatchPendingCommands(projectId);
    await expect(service.cancelPlan(principal(), projectId, plan.id, "cancel-durable", '"4"', {})).resolves.toEqual(accepted);
    expect(await service.getPlanSnapshot(principal(), projectId, plan.id)).toMatchObject({ status: "cancelled", revision: 5 });
    expect(await db.prototypeWorkflowCommand.count({ where: { projectId, kind: "plan_cancel" } })).toBe(1);
  });

  it("replays export delivery and gives a fresh retry its own workflow identity", async () => {
    const plan = await makePlan(), revision = await makeRevision(plan.id);
    workflows.startExport.mockRejectedValueOnce(new Error("network ambiguity"));
    const exported = await service.createExport(principal(), projectId, { revisionId: revision.id, format: "html" }, "export-start");
    expect(exported.status).toBe("queued");
    await due(); await service.dispatchPendingCommands(projectId);
    expect(workflows.startExport.mock.calls[0][0].commandId).toBe(workflows.startExport.mock.calls[1][0].commandId);
    await db.prototypeExport.update({ where: { id: exported.id }, data: { status: "failed", revision: 1, failureCode: "BUILD_FAILED", failureDetail: "Synthetic build failure" } });
    const retried = await service.retryExport(principal(), projectId, exported.id, "export-retry", '"1"', {});
    expect(retried).toMatchObject({ status: "queued", revision: 2 });
    expect(workflows.startExport.mock.calls[2][0].commandId).not.toBe(workflows.startExport.mock.calls[0][0].commandId);
    const cancelled = await service.cancelExport(principal(), projectId, exported.id, "export-cancel", '"2"', {});
    expect(cancelled.status).toBe("cancelling");
    expect(cancelled.finishedAt).toBeNull();
    expect(workflows.cancelExport.mock.calls[0][0].commandId).toBe(workflows.startExport.mock.calls[2][0].commandId);
    expect(await service.listExports(principal(), projectId)).toEqual([cancelled]);
  });

  it("recovers shares after lost acknowledgements and replays original creation without reopening revoked access", async () => {
    const plan = await makePlan(), revision = await makeRevision(plan.id);
    const html = `<!doctype html><html><body>${content}</body></html>`;
    const key = `private/${revision.id}.html`;
    frozenArtifacts.set(key, html);
    await db.prototypeRevision.update({ where: { id: revision.id }, data: { builtArtifactKey: key, builtArtifactSha256: hash(html), builtArtifactByteSize: Buffer.byteLength(html), builtArtifactMediaType: "text/html; charset=utf-8" } });
    const create = workflows.executeShareCreate!;
    workflows.executeShareCreate = vi.fn(async input => { await create(input); throw new Error("lost ack"); });
    await expect(service.createShare(principal(), projectId, { revisionId: revision.id }, "share-durable")).rejects.toMatchObject({ status: 503 });
    workflows.executeShareCreate = create; service = recreate(); await due();
    const shared = await service.createShare(principal(), projectId, { revisionId: revision.id }, "share-durable");
    const published = await service.getPublicShare(shared.url.split("/").at(-1)!);
    expect(published.revision).not.toHaveProperty("createdById"); expect(published.revision).not.toHaveProperty("sourceDocument");
    expect(published.revision.previewHtml).toBe(html);
    const direct = await service.getRevision(principal(), projectId, revision.id);
    const preview = await service.createPreviewToken(principal(), projectId, revision.id);
    expect((await service.getPreviewHtml(preview.url.split("/").at(-1)!)).html).toBe(direct.previewHtml);
    expect(published.revision.previewHtml).toBe(direct.previewHtml);
    expect(await service.listShares(principal(), projectId)).toEqual([shared]);
    const revoked = await service.revokeShare(principal(), projectId, shared.id, "revoke-share", '"0"', {});
    expect(revoked.status).toBe("revoked");
    await expect(service.getPublicShare(shared.url.split("/").at(-1)!)).rejects.toMatchObject({ status: 404, response: { code: "SHARE_REVOKED" } });
    await expect(service.createShare(principal(), projectId, { revisionId: revision.id }, "share-durable")).resolves.toEqual(shared);
    await expect(service.revokeShare(principal(), projectId, shared.id, "revoke-share", '"0"', {})).resolves.toEqual(revoked);
    expect(await db.prototypeShare.findUnique({ where: { id: shared.id } })).toMatchObject({ status: "revoked" });
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const expiring = await service.createShare(principal(), projectId, { revisionId: revision.id, expiresAt }, "share-expiring");
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(expiresAt) + 1);
    try {
      await expect(service.getPublicShare(expiring.url.split("/").at(-1)!)).rejects.toMatchObject({ status: 404, response: { code: "SHARE_EXPIRED" } });
      expect(await db.prototypeShare.findUnique({ where: { id: expiring.id } })).toMatchObject({ status: "expired" });
    } finally { clock.mockRestore(); }
    await expect(service.getPublicShare("invalid")).rejects.toMatchObject({ status: 404, response: { code: "RESOURCE_NOT_FOUND" } });
  });
});
