// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import React from 'react';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
const m=vi.hoisted(()=>({api:{getPlan:vi.fn(),listPlans:vi.fn(),getRevision:vi.fn(),listRevisions:vi.fn(),listShares:vi.fn(),listExports:vi.fn(),getRevisionDiff:vi.fn(),getRevisionInput:vi.fn(),createShare:vi.fn(),getProjectBootstrap:vi.fn()}, composer:null as any,userId:'audit-actor'}));
vi.mock('next/link',()=>({default:({children,...props}:any)=><a {...props}>{children}</a>}));
vi.mock('@/lib/auth/workbench-auth',()=>({useWorkbenchAuth:()=>({user:{id:m.userId}})}));
vi.mock('@/lib/studio/api',()=>({useWorkbenchPrototypeV2Api:()=>m.api,useWorkbenchProjectsApi:()=>m.api}));
vi.mock('@/lib/workbench/features/prototype-v2/api-adapter',()=>({useWorkbenchPrototypeV2Api:()=>m.api}));
vi.mock('@/lib/workbench/features/projects/api-adapter',()=>({useWorkbenchProjectsApi:()=>m.api}));
vi.mock('@/lib/workbench/features/prototype-v2/application/progress',()=>({useWorkbenchPrototypeProgress:()=>({snapshot:undefined,projection:undefined})}));
vi.mock('@/lib/studio/run',()=>({useStudioRun:()=>({}),projectedRun:()=>undefined,isActiveRun:()=>false}));
vi.mock('@/lib/studio/use-requirement-discussion',()=>({useRequirementDiscussion:()=>({messages:[],directory:[],uploads:[],generationBaseline:undefined,pending:false,loading:false,command:undefined})}));
vi.mock('@/components/studio/plan-input',()=>({PlanInputSummary:()=>null}));
vi.mock('@/components/studio/relations',()=>({RevisionRelations:()=>null,RunOutputs:()=>null}));
vi.mock('@/components/studio/page-stage',()=>({PageStage:({html}:any)=><div data-testid="private-preview">{html}</div>}));
vi.mock('@/components/studio/project-views',()=>({ProjectViews:()=>null,RunDetails:()=>null}));
vi.mock('@/components/studio/onlook/main',()=>({Main:({topBar,leftPanel,canvas,bottomBar}:any)=><>{topBar}{leftPanel}{canvas}{bottomBar}</>}));
vi.mock('@/components/studio/onlook/design-panel',()=>({DesignPanel:({tabs,selectedTab,onSelect}:any)=><>{tabs.map((t:any)=><button key={t.value} onClick={()=>onSelect(t.value)}>{t.label}导航</button>)}{tabs.find((t:any)=>t.value===selectedTab)?.content}</>}));
vi.mock('@/components/studio/composer',()=>({StudioComposer:(props:any)=>{m.composer=props;return <>{props.intentControl}<span data-testid="composer-prompt">{props.prompt}</span></>;}}));
vi.mock('@/components/studio/requirement-input',()=>({RequirementInput:({children}:any)=><>{children}</>}));
import {StudioProject} from '@/components/studio/project-route';
import {workbenchQueryKeys} from '@/lib/workbench/query/keys';
import {WorkbenchApiError} from '@/lib/workbench/api';
import {clearStudioComposerSessions,readComposerSession} from '@/lib/studio/composer-session';
const plan={id:'plan-one',rootPlanId:null,projectId:'project-one',contentVersion:1,revision:1,title:'audit-plan',prompt:'goal',status:'ready'};
const revision={id:'revision-one',planId:'plan-one',version:1,revision:1,projectId:'project-one',status:'ready',title:'audit-version',previewHtml:'PRIVATE_FROZEN_HTML',pages:[{id:'page-one',title:'Page',order:0}],sourceRevisionId:null};
const request={prompt:'goal',modelId:'deepseek-flash',workflow:'edit',sourceIds:[],requestedArtifactKinds:['prd','prototype'],targetSurface:'web',designStyle:{kind:'automatic'},artifactTargets:[],generationIntent:null,canvasSnapshot:null};
const clients:QueryClient[]=[];
async function mount(){const client=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false,staleTime:30000},mutations:{retry:false}}});clients.push(client);render(<QueryClientProvider client={client}><StudioProject projectId="project-one"/></QueryClientProvider>);await waitFor(()=>expect(screen.getByTestId('private-preview').textContent).toBe('PRIVATE_FROZEN_HTML'));await waitFor(()=>expect(m.composer).toBeTruthy());return client;}
beforeEach(async()=>{m.userId='audit-actor';vi.useRealTimers();cleanup();await clearStudioComposerSessions();sessionStorage.clear();window.history.replaceState(null,'','/studio/project-one?plan=plan-one&revision=revision-one&page=page-one');Object.values(m.api).forEach(fn=>fn.mockReset());m.composer=null;m.api.getPlan.mockResolvedValue({value:plan,etag:'"1"'});m.api.listPlans.mockResolvedValue([plan]);m.api.getRevision.mockResolvedValue({value:revision,etag:'"1"'});m.api.listRevisions.mockResolvedValue([revision]);m.api.listShares.mockResolvedValue([]);m.api.listExports.mockResolvedValue([]);m.api.getRevisionDiff.mockResolvedValue({sourceRevisionId:null,pages:[]});m.api.getProjectBootstrap.mockResolvedValue({value:{project:{id:'project-one',title:'Audit project'},access:{role:'owner'},selectedThreadId:'thread-one',entries:[],artifacts:[],latestRun:null},etag:'"1"'});});
afterEach(()=>{cleanup();clients.splice(0).forEach(c=>c.clear());vi.useRealTimers();});

