import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { prdDocumentV2Example } from "@workbench/workbench-contracts/test-fixtures";
import {
  assertPrdSmokeBusinessSemantics,
  assertPrdV2Structure,
  executePrdHttpSmoke,
} from "./workbench-prd-http-smoke.mjs";

const fixedNow = () => new Date("2026-07-23T09:00:00.000Z");
const smokeUuid = "11111111-2222-4333-8444-555555555555";
const email = "prd-smoke@example.test";
const password = "email-password-must-not-leak";
const existingCookie = "workbench.session_token=existing-session-must-not-leak";
const prdGenerationStages = [
  "collecting-prd-context",
  "structuring-prd",
  "drafting-prd",
  "validating-prd",
];

test("runs the isolated PRD v2 HTTP flow through Better Auth email sign-in", async (t) => {
  const fake = await startFakeWorkbench();
  t.after(fake.close);

  const result = await executePrdHttpSmoke({
    env: smokeEnvironment(fake.origin, {
      WORKBENCH_PRD_SMOKE_EMAIL: email,
      WORKBENCH_PRD_SMOKE_PASSWORD: password,
    }),
    now: fixedNow,
    randomUUID: () => smokeUuid,
    sleep: async () => undefined,
  });

  assert.equal(result.ok, true, `${result.failure?.code}: ${result.failure?.message}`);
  assert.equal(result.evidence.result, "PASS");
  assert.equal(result.evidence.authMode, "email");
  assert.equal(result.evidence.projectRetained, true);
  assert.equal(result.evidence.projectUrl, `${fake.origin}/projects/project-smoke`);
  assert.equal(result.evidence.checks.at(-1)?.name, "prd-board-node-verified");
  assert.equal(fake.state.authCalls, 1);
  assert.equal(fake.state.projectTitle.startsWith("[SMOKE] PRD HTTP "), true);
  assert.deepEqual(fake.state.submissionBody.request.requestedArtifactKinds, ["prd"]);
  assert.deepEqual(fake.state.submissionBody.attachments, []);
  assert.equal(fake.state.submissionBody.request.artifactTargets.length, 0);
  assert.equal(fake.state.submissionBody.request.canvasSnapshot, null);
  assert.equal(fake.state.selectedModelId, "model-generate");
  assert.ok(fake.state.apiCookies.every((cookie) => cookie === "workbench.session_token=fake-session"));
  assert.ok(fake.state.mutationOrigins.every((origin) => origin === fake.origin));
  assertNoSecretOrPrdBody(result, [email, password, "existing-session-must-not-leak"]);
});

test("uses an explicit existing session cookie without calling the sign-in route", async (t) => {
  const fake = await startFakeWorkbench();
  t.after(fake.close);

  const result = await executePrdHttpSmoke({
    env: smokeEnvironment(fake.origin, {
      WORKBENCH_PRD_SMOKE_SESSION_COOKIE: existingCookie,
    }),
    now: fixedNow,
    randomUUID: () => smokeUuid,
    sleep: async () => undefined,
  });

  assert.equal(result.ok, true, `${result.failure?.code}: ${result.failure?.message}`);
  assert.equal(result.evidence.authMode, "session-cookie");
  assert.equal(fake.state.authCalls, 0);
  assert.ok(fake.state.apiCookies.every((cookie) => cookie === existingCookie));
  assertNoSecretOrPrdBody(result, [existingCookie, email, password]);
});

test("fails closed before any HTTP write without the explicit write confirmation", async () => {
  let requests = 0;
  const result = await executePrdHttpSmoke({
    env: {
      NODE_ENV: "test",
      WORKBENCH_PRD_SMOKE_ALLOW_HTTP: "1",
      WORKBENCH_PRD_SMOKE_BASE_URL: "http://127.0.0.1:9",
      WORKBENCH_PRD_SMOKE_SESSION_COOKIE: existingCookie,
    },
    fetchImpl: async () => {
      requests += 1;
      throw new Error("must not be called");
    },
    now: fixedNow,
    randomUUID: () => smokeUuid,
  });

  assert.equal(result.ok, false);
  assert.equal(result.failure.code, "WRITE_CONFIRMATION_REQUIRED");
  assert.equal(result.evidence.projectUrl, undefined);
  assert.equal(requests, 0);
  assertNoSecretOrPrdBody(result, [existingCookie]);
});

