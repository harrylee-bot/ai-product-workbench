import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { Readable } from 'node:stream';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient } from '@workbench/workbench-db';
import { startRunRequestSchema } from '@workbench/workbench-contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { seedFixture } from './fixtures/knowledge-retrieval.js';
import { ProblemDetailsFilter } from '../src/common/problem-details.filter.js';
import { AccessService } from '../src/modules/access/access.service.js';
import { DesignPresetsService } from '../src/modules/design-presets/design-presets.service.js';
import { IdentityService } from '../src/modules/identity/identity.service.js';
import { WorkbenchAuthGuard } from '../src/modules/identity/workbench-auth.guard.js';
import { FilesController } from '../src/modules/files/files.controller.js';
import { FilesService } from '../src/modules/files/files.service.js';
import { FileUploadsService } from '../src/modules/files/file-uploads.service.js';
import { ImportSourcesController } from '../src/modules/import-sources/import-sources.controller.js';
import { ImportSourcesService } from '../src/modules/import-sources/import-sources.service.js';
import { RequirementsController } from '../src/modules/requirements/requirements.controller.js';
import { RequirementsService } from '../src/modules/requirements/requirements.service.js';
import { RequirementsProcessor } from '../src/modules/requirements/requirements.processor.js';
import { RequirementKnowledge } from '../src/modules/requirements/requirement-knowledge.js';
import { RequirementContextReader } from '../src/modules/requirements/requirement-context-reader.js';
import { PrototypeV2Controller } from '../src/modules/prototypes/prototype-v2.controller.js';
import { PrototypeV2Service } from '../src/modules/prototypes/prototype-v2.service.js';
import { RunsController } from '../src/modules/runs/runs.controller.js';
import { RunsService } from '../src/modules/runs/runs.service.js';
import { RunEventStore } from '../src/modules/runs/run-event.store.js';
import { FileVerificationProcessor } from '../../workbench-file-worker/src/verification/file-verification.processor.js';
import { PrismaVerificationStore } from '../../workbench-file-worker/src/verification/prisma-verification.store.js';
import { confirmedRequirementBaseline } from '../../workbench-worker/src/runs/confirmed-requirement-baseline.js';

const databaseUrl=process.env.WORKBENCH_REQUIREMENTS_TEST_DATABASE_URL;
const suite=databaseUrl?describe:describe.skip;
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');

/** Real HTTP, API services, PG, indexed lexical retrieval, byte verification and
 * confirmation fencing. Model, malware scanner, workflow and storage transports
 * are controlled fixtures; this is not a real-model/Temporal acceptance claim. */
