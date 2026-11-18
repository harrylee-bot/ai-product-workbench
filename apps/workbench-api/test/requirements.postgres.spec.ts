import { ProjectsService } from '../src/modules/projects/projects.service.js';
import { Readable } from 'node:stream';
import { ImportSourcesService } from '../src/modules/import-sources/import-sources.service.js';
import { DesignPresetsService } from '../src/modules/design-presets/design-presets.service.js';
import { RequirementContextReader } from '../src/modules/requirements/requirement-context-reader.js';
import { RequirementKnowledge } from '../src/modules/requirements/requirement-knowledge.js';
import { beforeAll,beforeEach,afterAll,describe,it,expect,vi } from 'vitest';
import { PrismaClient,Prisma } from '@workbench/workbench-db';
import { ConfigService } from '@nestjs/config';
import { createHash,randomUUID } from 'node:crypto';
import { prototypeDocumentFixture } from '../../../packages/workbench-contracts/test/prototype-fixture.js';
import { canonicalJson,startRunRequestSchema,type RequirementCard } from '@workbench/workbench-contracts';
import { AccessService } from '../src/modules/access/access.service.js';
import { RunsService } from '../src/modules/runs/runs.service.js';
import { RunEventStore } from '../src/modules/runs/run-event.store.js';
import { ThreadsService } from '../src/modules/threads/threads.service.js';
import { PrototypeV2Service } from '../src/modules/prototypes/prototype-v2.service.js';
import { RequirementsService } from '../src/modules/requirements/requirements.service.js';
import { RequirementsProcessor } from '../src/modules/requirements/requirements.processor.js';
import { confirmedRequirementBaseline } from '../../workbench-worker/src/runs/confirmed-requirement-baseline.js';
import { seedFixture } from './fixtures/knowledge-retrieval.js';
const url=process.env.WORKBENCH_REQUIREMENTS_TEST_DATABASE_URL;
const suite=url?describe:describe.skip;
suite('Requirement discussions with actual PostgreSQL; fixture model and workflow ports',()=>{
 const db=new PrismaClient({datasourceUrl:url});let fixture:Awaited<ReturnType<typeof seedFixture>>;
 let access:AccessService,runs:RunsService,service:RequirementsService,prototypes:PrototypeV2Service;
 const models={assertAvailable:vi.fn().mockResolvedValue(undefined)},queue={sendInTransaction:vi.fn().mockResolvedValue('fixture-job')};
 const workflows={configured:true,startPlan:vi.fn().mockResolvedValue(undefined),cancelPlan:vi.fn(),startExport:vi.fn(),cancelExport:vi.fn()};
 beforeAll(async()=>{fixture=await db.$transaction(seedFixture,{timeout:60000});access=new AccessService(db as never);runs=new RunsService(db as never,access,new RunEventStore(),queue as never,models as never,new DesignPresetsService());service=new RequirementsService(db as never,access,runs);prototypes=new PrototypeV2Service(db as never,workflows as never,new ConfigService(),{} as never,runs);},60000);
 beforeEach(async()=>{await db.requirementTurn.updateMany({where:{projectId:fixture.projectId,status:{in:["queued","running"]}},data:{status:"cancelled",finishedAt:new Date()}});});
 afterAll(async()=>{prototypes?.onModuleDestroy();await db.$disconnect();});
 async function create(kinds:('prd'|'prototype')[]=['prd','prototype']){
  const thread=await db.thread.create({data:{projectId:fixture.projectId,createdById:fixture.ownerId,title:'Incremental discussion fixture'}});
  const request=startRunRequestSchema.parse({prompt:'活动列表增加渠道筛选',modelId:'deepseek-flash',workflow:'generate',targetSurface:'web',designStyle:{kind:'automatic'},sourceIds:[],requestedArtifactKinds:kinds});
  return service.create(fixture.ownerId,thread.id,randomUUID(),request);
 }
 const baseCard:RequirementCard={goal:'活动列表增加渠道筛选',platform:'既有营销活动平台',modules:['活动管理'],roles:['策划'],existingCapabilities:[{description:'既有活动列表',scope:'platform',evidenceIds:['fixture-citation']}],reuse:['原列表'],changes:['增加渠道筛选'],affectedPages:['活动列表'],affectedFlows:['列表筛选'],targetSurface:'web',designConstraints:['保持原导航'],outputKinds:['prd','prototype'],assumptions:[],issues:[],platformChanges:[],preserved:['原区域权限']};
 function processor(card:unknown=baseCard,modelOverride?:unknown){
  const model=modelOverride??{analyze:vi.fn().mockResolvedValue({value:{reply:'可复用原列表，请核对本次改动。',card},inputTokens:100,outputTokens:80})};
  const evidence={id:'fixture-citation',releaseId:fixture.releaseId,releaseVersion:1,documentId:'fixture-document',chunkId:fixture.productionChunkId,title:'能力地图',sourcePath:'01-产品架构/产品能力地图.md',quote:'活动平台包含活动列表。',scope:'platform',checksum:'a'.repeat(64)};
  return new RequirementsProcessor(service,model as never,{retrieve:vi.fn().mockResolvedValue({releaseId:fixture.releaseId,evidence:[evidence]})} as never,runs,prototypes);
 }
 async function ready(kinds:('prd'|'prototype')[]=['prd','prototype']){
  let s=await create(kinds);s=await service.message(fixture.ownerId,s.id,randomUUID(),s.revision,{text:'仅在原活动列表新增渠道筛选，权限和其他页面保持原状。',intent:'discuss'});await processor({...baseCard,outputKinds:kinds}).tick(s.id);return service.get(fixture.ownerId,s.id);
 }
 const accept=(s:Awaited<ReturnType<typeof service.get>>)=>({summaryVersion:s.summaryVersion,summaryChecksum:s.summaryChecksum!,acceptedAssumptionIds:[],acceptedPlatformChanges:false});
 it('uses actual authorized indexed lexical retrieval and excludes source-lookup knowledge',async()=>{
  const knowledge=new RequirementKnowledge(db as never,access,{providers:null} as never),signal=new AbortController().signal;
  const result=await knowledge.retrieve(fixture.ownerId,fixture.projectId,'产品 工作台 用户 规则',signal);
  expect(result.releaseId).toBe(fixture.releaseId);expect(result.evidence.length).toBeGreaterThan(0);
  expect(result.evidence.every(x=>x.releaseId===fixture.releaseId&&x.chunkId!==fixture.sourceLookupChunkId)).toBe(true);
  for(const item of result.evidence)expect(item.checksum).toBe(createHash('sha256').update(item.quote).digest('hex'));
  await expect(knowledge.retrieve(fixture.outsiderId,fixture.projectId,'产品 规则',signal)).rejects.toMatchObject({status:404});
 });
 async function discussionWithSource(kinds:('prd'|'prototype')[]=['prototype'],withSource=false){
  const initial=await create(kinds);let request=initial.generationRequest;const bytes=Buffer.from('Existing draft source rules '+randomUUID()),sha256=createHash('sha256').update(bytes).digest('hex');
  if(withSource){
   const verifiedAt=new Date(),blob=await db.blob.create({data:{sha256,generation:1,storageKey:`blobs/${sha256.slice(0,2)}/${sha256.slice(2,4)}/${sha256}/g1`,mediaType:'text/markdown',byteSize:BigInt(bytes.length),status:'ready',verifiedAt}});
   await db.blobScan.create({data:{blobId:blob.id,attempt:1,status:'clean',scanner:'test-scanner',scannerVersion:'1',signatureVersion:'test-signatures',evidence:{result:'clean'},startedAt:verifiedAt,finishedAt:verifiedAt}});
   const file=await db.fileAsset.create({data:{projectId:initial.projectId,blobId:blob.id,uploadedById:fixture.ownerId,originalName:'draft-rules.md',declaredMediaType:'text/markdown',detectedMediaType:'text/markdown',byteSize:BigInt(bytes.length),status:'ready',verifiedAt}});
   const source=await new ImportSourcesService(db as never,access,queue as never).create(fixture.ownerId,initial.projectId,randomUUID(),{kind:'file',fileAssetId:file.id});
   const preset=new DesignPresetsService().list().items[0]!;
   request=startRunRequestSchema.parse({...request,sourceIds:[source.id],designStyle:{kind:'preset',presetId:preset.presetId,version:preset.version,checksum:preset.checksum}});
  }
  const snapshot=await db.$transaction(tx=>runs.captureGenerationInput(tx,initial.projectId,request));
  const s=await service.create(fixture.ownerId,initial.threadId,randomUUID(),request);
  const job=processor({...baseCard,outputKinds:kinds}) as any;
  job.contextReader=new RequirementContextReader(db as never,{getObject:async()=>({body:Readable.from([bytes]),byteSize:bytes.length,mediaType:'text/markdown',contentRange:null})});
  return {s,request,snapshot,job,bytes};
 }
 it.each([['prototype'],['prd','prototype'],['prd']] as ('prd'|'prototype')[][])('confirms one execution from a discussion with fixed sources and outputs %j',async(...selected)=>{
  const kinds=selected.filter(x=>x==='prd'||x==='prototype') as ('prd'|'prototype')[];
  const {s,request,snapshot,job,bytes}=await discussionWithSource(kinds,true);
  await service.message(fixture.ownerId,s.id,'draft-message',0,{text:'保留草稿来源和设计，仅增加渠道筛选',intent:'discuss'});await job.tick(s.id);
  const reviewed=await service.get(fixture.ownerId,s.id);expect(reviewed.state).toBe('ready_to_confirm');
  await Promise.all([service.confirm(fixture.ownerId,s.id,'draft-confirm',reviewed.revision,accept(reviewed)),service.confirm(fixture.ownerId,s.id,'draft-confirm',reviewed.revision,accept(reviewed))]);await job.tick(s.id);await job.tick(s.id);
  const done=await service.get(fixture.ownerId,s.id),run=await db.run.findUniqueOrThrow({where:{id:done.confirmation!.runId!},include:{sourceSnapshots:true}});
  expect(done.confirmation?.status).toBe('started');expect(await db.run.count({where:{threadId:s.threadId}})).toBe(1);expect((run.request as any).sourceIds).toEqual(request.sourceIds);expect((run.request as any).designStyle).toEqual(request.designStyle);expect(run.sourceSnapshots[0]?.snapshot).toEqual(snapshot.sources[0]?.snapshot);expect(run.designStyleSnapshot).toEqual(snapshot.designStyle.snapshot);
  const confirmation=await db.requirementConfirmation.findUniqueOrThrow({where:{id:done.confirmation!.id}});expect((confirmation.baseline as any).analysisContext.sourceContents.readings[0].text).toBe(bytes.toString());
  if(kinds.includes('prototype')){const derived=await db.prototypePlan.findUniqueOrThrow({where:{id:done.confirmation!.planId!}});expect(derived.rootPlanId).toBeNull();expect(derived.contentVersion).toBe(1);expect(derived.status).toBe('approved');}else expect(done.confirmation?.planId).toBeNull();
  expect((await service.confirm(fixture.ownerId,s.id,'draft-confirm',reviewed.revision,accept(reviewed))).confirmation?.runId).toBe(run.id);
 });
 it('preserves stored unconfirmed input but refuses runtime execution or retry',async()=>{
  const s=await create(['prd']);
  const row=await db.run.create({data:{projectId:s.projectId,threadId:s.threadId,createdById:fixture.ownerId,knowledgeReleaseId:fixture.releaseId,idempotencyKey:randomUUID(),requestHash:'a'.repeat(64),requestId:randomUUID(),traceId:randomUUID(),modelId:s.generationRequest.modelId,request:s.generationRequest as never}});
  const stored=await db.run.update({where:{id:row.id},data:{status:'failed',startedAt:new Date(),finishedAt:new Date(),errorCode:'RUNTIME_UNAVAILABLE',errorDetail:'Stored previous execution',errorRetryable:true}});
  await expect(db.$transaction(tx=>confirmedRequirementBaseline(tx,stored,startRunRequestSchema.parse(stored.request)))).rejects.toThrow('REQUIREMENT_CONFIRMATION_REQUIRED');
  await expect(runs.retry(fixture.ownerId,stored.id,'unconfirmed-retry')).rejects.toMatchObject({status:409,response:{code:'REQUIREMENT_CONFIRMATION_REQUIRED'}});
  expect(await db.run.findUniqueOrThrow({where:{id:stored.id}})).toEqual(stored);expect(await db.run.count({where:{threadId:s.threadId}})).toBe(1);
 });
 it('preserves retired draft rows without exposing them as generation plans',async()=>{
  const s=await create();const draft=await db.prototypePlan.create({data:{projectId:s.projectId,createdById:fixture.ownerId,title:'Stored draft',prompt:'Preserved data',generationRequest:s.generationRequest as never,idempotencyKey:randomUUID(),requestHash:'a'.repeat(64)}});
  await expect(service.create(fixture.ownerId,s.threadId,'retired-plan-context',s.generationRequest,{kind:'plan',planId:draft.id,expectedRevision:0} as never)).rejects.toThrow();
  const plans=await prototypes.listPlans({id:fixture.ownerId} as never,s.projectId);expect(plans.some(x=>x.id===draft.id)).toBe(false);
  await expect(prototypes.getPlanSnapshot({id:fixture.ownerId} as never,s.projectId,draft.id)).rejects.toMatchObject({status:404});
  expect(await db.prototypePlan.findUniqueOrThrow({where:{id:draft.id}})).toEqual(draft);
 });
 it('saves a short request, permits partial clarification, and creates no generation Run',async()=>{
  const s=await create();const before=await db.run.count({where:{projectId:fixture.projectId}});
  await service.message(fixture.ownerId,s.id,'short-message',0,{text:'想加个筛选',intent:'discuss'});await processor({platform:null,changes:[]}).tick(s.id);
  const result=await service.get(fixture.ownerId,s.id);expect(result.state).toBe('needs_clarification');expect(result.card?.platform).toBeNull();expect(await db.run.count({where:{projectId:fixture.projectId}})).toBe(before);
 });
 it('isolates users and private entries inside a shared authorized project',async()=>{
  const s=await create();await service.message(fixture.ownerId,s.id,'private-message',0,{text:'私有业务讨论',intent:'discuss'});
  await db.workspaceMember.createMany({data:[{workspaceId:(await db.project.findUniqueOrThrow({where:{id:fixture.projectId}})).workspaceId,principalId:fixture.outsiderId,role:'member'}],skipDuplicates:true});
  const project=await db.project.findUniqueOrThrow({where:{id:fixture.projectId}});await db.projectMember.createMany({data:[{workspaceId:project.workspaceId,projectId:project.id,principalId:fixture.outsiderId,role:'viewer'}],skipDuplicates:true});
  await expect(service.get(fixture.outsiderId,s.id)).rejects.toMatchObject({status:404});expect((await service.list(fixture.outsiderId,s.threadId)).items).toHaveLength(0);
  const threads=new ThreadsService(db as never,access);expect((await threads.listEntries(fixture.outsiderId,s.threadId)).items).toHaveLength(0);
 });
 it('replays a lost message receipt before checking stale ETag and supersedes old analysis',async()=>{
  const s=await create();const body={text:'增加渠道筛选',intent:'discuss' as const};const first=await service.message(fixture.ownerId,s.id,'lost-message',0,body);
  expect((await service.message(fixture.ownerId,s.id,'lost-message',0,body)).revision).toBe(first.revision);
  await expect(service.message(fixture.ownerId,s.id,'lost-message',0,{...body,text:'另一个请求'})).rejects.toMatchObject({status:409});
  const next=await service.message(fixture.ownerId,s.id,'next-message',first.revision,{text:'仅显示当前用户可见区域',intent:'discuss'});
  expect((await db.requirementTurn.findUniqueOrThrow({where:{id:first.activeTurn!.id}})).status).toBe('superseded');expect(next.activeTurn?.id).not.toBe(first.activeTurn?.id);
 });
 it('recovers the original message turn and its own suggestion confirmation after another tab advances',async()=>{
  const s=await create(['prd']);
  const firstInput={text:'只增加渠道筛选',intent:'confirm_suggestion' as const};
  const secondInput={text:'继续调整筛选展示',intent:'discuss' as const};
  const first=await service.message(fixture.ownerId,s.id,'first-suggestion',s.revision,firstInput);
  const job=processor({...baseCard,outputKinds:['prd']});
  await job.tick(s.id);
  const generated=await service.get(fixture.ownerId,s.id);
  expect(generated.confirmation?.status).toBe('started');
  const second=await service.message(fixture.ownerId,s.id,'second-discussion',generated.revision,secondInput);
  const replay=await service.message(fixture.ownerId,s.id,'first-suggestion',s.revision,firstInput);
  expect(replay.activeTurn?.id).toBe(first.activeTurn?.id);
  expect(replay.confirmation?.id).toBe(generated.confirmation?.id);
  expect((await service.get(fixture.ownerId,s.id)).activeTurn?.id).toBe(second.activeTurn?.id);
  await job.tick(s.id);
  const reviewed=await service.get(fixture.ownerId,s.id);
  await service.confirm(fixture.ownerId,s.id,'manual-confirmation',reviewed.revision,accept(reviewed));
  const discussionReplay=await service.message(fixture.ownerId,s.id,'second-discussion',generated.revision,secondInput);
  expect(discussionReplay.activeTurn?.id).toBe(second.activeTurn?.id);
  expect(discussionReplay.confirmation).toBeNull();
  expect(await db.requirementTurn.count({where:{sessionId:s.id}})).toBe(2);
 });
 it('paginates sessions with tied timestamps and rejects cross-user or cross-thread cursors',async()=>{
  const s=await create(),ids=[s.id];
  for(let i=0;i<3;i++)ids.push((await service.create(fixture.ownerId,s.threadId,randomUUID(),s.generationRequest)).id);
  await db.requirementSession.updateMany({where:{id:{in:ids}},data:{updatedAt:new Date('2026-11-17T00:00:00.000Z')}});
  const first=await service.list(fixture.ownerId,s.threadId,undefined,2);expect(first.items).toHaveLength(2);expect(first.nextCursor).not.toBeNull();
  const second=await service.list(fixture.ownerId,s.threadId,first.nextCursor!,2);expect(second.items).toHaveLength(2);expect(second.nextCursor).toBeNull();
  expect(new Set([...first.items,...second.items].map(x=>x.id))).toEqual(new Set(ids));
  await expect(service.list(fixture.outsiderId,s.threadId,first.nextCursor!,2)).rejects.toMatchObject({status:400});
  const other=await create();await expect(service.list(fixture.ownerId,other.threadId,first.nextCursor!,2)).rejects.toMatchObject({status:400});
 });
 it('fences a late response when newer requirements arrive',async()=>{
  let finish!:(value:unknown)=>void;let started!:(value?:unknown)=>void;const entered=new Promise(r=>{started=r;});
  const model={analyze:vi.fn().mockImplementation(()=>{started();return new Promise(r=>{finish=r;});})};
  const s=await create();const first=await service.message(fixture.ownerId,s.id,'late-first',0,{text:'增加渠道筛选',intent:'discuss'});const job=processor(baseCard,model).tick(s.id);await entered;
  await service.message(fixture.ownerId,s.id,'late-next',first.revision,{text:'只对本省活动生效',intent:'discuss'});finish({value:{reply:'旧回答',card:baseCard},inputTokens:100,outputTokens:40});await job;
  const current=await service.get(fixture.ownerId,s.id);expect(current.state).toBe('analyzing');expect(current.card).toBeNull();expect(current.summaryVersion).toBe(0);
 });
 it('persists cancellation and retries the same message without duplicating entries',async()=>{
  const s=await create();const first=await service.message(fixture.ownerId,s.id,'cancel-input',0,{text:'增加渠道筛选',intent:'discuss'});
  const cancelled=await service.action(fixture.ownerId,s.id,first.activeTurn!.id,'cancel-action',first.revision,'cancel');expect(cancelled.activeTurn?.status).toBe('cancelled');
  const retried=await service.action(fixture.ownerId,s.id,first.activeTurn!.id,'retry-action',cancelled.revision,'retry');expect(retried.activeTurn?.id).toBe(first.activeTurn?.id);
  expect(await db.threadEntry.count({where:{requirementSessionId:s.id,role:'user'}})).toBe(1);
 });
 it.each([['prd'],['prototype'],['prd','prototype']] as ('prd'|'prototype')[][])('one confirmation starts exactly one logical generation for %j',async(...kinds)=>{
  // Vitest spreads array cases into parameters.
  const selected=kinds.filter(x=>x==='prd'||x==='prototype') as ('prd'|'prototype')[];
  const s=await ready(selected);expect(s.state).toBe('ready_to_confirm');const body=accept(s),key=randomUUID();
  const responses=await Promise.all([service.confirm(fixture.ownerId,s.id,key,s.revision,body),service.confirm(fixture.ownerId,s.id,key,s.revision,body)]);
  expect(responses[0].confirmation?.id).toBe(responses[1].confirmation?.id);
  const job=processor({...baseCard,outputKinds:selected});await job.tick(s.id);await job.tick(s.id);
  const result=await service.get(fixture.ownerId,s.id);expect(result.confirmation?.status).toBe('started');expect(await db.run.count({where:{threadId:s.threadId}})).toBe(1);
  const run=await db.run.findUniqueOrThrow({where:{id:result.confirmation!.runId!}});expect((run.request as any).requestedArtifactKinds).toEqual(selected);expect(run.knowledgeReleaseId).toBe(fixture.releaseId);
  expect(await db.$transaction(tx=>confirmedRequirementBaseline(tx,run,startRunRequestSchema.parse(run.request)))).toMatchObject({confirmationId:result.confirmation?.id});
  expect((await service.confirm(fixture.ownerId,s.id,key,s.revision,body)).confirmation?.runId).toBe(run.id);
 });
 it('a new requirement invalidates a pending confirmation and cannot launch the old baseline',async()=>{
  const s=await ready();const confirmed=await service.confirm(fixture.ownerId,s.id,'invalidate-confirm',s.revision,accept(s));
  await service.message(fixture.ownerId,s.id,'changed-after-confirm',confirmed.revision,{text:'另外增加跨省授权',intent:'discuss'});
  expect((await db.requirementConfirmation.findUniqueOrThrow({where:{id:confirmed.confirmation!.id}})).status).toBe('invalidated');
  await expect(prototypes.createConfirmedRequirementPlan(fixture.ownerId,s.projectId,confirmed.confirmation!.id)).rejects.toMatchObject({status:409});expect(await db.run.count({where:{threadId:s.threadId}})).toBe(0);
 });
 it('database rejects summary rewrites after publication',async()=>{
  const s=await ready();await expect(db.requirementSummary.update({where:{sessionId_version:{sessionId:s.id,version:s.summaryVersion}},data:{checksum:'b'.repeat(64)}})).rejects.toBeDefined();
 });
 it('direct Run, old create-plan and new modification endpoints cannot bypass confirmation',async()=>{
  const s=await create();const request=startRunRequestSchema.parse(s.generationRequest);
  await expect(runs.start(fixture.ownerId,s.threadId,'bypass-run',request)).rejects.toMatchObject({status:409});
  const principal={id:fixture.ownerId} as never;
  expect(await db.run.count({where:{threadId:s.threadId}})).toBe(0);
 });
 it('does not generate when critical permission uncertainty is marked nonblocking by the model',async()=>{
  const s=await create();await service.message(fixture.ownerId,s.id,'critical-input',0,{text:'增加跨省访问',intent:'confirm_suggestion'});
  await processor({...baseCard,issues:[{id:'permission',kind:'missing',question:'哪些区域可以访问？',impact:'permission',blocking:false,evidenceIds:[]}]}).tick(s.id);
  const current=await service.get(fixture.ownerId,s.id);expect(current.state).toBe('needs_clarification');expect(current.confirmation).toBeNull();expect(await db.run.count({where:{threadId:s.threadId}})).toBe(0);
 });
 it('explicit suggested-generation intent uses the same confirmation and one approved plan',async()=>{
  const s=await create();await service.message(fixture.ownerId,s.id,'suggested-confirm',0,{text:'按建议直接生成，其他流程保留',intent:'confirm_suggestion'});
  await processor().tick(s.id);const current=await service.get(fixture.ownerId,s.id);expect(current.confirmation?.status).toBe('started');
  const plan=await db.prototypePlan.findUniqueOrThrow({where:{id:current.confirmation!.planId!}});expect(plan.status).toBe('approved');expect(await db.run.count({where:{threadId:s.threadId}})).toBe(1);
 });
 it('never turns model suggestions into user consent during ordinary discussion',async()=>{
  const s=await ready();expect(s.state).toBe('ready_to_confirm');expect(s.confirmation).toBeNull();expect(await db.run.count({where:{threadId:s.threadId}})).toBe(0);
 });
 it('concurrent distinct confirm keys still consume one summary once',async()=>{
  const s=await ready();const body=accept(s);const result=await Promise.all([service.confirm(fixture.ownerId,s.id,'confirm-a',s.revision,body),service.confirm(fixture.ownerId,s.id,'confirm-b',s.revision,body)]);
  expect(result[0].confirmation?.id).toBe(result[1].confirmation?.id);expect(await db.requirementConfirmation.count({where:{sessionId:s.id}})).toBe(1);
 });
 it('leaves a started baseline unchanged when new requirements are appended during generation',async()=>{
  const s=await ready();await service.confirm(fixture.ownerId,s.id,'start-before-change',s.revision,accept(s));await processor().tick(s.id);
  const started=await service.get(fixture.ownerId,s.id);const run=await db.run.findUniqueOrThrow({where:{id:started.confirmation!.runId!}});
  await service.message(fixture.ownerId,s.id,'later-change',started.revision,{text:'下一轮还要讨论渠道统计',intent:'discuss'});
  const after=await db.run.findUniqueOrThrow({where:{id:run.id}});expect(after.request).toEqual(run.request);const replay=await service.confirm(fixture.ownerId,s.id,'start-before-change',s.revision,accept(s));expect(replay.confirmation?.runId).toBe(run.id);expect((await db.requirementConfirmation.findUniqueOrThrow({where:{id:started.confirmation!.id}})).status).toBe('started');
  expect(await db.$transaction(tx=>confirmedRequirementBaseline(tx,after,startRunRequestSchema.parse(after.request)))).toMatchObject({confirmationId:started.confirmation!.id});
 });
 it('recovers an expired analysis lease as a failed receipt without a second model call',async()=>{
  const s=await create();const pending=await service.message(fixture.ownerId,s.id,'interrupted-input',0,{text:'增加渠道筛选',intent:'discuss'});
  await db.requirementTurn.update({where:{id:pending.activeTurn!.id},data:{status:'running',attempt:1,leaseOwner:'lost-process',leaseExpiresAt:new Date(0)}});
  const model={analyze:vi.fn()};await processor(baseCard,model).tick(s.id);const current=await service.get(fixture.ownerId,s.id);expect(current.activeTurn?.failureCode).toBe('REQUIREMENT_TURN_INTERRUPTED');expect(current.state).toBe('discussing');expect(model.analyze).not.toHaveBeenCalled();
 });
 it('records dispatch failure and retries the frozen confirmation without reanalysis or duplicate Run',async()=>{
  const s=await ready();await service.confirm(fixture.ownerId,s.id,'dispatch-recovery',s.revision,accept(s));models.assertAvailable.mockRejectedValueOnce(new Error('fixture catalog outage'));
  const job=processor();await job.tick(s.id);let current=await service.get(fixture.ownerId,s.id);expect(current.confirmation?.status).toBe('pending');expect(current.confirmation?.failureCode).toBeTruthy();expect(await db.run.count({where:{threadId:s.threadId}})).toBe(0);
  await db.requirementConfirmation.update({where:{id:current.confirmation!.id},data:{nextAttemptAt:new Date(0)}});await job.tick(s.id);current=await service.get(fixture.ownerId,s.id);expect(current.confirmation?.status).toBe('started');expect(await db.run.count({where:{threadId:s.threadId}})).toBe(1);
 });
 it('database rejects confirmed baseline and source snapshot rewrites',async()=>{
  const s=await ready();const confirmed=await service.confirm(fixture.ownerId,s.id,'immutable-confirm',s.revision,accept(s));
  await expect(db.requirementConfirmation.update({where:{id:confirmed.confirmation!.id},data:{baseline:{forged:true}}})).rejects.toBeDefined();
  await expect(db.requirementConfirmation.update({where:{id:confirmed.confirmation!.id},data:{inputSnapshot:{forged:true}}})).rejects.toBeDefined();
 });

 it('does not apply an older explicit consent to a newer turn snapshot',async()=>{
  const s=await create();await service.message(fixture.ownerId,s.id,'intent-fence',0,{text:'按建议直接生成',intent:'confirm_suggestion'});
  const originalGet=service.get.bind(service);const spy=vi.spyOn(service,'get').mockImplementationOnce(async(principalId,sessionId)=>{const value=await originalGet(principalId,sessionId);return {...value,activeTurn:value.activeTurn?{...value.activeTurn,id:'newer-turn'}:null};});
  try{await processor().tick(s.id);}finally{spy.mockRestore();}
  expect(await db.requirementConfirmation.count({where:{sessionId:s.id}})).toBe(0);expect(await db.run.count({where:{threadId:s.threadId}})).toBe(0);
 });

 it('explicitly resumes the same frozen confirmation after 12 dispatch failures and process recreation',async()=>{
  const s=await ready();const body=accept(s);await service.confirm(fixture.ownerId,s.id,'exhausted-dispatch',s.revision,body);
  const outage=new Error('fixture prolonged catalog outage');models.assertAvailable.mockRejectedValue(outage);
  for(let attempt=0;attempt<12;attempt++){
   const pending=await db.requirementConfirmation.findFirstOrThrow({where:{sessionId:s.id}});
   await db.requirementConfirmation.update({where:{id:pending.id},data:{nextAttemptAt:new Date(0)}});
   await processor().tick(s.id);
  }
  const exhausted=await db.requirementConfirmation.findFirstOrThrow({where:{sessionId:s.id}});expect(exhausted.dispatchAttempts).toBe(12);expect(exhausted.status).toBe('pending');expect(await db.run.count({where:{threadId:s.threadId}})).toBe(0);
  models.assertAvailable.mockResolvedValue(undefined);
  const resumed=await service.confirm(fixture.ownerId,s.id,'exhausted-dispatch',s.revision,body);expect(resumed.confirmation?.id).toBe(exhausted.id);
  const recreated=new RequirementsService(db as never,access,runs);
  await new RequirementsProcessor(recreated,{analyze:vi.fn()} as never,{} as never,runs,prototypes).tick(s.id);
  const finished=await recreated.get(fixture.ownerId,s.id);expect(finished.confirmation?.status).toBe('started');expect(finished.confirmation?.id).toBe(exhausted.id);
  const stored=await db.requirementConfirmation.findUniqueOrThrow({where:{id:exhausted.id}});expect(stored.baseline).toEqual(exhausted.baseline);expect(await db.run.count({where:{threadId:s.threadId}})).toBe(1);
 });

 it('recovers exhausted dispatch after refresh without the original browser confirmation key',async()=>{
  const s=await ready();const confirmed=await service.confirm(fixture.ownerId,s.id,'browser-lost-key',s.revision,accept(s));
  await db.requirementConfirmation.update({where:{id:confirmed.confirmation!.id},data:{dispatchAttempts:12,lastFailureCode:'REQUIREMENT_ANALYSIS_UNAVAILABLE',nextAttemptAt:new Date(0)}});
  const fresh=await service.get(fixture.ownerId,s.id);const retry=await service.retryConfirmation(fixture.ownerId,s.id,fresh.confirmation!.id,'fresh-dispatch-retry',fresh.revision);expect(retry.confirmation?.id).toBe(confirmed.confirmation!.id);
  await processor().tick(s.id);const started=await service.get(fixture.ownerId,s.id);expect(started.confirmation?.status).toBe('started');
  const replay=await service.retryConfirmation(fixture.ownerId,s.id,fresh.confirmation!.id,'fresh-dispatch-retry',fresh.revision);expect(replay.confirmation?.runId).toBe(started.confirmation?.runId);expect(await db.run.count({where:{threadId:s.threadId}})).toBe(1);
 });

 it.each(['unchanged','resolved-before-confirm','resolved-after-start','joint-output','confirm-locks-first','resolve-locks-first'] as const)('source-bound confirmation fences selected feedback: %s',async feedbackChange=>{
  const initial=await ready(['prototype']);await service.confirm(fixture.ownerId,initial.id,'source-plan-confirm',initial.revision,accept(initial));await processor({...baseCard,outputKinds:['prototype']}).tick(initial.id);
  const started=await service.get(fixture.ownerId,initial.id),sourcePlan=await db.prototypePlan.findUniqueOrThrow({where:{id:started.confirmation!.planId!}});
  const document=prototypeDocumentFixture(),checksum=createHash('sha256').update(canonicalJson(document)).digest('hex');
  const artifact=await db.artifact.create({data:{projectId:initial.projectId,kind:'prototype',title:'Fixture existing prototype'}});
  const chunk=await db.knowledgeChunk.findUniqueOrThrow({where:{id:fixture.productionChunkId},include:{document:true}});
  const citations=[{id:'source-fixture',documentId:chunk.documentId,chunkId:chunk.id,sourcePath:chunk.document.sourcePath,title:chunk.document.title,quote:chunk.content,locator:{heading:null,startLine:null,endLine:null}}];
  const version=await db.artifactVersion.create({data:{artifactId:artifact.id,projectId:initial.projectId,version:1,schemaVersion:1,status:'ready',content:document as never,checksum,citations,createdByRunId:started.confirmation!.runId,knowledgeReleaseId:fixture.releaseId}});
  await db.artifact.update({where:{id:artifact.id},data:{currentVersionId:version.id}});
  const source=await db.prototypeRevision.create({data:{projectId:initial.projectId,planId:sourcePlan.id,createdById:fixture.ownerId,version:sourcePlan.contentVersion,status:'ready',title:'Fixture immutable source',sourceDocument:document as never,sourceArtifactVersionId:version.id,pages:document.screens.map((x,i)=>({id:x.id,slug:x.id,title:x.name,route:x.route,order:i,content:'<div>Fixture</div>',sha256:'b'.repeat(64)})),documentSha256:checksum,idempotencyKey:randomUUID(),requestHash:checksum}});
  const anchor={scope:'node' as const,sourceRevisionId:source.id,pageId:'screen-a',nodeId:'node-a'};
  const feedback=await db.prototypeFeedback.create({data:{id:randomUUID(),projectId:initial.projectId,revisionId:source.id,createdById:fixture.ownerId,body:'仅调整选中节点的渠道提示',anchor,idempotencyKey:randomUUID(),requestHash:checksum}});
  const thread=await db.thread.create({data:{projectId:initial.projectId,createdById:fixture.ownerId,title:'Source-bound change'}});
  const request=startRunRequestSchema.parse({...initial.generationRequest,workflow:'edit',artifactTargets:[{artifactId:artifact.id,artifactVersionId:version.id,screenIds:[]}],requestedArtifactKinds:['prototype']});
  const context={kind:'revision' as const,revisionId:source.id,feedbackIds:[feedback.id],anchor};
  const s=await service.create(fixture.ownerId,thread.id,'source-bound-session',request,context);
  await service.message(fixture.ownerId,s.id,'source-bound-message',0,{text:'仅调整选中节点的渠道提示，其余页面与流程不变',intent:'discuss'});
  const outputKinds=feedbackChange==='joint-output'?['prd','prototype'] as const:['prototype'] as const;
  if(outputKinds.length===2){const current=await service.get(fixture.ownerId,s.id);await service.message(fixture.ownerId,s.id,'source-bound-joint',current.revision,{text:'需要文档与原型一起输出',intent:'discuss',generationRequest:{...request,requestedArtifactKinds:[...outputKinds]}});}
  const real=processor({...baseCard,outputKinds:[...outputKinds]}) as any;
  real.contextReader={read:vi.fn().mockResolvedValue({readings:[],artifactTargets:[{id:version.id,checksum,content:document}]})};await real.tick(s.id);
  const reviewed=await service.get(fixture.ownerId,s.id);expect(reviewed.state).toBe('ready_to_confirm');
  if(feedbackChange==='confirm-locks-first'||feedbackChange==='resolve-locks-first'){
   let release!:()=>void,entered!:(pid:number)=>void,otherEntered!:(pid:number)=>void;
   const hold=new Promise<void>(resolve=>{release=resolve;}),firstReady=new Promise<number>(resolve=>{entered=resolve;}),otherReady=new Promise<number>(resolve=>{otherEntered=resolve;});
   const firstIsConfirm=feedbackChange==='confirm-locks-first';
   const firstDb=transactionView(async tx=>{
    const [{pid}]=await tx.$queryRaw<{pid:number}[]>`SELECT pg_backend_pid() AS pid`;
    return new Proxy(tx,{get(target,key){
     if(key==='prototypeFeedback')return new Proxy(target.prototypeFeedback,{get(delegate,method){
      if(method===(firstIsConfirm?'findMany':'updateMany'))return async(args:never)=>{const result=await (delegate[method] as any)(args);entered(pid!);await hold;return result;};
      const value=Reflect.get(delegate,method);return typeof value==='function'?value.bind(delegate):value;
     }});const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});
   });
   const otherDb=transactionView(async tx=>{const [{pid}]=await tx.$queryRaw<{pid:number}[]>`SELECT pg_backend_pid() AS pid`;otherEntered(pid!);return tx;});
   const confirming=new RequirementsService((firstIsConfirm?firstDb:otherDb) as never,access,runs);
   const resolving=new PrototypeV2Service((firstIsConfirm?otherDb:firstDb) as never,workflows as never,new ConfigService(),{} as never,runs);
   const confirm=()=>confirming.confirm(fixture.ownerId,s.id,'racing-confirm',reviewed.revision,accept(reviewed));
   const resolve=()=>resolving.resolveFeedback({id:fixture.ownerId} as never,s.projectId,feedback.id,'racing-resolve','"0"',{});
   const first=firstIsConfirm?confirm():resolve();const firstPid=await firstReady;
   const other=firstIsConfirm?resolve():confirm();const otherResult=other.then(value=>({value}),error=>({error}));
   try{
    const otherPid=await otherReady;
    await vi.waitFor(async()=>{const [{pids}]=await db.$queryRaw<{pids:number[]}[]>`SELECT pg_blocking_pids(${otherPid}::int) AS pids`;expect(pids).toContain(firstPid);},{timeout:3000,interval:20});
   }finally{release();}
   await first;const outcome=await otherResult;resolving.onModuleDestroy();
   expect((await db.prototypeFeedback.findUniqueOrThrow({where:{id:feedback.id}})).status).toBe('resolved');
   if(firstIsConfirm){
    expect(outcome).toHaveProperty('value');const frozen=await db.requirementConfirmation.findFirstOrThrow({where:{sessionId:s.id}});
    expect((frozen.baseline as any).analysisContext.projectContext.source.feedback[0].status).toBe('open');
   }else{
    expect(outcome).toMatchObject({error:{status:409,response:{code:'REQUIREMENT_BASELINE_CHANGED'}}});expect(await db.requirementConfirmation.count({where:{sessionId:s.id}})).toBe(0);
   }
   expect(await db.run.count({where:{threadId:s.threadId}})).toBe(0);return;
  }
  if(feedbackChange==='resolved-before-confirm'){
   await prototypes.resolveFeedback({id:fixture.ownerId} as never,s.projectId,feedback.id,'resolve-before-confirm','"0"',{});
   await expect(service.confirm(fixture.ownerId,s.id,'source-bound-confirm',reviewed.revision,accept(reviewed))).rejects.toMatchObject({status:409,response:{code:'REQUIREMENT_BASELINE_CHANGED'}});
   await real.tick(s.id);expect(await db.run.count({where:{threadId:s.threadId}})).toBe(0);expect((await service.get(fixture.ownerId,s.id)).state).toBe('ready_to_confirm');
   expect(await db.threadEntry.count({where:{requirementSessionId:s.id}})).toBe(2);return;
  }
  await service.confirm(fixture.ownerId,s.id,'source-bound-confirm',reviewed.revision,accept(reviewed));await real.tick(s.id);
  const done=await service.get(fixture.ownerId,s.id);expect(done.confirmation?.status).toBe('started');const plan=await db.prototypePlan.findUniqueOrThrow({where:{id:done.confirmation!.planId!}});
  expect(plan.sourceRevisionId).toBe(source.id);expect(plan.feedbackIds).toEqual([feedback.id]);const run=await db.run.findUniqueOrThrow({where:{id:done.confirmation!.runId!}});expect((run.request as any).artifactTargets).toEqual([{artifactId:artifact.id,artifactVersionId:version.id,screenIds:[]}]);
  const confirmation=await db.requirementConfirmation.findUniqueOrThrow({where:{id:done.confirmation!.id}});expect((confirmation.baseline as any).context.anchor).toEqual(anchor);expect((await db.prototypeRevision.findUniqueOrThrow({where:{id:source.id}})).sourceDocument).toEqual(document);
  expect((run.request as any).requestedArtifactKinds).toEqual([...outputKinds]);
  if(feedbackChange==='resolved-after-start'){
   await prototypes.resolveFeedback({id:fixture.ownerId} as never,s.projectId,feedback.id,'resolve-after-start','"0"',{});
   const replay=await service.confirm(fixture.ownerId,s.id,'source-bound-confirm',reviewed.revision,accept(reviewed));expect(replay.confirmation?.runId).toBe(run.id);
   expect((await db.requirementConfirmation.findUniqueOrThrow({where:{id:confirmation.id}})).baseline).toEqual(confirmation.baseline);
   expect((confirmation.baseline as any).analysisContext.projectContext.source.feedback[0].status).toBe('open');
   expect(await db.$transaction(tx=>confirmedRequirementBaseline(tx,run,startRunRequestSchema.parse(run.request)))).toMatchObject({confirmationId:confirmation.id});
  }
 });

 it('applies the same private-entry audience to bootstrap and list pagination for owner, editor and viewer',async()=>{
  const s=await create();await service.message(fixture.ownerId,s.id,'bootstrap-private',0,{text:'未确认的私有讨论',intent:'discuss'});
  const seq=await db.thread.update({where:{id:s.threadId},data:{entrySequence:{increment:1}}});
  await db.threadEntry.create({data:{threadId:s.threadId,sequence:seq.entrySequence,role:'assistant',kind:'message',content:{protocol:'workbench.entry.v1',type:'assistant.message',text:'历史公开消息'}}});
  await db.board.upsert({where:{projectId:s.projectId},create:{projectId:s.projectId,viewport:{x:0,y:0,zoom:1}},update:{}});
  const projects=new ProjectsService(db as never,access),threads=new ThreadsService(db as never,access);
  const owner=await projects.bootstrap(fixture.ownerId,s.projectId,s.threadId);expect(owner.entries.map(x=>(x.content as any).text)).toContain('未确认的私有讨论');
  for(const role of ['editor','viewer'] as const){
   await db.projectMember.update({where:{projectId_principalId:{projectId:s.projectId,principalId:fixture.outsiderId}},data:{role}});
   const boot=await projects.bootstrap(fixture.outsiderId,s.projectId,s.threadId);expect(boot.entries.map(x=>(x.content as any).text)).toEqual(['历史公开消息']);
   const page=await threads.listEntries(fixture.outsiderId,s.threadId,0,1);expect(page.items.map(x=>(x.content as any).text)).toEqual(['历史公开消息']);expect(page.nextAfterSequence).toBeNull();
  }
  const first=await threads.listEntries(fixture.ownerId,s.threadId,0,1);expect((first.items[0].content as any).text).toBe('未确认的私有讨论');expect(first.nextAfterSequence).not.toBeNull();
  const next=await threads.listEntries(fixture.ownerId,s.threadId,first.nextAfterSequence!,1);expect((next.items[0].content as any).text).toBe('历史公开消息');
 });

 it.each(['prd','prototype'] as const)('preserves confirmed %s inputs and author across editor retry chains after a new knowledge release',async kind=>{
  await db.workspaceMember.createMany({data:[{workspaceId:fixture.workspaceId,principalId:fixture.outsiderId,role:'member'}],skipDuplicates:true});
  await db.projectMember.upsert({where:{projectId_principalId:{projectId:fixture.projectId,principalId:fixture.outsiderId}},create:{projectId:fixture.projectId,workspaceId:fixture.workspaceId,principalId:fixture.outsiderId,role:'editor'},update:{role:'editor'}});
  const {s,job}=await discussionWithSource([kind],true);await service.message(fixture.ownerId,s.id,'retry-source-message',0,{text:'保留原规则和设计，增加渠道筛选',intent:'discuss'});await job.tick(s.id);
  const reviewed=await service.get(fixture.ownerId,s.id);await service.confirm(fixture.ownerId,s.id,'retry-source-confirm',reviewed.revision,accept(reviewed));await job.tick(s.id);
  const started=await service.get(fixture.ownerId,s.id),original=await db.run.findUniqueOrThrow({where:{id:started.confirmation!.runId!},include:{sourceSnapshots:true}});
  await db.run.update({where:{id:original.id},data:{status:'failed',errorRetryable:true}});
  if(kind==='prototype')await db.prototypePlan.update({where:{id:started.confirmation!.planId!},data:{status:'failed',revision:{increment:1}}});
  const later=await db.$transaction(tx=>seedFixture(tx,{workspaceId:fixture.workspaceId,version:kind==='prd'?101:102}),{timeout:60000});
  expect((await db.knowledgeRelease.findUniqueOrThrow({where:{id:later.releaseId}})).status).toBe('ready');
  let retryId:string;
  if(kind==='prd')retryId=(await runs.retry(fixture.outsiderId,original.id,'other-editor-prd-retry')).id;
  else {const plan=await prototypes.retryPlan({id:fixture.outsiderId} as never,s.projectId,started.confirmation!.planId!,'other-editor-prototype-retry','"1"',{});retryId=(await db.prototypePlan.findUniqueOrThrow({where:{id:plan.id}})).runtimeRunId!;}
  const retry=await db.run.findUniqueOrThrow({where:{id:retryId},include:{sourceSnapshots:true}});
  expect(retry.createdById).toBe(fixture.outsiderId);expect(retry.retryOfRunId).toBe(original.id);expect(retry.request).toEqual(original.request);expect(retry.knowledgeReleaseId).toBe(original.knowledgeReleaseId);expect(retry.knowledgeReleaseId).not.toBe(later.releaseId);expect(retry.designStyleSnapshot).toEqual(original.designStyleSnapshot);expect(retry.designStyleSnapshotSha256).toBe(original.designStyleSnapshotSha256);expect(retry.sourceSnapshots.map(x=>x.snapshot)).toEqual(original.sourceSnapshots.map(x=>x.snapshot));
  expect(await db.$transaction(tx=>confirmedRequirementBaseline(tx,retry,startRunRequestSchema.parse(retry.request)))).toMatchObject({confirmationId:started.confirmation!.id});
  expect((await db.requirementConfirmation.findUniqueOrThrow({where:{id:started.confirmation!.id}})).principalId).toBe(fixture.ownerId);
  await db.run.update({where:{id:retry.id},data:{status:'failed',errorRetryable:true}});
  let secondId:string;
  if(kind==='prd')secondId=(await runs.retry(fixture.ownerId,retry.id,'owner-retry-chain')).id;
  else{
   const retryPlan=await db.prototypePlan.findFirstOrThrow({where:{runtimeRunId:retry.id}});await db.prototypePlan.update({where:{id:retryPlan.id},data:{status:'failed',revision:{increment:1}}});
   await expect(runs.retry(fixture.ownerId,retry.id,'reject-generic-prototype-retry')).rejects.toMatchObject({status:409,response:{code:'PROTOTYPE_PLAN_RETRY_REQUIRED'}});
   const next=await prototypes.retryPlan({id:fixture.ownerId} as never,s.projectId,retryPlan.id,'owner-plan-retry-chain',`"${retryPlan.revision+1}"`,{});secondId=(await db.prototypePlan.findUniqueOrThrow({where:{id:next.id}})).runtimeRunId!;
  }
  const secondRun=await db.run.findUniqueOrThrow({where:{id:secondId}});
  expect(await db.$transaction(tx=>confirmedRequirementBaseline(tx,secondRun,startRunRequestSchema.parse(secondRun.request)))).toMatchObject({confirmationId:started.confirmation!.id});
  await db.run.update({where:{id:secondId},data:{status:'failed',errorRetryable:true}});await db.projectMember.update({where:{projectId_principalId:{projectId:s.projectId,principalId:fixture.outsiderId}},data:{role:'viewer'}});
  await expect(runs.retry(fixture.outsiderId,secondId,'viewer-cannot-retry')).rejects.toMatchObject({status:404});
 });

 function transactionView(decorate:(tx:Prisma.TransactionClient)=>Promise<Prisma.TransactionClient>){
  return new Proxy(db,{get(target,key){if(key==='$transaction')return (operation:(tx:Prisma.TransactionClient)=>Promise<unknown>)=>db.$transaction(async tx=>operation(await decorate(tx)),{timeout:15000});const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 }
});