test("rejects a Prototype from a PRD-only production Run", async (t) => {
  const fake = await startFakeWorkbench({ artifactKind: "prototype" });
  t.after(fake.close);

  const result = await executePrdHttpSmoke({
    env: smokeEnvironment(fake.origin, {
      WORKBENCH_PRD_SMOKE_SESSION_COOKIE: existingCookie,
    }),
    now: fixedNow,
    randomUUID: () => smokeUuid,
    sleep: async () => undefined,
  });

  assert.equal(result.ok, false);
  assert.equal(result.failure.code, "PROTOTYPE_ARTIFACT_FORBIDDEN");
  assert.equal(result.evidence.projectRetained, true);
  assert.equal(result.evidence.projectUrl, `${fake.origin}/projects/project-smoke`);
  assertNoSecretOrPrdBody(result, [existingCookie]);
});

test("rejects a PRD Run that skips a real template-generation stage", async (t) => {
  const fake = await startFakeWorkbench({
    generationStages: prdGenerationStages.slice(0, -1),
  });
  t.after(fake.close);

  const result = await executePrdHttpSmoke({
    env: smokeEnvironment(fake.origin, {
      WORKBENCH_PRD_SMOKE_SESSION_COOKIE: existingCookie,
    }),
    now: fixedNow,
    randomUUID: () => smokeUuid,
    sleep: async () => undefined,
  });

  assert.equal(result.ok, false);
  assert.equal(result.failure.code, "PRD_GENERATION_STAGES_INVALID");
  assertNoSecretOrPrdBody(result, [existingCookie]);
});

test("rejects a PRD Run that reports a Prototype generation stage", async (t) => {
  const fake = await startFakeWorkbench({
    generationStages: [...prdGenerationStages, "generating-ui"],
  });
  t.after(fake.close);

  const result = await executePrdHttpSmoke({
    env: smokeEnvironment(fake.origin, {
      WORKBENCH_PRD_SMOKE_SESSION_COOKIE: existingCookie,
    }),
    now: fixedNow,
    randomUUID: () => smokeUuid,
    sleep: async () => undefined,
  });

  assert.equal(result.ok, false);
  assert.equal(result.failure.code, "PRD_GENERATION_STAGES_INVALID");
  assertNoSecretOrPrdBody(result, [existingCookie]);
});

test("rejects forbidden requirement-document placeholder wording", () => {
  const document = structuredClone(prdDocumentV2Example);
  document.sections.introduction.background.blocks[0].content[0].text = "待确认";

  assert.throws(
    () => assertPrdV2Structure(document),
    (error) => error?.code === "PRD_PLACEHOLDER_FORBIDDEN",
  );
});

test("requires the production smoke PRD revision to remain a draft", () => {
  const document = orderNotificationPrdFixture();
  document.revision.status = "approved";

  assert.throws(
    () => assertPrdV2Structure(document),
    (error) => error?.code === "PRD_REVISION_INVALID",
  );
});

test("requires the production smoke PRD to match the order-notification topic", () => {
  const document = orderNotificationPrdFixture();
  assert.deepEqual(assertPrdSmokeBusinessSemantics(document), {
    theme: "order-status-notification",
    themeRequirementCount: 7,
    unrelatedBusinessMatches: 0,
  });

  document.title = "其他主题需求说明书";
  assert.throws(
    () => assertPrdSmokeBusinessSemantics(document),
    (error) => error?.code === "PRD_SMOKE_TOPIC_INVALID",
  );
});

