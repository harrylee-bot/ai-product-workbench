// @vitest-environment jsdom
import React from 'react';
import {cleanup,render,screen} from '@testing-library/react';
import {afterEach,expect,it} from 'vitest';
import {WorkbenchQueryProvider} from '@/lib/workbench/query/provider';
import {useWorkbenchPrdDraftStore} from '@/lib/workbench/prd-editor/draft-context';
import {prdDocumentV3Example} from '@workbench/workbench-contracts/test-fixtures';
afterEach(()=>{cleanup();localStorage.clear()});
it('current query provider ignores retired drafts and allows unload without a Studio edit',()=>{
 const reference={projectId:'old-project',artifactId:'old-artifact',artifactVersionId:'old-version'};
 localStorage.setItem('workbench:prd-drafts:user-one',JSON.stringify([{reference,baseline:prdDocumentV3Example,document:prdDocumentV3Example}]));
 function Probe(){const store=useWorkbenchPrdDraftStore();return <span>{store?.hasDrafts()?'OLD_DRAFT_RESTORED':'NO_DRAFT'}</span>}
 render(<WorkbenchQueryProvider privateCacheNamespace="user-one"><Probe/></WorkbenchQueryProvider>);
 expect(screen.getByText('NO_DRAFT')).toBeTruthy();
 const event=new Event('beforeunload',{cancelable:true});
 expect(window.dispatchEvent(event)).toBe(true);
 expect(event.defaultPrevented).toBe(false);
});
