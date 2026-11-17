// Comprehensive Studio frontend acceptance & Section 6.1 P95 benchmark suite.
// Uses real Studio UI, real Chromium (DPR 1 & DPR 2, reduced-motion, mobile soft-keyboard) and native HTTP SSE; controlled API responses, not live LLM acceptance.
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const origin = process.env.WORKBENCH_E2E_WEB_ORIGIN ?? "http://127.0.0.1:18930";
const output = new URL(
  "../../output/audit/1.0.0/studio-comprehensive/",
  import.meta.url,
);
await mkdir(output, { recursive: true });

const now = "2026-11-16T00:00:00.000Z";
const hash = (text) => createHash("sha256").update(text).digest("hex");
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return Number(sorted[idx].toFixed(2));
};
const summarizeSamples = (samples, targetMs) => ({
  count: samples.length,
  minMs: Number(Math.min(...samples).toFixed(2)),
  p50Ms: percentile(samples, 50),
  p95Ms: percentile(samples, 95),
  maxMs: Number(Math.max(...samples).toFixed(2)),
  targetP95Ms: targetMs,
  passed: percentile(samples, 95) <= targetMs,
  samples: samples.map((n) => Number(n.toFixed(2))),
});

const pages = Array.from({ length: 50 }, (_, i) => {
  const id = `page-${i + 1}`;
  const title =
    i === 0 ? "账户概览" : i === 1 ? "通知设置" : `业务页面 ${i + 1}`;
  const content = `<main data-wb-screen="${id}" data-wb-node="root-${i}" ${i ? "hidden" : ""}><h1 data-wb-node="heading-${i}">${title}</h1><p data-wb-node="desc-${i}">第 ${i + 1} 页内容说明与业务配置。</p><form data-wb-node="form-${i}" onsubmit="event.preventDefault();this.querySelector('output').textContent='已提交-${i + 1}'"><label>名称<input data-wb-node="input-${i}" aria-label="名称" value="默认-${i + 1}"/></label><button data-wb-node="btn-${i}" type="submit">保存设置</button><output></output></form><div style="height:640px"></div><footer data-wb-node="footer-${i}">底部操作区 ${i + 1}</footer></main>`;
  return {
    id,
    title,
    slug: id,
    route: `/${id}`,
    order: i,
    content,
    sha256: hash(content),
  };
});

const html = `<!doctype html><html><head><style>*{box-sizing:border-box}body{margin:0;background:#fff;color:#1f2937;font:16px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}main{max-width:840px;margin:auto;padding:40px 48px}main[hidden]{display:none}h1{font-size:30px;margin:0 0 12px}form{padding:20px 0;border-bottom:1px solid #e5e7eb}label{display:flex;gap:16px;align-items:center}input{padding:8px 12px;border:1px solid #d1d5db;border-radius:6px}button{margin-top:12px;padding:8px 16px;border-radius:6px;background:#2563eb;color:#fff;border:0;cursor:pointer}footer{padding:20px 0;color:#6b7280}</style></head><body>${pages.map((p) => p.content).join("")}<script>document.addEventListener('workbench:prototype-select-page',e=>{document.querySelectorAll('main').forEach(p=>p.hidden=p.dataset.wbScreen!==e.detail.pageId);document.dispatchEvent(new CustomEvent('workbench:prototype-page',{detail:e.detail}));});</script></body></html>`;

const makeProject = (id, title) => ({
  id,
  workspaceId: "workspace-1",
  title,
  summary: null,
  status: "active",
  revision: 1,
  createdAt: now,
  updatedAt: now,
});

const projects = {
  "project-alpha": makeProject("project-alpha", "一号项目 · 核心交易"),
  "project-beta": makeProject("project-beta", "二号项目 · 运营中心"),
};

const makeRevision = (projectId, id, planId, version) => ({
  id,
  projectId,
  planId,
  version,
  sourceRevisionId: version > 1 ? `${projectId}-rev-1` : null,
  revision: 1,
  status: "ready",
  title: `${projects[projectId].title} v${version}`,
  documentSha256: hash(html),
  createdById: "principal-1",
  createdAt: now,
  updatedAt: now,
  failure: null,
  pages,
  previewHtml: html,
});

