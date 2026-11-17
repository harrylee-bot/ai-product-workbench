import { canonicalJson,prototypeInputSnapshotSchema,requirementDiscussionRequestSchema,type RequirementContext,type StartRunRequest } from '@workbench/workbench-contracts';
import { Prisma } from '@workbench/workbench-db';
import { requirementProblem } from './requirement-policy.js';

export async function readRequirementPlan(tx:Prisma.TransactionClient,projectId:string,context:Extract<RequirementContext,{kind:'plan'}>){
 await tx.$queryRaw(Prisma.sql`SELECT id FROM prototype_plans WHERE id=${context.planId} AND project_id=${projectId} FOR UPDATE`);
 const row=await tx.prototypePlan.findFirst({where:{id:context.planId,projectId}});
 if(!row||row.status!=='draft'||row.revision!==context.expectedRevision||row.runtimeRunId||row.reusedRunId)throw requirementProblem('REQUIREMENT_BASELINE_CHANGED');
 if(!row.generationRequest||!row.inputSnapshot)throw requirementProblem('REQUIREMENT_PLAN_CONTEXT_UNAVAILABLE');
 const request=requirementDiscussionRequestSchema.parse(row.generationRequest),snapshot=prototypeInputSnapshotSchema.parse(row.inputSnapshot);
 return {id:row.id,revision:row.revision,rootPlanId:row.rootPlanId,sourceRevisionId:row.sourceRevisionId,contentVersion:row.contentVersion,feedbackIds:row.feedbackIds as string[],title:row.title,request,snapshot};
}
export type RequirementPlanSource=Awaited<ReturnType<typeof readRequirementPlan>>;
export function assertPlanBindings(source:StartRunRequest,request:StartRunRequest){
 const bindings=(x:StartRunRequest)=>({workflow:x.workflow,artifactTargets:x.artifactTargets,generationIntent:x.generationIntent,prdScreenPlan:x.prdScreenPlan??null,canvasSnapshot:x.canvasSnapshot});
 if(canonicalJson(bindings(source))!==canonicalJson(bindings(request)))throw requirementProblem('REQUIREMENT_BASELINE_CHANGED');
}
