#!/usr/bin/env node

import { createHash, randomUUID as nodeRandomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { setTimeout as nodeDelay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  artifactVersionDetailSchema,
  canonicalJson,
  prdChannelKinds,
  prdSafetyBaselineItems,
  prdTableOfContentsEntriesFor,
  runEventSchema,
} from "@workbench/workbench-contracts";

const scriptPath = fileURLToPath(import.meta.url);
const writeConfirmation = "CREATE_ISOLATED_PRD_SMOKE_PROJECT";
const terminalRunStatuses = new Set(["succeeded", "failed", "cancelled"]);
const smokeThemeRequirements = [
  { label: "已登录消费者", terms: ["已登录消费者", "登录消费者"] },
  { label: "订单", terms: ["订单"] },
  { label: "通知开关", terms: ["通知开关", "开启通知", "关闭通知"] },
  { label: "订单状态分类", terms: ["订单状态分类", "状态分类"] },
  { label: "发送结果记录", terms: ["发送结果记录", "发送记录", "通知记录", "结果记录"] },
  { label: "失败重试", terms: ["失败重试", "发送失败", "重试"] },
  { label: "权限反馈", terms: ["权限反馈", "无权限", "权限"] },
  { label: "完整性和一致性校验", terms: ["完整性和一致性校验", "完整性、一致性校验"] },
];
const smokeExplicitConstraintRequirements = [
  { label: "沿用消费者现有通知设置", pattern: /(?:沿用|保持)[^。！？；;\n]{0,12}(?:消费者)?(?:现有|既有|原有)[^。！？；;\n]{0,8}(?:通知)?设置/u },
  { label: "不新增通知默认状态", pattern: /(?:不设|不设置|不新增|不改变).{0,12}(?:默认|初始)/u },
  { label: "沿用订单中心既有分类", pattern: /(?:沿用|保持)[^。！？；;\n]{0,12}(?:订单中心)?(?:现有|既有|原有)[^。！？；;\n]{0,8}(?:状态)?分类/u },
  { label: "不新增或枚举订单分类", pattern: /(?:不新增|不枚举|不列举).{0,12}(?:状态)?分类|(?:状态)?分类.{0,8}(?:不新增|不枚举|不列举)/u },
];
const unrelatedSmokeBusinessPattern = /产品工作台|当前项目|提交区|运行状态区|任务(?:页面|处理|执行入口|状态|权限|记录|编号|能力|结果|闭环)|(?:发起|提交|创建|查询)任务/u;
const smokeSectionThemePattern = /订单|通知/u;
const smokeDiagramThemePattern = /订单|通知|发送/u;
const smokeDegradationTopicPattern = /通知|发送/u;
const smokeDegradationRecoveryPattern = /重试|再次发送|重新发送|稍后再试|恢复/u;
const smokeRuntimeMetadataPattern = /(?:仅|只)(?:(?:需|需要)?(?:生成|产出|交付|提供|输出|包含)|(?:需|需要))\s*(?:一份)?(?:完整中文)?\s*(?:需求(?:说明书|文档)(?:\s*[（(]?PRD[）)]?)?|PRD)|(?:交付物|输出物|产出物|交付范围|本次产出)\s*(?:为|是|包括|包含|[:：]).{0,12}(?:完整中文)?\s*(?:需求(?:说明书|文档)(?:\s*[（(]?PRD[）)]?)?|PRD)|本需求.{0,8}(?:交付|输出|产出)\s*(?:一份)?(?:完整中文)?\s*(?:需求(?:说明书|文档)(?:\s*[（(]?PRD[）)]?)?|PRD)|(?:不(?:需要|交付|制作|生成|产出|提供|包含|输出)?|无需)(?:生成|产出|提供|包含|交付|制作|输出)?\s*.{0,12}(?:原型|图片|代码)|(?:原型|图片|代码)(?:[、,，/和及与]\s*(?:原型|图片|代码))*.{0,8}(?:不在|不属于).{0,12}(?:交付|输出|产出|范围)|PRD-only|Runtime metadata/iu;
const smokeInventedDefaultPattern = /(?:默认|初始|缺省|预设)(?:状态|值)?\s*(?:为|设为|设置为|设置成|设成|[:：=])?\s*[“”"'‘’]?(?:开启|关闭|打开|启用|停用)|(?:首次进入|首次打开|首次使用|首次访问|首次登录).{0,12}(?:自动|默认)(?:为用户)?(?:开启|关闭|打开|启用|停用)(?:通知|开关)?/gu;
const smokeNegatedDefaultContextPattern = /(?:(?:不|未|无|非|没有|无需|并非|不得|禁止|取消)(?:(?:新增|生成|产生|创建|设置|设定|设|采用|使用|启用)(?:为)?)?(?:任何|新的|新)?|不存在(?:系统)?(?:新增|生成|产生|创建|设置|设定)?)[\s，,、]*$/u;
const smokeCoordinatedDefaultContextPattern = /(?:默认|初始|缺省|预设)(?:状态|值)?\s*(?:为|设为|设置为|设置成|设成|[:：=])?\s*[“”"'‘’]?(?:开启|关闭|打开|启用|停用)(?:状态|值)?\s*(?:或|或者|和|及|与|、)\s*$/u;
const smokeDistinctOrderStatusValue = "(?:待付款|待支付|待发货|待收货|退款中|已退款)";
const smokeCategoryClauseText = "[^。！？；;\\n]";
const smokeInventedCategoryPattern = new RegExp(
  `${smokeDistinctOrderStatusValue}|(?:订单状态|状态分类)${smokeCategoryClauseText}{0,16}(?:为|按|包括|包含|分为|划分为|可选|选项|分类为|[:：])${smokeCategoryClauseText}{0,24}(?:支付|发货|收货|退款|完成|取消|已完成|已取消)`,
  "u",
);
const smokeSafetyRemarkRules = new Map([
  [1, {
    positive: /(?:新增|增加|新建|新开发|开发|建设|搭建|构建|实现|修改|调整|变更|变动|改造|升级).{0,24}(?:功能|接口|逻辑|页面|能力|控件|流程|状态|行为|规则)|(?:功能|接口|逻辑|页面|能力|控件|流程|状态|行为|规则).{0,24}(?:新增|增加|新建|新开发|开发|建设|搭建|构建|实现|修改|调整|变更|变动|改造|升级)/u,
    negative: /(?:不|未|无需)(?:发生|涉及|包含|进行)?(?:新增|增加|新建|新开发|开发|建设|搭建|构建|实现|修改|调整|变更|变动|改造|升级)|(?:功能|接口|逻辑|页面|能力|控件|流程|状态|行为|规则).{0,12}(?:不|未)(?:发生|涉及|进行)?.{0,6}(?:新增|增加|新建|新开发|开发|建设|搭建|构建|实现|修改|调整|变更|变动|改造|升级)/u,
  }],
  [2, {
    positive: /(?:面向|开放给|提供给)\s*(?:已登录\s*的?\s*)?(?:消费者|公众用户|C端用户)|(?:目标用户|服务对象).{0,8}(?:消费者|公众用户|C端用户)|(?:消费者|公众用户|C端用户)(?:可|可以|能够|能|通过|从|在|访问|使用|查看|进入|配置)/iu,
    negative: /(?:不再|尚未)\s*(?:面向|开放给|提供给).{0,16}(?:消费者|公众用户|C端用户)|(?:消费者|公众用户|C端用户).{0,16}(?:由|被).{0,12}(?:客服|内部|员工).{0,8}(?:管理|查看|操作)|(?:内部客服|员工).{0,12}(?:管理|查看|操作).{0,8}(?:消费者|公众用户|C端用户)/u,
  }],
  [21, {
    positive: /(?:完整性.{0,12}一致性|一致性.{0,12}完整性).{0,12}(?:校验|检查|验证)|(?:校验|检查|验证).{0,12}(?:完整性.{0,12}一致性|一致性.{0,12}完整性)/u,
    negative: /(?:不涉及|不进行|无需|不需要|未执行).{0,12}(?:完整性|一致性)|(?:完整性|一致性).{0,12}(?:不校验|无需校验|不涉及)/u,
  }],
]);
const forbiddenPlaceholders = [
  "待确认",
  "以实际为准",
  "以实际上线地址为准",
  "更新此内容",
  "删除此内容",
  "最后记得",
  "仅提醒",
  "需要各位业务大大",
  "业务大大名字",
  "XXX/XXXXX",
  "xxxx年xx月xx日",
  "例子：",
  "提醒：",
];
const prdGenerationStages = [
  "collecting-prd-context",
  "structuring-prd",
  "drafting-prd",
  "validating-prd",
];

export async function executePrdHttpSmoke({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  randomUUID = nodeRandomUUID,
  sleep = nodeDelay,
} = {}) {
  const smokeId = randomUUID();
  const evidence = {
    evidenceSchemaVersion: 1,
    smokeId,
    startedAt: timestamp(now),
    result: "RUNNING",
    projectRetained: true,
    checks: [],
  };
  let projectUrl = null;

  try {
    const config = readConfig(env);
    const client = createHttpClient({
      baseUrl: config.baseUrl,
      cookie: config.sessionCookie,
      fetchImpl,
      requestTimeoutMs: config.requestTimeoutMs,
    });
    evidence.authMode = config.authMode;

    if (config.authMode === "email") {
      const response = await client.request("/api/auth/sign-in/email", {
        authenticated: false,
        body: { email: config.email, password: config.password },
        expectedStatus: 200,
        method: "POST",
      });
      const cookie = sessionCookie(response.headers);
      if (!cookie) throw smokeError("AUTH_SESSION_COOKIE_MISSING", "Email sign-in did not return a session cookie");
      client.setCookie(cookie);
      await responseJson(response, "AUTH_RESPONSE_INVALID");
    }
    pass(evidence, now, "authenticated", { mode: config.authMode });

    const identity = await client.json("/api/v1/identity/me");
    const principalId = opaqueId(identity?.id, "identity.id");
    const workspaceId = opaqueId(identity?.defaultWorkspaceId, "identity.defaultWorkspaceId");
    pass(evidence, now, "identity-ready", { principalId, workspaceId });

    const models = await client.json("/api/v1/runtime/models");
    const modelItems = Array.isArray(models?.items) ? models.items : [];
    const generateModels = modelItems.filter((model) => model?.supportedWorkflows?.includes("generate"));
    const selectedModel = config.modelId
      ? modelItems.find((model) => model?.id === config.modelId)
      : generateModels[0];
    if (!selectedModel || !selectedModel.supportedWorkflows?.includes("generate")) {
      throw smokeError(
        "RUNTIME_MODEL_UNAVAILABLE",
        "No configured runtime model is available for the generate workflow",
      );
    }
    const modelId = opaqueId(selectedModel.id, "runtimeModel.id");
    pass(evidence, now, "runtime-model-ready", {
      selection: config.modelId ? "explicit" : "catalog-first-generate",
    });

    const project = await client.json(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/projects`,
      {
        body: { title: smokeProjectTitle(smokeId, now) },
        expectedStatus: 201,
        method: "POST",
      },
    );
    const projectId = opaqueId(project?.id, "project.id");
    projectUrl = new URL(`/projects/${encodeURIComponent(projectId)}`, config.baseUrl).href;
    evidence.projectId = projectId;
    evidence.projectUrl = projectUrl;
    pass(evidence, now, "smoke-project-created", { projectId });

    const initial = await client.json(`/api/v1/projects/${encodeURIComponent(projectId)}/bootstrap`);
    const threads = Array.isArray(initial?.threads) ? initial.threads : [];
    const initialArtifacts = Array.isArray(initial?.artifacts) ? initial.artifacts : null;
    const initialNodes = Array.isArray(initial?.board?.nodes) ? initial.board.nodes : null;
    if (threads.length !== 1) {
      throw smokeError("DEFAULT_THREAD_INVALID", "A new smoke project must contain exactly one default Thread");
    }
    if (!initialArtifacts || !initialNodes || initialArtifacts.length !== 0 || initialNodes.length !== 0) {
      throw smokeError("SMOKE_PROJECT_NOT_EMPTY", "The isolated smoke project was not empty before generation");
    }
    const threadId = opaqueId(threads[0]?.id, "bootstrap.threads[0].id");
    if (initial?.selectedThreadId !== threadId) {
      throw smokeError("DEFAULT_THREAD_INVALID", "The new smoke project did not select its default Thread");
    }
    evidence.threadId = threadId;
    pass(evidence, now, "default-thread-ready", { threadId });

    const intent = await client.json(
      `/api/v1/threads/${encodeURIComponent(threadId)}/submission-intents`,
      {
        body: {
          request: {
            prompt: smokePrompt(),
            modelId,
            workflow: "generate",
            generationIntent: null,
            targetSurface: "web",
            designStyle: { kind: "automatic" },
            sourceIds: [],
            artifactTargets: [],
            requestedArtifactKinds: ["prd"],
            canvasSnapshot: null,
          },
          attachments: [],
        },
        expectedStatus: 201,
        headers: { "Idempotency-Key": `prd-http-smoke-intent-${smokeId}` },
        method: "POST",
      },
    );
    const intentId = opaqueId(intent?.id, "submissionIntent.id");
    if (intent?.status !== "pending") {
      throw smokeError("SUBMISSION_INTENT_STATE_INVALID", "New SubmissionIntent was not pending");
    }
    pass(evidence, now, "submission-intent-created", { intentId });

    const submitted = await client.json(
      `/api/v1/submission-intents/${encodeURIComponent(intentId)}/submit`,
      { expectedStatus: 202, method: "POST" },
    );
    const runId = opaqueId(submitted?.run?.id, "submit.run.id");
    if (
      submitted?.intent?.id !== intentId
      || submitted?.intent?.runId !== runId
      || submitted?.intent?.status !== "submitted"
    ) {
      throw smokeError("SUBMISSION_RUN_BINDING_INVALID", "Submitted intent did not bind to its returned Run");
    }
    assertOnlyPrdRequested(submitted.run);
    const requestId = opaqueId(submitted?.run?.requestId, "submit.run.requestId");
    evidence.runId = runId;
    pass(evidence, now, "prd-run-submitted", { runId });

    const { run, statuses } = await waitForRun({
      client,
      deadline: Date.now() + config.timeoutMs,
      pollIntervalMs: config.pollIntervalMs,
      projectId,
      requestId,
      runId,
      sleep,
      threadId,
    });
    if (run.status !== "succeeded") {
      const remoteCode = safeCode(run?.failure?.code) ?? safeCode(run?.status) ?? "RUN_NOT_SUCCEEDED";
      throw smokeError("PRD_RUN_FAILED", `PRD Run ended without success (${remoteCode})`);
    }
    if (run.progress !== 1 || run.failure !== null) {
      throw smokeError("PRD_RUN_SUCCESS_INVALID", "Succeeded PRD Run did not report complete, failure-free state");
    }
    if (!Number.isInteger(run.attempt) || run.attempt < 1) {
      throw smokeError("PRD_RUN_ATTEMPT_INVALID", "Succeeded PRD Run did not report a positive execution attempt");
    }
    const runAttempt = run.attempt;
    pass(evidence, now, "prd-run-succeeded", { statuses });

    const artifactPage = await client.json(
      `/api/v1/projects/${encodeURIComponent(projectId)}/artifacts?limit=100`,
    );
    const artifacts = Array.isArray(artifactPage?.items) ? artifactPage.items : [];
    if (artifactPage?.nextCursor !== null) {
      throw smokeError("ARTIFACT_PAGE_UNBOUNDED", "Smoke project returned more than one Artifact page");
    }
    const runArtifacts = artifacts.filter((artifact) => artifact?.currentVersion?.createdByRunId === runId);
    if (runArtifacts.some((artifact) => artifact?.kind === "prototype")) {
      throw smokeError("PROTOTYPE_ARTIFACT_FORBIDDEN", "PRD-only smoke produced a Prototype Artifact");
    }
    const prdArtifacts = runArtifacts.filter((artifact) => artifact?.kind === "prd");
    if (runArtifacts.length !== 1 || prdArtifacts.length !== 1) {
      throw smokeError(
        "PRD_ARTIFACT_CARDINALITY_INVALID",
        "PRD-only smoke Run must produce exactly one PRD Artifact",
      );
    }
    const artifact = prdArtifacts[0];
    const artifactId = opaqueId(artifact?.id, "artifact.id");
    const artifactVersionId = opaqueId(
      artifact?.currentVersion?.artifactVersionId,
      "artifact.currentVersion.artifactVersionId",
    );
    if (
      artifact?.currentVersion?.status !== "ready"
      || artifact?.currentVersion?.kind !== "prd"
      || artifact?.currentVersion?.schemaVersion !== 2
      || artifact?.currentVersion?.createdByRunId !== runId
    ) {
      throw smokeError("PRD_ARTIFACT_NOT_READY_V2", "Current PRD ArtifactVersion is not the ready v2 output of the smoke Run");
    }
    evidence.artifactId = artifactId;
    evidence.artifactVersionId = artifactVersionId;
    pass(evidence, now, "ready-prd-artifact-found", { artifactId, artifactVersionId });

    const runEvents = await replayRunEvents(client, runId);
    const eventIdentityMismatch = runEvents.find((event) => (
      event.projectId !== projectId
      || event.threadId !== threadId
      || event.runId !== runId
      || event.requestId !== requestId
    ));
    if (eventIdentityMismatch) {
      throw smokeError(
        "PRD_RUN_EVENT_IDENTITY_INVALID",
        "PRD Run event replay contains an event from a different project, Thread, Run, or request",
      );
    }
    const unexpectedGenerationStage = runEvents.find((event) => (
      event.type === "run.generation.stage.changed"
      && event.payload.stage !== "thinking"
      && !prdGenerationStages.includes(event.payload.stage)
    ));
    if (unexpectedGenerationStage) {
      throw smokeError(
        "PRD_GENERATION_STAGES_INVALID",
        "PRD Run persisted a non-PRD generation stage",
      );
    }
    const generationStageEvents = runEvents.filter((event) => (
      event.type === "run.generation.stage.changed"
      && prdGenerationStages.includes(event.payload.stage)
    ));
    const observedStages = generationStageEvents.map((event) => event.payload.stage);
    if (
      observedStages.length !== prdGenerationStages.length
      || observedStages.some((stage, index) => stage !== prdGenerationStages[index])
      || generationStageEvents.some((event) => event.payload.attempt !== runAttempt)
    ) {
      throw smokeError(
        "PRD_GENERATION_STAGES_INVALID",
        "PRD Run did not persist the four real template-generation stages exactly once and in order",
      );
    }
    pass(evidence, now, "prd-generation-stages-verified", {
      sequences: generationStageEvents.map((event) => event.sequence),
      stages: observedStages,
    });

    const draftEvent = runEvents.find((event) => (
      event.type === "artifact.draft.created"
      && event.payload.kind === "prd"
      && event.payload.artifactId === artifactId
      && event.payload.artifactVersionId === artifactVersionId
      && event.payload.attempt === runAttempt
    ));
    if (!draftEvent) {
      throw smokeError(
        "PRD_DRAFT_EVENT_MISSING",
        "PRD Run did not publish a real artifact.draft.created event for its ready ArtifactVersion",
      );
    }
    if (draftEvent.sequence <= generationStageEvents.at(-1).sequence) {
      throw smokeError(
        "PRD_DRAFT_EVENT_ORDER_INVALID",
        "PRD draft was published before the validation stage completed",
      );
    }
    pass(evidence, now, "prd-draft-event-verified", {
      artifactIndex: draftEvent.payload.artifactIndex,
      sequence: draftEvent.sequence,
    });

    const rawVersion = await client.json(
      `/api/v1/artifacts/${encodeURIComponent(artifactId)}/versions/${encodeURIComponent(artifactVersionId)}`,
    );
    const parsedVersion = artifactVersionDetailSchema.safeParse(rawVersion);
    if (!parsedVersion.success) {
      throw contractError("ARTIFACT_VERSION_CONTRACT_INVALID", parsedVersion.error);
    }
    const version = parsedVersion.data;
    if (
      version.contentMode !== "inline"
      || version.kind !== "prd"
      || version.schemaVersion !== 2
      || version.content.protocol !== "workbench.prd.v2"
    ) {
      throw smokeError("PRD_V2_PROTOCOL_REQUIRED", "Ready ArtifactVersion is not inline workbench.prd.v2 with schemaVersion 2");
    }
    if (
      version.artifactId !== artifactId
      || version.artifactVersionId !== artifactVersionId
      || version.createdByRunId !== runId
    ) {
      throw smokeError("PRD_VERSION_IDENTITY_INVALID", "Ready PRD ArtifactVersion identity does not match the smoke Run");
    }
    if (draftEvent.payload.checksum !== version.checksum) {
      throw smokeError(
        "PRD_DRAFT_CHECKSUM_INVALID",
        "PRD draft event checksum does not match the ready ArtifactVersion checksum",
      );
    }
    const canonicalContentChecksum = createHash("sha256")
      .update(canonicalJson(version.content))
      .digest("hex");
    if (version.checksum !== canonicalContentChecksum) {
      throw smokeError(
        "PRD_VERSION_CHECKSUM_INVALID",
        "Ready PRD ArtifactVersion checksum does not match its canonical content",
      );
    }
    const structure = assertPrdV2Structure(version.content);
    pass(evidence, now, "prd-v2-contract-verified", structure);
    const semantics = assertPrdSmokeBusinessSemantics(version.content);
    pass(evidence, now, "prd-business-semantics-verified", semantics);

    const completed = await client.json(
      `/api/v1/projects/${encodeURIComponent(projectId)}/bootstrap?threadId=${encodeURIComponent(threadId)}`,
    );
    const nodes = Array.isArray(completed?.board?.nodes) ? completed.board.nodes : [];
    if (nodes.some((node) => node?.data?.artifactKind === "prototype")) {
      throw smokeError("PROTOTYPE_BOARD_NODE_FORBIDDEN", "PRD-only smoke added a Prototype Board node");
    }
    const prdNode = nodes.find((node) => (
      node?.artifactId === artifactId
      && node?.artifactVersionId === artifactVersionId
      && node?.data?.artifactKind === "prd"
    ));
    if (!prdNode || prdNode?.size?.width !== 500 || prdNode?.size?.height !== 500) {
      throw smokeError("PRD_BOARD_NODE_INVALID", "Ready PRD was not pinned as a 500 by 500 Board node");
    }
    pass(evidence, now, "prd-board-node-verified", { height: 500, width: 500 });

    evidence.finishedAt = timestamp(now);
    evidence.result = "PASS";
    return { evidence, failure: null, ok: true };
  } catch (error) {
    const failure = safeFailure(error);
    evidence.finishedAt = timestamp(now);
    evidence.result = "FAIL";
    evidence.failure = {
      afterCheck: evidence.checks.at(-1)?.name ?? null,
      code: failure.code,
    };
    if (projectUrl) evidence.projectUrl = projectUrl;
    return { evidence, failure, ok: false };
  }
}

function readConfig(env) {
  if (env.WORKBENCH_PRD_SMOKE_CONFIRM_WRITE?.trim() !== writeConfirmation) {
    throw smokeError(
      "WRITE_CONFIRMATION_REQUIRED",
      `WORKBENCH_PRD_SMOKE_CONFIRM_WRITE must equal ${writeConfirmation}`,
    );
  }
  const allowHttp = env.NODE_ENV === "test" && env.WORKBENCH_PRD_SMOKE_ALLOW_HTTP === "1";
  const baseUrl = origin(required(env, "WORKBENCH_PRD_SMOKE_BASE_URL"), allowHttp);
  const sessionCookieValue = optional(env, "WORKBENCH_PRD_SMOKE_SESSION_COOKIE");
  const email = optional(env, "WORKBENCH_PRD_SMOKE_EMAIL");
  const password = optional(env, "WORKBENCH_PRD_SMOKE_PASSWORD");
  if (sessionCookieValue && (email || password)) {
    throw smokeError("AUTH_MODE_AMBIGUOUS", "Use either an existing session cookie or email/password, not both");
  }
  if (!sessionCookieValue && (!email || !password)) {
    throw smokeError("AUTH_CONFIGURATION_REQUIRED", "Provide a session cookie or both smoke email and password");
  }
  if ((email && !password) || (!email && password)) {
    throw smokeError("AUTH_CONFIGURATION_INCOMPLETE", "Smoke email and password must be configured together");
  }
  const sessionCookie = sessionCookieValue ? normalizeCookie(sessionCookieValue) : "";
  const timeoutMs = boundedInteger(env, "WORKBENCH_PRD_SMOKE_TIMEOUT_MS", 900_000, allowHttp ? 100 : 30_000, 3_600_000);
  const pollIntervalMs = boundedInteger(env, "WORKBENCH_PRD_SMOKE_POLL_INTERVAL_MS", 2_000, allowHttp ? 1 : 250, 30_000);
  const requestTimeoutMs = boundedInteger(env, "WORKBENCH_PRD_SMOKE_REQUEST_TIMEOUT_MS", 30_000, allowHttp ? 100 : 1_000, 120_000);
  if (pollIntervalMs >= timeoutMs) {
    throw smokeError("POLL_INTERVAL_INVALID", "Smoke poll interval must be shorter than its total timeout");
  }
  const modelId = optional(env, "WORKBENCH_PRD_SMOKE_MODEL_ID");
  if (modelId && (modelId.length > 128 || /[\x00-\x1f\x7f]/u.test(modelId))) {
    throw smokeError("MODEL_ID_INVALID", "Smoke model id is invalid");
  }
  return {
    authMode: sessionCookie ? "session-cookie" : "email",
    baseUrl,
    email,
    modelId,
    password,
    pollIntervalMs,
    requestTimeoutMs,
    sessionCookie,
    timeoutMs,
  };
}

function createHttpClient({ baseUrl, cookie, fetchImpl, requestTimeoutMs }) {
  let activeCookie = cookie;
  return {
    setCookie(value) {
      activeCookie = normalizeCookie(value);
    },
    async json(pathname, options = {}) {
      return responseJson(await this.request(pathname, options), "HTTP_JSON_INVALID");
    },
    async request(pathname, options = {}) {
      const method = options.method ?? "GET";
      const url = new URL(pathname, baseUrl);
      if (url.origin !== baseUrl.origin) throw smokeError("REQUEST_ORIGIN_INVALID", "Smoke request escaped the configured Web origin");
      const headers = new Headers(options.headers ?? {});
      if (!headers.has("Accept")) headers.set("Accept", "application/json");
      headers.set("User-Agent", "workbench-production-prd-http-smoke/1");
      if (options.authenticated !== false && activeCookie) headers.set("Cookie", activeCookie);
      if (!["GET", "HEAD"].includes(method)) headers.set("Origin", baseUrl.origin);
      let body;
      if (options.body !== undefined) {
        headers.set("Content-Type", "application/json");
        body = JSON.stringify(options.body);
      }
      let response;
      try {
        response = await fetchImpl(url, {
          body,
          headers,
          method,
          redirect: "manual",
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
      } catch {
        throw smokeError("HTTP_REQUEST_FAILED", `${method} ${url.pathname} did not complete`);
      }
      const expected = Array.isArray(options.expectedStatus)
        ? options.expectedStatus
        : [options.expectedStatus ?? 200];
      if (!expected.includes(response.status)) {
        const remoteCode = await responseProblemCode(response);
        throw smokeError(
          "HTTP_STATUS_UNEXPECTED",
          `${method} ${url.pathname} returned ${response.status}${remoteCode ? ` (${remoteCode})` : ""}`,
        );
      }
      return response;
    },
  };
}

async function replayRunEvents(client, runId) {
  const response = await client.request(
    `/api/v1/runs/${encodeURIComponent(runId)}/events?afterSequence=0`,
    { headers: { Accept: "text/event-stream" } },
  );
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.startsWith("text/event-stream")) {
    throw smokeError("RUN_EVENT_STREAM_INVALID", "Run event replay did not return an SSE response");
  }
  const events = [];
  for (const frame of (await response.text()).split(/\r?\n\r?\n/gu)) {
    const data = frame.split(/\r?\n/gu)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    let candidate;
    try {
      candidate = JSON.parse(data);
    } catch {
      throw smokeError("RUN_EVENT_STREAM_INVALID", "Run event replay contained invalid JSON data");
    }
    const parsed = runEventSchema.safeParse(candidate);
    if (!parsed.success) throw contractError("RUN_EVENT_CONTRACT_INVALID", parsed.error);
    events.push(parsed.data);
  }
  return events;
}

async function waitForRun({ client, deadline, pollIntervalMs, projectId, requestId, runId, sleep, threadId }) {
  const statuses = [];
  while (Date.now() < deadline) {
    const run = await client.json(`/api/v1/runs/${encodeURIComponent(runId)}`);
    if (
      run?.id !== runId
      || run?.projectId !== projectId
      || run?.threadId !== threadId
      || run?.requestId !== requestId
    ) {
      throw smokeError("RUN_IDENTITY_INVALID", "Polled Run does not belong to the smoke project, Thread, and request");
    }
    assertOnlyPrdRequested(run);
    if (!statuses.includes(run.status)) statuses.push(run.status);
    if (run.status === "waiting_input") {
      throw smokeError("RUN_INPUT_REQUIRED", "PRD smoke unexpectedly requires interactive input");
    }
    if (terminalRunStatuses.has(run.status)) return { run, statuses };
    await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
  }
  throw smokeError("RUN_TIMEOUT", "PRD smoke Run did not reach a terminal status before the timeout");
}

function assertOnlyPrdRequested(run) {
  if (!run || JSON.stringify(run.requestedArtifactKinds) !== '["prd"]') {
    throw smokeError("RUN_ARTIFACT_SCOPE_INVALID", "Smoke Run did not preserve requestedArtifactKinds as PRD-only");
  }
}

export function assertPrdV2Structure(document) {
  if (!document || document.protocol !== "workbench.prd.v2") {
    throw smokeError("PRD_V2_PROTOCOL_REQUIRED", "Document protocol is not workbench.prd.v2");
  }
  if (document.revision?.status !== "draft") {
    throw smokeError("PRD_REVISION_INVALID", "Production smoke PRD revision must remain a draft");
  }
  const additionalSections = document.sections?.businessRequirements?.additionalSections;
  const expectedTableOfContents = prdTableOfContentsEntriesFor(
    Array.isArray(additionalSections) ? additionalSections.map((section) => section?.title) : [],
  );
  if (
    !Array.isArray(additionalSections)
    || document.tableOfContents?.entries?.length !== expectedTableOfContents.length
    || JSON.stringify(document.tableOfContents.entries) !== JSON.stringify(expectedTableOfContents)
  ) {
    throw smokeError("PRD_TABLE_OF_CONTENTS_INVALID", "PRD v2 table of contents does not match its fixed and optional business sections");
  }
  const channels = document.sections?.introduction?.usageScenarios?.channelTable?.rows;
  if (
    !Array.isArray(channels)
    || channels.length !== 3
    || channels.some((row, index) => row.sequence !== index + 1 || row.channel !== prdChannelKinds[index])
  ) {
    throw smokeError("PRD_CHANNEL_TABLE_INVALID", "PRD v2 does not contain the three canonical channels in order");
  }
  const diagrams = document.sections?.businessRequirements?.flowAndPages?.diagrams;
  if (
    !Array.isArray(diagrams)
    || diagrams.length !== 2
    || diagrams[0]?.kind !== "productFlow"
    || diagrams[0]?.title !== "图1 产品流程图"
    || diagrams[1]?.kind !== "productArchitecture"
    || diagrams[1]?.title !== "图2 产品架构图"
  ) {
    throw smokeError("PRD_DIAGRAMS_INVALID", "PRD v2 does not contain product flow and product architecture diagrams");
  }
  const degradation = document.sections?.degradation;
  const degradationText = inlinePlainText(degradation?.content).trim();
  if (degradation?.applicable === false && degradationText !== "不涉及") {
    throw smokeError("PRD_DEGRADATION_INVALID", "Non-applicable degradation must contain only the canonical marker");
  }
  if (degradation?.applicable === true) {
    const chineseCharacters = [...degradationText.matchAll(/[\u3400-\u9fff]/gu)].length;
    if (chineseCharacters < 100) {
      throw smokeError("PRD_DEGRADATION_INVALID", "Applicable degradation must contain a concrete plan of at least 100 Chinese characters");
    }
  }
  if (typeof degradation?.applicable !== "boolean") {
    throw smokeError("PRD_DEGRADATION_INVALID", "PRD v2 degradation applicability is missing");
  }
  const safetyRows = document.sections?.safetyBaseline?.rows;
  if (
    !Array.isArray(safetyRows)
    || safetyRows.length !== 21
    || safetyRows.some((row, index) => row.sequence !== prdSafetyBaselineItems[index]?.sequence)
  ) {
    throw smokeError("PRD_SAFETY_BASELINE_INVALID", "PRD v2 does not contain all 21 canonical safety rows in order");
  }
  if (stringValues(document).some((value) => forbiddenPlaceholders.some((placeholder) => value.includes(placeholder)))) {
    throw smokeError("PRD_PLACEHOLDER_FORBIDDEN", "PRD v2 contains forbidden placeholder wording");
  }
  return {
    channelCount: channels.length,
    degradation: degradation.applicable ? "concrete" : "not-applicable",
    diagramCount: diagrams.length,
    protocol: document.protocol,
    revisionStatus: document.revision.status,
    safetyRowCount: safetyRows.length,
    schemaVersion: 2,
    tableOfContentsCount: document.tableOfContents.entries.length,
  };
}

export function assertPrdSmokeBusinessSemantics(document) {
  if (
    document.title !== "电商订单状态通知设置需求说明书"
    || document.cover?.workOrderName !== "电商订单状态通知设置"
    || document.cover?.title !== "电商订单状态通知设置需求说明书"
  ) {
    throw smokeError("PRD_SMOKE_TOPIC_INVALID", "PRD title and cover do not match the requested order-notification topic");
  }
  const channels = document.sections?.introduction?.usageScenarios?.channelTable?.rows;
  if (
    channels?.[0]?.enabled !== true
    || channels?.[1]?.enabled !== false
    || channels?.[2]?.enabled !== false
  ) {
    throw smokeError("PRD_SMOKE_TOPIC_INVALID", "PRD channels do not keep only the requested in-app channel enabled");
  }

  const safetyRows = document.sections?.safetyBaseline?.rows;
  if (!Array.isArray(safetyRows) || safetyRows.length !== prdSafetyBaselineItems.length) {
    throw smokeError("PRD_SMOKE_SAFETY_INVALID", "PRD safety baseline is incomplete");
  }
  for (const row of safetyRows) {
    const expectedApplicability = row.sequence === 1 || row.sequence === 2 || row.sequence === 21
      ? "是"
      : "不涉及";
    if (row.applicability !== expectedApplicability) {
      throw smokeError(
        "PRD_SMOKE_SAFETY_INVALID",
        `PRD safety row ${row.sequence} does not match the explicit order-notification facts`,
      );
    }
    if (expectedApplicability === "不涉及" && row.remarks !== null) {
      throw smokeError(
        "PRD_SMOKE_SAFETY_INVALID",
        `PRD safety row ${row.sequence} must not carry an unrelated remark`,
      );
    }
    const expectedRemarkRule = smokeSafetyRemarkRules.get(row.sequence);
    if (
      expectedApplicability === "是"
      && (
        typeof row.remarks !== "string"
        || row.remarks.trim() === ""
        || !expectedRemarkRule?.positive.test(row.remarks)
        || expectedRemarkRule.negative.test(row.remarks)
      )
    ) {
      throw smokeError(
        "PRD_SMOKE_SAFETY_INVALID",
        `PRD safety row ${row.sequence} is missing evidence for its own canonical meaning`,
      );
    }
  }

  const introduction = document.sections?.introduction;
  const businessRequirements = document.sections?.businessRequirements;
  const degradation = document.sections?.degradation;
  const visibleText = visibleTextSegments({
    businessRequirements,
    degradation,
    introduction,
  }).join("\n");
  const sourceBoundaryViolation = tableDefaultValueViolation(document)
    ?? tableCategoryValueViolation(document)
    ?? semanticTextSegments(document)
    .map((value) => (
      value.match(smokeRuntimeMetadataPattern)?.[0]
      ?? inventedDefaultViolation(value)
      ?? value.match(smokeInventedCategoryPattern)?.[0]
    ))
    .find(Boolean);
  if (sourceBoundaryViolation) {
    throw smokeError(
      "PRD_SMOKE_SOURCE_BOUNDARY_INVALID",
      `PRD contains Runtime metadata or an unrequested business fact: ${sourceBoundaryViolation}`,
    );
  }
  for (const requirement of smokeThemeRequirements) {
    if (!requirement.terms.some((term) => visibleText.includes(term))) {
      throw smokeError(
        "PRD_SMOKE_TOPIC_INVALID",
        `PRD does not contain the requested ${requirement.label} requirement`,
      );
    }
  }
  for (const requirement of smokeExplicitConstraintRequirements) {
    if (!requirement.pattern.test(visibleText)) {
      throw smokeError(
        "PRD_SMOKE_TOPIC_INVALID",
        `PRD does not preserve the requested ${requirement.label} constraint`,
      );
    }
  }

  const unrelatedTerm = visibleText.match(unrelatedSmokeBusinessPattern)?.[0];
  if (unrelatedTerm) {
    throw smokeError(
      "PRD_SMOKE_UNRELATED_CONTENT",
      `PRD contains unrelated task-domain content: ${unrelatedTerm}`,
    );
  }

  for (const [label, section] of [
    ["background", introduction?.background],
    ["core rules", businessRequirements?.coreRules],
    ["acceptance criteria", businessRequirements?.acceptanceCriteria],
  ]) {
    const sectionText = visibleTextSegments(section).join("\n");
    if (!smokeSectionThemePattern.test(sectionText)) {
      throw smokeError(
        "PRD_SMOKE_TOPIC_INVALID",
        `PRD ${label} is not grounded in the requested order-notification topic`,
      );
    }
  }

  const diagrams = businessRequirements?.flowAndPages?.diagrams;
  if (
    !Array.isArray(diagrams)
    || diagrams.some((diagram) => !smokeDiagramThemePattern.test(visibleTextSegments(diagram).join("\n")))
  ) {
    throw smokeError(
      "PRD_SMOKE_TOPIC_INVALID",
      "Each PRD diagram must describe the requested order-notification flow",
    );
  }

  const degradationText = visibleTextSegments(degradation).join("\n");
  if (
    degradation?.applicable !== true
    || !smokeDegradationTopicPattern.test(degradationText)
    || !smokeDegradationRecoveryPattern.test(degradationText)
  ) {
    throw smokeError(
      "PRD_SMOKE_TOPIC_INVALID",
      "PRD degradation must contain a concrete order-notification recovery plan",
    );
  }
  return {
    theme: "order-status-notification",
    themeRequirementCount: smokeThemeRequirements.length + smokeExplicitConstraintRequirements.length,
    unrelatedBusinessMatches: 0,
  };
}

function smokeProjectTitle(smokeId, now) {
  return `[SMOKE] PRD HTTP ${timestamp(now).slice(0, 10)} ${smokeId.slice(0, 8)}`;
}

function smokePrompt() {
  return [
    "这是隔离的生产验收 smoke，无需追问。",
    "请仅生成一份完整中文需求说明书，不生成原型、图片、代码或其他产物。",
    "主题：电商订单状态通知设置。目标用户是已登录消费者；支持端内通知开关、订单状态分类、发送结果记录、失败重试与权限反馈；本次不投放 WAP/H5 和小程序。",
    "通知开关不设新的默认状态，沿用消费者现有设置；订单状态分类沿用订单中心既有分类，本需求不新增或枚举分类。",
    "通知开关、订单状态分类映射和发送结果状态必须执行完整性和一致性校验。",
    "请基于这些明确前提完成可直接评审和验收的需求说明书。",
  ].join("\n");
}

function inlinePlainText(inlines) {
  if (!Array.isArray(inlines)) return "";
  return inlines.map((inline) => {
    if (!inline || typeof inline !== "object") return "";
    if (inline.type === "citation" || inline.type === "reference") return inline.label ?? "";
    return typeof inline.text === "string" ? inline.text : "";
  }).join("");
}

function stringValues(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringValues);
  if (value && typeof value === "object") return Object.values(value).flatMap(stringValues);
  return [];
}

function semanticTextSegments(value) {
  const segments = [];
  const inlineTypes = new Set(["citation", "link", "reference", "text"]);
  const visit = (current) => {
    if (typeof current === "string") {
      segments.push(current);
      return;
    }
    if (Array.isArray(current)) {
      if (
        current.length > 0
        && current.every((item) => (
          item
          && typeof item === "object"
          && inlineTypes.has(item.type)
        ))
      ) {
        segments.push(inlinePlainText(current));
        return;
      }
      for (const item of current) visit(item);
      return;
    }
    if (current && typeof current === "object") {
      for (const item of Object.values(current)) visit(item);
    }
  };
  visit(value);
  return segments;
}

function tableDefaultValueViolation(value) {
  const markerLabelPattern = /^(?:默认|初始|缺省|预设)(?:状态|值)?$/u;
  const valuePattern = /^(?:[“”"'‘’\s])*(?:开启|关闭|打开|启用|停用|是|否|true|false)(?:[“”"'‘’\s。；;]*)$/iu;
  const visit = (current) => {
    if (Array.isArray(current)) {
      for (const item of current) {
        const violation = visit(item);
        if (violation) return violation;
      }
      return undefined;
    }
    if (!current || typeof current !== "object") return undefined;
    if (current.type === "table" && Array.isArray(current.columns) && Array.isArray(current.rows)) {
      const defaultColumnIds = new Set(current.columns
        .filter((column) => markerLabelPattern.test(column?.label?.trim() ?? ""))
        .map((column) => column.id));
      for (const row of current.rows) {
        const cells = Array.isArray(row?.cells) ? row.cells : [];
        const cellTexts = cells.map((cell) => ({
          columnId: cell?.columnId,
          text: inlinePlainText(cell?.content).trim(),
        }));
        const columnValue = cellTexts.find((cell) => (
          defaultColumnIds.has(cell.columnId)
          && valuePattern.test(cell.text)
        ));
        if (columnValue) return `默认值: ${columnValue.text}`;
        if (
          cellTexts.some((cell) => markerLabelPattern.test(cell.text))
          && cellTexts.some((cell) => valuePattern.test(cell.text))
        ) {
          return `默认值: ${cellTexts.find((cell) => valuePattern.test(cell.text))?.text}`;
        }
      }
    }
    for (const item of Object.values(current)) {
      const violation = visit(item);
      if (violation) return violation;
    }
    return undefined;
  };
  return visit(value);
}

function tableCategoryValueViolation(value) {
  const columnPattern = /(?:订单状态|状态分类)/u;
  const valuePattern = /^(?:待付款|待支付|待发货|待收货|已完成|已取消|退款中|已退款|支付|发货|收货|完成|取消)$/u;
  const visit = (current) => {
    if (Array.isArray(current)) {
      for (const item of current) {
        const violation = visit(item);
        if (violation) return violation;
      }
      return undefined;
    }
    if (!current || typeof current !== "object") return undefined;
    if (current.type === "table" && Array.isArray(current.columns) && Array.isArray(current.rows)) {
      const categoryColumnIds = new Set(current.columns
        .filter((column) => columnPattern.test(column?.label ?? ""))
        .map((column) => column.id));
      for (const row of current.rows) {
        const categoryValue = (Array.isArray(row?.cells) ? row.cells : []).find((cell) => (
          categoryColumnIds.has(cell?.columnId)
          && valuePattern.test(inlinePlainText(cell?.content).trim())
        ));
        if (categoryValue) return `订单状态分类: ${inlinePlainText(categoryValue.content).trim()}`;
      }
    }
    for (const item of Object.values(current)) {
      const violation = visit(item);
      if (violation) return violation;
    }
    return undefined;
  };
  return visit(value);
}

function inventedDefaultViolation(value) {
  for (const match of value.matchAll(smokeInventedDefaultPattern)) {
    const markerOffset = match[0].search(/(?:默认|初始|缺省|预设|自动)/u);
    const markerIndex = (match.index ?? 0) + markerOffset;
    const precedingContext = value.slice(Math.max(0, markerIndex - 16), markerIndex);
    if (smokeNegatedDefaultContextPattern.test(precedingContext)) continue;
    const coordinated = precedingContext.match(smokeCoordinatedDefaultContextPattern);
    if (coordinated) {
      const firstMarkerOffset = coordinated[0].search(/(?:默认|初始|缺省|预设)/u);
      const firstMarkerIndex = markerIndex - coordinated[0].length + firstMarkerOffset;
      const firstPrecedingContext = value.slice(Math.max(0, firstMarkerIndex - 16), firstMarkerIndex);
      if (smokeNegatedDefaultContextPattern.test(firstPrecedingContext)) continue;
    }
    return match[0];
  }
  return undefined;
}

function visibleTextSegments(value) {
  const segments = [];
  const visibleKeys = new Set([
    "actor",
    "description",
    "group",
    "label",
    "notes",
    "outcome",
    "remarks",
    "statement",
    "successMetric",
    "text",
    "title",
    "trigger",
  ]);
  const visit = (current) => {
    const fragments = [];
    if (Array.isArray(current)) {
      for (const item of current) fragments.push(...visit(item));
    } else if (current && typeof current === "object") {
      for (const [key, item] of Object.entries(current)) {
        if (visibleKeys.has(key) && typeof item === "string") fragments.push(item);
        else fragments.push(...visit(item));
      }
    }
    if (fragments.length > 1) segments.push(fragments.join(""));
    return fragments;
  };
  visit(value);
  return segments;
}

async function responseJson(response, code) {
  try {
    return await response.json();
  } catch {
    throw smokeError(code, "HTTP response was not valid JSON");
  }
}

async function responseProblemCode(response) {
  try {
    const payload = await response.json();
    return safeCode(payload?.code);
  } catch {
    return null;
  }
}

function sessionCookie(headers) {
  const values = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : splitSetCookie(headers.get("set-cookie") ?? "");
  return values.map((value) => value.split(";", 1)[0]).filter(Boolean).join("; ");
}

function splitSetCookie(value) {
  return value ? value.split(/,(?=\s*[^;,=]+=[^;,]+)/u) : [];
}

function normalizeCookie(value) {
  const normalized = value.replace(/^Cookie:\s*/iu, "").trim();
  if (
    normalized.length < 3
    || normalized.length > 16_384
    || !normalized.includes("=")
    || /[\r\n\x00]/u.test(normalized)
  ) {
    throw smokeError("SESSION_COOKIE_INVALID", "Existing session cookie is invalid");
  }
  return normalized;
}

function origin(value, allowHttp) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw smokeError("BASE_URL_INVALID", "Smoke base URL must be an absolute origin");
  }
  if (
    (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:"))
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) {
    throw smokeError("BASE_URL_INVALID", "Smoke base URL must be a credential-free HTTPS origin");
  }
  return url;
}

function required(env, name) {
  const value = optional(env, name);
  if (!value) throw smokeError("CONFIG_REQUIRED", `${name} is required`);
  return value;
}

function optional(env, name) {
  const value = env[name];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function boundedInteger(env, name, fallback, minimum, maximum) {
  const raw = optional(env, name) || String(fallback);
  if (!/^[1-9]\d*$/u.test(raw)) throw smokeError("CONFIG_INTEGER_INVALID", `${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw smokeError("CONFIG_INTEGER_INVALID", `${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function opaqueId(value, field) {
  if (typeof value !== "string" || !value.trim() || value.length > 160 || /[\r\n\x00]/u.test(value)) {
    throw smokeError("OPAQUE_ID_INVALID", `${field} is missing or invalid`);
  }
  return value;
}

function contractError(code, error) {
  const path = error?.issues?.[0]?.path?.map(String).join(".") || "root";
  return smokeError(code, `Contract validation failed at ${path}`);
}

function pass(evidence, now, name, detail = {}) {
  evidence.checks.push({ ...detail, at: timestamp(now), name, status: "PASS" });
}

function timestamp(now) {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw smokeError("CLOCK_INVALID", "Smoke clock returned an invalid Date");
  }
  return value.toISOString();
}

function safeCode(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,120}$/u.test(value) ? value : null;
}

function smokeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safeFailure(error) {
  return {
    code: safeCode(error?.code) ?? "PRD_HTTP_SMOKE_FAILED",
    message: error instanceof Error ? error.message : "PRD HTTP smoke failed",
  };
}

export function smokeUsage() {
  return [
    "Production PRD HTTP smoke (creates and retains an isolated [SMOKE] project).",
    "",
    "Required:",
    "  WORKBENCH_PRD_SMOKE_BASE_URL=https://your-workbench-origin",
    `  WORKBENCH_PRD_SMOKE_CONFIRM_WRITE=${writeConfirmation}`,
    "  Either WORKBENCH_PRD_SMOKE_SESSION_COOKIE, or both:",
    "    WORKBENCH_PRD_SMOKE_EMAIL",
    "    WORKBENCH_PRD_SMOKE_PASSWORD",
    "",
    "Optional:",
    "  WORKBENCH_PRD_SMOKE_MODEL_ID",
    "  WORKBENCH_PRD_SMOKE_TIMEOUT_MS (default 900000)",
    "  WORKBENCH_PRD_SMOKE_POLL_INTERVAL_MS (default 2000)",
    "  WORKBENCH_PRD_SMOKE_REQUEST_TIMEOUT_MS (default 30000)",
  ].join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  if (process.argv.includes("--help")) {
    process.stdout.write(`${smokeUsage()}\n`);
  } else {
    const result = await executePrdHttpSmoke();
    process.stdout.write(`${JSON.stringify(result.evidence, null, 2)}\n`);
    if (!result.ok) {
      process.stderr.write(`production PRD HTTP smoke failed: ${result.failure.code}: ${result.failure.message}\n`);
      process.exitCode = 1;
    }
  }
}
