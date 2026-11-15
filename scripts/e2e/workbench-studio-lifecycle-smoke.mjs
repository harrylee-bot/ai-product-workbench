// Browser integration fixture: native, continuously open HTTP SSE, no model calls.
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { prdDocumentV3Example } from "@workbench/workbench-contracts/test-fixtures";
const origin = process.env.WORKBENCH_E2E_WEB_ORIGIN ?? "http://127.0.0.1:18930";
const output = new URL(
  "../../output/audit/1.0.0/studio-lifecycle/",
  import.meta.url,
);
await mkdir(output, { recursive: true });
const now = "2026-11-15T00:00:00.000Z",
  projectId = "lifecycle-project",
  threadId = "lifecycle-thread",
  planId = "lifecycle-plan";
const project = {
  id: projectId,
  workspaceId: "workspace-1",
  title: "生命周期验证",
  summary: null,
  status: "active",
  revision: 1,
  createdAt: now,
  updatedAt: now,
};
const thread = {
  id: threadId,
  projectId,
  title: "需求",
  status: "active",
  revision: 1,
  createdAt: now,
  updatedAt: now,
};
const board = {
  id: "board-1",
  projectId,
  revision: 1,
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [],
  edges: [],
};
const plan = {
  id: planId,
  projectId,
  rootPlanId: null,
  sourceRevisionId: null,
  contentVersion: 1,
  status: "generating",
  prompt: "生成项目原型",
  title: "项目原型",
  revision: 1,
  createdById: "principal-1",
  createdAt: now,
  updatedAt: now,
  failure: null,
};
const freshRun = (id, kinds) => ({
  id,
  requestId: `request-${id}`,
  projectId,
  threadId,
  retryOfRunId: null,
  status: "running",
  modelId: "fixture-model",
  workflow: "generate",
  generationIntent: null,
  targetSurface: "web",
  designStyle: { kind: "automatic" },
  artifactTargets: [],
  requestedArtifactKinds: kinds,
  sources: [],
  knowledgeReleaseId: null,
  phase: "generating",
  phaseLabel: "正在生成",
  progress: null,
  attempt: 1,
  lastEventSequence: 0,
  cancelRequestedAt: null,
  failure: null,
  cancellationReason: null,
  createdAt: now,
  startedAt: now,
  finishedAt: null,
});
const results = {
  evidence: "UI fixture with actual open HTTP SSE; not live model acceptance",
  checks: [],
  errors: [],
  unknown: [],
  console: [],
  failedRequests: [],
};
let mode = "plan",
  run = freshRun("run-plan", ["prototype"]),
  events = [],
  approvals = [],
  artifacts = [],
  intent = null,
  sourceRemoved = false,
  createCount = 0,
  submitCount = 0,
  progressReads = 0,
  retryCount = 0,
  cancelCount = 0;
