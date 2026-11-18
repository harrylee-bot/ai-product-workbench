// Real Chromium + actual DraftProjection/derived Swarm engine. Controlled
// projection data only: this script does not call any model or backend service.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { chromium } from "playwright";

const root = new URL("../../", import.meta.url);
const output = new URL("output/audit/1.0.0/studio-swarm/", root);
await mkdir(output, { recursive: true });
const bundle = await build({
  stdin: {
    contents: `
      import React, { StrictMode, useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { DraftProjection } from './apps/web/components/studio/draft-projection';
      import { generationPreviewSchema } from '@workbench/workbench-contracts';
      const root = createRoot(document.querySelector('#mount'));
      function Projection({ page, running }) {
        const [motionEnabled, setMotionEnabled] = useState(true);
        return <DraftProjection page={page} available={document.querySelector('#mount').clientWidth}
          running={running} updated={false} motionEnabled={motionEnabled}
          onMotionEnabledChange={setMotionEnabled} />;
      }
      window.renderProjection = (nodes, { running = true, scope = 'run-1:page-1', width = 960 } = {}) => {
        const preview = generationPreviewSchema.parse({ artifactIndex: 0, kind: 'prototype', title: '订单中心', markdown: '', screens: [{ id: scope, name: '订单中心', width, height: 680, nodes }] });
        root.render(<StrictMode><Projection key={scope} page={preview.screens[0]} running={running}/></StrictMode>);
      };
      window.swarmAnimationFrames = 0;
      const raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = callback => raf(time => { window.swarmAnimationFrames++; callback(time); });
    `,
    resolveDir: root.pathname,
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "iife",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"development"' },
});
const js = bundle.outputFiles[0].contents;
const css = (await readFile(new URL("apps/web/app/globals.css", root), "utf8"))
  .split("\n").filter(line => /^\.visual-draft-(paper|motion|scroll)/u.test(line)).join("\n");
const html = `<!doctype html><html lang="zh"><meta charset="utf-8"><style>
  *{box-sizing:border-box}body{margin:0;background:#f2f5fa;color:#172033;font:14px system-ui,sans-serif}
  header{height:64px;padding:18px 28px;background:white;border-bottom:1px solid #e1e7f0}
  aside{position:fixed;left:0;top:64px;bottom:0;width:80px;background:#fff;border-right:1px solid #e1e7f0;padding:20px}
  #mount{position:fixed;left:104px;right:24px;top:92px;bottom:102px;overflow:auto;padding:0 12px 20px}
  footer{position:fixed;bottom:24px;left:calc(50% + 40px);transform:translateX(-50%);background:white;border:1px solid #d8e1ed;border-radius:16px;padding:16px;box-shadow:0 8px 30px #14294a12;width:min(660px,70vw)}
  footer input{border:0;outline:0;width:100%;font:inherit}button{font:inherit}
  ${css}
  @media(max-width:600px){aside{width:44px;padding:12px}#mount{left:52px;right:8px;top:80px;padding:0 4px}header{padding:18px 14px}footer{left:calc(50% + 22px);width:80vw}}
</style><header>Studio · 订单中心 <button id="outside">项目菜单</button></header><aside>◫</aside><main id="mount"></main><footer><input aria-label="需求输入" placeholder="继续描述你的需求…"></footer><script src="/bundle.js"></script></html>`;
const server = createServer((req, res) => {
  res.setHeader("Content-Type", req.url === "/bundle.js" ? "text/javascript" : "text/html; charset=utf-8");
  res.end(req.url === "/bundle.js" ? js : html);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const node = (id, text, extra = {}) => ({
  id, parentId: "root", kind: "text", text, x: 0, y: 0, width: 400, height: 48,
  absolute: false, direction: "column", gap: 0, padding: 0, fill: null,
  color: "#172033", fontSize: 20, radius: 0, ...extra,
});
const nodes = (label = "订单正在生成") => [
  node("root", "", { parentId: null, kind: "frame", width: 928, height: 620, padding: 28, gap: 22, fill: "#f8faff", radius: 12 }),
  node("heading", label, { fontSize: 32, height: 60, width: 800 }),
  node("intro", "实时同步订单状态，集中管理交易与交付。", { width: 800, fontSize: 16, height: 32, color: "#667085" }),
  node("summary", "本月订单", { kind: "frame", fill: "#e8efff", padding: 24, height: 150, radius: 12, width: 800 }),
  node("total", "128 笔订单", { parentId: "summary", fontSize: 28, width: 600 }),
  node("actions", "查看订单", { kind: "button", fill: "#2563eb", color: "#ffffff", padding: 16, width: 180, height: 56, radius: 8 }),
];
const results = { status: "running", evidence: "Actual React component and pinned MIT-derived engine in Chromium; controlled validated projections; zero model calls", checks: [], errors: [], bundleSha256: createHash("sha256").update(js).digest("hex") };
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
  page.setDefaultTimeout(10000);
  page.on("pageerror", error => results.errors.push(error.message));
  const requests = [];
  page.on("request", request => requests.push(request.url()));
  await page.goto(origin);
  const render = (items, options) => page.evaluate(({ items, options }) => window.renderProjection(items, options), { items, options });
  const overlay = page.locator("[data-swarm-projection]");
  await render(nodes());
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-swarm-projection]')?.shadowRoot?.querySelector('[data-swarm-source="root"][data-swarm-kind="box"]');
    return Number(el?.dataset.swarmProgress) > 0;
  });
  assert.equal(await overlay.locator(".worker").count(), 6);
  assert.equal(await overlay.getAttribute("aria-hidden"), "true");
  const before = Number(await overlay.locator('[data-swarm-source="root"][data-swarm-kind="box"]').getAttribute("data-swarm-progress"));
  await render(nodes("订单中心 · 最新更新"));
  await page.waitForFunction(() => {
    const shadow = document.querySelector('[data-swarm-projection]')?.shadowRoot;
    return shadow?.textContent.includes('订单中心');
  });
  const retained = Number(await overlay.locator('[data-swarm-source="root"][data-swarm-kind="box"]').getAttribute("data-swarm-progress"));
  assert(retained >= before, `Unchanged root drawing restarted: ${before} -> ${retained}`);
  await page.getByRole("button", { name: "项目菜单" }).click();
  await page.getByRole("textbox", { name: "需求输入" }).fill("连续更新时仍可输入");
  assert.equal(await page.getByRole("textbox", { name: "需求输入" }).inputValue(), "连续更新时仍可输入");
  await page.screenshot({ path: new URL("drawing-desktop.png", output).pathname });
  results.checks.push("Real changed-node typing/boxes; unchanged in-flight root retains progress; six decorative cursors; outside controls/input usable; DPR 2 screenshot");

  const escaped = '<script>window.pwned=true</script>订单 ✅ é';
  await render([...nodes(escaped).filter(item => item.id !== "intro"), node("new-row", "已添加配送进度", { parentId: "root" })]);
  await page.waitForFunction(() => document.querySelector('[data-draft-node="new-row"]')?.textContent === '已添加配送进度');
  assert.equal(await page.locator('[data-draft-node="intro"]').count(), 0);
  assert.equal(await page.evaluate(() => window.pwned), undefined);
  for (let i = 0; i < 30; i++) await render(nodes(`订单进度 ${i}`));
  await page.locator('[data-draft-node="heading"]').filter({hasText:"订单进度 29"}).waitFor();
  await overlay.waitFor({ state: "detached", timeout: 2600 });
  assert.equal(await page.locator('[data-draft-node="heading"]').textContent(), "订单进度 29");
  assert.equal(await page.locator("iframe").count(), 0);
  results.checks.push("Add/delete and Unicode/untrusted text remain inert; 30 coalesced updates reach latest content; drawing relinquishes cover within two seconds");

  await render(nodes("关闭测试"));
  await overlay.waitFor();
  await page.getByRole("button", { name: "关闭绘制动效" }).click();
  await overlay.waitFor({ state: "detached" });
  await render(nodes("关闭后的真实内容"));
  await page.getByText("关闭后的真实内容", { exact: true }).waitFor();
  assert.equal(await overlay.count(), 0);
  await page.getByRole("button", { name: "开启绘制动效" }).click();
  await overlay.waitFor();
  await render(nodes("冻结完成"), { running: false });
  await overlay.waitFor({ state: "detached" });
  await render(nodes("新的运行"), { scope: "run-2:page-1" });
  await overlay.waitFor();
  assert.equal(await overlay.count(), 1);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await overlay.waitFor({ state: "detached" });
  await render(nodes("减少动态效果"));
  await page.getByText("减少动态效果", { exact: true }).waitFor();
  assert.equal(await overlay.count(), 0);
  results.checks.push("Disable persists across same-page updates; reenable/terminal/new-run cleanup; live reduced-motion change removes animation and preserves content");

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await overlay.waitFor();
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  assert.equal(await overlay.getAttribute("data-swarm-phase"), "paused");
  const frames = await page.evaluate(() => window.swarmAnimationFrames);
  assert(Number.isFinite(frames) && frames > 0);
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => window.swarmAnimationFrames), frames);
  await render(nodes("后台接收最新草稿"));
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: false, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForFunction(() => document.querySelector('[data-swarm-projection]')?.dataset.swarmPhase === 'building');
  await page.evaluate(() => { document.querySelector('#mount').scrollTop = 100; });
  await overlay.waitFor({ state: "detached" });
  results.checks.push("Synthetic visibility change pauses animation frames and resumes pending content; real inner scrolling reveals current UI");

  await render([
    node("root", "", { parentId: null, kind: "frame", width: 928, height: 680, fill: "#ffffff", padding: 20 }),
    ...Array.from({ length: 119 }, (_, i) => node(`bounded-${i}`, i === 0 ? "长文本".repeat(666) : `区域 ${i}`, { absolute: true, x: (i % 3) * 290, y: Math.floor(i / 3) * 48, width: 280, height: 40 })),
  ], { scope: "capacity-run" });
  await page.waitForFunction(() => document.querySelectorAll('[data-draft-node]').length === 120);
  await overlay.waitFor({ state: "detached", timeout: 2600 });
  assert.equal(await page.locator('[data-draft-node="bounded-0"]').textContent(), "长文本".repeat(666));
  results.checks.push("Contract maximum 120 real nodes and a 1998-character text remain readable after bounded animation; no model traffic");

  await page.setViewportSize({ width: 390, height: 844 });
  await render(nodes("手机订单"), { scope: "mobile-run" });
  await overlay.waitFor();
  await page.waitForFunction(() => document.querySelector('[data-swarm-projection]')?.dataset.swarmPhase === 'building');
  const clip = await overlay.evaluate(el => {
    const paper = document.querySelector('[data-draft-page]').getBoundingClientRect();
    return { left: Number.parseFloat(el.style.getPropertyValue('--swarm-left')), width: Number.parseFloat(el.style.getPropertyValue('--swarm-width')), paperLeft: paper.left, paperWidth: paper.width, pointerEvents: el.shadowRoot.querySelector('.cover').style.pointerEvents };
  });
  assert(Math.abs(clip.left - clip.paperLeft) < 2 && clip.width <= clip.paperWidth + 2);
  assert.equal(clip.pointerEvents, "none");
  await page.waitForFunction(() => [...document.querySelector('[data-swarm-projection]').shadowRoot.querySelectorAll('.badge')].some(el => el.textContent.includes('CSS px')));
  await page.screenshot({ path: new URL("drawing-mobile.png", output).pathname });
  await page.setViewportSize({ width: 430, height: 844 });
  await overlay.waitFor({ state: "detached" });
  results.checks.push("390px viewport clips drawing to the actual zoomed paper; pointer-transparent cover; resize cancels stale geometry");
  assert(requests.every(url => url.startsWith(origin)), "Unexpected external/model request");
  assert.deepEqual(results.errors, []);
  results.status = "passed";
} catch (error) {
  results.status = "failed";
  results.failure = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await writeFile(new URL("results.json", output), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
}
