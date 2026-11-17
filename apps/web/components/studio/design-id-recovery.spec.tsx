// @vitest-environment jsdom
import React from 'react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({POST:vi.fn(),GET:vi.fn()}));
vi.mock('@/lib/workbench/transport/context',()=>({useWorkbenchTransport:()=>({api:m})}));
import {ContextImports} from '@/components/studio/context-library';
afterEach(()=>{cleanup();vi.restoreAllMocks()});
it.each(['01234567-89ab-4cde-8012-3456789abcde','abcdef01-89ab-4cde-8012-3456789abcde'] as const)('creates a custom design with UUID %s',async(uuid)=>{
 m.POST.mockReset().mockRejectedValue(new Error("TEST_HTTP_REACHED"));m.GET.mockResolvedValue({data:{items:[],nextCursor:null}});
 vi.spyOn(crypto,'randomUUID').mockReturnValue(uuid);
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 render(<QueryClientProvider client={client}><ContextImports bootstrap={{project:{id:'project-one',workspaceId:'workspace-one'}} as any} canEdit/></QueryClientProvider>);
 fireEvent.click(screen.getByText('创建自定义设计系统'));
 fireEvent.change(screen.getByLabelText('名称'),{target:{value:'品牌规范'}});
 fireEvent.click(screen.getByRole('button',{name:'创建设计系统'}));
 await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('TEST_HTTP_REACHED'));
 expect(m.POST).toHaveBeenCalledOnce();expect(m.POST.mock.calls[0][1].body.document.documentId).toBe(`design-${uuid}`);
 expect((screen.getByLabelText('名称') as HTMLInputElement).value).toBe('品牌规范');
});