it('clears private previews and project queries after explicit access revocation, then verifies permission',async()=>{
 const client=await mount(); const initial=m.api.getProjectBootstrap.mock.calls.length;
 const denied=new WorkbenchApiError({status:403,code:'PROJECT_FORBIDDEN',title:'access revoked',type:'about:blank'});
 m.api.getProjectBootstrap.mockRejectedValue(denied);
 for(const name of ['getPlan','listPlans','getRevision','listRevisions','listShares','listExports','getRevisionDiff'] as const)m.api[name].mockRejectedValue(denied);
 await act(async()=>{await client.invalidateQueries({queryKey:workbenchQueryKeys.prototypeV2('project-one')});});
 await waitFor(()=>expect(screen.queryByTestId('private-preview')).toBeNull());
 await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('项目访问权限已失效'));
 expect(m.api.getProjectBootstrap.mock.calls.length).toBeGreaterThan(initial);
 expect(client.getQueryData(workbenchQueryKeys.prototypeV2Plan('project-one','plan-one'))).toBeUndefined();
});
it('retains an authorized cached preview during an ordinary network failure',async()=>{
 const client=await mount(); m.api.getRevision.mockRejectedValue(new Error('network unavailable'));
 await act(async()=>{await client.invalidateQueries({queryKey:workbenchQueryKeys.prototypeV2('project-one')});});
 await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('network unavailable'));
 expect(screen.getByTestId('private-preview').textContent).toBe('PRIVATE_FROZEN_HTML');
});
it('keeps the last explicit new selection after a revision input response arrives late',async()=>{
 await mount();let resolve!:(r:any)=>void;m.api.getRevisionInput.mockImplementation(()=>new Promise(r=>{resolve=r}));
 fireEvent.click(screen.getByRole('button',{name:'修改版本 1'}));await waitFor(()=>expect(m.api.getRevisionInput).toHaveBeenCalledTimes(1));
 fireEvent.click(screen.getByRole('button',{name:'新建计划'}));
 await act(async()=>{resolve({plan,request,snapshot:null,sha256:'a'.repeat(64),modificationRequest:request});});
 expect(screen.getByRole('button',{name:'新建计划'}).getAttribute('aria-pressed')).toBe('true');
 expect(screen.getByRole('button',{name:'修改版本 1'}).getAttribute('aria-pressed')).toBe('false');
});
it.each(['7','30'])('recovers the exact %s-day share command after a lost receipt and refresh',async(days)=>{
 await mount();vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-17T01:00:00Z'));
 const accepted=new Map<string,unknown>();
 m.api.createShare.mockImplementation(async(projectId:string,body:any,key:string)=>{
  accepted.set(key,body); if(m.api.createShare.mock.calls.length===1)throw new Error('response lost after server accepted');
  return {value:{id:'share-one',projectId,...body},etag:'"1"'};
 });
 fireEvent.click(screen.getByRole('button',{name:'分享 / 导出'}));
 fireEvent.change(screen.getByLabelText('分享有效期'),{target:{value:days}});
 fireEvent.click(screen.getByRole('button',{name:'创建分享'}));
 await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('response lost'));
 cleanup();clients.splice(0).forEach(c=>c.clear());m.composer=null;
 vi.setSystemTime(new Date('2026-11-17T01:05:00Z'));await mount();
 fireEvent.click(screen.getByRole('button',{name:'分享 / 导出'}));
 await waitFor(()=>expect((screen.getByRole('button',{name:/^(恢复分享结果|创建分享)$/}) as HTMLButtonElement).disabled).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:/^(恢复分享结果|创建分享)$/}));
 await waitFor(()=>expect(m.api.createShare).toHaveBeenCalledTimes(2));
 expect(m.api.createShare.mock.calls[0]).toEqual(m.api.createShare.mock.calls[1]);expect(accepted.size).toBe(1);
 await waitFor(()=>expect(screen.getByRole('button',{name:'创建分享'})).toBeTruthy());
});

