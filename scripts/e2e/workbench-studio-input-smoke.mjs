// New Studio fixed-input UI regression; mocked API, no live generation claim.
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { prdDocumentV3Example } from "@workbench/workbench-contracts/test-fixtures";
import { startRunRequestSchema } from "@workbench/workbench-contracts";
const variants = process.env.WORKBENCH_E2E_PROTOTYPE_VARIANTS === "1";
const recovery = process.env.WORKBENCH_E2E_SUBMISSION_RECOVERY === "1";
const splitModels = process.env.WORKBENCH_E2E_SPLIT_MODEL_CAPABILITIES === "1";
const origin = process.env.WORKBENCH_E2E_WEB_ORIGIN ?? "http://127.0.0.1:18930";
const output = new URL(
  variants
    ? "../../output/audit/1.0.0/studio-variants/"
    : recovery
      ? "../../output/audit/1.0.0/studio-submission-recovery/"
      : splitModels
        ? "../../output/audit/1.0.0/studio-revision-models/"
        : "../../output/audit/1.0.0/studio-input/",
  import.meta.url,
);
await mkdir(output, { recursive: true });
const now = "2026-11-15T00:00:00.000Z",
  projectId = "input-project",
  revisionId = "input-revision";
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const project = {
  id: projectId,
  workspaceId: "workspace-1",
  title: "完整输入验证",
  summary: null,
  status: "active",
  revision: 1,
  createdAt: now,
  updatedAt: now,
};
const thread = {
  id: "input-thread",
  projectId,
  title: "需求",
  status: "active",
  revision: 1,
  createdAt: now,
  updatedAt: now,
};
const board = {
  id: "input-board",
  projectId,
  revision: 1,
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [],
  edges: [],
};
const root = {
  id: "root-plan",
  projectId,
  rootPlanId: null,
  sourceRevisionId: null,
  contentVersion: 1,
  status: "ready",
  prompt: "创建订单管理系统",
  title: "订单管理",
  revision: 1,
  createdById: "principal-1",
  createdAt: now,
  updatedAt: now,
  failure: null,
};
const secondPlan = {
  ...root,
  id: "second-plan",
  rootPlanId: root.id,
  contentVersion: 2,
};
const plans = [root, secondPlan],
  commands = [];
let role = "owner";
let misboundRelation = false;
let conflicts = recovery ? 1 : 0;
const receipts = new Map(),
  lostKinds = new Set(),
  replayed = [];
const html =
  '<main data-wb-screen="home" data-wb-node="root"><h1 data-wb-node="heading">订单管理</h1><button data-wb-node="save">保存</button></main>';
const revision = {
  id: revisionId,
  projectId,
  planId: root.id,
  version: 1,
  sourceRevisionId: null,
  revision: 1,
  status: "ready",
  title: root.title,
  documentSha256: hash(html),
  createdById: "principal-1",
  createdAt: now,
  updatedAt: now,
  failure: null,
  pages: [
    {
      id: "home",
      slug: "home",
      title: "订单管理",
      route: "/",
      order: 0,
      content: html,
      sha256: hash(html),
    },
  ],
  previewHtml: html,
};
if (variants) {
  const detailHtml = '<main data-wb-screen="detail"><h1>订单详情</h1></main>';
  revision.pages.push({
    id: "detail",
    slug: "detail",
    title: "订单详情",
    route: "/detail",
    order: 1,
    content: detailHtml,
    sha256: hash(detailHtml),
  });
  revision.pages.push(
    ...Array.from({ length: 12 }, (_, index) => {
      const id = `extra-${index + 1}`;
      const pageHtml = `<main data-wb-screen="${id}"><h1>扩展页面 ${index + 1}</h1></main>`;
      return {
        id,
        slug: id,
        title: `扩展页面 ${index + 1}`,
        route: `/extra-${index + 1}`,
        order: index + 2,
        content: pageHtml,
        sha256: hash(pageHtml),
      };
    }),
  );
}
const source = (id) => ({
  id,
  projectId,
  createdById: "principal-1",
  kind: "url_snapshot",
  status: "ready",
  label: id === "source-1" ? "原始需求" : "新增参考",
  descriptor: {
    kind: "url_snapshot",
    sourceUrl: `https://example.test/${id}`,
    resolvedUrl: null,
  },
  checksum: "a".repeat(64),
  revision: 1,
  failure: null,
  deletedAt: null,
  createdAt: now,
  updatedAt: now,
});
const sources = [source("source-1"), source("source-2")];
const requests = new Map([
  [
    root.id,
    {
      prompt: root.prompt,
      modelId: "model-a",
      workflow: "generate",
      generationIntent: null,
      targetSurface: "web",
      designStyle: { kind: "automatic" },
      sourceIds: ["source-1"],
      artifactTargets: [],
      requestedArtifactKinds: ["prototype"],
      canvasSnapshot: null,
    },
  ],
]);
requests.set(secondPlan.id, { ...requests.get(root.id) });
const secondRevision = {
  ...revision,
  id: "input-revision-2",
  version: 2,
  sourceRevisionId: revisionId,
};
const input = (plan) => {
  const request = requests.get(plan.id);
  return {
    plan,
    request,
    snapshot: {
      sources: request.sourceIds.map((id) => {
        const { kind, label, checksum, descriptor } = source(id);
        return {
          sourceId: id,
          kind,
          label,
          checksum,
          descriptor,
          snapshot: {
            protocol: "workbench.import-source-snapshot.v1",
            sourceRevision: 1,
            checksum,
            blobs: [],
          },
        };
      }),
      designStyle: {
        artifactVersionId: null,
        snapshot: null,
        snapshotSha256: null,
      },
      knowledgeReleaseId: "knowledge-fixed",
    },
    sha256: hash(request),
  };
};
const designVersion = {
  artifactId: "design-1",
  artifactVersionId: "design-version",
  version: 1,
  kind: "design_system",
  schemaVersion: 1,
  status: "ready",
  checksum: "b".repeat(64),
  createdByRunId: null,
  createdAt: now,
};
const artifact = {
  id: "design-1",
  projectId,
  kind: "design_system",
  title: "项目设计系统",
  revision: 1,
  currentVersion: designVersion,
  createdAt: now,
  updatedAt: now,
};
const prdVersion = {
  ...designVersion,
  artifactId: "artifact-prd",
  artifactVersionId: "version-prd",
  kind: "prd",
  schemaVersion: 3,
};
const prdArtifact = {
  ...artifact,
  id: "artifact-prd",
  kind: "prd",
  title: "订单需求",
  currentVersion: prdVersion,
};
const prdRelation = {
  artifactId: "artifact-prd",
  artifactVersionId: "version-prd",
  version: 1,
  schemaVersion: 3,
  kind: "prd",
  status: "ready",
  title: "订单需求",
  createdByRunId: null,
  prototypeRevision: null,
};
const prototypeRelation = {
  artifactId: "source-prototype",
  artifactVersionId: "source-version-1",
  version: 1,
  schemaVersion: 1,
  kind: "prototype",
  status: "ready",
  title: "关联订单原型",
  createdByRunId: null,
  prototypeRevision: { id: revisionId, planId: "root-plan", version: 1 },
};
const results = {
  evidence: "mocked API UI regression, not real model generation",
  checks: [],
  unknown: [],
  errors: [],
};
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
});
await context.addCookies([
  {
    name: "workbench.session_token",
    value: "fixture-input-session",
    url: origin,
  },
]);
const json = (route, value, status = 200) =>
  route.fulfill({
    status,
    contentType: "application/json",
    headers: { etag: `"${value?.revision ?? 1}"` },
    body: JSON.stringify(value),
  });
