// @vitest-environment jsdom
import React from 'react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({listProjectReleases:vi.fn(),listExportJobs:vi.fn(),cancelExportJob:vi.fn()}));
vi.mock('@/lib/studio/api',()=>({useWorkbenchReleasesApi:()=>m,useWorkbenchExportsApi:()=>m,useWorkbenchSharesApi:()=>({})}));
import {ProjectPublishing} from './project-publishing';
afterEach(cleanup);
it('keeps polling generic export cancellation and enables retry only after authoritative cleanup completion',async()=>{
 const time='2026-11-17T10:00:00Z',job={id:'job-one',projectId:'project-one',releaseId:'release-one',createdById:'actor-one',format:'pdf',packaging:'single_file',selection:{kind:'release'},revision:1,options:{},status:'queued',output:null,failure:null,createdAt:time,startedAt:null,finishedAt:null,updatedAt:time};
 let accepted=false,reads=0;m.listProjectReleases.mockResolvedValue({items:[],nextCursor:null});m.cancelExportJob.mockImplementation(async()=>{accepted=true;return{value:{...job,status:'cancelling'},etag:'"2"'}});m.listExportJobs.mockImplementation(async()=>{if(accepted)reads++;return{items:[{...job,status:!accepted?'queued':reads===1?'cancelling':'cancelled',finishedAt:reads>1?time:null}],nextCursor:null}});
 const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});render(<QueryClientProvider client={client}><ProjectPublishing bootstrap={{project:{id:'project-one'},access:{role:'editor'},artifacts:[]} as any} canEdit/></QueryClientProvider>);
 const article=await screen.findByRole('article',{name:'导出 job-one'});fireEvent.click(within(article).getByRole('button',{name:'取消导出'}));await within(article).findByText('PDF · 正在取消');expect(within(article).queryByRole('button',{name:'取消导出'})).toBeNull();expect(within(article).queryByRole('button',{name:'下载并校验'})).toBeNull();expect(within(article).queryByRole('button',{name:'重新导出固定版本'})).toBeNull();
 await within(article).findByText('PDF · 已取消',{}, {timeout:5000});await waitFor(()=>expect(within(article).getByRole('button',{name:'重新导出固定版本'})).toBeTruthy());expect(m.cancelExportJob).toHaveBeenCalledWith('job-one','"1"');cleanup();client.clear();
});
it('keeps the accepted cancelling snapshot when the export list refresh fails',async()=>{
 vi.clearAllMocks();
 const time='2026-11-17T10:00:00Z',job={id:'job-two',projectId:'project-one',releaseId:'release-one',createdById:'actor-one',format:'pdf',packaging:'single_file',selection:{kind:'release'},revision:1,options:{},status:'queued',output:null,failure:null,createdAt:time,startedAt:null,finishedAt:null,updatedAt:time};
 let reads=0;m.listProjectReleases.mockResolvedValue({items:[],nextCursor:null});m.listExportJobs.mockImplementation(async()=>{reads+=1;if(reads===1)return{items:[job],nextCursor:null};throw new Error('list unavailable after cancellation')});m.cancelExportJob.mockResolvedValue({value:{...job,status:'cancelling',revision:2},etag:'"2"'});
 const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});render(<QueryClientProvider client={client}><ProjectPublishing bootstrap={{project:{id:'project-one'},access:{role:'editor'},artifacts:[]} as any} canEdit/></QueryClientProvider>);
 const article=await screen.findByRole('article',{name:'导出 job-two'});fireEvent.click(within(article).getByRole('button',{name:'取消导出'}));await within(article).findByText('PDF · 正在取消');await screen.findByRole('alert');expect(within(article).getByText('PDF · 正在取消')).toBeTruthy();expect(within(article).queryByRole('button',{name:'取消导出'})).toBeNull();expect(within(article).queryByRole('button',{name:'重新导出固定版本'})).toBeNull();client.clear();
});

it.each([
  ['cancelled', '已取消', '重新导出固定版本'],
  ['failed', '失败', '重新导出固定版本'],
  ['succeeded', '可下载', '下载并校验'],
])('retains a confirmed %s export across stale list responses and panel remounts', async (status, label, terminalAction) => {
  const timestamp = '2026-11-17T10:00:00Z';
  const job = {
    id: 'export-original', projectId: 'project-one', releaseId: 'release-one', createdById: 'actor-one',
    format: 'pdf', packaging: 'single_file', selection: {kind: 'release'}, options: {},
    createdAt: timestamp, updatedAt: timestamp, startedAt: timestamp, finishedAt: timestamp, revision: 3, status,
    failure: status === 'failed' ? {code: 'EXPORT_FAILED', detail: '生成失败'} : null,
    output: status === 'succeeded' ? {sha256: 'a'.repeat(64), byteSize: 40, mediaType: 'application/pdf'} : null,
  };
  const earlier = {...job, status: 'running', revision: 2, output: null, failure: null, finishedAt: null};
  const newJob = {...earlier, id: 'export-retry', status: 'queued', revision: 0, startedAt: null};
  m.listProjectReleases.mockResolvedValue({items: [], nextCursor: null});
  m.listExportJobs.mockResolvedValueOnce({items: [job], nextCursor: null})
    .mockResolvedValue({items: [newJob, earlier], nextCursor: null});
  const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
  const key = ['studio', 'export-jobs', 'project-one'];
  const mount = () => render(<QueryClientProvider client={client}>
    <ProjectPublishing bootstrap={{project: {id: 'project-one'}, access: {role: 'editor'}, artifacts: []} as any} canEdit/>
  </QueryClientProvider>);
  const first = mount();
  await screen.findByText('PDF · ' + label);
  await act(() => client.refetchQueries({queryKey: key, exact: true}));
  const original = within(await screen.findByRole('article', {name: '导出 export-original'}));
  expect(original.getByRole('button', {name: terminalAction})).toBeTruthy();
  expect(original.queryByRole('button', {name: '取消导出'})).toBeNull();
  expect(within(screen.getByRole('article', {name: '导出 export-retry'})).getByRole('button', {name: '取消导出'})).toBeTruthy();
  expect(client.getQueryData(key)).toMatchObject({pages: [{items: [newJob, job]}]});
  first.unmount();
  mount();
  expect(within(await screen.findByRole('article', {name: '导出 export-original'})).getByText('PDF · ' + label)).toBeTruthy();
  cleanup();
  client.clear();
});
