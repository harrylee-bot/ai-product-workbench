// Mounted Studio requirement workflow against fixed-contract API fixtures. No model calls.
const { chromium, webkit } = await import(process.env.WORKBENCH_E2E_PLAYWRIGHT_MODULE ?? "playwright");
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { prdDocumentV3Example } from "@workbench/workbench-contracts/test-fixtures";
import {
  runSchema,
  requirementSessionSchema,
  requirementCardSchema,
  startRunRequestSchema,
} from "@workbench/workbench-contracts";
const variants = process.env.WORKBENCH_E2E_PROTOTYPE_VARIANTS === "1";
const recovery = process.env.WORKBENCH_E2E_SUBMISSION_RECOVERY === "1";
const splitModels = process.env.WORKBENCH_E2E_SPLIT_MODEL_CAPABILITIES === "1";
const origin = process.env.WORKBENCH_E2E_WEB_ORIGIN ?? "http://127.0.0.1:18930";
const output = new URL(
  process.env.WORKBENCH_E2E_STUDIO_OUTPUT ??
    "../../output/audit/1.0.0/studio-rebuild-only-workflow/",
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
plans.splice(1);
let sessions = [],
  entries = [],
  confirmCalls = [],
  messages = [],
  createCalls = [];
let loseConfirmation = false,
  pendingDispatch = false;
const dispatchCalls = [];
const directoryCursors = [];
const commandReceipts = new Map();
const run = {
  id: "confirmed-prd-run",
  requestId: "confirmed-request",
  projectId,
  threadId: thread.id,
  retryOfRunId: null,
  status: "succeeded",
  modelId: "model-b",
  workflow: "generate",
  generationIntent: null,
  targetSurface: "web",
  designStyle: { kind: "automatic" },
  artifactTargets: [],
  requestedArtifactKinds: ["prd"],
  sources: [],
  knowledgeReleaseId: "knowledge-fixed",
  phase: "publishing",
  phaseLabel: "完成",
  progress: 1,
  attempt: 1,
  lastEventSequence: 0,
  cancelRequestedAt: null,
  failure: null,
  cancellationReason: null,
  createdAt: now,
  startedAt: now,
  finishedAt: now,
};
runSchema.parse(run);
const cardFor = (request) =>
  requirementCardSchema.parse({
    goal: "增加订单领取次数限制",
    platform: "活动平台",
    modules: ["规则配置"],
    roles: ["策划人员"],
    existingCapabilities: [
      {
        description: "沿用现有订单入口",
        evidenceIds: ["evidence-one"],
        scope: "template",
      },
    ],
    reuse: ["沿用登录和原导航"],
    changes: ["现有规则区增加领取次数字段"],
    affectedPages: ["订单规则页"],
    affectedFlows: ["配置次数 → 领取校验"],
    targetSurface: request.targetSurface,
    designConstraints: ["沿用项目设计"],
    outputKinds: request.requestedArtifactKinds,
    assumptions: [
      { id: "assumption-one", text: "默认使用原有字段布局", evidenceIds: [] },
    ],
    issues: [],
    platformChanges: [],
    preserved: ["登录和支付流程"],
  });
const evidence = [
  {
    id: "evidence-one",
    releaseId: "knowledge-fixed",
    releaseVersion: 1,
    documentId: "document-one",
    chunkId: "chunk-one",
    sourcePath: "产品架构/能力地图",
    title: "模板能力",
    quote: "当前模板支持规则配置。",
    scope: "template",
    checksum: "a".repeat(64),
  },
];
const addEntry = (text, assistant = false) =>
  entries.push({
    id: `entry-${entries.length + 1}`,
    threadId: thread.id,
    sequence: entries.length + 1,
    role: assistant ? "assistant" : "user",
    kind: "message",
    content: {
      protocol: "workbench.entry.v1",
      type: assistant ? "assistant.message" : "user.prompt",
      text,
      ...(assistant ? {} : { sourceIds: [] }),
    },
    producedByRunId: null,
    createdAt: now,
  });
const results = {
  evidence:
    "Actual mounted Studio with fixed-contract API fixtures; no backend/model acceptance",
  checks: [],
  unknown: [],
  errors: [],
  revisionReads: [],
};
const engine = process.env.WORKBENCH_E2E_BROWSER ?? "chromium";
assert.ok(["chromium", "webkit"].includes(engine));
const browser = await (engine === "webkit" ? webkit : chromium).launch({
  headless: true,
  executablePath: engine === "webkit" ? process.env.PLAYWRIGHT_WEBKIT_EXECUTABLE : process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
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
  if (path.includes("requirement-sessions")) {
    if (method === "POST" && commandReceipts.has(key)) {
      const original = commandReceipts.get(key);
      assert.deepEqual(route.request().postDataJSON(), original.body);
      assert.equal(route.request().headers()["if-match"], original.etag);
      return json(route, original.value, original.status);
    }
    if (path === `/api/v1/threads/${thread.id}/requirement-sessions`) {
      if (method === "GET") {
        const query = new URL(route.request().url()).searchParams;
        const offset = Number(query.get("cursor") ?? 0);
        const limit = Number(query.get("limit") ?? 30);
        directoryCursors.push(query.get("cursor"));
        return json(route, {
          items: sessions.slice(offset, offset + limit),
          nextCursor:
            offset + limit < sessions.length ? String(offset + limit) : null,
        });
      }
      const body = route.request().postDataJSON();
      assert(["new", "revision"].includes(body.context.kind));
      createCalls.push(body);
      const value = requirementSessionSchema.parse({
        id: `requirement-${createCalls.length}`,
        projectId,
        threadId: thread.id,
        revision: 1,
        state: "discussing",
        context: body.context,
        generationRequest: body.generationRequest,
        summaryVersion: 0,
        summaryChecksum: null,
        card: null,
        evidence: [],
        activeTurn: null,
        confirmation: null,
        createdAt: now,
        updatedAt: now,
      });
      sessions.unshift(value);
      return json(route, value, 201);
    }
    const id = path.split("/requirement-sessions/")[1]?.split("/")[0];
    const value = sessions.find((item) => item.id === id);
    assert(value, `Unknown requirement ${path}`);
    if (method === "GET") return json(route, value);
    assert.equal(route.request().headers()["if-match"], `"${value.revision}"`);
    const body = route.request().postDataJSON();
    if (path.endsWith("/messages")) {
      messages.push(body);
      addEntry(body.text);
      value.revision++;
      value.generationRequest = body.generationRequest;
      value.confirmation = null;
      if (body.text.includes("先了解")) {
        value.card = null;
        value.state = "needs_clarification";
        addEntry("想了解现有平台的哪个模块？", true);
      } else {
        value.card = cardFor(body.generationRequest);
        value.state = "ready_to_confirm";
        value.summaryVersion++;
        value.summaryChecksum = "a".repeat(64);
        value.evidence = evidence;
        addEntry("已整理为现有平台上的增量改动，请核对摘要。", true);
      }
      return json(route, requirementSessionSchema.parse(value), 202);
    }
    if (path.includes("/confirmations/") && path.endsWith("/retry")) {
      assert.equal(body, null);
      const confirmationId = path.split("/confirmations/")[1].split("/")[0];
      assert.equal(confirmationId, value.confirmation.id);
      dispatchCalls.push({
        confirmationId,
        key,
        etag: route.request().headers()["if-match"],
      });
      value.revision++;
      value.state = "generating";
      value.confirmation = {
        ...value.confirmation,
        status: "started",
        failureCode: null,
        planId: root.id,
        runId: null,
      };
      return json(route, requirementSessionSchema.parse(value), 202);
    }
    if (path.endsWith("/confirm")) {
      confirmCalls.push({
        body,
        key,
        etag: route.request().headers()["if-match"],
      });
      assert.equal(body.summaryVersion, value.summaryVersion);
      assert.equal(body.summaryChecksum, value.summaryChecksum);
      assert.deepEqual(body.acceptedAssumptionIds, ["assumption-one"]);
      value.revision++;
      value.state = "generating";
      value.confirmation = {
        id: `confirmation-${confirmCalls.length}`,
        summaryVersion: value.summaryVersion,
        summaryChecksum: value.summaryChecksum,
        status: "started",
        failureCode: null,
        acceptedAssumptionIds: body.acceptedAssumptionIds,
        acceptedPlatformChanges: body.acceptedPlatformChanges,
        confirmedAt: now,
        planId: value.generationRequest.requestedArtifactKinds.includes(
          "prototype",
        )
          ? root.id
          : null,
        runId: value.generationRequest.requestedArtifactKinds.includes(
          "prototype",
        )
          ? null
          : run.id,
      };
      if (pendingDispatch) {
        pendingDispatch = false;
        value.state = "confirmed";
        value.confirmation = {
          ...value.confirmation,
          status: "pending",
          failureCode: "DISPATCH_UNAVAILABLE",
          planId: null,
          runId: null,
        };
      }
      const receipt = requirementSessionSchema.parse(value);
      commandReceipts.set(key, {
        body: structuredClone(body),
        etag: route.request().headers()["if-match"],
        value: receipt,
        status: 202,
      });
      if (loseConfirmation) {
        loseConfirmation = false;
        return json(
          route,
          {
            type: "about:blank",
            status: 503,
            title: "Reply lost",
            code: "SERVICE_UNAVAILABLE",
          },
          503,
        );
      }
      return json(route, receipt, 202);
    }
  }
  if (path === `/api/v1/threads/${thread.id}/entries`) {
    const after = Number(
      new URL(route.request().url()).searchParams.get("afterSequence") ?? 0,
    );
    return json(route, {
      items: entries.filter((entry) => entry.sequence > after),
      nextAfterSequence: null,
    });
  }
  if (path === `/api/v1/runs/${run.id}/approvals`)
    return json(route, { items: [] });
  if (path === `/api/v1/runs/${run.id}`) return json(route, run);
  if (path === `/api/v1/runs/${run.id}/outputs`)
    return json(route, {
      projectId,
      runId: run.id,
      status: run.status,
      coverage: "complete",
      items: [{ kind: "prd", state: "ready", version: prdRelation }],
    });
  if (path === `/api/v1/threads/${thread.id}/runs`)
    return json(route, { items: [], nextCursor: null });
  if (method === "POST") {
    results.unknown.push(`Forbidden bypass: ${path}`);
    return json(
      route,
      {
        type: "about:blank",
        status: 409,
        title: "Must confirm requirements",
        code: "REQUIREMENT_CONFIRMATION_REQUIRED",
      },
      409,
    );
  }

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
      entries,
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
  const match = path.match(/\/plans\/([^/]+)(?:\/(.*))?$/);
  if (match) {
    const plan = plans.find((p) => p.id === match[1]);
    if (!plan)
      return json(route, { status: 404, title: "Plan not found" }, 404);
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
  if (path.endsWith(`/revisions/${revisionId}`)) {
    results.revisionReads.push(revisionId);
    return json(route, revision);
  }
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
const prompt = page.getByRole("textbox", { name: "描述需求或修改" });
const button = (name) => page.getByRole("button", { name, exact: true });
try {
  for (const outputKind of ["both", "prd", "prototype"]) {
    sessions = [];
    entries = [];
    await page.goto(
      `${origin}/studio/${projectId}?plan=${root.id}&revision=${revisionId}`,
    );
    await page.evaluate(async () => {
      sessionStorage.clear();
      await new Promise((resolve) => {
        const request = indexedDB.deleteDatabase(
          "workbench-studio-composer-v1",
        );
        request.onsuccess = resolve;
        request.onerror = resolve;
        request.onblocked = resolve;
      });
    });
    await page.reload();
    await prompt.waitFor();
    await page.evaluate(() =>
      sessionStorage.setItem(
        "workbench:studio:principal-1:input-project:submission",
        JSON.stringify({
          version: 1,
          key: "legacy-key",
          request: { title: "旧直接提交" },
          target: { kind: "draft", id: "old-plan" },
        }),
      ),
    );
    await page
      .getByRole("combobox", { name: "模型", exact: true })
      .selectOption("model-b");
    await page
      .getByRole("combobox", { name: "输出类型", exact: true })
      .selectOption(outputKind);
    if (outputKind === "both") {
      await prompt.fill("先了解平台已有能力");
      await prompt.press("Enter");
      await page
        .getByText("想了解现有平台的哪个模块？", { exact: true })
        .waitFor();
      assert.equal(confirmCalls.length, 0);
      assert.equal(await button("确认需求并生成").count(), 0);
    }
    await prompt.fill(
      "在现有活动订单规则区增加每人领取次数限制，沿用登录和支付流程",
    );
    await prompt.press("Enter");
    const confirm = button("确认需求并生成");
    await confirm.waitFor();
    await page.waitForFunction(
      () =>
        document.querySelector(".studio-requirement-confirm")?.disabled ===
        false,
    );
    assert.equal(createCalls.at(-1).generationRequest.modelId, "model-b");
    assert.deepEqual(
      messages.at(-1).generationRequest.requestedArtifactKinds,
      outputKind === "both" ? ["prd", "prototype"] : [outputKind],
    );
    const before = confirmCalls.length;
    assert.equal(commands.length, 0);
    await prompt.fill("新输入还没有发送");
    assert.equal(await confirm.isDisabled(), true);
    await prompt.fill("");
    await page.waitForFunction(async () => {
      const db = await new Promise((resolve) => {
        const request = indexedDB.open("workbench-studio-composer-v1", 1);
        request.onsuccess = () => resolve(request.result);
      });
      const saved = await new Promise((resolve) => {
        const request = db
          .transaction("sessions")
          .objectStore("sessions")
          .get("principal-1:input-project");
        request.onsuccess = () => resolve(request.result);
      });
      db.close();
      return saved?.entries?.[saved.activeKey]?.draft.prompt === "";
    });
    await page.reload();
    await confirm.waitFor();
    await page.waitForFunction(
      () =>
        document.querySelector(".studio-requirement-confirm")?.disabled ===
        false,
    );
    if (outputKind === "both") loseConfirmation = true;
    if (outputKind === "prototype") pendingDispatch = true;
    await confirm.click();
    if (outputKind === "both") {
      const recover = button("恢复确认结果");
      await recover.waitFor();
      await recover.click();
    }
    if (outputKind === "prototype") {
      await button("重试已确认任务").waitFor();
      const confirmationId = sessions[0].confirmation.id;
      await page.evaluate(() => sessionStorage.clear());
      await page.reload();
      await button("重试已确认任务").click();
      await page.getByRole("complementary", { name: "本次生成基线" }).waitFor();
      assert.equal(dispatchCalls.at(-1).confirmationId, confirmationId);
      assert.notEqual(dispatchCalls.at(-1).key, confirmCalls.at(-1).key);
    }
    await page.getByRole("complementary", { name: "本次生成基线" }).waitFor();
    await page.waitForURL((url) =>
      outputKind === "prd"
        ? url.searchParams.get("run") === run.id
        : url.searchParams.get("plan") === root.id,
    );
    assert.equal(confirmCalls.length, before + 1);
    assert.equal(await button("审批并开始生成").count(), 0);
    assert.equal(await button("讨论并确认需求").count(), 0);
    assert.equal(await button("确认上次提交").count(), 0);
    await prompt.fill("下一版补充展示说明");
    await prompt.press("Enter");
    await page.waitForFunction(
      () => document.querySelector("textarea")?.value === "",
    );
    assert.equal(confirmCalls.length, before + 1);
    results.checks.push(
      `${outputKind}: send only discusses; supported model retained; unsent input blocks confirmation; reload restores fixed card; one confirmation opens existing output route; follow-up does not create another generation`,
    );
    await page.screenshot({
      path: new URL(`mounted-${outputKind}.png`, output).pathname,
    });
    await page.evaluate(() => {
      window.dispatchEvent(new Event("workbench:logout"));
    });
  }
  // Fixed revision source stays attached even though the ordinary composer has
  // the same requirement workflow. No legacy revise/plan API is authorized.
  sessions = [];
  entries = [];
  await page.goto(
    `${origin}/studio/${projectId}?plan=${root.id}&revision=${revisionId}`,
  );
  await prompt.waitFor();
  await button("修改版本 1").click();
  await page
    .locator(".visual-intent")
    .getByText(/^源版本 1/)
    .waitFor();
  await prompt.fill("仅调整该版本领取按钮的文案，保持其他页面不变");
  const revisionOutput = page.getByRole("combobox", {
    name: "输出类型",
    exact: true,
  });
  await revisionOutput.selectOption("both");
  await button("发送需求").click();
  await page.waitForFunction(
    () => document.querySelector("textarea")?.value === "",
  );
  assert.equal(createCalls.at(-1).context.kind, "revision");
  assert.equal(createCalls.at(-1).context.revisionId, revisionId);
  assert.deepEqual(createCalls.at(-1).generationRequest.artifactTargets, [
    {
      artifactId: "source-prototype",
      artifactVersionId: "source-version-1",
      screenIds: [],
    },
  ]);
  assert.equal(createCalls.at(-1).generationRequest.workflow, "edit");
  assert.deepEqual(messages.at(-1).generationRequest.requestedArtifactKinds, [
    "prd",
    "prototype",
  ]);
  results.checks.push(
    "Revision discussion retains exact revision, fixed artifact version and edit workflow; no legacy plan/revise bypass",
  );
  await page.setViewportSize({ width: 390, height: 780 });
  await page.screenshot({
    path: new URL("mounted-mobile.png", output).pathname,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() =>
    window.dispatchEvent(new Event("workbench:logout")),
  );
  const saved = {
    ...structuredClone(sessions[0]),
    id: "saved-discussion",
    context: { kind: "new" },
    state: "ready_to_confirm",
    confirmation: null,
    card: cardFor(requests.get(root.id)),
    generationRequest: structuredClone(requests.get(root.id)),
  };
  sessions = [
    ...Array.from({ length: 100 }, (_, i) => ({
      ...saved,
      id: `other-source-${i}`,
      context: {
        kind: "revision",
        revisionId: `unrelated-revision-${i}`,
        feedbackIds: [],
        anchor: null,
      },
    })),
    saved,
    {
      ...saved,
      id: "older-discussion",
      card: { ...saved.card, goal: "更早的范围讨论" },
      updatedAt: "2026-11-14T00:00:00Z",
    },
  ];
  const createCount = createCalls.length;
  await page.goto(
    `${origin}/studio/${projectId}?plan=${root.id}&revision=${revisionId}`,
  );
  await prompt.waitFor();
  await button("新建计划").click();
  const directory = page.getByRole("combobox", {
    name: "需求讨论",
    exact: true,
  });
  await directory.waitFor();
  assert(directoryCursors.includes("100"));
  assert.equal(await directory.inputValue(), "saved-discussion");
  await directory.selectOption("older-discussion");
  await page.getByText("更早的范围讨论", { exact: true }).waitFor();
  assert.equal(createCalls.length, createCount);
  results.checks.push(
    "Directory restores a matching discussion beyond 100 unrelated source sessions and switches among loaded matching discussions without creating a duplicate",
  );
  assert.deepEqual(results.unknown, []);
  assert.deepEqual(results.errors, []);
  results.status = "passed";
} catch (error) {
  results.status = "failed";
  results.errors.push(error.stack ?? String(error));
  await page.screenshot({ path: new URL("failure.png", output).pathname });
  process.exitCode = 1;
} finally {
  await browser.close();
  await writeFile(
    new URL("results.json", output),
    JSON.stringify(
      {
        ...results,
        createCalls,
        messages,
        confirmCalls,
        dispatchCalls,
        modelCalls: 0,
      },
      null,
      2,
    ),
  );
}
console.log(JSON.stringify(results, null, 2));
