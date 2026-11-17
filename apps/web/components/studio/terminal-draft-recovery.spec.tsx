// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { prototypeProgressSchema, runEventSchema } from '@workbench/workbench-contracts';
const ports=vi.hoisted(()=>({ getProgress:vi.fn(), subscribe:vi.fn(), transport:{baseUrl:'http://review.test/api/v1'}, api:null as any }));
ports.api={getProgress:ports.getProgress};
vi.mock('@/lib/workbench/features/prototype-v2/api-adapter',()=>({useWorkbenchPrototypeV2Api:()=>ports.api}));
vi.mock('@/lib/workbench/transport/context',()=>({useWorkbenchTransport:()=>ports.transport}));
vi.mock('@/lib/workbench/run/stream',()=>({subscribeRunEvents:ports.subscribe}));
import { applyPrototypeProgress, seedPrototypeProgress, useWorkbenchPrototypeProgress } from '@/lib/workbench/features/prototype-v2/application/progress';
const time='2026-11-17T10:00:00Z';
const preview={artifactIndex:0,kind:'prototype',title:'授权草稿',markdown:'',screens:[{id:'screen-a',name:'订单',width:1000,height:700,nodes:[{id:'node-a',parentId:null,kind:'text',text:'最后有效的订单草稿',x:0,y:0,width:500,height:40,absolute:false,direction:'column',gap:0,padding:0,fill:null,color:'#000',fontSize:14,radius:0}]}]};
function event(sequence:number,type:string,payload:unknown){return runEventSchema.parse({protocol:'workbench.run.v1',id:`event-${sequence}`,runId:'run-1',requestId:'request-1',projectId:'project-1',threadId:'thread-1',traceId:'trace-1',occurredAt:time,sequence,type,payload});}
function snapshot(status:'running'|'failed'|'cancelled') {return prototypeProgressSchema.parse({projectId:'project-1',planId:'plan-1',status:status==='running'?'generating':status,input:{requestedArtifactKinds:['prototype'],modelId:'deepseek-flash',targetSurface:'web',sourceIds:[],designStyle:null},run:{id:'run-1',requestId:'request-1',projectId:'project-1',threadId:'thread-1',retryOfRunId:null,status,modelId:'deepseek-flash',workflow:'generate',generationIntent:null,targetSurface:'web',designStyle:{kind:'automatic'},artifactTargets:[],requestedArtifactKinds:['prototype'],sources:[],knowledgeReleaseId:null,phase:null,phaseLabel:null,progress:null,attempt:1,lastEventSequence:status==='running'?10:11,cancelRequestedAt:null,failure:status==='failed'?{code:'GENERATION_FAILED',message:'服务暂不可用',retryable:true}:null,cancellationReason:status==='cancelled'?'user':null,createdAt:time,startedAt:time,finishedAt:status==='running'?null:time},events:[event(8,'artifact.preview.updated',{attempt:1,preview})],coverage:'window',finalRevisionId:null});}
it('ignores late previews and phase events without reviving the terminal Run',()=>{const value=snapshot('failed'),state=seedPrototypeProgress(value)!;expect(state).toMatchObject({status:'failed',attempt:1,lastSequence:11,failure:value.run!.failure});const late=applyPrototypeProgress(state,event(12,'artifact.preview.updated',{attempt:1,preview:{...preview,title:'LATE'}}));expect(late.generationPreviews).toEqual({'0':preview});expect(late.lastSequence).toBe(12);const phase=applyPrototypeProgress(late,event(13,'run.phase.changed',{phase:'generating',label:'LATE',progress:0.5}));expect(phase.status).toBe('failed');});
afterEach(()=>{cleanup();vi.clearAllMocks();});
describe('FE-L006 terminal draft snapshot recovery',()=>{
 for(const status of ['failed','cancelled'] as const)it(`authorized ${status} snapshot retains its authorized last draft`,()=>{const value=snapshot(status);expect(value.events[0].type).toBe('artifact.preview.updated');expect(seedPrototypeProgress(snapshot('running'))?.generationPreviews['0']).toEqual(preview);expect(seedPrototypeProgress(value)?.generationPreviews).toEqual({'0':preview});});
 it('real hook retains SSE failure draft after authoritative recovery',async()=>{
  ports.getProgress.mockResolvedValueOnce(snapshot('running')).mockResolvedValue(snapshot('failed'));
  let stream:any,finish!:()=>void;
  ports.subscribe.mockImplementation((args:any)=>{stream=args;return new Promise<void>(resolve=>{finish=resolve;});});
  const {result}=renderHook(()=>useWorkbenchPrototypeProgress('project-1','plan-1'));
  await waitFor(()=>expect(result.current.projection?.generationPreviews['0']).toEqual(preview));
  act(()=>{stream.onEvent(event(11,'run.failed',{code:'GENERATION_FAILED',message:'服务暂不可用',retryable:true}));finish();});
  expect(result.current.projection?.status).toBe('failed');
  expect(result.current.projection?.generationPreviews['0']).toEqual(preview);
  await waitFor(()=>expect(ports.getProgress).toHaveBeenCalledTimes(2),{timeout:2000});
  expect(result.current.snapshot?.events).toHaveLength(1);
  expect(result.current.projection?.generationPreviews).toEqual({'0':preview});
 });
});