test("requires order-notification facts in the business body instead of metadata", () => {
  const document = orderNotificationPrdFixture();
  document.sections.introduction = replaceStringFragments(
    document.sections.introduction,
    "权限",
    "授权",
  );
  document.sections.businessRequirements = replaceStringFragments(
    document.sections.businessRequirements,
    "权限",
    "授权",
  );
  document.sections.degradation = replaceStringFragments(
    document.sections.degradation,
    "权限",
    "授权",
  );
  assert.equal(JSON.stringify(document.assumptions).includes("权限"), true);

  assert.throws(
    () => assertPrdSmokeBusinessSemantics(document),
    (error) => error?.code === "PRD_SMOKE_TOPIC_INVALID",
  );
});

test("rejects unrelated task-domain content in the production smoke PRD", () => {
  const unrelated = orderNotificationPrdFixture();
  unrelated.sections.introduction.background.blocks[0].content[0].text =
    "现有产品工作台已提供业务任务处理入口，但处理状态、异常恢复和结果确认信息不完整，用户难以判断任务是否闭环。本需求调整工作台任务页面及配套处理能力，使用户能够提交必要信息、跟踪处理状态并确认最终结果。";
  assert.throws(
    () => assertPrdSmokeBusinessSemantics(unrelated),
    (error) => error?.code === "PRD_SMOKE_UNRELATED_CONTENT",
  );

  for (const phrase of ["任务页面", "任务执行入口", "任务状态", "任务权限", "任务记录"]) {
    const nearSynonym = orderNotificationPrdFixture();
    nearSynonym.sections.introduction.background.blocks[0].content[0].text += ` ${phrase}`;
    assert.throws(
      () => assertPrdSmokeBusinessSemantics(nearSynonym),
      (error) => error?.code === "PRD_SMOKE_UNRELATED_CONTENT",
      phrase,
    );
  }

  const diagramGroupDrift = orderNotificationPrdFixture();
  diagramGroupDrift.sections.businessRequirements.flowAndPages.diagrams[0].nodes[0].group = "任务能力";
  assert.throws(
    () => assertPrdSmokeBusinessSemantics(diagramGroupDrift),
    (error) => error?.code === "PRD_SMOKE_UNRELATED_CONTENT",
  );
});

test("allows task wording that remains grounded in notification delivery", () => {
  const document = orderNotificationPrdFixture();
  document.sections.degradation.content[0].text += " 通知发送任务由队列调度，失败后生成重试任务。";

  assert.doesNotThrow(() => assertPrdSmokeBusinessSemantics(document));
});

test("requires the order-notification topic in each critical PRD section", () => {
  for (const mutate of [
    (document) => {
      document.sections.introduction.background = replaceStringFragments(
        replaceStringFragments(document.sections.introduction.background, "订单", "业务"),
        "通知",
        "消息",
      );
    },
    (document) => {
      document.sections.businessRequirements.coreRules = replaceStringFragments(
        replaceStringFragments(document.sections.businessRequirements.coreRules, "订单", "业务"),
        "通知",
        "消息",
      );
    },
    (document) => {
      document.sections.businessRequirements.acceptanceCriteria = replaceStringFragments(
        replaceStringFragments(document.sections.businessRequirements.acceptanceCriteria, "订单", "业务"),
        "通知",
        "消息",
      );
    },
  ]) {
    const document = orderNotificationPrdFixture();
    mutate(document);
    assert.throws(
      () => assertPrdSmokeBusinessSemantics(document),
      (error) => error?.code === "PRD_SMOKE_TOPIC_INVALID",
    );
  }
});

test("requires both diagrams and degradation to describe order-notification recovery", () => {
  const diagramDrift = orderNotificationPrdFixture();
  diagramDrift.sections.businessRequirements.flowAndPages.diagrams[1] = replaceStringFragments(
    replaceStringFragments(
      replaceStringFragments(diagramDrift.sections.businessRequirements.flowAndPages.diagrams[1], "订单", "业务"),
      "通知",
      "消息",
    ),
    "发送",
    "执行",
  );
  assert.throws(
    () => assertPrdSmokeBusinessSemantics(diagramDrift),
    (error) => error?.code === "PRD_SMOKE_TOPIC_INVALID",
  );

  const degradationDrift = orderNotificationPrdFixture();
  degradationDrift.sections.degradation = replaceStringFragments(
    replaceStringFragments(degradationDrift.sections.degradation, "重试", "人工处理"),
    "恢复",
    "人工介入",
  );
  assert.throws(
    () => assertPrdSmokeBusinessSemantics(degradationDrift),
    (error) => error?.code === "PRD_SMOKE_TOPIC_INVALID",
  );
});

