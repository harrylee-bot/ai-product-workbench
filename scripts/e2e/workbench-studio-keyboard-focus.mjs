// Actual Tailwind/PostCSS compilation and Chromium keyboard focus; no model calls.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import {chromium} from 'playwright';
const root=path.resolve(fileURLToPath(new URL('../../',import.meta.url))),sourcePath=path.join(root,'apps/web/app/globals.css');
const output=path.join(root,'output/audit/1.0.0/studio-keyboard-focus');await mkdir(output,{recursive:true});
const beforeCommit=process.env.WORKBENCH_FOCUS_BASE_COMMIT??'5e7d49e02bd3fab8f2a0b8b9c11037e87f56ccff';
const sources={before:execFileSync('git',['show',beforeCommit+':apps/web/app/globals.css'],{cwd:root,encoding:'utf8'}),after:await readFile(sourcePath,'utf8')};
const digest=s=>createHash('sha256').update(s).digest('hex');const results={beforeCommit,scope:'Real compiled product stylesheet, isolated native DOM using Studio home/workspace classes; no full product or live backend claim',realApiCalls:0,realModelCalls:0};
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
try{for(const [mode,source] of Object.entries(sources)){
 const compiled=await postcss([tailwind()]).process(source,{from:sourcePath});await writeFile(path.join(output,mode+'.css'),compiled.css);
 const page=await browser.newPage();await page.route('**/*',route=>route.abort());
 await page.setContent('<!doctype html><html><body><main class="studio-shell studio-home"><button id="home">创建项目</button><a id="control" href="#">项目目录</a></main><div class="studio-shell visual-workspace" style="position:relative;height:300px"><button id="send">发送需求</button><input id="prompt" aria-label="需求"/><select id="model" aria-label="模型"><option>Flash</option></select><textarea id="details" aria-label="详情"></textarea></div></body></html>');
 await page.addStyleTag({content:compiled.css});const observed=[];
 for(let n=0;n<6;n++){await page.keyboard.press('Tab');observed.push(await page.evaluate(()=>{const e=document.activeElement,s=getComputedStyle(e);return{id:e.id,visible:e.matches(':focus-visible'),style:s.outlineStyle,width:s.outlineWidth,color:s.outlineColor};}));}
 assert.deepEqual(observed.map(x=>x.id),['home','control','send','prompt','model','details']);
 for(const item of observed){assert.equal(item.visible,true);if(mode==='after'){assert.equal(item.style,'solid');assert.ok(parseFloat(item.width)>=2);}else if(item.id!=='control')assert.equal(item.style,'none');}
 results[mode]={sourceSha256:digest(source),compiledSha256:digest(compiled.css),observed};await page.screenshot({path:path.join(output,mode+'.png')});await page.close();
}results.status='passed';await writeFile(path.join(output,'results.json'),JSON.stringify(results,null,2));console.log({status:results.status,controls:6,output});}finally{await browser.close();}