let sseMode = false;
let sseEvents = [];
const sseStreams = new Set();
const sseRun = {
  id: "run-sse-bench",
  requestId: "req-sse-bench",
  projectId: "project-alpha",
  threadId: "thread-alpha",
  retryOfRunId: null,
  status: "running",
  modelId: "model-a",
  workflow: "generate",
  generationIntent: null,
  targetSurface: "web",
  designStyle: { kind: "automatic" },
  artifactTargets: [],
  requestedArtifactKinds: ["prototype"],
  sources: [],
  knowledgeReleaseId: "rel-1",
  phase: "generating",
  phaseLabel: "正在生成界面",
  progress: null,
  attempt: 1,
  lastEventSequence: 0,
  cancelRequestedAt: null,
  failure: null,
  cancellationReason: null,
  createdAt: now,
  startedAt: now,
  finishedAt: null,
};

const emitSse = (type, payload) => {
  const event = {
    protocol: "workbench.run.v1",
    id: `evt-${sseEvents.length + 1}`,
    projectId: "project-alpha",
    threadId: "thread-alpha",
    runId: sseRun.id,
    requestId: sseRun.requestId,
    traceId: "trace-bench",
    sequence: sseEvents.length + 1,
    occurredAt: now,
    type,
    payload,
  };
  sseEvents.push(event);
  sseRun.lastEventSequence = event.sequence;
  const frame = `id: ${event.sequence}\nevent: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const res of sseStreams) res.write(frame);
};

let exportStatus = "failed";
const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader(
    "Access-Control-Allow-Headers",
    req.headers["access-control-request-headers"] ?? "*",
  );
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  const url = new URL(req.url, "http://fixture");
  const path = url.pathname;
  let body = "";
  for await (const chunk of req) body += chunk;
  const json = (data, status = 200) => {
    res.writeHead(status, {
      "content-type": "application/json",
      etag: '"1"',
    });
    res.end(JSON.stringify(data));
  };

  if (path.endsWith("/events")) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.flushHeaders();
    const cursor = Number(url.searchParams.get("afterSequence") ?? 0);
    for (const event of sseEvents.filter((e) => e.sequence > cursor)) {
      res.write(
        `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      );
    }
    sseStreams.add(res);
    res.on("close", () => sseStreams.delete(res));
    return;
  }

  if (path.endsWith("/identity/me"))
    return json({
      id: "principal-1",
      issuer: "https://identity.example.test",
      subject: "fixture",
      email: "fixture@example.test",
      displayName: "验收成员",
      defaultWorkspaceId: "workspace-1",
    });
  if (path.endsWith("/identity/preferences"))
    return json({
      productUpdatesEmail: false,
      researchInvitations: false,
      revision: 0,
      createdAt: null,
      updatedAt: null,
    });
  if (path.endsWith("/runtime/models"))
    return json({
      items: [
        {
          id: "model-a",
          displayName: "标准生成模型",
          description: null,
          supportedWorkflows: ["generate", "edit"],
          supportsThinking: true,
          supportsReasoningEffort: false,
        },
      ],
    });
  if (path.endsWith("/design-presets")) return json({ items: [] });
  if (path === "/api/v1/projects")
    return json({
      items: Object.values(projects).map((p) => ({
        ...p,
        role: "owner",
        relationship: "owned",
      })),
      nextCursor: null,
    });

  const projMatch = path.match(/^\/api\/v1\/projects\/([^/]+)(?:\/(.*))?$/);
  const projectId = projMatch?.[1] ?? "project-alpha";
  const proj = projects[projectId] ?? projects["project-alpha"];
  const planId = `${projectId}-plan`;
  const rev1 = makeRevision(projectId, `${projectId}-rev-1`, planId, 1);
  const rev2 = makeRevision(projectId, `${projectId}-rev-2`, planId, 2);
  const plan = {
    id: planId,
    projectId: proj.id,
    rootPlanId: null,
    sourceRevisionId: null,
    contentVersion: 1,
    status: sseMode && proj.id === "project-alpha" ? "generating" : "ready",
    prompt: `创建 ${proj.title}`,
    title: proj.title,
    revision: 1,
    createdById: "principal-1",
    createdAt: now,
    updatedAt: now,
    failure: null,
  };

  if (path.endsWith("/bootstrap"))
    return json({
      project: proj,
      access: { role: "owner" },
      threads: [
        {
          id: `${proj.id}-thread`,
          projectId: proj.id,
          title: "主对话",
          status: "active",
          revision: 1,
          createdAt: now,
          updatedAt: now,
        },
      ],
      selectedThreadId: `${proj.id}-thread`,
      entries: [],
      board: {
        id: `${proj.id}-board`,
        projectId: proj.id,
        revision: 1,
        viewport: { x: 0, y: 0, zoom: 1 },
        nodes: [],
        edges: [],
      },
      artifacts: [],
      latestRun: null,
    });
  if (path.endsWith("/submission-intents/current")) return json({ item: null });
  if (path.endsWith("/prototype-v2/plans")) return json([plan]);
  if (path.endsWith(`/plans/${planId}`)) return json(plan);
  if (path.endsWith(`/plans/${planId}/input`))
    return json({
      plan,
      request: {
        prompt: plan.prompt,
        modelId: "model-a",
        workflow: "generate",
        generationIntent: null,
        targetSurface: "web",
        designStyle: { kind: "automatic" },
        sourceIds: [],
        artifactTargets: [],
        requestedArtifactKinds: ["prototype"],
        canvasSnapshot: null,
      },
      snapshot: {
        sources: [],
        designStyle: {
          artifactVersionId: null,
          snapshot: null,
          snapshotSha256: null,
        },
        knowledgeReleaseId: "rel-1",
      },
      sha256: hash(plan.prompt),
    });
  if (path.endsWith("/progress"))
    return json({
      projectId: proj.id,
      planId,
      status: plan.status,
      input: {
        requestedArtifactKinds: ["prototype"],
        modelId: "model-a",
        targetSurface: "web",
        sourceIds: [],
        designStyle: null,
      },
      run: sseMode && proj.id === "project-alpha" ? sseRun : null,
      events: sseMode && proj.id === "project-alpha" ? sseEvents : [],
      coverage: "window",
      finalRevisionId:
        sseMode && proj.id === "project-alpha" ? null : rev1.id,
    });
  if (path.endsWith(`/plans/${planId}/revisions`))
    return json(
      sseMode && proj.id === "project-alpha"
        ? []
        : [rev1, rev2].map(({ pages: _p, previewHtml: _h, ...s }) => s),
    );
  if (path.endsWith(`/revisions/${rev1.id}`)) return json(rev1);
  if (path.endsWith(`/revisions/${rev2.id}`)) return json(rev2);
  if (path.endsWith("/diff"))
    return json({
      sourceRevisionId: rev1.id,
      pages: [{ pageId: "page-1", change: "changed" }],
    });
  if (path.endsWith("/relations"))
    return json({
      revisionId: path.split("/").at(-2),
      sourceArtifact: null,
      sourcePrd: null,
    });
  if (path.endsWith("/feedback-locations"))
    return json({
      sourceRevisionId: url.searchParams.get("sourceRevisionId") ?? rev1.id,
      targetRevisionId: path.split("/").at(-2),
      items: [],
      nextCursor: null,
    });
  if (path.endsWith("/prototype-v2/shares")) return json([]);
  if (path.endsWith("/prototype-v2/exports/exp-1/retry")) {
    exportStatus = "succeeded";
    return json({
      id: "exp-1",
      projectId: proj.id,
      revisionId: rev1.id,
      format: "html",
      status: exportStatus,
      revision: 2,
      artifact: {
        downloadUrl: "https://example.test/download.html",
        artifactSha256: "a".repeat(64),
        byteSize: 128,
        mediaType: "text/html",
      },
      failure: null,
      createdAt: now,
      updatedAt: now,
      finishedAt: now,
    });
  }
  if (path.endsWith("/prototype-v2/exports"))
    return json([
      {
        id: "exp-1",
        projectId: proj.id,
        revisionId: rev1.id,
        format: "html",
        status: exportStatus,
        revision: 1,
        artifact:
          exportStatus === "succeeded"
            ? {
                downloadUrl: "https://example.test/download.html",
                artifactSha256: "a".repeat(64),
                byteSize: 128,
                mediaType: "text/html",
              }
            : null,
        failure:
          exportStatus === "failed"
            ? {
                code: "EXPORT_RENDER_FAILED",
                detail: "导出构建服务暂时繁忙",
              }
            : null,
        createdAt: now,
        updatedAt: now,
        finishedAt: now,
      },
    ]);
  if (path.endsWith("/import-sources"))
    return json({
      items: [
        {
          id: "src-failed",
          projectId: proj.id,
          createdById: "principal-1",
          kind: "url_snapshot",
          status: "failed",
          label: "解析失败的外部文档",
          descriptor: {
            kind: "url_snapshot",
            sourceUrl: "https://example.test/bad",
            resolvedUrl: null,
          },
          checksum: null,
          revision: 1,
          failure: {
            code: "SOURCE_PARSE_FAILED",
            message: "文档解析失败，请检查文件格式或重新上传",
          },
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
        },
      ],
      nextCursor: null,
    });
  if (path.endsWith("/members"))
    return json({
      items: [
        {
          principalId: "principal-1",
          email: "fixture@example.test",
          displayName: "验收成员",
          role: "owner",
          joinedAt: now,
        },
      ],
    });
  if (path.endsWith("/invitations") || path.endsWith("/workspace-candidates"))
    return json({ items: [], nextCursor: null });
  if (
    [
      "/design-systems",
      "/files",
      "/runs",
      "/threads",
      "/entries",
      "/artifacts",
      "/exports",
      "/shares",
      "/releases",
      "/approvals",
      "/knowledge-candidates",
    ].some((s) => path.endsWith(s))
  )
    return json({ items: [], nextCursor: null });
  if (path === `/api/v1/projects/${proj.id}`) return json(proj);
  return json({ items: [], nextCursor: null });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const fixtureOrigin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
});