function smokeEnvironment(origin, auth) {
  return {
    NODE_ENV: "test",
    WORKBENCH_PRD_SMOKE_ALLOW_HTTP: "1",
    WORKBENCH_PRD_SMOKE_BASE_URL: origin,
    WORKBENCH_PRD_SMOKE_CONFIRM_WRITE: "CREATE_ISOLATED_PRD_SMOKE_PROJECT",
    WORKBENCH_PRD_SMOKE_POLL_INTERVAL_MS: "1",
    WORKBENCH_PRD_SMOKE_REQUEST_TIMEOUT_MS: "1000",
    WORKBENCH_PRD_SMOKE_TIMEOUT_MS: "2000",
    ...auth,
  };
}

function assertNoSecretOrPrdBody(result, forbiddenValues) {
  const serialized = JSON.stringify(result);
  for (const value of forbiddenValues) assert.equal(serialized.includes(value), false);
  assert.equal(serialized.includes("现有产品工作台已提供业务任务处理入口"), false);
  assert.equal(serialized.includes("依赖异常时保留用户输入"), false);
}

async function startFakeWorkbench({
  artifactKind = "prd",
  generationStages = prdGenerationStages,
} = {}) {
  const state = {
    apiCookies: [],
    authCalls: 0,
    bootstrapCalls: 0,
    mutationOrigins: [],
    projectTitle: "",
    runPolls: 0,
    selectedModelId: null,
    submissionBody: null,
  };
  const server = http.createServer((request, response) => {
    void handleFakeRequest(request, response, state, artifactKind, generationStages).catch(() => {
      if (!response.headersSent) response.writeHead(500, { "Content-Type": "application/json" });
      if (!response.writableEnded) response.end(JSON.stringify({ code: "FAKE_SERVER_FAILURE" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake server did not bind TCP");
  return {
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    origin: `http://127.0.0.1:${address.port}`,
    state,
  };
}

async function handleFakeRequest(request, response, state, artifactKind, generationStages) {
  const url = new URL(request.url ?? "/", "http://fake.test");
  const method = request.method ?? "GET";
  if (!["GET", "HEAD"].includes(method)) state.mutationOrigins.push(request.headers.origin ?? "");

  if (method === "POST" && url.pathname === "/api/auth/sign-in/email") {
    state.authCalls += 1;
    const body = await requestJson(request);
    assert.deepEqual(body, { email, password });
    return sendJson(response, 200, { user: { id: "principal-smoke" } }, {
      "Set-Cookie": "workbench.session_token=fake-session; Path=/; HttpOnly; Secure; SameSite=Lax",
    });
  }

  if (url.pathname.startsWith("/api/v1/")) {
    state.apiCookies.push(request.headers.cookie ?? "");
  }
  if (method === "GET" && url.pathname === "/api/v1/identity/me") {
    return sendJson(response, 200, {
      id: "principal-smoke",
      defaultWorkspaceId: "workspace-smoke",
    });
  }
  if (method === "GET" && url.pathname === "/api/v1/runtime/models") {
    return sendJson(response, 200, {
      items: [
        { id: "model-edit", supportedWorkflows: ["edit"] },
        { id: "model-generate", supportedWorkflows: ["generate", "edit"] },
      ],
    });
  }
  if (method === "POST" && url.pathname === "/api/v1/workspaces/workspace-smoke/projects") {
    const body = await requestJson(request);
    state.projectTitle = body.title;
    return sendJson(response, 201, { id: "project-smoke" });
  }
  if (method === "GET" && url.pathname === "/api/v1/projects/project-smoke/bootstrap") {
    state.bootstrapCalls += 1;
    return sendJson(response, 200, state.bootstrapCalls === 1
      ? initialBootstrap()
      : completedBootstrap());
  }
  if (method === "POST" && url.pathname === "/api/v1/threads/thread-smoke/submission-intents") {
    state.submissionBody = await requestJson(request);
    state.selectedModelId = state.submissionBody.request.modelId;
    return sendJson(response, 201, { id: "intent-smoke", status: "pending" });
  }
  if (method === "POST" && url.pathname === "/api/v1/submission-intents/intent-smoke/submit") {
    return sendJson(response, 202, {
      intent: { id: "intent-smoke", runId: "run-smoke", status: "submitted" },
      run: runFixture("queued"),
    });
  }
  if (method === "GET" && url.pathname === "/api/v1/runs/run-smoke") {
    state.runPolls += 1;
    return sendJson(response, 200, runFixture(
      state.runPolls === 1 ? "queued" : state.runPolls === 2 ? "running" : "succeeded",
    ));
  }
  if (method === "GET" && url.pathname === "/api/v1/runs/run-smoke/events") {
    const stageEvents = generationStages.map((stage, index) => (
      prdGenerationStageEventFixture(stage, index + 1)
    ));
    return sendRunEventStream(response, [
      ...stageEvents,
      prdDraftEventFixture(stageEvents.length + 1),
    ]);
  }
  if (method === "GET" && url.pathname === "/api/v1/projects/project-smoke/artifacts") {
    return sendJson(response, 200, {
      items: [artifactKind === "prototype" ? prototypeArtifactFixture() : prdArtifactFixture()],
      nextCursor: null,
    });
  }
  if (
    method === "GET"
    && url.pathname === "/api/v1/artifacts/artifact-smoke/versions/version-smoke"
  ) {
    return sendJson(response, 200, prdVersionFixture());
  }
  return sendJson(response, 404, { code: "FAKE_ROUTE_NOT_FOUND" });
}

function initialBootstrap() {
  return {
    artifacts: [],
    board: { nodes: [] },
    selectedThreadId: "thread-smoke",
    threads: [{ id: "thread-smoke" }],
  };
}

function completedBootstrap() {
  return {
    artifacts: [prdArtifactFixture()],
    board: {
      nodes: [{
        artifactId: "artifact-smoke",
        artifactVersionId: "version-smoke",
        data: { artifactKind: "prd" },
        size: { height: 500, width: 500 },
      }],
    },
    threads: [{ id: "thread-smoke" }],
  };
}

function runFixture(status) {
  return {
    failure: null,
    id: "run-smoke",
    progress: status === "succeeded" ? 1 : status === "running" ? 0.5 : 0,
    projectId: "project-smoke",
    requestedArtifactKinds: ["prd"],
    status,
    threadId: "thread-smoke",
  };
}

function prdArtifactFixture() {
  return {
    id: "artifact-smoke",
    kind: "prd",
    currentVersion: {
      artifactId: "artifact-smoke",
      artifactVersionId: "version-smoke",
      createdByRunId: "run-smoke",
      kind: "prd",
      schemaVersion: 2,
      status: "ready",
    },
  };
}

function prototypeArtifactFixture() {
  return {
    id: "artifact-prototype",
    kind: "prototype",
    currentVersion: {
      artifactId: "artifact-prototype",
      artifactVersionId: "version-prototype",
      createdByRunId: "run-smoke",
      kind: "prototype",
      schemaVersion: 1,
      status: "ready",
    },
  };
}

function prdVersionFixture() {
  return {
    artifactId: "artifact-smoke",
    artifactVersionId: "version-smoke",
    checksum: "a".repeat(64),
    citations: [],
    content: orderNotificationPrdFixture(),
    contentMode: "inline",
    createdAt: "2026-07-23T09:01:00.000Z",
    createdByRunId: "run-smoke",
    kind: "prd",
    knowledgeReleaseId: null,
    schemaVersion: 2,
    status: "ready",
    version: 1,
  };
}

function orderNotificationPrdFixture() {
  let document = structuredClone(prdDocumentV2Example);
  for (const [source, replacement] of [
    ["产品工作台", "电商订单中心"],
    ["当前项目", "电商订单中心"],
    ["目标业务用户", "已登录消费者"],
    ["提交区", "通知设置区"],
    ["运行状态区", "发送状态区"],
    ["任务处理", "通知发送"],
    ["任务页面", "通知设置页"],
    ["任务状态", "发送状态"],
    ["任务记录", "发送记录"],
    ["任务编号", "通知编号"],
    ["任务", "通知"],
    ["提交", "保存"],
    ["处理", "发送"],
    ["结果", "发送结果"],
    ["输入", "设置内容"],
    ["阶段", "发送阶段"],
    ["重复", "多次"],
  ]) {
    document = replaceStringFragments(document, source, replacement);
  }
  document.documentId = "prd-smoke-order-notification";
  document.title = "电商订单状态通知设置需求说明书";
  document.cover = {
    workOrderName: "电商订单状态通知设置",
    title: "电商订单状态通知设置需求说明书",
  };
  document.sections.introduction.background.blocks[0].content[0].text =
    "电商订单中心当前缺少统一的端内状态通知设置，已登录消费者无法按订单状态管理提醒。本需求新增通知开关、状态分类和发送记录，并补齐失败重试及权限反馈。";
  document.sections.introduction.usageScenarios.blocks[0].content[0].text =
    "已登录消费者从订单中心端内入口进入通知设置页，按订单状态分类开启或关闭通知，并查看发送结果记录。";
  document.sections.introduction.usageScenarios.channelTable.rows = [
    { sequence: 1, channel: "inApp", enabled: true },
    { sequence: 2, channel: "wapH5", enabled: false },
    { sequence: 3, channel: "miniProgram", enabled: false },
  ];
  document.sections.businessRequirements.summary[0].text =
    "总体目标：已登录消费者可配置订单状态通知开关，查看发送结果记录，并在发送失败时重试或获得明确权限反馈。";
  document.sections.businessRequirements.coreRules.blocks[2].content[0].text =
    "本需求修改现有订单通知功能逻辑；通知设置数据与发送状态均执行完整性和一致性校验。";
  return document;
}

function replaceStringFragments(value, source, replacement) {
  if (typeof value === "string") return value.replaceAll(source, replacement);
  if (Array.isArray(value)) {
    return value.map((item) => replaceStringFragments(item, source, replacement));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(
      ([key, item]) => [key, replaceStringFragments(item, source, replacement)],
    ));
  }
  return value;
}

function prdGenerationStageEventFixture(stage, sequence) {
  return {
    protocol: "workbench.run.v1",
    id: `event-stage-${sequence}`,
    projectId: "project-smoke",
    threadId: "thread-smoke",
    runId: "run-smoke",
    requestId: "request-smoke",
    sequence,
    occurredAt: `2026-07-23T09:00:0${sequence}.000Z`,
    traceId: "trace-smoke",
    type: "run.generation.stage.changed",
    payload: { attempt: 1, stage },
  };
}

function prdDraftEventFixture(sequence) {
  return {
    protocol: "workbench.run.v1",
    id: "event-draft-smoke",
    projectId: "project-smoke",
    threadId: "thread-smoke",
    runId: "run-smoke",
    requestId: "request-smoke",
    sequence,
    occurredAt: "2026-07-23T09:00:30.000Z",
    traceId: "trace-smoke",
    type: "artifact.draft.created",
    payload: {
      attempt: 1,
      artifactIndex: 0,
      artifactId: "artifact-smoke",
      artifactVersionId: "version-smoke",
      kind: "prd",
      checksum: "a".repeat(64),
      draftChecksum: "b".repeat(64),
      screens: [],
    },
  };
}

async function requestJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
}

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

function sendRunEventStream(response, events) {
  response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
  response.end(events.map((event) => (
    `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
  )).join(""));
}
