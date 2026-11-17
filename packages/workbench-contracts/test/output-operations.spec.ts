import { describe, expect, it } from 'vitest';
import { startRunRequestSchema } from '../src/runs.js';

const target={artifactId:'prototype-1',artifactVersionId:'version-1',screenIds:[]};
const request={prompt:'在现有活动管理中增加报名人数展示',modelId:'deepseek-flash',workflow:'edit',targetSurface:'web',designStyle:{kind:'automatic'},sourceIds:[],artifactTargets:[target],requestedArtifactKinds:['prd','prototype'],requirementConfirmationId:'confirmation-1'};
const operations=[{kind:'prd',operation:{kind:'create'}},{kind:'prototype',operation:{kind:'revise',target}}];
describe('confirmed output operations',()=>{
 it('accepts creation and revision in one confirmed edit',()=>expect(startRunRequestSchema.parse({...request,outputOperations:operations}).outputOperations).toEqual(operations));
 it('allows a reference input without publishing a revision to it',()=>expect(startRunRequestSchema.safeParse({...request,requestedArtifactKinds:['prd'],outputOperations:operations.slice(0,1)}).success).toBe(true));
 it('requires a complete output plan at confirmation',()=>{
  expect(startRunRequestSchema.safeParse(request).success).toBe(false);
  expect(startRunRequestSchema.safeParse({...request,outputOperations:operations.slice(1)}).success).toBe(false);
  expect(startRunRequestSchema.safeParse({...request,requestedArtifactKinds:[],outputOperations:[]}).success).toBe(false);
 });
 it('rejects a forged revision version, duplicate output, or prototype before its PRD',()=>{
  expect(startRunRequestSchema.safeParse({...request,outputOperations:[operations[0],{kind:'prototype',operation:{kind:'revise',target:{...target,artifactVersionId:'other-version'}}}]}).success).toBe(false);
  expect(startRunRequestSchema.safeParse({...request,outputOperations:[...operations,operations[0]]}).success).toBe(false);
  expect(startRunRequestSchema.safeParse({...request,outputOperations:[...operations].reverse()}).success).toBe(false);
 });
});