suite('New generation flow over actual HTTP and PostgreSQL',()=>{
 const db=new PrismaClient({datasourceUrl:databaseUrl});
 let fixture:Awaited<ReturnType<typeof seedFixture>>,app:NestExpressApplication,origin:string,objectServer:Server,objectOrigin:string;
 let sessions:RequirementsService,processor:RequirementsProcessor,prototypes:PrototypeV2Service;
 let sourceId:string;
 const sourceBytes=Buffer.from('# 产品工作台规则\n活动列表保留已有权限，本次只增加渠道筛选。'+randomUUID());
 const objects=new Map<string,{bytes:Buffer;mediaType:string}>();
 const uploads=new Map<string,{key:string;mediaType:string;parts:Map<number,{bytes:Buffer;etag:string}>}>();
 const queue={sendInTransaction:vi.fn(async()=>randomUUID())};
 const models={assertAvailable:vi.fn(async()=>undefined)};
 const workflows={configured:true,startPlan:vi.fn(),cancelPlan:vi.fn(),startExport:vi.fn(),cancelExport:vi.fn()};
 const model={analyze:vi.fn(async(input:any)=>{
  const evidence=input.context.evidence[0];if(!evidence)throw Error('INDEXED_EVIDENCE_REQUIRED');
  const request=input.context.configuration;
  return {value:{reply:'保留原平台，确认本次渠道筛选增量。',card:{goal:'活动列表增加渠道筛选',platform:'产品工作台',modules:['活动管理'],roles:['已有业务用户'],existingCapabilities:[{description:evidence.quote,scope:evidence.scope,evidenceIds:[evidence.id]}],reuse:['原活动列表'],changes:['仅增加渠道筛选'],affectedPages:['活动列表'],affectedFlows:['列表筛选'],targetSurface:request.targetSurface,designConstraints:['保留原导航'],outputKinds:request.requestedArtifactKinds,assumptions:[],issues:[],platformChanges:[],preserved:['原权限和其他页面']}},inputTokens:10,outputTokens:10};
 })};
 const storage={
  createMultipartUpload:vi.fn(async({key,mediaType}:{key:string;mediaType:string})=>{const uploadId=randomUUID();uploads.set(uploadId,{key,mediaType,parts:new Map()});return {uploadId};}),
  signMultipartPart:async({uploadId,partNumber,contentLength}:any)=>({url:`${objectOrigin}/${uploadId}/${partNumber}`,headers:{'content-length':String(contentLength)},expiresAt:new Date(Date.now()+60000)}),
  listMultipartParts:async({uploadId}:any)=>[...uploads.get(uploadId)!.parts].map(([partNumber,part])=>({partNumber,etag:part.etag,byteSize:part.bytes.length})),
  completeMultipartUpload:async({uploadId,parts}:any)=>{const state=uploads.get(uploadId)!;objects.set(state.key,{bytes:Buffer.concat(parts.map((part:any)=>state.parts.get(part.partNumber)!.bytes)),mediaType:state.mediaType});},
  abortMultipartUpload:async({uploadId}:any)=>{uploads.delete(uploadId);},
  statObject:async(key:string)=>{const row=objects.get(key);return row?{byteSize:row.bytes.length,mediaType:row.mediaType,etag:sha(row.bytes)}:null;},
  getObject:async(input:string|{key:string})=>{const row=objects.get(typeof input==='string'?input:input.key);if(!row)throw Error('FIXTURE_OBJECT_MISSING');return {body:Readable.from([row.bytes]),byteSize:row.bytes.length,mediaType:row.mediaType,contentRange:null};},
  promoteObject:async(input:any)=>{const row=objects.get(input.sourceKey)!;expect(sha(row.bytes)).toBe(input.sha256);objects.set(input.destinationKey,{...row,mediaType:input.mediaType});},
  putContentAddressed:async()=>{throw Error('UNEXPECTED_EXTRACTION');},
  deleteObject:async(key:string)=>{objects.delete(key);},
 };
 async function boot(){
  const access=new AccessService(db as never);
  const runs=new RunsService(db as never,access,new RunEventStore(),queue as never,models as never,new DesignPresetsService());
  sessions=new RequirementsService(db as never,access,runs);
  const config=new ConfigService({WORKBENCH_AUTH_MODE:'development',NODE_ENV:'test'});
  prototypes=new PrototypeV2Service(db as never,workflows,config,storage as never,runs);
  processor=new RequirementsProcessor(sessions,model as never,new RequirementKnowledge(db as never,access,{providers:null} as never),runs,prototypes,new RequirementContextReader(db as never,storage));
  const fileConfig={stagingPrefix:'test-http-staging',preferredPartSize:8*1024*1024,sessionTtlSeconds:3600,signedUrlTtlSeconds:60};
  const fileUploads=new FileUploadsService(db as never,storage,queue as never,fileConfig as never);
  const files=new FilesService(db as never,storage,queue as never,fileConfig as never);
  const imports=new ImportSourcesService(db as never,access,queue as never);
  const identity={resolvePrincipal:async({subject}:{subject:string})=>db.principal.findUniqueOrThrow({where:{id:subject}})};
  const guard=new WorkbenchAuthGuard(config,identity as never);
  class HttpFixtureModule{}
  Module({controllers:[RequirementsController,PrototypeV2Controller,RunsController,FilesController,ImportSourcesController],providers:[
   {provide:ConfigService,useValue:config},{provide:IdentityService,useValue:identity},{provide:WorkbenchAuthGuard,useValue:guard},
   {provide:RequirementsService,useValue:sessions},{provide:PrototypeV2Service,useValue:prototypes},{provide:RunsService,useValue:runs},
   {provide:FileUploadsService,useValue:fileUploads},{provide:FilesService,useValue:files},{provide:ImportSourcesService,useValue:imports},
  ]})(HttpFixtureModule);
  app=await NestFactory.create<NestExpressApplication>(HttpFixtureModule,{logger:false,abortOnError:false});
  app.setGlobalPrefix('api/v1');app.useGlobalFilters(new ProblemDetailsFilter());await app.listen(0,'127.0.0.1');
  origin=await app.getUrl()+'/api/v1';
 }
 beforeAll(async()=>{
  fixture=await db.$transaction(tx=>seedFixture(tx,undefined,{path:'01-产品架构/产品能力地图.md',content:'产品工作台用户规则，活动列表只增加渠道筛选。原平台已有活动列表和用户权限。'}),{timeout:60000});
  objectServer=createServer(async(req,res)=>{
   const [id,part]=new URL(req.url!,'http://localhost').pathname.slice(1).split('/');const upload=uploads.get(id!);
   if(req.method!=='PUT'||!upload){res.writeHead(404).end();return;}
   const chunks=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const bytes=Buffer.concat(chunks);const etag=`"${sha(bytes)}"`;
   upload.parts.set(Number(part),{bytes,etag});res.writeHead(200,{etag}).end();
  });
  await new Promise<void>(resolve=>objectServer.listen(0,'127.0.0.1',resolve));const address=objectServer.address();if(!address||typeof address==='string')throw Error('NO_OBJECT_PORT');objectOrigin=`http://127.0.0.1:${address.port}`;
  await boot();
 },60000);
 afterAll(async()=>{prototypes?.onModuleDestroy();await app?.close();await new Promise<void>(resolve=>objectServer?.close(()=>resolve()));await db.$disconnect();});
 async function http(method:string,path:string,options:{body?:unknown;key?:string;etag?:string;principal?:string;status?:number}={}){
  const response=await fetch(origin+path,{method,headers:{'x-workbench-dev-subject':options.principal??fixture.ownerId,...(options.body?{'content-type':'application/json'}:{}),...(options.key?{'idempotency-key':options.key}:{}),...(options.etag?{'if-match':options.etag}:{})},body:options.body?JSON.stringify(options.body):undefined});
  const raw=await response.text(),value=raw?JSON.parse(raw):null;expect(response.status,JSON.stringify(value)).toBe(options.status??200);return {value,etag:response.headers.get('etag'),headers:response.headers};
 }
 async function createDiscussion(kinds:('prd'|'prototype')[]=['prd']){
  expect(sourceId).toBeTruthy();
  const thread=await db.thread.create({data:{projectId:fixture.projectId,createdById:fixture.ownerId,title:'HTTP discussion'}});
  const generationRequest=startRunRequestSchema.parse({prompt:'产品工作台用户规则，活动列表只增加渠道筛选',modelId:'deepseek-flash',workflow:'generate',targetSurface:'web',designStyle:{kind:'automatic'},sourceIds:[sourceId],requestedArtifactKinds:kinds});
  const created=await http('POST',`/threads/${thread.id}/requirement-sessions`,{body:{generationRequest,context:{kind:'new'}},key:randomUUID(),status:201});
  return {thread,generationRequest,created,path:`/requirement-sessions/${created.value.id}`};
 }
 const confirmationBody=(value:any)=>({summaryVersion:value.summaryVersion,summaryChecksum:value.summaryChecksum,acceptedAssumptionIds:[],acceptedPlatformChanges:false});
 it('resumes standalone multipart upload across API restart, verifies bytes and creates a ready source',async()=>{
  const body={fileName:'增量规则.md',declaredMediaType:'text/markdown',byteSize:sourceBytes.length,sha256:sha(sourceBytes)},key=randomUUID();
  const first=await http('POST',`/projects/${fixture.projectId}/file-upload-sessions`,{body,key,status:201});
  const {file,upload}=first.value;
  await http('POST',`/projects/${fixture.projectId}/import-sources`,{body:{kind:'file',fileAssetId:file.id},key:randomUUID(),status:409});
  const signed=await http('POST',`/file-upload-sessions/${upload.id}/parts/1`,{body:{contentLength:sourceBytes.length},etag:first.etag!});
  const stored=await fetch(signed.value.url,{method:'PUT',headers:signed.value.headers,body:sourceBytes});expect(stored.status).toBe(200);
  const part={partNumber:1,etag:stored.headers.get('etag')!};
  prototypes.onModuleDestroy();await app.close();await boot();
  const replay=await http('POST',`/projects/${fixture.projectId}/file-upload-sessions`,{body,key,status:201});expect(replay.value.file.id).toBe(file.id);expect(storage.createMultipartUpload).toHaveBeenCalledTimes(1);
  const parts=await http('GET',`/file-upload-sessions/${upload.id}/parts`);expect(parts.value.parts).toEqual([{...part,byteSize:sourceBytes.length}]);
  await http('GET',`/file-upload-sessions/${upload.id}`,{principal:fixture.outsiderId,status:404});
  const completionKey=randomUUID();const completion=await http('POST',`/file-upload-sessions/${upload.id}/complete`,{body:{parts:[part]},key:completionKey,etag:replay.etag!,status:202});expect(completion.value.file.status).toBe('verifying');
  await http('POST',`/file-upload-sessions/${upload.id}/complete`,{body:{parts:[part]},key:completionKey,etag:replay.etag!,status:202});
  const scanner={scan:async({body}:any)=>{for await(const _ of body){}return {status:'clean' as const,scanner:'fixture-scanner',scannerVersion:'1',signatureVersion:'fixture',evidence:{fixture:true},startedAt:new Date(),finishedAt:new Date()};}};
  const verifier=new FileVerificationProcessor(new PrismaVerificationStore(db,{pending:'test-pending',canonical:'blobs',quarantine:'test-quarantine'}),storage,scanner,10*1024*1024);
  expect(await verifier.verify(upload.id)).toBe('ready');
  const ready=await http('GET',`/files/${file.id}`);expect(ready.value).toMatchObject({status:'ready',sha256:sha(sourceBytes)});
  const source=await http('POST',`/projects/${fixture.projectId}/import-sources`,{body:{kind:'file',fileAssetId:file.id},key:randomUUID(),status:201});sourceId=source.value.id;expect(source.value.status).toBe('ready');
 },90000);
 it.each([['prd'],['prototype'],['prd','prototype']] as const)('discusses and confirms %j over HTTP with exact source bytes and no duplicate execution',async(...selected)=>{
  const kinds=selected.filter(x=>x==='prd'||x==='prototype');
  const {thread,generationRequest,created,path}=await createDiscussion(kinds);
  const message=await http('POST',path+'/messages',{body:{text:generationRequest.prompt},key:randomUUID(),etag:created.etag!,status:202});expect(message.headers.get('cache-control')).toBe('private, no-store');
  expect(await db.run.count({where:{threadId:thread.id}})).toBe(0);await processor.tick(created.value.id);
  const ready=await http('GET',path);expect(ready.value.state,JSON.stringify(ready.value.activeTurn)).toBe('ready_to_confirm');expect(model.analyze.mock.calls.at(-1)?.[0].context.sourceContents.readings[0].text).toBe(sourceBytes.toString());
  await http('GET',path,{principal:fixture.outsiderId,status:404});
  const body=confirmationBody(ready.value),key=randomUUID();
  await http('POST',path+'/confirm',{body,key:randomUUID(),status:428});
  await http('POST',path+'/confirm',{body,key:randomUUID(),etag:created.etag!,status:412});
  await http('POST',path+'/confirm',{body:{...body,summaryChecksum:'0'.repeat(64)},key:randomUUID(),etag:ready.etag!,status:409});
  await http('POST',path+'/confirm',{body,key:randomUUID(),etag:ready.etag!,principal:fixture.outsiderId,status:404});
  await Promise.all(Array.from({length:3},()=>http('POST',path+'/confirm',{body,key,etag:ready.etag!,status:202})));
  await processor.tick(created.value.id);const started=await http('GET',path);expect(started.value.confirmation.status).toBe('started');
  const run=await db.run.findUniqueOrThrow({where:{id:started.value.confirmation.runId},include:{sourceSnapshots:true}});expect(await db.run.count({where:{threadId:thread.id}})).toBe(1);expect(run.sourceSnapshots[0]?.checksum).toBe(sha(sourceBytes));
  expect((await http('POST',path+'/confirm',{body,key,etag:ready.etag!,status:202})).value.confirmation.runId).toBe(run.id);
  expect((run.request as any).requestedArtifactKinds).toEqual(kinds);await expect(db.$transaction(tx=>confirmedRequirementBaseline(tx,run,startRunRequestSchema.parse(run.request)))).resolves.toMatchObject({confirmationId:started.value.confirmation.id});
  const id=started.value.confirmation.planId;
  if(id){const input=await http('GET',`/projects/${fixture.projectId}/prototype-v2/plans/${id}/input`);expect(input.value.request).toEqual(run.request);expect(input.value.snapshot.sources[0].checksum).toBe(sha(sourceBytes));}
  // The runtime terminal state is a fixture; retry routing and immutable input
  // checks below use actual HTTP, API, database and Worker validation.
  await db.run.update({where:{id:run.id},data:{status:'failed',errorRetryable:true}});
  let retryRunId:string;
  if(id){
   const plan=await db.prototypePlan.update({where:{id},data:{status:'failed',revision:{increment:1}}});const queued=queue.sendInTransaction.mock.calls.length;
   const rejected=await http('POST',`/runs/${run.id}/retry`,{key:randomUUID(),status:409});expect(rejected.value.code).toBe('PROTOTYPE_PLAN_RETRY_REQUIRED');expect(queue.sendInTransaction).toHaveBeenCalledTimes(queued);expect(await db.run.count({where:{threadId:thread.id}})).toBe(1);
   const key=randomUUID(),path=`/projects/${fixture.projectId}/prototype-v2/plans/${id}/retry`,options={body:{},key,etag:`"${plan.revision}"`,status:202};
   const retry=await http('POST',path,options);expect((await http('POST',path,options)).value.id).toBe(retry.value.id);retryRunId=(await db.prototypePlan.findUniqueOrThrow({where:{id:retry.value.id}})).runtimeRunId!;
   expect(await db.prototypeWorkflowCommand.count({where:{targetId:retry.value.id,kind:'plan_start'}})).toBe(1);
  }else retryRunId=(await http('POST',`/runs/${run.id}/retry`,{key:randomUUID(),status:202})).value.id;
  const retry=await db.run.findUniqueOrThrow({where:{id:retryRunId},include:{sourceSnapshots:true}});expect(retry.retryOfRunId).toBe(run.id);expect(retry.request).toEqual(run.request);expect(retry.knowledgeReleaseId).toBe(run.knowledgeReleaseId);expect(retry.sourceSnapshots.map(x=>x.snapshot)).toEqual(run.sourceSnapshots.map(x=>x.snapshot));
  expect(await db.run.count({where:{threadId:thread.id}})).toBe(2);await expect(db.$transaction(tx=>confirmedRequirementBaseline(tx,retry,startRunRequestSchema.parse(retry.request)))).resolves.toMatchObject({confirmationId:started.value.confirmation.id});
 },90000);
 it('cancels and retries the same discussion turn across an API restart without duplicating the user entry',async()=>{
  const {thread,generationRequest,created,path}=await createDiscussion();
  const messageKey=randomUUID(),messageBody={text:generationRequest.prompt};
  const message=await http('POST',path+'/messages',{body:messageBody,key:messageKey,etag:created.etag!,status:202});
  const turnPath=path+`/turns/${message.value.activeTurn.id}`;
  const cancelKey=randomUUID(),cancelled=await http('POST',turnPath+'/cancel',{key:cancelKey,etag:message.etag!});
  expect(cancelled.value.activeTurn.status).toBe('cancelled');
  const calls=model.analyze.mock.calls.length;await processor.tick(created.value.id);expect(model.analyze).toHaveBeenCalledTimes(calls);
  prototypes.onModuleDestroy();await app.close();await boot();
  expect((await http('POST',turnPath+'/cancel',{key:cancelKey,etag:message.etag!})).value.activeTurn.status).toBe('cancelled');
  const replay=await http('POST',path+'/messages',{body:messageBody,key:messageKey,etag:created.etag!,status:202});expect(replay.value.activeTurn.id).toBe(message.value.activeTurn.id);
  await http('POST',path+'/messages',{body:{text:'Changed request'},key:messageKey,etag:created.etag!,status:409});
  const retryKey=randomUUID();await http('POST',turnPath+'/retry',{key:retryKey,etag:replay.etag!,status:202});
  await http('POST',turnPath+'/retry',{key:retryKey,etag:replay.etag!,status:202});await processor.tick(created.value.id);
  const ready=await http('GET',path);expect(ready.value.state).toBe('ready_to_confirm');expect(ready.value.activeTurn.id).toBe(message.value.activeTurn.id);expect(model.analyze).toHaveBeenCalledTimes(calls+1);
  expect(await db.threadEntry.count({where:{requirementSessionId:created.value.id,role:'user'}})).toBe(1);expect(await db.run.count({where:{threadId:thread.id}})).toBe(0);
 });
 it('rejects an obsolete confirmation card after a new message and only confirms the latest summary',async()=>{
  const {thread,generationRequest,created,path}=await createDiscussion();
  await http('POST',path+'/messages',{body:{text:generationRequest.prompt},key:randomUUID(),etag:created.etag!,status:202});await processor.tick(created.value.id);
  const old=await http('GET',path),oldBody=confirmationBody(old.value);
  await http('POST',path+'/messages',{body:{text:generationRequest.prompt},key:randomUUID(),etag:old.etag!,status:202});
  await http('POST',path+'/confirm',{body:oldBody,key:randomUUID(),etag:old.etag!,status:412});await processor.tick(created.value.id);
  const ready=await http('GET',path);expect(ready.value.summaryVersion).toBe(old.value.summaryVersion+1);
  await http('POST',path+'/confirm',{body:oldBody,key:randomUUID(),etag:ready.etag!,status:409});expect(await db.run.count({where:{threadId:thread.id}})).toBe(0);
  await http('POST',path+'/confirm',{body:confirmationBody(ready.value),key:randomUUID(),etag:ready.etag!,status:202});await processor.tick(created.value.id);
  expect((await http('GET',path)).value.confirmation.status).toBe('started');expect(await db.run.count({where:{threadId:thread.id}})).toBe(1);
 });
 it('recovers dispatch failure after restart with a new action key and the original frozen confirmation',async()=>{
  const {thread,generationRequest,created,path}=await createDiscussion();
  await http('POST',path+'/messages',{body:{text:generationRequest.prompt},key:randomUUID(),etag:created.etag!,status:202});await processor.tick(created.value.id);
  const ready=await http('GET',path);await http('POST',path+'/confirm',{body:confirmationBody(ready.value),key:randomUUID(),etag:ready.etag!,status:202});
  models.assertAvailable.mockRejectedValueOnce(new Error('fixture catalog unavailable'));await processor.tick(created.value.id);
  const failed=await http('GET',path);expect(failed.value.confirmation.status).toBe('pending');expect(failed.value.confirmation.failureCode).toBeTruthy();expect(await db.run.count({where:{threadId:thread.id}})).toBe(0);
  const frozen=await db.requirementConfirmation.findUniqueOrThrow({where:{id:failed.value.confirmation.id}}),calls=model.analyze.mock.calls.length;
  prototypes.onModuleDestroy();await app.close();await boot();
  const refreshed=await http('GET',path),key=randomUUID(),retryPath=path+`/confirmations/${frozen.id}/retry`;
  await http('POST',retryPath,{key,etag:refreshed.etag!,status:202});await processor.tick(created.value.id);
  const replay=await http('POST',retryPath,{key,etag:refreshed.etag!,status:202});expect(replay.value.confirmation).toMatchObject({id:frozen.id,status:'started'});
  expect(model.analyze).toHaveBeenCalledTimes(calls);expect(await db.run.count({where:{threadId:thread.id}})).toBe(1);
  const final=await db.requirementConfirmation.findUniqueOrThrow({where:{id:frozen.id}});expect(final.baseline).toEqual(frozen.baseline);expect(final.inputSnapshot).toEqual(frozen.inputSnapshot);
 });
});