await context.route("**/api/auth/**", (route) =>
  json(route, {
    session: {
      id: "session-fixture",
      token: "fixture-input-session",
      userId: "principal-1",
      expiresAt: "2099-01-01T00:00:00Z",
      createdAt: now,
      updatedAt: now,
      ipAddress: null,
      userAgent: "Playwright",
    },
    user: {
      id: "principal-1",
      name: "验证",
      email: "fixture@example.test",
      emailVerified: true,
      image: null,
      createdAt: now,
      updatedAt: now,
    },
  }),
);
await context.route("**/api/v1/**", async (route) => {
  const path = new URL(route.request().url()).pathname,
    method = route.request().method();
  const key = route.request().headers()["idempotency-key"];
  if (method === "POST" && receipts.has(key)) {
    const receipt = receipts.get(key);
    assert.deepEqual(route.request().postDataJSON(), receipt.body);
    assert.equal(route.request().headers()["if-match"], receipt.etag);
    replayed.push({
      key,
      body: route.request().postDataJSON(),
      etag: receipt.etag,
    });
    return json(route, receipt.plan, 201);
  }
  const lostResponse = (kind, body, plan) => {
    if (!recovery || lostKinds.has(kind)) return false;
    assert(key);
    lostKinds.add(kind);
    receipts.set(key, {
      body: structuredClone(body),
      plan: structuredClone(plan),
      etag: route.request().headers()["if-match"],
    });
    return true;
  };

  if (path.endsWith("/identity/me"))
    return json(route, {
      id: "principal-1",
      issuer: "https://identity.example.test",
      subject: "fixture",
      email: "fixture@example.test",
      displayName: "验证",
      defaultWorkspaceId: "workspace-1",
    });
  if (path.endsWith("/bootstrap"))
    return json(route, {
      project,
      access: { role },
      threads: [thread],
      selectedThreadId: thread.id,
      entries: [],
      board,
      artifacts: [prdArtifact, artifact],
      latestRun: null,
    });
  if (path === `/api/v1/projects/${projectId}/artifacts`)
    return json(route, { items: [prdArtifact, artifact], nextCursor: null });
  if (path.endsWith("/artifact-links"))
    return json(route, { items: [], nextCursor: null });
  if (path.endsWith("/runtime/models"))
    return json(route, {
      items: ["model-a", "model-b"].map((id) => ({
        id,
        displayName: id,
        description: null,
        supportedWorkflows: splitModels
          ? [id === "model-a" ? "generate" : "edit"]
          : ["generate", "edit"],
        supportsThinking: true,
        supportsReasoningEffort: false,
      })),
    });
  if (path.endsWith("/design-presets")) return json(route, { items: [] });
  if (path.endsWith("/import-sources"))
    return json(route, { items: sources, nextCursor: null });
  if (path.includes("/import-sources/"))
    return json(route, source(path.split("/").at(-1)));
  if (path.endsWith("/prototype-v2/plans")) {
    if (method === "POST") {
      const body = route.request().postDataJSON();
      commands.push({ kind: "new", path, body, key });
      const plan = {
        ...root,
        id: `new-plan-${commands.length}`,
        status: "draft",
        title: body.title,
        prompt: body.prompt,
      };
      plans.push(plan);
      requests.set(plan.id, body.generationRequest);
      if (lostResponse("new", body, plan))
        return json(
          route,
          {
            status: 503,
            title: "Response lost",
            type: "about:blank",
            code: "SERVICE_UNAVAILABLE",
          },
          503,
        );
      return json(route, plan, 201);
    }
    return json(route, plans);
  }
  if (path.endsWith("/artifact-prd/versions/version-prd/relations"))
    return json(route, {
      version: prdRelation,
      sourcePrd: null,
      derivedPrototypes: [prototypeRelation],
      nextCursor: null,
    });
  if (path.endsWith("/source-prototype/versions/source-version-1/relations"))
    return json(route, {
      version: prototypeRelation,
      sourcePrd: prdRelation,
      derivedPrototypes: [],
      nextCursor: null,
    });
  if (path.includes("/prototype-v2/revisions/") && path.endsWith("/relations"))
    return json(route, {
      revisionId: misboundRelation ? "wrong-revision" : path.split("/").at(-2),
      sourceArtifact:
        variants && path.includes(`/${secondRevision.id}/`)
          ? {
              ...prototypeRelation,
              artifactVersionId: "source-version-2",
              version: 2,
              prototypeRevision: {
                id: secondRevision.id,
                planId: root.id,
                version: 2,
              },
            }
          : prototypeRelation,
      sourcePrd: prdRelation,
    });
  if (path.endsWith("/artifacts/artifact-prd")) return json(route, prdArtifact);
  if (path.endsWith("/artifact-prd/versions"))
    return json(route, {
      items: [{ ...prdVersion, contentMode: "inline" }],
      nextCursor: null,
    });
  if (path.endsWith("/artifact-prd/versions/version-prd"))
    return json(route, {
      ...prdVersion,
      citations: [],
      knowledgeReleaseId: null,
      contentMode: "inline",
      content: prdDocumentV3Example,
    });
  if (path.endsWith("/submission-intents") && method === "POST") {
    commands.push({
      kind: "document",
      path,
      body: route.request().postDataJSON(),
    });
    return json(
      route,
      { status: 409, title: "Fixture intentionally retains document draft" },
      409,
    );
  }
  if (path.endsWith(`/revisions/${secondRevision.id}/input`))
    return json(route, {
      ...input(secondPlan),
      modificationRequest: {
        ...requests.get(secondPlan.id),
        workflow: "edit",
        generationIntent: null,
        requestedArtifactKinds: ["prototype"],
        artifactTargets: [
          {
            artifactId: "source-prototype",
            artifactVersionId: "source-version-2",
            screenIds: [],
          },
        ],
      },
    });
  if (path.endsWith(`/revisions/${revisionId}/input`))
    return json(route, {
      ...input(root),
      modificationRequest: {
        ...requests.get(root.id),
        workflow: "edit",
        generationIntent: null,
        requestedArtifactKinds: ["prototype"],
        artifactTargets: [
          {
            artifactId: "source-prototype",
            artifactVersionId: "source-version-1",
            screenIds: [],
          },
        ],
      },
    });
  if (path.endsWith(`/revisions/${revisionId}/plans`) && method === "POST") {
    const body = route.request().postDataJSON();
    assert.equal(route.request().headers()["if-match"], '"1"');
    commands.push({ kind: "derive", path, body, key });
    const plan = {
      ...root,
      id:
        commands.filter((command) => command.kind === "derive").length === 1
          ? "derived-plan"
          : `derived-plan-${commands.length}`,
      rootPlanId: root.id,
      sourceRevisionId: revisionId,
      contentVersion: 2,
      status: "draft",
      revision: 0,
      title: body.title,
      prompt: body.prompt,
    };
    plans.push(plan);
    requests.set(plan.id, body.generationRequest);
    if (lostResponse("derive", body, plan))
      return json(
        route,
        {
          status: 503,
          title: "Response lost",
          type: "about:blank",
          code: "SERVICE_UNAVAILABLE",
        },
        503,
      );
    return json(route, plan, 201);
  }
  const match = path.match(/\/plans\/([^/]+)(?:\/(.*))?$/);
  if (match) {
    const plan = plans.find((p) => p.id === match[1]);
    if (!plan)
      return json(route, { status: 404, title: "Plan not found" }, 404);
    if (match[2] === "input" && method === "POST") {
      const body = route.request().postDataJSON();
      commands.push({
        kind: "update",
        key,
        path,
        body,
        etag: route.request().headers()["if-match"],
      });
      if (conflicts++ === 0) {
        plan.revision++;
        return json(
          route,
          {
            status: 412,
            title: "Concurrent adjustment",
            detail: "输入已更新，请核对最新记录",
          },
          412,
        );
      }
      assert.equal(route.request().headers()["if-match"], `"${plan.revision}"`);
      Object.assign(plan, {
        title: body.title,
        prompt: body.prompt,
        revision: plan.revision + 1,
      });
      requests.set(plan.id, body.generationRequest);
      if (lostResponse("update", body, plan))
        return json(
          route,
          {
            status: 503,
            title: "Response lost",
            type: "about:blank",
            code: "SERVICE_UNAVAILABLE",
          },
          503,
        );
      return json(route, plan);
    }
    if (match[2] === "input") return json(route, input(plan));
    if (match[2] === "progress")
      return json(route, {
        projectId,
        planId: plan.id,
        status: plan.status,
        input: {
          requestedArtifactKinds: requests.get(plan.id).requestedArtifactKinds,
          modelId: requests.get(plan.id).modelId,
          targetSurface: requests.get(plan.id).targetSurface,
          sourceIds: requests.get(plan.id).sourceIds,
          designStyle: null,
        },
        run: null,
        events: [],
        coverage: "window",
        finalRevisionId: plan.id === root.id ? revisionId : null,
      });
    if (match[2] === "revisions") {
      return json(
        route,
        plan.id === root.id
          ? [revision, secondRevision].map(
              ({ pages, previewHtml, ...summary }) => summary,
            )
          : [],
      );
    }
    if (!match[2]) return json(route, plan);
  }
  if (path.endsWith(`/revisions/${revisionId}`)) return json(route, revision);
  if (path.endsWith(`/revisions/${secondRevision.id}`))
    return json(route, secondRevision);
  if (path.endsWith("/feedback-locations"))
    return json(route, {
      sourceRevisionId: new URL(route.request().url()).searchParams.get(
        "sourceRevisionId",
      ),
      targetRevisionId: path.split("/").at(-2),
      items: [],
      nextCursor: null,
    });
  if (path.endsWith("/diff"))
    return json(route, {
      sourceRevisionId: null,
      pages: [{ pageId: "home", change: "added" }],
    });
  if (
    ["/feedback", "/prototype-v2/shares", "/prototype-v2/exports"].some((s) =>
      path.endsWith(s),
    )
  )
    return json(route, []);
  if (path.endsWith("/submission-intents/current"))
    return json(route, { item: null });
  results.unknown.push(`${method} ${path}`);
  return json(route, { status: 404, title: "Fixture route missing" }, 404);
});
const page = await context.newPage();
page.setDefaultTimeout(12000);
page.on("pageerror", (e) => results.errors.push(e.message));
try {
  if (variants) {
    const sourceUrl = `${origin}/studio/${projectId}?plan=${root.id}&revision=${revisionId}&page=detail`;
    const button = (name) => page.getByRole("button", { name, exact: true });
    const versions = () => button("版本").first().click();
    const prompt = page.getByRole("textbox", { name: "描述需求或修改" });
    const choice = page.getByText("从此版本生成变体", { exact: true });
    await page.goto(sourceUrl, { waitUntil: "networkidle", timeout: 60000 });
    await versions();
    await choice.click();
    const home = page.getByRole("checkbox", { name: "订单管理", exact: true });
    const detail = page.getByRole("checkbox", {
      name: "订单详情",
      exact: true,
    });
    assert.equal(await detail.isChecked(), true);
    for (let i = 1; i <= 11; i++) {
      await page
        .getByRole("checkbox", { name: `扩展页面 ${i}`, exact: true })
        .check();
    }
    const extra12 = page.getByRole("checkbox", {
      name: "扩展页面 12",
      exact: true,
    });
    assert.equal(await extra12.isDisabled(), true);
    const filter = page.getByLabel("筛选来源页面", { exact: true });
    await filter.fill("扩展页面 12");
    assert.equal(await extra12.isDisabled(), true);
    await filter.clear();
    for (let i = 1; i <= 11; i++) {
      await page
        .getByRole("checkbox", { name: `扩展页面 ${i}`, exact: true })
        .uncheck();
    }
    await detail.uncheck();
    assert.equal(await button("生成设计变体").isDisabled(), true);
    assert.equal(await button("生成交互变体").isDisabled(), true);
    await home.check();
    await detail.check();
    await button("生成设计变体").click();
    await page
      .getByText("设计变体：订单管理 · 原型修订 1 · 订单管理、订单详情", {
        exact: true,
      })
      .waitFor();
    await prompt.fill("设计变体保留订单列表和详情");
    await versions();
    await page.getByRole("button", { name: /^版本 2 ·/ }).click();
    await page.reload({ waitUntil: "networkidle" });
    assert.equal(
      new URL(page.url()).searchParams.get("revision"),
      secondRevision.id,
    );
    await page
      .getByText("设计变体：订单管理 · 原型修订 1 · 订单管理、订单详情", {
        exact: true,
      })
      .waitFor();
    assert.equal(await prompt.inputValue(), "设计变体保留订单列表和详情");
    await button("发送需求").click();
    const fixedSources = page.getByRole("region", { name: "固定变体来源" });
    await fixedSources
      .getByRole("link", { name: "页面 detail", exact: true })
      .waitFor();
    assert.match(
      await fixedSources
        .getByRole("link", { name: "页面 detail", exact: true })
        .getAttribute("href"),
      /revision=input-revision&page=detail/,
    );
    const design = startRunRequestSchema.parse(
      commands.at(-1).body.generationRequest,
    );
    assert.equal(commands.at(-1).kind, "new");
    assert.equal(design.workflow, "generate");
    assert.equal(design.generationIntent, "followup-design");
    assert.deepEqual(design.requestedArtifactKinds, ["prototype"]);
    assert.deepEqual(design.artifactTargets, [
      {
        artifactId: "source-prototype",
        artifactVersionId: "source-version-1",
        screenIds: ["home", "detail"],
      },
    ]);
    results.checks.push(
      "design variant uses selected pages of an older fixed version after browsing a newer one and reloading the composer",
    );
    await page.goto(sourceUrl, { waitUntil: "networkidle" });
    await versions();
    await choice.click();
    assert.equal(await detail.isChecked(), true);
    await button("生成交互变体").click();
    await page
      .getByText("交互变体：订单管理 · 原型修订 1 · 订单详情", { exact: true })
      .waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: new URL("mobile-variant-composer.png", output).pathname,
    });
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    await button("发送需求").click();
    await fixedSources
      .getByRole("link", { name: "页面 detail", exact: true })
      .waitFor();
    const interactive = startRunRequestSchema.parse(
      commands.at(-1).body.generationRequest,
    );
    assert.equal(interactive.generationIntent, "interactive-prototype");
    assert.deepEqual(interactive.artifactTargets, [
      {
        artifactId: "source-prototype",
        artifactVersionId: "source-version-1",
        screenIds: ["detail"],
      },
    ]);
    assert.equal(commands.length, 2);
    results.checks.push(
      "interactive variant submits independently with the active fixed source page in a reviewable plan on a phone",
    );
    misboundRelation = true;
    await page.goto(sourceUrl, { waitUntil: "networkidle" });
    await versions();
    await page.getByText("需求来源暂不可用。", { exact: true }).waitFor();
    assert.equal(await choice.count(), 0);
    misboundRelation = false;
    role = "viewer";
    await page.goto(sourceUrl, { waitUntil: "networkidle" });
    await versions();
    await page.getByText(/固定原型产物/).waitFor();
    assert.equal(await choice.count(), 0);
    results.checks.push(
      "mismatched source relation and viewer access both disable variant generation while preserving provenance",
    );
  } else if (recovery) {
    await page.goto(
      `${origin}/studio/${projectId}?plan=${root.id}&revision=${revisionId}&page=home`,
      { waitUntil: "networkidle" },
    );
    await page.getByRole("button", { name: "修改版本 1", exact: true }).click();
    await page
      .getByRole("button", { name: "移除引用 原始需求", exact: true })
      .waitFor();
    await page
      .getByRole("textbox", { name: "描述需求或修改" })
      .fill("保存一次固定版本修改");
    await page.getByRole("button", { name: "发送需求", exact: true }).click();
    await page.getByText("Response lost", { exact: true }).waitFor();
    await page.reload({ waitUntil: "networkidle" });
    await page
      .getByRole("textbox", { name: "描述需求或修改" })
      .fill("下一次尚未提交的内容");
    await page
      .getByRole("button", { name: "确认上次提交", exact: true })
      .click();
    await page
      .getByRole("button", { name: "调整完整输入", exact: true })
      .waitFor();
    assert.equal(
      await page.getByRole("textbox", { name: "描述需求或修改" }).inputValue(),
      "下一次尚未提交的内容",
    );
    assert.equal(plans.filter((p) => p.id === "derived-plan").length, 1);
    assert.equal(replayed[0].key, commands[0].key);
    results.checks.push(
      "accepted revision plan is recovered by its original command after refresh; current unsent text remains intact",
    );
    await page
      .getByRole("button", { name: "调整完整输入", exact: true })
      .click();
    await page
      .getByText(/调整计划：/)
      .last()
      .waitFor();
    await page
      .getByRole("textbox", { name: "描述需求或修改" })
      .fill("修改草稿并模拟响应丢失");
    await page.getByRole("button", { name: "发送需求", exact: true }).click();
    await page.getByText("Response lost", { exact: true }).waitFor();
    await page.reload({ waitUntil: "networkidle" });
    await page
      .getByRole("button", { name: "确认上次提交", exact: true })
      .click();
    await page
      .getByText("上次提交已确认，当前输入保持不变", { exact: true })
      .waitFor();
    assert.equal(replayed[1].key, commands[1].key);
    assert.equal(replayed[1].etag, commands[1].etag);
    assert.equal(plans.find((p) => p.id === "derived-plan").revision, 1);
    results.checks.push(
      "draft input recovery uses original CAS and key after server revision advances",
    );
    await page.getByRole("button", { name: "新建计划", exact: true }).click();
    await page
      .getByRole("textbox", { name: "描述需求或修改" })
      .fill("新建独立计划的恢复验证");
    await page.getByRole("button", { name: "发送需求", exact: true }).click();
    await page.getByText("Response lost", { exact: true }).waitFor();
    await page.reload({ waitUntil: "networkidle" });
    await page
      .getByRole("button", { name: "确认上次提交", exact: true })
      .click();
    await page
      .getByText("上次提交已确认，当前输入保持不变", { exact: true })
      .waitFor();
    assert.equal(replayed[2].key, commands[2].key);
    assert.equal(plans.filter((p) => p.id.startsWith("new-plan")).length, 1);
    assert.equal(
      await page
        .getByRole("button", { name: "确认上次提交", exact: true })
        .count(),
      0,
    );
    results.checks.push(
      "new plan recovery creates no duplicate and clears its completed local record",
    );
  } else {
    await page.goto(
      `${origin}/studio/${projectId}?plan=${root.id}&revision=${revisionId}&page=home`,
      { waitUntil: "networkidle" },
    );
    await page.getByRole("button", { name: "修改版本 1", exact: true }).click();
    await page
      .getByRole("button", { name: "移除引用 原始需求", exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("combobox", { name: "模型", exact: true })
        .inputValue(),
      splitModels ? "" : "model-a",
    );
    if (splitModels) {
      await page.getByText("所选模型不支持当前操作，请选择可用模型").waitFor();
      assert.equal(
        await page
          .getByRole("button", { name: "发送需求", exact: true })
          .isDisabled(),
        true,
      );
      assert.equal(
        await page
          .getByRole("combobox", { name: "模型", exact: true })
          .getByRole("option", { name: "model-b", exact: true })
          .count(),
        1,
      );
      assert.equal(
        await page
          .getByRole("combobox", { name: "模型", exact: true })
          .getByRole("option", { name: "model-a", exact: true })
          .count(),
        0,
      );
    }
    await page
      .getByRole("textbox", { name: "描述需求或修改" })
      .fill("增加审批流程，并调整设计");
    await page
      .getByRole("combobox", { name: "模型", exact: true })
      .selectOption("model-b");
    await page
      .getByRole("combobox", { name: "目标终端", exact: true })
      .selectOption("app");
    await page
      .getByRole("combobox", { name: "设计风格", exact: true })
      .selectOption("artifact:design-version");
    await page.getByRole("button", { name: /^资料\s*1$/ }).click();
    await page.getByRole("checkbox", { name: /新增参考/ }).check();
    await page.getByRole("button", { name: /^资料\s*2$/ }).click();
    if (splitModels) {
      await page.reload({ waitUntil: "networkidle" });
      await page.getByText(/源版本 1/).waitFor();
      assert.equal(
        await page
          .getByRole("combobox", { name: "模型", exact: true })
          .inputValue(),
        "model-b",
      );
      assert.equal(
        await page
          .getByRole("combobox", { name: "模型", exact: true })
          .getByRole("option", { name: "model-a", exact: true })
          .count(),
        0,
      );
      assert.equal(
        await page
          .getByRole("textbox", { name: "描述需求或修改" })
          .inputValue(),
        "增加审批流程，并调整设计",
      );
    }
    await page.getByRole("button", { name: "发送需求", exact: true }).click();
    await page
      .getByRole("button", { name: "调整完整输入", exact: true })
      .waitFor();
    assert.equal(commands.length, 1);
    assert.deepEqual(commands[0].body.generationRequest.sourceIds, [
      "source-1",
      "source-2",
    ]);
    assert.equal(commands[0].body.generationRequest.modelId, "model-b");
    assert.equal(commands[0].body.generationRequest.workflow, "edit");
    assert.deepEqual(commands[0].body.generationRequest.artifactTargets, [
      {
        artifactId: "source-prototype",
        artifactVersionId: "source-version-1",
        screenIds: [],
      },
    ]);
    assert.equal(requests.get(root.id).workflow, "generate");
    assert.equal(requests.get(root.id).modelId, "model-a");
    if (splitModels)
      results.checks.push(
        "initial revision and restored revision offer only edit-capable models; unsupported historical model remains explicit, and submitted edit request leaves historical generate input unchanged",
      );
    assert.equal(commands[0].body.generationRequest.targetSurface, "app");
    assert.deepEqual(commands[0].body.generationRequest.designStyle, {
      kind: "artifact",
      artifactVersionId: "design-version",
    });
    results.checks.push(
      "new sources, model, target and design become a reviewable plan bound to the exact source revision",
    );
    await page
      .getByRole("button", { name: "调整完整输入", exact: true })
      .click();
    assert.equal(
      await page
        .getByRole("combobox", { name: "模型", exact: true })
        .inputValue(),
      "model-b",
    );
    assert.equal(
      await page
        .getByRole("combobox", { name: "设计风格", exact: true })
        .inputValue(),
      "artifact:design-version",
    );
    await page
      .getByRole("textbox", { name: "描述需求或修改" })
      .fill("保留全部绑定，补充操作权限");
    await page.getByRole("button", { name: "发送需求", exact: true }).click();
    await page
      .getByText(/Concurrent adjustment|输入已更新/)
      .first()
      .waitFor();
    assert.equal(
      await page.getByRole("textbox", { name: "描述需求或修改" }).inputValue(),
      "保留全部绑定，补充操作权限",
    );
    results.checks.push("CAS conflict preserves the full edit and prompt");
    await page
      .getByRole("button", { name: "保留我的调整并继续", exact: true })
      .click();
    assert.equal(
      await page.getByRole("textbox", { name: "描述需求或修改" }).inputValue(),
      "保留全部绑定，补充操作权限",
    );
    assert.equal(
      await page
        .getByRole("combobox", { name: "设计风格", exact: true })
        .inputValue(),
      "artifact:design-version",
    );
    await page.getByRole("button", { name: "发送需求", exact: true }).click();
    await page
      .getByRole("button", { name: "调整完整输入", exact: true })
      .waitFor();
    assert.equal(commands.length, 3);
    assert.deepEqual(commands[2].body.generationRequest.sourceIds, [
      "source-1",
      "source-2",
    ]);
    assert.equal(commands[2].etag, '"1"');
    assert.equal(
      requests.get("derived-plan").prompt,
      "保留全部绑定，补充操作权限",
    );
    results.checks.push(
      "explicit conflict recovery adjusts the same draft and retains every binding",
    );
    // A draft target remains explicit while browsing other versions and plans.
    await page
      .getByRole("button", { name: "调整完整输入", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "描述需求或修改" })
      .fill("修改草稿后浏览版本二");
    await page.getByRole("button", { name: "计划", exact: true }).click();
    await page
      .getByRole("combobox", { name: "选择原型计划", exact: true })
      .selectOption(root.id);
    assert.equal(
      await page.getByRole("textbox", { name: "描述需求或修改" }).inputValue(),
      "修改草稿后浏览版本二",
    );
    await page
      .getByRole("button", { name: "版本", exact: true })
      .first()
      .click();
    await page.getByRole("button", { name: /^版本 2 ·/ }).click();
    assert.equal(
      await page
        .getByRole("button", { name: "新建计划", exact: true })
        .getAttribute("aria-pressed"),
      "false",
    );
    await page
      .getByText(/调整计划：/)
      .last()
      .waitFor();
    await page.getByRole("button", { name: "发送需求", exact: true }).click();
    await page
      .getByRole("button", { name: "调整完整输入", exact: true })
      .waitFor();
    assert.equal(commands.at(-1).kind, "update");
    assert.ok(commands.at(-1).path.endsWith("/plans/derived-plan/input"));
    assert.equal(commands.at(-1).body.prompt, "修改草稿后浏览版本二");
    results.checks.push(
      "browsing version two while adjusting a draft retains a visibly identified draft target and sends its input endpoint",
    );

    await page
      .getByRole("button", { name: "版本", exact: true })
      .first()
      .click();
    await page.getByRole("button", { name: /^版本 1 ·/ }).click();
    await page.getByRole("button", { name: "修改版本 1", exact: true }).click();
    await page
      .getByRole("textbox", { name: "描述需求或修改" })
      .fill("修改版本一，浏览版本二");
    await page.getByText(/源版本 1/).waitFor();
    if (splitModels)
      await page
        .getByRole("combobox", { name: "模型", exact: true })
        .selectOption("model-b");
    await page
      .getByRole("button", { name: "版本", exact: true })
      .first()
      .click();
    await page.getByRole("button", { name: /^版本 2 ·/ }).click();
    await page.getByText(/源版本 1 · 仍绑定原来源/).waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "新建计划", exact: true })
        .getAttribute("aria-pressed"),
      "false",
    );
    assert.equal(
      new URL(page.url()).searchParams.get("revision"),
      secondRevision.id,
    );
    await page.screenshot({
      path: new URL("source-context.png", output).pathname,
    });
    await page.getByRole("button", { name: "发送需求", exact: true }).click();
    await page
      .getByRole("button", { name: "调整完整输入", exact: true })
      .waitFor();
    assert.equal(commands.at(-1).kind, "derive");
    assert.ok(commands.at(-1).path.endsWith(`/revisions/${revisionId}/plans`));
    results.checks.push(
      "browsing version two keeps source version one visibly fixed and the actual revision-plan request agrees",
    );

    // Explicit new/document actions suspend the previous input, including files.
    await page
      .getByRole("button", { name: "调整完整输入", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "描述需求或修改" })
      .fill("等待恢复的原型草稿");
    await page
      .getByRole("combobox", { name: "模型", exact: true })
      .selectOption("model-b");
    await page.locator('input[type="file"]').setInputFiles({
      name: "待恢复.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("attachment survives reload"),
    });
    await page.getByRole("button", { name: "新建计划", exact: true }).click();
    assert.equal(
      await page
        .getByRole("button", { name: "新建计划", exact: true })
        .getAttribute("aria-pressed"),
      "true",
    );
    await page
      .getByRole("textbox", { name: "描述需求或修改" })
      .fill("明确新建独立计划");
    await page.getByRole("button", { name: "发送需求", exact: true }).click();
    await page
      .getByRole("button", { name: "调整完整输入", exact: true })
      .waitFor();
    assert.equal(commands.at(-1).kind, "new");
    assert.ok(commands.at(-1).path.endsWith("/prototype-v2/plans"));
    await page.getByRole("button", { name: /^恢复输入：调整计划/ }).click();
    assert.equal(
      await page.getByRole("textbox", { name: "描述需求或修改" }).inputValue(),
      "等待恢复的原型草稿",
    );
    await page
      .getByRole("button", { name: "移除 待恢复.txt", exact: true })
      .waitFor();
    await page.reload({ waitUntil: "networkidle" });
    await page
      .getByRole("button", { name: "移除待恢复附件 待恢复.txt", exact: true })
      .waitFor();
    assert.equal(
      await page.getByRole("textbox", { name: "描述需求或修改" }).inputValue(),
      "等待恢复的原型草稿",
    );
    assert.equal(
      await page
        .getByRole("combobox", { name: "模型", exact: true })
        .inputValue(),
      "model-b",
    );
    assert.equal(
      await page
        .getByRole("button", { name: "发送需求", exact: true })
        .isDisabled(),
      true,
    );
    const storedFile = await page.evaluate(
      async () =>
        new Promise((resolve, reject) => {
          const r = indexedDB.open("workbench-studio-composer", 1);
          r.onsuccess = () => {
            const db = r.result,
              q = db
                .transaction("sessions")
                .objectStore("sessions")
                .get("principal-1:input-project");
            q.onsuccess = () => {
              const draft = q.result.entries[q.result.activeKey].draft;
              resolve({
                files: draft.files,
                missingFiles: draft.missingFiles.map(
                  ({ name, size, type }) => ({
                    name,
                    size,
                    type,
                  }),
                ),
              });
              db.close();
            };
            q.onerror = () => reject(q.error);
          };
          r.onerror = () => reject(r.error);
        }),
    );
    assert.deepEqual(storedFile, {
      files: [],
      missingFiles: [
        {
          name: "待恢复.txt",
          size: Buffer.byteLength("attachment survives reload"),
          type: "text/plain",
        },
      ],
    });
    await page.locator('input[type="file"]').setInputFiles({
      name: "待恢复.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("attachment survives reload"),
    });
    await page
      .getByRole("button", { name: "移除 待恢复.txt", exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "发送需求", exact: true })
        .isDisabled(),
      false,
    );
    results.checks.push(
      "explicit new-plan action sends its own endpoint; suspended draft and exact model recover; unuploaded files persist metadata only and block sending until explicitly reselected",
    );

    await page.getByRole("button", { name: "文档", exact: true }).click();
    await page
      .getByRole("button", { name: "继续完善此版本", exact: true })
      .click();
    await page.getByText("基于固定产物：订单需求 · 版本 1").waitFor();
    assert.equal(
      await page.getByRole("textbox", { name: "描述需求或修改" }).inputValue(),
      "完善《订单需求》：",
    );
    assert.equal(
      await page
        .getByRole("button", { name: "移除 待恢复.txt", exact: true })
        .count(),
      0,
    );
    await page.goBack({ waitUntil: "networkidle" });
    await page.getByText("基于固定产物：订单需求 · 版本 1").waitFor();
    await page.getByRole("button", { name: "发送需求", exact: true }).click();
    await page
      .getByText("Fixture intentionally retains document draft")
      .waitFor();
    assert.equal(commands.at(-1).kind, "document");
    assert.equal(commands.at(-1).body.request.workflow, "edit");
    assert.deepEqual(commands.at(-1).body.request.artifactTargets, [
      {
        artifactId: "artifact-prd",
        artifactVersionId: "version-prd",
        screenIds: [],
      },
    ]);
    await page.getByRole("button", { name: /^恢复输入：调整计划/ }).click();
    assert.equal(
      await page.getByRole("textbox", { name: "描述需求或修改" }).inputValue(),
      "等待恢复的原型草稿",
    );
    await page
      .getByRole("button", { name: "移除 待恢复.txt", exact: true })
      .waitFor();
    results.checks.push(
      "document action and browser back keep the visible fixed document target; actual submission-intent request targets that exact artifact, while the original prototype draft is recoverable",
    );
    await page.goto(
      `${origin}/studio/${projectId}?view=documents&artifact=artifact-prd&artifactVersion=version-prd`,
      { waitUntil: "networkidle" },
    );
    await page
      .getByRole("textbox", { name: "PRD 生成页面范围" })
      .fill("订单列表");
    await page
      .getByRole("button", { name: "基于此 PRD 生成界面", exact: true })
      .click();
    await page.getByRole("button", { name: "发送需求", exact: true }).click();
    await page.getByText("固定页面范围：订单列表", { exact: true }).waitFor();
    assert.equal(commands.at(-1).kind, "new");
    assert.equal(
      commands.at(-1).body.generationRequest.generationIntent,
      "prd-prototype",
    );
    assert.deepEqual(commands.at(-1).body.generationRequest.prdScreenPlan, [
      { id: "screen-1", title: "订单列表" },
    ]);
    assert.deepEqual(commands.at(-1).body.generationRequest.artifactTargets, [
      {
        artifactId: "artifact-prd",
        artifactVersionId: "version-prd",
        screenIds: [],
      },
    ]);
    await page.getByRole("button", { name: "文档", exact: true }).click();
    await page
      .getByRole("textbox", { name: "PRD 生成页面范围" })
      .fill("订单列表\n订单详情\n提交结果");
    await page
      .getByRole("button", { name: "生成多屏流程", exact: true })
      .click();
    const flowPrompt = await page
      .getByRole("textbox", { name: "描述需求或修改" })
      .inputValue();
    await page.reload({ waitUntil: "networkidle" });
    assert.equal(
      await page.getByRole("textbox", { name: "描述需求或修改" }).inputValue(),
      flowPrompt,
    );
    await page.getByRole("button", { name: "发送需求", exact: true }).click();
    await page
      .getByText("固定页面范围：订单列表 → 订单详情 → 提交结果", {
        exact: true,
      })
      .waitFor();
    const flow = commands.at(-1).body.generationRequest;
    assert.equal(flow.workflow, "generate");
    assert.equal(flow.generationIntent, "prd-flow");
    assert.equal(flow.prdScreenPlan.length, 3);
    assert.deepEqual(flow.requestedArtifactKinds, ["prototype"]);
    assert.equal(flow.artifactTargets[0].artifactVersionId, "version-prd");
    results.checks.push(
      "PRD single-screen and multi-screen actions preserve the exact document version, distinct operation contexts and explicit screen plans across refresh before creating reviewable plans",
    );
    await page.getByRole("button", { name: "文档", exact: true }).click();
    await page.getByRole("link", { name: /关联订单原型 · 版本 1/ }).click();
    await page
      .getByRole("button", { name: "版本", exact: true })
      .first()
      .click();
    await page
      .getByRole("link", { name: "订单需求 · 版本 1", exact: true })
      .click();
    await page.getByRole("combobox", { name: "文档版本" }).waitFor();
    assert.equal(
      new URL(page.url()).searchParams.get("artifactVersion"),
      "version-prd",
    );
    assert.equal(
      await page.getByRole("combobox", { name: "文档版本" }).inputValue(),
      "version-prd",
    );
    results.checks.push(
      "persisted document-to-prototype and frozen revision-to-PRD links return the exact document version and survive direct navigation",
    );
  }
  await page.screenshot({ path: new URL("fixed-input.png", output).pathname });
  assert.deepEqual(results.errors, []);
  assert.deepEqual(results.unknown, []);
  results.status = "passed";
} catch (error) {
  results.status = "failed";
  results.failure = error.stack;
  results.url = page.url();
  results.body = (await page.locator("body").innerText()).slice(0, 5000);
  await page.screenshot({ path: new URL("failure.png", output).pathname });
  process.exitCode = 1;
} finally {
  results.commands = commands;
  results.replayed = replayed;
  await writeFile(
    new URL("results.json", output),
    JSON.stringify(results, null, 2),
  );
  console.log(JSON.stringify(results, null, 2));
  await browser.close();
}
