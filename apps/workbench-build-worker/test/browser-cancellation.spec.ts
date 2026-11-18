import { chromium, type Browser } from 'playwright-core';
import { describe,expect,it,vi } from 'vitest';
import { checkFrozenPrototypeHtml } from '../src/browser-check.js';

const executablePath=process.env.WORKBENCH_EXPORT_CHROMIUM_PATH;
(executablePath?describe:describe.skip)('actual Chromium cancellation cleanup',()=>{
 it('closes the browser before acknowledging an aborted validation',async()=>{
  const controller=new AbortController(),launch=chromium.launch.bind(chromium);let browser:Browser|undefined;
  const spy=vi.spyOn(chromium,'launch').mockImplementation(async options=>browser=await launch(options));
  try{
   const operation=checkFrozenPrototypeHtml('<html><body data-wb-prototype="true">Waiting for runtime</body></html>',{executablePath,timeoutMs:30000,signal:controller.signal,onProgress:step=>{if(step==='chromium:dom')controller.abort(new Error('fixture cancellation requested'));}});
   await expect(operation).rejects.toThrow('fixture cancellation requested');expect(browser).toBeDefined();expect(browser!.isConnected()).toBe(false);
  }finally{spy.mockRestore();await browser?.close();}
 },30000);
});
