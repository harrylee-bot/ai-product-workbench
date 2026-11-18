import { Optional,Logger,Injectable, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@workbench/workbench-db';
import { requirementDiscussionRequestSchema,startRunRequestSchema, requirementContextSchema, requirementCardSchema, prototypeInputSnapshotSchema, type StartRunRequest, type PostRequirementMessageRequest } from '@workbench/workbench-contracts';
import { hashRequest } from '../../common/idempotency.js';
import { RequirementsService } from './requirements.service.js';
import { RequirementModel } from './requirement-model.js';
import { KnowledgeRetrievalError } from '../knowledge/knowledge-retrieval.types.js';
import { RequirementKnowledge } from './requirement-knowledge.js';
import { isReady, validateAnalysis, requirementProblem } from './requirement-policy.js';
import { RequirementContextReader } from './requirement-context-reader.js';
import { RunsService } from '../runs/runs.service.js';
import { PrototypeV2Service } from '../prototypes/prototype-v2.service.js';
import { feedbackAnchorIndex } from '../prototypes/prototype-feedback-location.js';
const json=(x:unknown)=>x as Prisma.InputJsonValue;
@Injectable()
export class RequirementsProcessor implements OnModuleInit,OnModuleDestroy {
 private readonly logger=new Logger(RequirementsProcessor.name);
 private timer?:ReturnType<typeof setInterval>;private working=false;private stopped=false;
 private readonly controllers=new Set<AbortController>();
 constructor(private readonly sessions:RequirementsService,private readonly model:RequirementModel,private readonly knowledge:RequirementKnowledge,private readonly runs:RunsService,private readonly prototypes:PrototypeV2Service,@Optional() private readonly contextReader?:RequirementContextReader){}
 onModuleInit(){this.timer=setInterval(()=>{void this.tick().catch(()=>undefined);},1000);this.timer.unref();}
 onModuleDestroy(){this.stopped=true;if(this.timer)clearInterval(this.timer);for(const controller of this.controllers)controller.abort();}
 async tick(sessionId?:string){
  if(this.working||this.stopped)return;this.working=true;
  try{
   const db=this.sessions.db;
   const expired=await db.requirementTurn.findMany({where:{status:'running',leaseExpiresAt:{lt:new Date()},...(sessionId?{sessionId}:{})},take:20});
   for(const stale of expired)await db.$transaction(async tx=>{
    await tx.$queryRaw(Prisma.sql`SELECT id FROM requirement_sessions WHERE id=${stale.sessionId} FOR UPDATE`);
    const changed=await tx.requirementTurn.updateMany({where:{id:stale.id,status:'running',leaseExpiresAt:{lt:new Date()}},data:{status:'failed',failureCode:'REQUIREMENT_TURN_INTERRUPTED',finishedAt:new Date()}});
    if(changed.count)await tx.requirementSession.updateMany({where:{id:stale.sessionId,currentTurnId:stale.id,revision:stale.inputRevision},data:{state:'discussing',revision:{increment:1}}});
   });
   const turn=await db.$transaction(async tx=>{
    const rows=await tx.$queryRaw<{id:string}[]>(Prisma.sql`SELECT id FROM requirement_turns WHERE status='queued' ${sessionId?Prisma.sql`AND session_id=${sessionId}`:Prisma.empty} ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`);
    if(!rows[0])return null;
    return tx.requirementTurn.update({where:{id:rows[0].id},data:{status:'running',attempt:{increment:1},leaseOwner:randomUUID(),leaseExpiresAt:new Date(Date.now()+180000)}});
   });
   if(turn)await this.analyze(turn);
   const confirmations=await db.requirementConfirmation.findMany({where:{status:'pending',dispatchAttempts:{lt:12},nextAttemptAt:{lte:new Date()},...(sessionId?{sessionId}:{})},take:5,orderBy:{confirmedAt:'asc'}});
   for(const confirmation of confirmations){
    const claimed=await db.requirementConfirmation.updateMany({where:{id:confirmation.id,status:'pending',nextAttemptAt:{lte:new Date()}},data:{dispatchAttempts:{increment:1},nextAttemptAt:new Date(Date.now()+60000)}});
    if(!claimed.count)continue;
    try{
     const session=await this.sessions.authorize(confirmation.principalId,confirmation.sessionId);
     const request=startRunRequestSchema.parse(confirmation.generationRequest);
     if(request.requestedArtifactKinds.includes('prototype')){
      await this.prototypes.createConfirmedRequirementPlan(confirmation.principalId,session.projectId,confirmation.id);
     }else await this.runs.start(confirmation.principalId,session.threadId,`requirement:${confirmation.id}`,request);
    }catch(error){
     // Keep a durable pending confirmation for an external service outage.
     // Invalidated/stale confirmations are rejected again inside generation's transaction.
     const failureCode=safeFailure(error);this.logger.warn({operation:'requirement-dispatch',confirmationId:confirmation.id,code:failureCode});
     await db.requirementConfirmation.updateMany({where:{id:confirmation.id,status:'pending'},data:{lastFailureCode:failureCode}});
     if(error instanceof Error&&error.name==='AbortError')break;
    }
   }
  }finally{this.working=false;}
 }
 private async analyze(turn:Prisma.RequirementTurnGetPayload<{}>){
  const db=this.sessions.db,controller=new AbortController();this.controllers.add(controller);
  const deadline=setTimeout(()=>controller.abort(),120000);deadline.unref();
  const monitor=setInterval(()=>{void db.requirementTurn.findUnique({where:{id:turn.id}}).then(current=>{if(current?.status!=='running'||current.leaseOwner!==turn.leaseOwner)controller.abort();}).catch(()=>controller.abort());},1000);monitor.unref();
  try{
   const session=await this.sessions.authorize(turn.principalId,turn.sessionId);
   if(session.currentTurnId!==turn.id||session.revision!==turn.inputRevision)throw requirementProblem('REQUIREMENT_TURN_CHANGED');
   const input=turn.input as {message:PostRequirementMessageRequest;request:unknown;entries:{content:{text?:string};role:string}[]};
   let request:StartRunRequest=requirementDiscussionRequestSchema.parse(input.request);
   const context=requirementContextSchema.parse(session.context);
   const projectContext=await this.sessions.transaction(turn.principalId,turn.sessionId,async(tx,s)=>{
    if(s.currentTurnId!==turn.id||s.revision!==turn.inputRevision)throw requirementProblem('REQUIREMENT_TURN_CHANGED');
    const revisionContext=context.kind==='revision'?context:null;
    let source=null;
    if(revisionContext){
     request=await this.runs.resolvePrototypeRevisionRequest(tx,s.projectId,revisionContext.revisionId,request,true);
     const revision=await tx.prototypeRevision.findFirst({where:{id:revisionContext.revisionId,projectId:s.projectId}});if(!revision)throw requirementProblem('REQUIREMENT_SOURCE_CHANGED');
     const feedback=await tx.prototypeFeedback.findMany({where:{id:{in:revisionContext.feedbackIds},projectId:s.projectId,revisionId:revisionContext.revisionId,status:'open'}});
     if(feedback.length!==revisionContext.feedbackIds.length)throw requirementProblem('REQUIREMENT_SOURCE_CHANGED');
     if(revisionContext.anchor){const index=feedbackAnchorIndex(revision);const anchor=revisionContext.anchor;if(anchor.sourceRevisionId!==revision.id||anchor.scope==='unresolved'||!index.pages.has(anchor.pageId)||anchor.scope==='node'&&index.nodes?.get(anchor.nodeId)!==anchor.pageId)throw requirementProblem('REQUIREMENT_SOURCE_CHANGED');}
     source={revisionId:revision.id,documentSha256:revision.documentSha256,document:revision.sourceDocument,feedback,anchor:revisionContext.anchor};
    }
    request=await this.runs.resolveOutputOperations(tx,s.projectId,request);
    // Query only this project. Missing and foreign IDs receive the same
    // response, so this check cannot disclose another project's sources.
    if(request.sourceIds.length){
     const visible=await tx.importSource.count({where:{projectId:s.projectId,id:{in:request.sourceIds}}});
     if(visible!==request.sourceIds.length)throw requirementProblem('REQUIREMENT_SOURCE_UNAVAILABLE',409);
    }
    const snapshot=await this.runs.captureGenerationInput(tx,s.projectId,{...request,prompt:"Discussion context authorization check only"});
    const project=await tx.project.findUniqueOrThrow({where:{id:s.projectId},select:{id:true,title:true}});
    return {project,snapshot,source};
   });
   const sourceContents=this.contextReader?await this.contextReader.read(turn.projectId,projectContext.snapshot,request,controller.signal):{readings:[],artifactTargets:[]};
   if(!this.contextReader&&(request.sourceIds.length||request.artifactTargets.length))throw requirementProblem('REQUIREMENT_SOURCE_TEXT_UNAVAILABLE');
   const userHistory=input.entries.filter(x=>x.role==='user').map(x=>x.content.text??'');
   const query=[...new Set([input.message.text,userHistory[0]??'',...userHistory.slice(-3)].filter(Boolean))].join('\n');
   const knowledge=await this.knowledge.retrieve(turn.principalId,turn.projectId,query,controller.signal);
   const messages=input.entries.filter(x=>x.role==='user'||x.role==='assistant').map(x=>({role:x.role as 'user'|'assistant',content:x.content.text??''}));messages.push({role:'user',content:input.message.text});
   const modelContext={configuration:request,context,projectContext,sourceContents,evidence:knowledge.evidence};
   if(JSON.stringify(modelContext).length>100000)throw requirementProblem('REQUIREMENT_CONTEXT_LIMIT',429);
   const result=await this.model.analyze({messages,context:modelContext},controller.signal);
   const analysis=validateAnalysis(result.value,knowledge.evidence);
   if(analysis.card?.targetSurface&&analysis.card.targetSurface!==request.targetSurface||analysis.card?.outputKinds&&hashRequest([...analysis.card.outputKinds].sort())!==hashRequest([...request.requestedArtifactKinds].sort()))throw requirementProblem('REQUIREMENT_MODEL_OUTPUT_INVALID',503);
   const ready=isReady(analysis.card,knowledge.evidence);
   await this.sessions.transaction(turn.principalId,turn.sessionId,async(tx,s)=>{
    const current=await tx.requirementTurn.findUnique({where:{id:turn.id}});
    if(s.currentTurnId!==turn.id||s.revision!==turn.inputRevision||current?.status!=='running'||current.leaseOwner!==turn.leaseOwner)return;
    const version=s.summaryVersion+1;
    const checksum=hashRequest({card:analysis.card,evidence:knowledge.evidence,request,context});
    await tx.requirementSummary.create({data:{id:`summary_${randomUUID()}`,sessionId:s.id,version,inputRevision:turn.inputRevision,checksum,card:analysis.card?json(analysis.card):Prisma.JsonNull,evidence:json(knowledge.evidence),knowledgeReleaseId:knowledge.releaseId,contextSnapshot:json({projectContext,sourceContents,request,context,retrievalEvidence:knowledge.retrievalEvidence??null})}});
    const thread=await tx.thread.update({where:{id:s.threadId},data:{entrySequence:{increment:1},revision:{increment:1}}});
    await tx.threadEntry.create({data:{threadId:s.threadId,sequence:thread.entrySequence,role:'assistant',kind:'message',audiencePrincipalId:turn.principalId,requirementSessionId:s.id,content:{protocol:'workbench.entry.v1',type:'assistant.message',text:analysis.reply}}});
    await tx.requirementTurn.update({where:{id:turn.id},data:{status:'succeeded',inputTokens:result.inputTokens,outputTokens:result.outputTokens,finishedAt:new Date(),leaseExpiresAt:null}});
    await tx.requirementSession.update({where:{id:s.id},data:{state:ready?'ready_to_confirm':'needs_clarification',summaryVersion:version,revision:{increment:1}}});
   });
   if(ready&&input.message.intent==='confirm_suggestion'){
    const snapshot=await this.sessions.get(turn.principalId,turn.sessionId);
    if(snapshot.state!=='ready_to_confirm'||snapshot.activeTurn?.id!==turn.id)return;
    const card=requirementCardSchema.parse(snapshot.card);
    // The explicit message intent can accept ordinary suggested assumptions;
    // platform-level changes still require their own visible acceptance.
    if(card.platformChanges.length===0)await this.sessions.confirm(turn.principalId,turn.sessionId,`message-confirm:${turn.id}`,snapshot.revision,{summaryVersion:snapshot.summaryVersion,summaryChecksum:snapshot.summaryChecksum!,acceptedAssumptionIds:card.assumptions.map(x=>x.id),acceptedPlatformChanges:false});
   }
  }catch(error){
   const code=controller.signal.aborted?'REQUIREMENT_TURN_INTERRUPTED':safeFailure(error);
   this.logger.warn({operation:'requirement-analysis',turnId:turn.id,code});
   await db.requirementTurn.updateMany({where:{id:turn.id,status:'running',leaseOwner:turn.leaseOwner},data:{status:'failed',failureCode:code,finishedAt:new Date(),leaseExpiresAt:null}});
   await db.requirementSession.updateMany({where:{id:turn.sessionId,currentTurnId:turn.id,revision:turn.inputRevision},data:{state:'discussing',revision:{increment:1}}});
  }finally{clearInterval(monitor);clearTimeout(deadline);this.controllers.delete(controller);}
 }
}
function safeFailure(error:unknown){
 if(error instanceof KnowledgeRetrievalError)return 'REQUIREMENT_KNOWLEDGE_UNAVAILABLE';
 if(error&&typeof error==='object'&&'getResponse' in error&&typeof error.getResponse==='function'){
  const response=error.getResponse() as {code?:string};if(response.code==='RUN_IMPORT_SOURCE_NOT_READY')return 'REQUIREMENT_SOURCE_CHANGED';
  if(response.code?.startsWith('REQUIREMENT_'))return response.code;
 }
 return 'REQUIREMENT_ANALYSIS_UNAVAILABLE';
}