const streams = new Set();
const emit = (type, payload) => {
  const event = {
    protocol: "workbench.run.v1",
    id: `event-${events.length + 1}`,
    projectId,
    threadId,
    runId: run.id,
    requestId: run.requestId,
    traceId: "fixture",
    sequence: events.length + 1,
    occurredAt: now,
    type,
    payload,
  };
  events.push(event);
  run.lastEventSequence = event.sequence;
  const bytes = `id: ${event.sequence}\nevent: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const response of streams) response.write(bytes);
};
const requireInput = (id, prompt) => {
  const approval = {
    id,
    runId: run.id,
    kind: "question",
    prompt,
    options: [],
    attempt: 1,
    status: "pending",
    response: null,
    decidedById: null,
    decidedAt: null,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
  approvals.push(approval);
  run.status = "waiting_input";
  emit("run.input.required", {
    approvalId: id,
    kind: approval.kind,
    prompt,
    options: [],
    attempt: 1,
  });
};
const json = (response, data, status = 200) => {
  response.writeHead(status, {
    "content-type": "application/json",
    etag: '"1"',
  });
  response.end(JSON.stringify(data));
};
const source = {
  id: "source-1",
  projectId,
  createdById: "principal-1",
  kind: "url_snapshot",
  status: "ready",
  label: "已选需求资料",
  descriptor: {
    kind: "url_snapshot",
    sourceUrl: "https://example.test/spec",
    resolvedUrl: "https://example.test/spec",
  },
  checksum: "a".repeat(64),
  revision: 1,
  failure: null,
  deletedAt: null,
  createdAt: now,
  updatedAt: now,
};
const version = {
  artifactId: "artifact-prd",
  artifactVersionId: "version-prd",
  version: 1,
  kind: "prd",
  schemaVersion: 3,
  status: "ready",
  checksum: "b".repeat(64),
  createdByRunId: "run-document",
  createdAt: now,
};
const relationVersion = {
  artifactId: version.artifactId,
  artifactVersionId: version.artifactVersionId,
  version: version.version,
  kind: version.kind,
  schemaVersion: version.schemaVersion,
  status: version.status,
  createdByRunId: version.createdByRunId,
  title: "需求说明书",
  prototypeRevision: null,
};
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
  const url = new URL(req.url, "http://fixture"),
    path = url.pathname;
  let body = "";
  for await (const chunk of req) body += chunk;
  if (path.endsWith("/events")) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.flushHeaders();
    const cursor = Number(
      url.searchParams.get("afterSequence") ??
        req.headers["last-event-id"] ??
        0,
    );
    for (const event of events.filter((e) => e.sequence > cursor))
      res.write(
        `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      );
    streams.add(res);
    res.on("close", () => streams.delete(res));
    return;
  }
  if (path.endsWith("/bootstrap"))
    return json(res, {
      project,
      access: { role: "owner" },
      threads: [thread],
      selectedThreadId: threadId,
      entries: [],
      board,
      artifacts,
      latestRun: mode === "document" && submitCount ? run : null,
    });
  if (path.endsWith("/runtime/models"))
    return json(res, {
      items: [
        {
          id: "fixture-model",
          displayName: "验证模型",
          description: null,
          supportedWorkflows: ["generate", "edit"],
          supportsThinking: true,
          supportsReasoningEffort: false,
        },
      ],
    });
  if (path.endsWith("/design-presets")) return json(res, { items: [] });
  if (path.endsWith("/design-systems"))
    return json(res, { items: [], nextCursor: null });
  if (path.endsWith("/identity/me"))
    return json(res, {
      id: "principal-1",
      issuer: "https://identity.example.test",
      subject: "fixture",
      email: "fixture@example.test",
      displayName: "验证",
      defaultWorkspaceId: "workspace-1",
    });
  if (path.endsWith("/import-sources"))
    return json(res, {
      items: sourceRemoved ? [] : [source],
      nextCursor: null,
    });
  if (path.endsWith("/import-sources/source-1") && req.method === "DELETE") {
    sourceRemoved = true;
    res.writeHead(204);
    res.end();
    return;
  }
  if (path.endsWith("/prototype-v2/plans"))
    return json(res, mode === "plan" ? [plan] : []);
  if (path.endsWith(`/plans/${planId}`)) return json(res, plan);
  if (path.endsWith("/input"))
    return json(res, {
      plan,
      request: {
        prompt: plan.prompt,
        modelId: run.modelId,
        workflow: "generate",
        targetSurface: "web",
        designStyle: { kind: "automatic" },
        sourceIds: [],
        artifactTargets: [],
        requestedArtifactKinds: ["prototype"],
        generationIntent: null,
        canvasSnapshot: null,
      },
      snapshot: {
        sources: [],
        designStyle: {
          artifactVersionId: null,
          snapshot: null,
          snapshotSha256: null,
        },
        knowledgeReleaseId: null,
      },
      sha256: "a".repeat(64),
    });
  if (path.endsWith("/progress")) {
    progressReads++;
    return json(res, {
      projectId,
      planId,
      status: plan.status,
      input: {
        requestedArtifactKinds: ["prototype"],
        modelId: run.modelId,
        targetSurface: "web",
        sourceIds: [],
        designStyle: null,
      },
      run: { ...run },
      events: [],
      coverage: "window",
      finalRevisionId: null,
    });
  }
  if (
    path.endsWith("/revisions") ||
    path.endsWith("/prototype-v2/shares") ||
    path.endsWith("/prototype-v2/exports")
  )
    return json(res, []);
  if (path.endsWith(`/runs/${run.id}/retry`) && req.method === "POST") {
    retryCount++;
    const previous = run;
    run = { ...freshRun("run-retried", ["prd"]), retryOfRunId: previous.id };
    events = [];
    approvals = [];
    return json(res, run, 202);
  }
  if (path.endsWith(`/runs/${run.id}/cancel`) && req.method === "POST") {
    cancelCount++;
    run.status = "cancelling";
    run.cancelRequestedAt = now;
    emit("run.cancel.requested", {});
    return json(res, run, 202);
  }
  if (path.endsWith(`/runs/${run.id}`)) return json(res, run);
  if (path.endsWith(`/runs/${run.id}/outputs`))
    return json(res, {
      projectId,
      runId: run.id,
      status: run.status,
      coverage: "complete",
      items: run.requestedArtifactKinds.map((kind) => ({
        kind,
        state:
          run.id === "run-partial"
            ? kind === "prd"
              ? "unpublished"
              : "failed"
            : run.status === "succeeded" && kind === "prd"
              ? "ready"
              : run.status === "failed"
                ? "failed"
                : run.status === "cancelled"
                  ? "cancelled"
                  : "pending",
        version:
          kind === "prd" &&
          (run.status === "succeeded" || run.id === "run-partial")
            ? {
                ...relationVersion,
                status: run.id === "run-partial" ? "staging" : "ready",
                createdByRunId: run.id,
              }
            : null,
      })),
    });
  if (path.endsWith("/approvals")) return json(res, { items: approvals });
  if (path.includes("/approvals/")) {
    const item = approvals.find((a) => path.endsWith("/" + a.id));
    if (!item) return json(res, { status: 404, title: "Not found" }, 404);
    if (req.method === "POST") {
      const decision = JSON.parse(body);
      Object.assign(item, {
        status: decision.decision === "submit" ? "submitted" : "approved",
        response: decision,
        revision: 2,
        decidedById: "principal-1",
        decidedAt: now,
      });
      run.status = "running";
      emit("run.input.submitted", {
        approvalId: item.id,
        decision: decision.decision,
      });
      emit("run.phase.changed", {
        phase: "generating",
        label: "继续生成",
        progress: null,
      });
      return json(res, { approval: item, run }, 202);
    }
    return json(res, item);
  }
  if (path.endsWith("/submission-intents") && req.method === "POST") {
    createCount++;
    intent = {
      id: "intent-document",
      projectId,
      threadId,
      status: "pending",
      request: JSON.parse(body).request,
      attachments: [],
      runId: null,
      lastFailure: null,
      revision: 1,
      submittedAt: null,
      cancelledAt: null,
      createdAt: now,
      updatedAt: now,
    };
    return json(res, intent, 201);
  }
  if (path.endsWith("/submission-intents/intent-document/submit")) {
    submitCount++;
    intent = {
      ...intent,
      status: "submitted",
      runId: run.id,
      submittedAt: now,
      revision: 2,
    };
    return json(res, { intent, run }, 202);
  }
  if (path.endsWith("/submission-intents/current"))
    return json(res, { item: intent });
  if (path.endsWith("/artifact-prd/versions"))
    return json(res, {
      items: [{ ...version, contentMode: "inline" }],
      nextCursor: null,
    });
  if (path.endsWith("/artifact-prd/versions/version-prd/relations"))
    return json(res, {
      version: relationVersion,
      sourcePrd: null,
      derivedPrototypes: [],
      nextCursor: null,
    });
  if (path.endsWith("/artifact-prd/versions/version-prd"))
    return json(res, {
      ...version,
      citations: [],
      knowledgeReleaseId: null,
      contentMode: "inline",
      content: prdDocumentV3Example,
    });
  if (path.endsWith("/runs"))
    return json(res, { items: [run], nextCursor: null });
  if (path.endsWith("/entries"))
    return json(res, { items: [], nextAfterSequence: null });
  results.unknown.push(`${req.method} ${path}`);
  return json(res, { status: 404, title: "Fixture route missing" }, 404);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const fixtureOrigin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  bypassCSP: true,
});
await context.addCookies([
  { name: "workbench.session_token", value: "lifecycle-fixture", url: origin },
]);
await context.route("**/api/auth/**", (r) =>
  r.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      session: {
        id: "fixture",
        token: "lifecycle-fixture",
        userId: "principal-1",
        expiresAt: "2099-01-01T00:00:00Z",
        createdAt: now,
        updatedAt: now,
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
  }),
);
// This integration fixture uses a second loopback origin for native open SSE.
// Bypass CSP only in this browser context; frame security has its own smoke/contract tests.
await context.route("**/api/v1/**", (route) => {
  const url = new URL(route.request().url());
  return route.continue({ url: fixtureOrigin + url.pathname + url.search });
});
const page = await context.newPage();
page.setDefaultTimeout(12000);
page.on("pageerror", (error) => results.errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") results.console.push(message.text());
});
page.on("requestfailed", (request) =>
  results.failedRequests.push({
    url: request.url(),
    failure: request.failure(),
  }),
);
const waitFor = async (fn) => {
  for (let i = 0; i < 120; i++) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Fixture condition timed out");
};
try {
  await page.goto(`${origin}/studio/${projectId}?plan=${planId}`, {
    waitUntil: "domcontentloaded",
  });
  await waitFor(() => streams.size > 0 && progressReads > 0);
  await page.getByRole("button", { name: "详情", exact: true }).click();
  const snapshotReadsBeforeInput = progressReads;
  requireInput("approval-first", "请说明目标用户");
  await page.getByText("请说明目标用户", { exact: true }).waitFor();
  assert.equal(
    progressReads,
    snapshotReadsBeforeInput,
    "waiting input must appear on the existing SSE connection",
  );
  await page.getByRole("textbox", { name: "补充输入" }).fill("产品经理");
  await page.getByRole("button", { name: "提交回答", exact: true }).click();
  await waitFor(() => approvals[0].status === "submitted");
  await page.getByText("继续生成", { exact: true }).first().waitFor();
  results.checks.push(
    "open SSE running → waiting_input → answer → running without snapshot polling",
  );
  requireInput("approval-second", "请补充交付范围");
  await page.getByText("请补充交付范围", { exact: true }).waitFor();
  for (const response of streams) response.end();
  await waitFor(() => progressReads >= 2);
  await page.getByText("请补充交付范围", { exact: true }).waitFor();
  results.checks.push(
    "pending approval survives disconnection and authoritative snapshot recovery",
  );
  await page.screenshot({
    path: new URL("plan-approval-recovered.png", output).pathname,
  });
  await page.goto("about:blank");
  for (const response of streams) response.end();
  streams.clear();
  mode = "document";
  run = freshRun("run-document", ["prd"]);
  events = [];
  approvals = [];
  await page.goto(`${origin}/studio/${projectId}`, {
    waitUntil: "domcontentloaded",
  });
  await page
    .getByRole("textbox", { name: "描述需求或修改" })
    .fill("为订单管理系统编写需求文档");
  await page.getByRole("button", { name: "资料", exact: true }).last().click();
  await page.getByRole("checkbox", { name: /已选需求资料/ }).check();
  await page.getByRole("button", { name: /^资料\s*1$/ }).click();
  await page
    .locator(".studio-rail")
    .getByRole("button", { name: "资料", exact: true })
    .click();
  await page.getByRole("button", { name: "移除", exact: true }).click();
  await page.getByText("已选需求资料 · 不可用", { exact: false }).waitFor();
  assert(
    await page
      .getByRole("button", { name: "发送需求", exact: true })
      .isDisabled(),
  );
  await page
    .getByRole("button", { name: "移除引用 已选需求资料", exact: true })
    .click();
  assert.equal(
    await page.getByRole("textbox", { name: "描述需求或修改" }).inputValue(),
    "为订单管理系统编写需求文档",
  );
  assert.equal(
    await page
      .getByRole("button", { name: "发送需求", exact: true })
      .isEnabled(),
    true,
  );
  results.checks.push(
    "deleted selected source stays removable, preserves prompt and restores send",
  );
  await page
    .getByRole("combobox", { name: "输出类型", exact: true })
    .selectOption("prd");
  await page.getByRole("button", { name: "发送需求", exact: true }).click();
  await waitFor(() => submitCount === 1 && streams.size > 0);
  await page
    .getByRole("heading", { name: "文档与产物", exact: true })
    .waitFor();
  await page
    .getByRole("textbox", { name: "描述需求或修改" })
    .fill("下一轮草稿");
  assert(
    await page
      .getByRole("button", { name: "发送需求", exact: true })
      .isDisabled(),
  );
  emit("artifact.preview.updated", {
    attempt: 1,
    preview: {
      artifactIndex: 0,
      kind: "prd",
      title: "订单管理需求",
      markdown: "第一段真实投影测试数据",
      screens: [],
    },
  });
  await page.getByText("第一段真实投影测试数据", { exact: true }).waitFor();
  emit("artifact.preview.updated", {
    attempt: 1,
    preview: {
      artifactIndex: 0,
      kind: "prd",
      title: "订单管理需求",
      markdown: "第二段更新后的投影测试数据",
      screens: [],
    },
  });
  await page.getByText("第二段更新后的投影测试数据", { exact: true }).waitFor();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("第二段更新后的投影测试数据", { exact: true }).waitFor();
  assert.equal(createCount, 1);
  assert.equal(submitCount, 1);
  assert.equal(
    await page.getByRole("textbox", { name: "描述需求或修改" }).inputValue(),
    "下一轮草稿",
  );
  requireInput("approval-document", "请确认文档受众");
  await page.getByText("请确认文档受众", { exact: true }).waitFor();
  await page.getByRole("textbox", { name: "补充输入" }).fill("业务人员");
  await page.getByRole("button", { name: "提交回答", exact: true }).click();
  await waitFor(() => approvals[0].status === "submitted");
  artifacts = [
    {
      id: "artifact-prd",
      projectId,
      kind: "prd",
      title: "新生成的订单需求",
      revision: 1,
      currentVersion: version,
      createdAt: now,
      updatedAt: now,
    },
  ];
  emit("artifact.declared", {
    artifactId: version.artifactId,
    artifactVersionId: version.artifactVersionId,
    version: 1,
  });
  run.status = "succeeded";
  run.finishedAt = now;
  emit("run.completed", { artifactCount: 1 });
  for (const response of streams) response.end();
  await page.getByText("文档任务已完成", { exact: true }).waitFor();
  await page
    .getByRole("heading", { name: "示例工单需求说明书", exact: true })
    .first()
    .waitFor();
  assert.equal(
    await page
      .getByRole("combobox", { name: "选择文档", exact: true })
      .inputValue(),
    "artifact-prd",
  );
  assert.equal(createCount, 1);
  assert.equal(submitCount, 1);
  assert.equal(
    await page
      .getByRole("button", { name: "发送需求", exact: true })
      .isEnabled(),
    true,
  );
  results.checks.push(
    "document-only submission tracks previews, refresh, input wait and terminal artifact without leaving documents or duplicate submissions",
  );
  await page.screenshot({
    path: new URL("document-completed.png", output).pathname,
  });
  await page.goto("about:blank");
  for (const response of streams) response.end();
  streams.clear();
  run = {
    ...freshRun("run-failed", ["prd"]),
    status: "failed",
    failure: {
      code: "FIXTURE_RETRY",
      message: "可重试的文档失败",
      retryable: true,
    },
    finishedAt: now,
  };
  events = [];
  approvals = [];
  await page.goto(
    `${origin}/studio/${projectId}?view=documents&run=${run.id}`,
    { waitUntil: "domcontentloaded" },
  );
  await page.getByText("文档任务失败", { exact: true }).click();
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await waitFor(() => retryCount === 1 && streams.size > 0);
  await page.waitForURL(/run=run-retried/);
  assert.equal(run.retryOfRunId, "run-failed");
  assert(
    await page
      .getByRole("button", { name: "发送需求", exact: true })
      .isDisabled(),
  );
  await page.getByRole("button", { name: "停止运行", exact: true }).click();
  await waitFor(() => cancelCount === 1);
  assert(
    await page
      .getByRole("button", { name: "发送需求", exact: true })
      .isDisabled(),
    "cancel acceptance must not unlock send before terminal state",
  );
  run.status = "cancelled";
  run.finishedAt = now;
  emit("run.cancelled", { reason: "用户停止" });
  for (const response of streams) response.end();
  await page.getByText("文档任务已停止", { exact: true }).waitFor();
  assert(
    await page
      .getByRole("button", { name: "发送需求", exact: true })
      .isEnabled(),
  );
  results.checks.push(
    "retry follows the new run identity; cancel acceptance stays busy until cancelled terminal event",
  );
  await page.goto("about:blank");
  run = {
    ...freshRun("run-partial", ["prd", "prototype"]),
    status: "failed",
    finishedAt: now,
    failure: {
      code: "PARTIAL_OUTPUT",
      message: "原型生成中断",
      retryable: true,
    },
  };
  events = [];
  approvals = [];
  await page.goto(`${origin}/studio/${projectId}?view=runs&run=${run.id}`, {
    waitUntil: "domcontentloaded",
  });
  const visibleOutputs = page.getByRole("region", { name: "分项产物状态" });
  await visibleOutputs
    .getByText("需求文档：已有草稿，尚未发布", { exact: true })
    .waitFor();
  await visibleOutputs.getByText("原型：未完成", { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("combobox", { name: "运行记录" }).inputValue(),
    "run-partial",
  );
  assert.equal(
    await page
      .getByRole("region", { name: "分项产物状态" })
      .getByRole("link")
      .count(),
    0,
  );
  results.checks.push(
    "direct fixed-run navigation shows unpublished PRD and failed Prototype separately without a usable-output link for a failed joint task",
  );
  assert.deepEqual(results.errors, []);
  assert.deepEqual(results.unknown, []);
  results.status = "passed";
} catch (error) {
  results.status = "failed";
  results.failure = error.stack;
  results.url = page.url();
  results.body = (await page.locator("body").innerText()).slice(0, 3000);
  await page.screenshot({ path: new URL("failure.png", output).pathname });
  process.exitCode = 1;
} finally {
  results.requests = {
    progressReads,
    createCount,
    submitCount,
    retryCount,
    cancelCount,
  };
  await writeFile(
    new URL("results.json", output),
    JSON.stringify(results, null, 2),
  );
  console.log(JSON.stringify(results, null, 2));
  await browser.close();
  for (const response of streams) response.end();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
