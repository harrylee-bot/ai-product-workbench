// @vitest-environment jsdom
import React from 'react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({api:null as any}));
vi.mock('@/lib/studio/api',()=>({useWorkbenchArtifactsApi:()=>m.api}));
vi.mock('@/lib/auth/workbench-auth',()=>({useWorkbenchAuth:()=>({user:{id:'user-one'}})}));
vi.mock('@/components/studio/relations',()=>({ArtifactRelations:()=>null}));
vi.mock('@/components/studio/artifact-links',()=>({ArtifactLinks:()=>null}));
vi.mock('@/components/studio/image-editor',()=>({ImageEditor:()=>null}));
vi.mock('@/components/studio/prototype-variants',()=>({PrototypeVariants:()=>null}));
import {DocumentView} from '@/components/studio/document-view';
import {WorkbenchApiError} from '@/lib/workbench/api/problem-details';
import {prdDocumentV3Example} from '@workbench/workbench-contracts/test-fixtures';
afterEach(()=>{cleanup();sessionStorage.clear()});
async function setup(conflict:boolean){
 const document=structuredClone(prdDocumentV3Example),latest=structuredClone(document),versionId='version-one';
 latest.revision.number=document.revision.number+1;latest.cover.workOrderName='同事已保存';latest.title=latest.cover.title='同事已保存需求说明书';
 const artifact:any={id:'artifact-one',projectId:'project-one',kind:'prd',title:document.title,revision:1,currentVersion:{artifactVersionId:versionId}};
 window.history.replaceState(null,'','/?artifact=artifact-one&artifactVersion=version-one');
 let serverRevision=1;const writes:any[]=[];
 m.api={
  listArtifactVersions:vi.fn(async()=>({items:[{artifactVersionId:versionId,version:1,status:'ready'}],nextCursor:null})),
  getArtifactVersion:vi.fn(async(_id:string,id:string)=>({value:{artifactVersionId:id,artifactId:artifact.id,projectId:artifact.projectId,kind:'prd',version:id===versionId?1:2,status:'ready',contentMode:'inline',content:id===versionId?document:latest,checksum:'a'.repeat(64)},etag:'"fixed"'})),
  getArtifact:vi.fn(async()=>({value:{...artifact,revision:serverRevision,currentVersion:{artifactVersionId:serverRevision===1?versionId:'version-two'}},etag:'"'+serverRevision+'"'})),
  createArtifactVersion:vi.fn(async(_id:any,body:any,etag:any,key:any)=>{writes.push({body,etag,key});if(writes.length===1){if(conflict){serverRevision=2;throw new WorkbenchApiError({type:'about:blank',title:'Version mismatch',status:412,code:'PRECONDITION_FAILED',detail:'Concurrent update'} as any)}throw new TypeError('response lost')}return {value:{artifactVersionId:'version-three'},etag:'"3"'}})
 };
 const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
 const mount=()=>render(<QueryClientProvider client={client}><DocumentView artifact={artifact} canEdit onPrompt={()=>{}} initialVersionId={versionId}/></QueryClientProvider>);
 const view=mount();fireEvent.click(await screen.findByRole('button',{name:'编辑文档'}));fireEvent.change(screen.getByLabelText('工单名称'),{target:{value:'我的草稿'}});fireEvent.click(screen.getByRole('button',{name:'保存新版本'}));await waitFor(()=>expect(writes).toHaveLength(1));
 return {writes,view,mount,document,latest};
}
it('preserves an explicit conflict across reload and only writes with a new baseline after review',async()=>{
 const {writes,view,mount,latest}=await setup(true);
 await screen.findByRole('region',{name:'文档保存冲突'});
 expect((screen.getByRole('button',{name:'保存新版本'}) as HTMLButtonElement).disabled).toBe(true);
 view.unmount();mount();fireEvent.click(await screen.findByRole('button',{name:'恢复文档编辑'}));
 expect((screen.getByLabelText('工单名称') as HTMLInputElement).value).toBe('我的草稿');
 expect((screen.getByRole('button',{name:'保存新版本'}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'读取最新版本并核对'}));
 await screen.findByText('工单名称：同事已保存');expect(writes).toHaveLength(1);
 fireEvent.click(screen.getByRole('button',{name:'已核对，以最新版本为基线'}));
 fireEvent.click(screen.getByRole('button',{name:'保存新版本'}));
 await waitFor(()=>expect(writes).toHaveLength(2));
 expect(writes[0].etag).toBe('"1"');expect(writes[1].etag).toBe('"2"');expect(writes[1].key).not.toBe(writes[0].key);
 expect(writes[1].body.baseArtifactVersionId).toBe('version-two');expect(writes[1].body.document.cover.workOrderName).toBe('我的草稿');expect(writes[1].body.document.revision.number).toBeGreaterThan(latest.revision.number);expect(writes[1].body.document.citations).toEqual(latest.citations);
 await screen.findByText('已保存为新版本');
});
it('replays the exact document, ETag and action key when the response is unknown',async()=>{
 const {writes}=await setup(false);await screen.findByText('response lost');
 expect(screen.queryByRole('region',{name:'文档保存冲突'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'保存新版本'}));await waitFor(()=>expect(writes).toHaveLength(2));
 expect(writes[1]).toEqual(writes[0]);expect(m.api.getArtifact).toHaveBeenCalledOnce();await screen.findByText('已保存为新版本');
});
