// Actual UI components + headless Chromium. Controlled view data only;
// no semantic/model/backend acceptance or production workflow claim.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { chromium } from "playwright";

const root = new URL("../../", import.meta.url);
const output = new URL("output/audit/1.0.0/studio-requirement-discussion/", root);
await mkdir(output, { recursive: true });
const result = { status: "running", evidence: "Actual RequirementDiscussion and Onlook ChatInput; controlled UI data; no backend/model calls", checks: [], errors: [], modelCalls: 0 };
const bundle = await build({
  stdin: { resolveDir: root.pathname, loader: "tsx", contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { RequirementDiscussion } from './apps/web/components/studio/requirement-discussion';
    import { ChatInput } from './apps/web/components/studio/onlook/chat-input';
    window.confirmations = []; window.messages = []; window.recoveries = 0;
    function App() {
      const [view, setView] = useState(null), [text, setText] = useState('');
      const [output, setOutput] = useState('both'), [editable, setEditable] = useState(true);
      window.setDiscussion = next => { setView(next); setText(''); };
      window.setEditable = setEditable;
      return <div className="dock">
        {view && <RequirementDiscussion view={view} canEdit={editable} dirtyInput={!!text.trim()}
          onConfirm={async review => { window.confirmations.push({review, output}); setView(v => ({...v, status:'generating', currentGeneration:{label:'正在生成', baseline:review.id + '/' + review.version}})); }}
          onContinue={() => document.querySelector('textarea')?.focus()}
          onRecoverConfirmation={async () => { window.recoveries++; }} onLoadEarlier={async () => {}} />}
        <ChatInput discussion value={text} onChange={setText} onSendMessage={async () => {window.messages.push({text, output});setText('');}}
          onFiles={() => {}} onScreenshot={async () => {}} isStreaming={false} disabled={!editable}
          controls={<select aria-label="生成内容" value={output} onChange={e => setOutput(e.target.value)}><option value="both">文档＋原型</option><option value="prd">仅文档</option><option value="prototype">仅原型</option></select>} />
      </div>;
    }
    createRoot(document.querySelector('#mount')).render(<App/>);
  ` },
  bundle: true, write: false, format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' },
});
const js = bundle.outputFiles[0].contents;
result.bundleSha256 = createHash("sha256").update(js).digest("hex");
const css = (await readFile(new URL("apps/web/app/globals.css", root), "utf8")).split("\n")
  .filter(line => /^\.studio-(requirement|composer|chips|muted|error)|^@media\(max-width:600px\).*studio-requirement/u.test(line)).join("\n");
const html = `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{box-sizing:border-box}body{margin:0;background:#f4f5f7;color:#202938;font:14px system-ui;--studio-line:#e3e6eb;--studio-text:#202938}header{padding:18px 28px;background:#fff;border-bottom:1px solid #e3e6eb}button,select{font:inherit;background:white;border:1px solid #d7dfe9;border-radius:8px;padding:8px 12px;color:inherit;cursor:pointer}button:disabled{opacity:.5;cursor:default}button:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid #2563eb;outline-offset:2px}.dock{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);width:min(800px,calc(100% - 32px));display:flex;flex-direction:column;gap:10px}.backdrop{padding:30px;color:#75849a;max-width:800px;margin:0 auto}.backdrop>div{background:#fff;border-radius:12px;height:130px;border:1px solid #e3e6eb;margin:20px 0;padding:24px}${css}
</style><header>Studio · 活动规则 <small>受控 UI 验证</small></header><main class="backdrop"><h1>活动配置</h1><div>基础信息　　页面配置　　规则配置</div><div>原页面舞台</div></main><div id="mount"></div><script src="/bundle.js"></script></html>`;
const server = createServer((req, res) => { res.setHeader("Content-Type", req.url === "/bundle.js" ? "text/javascript" : "text/html; charset=utf-8"); res.end(req.url === "/bundle.js" ? js : html); });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const base = {
  scopeKey: "user/project/thread", status: "discussing", contextLabel: "修改固定版本 2 · 领取按钮", messages: [], questions: [],
  evidence: [{ id: "source", title: "活动模板配置手册", location: "规则配置 / 参与次数", quote: "当前模板支持参与次数限制。", release: "workbench-1.0.0", version: 3, scope: "template" }],
  knowledgeStatus: "available", canConfirm: false, reviewCurrent: true, confirmationPending: false, hasEarlierMessages: false,
};
const ready = { ...base, status: "ready", canConfirm: true, review: {
  id: "summary", version: 2, goal: "复用当前活动规则页，增加每人领取次数", platform: "活动平台", roles: ["策划人员"], modules: ["规则配置"],
  existing: [{ id: "exists", text: "已有参与次数配置", origin: "knowledge", evidenceIds: ["source"] }],
  reuse: [{ id: "reuse", text: "保留现有规则配置入口和权限范围", origin: "knowledge", evidenceIds: ["source"] }],
  changes: [{ id: "change", text: "新增每人领取次数和超限提示", origin: "user", evidenceIds: [] }],
  assumptions: [{ id: "suggestion", text: "新字段放在参与次数旁，沿用现有表单样式", origin: "suggestion", evidenceIds: ["source"] }],
  platformChanges: [], pages: ["活动规则配置页", "活动前台领取区"], flows: ["配置领取上限 → 校验资格 → 领取或显示超限"],
  preserved: ["4A 登录、现有导航、审核发布和活动报表"], target: "Web", design: ["继承当前字段分组与状态颜色"], outputKinds: ["prd", "prototype"],
} };
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
  page.on("pageerror", error => result.errors.push(error.message));
  const requests = []; page.on("request", request => requests.push(request.url()));
  await page.goto(origin); await page.waitForFunction(() => !!window.setDiscussion);
  const set = view => page.evaluate(async view => {
    window.setDiscussion(view);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, view);
  const confirm = page.getByRole("button", { name: "确认需求并生成" });
  const input = page.getByRole("textbox", { name: "描述需求或修改" });
  await set({ ...base, status: "needs-clarification", questions: [{ id: "module", question: "要调整哪个活动模板？", reason: "不同模板的领取规则和适用区域不同。", blocking: true, evidenceIds: [] }] });
  await page.getByText("要调整哪个活动模板？").waitFor(); assert.equal(await confirm.count(), 0);
  await input.fill("先了解一下平台已有的活动规则"); await input.press("Enter");
  assert.equal(await page.evaluate(() => window.messages.length), 1); assert.equal(await page.evaluate(() => window.confirmations.length), 0);
  result.checks.push("Incomplete requirements/knowledge questions need no manufactured card; ordinary send records discussion only");
  await set(ready); await confirm.waitFor(); assert.equal(await confirm.isEnabled(), true);
  await page.getByRole("button", { name: "继续调整需求" }).click(); assert.equal(await input.evaluate(node => node === document.activeElement), true);
  await input.fill("补充：仅限浙江模板"); assert.equal(await confirm.isDisabled(), true);
  await input.fill(""); await set({ ...ready, reviewCurrent: false }); assert.equal(await confirm.isDisabled(), true);
  result.checks.push("Sufficient controlled view directly shows card; natural-language changes focus the existing input and invalidate old confirmation");
  await set(ready);
  const region = page.getByRole("region", { name: "需求交流" });
  await region.evaluate(node => { node.scrollTop = 0; });
  await page.screenshot({ path: new URL("discussion-desktop.png", output).pathname });
  const bounds = await page.locator(".dock").boundingBox(); assert(Math.abs(bounds.x + bounds.width / 2 - 720) <= 1);
  for (const outputKind of ["both", "prd", "prototype"]) {
    await set({ ...ready, review: { ...ready.review, version: outputKind === "both" ? 2 : outputKind === "prd" ? 3 : 4, outputKinds: outputKind === "both" ? ["prd", "prototype"] : [outputKind] } });
    await page.getByRole("combobox", { name: "生成内容" }).selectOption(outputKind);
    await confirm.click(); await page.getByText("后续消息不会修改本次生成；新的改动需重新梳理和确认。").waitFor();
  }
  assert.deepEqual(await page.evaluate(() => window.confirmations.map(item => item.output)), ["both", "prd", "prototype"]);
  await input.fill("下一版增加失败补偿说明"); await input.press("Enter");
  assert.equal(await page.evaluate(() => window.confirmations.length), 3);
  result.checks.push("Three output selections share the explicit review-confirm action; confirmed generation and subsequent discussion remain distinct; bottom-centered dock");
  await page.setViewportSize({ width: 390, height: 720 });
  await set({ ...ready, review: { ...ready.review, platformChanges: ["跨区域权限改造需单独估算成本"] } });
  const consent = page.getByRole("checkbox"); await consent.scrollIntoViewIfNeeded();
  assert.equal(await confirm.isDisabled(), true); await consent.check(); assert.equal(await confirm.isEnabled(), true);
  await confirm.scrollIntoViewIfNeeded();
  await page.screenshot({ path: new URL("discussion-mobile.png", output).pathname });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert((await confirm.boundingBox()).height >= 44);
  await page.evaluate(() => window.setEditable(false)); assert.equal(await confirm.isDisabled(), true); assert.equal(await page.getByRole("button", { name: "发送需求" }).isDisabled(), true);
  result.checks.push("390px layout has no outer overflow and 44px confirmation target; platform-wide changes require explicit consent; viewer cannot send/confirm");
  assert.equal(requests.filter(url => !url.startsWith(origin)).length, 0); assert.deepEqual(result.errors, []);
  result.status = "passed";
} catch (error) { result.status = "failed"; result.errors.push(error.stack ?? String(error)); process.exitCode = 1; }
finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); await writeFile(new URL("results.json", output), JSON.stringify(result, null, 2)); }
console.log(JSON.stringify(result, null, 2));
