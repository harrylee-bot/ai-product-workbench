import { createHash,randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { PrismaClient } from '@workbench/workbench-db';
import { startRunRequestSchema,type RequirementContext,type StartRunRequest } from '@workbench/workbench-contracts';
import { AccessService } from '../../src/modules/access/access.service.js';
import { RunsService } from '../../src/modules/runs/runs.service.js';
import { RequirementsService } from '../../src/modules/requirements/requirements.service.js';
import { RequirementsProcessor } from '../../src/modules/requirements/requirements.processor.js';
import { RequirementContextReader } from '../../src/modules/requirements/requirement-context-reader.js';
import { PrototypeV2Service } from '../../src/modules/prototypes/prototype-v2.service.js';

/** Actual services and DB; only model, retrieved business facts and object transport
 * are fixture ports. This helper never manufactures a confirmation record. */
export function requirementFlow(db:PrismaClient,runs:RunsService,prototypes:PrototypeV2Service,principalId:string,projectId:string,bytes?:Uint8Array){
 const sessions=new RequirementsService(db as never,new AccessService(db as never),runs);
 async function prepare(request:StartRunRequest,context:RequirementContext={kind:'new'},threadId?:string){
  const thread=threadId?{id:threadId}:await db.thread.create({data:{projectId,createdById:principalId,title:'Requirement fixture'}});
  const session=await sessions.create(principalId,thread.id,randomUUID(),request,context);
  return {session,async analyze(input=request,text=request.prompt){
   await sessions.message(principalId,session.id,randomUUID(),session.revision,{text,generationRequest:input,intent:'discuss'});
   const project=await db.project.findUniqueOrThrow({where:{id:projectId}});
   const release=await db.knowledgeRelease.findFirstOrThrow({where:{status:'ready',OR:[{projectId},{projectId:null,workspaceId:project.workspaceId},{projectId:null,workspaceId:null}]},orderBy:{createdAt:'desc'}});
   const chunk=await db.knowledgeChunk.findFirstOrThrow({where:{releaseId:release.id},include:{document:true}});
   const citation={id:`fixture-${chunk.id}`,releaseId:release.id,releaseVersion:release.version,documentId:chunk.documentId,chunkId:chunk.id,sourcePath:chunk.document.sourcePath,title:chunk.document.title,quote:chunk.content,checksum:createHash('sha256').update(chunk.content).digest('hex'),scope:'platform' as const};
   const card={goal:text,platform:'既有测试平台',modules:['原模块'],roles:['既有用户'],existingCapabilities:[{description:'既有测试能力',scope:'platform',evidenceIds:[citation.id]}],reuse:['保留原入口'],changes:[text],affectedPages:['原页面'],affectedFlows:['原流程'],targetSurface:input.targetSurface,designConstraints:['沿用所选设计'],outputKinds:input.requestedArtifactKinds,assumptions:[],issues:[],platformChanges:[],preserved:['原权限与其他流程']};
   const storage={getObject:async()=>{if(!bytes)throw Error('FIXTURE_SOURCE_BYTES_REQUIRED');return {body:Readable.from([bytes]),byteSize:bytes.length,mediaType:'text/markdown',contentRange:null};}};
   const processor=new RequirementsProcessor(sessions,{analyze:async()=>({value:{reply:'请核对已明确的增量。',card},inputTokens:1,outputTokens:1})} as never,{retrieve:async()=>({releaseId:release.id,evidence:[citation]})} as never,runs,prototypes,new RequirementContextReader(db as never,storage));
   await processor.tick(session.id);
   const ready=await sessions.get(principalId,session.id);
   if(ready.state!=='ready_to_confirm')throw Error(`FIXTURE_REQUIREMENT_NOT_READY:${ready.activeTurn?.failureCode??ready.state}`);
   return {ready,processor,confirm:async(key=randomUUID())=>sessions.confirm(principalId,session.id,key,ready.revision,{summaryVersion:ready.summaryVersion,summaryChecksum:ready.summaryChecksum!,acceptedAssumptionIds:[],acceptedPlatformChanges:false})};
  }};
 }
 async function create(request:StartRunRequest,context:RequirementContext={kind:'new'},threadId?:string){
  const discussion=await prepare(request,context,threadId),analysis=await discussion.analyze();
  const confirmed=await analysis.confirm();
  await analysis.processor.tick(confirmed.id);
  const state=await sessions.get(principalId,confirmed.id);
  if(state.confirmation?.status!=='started')throw Error(`FIXTURE_REQUIREMENT_NOT_STARTED:${state.confirmation?.failureCode??state.state}`);
  const run=await db.run.findUniqueOrThrow({where:{id:state.confirmation.runId!}});
  const plan=state.confirmation.planId?await prototypes.getPlanSnapshot({id:principalId} as never,projectId,state.confirmation.planId):null;
  return {session:state,plan,run,request:startRunRequestSchema.parse(run.request)};
 }
 return {sessions,prepare,create};
}