it('does not render another account cache while its project permission is still being checked',async()=>{
 const client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:30000}}});clients.push(client);
 const view=render(<QueryClientProvider client={client}><StudioProject projectId="project-one"/></QueryClientProvider>);
 await waitFor(()=>expect(screen.getByTestId('private-preview').textContent).toBe('PRIVATE_FROZEN_HTML'));
 let reject!:(reason:unknown)=>void;
 m.api.getProjectBootstrap.mockImplementation(()=>new Promise((_resolve,no)=>{reject=no}));
 m.userId='different-account';view.rerender(<QueryClientProvider client={client}><StudioProject projectId="project-one"/></QueryClientProvider>);
 expect(screen.queryByTestId('private-preview')).toBeNull();
 await waitFor(()=>expect(reject).toBeTruthy());
 await act(async()=>reject(new WorkbenchApiError({status:403,code:'PROJECT_FORBIDDEN',title:'not a member',type:'about:blank'})));
 await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('项目访问权限已失效'));
 expect(client.getQueryData(workbenchQueryKeys.prototypeV2Plan('project-one','plan-one'))).toBeUndefined();
});

it('restores the same actor unsent draft only after fresh project authorization succeeds',async()=>{
 const client=await mount(); const bootstrap=await m.api.getProjectBootstrap();
 act(()=>m.composer.setPrompt('合法未发送的草稿'));
 await waitFor(async()=>expect((await readComposerSession('audit-actor:project-one'))?.entries.new?.draft.prompt).toBe('合法未发送的草稿'));
 const denied=new WorkbenchApiError({status:403,code:'PROJECT_FORBIDDEN',title:'removed',type:'about:blank'});
 m.api.getProjectBootstrap.mockRejectedValue(denied);m.api.getRevision.mockRejectedValue(denied);
 await act(async()=>{await client.invalidateQueries({queryKey:workbenchQueryKeys.prototypeV2('project-one')});});
 await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('项目访问权限已失效'));
 expect(screen.queryByTestId('composer-prompt')).toBeNull();
 m.api.getProjectBootstrap.mockResolvedValue(bootstrap);m.api.getRevision.mockResolvedValue({value:revision,etag:'"1"'});
 fireEvent.click(screen.getByRole('button',{name:'重新核验权限'}));
 await waitFor(()=>expect(screen.getByTestId('composer-prompt').textContent).toBe('合法未发送的草稿'));
 expect(screen.getByTestId('private-preview').textContent).toBe('PRIVATE_FROZEN_HTML');
});