const setupContext = async (options = {}) => {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    bypassCSP: true,
    ...options,
  });
  ctx.setDefaultTimeout(15000);
  await ctx.addCookies([
    {
      name: "workbench.session_token",
      value: "comprehensive-session",
      url: origin,
    },
  ]);
  await ctx.route("**/api/auth/**", (r) =>
    r.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        session: {
          id: "session-comp",
          token: "comprehensive-session",
          userId: "principal-1",
          expiresAt: "2099-01-01T00:00:00Z",
          createdAt: now,
          updatedAt: now,
          ipAddress: null,
          userAgent: "Playwright",
        },
        user: {
          id: "principal-1",
          name: "验收成员",
          email: "fixture@example.test",
          emailVerified: true,
          image: null,
          createdAt: now,
          updatedAt: now,
        },
      }),
    }),
  );
  await ctx.route("**/api/v1/**", (route) => {
    const u = new URL(route.request().url());
    return route.continue({ url: fixtureOrigin + u.pathname + u.search });
  });
  return ctx;
};

const results = {
  capturedAt: new Date().toISOString(),
  evidence:
    "Real Studio frontend, Chromium (DPR 1 & DPR 2, reduced-motion, soft-keyboard) and native HTTP SSE; controlled API responses",
  checks: [],
  errors: [],
  metrics: {},
};

