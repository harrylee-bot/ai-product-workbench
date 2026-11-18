// @vitest-environment jsdom
import React from 'react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
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
