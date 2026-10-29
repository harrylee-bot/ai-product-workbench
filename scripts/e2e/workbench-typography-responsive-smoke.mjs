import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { artifactVersionDetailSchema, exportCapabilitiesSchema, projectReleaseSchema, publicArtifactVersionDetailSchema, publicShareSchema } from "@workbench/workbench-contracts";
import { prdDocumentV2Example } from "@workbench/workbench-contracts/test-fixtures";

// Layout regression against the real local Web bundle with controlled read-only APIs.
const origin = new URL(process.env.WORKBENCH_E2E_WEB_ORIGIN ?? "http://localhost:3000").origin;
assert.ok(["localhost", "127.0.0.1"].includes(new URL(origin).hostname), "Use a local Web server for this fixture");
const output = fileURLToPath(new URL("../../output/audit/1.0.0/typography-responsive/", import.meta.url));
const timestamp = "2026-10-29T00:00:00.000Z";
const checksum = "a".repeat(64);
const project = { id: "project-typography", workspaceId: "workspace-1", title: "跨部门业务需求与产品原型协同管理平台的字体及多屏适配验收项目", summary: null, status: "active", revision: 1, createdAt: timestamp, updatedAt: timestamp };
const thread = { id: "thread-typography", projectId: project.id, title: "需求", status: "active", revision: 1, createdAt: timestamp, updatedAt: timestamp };
const version = { artifactId: "artifact-prd", artifactVersionId: "prd-v1", version: 1, kind: "prd", schemaVersion: 2, status: "ready", checksum, createdByRunId: null, createdAt: timestamp };
const artifact = { id: "artifact-prd", projectId: project.id, kind: "prd", title: "示例工单需求说明书", revision: 1, currentVersion: version, createdAt: timestamp, updatedAt: timestamp };
const board = {
  id: "board-typography", projectId: project.id, revision: 1,
  viewport: { x: 320, y: 55, zoom: 0.8 },
  nodes: [{ id: "node-prd", kind: "artifact", parentNodeId: null, order: 0,
    position: { x: 10, y: 10 }, size: { width: 750, height: 1000 },
    artifactId: "artifact-prd", artifactVersionId: "prd-v1",
    data: { protocol: "workbench.board-node.v1", nodeType: "artifact", title: artifact.title, artifactKind: "prd" } }],
  edges: [],
};
const detail = artifactVersionDetailSchema.parse({ ...version, citations: [], knowledgeReleaseId: null, contentMode: "inline", content: prdDocumentV2Example });
const pin = { position: 0, artifactId: artifact.id, artifactVersionId: version.artifactVersionId, title: artifact.title, kind: "prd", version: 1, schemaVersion: 2, checksum, assets: [] };
const release = projectReleaseSchema.parse({
  id: "release-typography", projectId: project.id, version: 1, status: "ready", createdById: "principal-1",
  boardId: board.id, boardRevision: 1, boardSnapshot: board, boardChecksum: checksum, artifactPins: [pin],
  manifest: { protocol: "workbench.project-release.v1", projectId: project.id, releaseVersion: 1, board: { id: board.id, revision: 1, checksum }, artifacts: [pin] },
  manifestSha256: checksum, failure: null, createdAt: timestamp, finishedAt: timestamp, updatedAt: timestamp,
});
const publicRelease = structuredClone(release);
delete publicRelease.createdById;
for (const item of [...publicRelease.artifactPins, ...publicRelease.manifest.artifacts]) delete item.assets;
const publicShare = publicShareSchema.parse({ shareId: "share-typography", scope: "remix", expiresAt: null, release: publicRelease });
const publicDetail = { ...detail };
delete publicDetail.createdByRunId;
delete publicDetail.knowledgeReleaseId;
publicArtifactVersionDetailSchema.parse(publicDetail);
const available = { available: true, authentication: "not_required", reasonCode: null };
const capabilities = exportCapabilitiesSchema.parse({
  formats: Object.fromEntries(["html", "react", "figma", "mcp", "docx", "pdf"].map(f => [f, available])),
  packaging: { single_file: available, zip: available },
  external: Object.fromEntries(["ai_studio", "netlify", "lovable", "bolt"].map(f => [f, { available: false, authentication: "required", reasonCode: "EXPORT_EXTERNAL_AUTHENTICATION_REQUIRED" }])),
});
const unknownRequests = [];
const pageErrors = [];
const json = (route, value, headers = {}, status = 200) => route.fulfill({ status, contentType: "application/json", headers, body: JSON.stringify(value) });
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
await context.addCookies([{ name: "workbench.session_token", value: "fixture-typography", url: origin }]);
await context.route("**/api/auth/**", route => json(route, {
  session: { id: "session-typography", token: "fixture-typography", userId: "principal-1", expiresAt: "2099-01-01T00:00:00.000Z", createdAt: timestamp, updatedAt: timestamp, ipAddress: null, userAgent: "Playwright" },
  user: { id: "principal-1", name: "Layout Reviewer", email: "reviewer@example.test", emailVerified: true, image: null, createdAt: timestamp, updatedAt: timestamp },
}));
await context.route("**/api/v1/**", route => {
  const request = route.request();
  const p = new URL(request.url()).pathname;
  if (request.method() === "GET") {
    if (p === "/api/v1/identity/me") return json(route, { id: "principal-1", issuer: "https://identity.example.test", subject: "typography", email: "reviewer@example.test", displayName: "Layout Reviewer", defaultWorkspaceId: "workspace-1" });
    if (p === "/api/v1/identity/preferences") return json(route, { productUpdatesEmail: false, researchInvitations: false, revision: 0, createdAt: null, updatedAt: null }, { etag: '\"0\"' });
    if (p === "/api/v1/runtime/models") return json(route, { items: [{ id: "model-1", displayName: "Controlled Model", description: null, supportedWorkflows: ["generate", "redesign", "ideate", "edit"], supportsThinking: true, supportsReasoningEffort: false }] });
    if (p === "/api/v1/design-presets") return json(route, { items: [] });
    if (p === "/api/v1/projects") return json(route, { items: [{ ...project, role: "owner", relationship: "owned" }], nextCursor: null });
    if (p === "/api/v1/workspaces/workspace-1/design-systems") return json(route, { items: [], nextCursor: null });
    if (p === `/api/v1/projects/${project.id}/bootstrap`) return json(route, { project, access: { role: "owner" }, threads: [thread], selectedThreadId: thread.id, entries: [], board, artifacts: [artifact], latestRun: null }, { etag: '\"1\"' });
    if (p === `/api/v1/threads/${thread.id}/submission-intents/current`) return json(route, { item: null });
    if (p === `/api/v1/projects/${project.id}/artifacts`) return json(route, { items: [artifact], nextCursor: null });
    if (p === `/api/v1/projects/${project.id}/board`) return json(route, board, { etag: '\"1\"' });
    if (p === "/api/v1/artifacts/artifact-prd") return json(route, artifact, { etag: '\"1\"' });
    if (p === "/api/v1/artifacts/artifact-prd/versions") return json(route, { items: [version], nextCursor: null });
    if (p === "/api/v1/artifacts/artifact-prd/versions/prd-v1") return json(route, detail, { etag: `"${checksum}"` });
    if (p.endsWith("/finalization")) return json(route, null);
    if (p.endsWith("/preference")) return json(route, { artifactId: artifact.id, artifactVersionId: version.artifactVersionId, screenId: null, favorite: false, reaction: null, revision: 0, createdAt: null, updatedAt: null }, { etag: `"avp1.0.${"a".repeat(43)}"` });
    if (p === `/api/v1/projects/${project.id}/members`) return json(route, { items: [
      { projectId: project.id, principalId: "principal-1", role: "owner", displayName: "负责跨部门需求及原型协同工作的产品负责人", email: "product-owner-with-a-long-name@example.test", createdAt: timestamp, updatedAt: timestamp },
      { projectId: project.id, principalId: "principal-2", role: "viewer", displayName: "业务验收协作者", email: "reviewer-with-a-long-name@example.test", createdAt: timestamp, updatedAt: timestamp },
    ] });
    if (p === "/api/v1/exports/capabilities") return json(route, capabilities);
    if (p === `/api/v1/projects/${project.id}/shares`) return json(route, { items: [], activeCount: 0, nextCursor: null });
    if (/\/(import-sources|releases|exports|invitations|members)$/.test(p)) return json(route, { items: [], nextCursor: null });
    if (p === "/api/v1/public/shares/typography-fixture") return json(route, publicShare, { etag: '\"public-share\"' });
    if (p === "/api/v1/public/shares/typography-fixture/artifacts/artifact-prd/versions/prd-v1") return json(route, publicDetail, { etag: `"${checksum}"` });
  }
  unknownRequests.push(`${request.method()} ${p}`);
  return json(route, { code: "FIXTURE_ROUTE_MISSING" }, {}, 404);
});
const page = await context.newPage();
page.setDefaultTimeout(15_000);
page.on("pageerror", error => pageErrors.push(error.stack ?? error.message));
const results=[];
const viewports=[{width:320,height:568},{width:375,height:812},{width:768,height:1024},{width:1024,height:768},{width:1440,height:900},{width:844,height:390}];
async function capture(name,viewport) {
 await page.setViewportSize(viewport);
 await page.waitForTimeout(350);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${name} body overflow at ${viewport.width}`);
 await page.screenshot({path:`${output}/verified-${name}-${viewport.width}x${viewport.height}.png`,animations:'disabled'});
 results.push({name,viewport,passed:true});
}
async function inside(locator,label) {
 await page.waitForTimeout(350);
 const bounds=await locator.boundingBox();
 assert.ok(bounds,`${label} must be visible`);
 assert.ok(bounds.x>=-1&&bounds.y>=-1&&bounds.x+bounds.width<=(page.viewportSize().width+1)&&bounds.y+bounds.height<=(page.viewportSize().height+1),`${label} outside viewport: ${JSON.stringify(bounds)}`);
}
async function toolbar(selector) {
 const root=page.locator(selector);
 assert.ok(await root.evaluate(el=>el.scrollWidth<=el.clientWidth+1),`${selector} overflows horizontally`);
 const controls=root.locator('button').filter({visible:true});
 for(const button of await controls.all()) await inside(button,await button.getAttribute('aria-label')??await button.innerText());
 const bounds=await controls.evaluateAll(els=>els.map(el=>{const r=el.getBoundingClientRect();return {label:el.getAttribute('aria-label')??el.textContent,x:r.x,y:r.y,right:r.right,bottom:r.bottom};}));
 for(let i=0;i<bounds.length;i++)for(let j=i+1;j<bounds.length;j++){
  const a=bounds[i],b=bounds[j];assert.ok(Math.min(a.right,b.right)-Math.max(a.x,b.x)<=1||Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y)<=1,`Overlapping actions ${a.label} and ${b.label}`);
 }
}
async function closeDialog(){await page.keyboard.press('Escape');await page.waitForTimeout(200);}
try {
 await page.goto(origin,{waitUntil:'networkidle',timeout:90000});
 await page.locator('[data-home-composer]').waitFor({timeout:60000});
 for(const v of viewports){
  await page.setViewportSize(v);
  await page.getByRole('button',{name:'提交提示',exact:true}).scrollIntoViewIfNeeded();
  await toolbar('[data-home-composer-toolbar]');
  await capture('home',v);
  const scroller=page.locator('.workbench-home-content');
  assert.ok(await scroller.evaluate(el=>el.scrollHeight>=el.clientHeight));
 }
 for(const v of [{width:320,height:568},{width:768,height:1024}]){
  await page.setViewportSize(v);
  await page.getByRole('button',{name:'项目列表',exact:true}).click();
  await page.waitForTimeout(350);
  await inside(page.locator('[data-home-project-drawer-open="true"]'),'project drawer');
  await capture('drawer',v);
  await page.getByRole('button',{name:'项目列表',exact:true}).click();
 }
 await page.setViewportSize({width:320,height:568});
 for(const label of ['选择生成类型','命令','添加附件']){
  await page.getByRole('button',{name:label,exact:true}).click();
  await inside(page.getByRole('menu'),'home '+label);
  await capture('home-menu-'+label,{width:320,height:568});
  await page.getByRole('button',{name:label,exact:true}).click();
 }
 await page.getByRole('button',{name:'添加附件',exact:true}).click();
 await page.getByRole('menuitem',{name:/网站/}).click();
 for(const v of [{width:320,height:568},{width:844,height:390},{width:768,height:1024}]){
  await page.setViewportSize(v);await inside(page.getByRole('dialog'),'import');
  const close=page.locator('[data-slot="dialog-close"]');
  assert.ok(await close.evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),'Dialog close button must be above navigation');
  await capture('import',v);
 }
 await closeDialog();
 await page.goto(`${origin}/projects/${project.id}`,{waitUntil:'networkidle',timeout:90000});
 await page.locator('[data-workbench-project]').waitFor({timeout:60000});
 for(const v of viewports){
  await page.setViewportSize(v);await page.waitForTimeout(200);
  await toolbar('[data-project-composer-toolbar]');
  await inside(page.getByRole('navigation',{name:'画布工具'}),'canvas tools');
  if(v.width<768){
   const rail=await page.getByRole('navigation',{name:'画布工具'}).boundingBox(), suggestions=await page.locator('[data-project-suggestions]').boundingBox(),composer=await page.locator('[data-project-composer]').boundingBox();
   assert.ok(rail.y+rail.height<=suggestions.y, 'Canvas tools overlap suggestions');
   assert.ok(suggestions.y+suggestions.height<composer.y,'Suggestions overlap composer');
  }
  const paragraphs=page.locator('[data-prd-protocol] p');
  assert.ok(await paragraphs.count()>0);
  assert.ok(await paragraphs.evaluateAll(els=>els.every(el=>getComputedStyle(el).whiteSpace!=='nowrap')),'Document paragraphs must wrap');
  await capture('project',v);
 }
 await page.setViewportSize({width:1440,height:900});
 const documentNode=page.locator('.react-flow__node[data-id="node-prd"]');
 await documentNode.focus();await documentNode.press('Enter');
 await page.locator('[data-prd-editor="active"]').waitFor();
 const editorTitle=page.locator('.workbench-prd-editor-content h1').first();
 assert.ok(await editorTitle.evaluate(el=>parseFloat(getComputedStyle(el).fontSize)<=32),'Editor title must use the reading scale');
 assert.ok(await page.locator('.workbench-prd-editor-content p').evaluateAll(els=>els.every(el=>getComputedStyle(el).whiteSpace!=='nowrap')),'Editor paragraphs must wrap');
 for(const v of [{width:1440,height:900},{width:320,height:568}])await capture('document-editor',v);
 await page.setViewportSize({width:1440,height:900});
 await page.locator('.react-flow__pane').click({position:{x:1100,y:250}});
 await page.setViewportSize({width:320,height:568});
 for(const label of ['选择生成类型','命令','样式','添加附件']){
  await page.getByRole('button',{name:label,exact:true}).click();
  await inside(page.getByRole('menu'),'project '+label);
  await capture('project-menu-'+label,{width:320,height:568});
  await page.getByRole('button',{name:label,exact:true}).click();
 }
 await page.getByRole('button',{name:'共享',exact:true}).click();
 await inside(page.getByRole('dialog'),'share');await capture('share',{width:320,height:568});await closeDialog();
 await page.getByRole('button',{name:'导出',exact:true}).click();
 await inside(page.locator('[data-workbench-export-panel]'),'export');await capture('export',{width:320,height:568});
 await page.getByRole('button',{name:'Close',exact:true}).click();
 await page.getByRole('button',{name:'项目菜单',exact:true}).click();
 await page.getByRole('menuitem',{name:'成员与权限',exact:true}).click();
 await inside(page.getByRole('dialog'),'members');await capture('members',{width:320,height:568});await closeDialog();
 await page.goto(`${origin}/share/typography-fixture`,{waitUntil:'networkidle',timeout:90000});
 await page.getByRole('heading',{name:/共享项目/}).waitFor();
 for(const v of [{width:320,height:568},{width:768,height:1024},{width:1440,height:900}])await capture('public-share',v);
 await context.route('**/api/auth/**',route=>json(route,{session:null,user:null}));
 await page.goto(`${origin}/login`,{waitUntil:'networkidle',timeout:90000});
 await page.setViewportSize({width:320,height:568});
 await page.getByRole('button',{name:'打开导航',exact:true}).click();
 await page.getByRole('button',{name:'登录',exact:true}).click();
 for(const v of [{width:320,height:568},{width:844,height:390},{width:1440,height:900}]){
  await page.setViewportSize(v);await inside(page.locator('form').first(),'login form');
  const input=page.getByRole('textbox',{name:'用户名或邮箱',exact:true});
  if(v.width<640)assert.equal(await input.evaluate(el=>getComputedStyle(el).fontSize),'16px');
  await capture('login',v);
 }
 assert.deepEqual(pageErrors,[]);assert.deepEqual(unknownRequests,[]);
 console.log(JSON.stringify({passed:true,checks:results.length}));
}finally{
 await writeFile(`${output}/verified-checks.json`,JSON.stringify({environment:'Local Next.js with controlled API fixtures',results,pageErrors,unknownRequests},null,2));
 await browser.close();
}
