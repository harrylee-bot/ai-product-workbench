import { describe,it,expect } from 'vitest';
import { requirementAnalysisSchema,requirementCardSchema,createRequirementSessionRequestSchema,postRequirementMessageRequestSchema } from '../src/requirements.js';
const config={prompt:'写PRD',modelId:'chosen-supported-model',workflow:'generate',targetSurface:'web',designStyle:{kind:'automatic'},sourceIds:[],requestedArtifactKinds:['prd']};
describe('Requirement discussion contracts',()=>{
 it('accepts a short clarification without inventing a card',()=>expect(requirementAnalysisSchema.parse({reply:'希望调整哪个平台的哪个模块？',card:null}).card).toBeNull());
 it('accepts incomplete known fields and empty change list for knowledge questions',()=>expect(requirementAnalysisSchema.parse({reply:'现有活动管理支持什么？',card:{platform:null,modules:[],roles:[],changes:[]}}).card?.changes).toEqual([]));
 it('requires complete fields only at the ready boundary',()=>expect(requirementCardSchema.safeParse({platform:null,changes:[]}).success).toBe(false));
 it('preserves generation model choice and allows discussion before PRD completeness',()=>expect(createRequirementSessionRequestSchema.parse({generationRequest:config}).generationRequest.modelId).toBe('chosen-supported-model'));
 it('preserves exact revision, selected feedback and element context',()=>expect(createRequirementSessionRequestSchema.parse({generationRequest:config,context:{kind:'revision',revisionId:'revision-1',feedbackIds:['feedback-1'],anchor:{scope:'node',sourceRevisionId:'revision-1',pageId:'page-1',nodeId:'node-1',quote:'报名'}}}).context.kind).toBe('revision'));
 it('rejects a client-invented confirmation inside discussion input',()=>expect(createRequirementSessionRequestSchema.safeParse({generationRequest:{...config,requirementConfirmationId:'forged'}}).success).toBe(false));
 it('rejects client-invented output operations inside discussion input',()=>expect(createRequirementSessionRequestSchema.safeParse({generationRequest:{...config,outputOperations:[{kind:'prd',operation:{kind:'create'}}]}}).success).toBe(false));
 it('does not infer confirmation intent by default',()=>expect(postRequirementMessageRequestSchema.parse({text:'请再想想'}).intent).toBe('discuss'));
 it('rejects Canvas state in a new discussion',()=>expect(createRequirementSessionRequestSchema.safeParse({generationRequest:{...config,canvasSnapshot:{protocol:'workbench.canvas-snapshot.v1'}}}).success).toBe(false));
 it('rejects retired draft-plan contexts',()=>{
  expect(createRequirementSessionRequestSchema.safeParse({generationRequest:config,context:{kind:'plan',planId:'draft-1',expectedRevision:3}}).success).toBe(false);
  expect(createRequirementSessionRequestSchema.safeParse({generationRequest:config,context:{kind:'plan',planId:'draft-1'}}).success).toBe(false);
 });
});
