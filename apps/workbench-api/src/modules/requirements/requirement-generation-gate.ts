import { canonicalJson, prototypeInputSnapshotSchema, startRunRequestSchema, type StartRunRequest } from '@workbench/workbench-contracts';
import { Prisma } from '@workbench/workbench-db';
import { requirementProblem } from './requirement-policy.js';
export async function lockRequirementConfirmation(tx:Prisma.TransactionClient,principalId:string,projectId:string,request:StartRunRequest){
 const id=request.requirementConfirmationId;if(!id)throw requirementProblem('REQUIREMENT_CONFIRMATION_REQUIRED');
 await tx.$queryRaw(Prisma.sql`SELECT id FROM requirement_confirmations WHERE id=${id} FOR UPDATE`);
 const confirmation=await tx.requirementConfirmation.findFirst({where:{id,principalId,projectId}});
 if(!confirmation)throw requirementProblem('REQUIREMENT_CONFIRMATION_REQUIRED');
 if(confirmation.status!=='pending')throw requirementProblem(confirmation.status==='started'?'REQUIREMENT_ALREADY_STARTED':'REQUIREMENT_BASELINE_CHANGED');
 const session=await tx.requirementSession.findUnique({where:{id:confirmation.sessionId}});
 if(!session||session.confirmationId!==id||session.state!=='confirmed'||session.revision!==confirmation.inputRevision+1)throw requirementProblem('REQUIREMENT_BASELINE_CHANGED');
 if(canonicalJson(startRunRequestSchema.parse(confirmation.generationRequest))!==canonicalJson(request))throw requirementProblem('REQUIREMENT_BASELINE_CHANGED');
 return {...confirmation,inputSnapshot:prototypeInputSnapshotSchema.parse(confirmation.inputSnapshot)};
}
export async function consumeRequirementConfirmation(tx:Prisma.TransactionClient,confirmationId:string,runId:string,planId:string|null){
 const confirmation=await tx.requirementConfirmation.update({where:{id:confirmationId},data:{status:'started',lastFailureCode:null,runId,planId}});
 await tx.requirementSession.update({where:{id:confirmation.sessionId},data:{state:'generating',revision:{increment:1}}});
}