it('keeps polling an accepted export cancellation and only displays completion after GET acknowledges cleanup',async()=>{
 const now='2026-11-17T00:00:00.000Z';
 const item={id:'export-one',projectId:'project-one',revisionId:'revision-one',format:'html',status:'cancelling',revision:1,artifact:null,failure:null,createdAt:now,updatedAt:now,finishedAt:null};
 m.api.listExports.mockResolvedValueOnce([item]).mockResolvedValue([{...item,status:'cancelled',finishedAt:now}]);
 await mount();
 fireEvent.click(screen.getByRole('button',{name:'分享 / 导出'}));
 await screen.findByText('HTML · 正在取消',{}, {timeout:5000});
 expect(screen.queryByRole('button',{name:'取消导出'})).toBeNull();expect(screen.queryByRole('button',{name:'重试'})).toBeNull();
 await screen.findByText('HTML · 已取消',{}, {timeout:5000});
});

it('rechecks and removes private views on a later denial of the same HTTP path',async()=>{
 await mount();const path='/api/v1/projects/project-one/prototype-v2/shares';
 const signal=()=>window.dispatchEvent(new CustomEvent('workbench:access-denied',{detail:{path,status:403}}));
 const initial=m.api.getProjectBootstrap.mock.calls.length;
 act(signal);await waitFor(()=>expect(m.api.getProjectBootstrap.mock.calls.length).toBeGreaterThan(initial));
 await screen.findByTestId('private-preview');
 m.api.getProjectBootstrap.mockRejectedValue(new WorkbenchApiError({status:403,code:'PROJECT_FORBIDDEN',title:'removed',type:'about:blank'}));
 const before=m.api.getProjectBootstrap.mock.calls.length;act(signal);
 await waitFor(()=>expect(screen.queryByTestId('private-preview')).toBeNull());
 await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('项目访问权限已失效'));
 expect(m.api.getProjectBootstrap.mock.calls.length).toBeGreaterThan(before);
});
it('stops automatic remount loops when a resource repeatedly denies access but project bootstrap succeeds',async()=>{
 await mount();const signal=()=>window.dispatchEvent(new CustomEvent('workbench:access-denied',{detail:{path:'/api/v1/projects/project-one/prototype-v2/shares',status:403}}));
 act(signal);await screen.findByTestId('private-preview');
 act(signal);await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('资源仍拒绝访问'));
 expect(screen.queryByTestId('private-preview')).toBeNull();
 const calls=m.api.getProjectBootstrap.mock.calls.length;await act(async()=>{await new Promise(r=>setTimeout(r,100));});expect(m.api.getProjectBootstrap).toHaveBeenCalledTimes(calls);
 fireEvent.click(screen.getByRole('button',{name:'重新核验权限'}));await screen.findByTestId('private-preview');
});

it('clears private caches for a concealed project404 but preserves workspace on a missing individual resource',async()=>{const client=await mount();const before=m.api.getProjectBootstrap.mock.calls.length;act(()=>window.dispatchEvent(new CustomEvent('workbench:access-denied',{detail:{path:'/api/v1/projects/project-one/prototype-v2/revisions/missing',status:404}})));expect(screen.getByTestId('private-preview')).toBeTruthy();expect(m.api.getProjectBootstrap).toHaveBeenCalledTimes(before);m.api.getProjectBootstrap.mockRejectedValue(new WorkbenchApiError({status:404,code:'NOT_FOUND',title:'Project was not found',type:'about:blank'}));await act(async()=>{await client.invalidateQueries({queryKey:workbenchQueryKeys.bootstraps('project-one')});});await waitFor(()=>expect(screen.queryByTestId('private-preview')).toBeNull());await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('项目访问权限已失效'));expect(client.getQueryData(workbenchQueryKeys.prototypeV2Plan('project-one','plan-one'))).toBeUndefined();});
