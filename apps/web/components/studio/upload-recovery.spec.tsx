// @vitest-environment jsdom
import React, {useState} from 'react';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, expect, it, vi} from 'vitest';
const m=vi.hoisted(()=>({createUpload:vi.fn(),createImportSource:vi.fn(),getImportSource:vi.fn(),service:{}}));
vi.mock('@/lib/workbench/files/uppy-multipart',()=>({createWorkbenchMultipartUpload:(...args:any[])=>m.createUpload(...args)}));
vi.mock('@/lib/workbench/features/files',async()=>({...await import('@/lib/workbench/files/upload-registry'),useWorkbenchFileTransferService:()=>m.service}));
vi.mock('@/lib/studio/api',()=>({useWorkbenchImportSourcesApi:()=>m}));
vi.mock('@/lib/workbench/features/runtime-models',()=>({useWorkbenchRuntimeModels:()=>({data:{items:[{id:'deepseek-flash',displayName:'Flash',supportedWorkflows:['generate','edit']}]},isPending:false})}));
vi.mock('@/lib/workbench/features/design-presets',()=>({useWorkbenchDesignPresets:()=>({data:{items:[]}})}));
vi.mock('@/lib/studio/import-sources',()=>({useStudioImportSources:()=>({items:[],selectedItems:[],invalidIds:[],unverifiedIds:[]})}));
import {useStudioInputPreparation} from '@/lib/studio/use-input-preparation';
import {StudioComposer} from '@/components/studio/composer';
afterEach(()=>{cleanup();vi.clearAllMocks()});
it.each(['retry','cancel','remove'] as const)('recovers a retryable attachment failure with %s without silently sending partial input',async(action)=>{
 const file=new File(['private requirements'],'brief.txt',{type:'text/plain'});
 let snap:any={id:'local-upload',projectId:'project-one',fileAssetId:null,uploadSessionId:null,fileName:file.name,declaredMediaType:file.type,byteSize:file.size,phase:'queued',recoveryState:'new',bytesUploaded:0,uploadPercent:0,bytesHashed:0,hashPercent:0,clientSha256Hint:null,file:null,extraction:null,error:null};
 const listeners=new Set<(s:any)=>void>();
 const publish=(phase:string,extra={})=>{snap={...snap,phase,...extra};listeners.forEach(f=>f(snap));return snap};
 const controller={getSnapshot:()=>snap,subscribe:(fn:any)=>{listeners.add(fn);return()=>listeners.delete(fn)},start:vi.fn(async()=>publish('failed',{error:{code:'UPLOAD_FAILED',message:'transfer interrupted',retryable:true}})),retry:vi.fn(async()=>publish('ready',{fileAssetId:'file-one',error:null})),cancel:vi.fn(async()=>publish('cancelled',{error:null})),destroy:vi.fn(),pause:vi.fn(),resume:vi.fn()};
 m.createUpload.mockResolvedValue(controller);m.createImportSource.mockResolvedValue({value:{id:'source-one'}});m.getImportSource.mockResolvedValue({value:{projectId:'project-one',status:'ready'}});
 let settled=false;const send=vi.fn();
 function Harness(){
  const prep=useStudioInputPreparation('project-one');
  const [busy,setBusy]=useState(false),[draft,setDraft]=useState<any>({prompt:'生成需求页面',modelId:'deepseek-flash',sourceIds:[],files:[file],missingFiles:[],requestedArtifactKinds:['prototype'],targetSurface:'web',designStyle:{kind:'automatic'}});
  return <StudioComposer projectId="project-one" bootstrap={{artifacts:[]} as any} prompt={draft.prompt} setPrompt={prompt=>setDraft((d:any)=>({...d,prompt}))} draft={draft} updateDraft={setDraft} busy={busy} disabled={false} uploads={prep.uploads} onRetryUpload={prep.retryUpload} onCancelUpload={prep.cancelUpload} onSubmit={async(input)=>{setBusy(true);try{const request=await prep.prepare(input,()=>{});send(request);return 'receipt'}finally{settled=true;setBusy(false)}}}/>;
 }
 const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
 const view=render(<QueryClientProvider client={client}><Harness/></QueryClientProvider>);
 fireEvent.click(screen.getByRole('button',{name:'发送需求'}));
 await screen.findByText(/brief.txt · 处理失败/);
 expect(screen.getByText('transfer interrupted')).toBeTruthy();expect(settled).toBe(false);
 const label=action==='retry'?'重试上传 brief.txt':action==='cancel'?'取消上传 brief.txt':'移除 brief.txt';
 fireEvent.click(screen.getByRole('button',{name:label}));
 await waitFor(()=>expect(settled).toBe(true));
 expect((screen.getByRole('button',{name:'发送需求'}) as HTMLButtonElement).disabled).toBe(false);
 expect((screen.getByRole('textbox',{name:'描述需求或修改'}) as HTMLTextAreaElement).value).toBe('生成需求页面');
 expect(m.createUpload).toHaveBeenCalledOnce();
 if(action==='retry'){expect(controller.retry).toHaveBeenCalledOnce();expect(send).toHaveBeenCalledWith(expect.objectContaining({sourceIds:['source-one']}));expect(controller.cancel).not.toHaveBeenCalled();}
 else {expect(controller.cancel).toHaveBeenCalledOnce();expect(send).not.toHaveBeenCalled();expect(m.createImportSource).not.toHaveBeenCalled();expect(screen.getByText(/本次需求未发送/)).toBeTruthy();if(action==='remove')expect(screen.queryByRole('button',{name:'移除 brief.txt'})).toBeNull();else expect(screen.getByRole('button',{name:'移除 brief.txt'})).toBeTruthy();}
 view.unmount();await act(async()=>{await Promise.resolve()});
});
