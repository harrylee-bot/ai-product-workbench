import { canonicalJson, prototypeInputSnapshotSchema, startRunRequestSchema, type StartRunRequest } from '@workbench/workbench-contracts';
import type { Prisma } from '@workbench/workbench-db';
export async function confirmedRequirementBaseline(tx:Prisma.TransactionClient,run:{id:string;projectId:string;createdById:string;knowledgeReleaseId:string|null;retryOfRunId:string|null},request:StartRunRequest){
 if(!request.requirementConfirmationId)throw Error('REQUIREMENT_CONFIRMATION_REQUIRED');
 const confirmation=await tx.requirementConfirmation.findFirst({where:{id:request.requirementConfirmationId,projectId:run.projectId,status:'started'}});
 if(!confirmation||canonicalJson(startRunRequestSchema.parse(confirmation.generationRequest))!==canonicalJson(request))throw Error('REQUIREMENT_BASELINE_CHANGED');
 const snapshot=prototypeInputSnapshotSchema.parse(confirmation.inputSnapshot);
 if(snapshot.knowledgeReleaseId!==run.knowledgeReleaseId)throw Error('REQUIREMENT_KNOWLEDGE_BASELINE_CHANGED');
 const summary=await tx.requirementSummary.findUnique({where:{sessionId_version:{sessionId:confirmation.sessionId,version:confirmation.summaryVersion}}});
 const baseline=confirmation.baseline as {analysisContext?:unknown;summaryChecksum?:string;card?:unknown;evidence?:unknown;entries?:unknown;context?:unknown};
 if(!summary||summary.checksum!==baseline.summaryChecksum||canonicalJson(summary.card)!==canonicalJson(baseline.card)||canonicalJson(summary.evidence)!==canonicalJson(baseline.evidence)||canonicalJson(summary.contextSnapshot)!==canonicalJson(baseline.analysisContext))throw Error('REQUIREMENT_BASELINE_CHANGED');
 let ancestor:string|null=run.id;let found=false;
 for(let depth=0;ancestor&&depth<100;depth++){
  const previous:Pick<Prisma.RunGetPayload<{}>,'id'|'createdById'|'request'|'knowledgeReleaseId'|'retryOfRunId'>|null=await tx.run.findFirst({where:{id:ancestor,projectId:run.projectId},select:{id:true,createdById:true,request:true,knowledgeReleaseId:true,retryOfRunId:true}});
  if(!previous||canonicalJson(startRunRequestSchema.parse(previous.request))!==canonicalJson(request)||previous.knowledgeReleaseId!==snapshot.knowledgeReleaseId)break;
  if(ancestor===confirmation.runId){found=previous.createdById===confirmation.principalId;break;}
  ancestor=previous.retryOfRunId;
 }
 if(!found)throw Error('REQUIREMENT_BASELINE_RUN_MISMATCH');
 return {confirmationId:confirmation.id,summaryVersion:summary.version,checksum:summary.checksum,baseline:confirmation.baseline};
}

export async function freezeConfirmedSources(tx:Prisma.TransactionClient,confirmed:{baseline:unknown},sources:import('../runtime/runtime.port.js').RuntimeSource[]){
 const readings=(confirmed.baseline as {sourceContents?:{readings?:{sourceId:string;originalBlobId:string;blobId:string;sha256:string;extraction:null|{id:string;kind:string;position:number;content:{storageKey:string;sha256:string;byteSize:number;mediaType:string}}}[]}}).sourceContents?.readings;
 if(!readings||readings.length!==sources.length)throw Error('REQUIREMENT_SOURCE_BASELINE_CHANGED');
 const result=[];
 for(const source of sources){
  const reading=readings.find(x=>x.sourceId===source.sourceId&&x.originalBlobId===source.blobId);
  if(!reading)throw Error('REQUIREMENT_SOURCE_BASELINE_CHANGED');
  if(!reading.extraction){if(source.sha256!==reading.sha256)throw Error('REQUIREMENT_SOURCE_BASELINE_CHANGED');result.push({...source,extraction:null});continue;}
  const output=await tx.fileExtractionOutput.findFirst({where:{extractionId:reading.extraction.id,blobId:reading.blobId,kind:reading.extraction.kind,position:reading.extraction.position,extraction:{sourceBlobId:source.blobId,status:'ready'}} ,include:{blob:true}});
  const pointer=reading.extraction.content;
  if(!output||output.blob.status!=='ready'||output.blob.deletedAt||output.blob.sha256!==pointer.sha256||output.blob.storageKey!==pointer.storageKey||Number(output.blob.byteSize)!==pointer.byteSize||output.blob.mediaType!==pointer.mediaType)throw Error('REQUIREMENT_SOURCE_BASELINE_CHANGED');
  result.push({...source,extraction:{kind:reading.extraction.kind,position:reading.extraction.position,content:pointer}});
 }
 return result;
}