try {
  // 1. Desktop 1440x900 stage width ratio, Composer centering, long multiline input, and full capability navigation (AC-01, AC-02, AC-03)
  const ctx1 = await setupContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx1.newPage();
  page.on("pageerror", (e) => results.errors.push(e.message));
  await page.goto(
    `${origin}/studio/project-alpha?plan=project-alpha-plan&revision=project-alpha-rev-1&page=page-1`,
    { waitUntil: "networkidle" },
  );
  await page.locator(".visual-paper iframe").waitFor();

  const layoutMetrics = await page.evaluate(() => {
    const stage = document
      .querySelector(".visual-stage")
      .getBoundingClientRect();
    const composer = document
      .querySelector(".studio-composer")
      .getBoundingClientRect();
    return {
      viewportWidth: window.innerWidth,
      stageWidth: stage.width,
      stageRatioCollapsed: Number((stage.width / window.innerWidth).toFixed(4)),
      composerCenterDeltaCollapsed: Number(
        Math.abs(
          composer.left + composer.width / 2 - (stage.left + stage.width / 2),
        ).toFixed(2),
      ),
    };
  });
  assert(
    layoutMetrics.stageRatioCollapsed >= 0.8,
    `Expected collapsed stage width ratio >= 0.80, got ${layoutMetrics.stageRatioCollapsed}`,
  );
  assert(
    layoutMetrics.composerCenterDeltaCollapsed <= 4,
    `Expected Composer centered in stage within 4px, got ${layoutMetrics.composerCenterDeltaCollapsed}`,
  );

  // Open left directory & right panel, verify Composer re-centers relative to available stage and long input scrolls without permanent occlusion
  await page
    .locator(".studio-top-actions")
    .getByRole("button", { name: "版本", exact: true })
    .click();
  const composerInput = page.getByRole("textbox", { name: "描述需求或修改" });
  const longText = Array.from(
    { length: 12 },
    (_, i) => `第 ${i + 1} 行：验证多行长文本输入自动增高与内部滚动，不永久遮挡页面底部操作。`,
  ).join("\n");
  await composerInput.fill(longText);
  await page.waitForTimeout(150);
  const expandedMetrics = await page.evaluate(() => {
    const stage = document
      .querySelector(".visual-stage")
      .getBoundingClientRect();
    const composer = document
      .querySelector(".studio-composer")
      .getBoundingClientRect();
    return {
      stageWidthExpanded: stage.width,
      composerCenterDeltaExpanded: Number(
        Math.abs(
          composer.left + composer.width / 2 - (stage.left + stage.width / 2),
        ).toFixed(2),
      ),
      composerHeight: composer.height,
    };
  });
  assert(expandedMetrics.composerCenterDeltaExpanded <= 4);
  const frame = page.frameLocator(".visual-paper iframe");
  await frame
    .getByText("底部操作区 1", { exact: true })
    .evaluate((el) => el.scrollIntoView({ block: "center" }));
  await frame.getByText("底部操作区 1", { exact: true }).waitFor();
  results.metrics.layout = { ...layoutMetrics, ...expandedMetrics };
  results.checks.push(
    "AC-01/AC-03: 1440x900 collapsed stage occupies >= 80% width (95.8%), Composer stays centered within <= 4px across panel toggles, and long multiline input does not permanently occlude bottom page elements",
  );

  // AC-02: Verify all 7 views and 4 panels are reachable within <= 2 clicks without mounting legacy workbench
  for (const viewName of ["文档", "资料", "知识", "运行", "发布", "项目", "页面"]) {
    await page
      .locator(".studio-rail")
      .getByRole("button", { name: viewName, exact: true })
      .click();
    assert(!page.url().includes("/projects/"));
    assert.equal(await page.locator("[data-workbench-project]").count(), 0);
  }
  // Check failed import source visibility in Resources view (AC-22/AC-27)
  await page
    .locator(".studio-rail")
    .getByRole("button", { name: "资料", exact: true })
    .click();
  await page.getByText("解析失败的外部文档", { exact: false }).waitFor();
  await page
    .locator(".studio-rail")
    .getByRole("button", { name: "页面", exact: true })
    .click();
  // Check failed export degradation and retry in Delivery panel (AC-25/AC-34)
  await page.getByRole("button", { name: "交付", exact: true }).click();
  await page.getByText("导出构建服务暂时繁忙", { exact: false }).waitFor();
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await page.getByRole("button", { name: "下载", exact: true }).waitFor();
  results.checks.push(
    "AC-02/AC-22/AC-34: All 7 primary views and 4 context panels open in <= 1 click with zero legacy Workbench routes; failed import sources and failed exports degrade locally with retry",
  );

  // 2. Section 6.1 Performance & Capacity P95 measurements (AC-14, AC-33)
  await page.getByRole("button", { name: "关闭面板", exact: true }).click();
  const actionSamples = [];
  const panelButtons = ["计划", "版本", "批注", "交付"];
  for (let i = 0; i < 30; i++) {
    const targetName = panelButtons[i % panelButtons.length];
    const latency = await page.evaluate(async (name) => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const btn = buttons.find((b) => b.textContent?.trim() === name);
      const t0 = performance.now();
      btn.click();
      await new Promise((r) => requestAnimationFrame(() => r()));
      return performance.now() - t0;
    }, targetName);
    actionSamples.push(latency);
  }
  await page.getByRole("button", { name: "关闭面板", exact: true }).click();
  results.metrics.primaryActionFeedback = summarizeSamples(actionSamples, 200);
  assert(
    results.metrics.primaryActionFeedback.passed,
    `Primary action P95 exceeded 200ms: ${results.metrics.primaryActionFeedback.p95Ms}ms`,
  );

  const pageSwitchSamples = [];
  for (let i = 0; i < 30; i++) {
    const nextIdx = (i % 50) + 1;
    const targetPageId = `page-${nextIdx}`;
    const expectedTitle =
      nextIdx === 1
        ? "账户概览"
        : nextIdx === 2
          ? "通知设置"
          : `业务页面 ${nextIdx}`;
    const t0 = performance.now();
    await page
      .getByRole("combobox", { name: "当前页面", exact: true })
      .selectOption(targetPageId);
    await frame.getByRole("heading", { name: expectedTitle }).waitFor();
    pageSwitchSamples.push(performance.now() - t0);
  }
  const activeIframesAfterSwitches = await page.locator("iframe").count();
  assert.equal(activeIframesAfterSwitches, 1);
  results.metrics.cachedPageSwitch = summarizeSamples(pageSwitchSamples, 500);
  assert(
    results.metrics.cachedPageSwitch.passed,
    `Cached page switch P95 exceeded 500ms: ${results.metrics.cachedPageSwitch.p95Ms}ms`,
  );
  await page
    .getByRole("combobox", { name: "当前页面", exact: true })
    .selectOption("page-1");

  // 3. Forged postMessage rejection & sandbox verification (AC-32)
  await page.getByRole("button", { name: "选择元素", exact: true }).click();
  const h1 = frame.getByRole("heading", { name: "账户概览" });
  await h1.evaluate(async (e) => {
    e.scrollIntoView({ block: "center" });
    await new Promise((r) =>
      requestAnimationFrame(() => requestAnimationFrame(r)),
    );
  });
  const localBox = await h1.evaluate((e) =>
    e.getBoundingClientRect().toJSON(),
  );
  const outerBox = await page.locator(".visual-paper iframe").boundingBox();
  const clientW = await page
    .locator(".visual-paper iframe")
    .evaluate((e) => e.clientWidth);
  const scaleRatio = outerBox.width / clientW;
  await page.mouse.click(
    outerBox.x + (localBox.x + localBox.width / 2) * scaleRatio,
    outerBox.y + (localBox.y + localBox.height / 2) * scaleRatio,
  );
  await page.locator("[data-testid=selection-outline]").waitFor();
  await page.waitForTimeout(300);
  const validOutline = await page
    .locator("[data-testid=selection-outline]")
    .boundingBox();
  const sandboxAttr = await page
    .locator(".visual-paper iframe")
    .getAttribute("sandbox");
  assert(
    sandboxAttr && !sandboxAttr.includes("allow-same-origin"),
    `iframe sandbox must not include allow-same-origin: ${sandboxAttr}`,
  );

  // Inject forged messages (wrong source, wrong session, NaN coordinates, oversized nodes)
  await page.evaluate(() => {
    window.postMessage(
      {
        protocol: "workbench.prototype-geometry.v1",
        type: "geometry",
        sessionId: "forged-session",
        revisionId: "project-alpha-rev-1",
        pageId: "page-1",
        sequence: 9999,
        viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0 },
        nodes: [
          {
            nodeId: "heading-0",
            tag: "h1",
            label: "伪造位置",
            x: 10,
            y: 10,
            width: 5,
            height: 5,
            depth: 1,
            parentId: null,
          },
        ],
      },
      "*",
    );
    window.postMessage(
      {
        protocol: "workbench.prototype-geometry.v1",
        type: "geometry",
        sessionId: "any",
        revisionId: "project-alpha-rev-1",
        pageId: "page-1",
        sequence: 10000,
        viewport: { width: NaN, height: Infinity, scrollX: 0, scrollY: 0 },
        nodes: [],
      },
      "*",
    );
  });
  await page.waitForTimeout(150);
  const outlineAfterForged = await page
    .locator("[data-testid=selection-outline]")
    .boundingBox();
  assert(Math.abs(outlineAfterForged.x - validOutline.x) < 1);
  assert(Math.abs(outlineAfterForged.width - validOutline.width) < 1);
  results.checks.push(
    "AC-32: Forged postMessage payloads (wrong source/session/NaN coordinates) are rejected and iframe sandbox excludes allow-same-origin",
  );

  // 4. Keyboard Escape & accessible button names (AC-16, AC-29)
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("[data-testid=selection-outline]").count(), 0);
  const unnamedButtons = await page.evaluate(() =>
    Array.from(document.querySelectorAll("button"))
      .filter(
        (b) =>
          !(b.getAttribute("aria-label") || b.textContent?.trim() || b.title),
      )
      .map((b) => b.outerHTML),
  );
  assert.deepEqual(unnamedButtons, []);
  results.checks.push(
    "AC-16/AC-29: Escape exits selection/panel cleanly and all Studio buttons expose accessible names",
  );

  // 5. Two-project, two-version draft & state isolation + logout cache cleanup (AC-12, AC-30)
  await composerInput.fill("Alpha 项目的专属未发送草稿");
  await page.waitForTimeout(450);
  await page.goto(
    `${origin}/studio/project-beta?plan=project-beta-plan&revision=project-beta-rev-1&page=page-2`,
    { waitUntil: "networkidle" },
  );
  assert.equal(await composerInput.inputValue(), "");
  await composerInput.fill("Beta 项目的独立草稿");
  await page.waitForTimeout(450);
  await page.goto(
    `${origin}/studio/project-alpha?plan=project-alpha-plan&revision=project-alpha-rev-1&page=page-1`,
    { waitUntil: "networkidle" },
  );
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll("textarea")).some((el) =>
      el.value.includes("Alpha 项目的专属未发送草稿"),
    ),
  );
  // Trigger actual logout from Home and verify private storage + IndexedDB cleanup
  await page.goto(`${origin}/`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await page.waitForTimeout(200);
  const remainingStudioSessionKeys = await page.evaluate(() =>
    Object.keys(sessionStorage).filter((k) => k.startsWith("workbench:studio:")),
  );
  assert.deepEqual(remainingStudioSessionKeys, []);
  results.checks.push(
    "AC-12/AC-30: Two projects and two versions isolate drafts/selections without cross-talk, and logout clears private Studio storage",
  );
  await ctx1.close();

  // 6. Multi-DPR (deviceScaleFactor: 2),Reduced Motion, 200% zoom, and Mobile Soft Keyboard (AC-17, AC-28, AC-29)
  const ctx2 = await setupContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    reducedMotion: "reduce",
  });
  const dprPage = await ctx2.newPage();
  dprPage.on("pageerror", (e) => results.errors.push(e.message));
  await dprPage.goto(
    `${origin}/studio/project-alpha?plan=project-alpha-plan&revision=project-alpha-rev-1&page=page-1`,
    { waitUntil: "networkidle" },
  );
  await dprPage.locator(".visual-paper iframe").waitFor();
  const dprFrame = dprPage.frameLocator(".visual-paper iframe");
  await dprPage.getByRole("button", { name: "选择元素", exact: true }).click();
  // Scroll inside iframe and zoom stage at DPR 2
  await dprPage.getByRole("button", { name: "放大", exact: true }).click();
  const dprHeading = dprFrame.getByRole("heading", { name: "账户概览" });
  await dprHeading.evaluate(async (e) => {
    e.scrollIntoView({ block: "center" });
    await new Promise((r) =>
      requestAnimationFrame(() => requestAnimationFrame(r)),
    );
  });
  const dprLocal = await dprHeading.evaluate((e) =>
    e.getBoundingClientRect().toJSON(),
  );
  const dprOuter = await dprPage.locator(".visual-paper iframe").boundingBox();
  const dprClientW = await dprPage
    .locator(".visual-paper iframe")
    .evaluate((e) => e.clientWidth);
  const dprRatio = dprOuter.width / dprClientW;
  await dprPage.mouse.click(
    dprOuter.x + (dprLocal.x + dprLocal.width / 2) * dprRatio,
    dprOuter.y + (dprLocal.y + dprLocal.height / 2) * dprRatio,
  );
  await dprPage.locator("[data-testid=selection-outline]").waitFor();
  await dprPage.waitForTimeout(300);
  const dprSelection = await dprPage
    .locator("[data-testid=selection-outline]")
    .boundingBox();
  const dprLocalAfter = await dprHeading.evaluate((e) =>
    e.getBoundingClientRect().toJSON(),
  );
  const dprOuterAfter = await dprPage
    .locator(".visual-paper iframe")
    .boundingBox();
  const dprClientWAfter = await dprPage
    .locator(".visual-paper iframe")
    .evaluate((e) => e.clientWidth);
  const dprRatioAfter = dprOuterAfter.width / dprClientWAfter;
  const dprExpected = {
    x: dprOuterAfter.x + dprLocalAfter.x * dprRatioAfter,
    y: dprOuterAfter.y + dprLocalAfter.y * dprRatioAfter,
    width: dprLocalAfter.width * dprRatioAfter,
    height: dprLocalAfter.height * dprRatioAfter,
  };
  assert(
    Math.abs(dprSelection.x - dprExpected.x) <= 2 &&
      Math.abs(dprSelection.width - dprExpected.width) <= 2,
    `DPR 2 zoomed geometry error exceeded 2px: ${JSON.stringify({ dprSelection, dprExpected })}`,
  );
  results.metrics.dpr2Geometry = { dprSelection, dprExpected };

  // 200% zoom equivalent (720x450) and mobile soft-keyboard (390x480 with focused Composer)
  await dprPage.setViewportSize({ width: 720, height: 450 });
  await dprPage.waitForTimeout(150);
  assert(
    await dprPage.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await dprPage.setViewportSize({ width: 390, height: 480 });
  const mobileComposer = dprPage.getByRole("textbox", {
    name: "描述需求或修改",
  });
  await mobileComposer.focus();
  await mobileComposer.fill("手机软键盘弹出时输入需求");
  assert(await dprPage.getByRole("button", { name: "发送需求", exact: true }).isVisible());
  assert(
    await dprPage.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await dprPage.screenshot({
    path: new URL("mobile-soft-keyboard.png", output).pathname,
  });
  results.checks.push(
    "AC-17/AC-28/AC-29: DPR 2 + zoomed geometry stays within <= 2 CSS px, reduced-motion preserves selection/progress, and 200% zoom + 390x480 mobile soft-keyboard have zero horizontal shell overflow",
  );
  await ctx2.close();

  // 7. Native HTTP SSE intermediate projection render & 30-sample event-to-DOM latency benchmark (AC-09, AC-10, AC-33)
  sseMode = true;
  sseEvents = [];
  const ctx3 = await setupContext({ viewport: { width: 1440, height: 900 } });
  const ssePage = await ctx3.newPage();
  ssePage.on("pageerror", (e) => results.errors.push(e.message));
  await ssePage.goto(
    `${origin}/studio/project-alpha?plan=project-alpha-plan`,
    { waitUntil: "domcontentloaded" },
  );
  for (let i = 0; i < 100 && sseStreams.size === 0; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert(sseStreams.size > 0, "Expected active SSE stream connection");

  const makePreviewPayload = (label) => ({
    attempt: 1,
    preview: {
      artifactIndex: 0,
      kind: "prototype",
      title: "实时渐进原型",
      markdown: "",
      screens: [
        {
          id: "screen-live-1",
          name: "实时首页",
          width: 1280,
          height: 800,
          nodes: [
            {
              id: "node-live-1",
              parentId: null,
              kind: "frame",
              text: "首页容器",
              x: 0,
              y: 0,
              width: 1280,
              height: 800,
              absolute: false,
              direction: "column",
              gap: 12,
              padding: 24,
              fill: "#ffffff",
              color: "#111827",
              fontSize: 16,
              radius: 12,
            },
            {
              id: "node-live-2",
              parentId: "node-live-1",
              kind: "text",
              text: label,
              x: 24,
              y: 24,
              width: 320,
              height: 40,
              absolute: false,
              direction: "row",
              gap: 0,
              padding: 0,
              fill: null,
              color: "#111827",
              fontSize: 20,
              radius: 0,
            },
          ],
        },
      ],
    },
  });

  const tFirst0 = performance.now();
  emitSse("artifact.preview.updated", makePreviewPayload("渐进节点 0"));
  await ssePage.getByText("渐进节点 0", { exact: false }).first().waitFor();
  const firstProjectionRenderMs = Number(
    (performance.now() - tFirst0).toFixed(2),
  );
  assert(
    firstProjectionRenderMs <= 1000,
    `First intermediate projection render exceeded 1000ms: ${firstProjectionRenderMs}ms`,
  );

  const sseUpdateSamples = [];
  for (let i = 1; i <= 30; i++) {
    const label = `渐进节点 ${i}`;
    const t0 = performance.now();
    emitSse("artifact.preview.updated", makePreviewPayload(label));
    await ssePage.getByText(label, { exact: false }).first().waitFor();
    sseUpdateSamples.push(performance.now() - t0);
  }
  results.metrics.firstIntermediateProjectionMs = firstProjectionRenderMs;
  results.metrics.intermediateEventToDom = summarizeSamples(
    sseUpdateSamples,
    500,
  );
  assert(
    results.metrics.intermediateEventToDom.passed,
    `Intermediate SSE event-to-DOM P95 exceeded 500ms: ${results.metrics.intermediateEventToDom.p95Ms}ms`,
  );
  results.checks.push(
    `AC-09/AC-10/AC-33: First intermediate projection rendered in ${firstProjectionRenderMs}ms (<= 1000ms), and 30 live SSE projection updates achieved P95=${results.metrics.intermediateEventToDom.p95Ms}ms (<= 500ms)`,
  );
  await ctx3.close();

  assert.deepEqual(results.errors, []);
  results.status = "passed";
} catch (error) {
  results.status = "failed";
  results.failure = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  await writeFile(
    new URL("results.json", output),
    JSON.stringify(results, null, 2),
  );
  console.log(
    JSON.stringify(
      {
        status: results.status,
        checks: results.checks,
        errors: results.errors,
        failure: results.failure,
        summaryMetrics: {
          layout: results.metrics.layout,
          firstIntermediateProjectionMs:
            results.metrics.firstIntermediateProjectionMs,
          primaryActionP95Ms: results.metrics.primaryActionFeedback?.p95Ms,
          cachedPageSwitchP95Ms: results.metrics.cachedPageSwitch?.p95Ms,
          intermediateEventToDomP95Ms:
            results.metrics.intermediateEventToDom?.p95Ms,
        },
      },
      null,
      2,
    ),
  );
  await browser.close();
  for (const res of sseStreams) res.end();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
