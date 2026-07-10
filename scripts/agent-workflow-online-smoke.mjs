#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const COVERAGE_SEGMENTER = new Intl.Segmenter("zh-CN", { granularity: "word" });
const COVERAGE_STOP_TOKENS = new Set([
  "与", "和", "及", "或", "的", "了", "为", "并", "在", "后", "时", "中", "内", "按", "对", "将",
  "可", "需", "应", "每个", "当前", "相关", "至少", "默认", "进行", "通过", "支持",
]);
const CHANNEL_DEFINITIONS = [
  {
    label: "端内渠道",
    aliases: /^(?:端内渠道|端内|APP|客户端)$/i,
    positive: /端内(?:渠道|入口|页面|投放)|(?:APP|客户端)(?:渠道|入口|页面|投放)/i,
    negative: /(?:不|未)(?:支持|覆盖|投放|发布到|包含).{0,10}(?:端内|APP|客户端)|(?:端内|APP|客户端).{0,10}(?:不|未)(?:支持|覆盖|投放|发布到|包含)|仅(?:支持|投放|发布到).{0,8}(?:H5|WAP|小程序)/i,
  },
  {
    label: "WAP/H5端外渠道",
    aliases: /^(?:WAP\/H5端外渠道|H5\/WAP端外渠道|WAP|H5|端外渠道)$/i,
    positive: /(?:WAP|H5)(?:端外)?(?:渠道|入口|页面|投放|上线)|端外(?:渠道|入口|页面|投放|上线)|(?:通过|发布到|投放到|覆盖|进入|访问|上线|支持).{0,12}(?:WAP|H5|端外)/i,
    negative: /(?:不|未)(?:支持|覆盖|投放|发布到|包含).{0,10}(?:WAP|H5|端外)|(?:WAP|H5|端外).{0,10}(?:不|未)(?:支持|覆盖|投放|发布到|包含)|仅(?:支持|投放|发布到).{0,8}(?:端内|小程序)/i,
  },
  {
    label: "小程序",
    aliases: /^小程序(?:渠道)?$/,
    positive: /小程序(?:渠道|入口|页面|投放|上线)|(?:通过|发布到|投放到|覆盖|进入|访问|上线|支持).{0,12}小程序/,
    negative: /(?:不|未)(?:支持|覆盖|投放|发布到|包含).{0,10}小程序|小程序.{0,10}(?:不|未)(?:支持|覆盖|投放|发布到|包含)|仅(?:支持|投放|发布到).{0,8}(?:端内|H5|WAP)/i,
  },
];
const SENSITIVE_SAFETY_ROWS = [
  { index: 13, label: "身份证/生物识别/银行卡", evidence: /身份证(?:号码|照片)?|生物识别|银行卡/ },
  { index: 15, label: "第三方页面或应用跳转", evidence: /跳转.{0,12}第三方|第三方(?:页面|应用|链接)/ },
  { index: 16, label: "第三方接口数据交互", evidence: /第三方(?:公司|系统|平台).{0,24}(?:接口|数据交互|对接)|(?:接口|数据交互|对接).{0,24}第三方(?:公司|系统|平台)/ },
];
const SAFETY_BASELINE_ROW_PATTERNS = [
  /新开发功能接口|现有功能接口逻辑变动/,
  /面向公众用户/,
  /公网暴露面/,
  /个人信息.*脱敏|脱敏展示/,
  /水印/,
  /查询条件/,
  /4A统一管理|4A要求/i,
  /未接入4A.*安全要求|通行字.*18|18项安全/i,
  /敏感词过滤/,
  /先审后发/,
  /隐私政策/,
  /双清单/,
  /身份证|生物识别|银行卡/,
  /免密登录/,
  /第三方页面|第三方应用/,
  /第三方公司.*接口|数据交互/,
  /API接口.*台账|台账填报/i,
  /加密传输|接口鉴权|访问控制/,
  /加密存储/,
  /数据采集规范/,
  /完整性和一致性校验/,
];

const DEFAULT_TOPIC = "我想做一个签到领积分的活动，请根据知识库内容生成需求文档和原型";
const topic = process.argv.slice(2).join(" ").trim() || process.env.AGENT_WORKFLOW_ONLINE_TOPIC || DEFAULT_TOPIC;
const baseUrl = normalizeBaseUrl(process.env.AGENT_WORKFLOW_ONLINE_BASE_URL || "https://aionbench.com/api");
const forwardedProto = process.env.AGENT_WORKFLOW_ONLINE_FORWARDED_PROTO?.trim();
const expectedBuildSha = await resolveExpectedBuildSha();
const selectedModel = process.env.AGENT_WORKFLOW_ONLINE_MODEL || "datatoken/datatoken-gpt-5-5";
const expectedRuntimeName = process.env.AGENT_WORKFLOW_ONLINE_EXPECTED_RUNTIME_NAME || "ai-product-workbench-lead";
// A full artifact run may include the initial generation plus two QA repair turns.
const timeoutMs = numberFromEnv("AGENT_WORKFLOW_ONLINE_TIMEOUT_MS", 1_200_000);
const requestTimeoutMs = numberFromEnv("AGENT_WORKFLOW_ONLINE_REQUEST_TIMEOUT_MS", 30_000);
const strict = process.env.AGENT_WORKFLOW_ONLINE_STRICT !== "0";
const keepConversation = process.env.AGENT_WORKFLOW_ONLINE_KEEP_CONVERSATION === "1";
const replayDir = process.env.AGENT_WORKFLOW_ONLINE_REPLAY_DIR?.trim();
const outputRoot = path.resolve(process.env.AGENT_WORKFLOW_ONLINE_OUT
  || path.join(process.cwd(), "storage", "agent-workflow-online-smoke", replayDir ? `replay-${safeStamp()}` : safeStamp()));

if (process.env.AGENT_WORKFLOW_ONLINE_SELF_TEST === "1") {
  runSelfTest();
  if (process.env.AGENT_WORKFLOW_ONLINE_BROWSER_SELF_TEST === "1") {
    await runBrowserContractSelfTest();
  }
  process.exit(0);
}

if (replayDir) {
  const replay = await replayOnlineSmoke(path.resolve(replayDir));
  console.log(JSON.stringify({
    outputRoot,
    replaySource: replay.replaySource,
    evaluation: replay.evaluation,
  }, null, 2));
  process.exit(strict && !replay.evaluation.passed ? 1 : 0);
}

await mkdir(outputRoot, { recursive: true });

const runId = safeStamp().replace(/[^0-9A-Za-z]/g, "").slice(0, 18);
const username = `codex_prod_smoke_${runId}`;
const email = `${username}@example.local`;
const password = `CodexSmoke${runId}!`;
let cookieHeader = "";
let conversationId = randomUUID();
const requests = {};
const snapshots = {};
let prototypeRender = { status: "skipped", reason: "prototype snapshot not fetched yet" };
let accountRegistered = false;
let accountCleanup = { status: "not_started" };
let isolationCheck = { status: "not_started", passed: false };

let streamResult = { status: "not_started" };
try {
  await fetchHealthSnapshot();
  if (strict && !evaluateBuildIdentity(snapshots.health?.value, expectedBuildSha).passed) {
    throw new Error(`online build identity unavailable: ${evaluateBuildIdentity(snapshots.health?.value, expectedBuildSha).evidence}`);
  }
  await requestJson("POST", "/auth/register", {
    username,
    email,
    password,
    displayName: "Codex Prod Smoke",
  });
  accountRegistered = true;
  const created = await requestJson("POST", "/conversations", {
    conversationId,
    title: `Codex 线上冒烟：${topicTitle(topic)}`,
  });
  conversationId = created?.conversation?.id ?? conversationId;

  streamResult = await streamChat();
  await fetchSnapshots();
  prototypeRender = await renderOnlinePrototype();
  isolationCheck = await runCrossUserIsolationCheck();
} catch (error) {
  streamResult = {
    ...streamResult,
    setupError: error instanceof Error ? error.message : String(error),
  };
} finally {
  if (conversationId && !keepConversation) {
    await requestJson("DELETE", `/conversations/${conversationId}`).catch(() => null);
  }

  if (accountRegistered && keepConversation) {
    accountCleanup = {
      status: "skipped_by_request",
      reason: "AGENT_WORKFLOW_ONLINE_KEEP_CONVERSATION=1 preserves the owner account and conversation",
    };
  } else if (accountRegistered) {
    try {
      const result = await requestJson("DELETE", "/auth/me");
      accountCleanup = accountCleanupEvidence(result, {
        requireThreadAttempt: ownerHasDeerFlowThread(),
      });
    } catch (error) {
      accountCleanup = {
        status: "failed",
        route: "/auth/me",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  } else {
    accountCleanup = { status: "not_required", reason: "smoke account was not created" };
  }

  const rawStream = await readTextFile(path.join(outputRoot, "stream.raw.txt"));
  const evaluation = evaluateOnlineResult(rawStream, snapshots, streamResult, prototypeRender, accountCleanup, isolationCheck, expectedBuildSha);
  const summary = {
    baseUrl,
    topic,
    outputRoot,
    username,
    email,
    conversationId,
    cookieCaptured: Boolean(cookieHeader),
    keepConversation,
    expectedBuildSha,
    streamResult,
    accountCleanup,
    isolationCheck,
    prototypeRender,
    evaluation,
    snapshots,
    requests,
    createdAt: new Date().toISOString(),
  };
  await writeFile(path.join(outputRoot, "online-smoke-summary.json"), JSON.stringify(summary, null, 2), "utf8");
  console.log(JSON.stringify({
    outputRoot,
    conversationId,
    streamResult,
    accountCleanup,
    isolationCheck,
    evaluation,
  }, null, 2));
  if (strict && !evaluation.passed) {
    process.exit(1);
  }
}

async function fetchHealthSnapshot() {
  try {
    const value = await requestJson("GET", "/system/health");
    snapshots.health = { ok: true, value };
    await writeFile(path.join(outputRoot, "health.json"), JSON.stringify(value, null, 2), "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    snapshots.health = { ok: false, error: message };
    await writeFile(path.join(outputRoot, "health.error.txt"), message, "utf8");
    throw error;
  }
}

async function streamChat() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`online stream timeout after ${timeoutMs}ms`)), timeoutMs);
  const startedAt = new Date().toISOString();
  let raw = "";
  let httpStatus = 0;

  try {
    const response = await fetch(`${baseUrl}/chat/stream`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream, text/plain, */*",
        ...(forwardedProto ? { "x-forwarded-proto": forwardedProto } : {}),
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
      },
      body: JSON.stringify({
        id: conversationId,
        message: { role: "user", parts: [{ type: "text", text: topic }] },
        selectedChatModel: selectedModel,
        selectedVisibilityType: "private",
        selectedArtifactMode: "chat",
      }),
      signal: controller.signal,
    });
    httpStatus = response.status;
    setCookies(response.headers);
    if (!response.body) throw new Error(`stream response has no body, status=${response.status}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
      await writeFile(path.join(outputRoot, "stream.raw.txt"), raw, "utf8");
    }
    raw += decoder.decode();
    await writeFile(path.join(outputRoot, "stream.raw.txt"), raw, "utf8");

    return {
      status: response.ok ? "completed" : "http_error",
      httpStatus,
      startedAt,
      endedAt: new Date().toISOString(),
      bytes: Buffer.byteLength(raw),
    };
  } catch (error) {
    await writeFile(path.join(outputRoot, "stream.raw.txt"), raw, "utf8");
    await requestJson("POST", `/chat/${conversationId}/stop`, {}).catch(() => null);
    return {
      status: "failed_or_timeout",
      httpStatus,
      startedAt,
      endedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
      bytes: Buffer.byteLength(raw),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSnapshots() {
  const routes = {
    runtimeStatus: `/conversations/${conversationId}/runtime-status`,
    messages: `/conversations/${conversationId}/messages`,
    conversation: `/conversations/${conversationId}`,
    prd: `/conversations/${conversationId}/prd/current`,
    prototype: `/conversations/${conversationId}/prototype/current`,
  };
  for (const [name, route] of Object.entries(routes)) {
    try {
      const value = await requestJson("GET", route);
      snapshots[name] = { ok: true, value };
      await writeFile(path.join(outputRoot, `${name}.json`), JSON.stringify(value, null, 2), "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      snapshots[name] = { ok: false, error: message };
      await writeFile(path.join(outputRoot, `${name}.error.txt`), message, "utf8");
    }
  }
}

async function runCrossUserIsolationCheck() {
  const ownerCookieHeader = cookieHeader;
  const verifierRunId = `${runId}iso`.slice(0, 22);
  const verifierUsername = `codex_prod_isolation_${verifierRunId}`;
  const verifierEmail = `${verifierUsername}@example.local`;
  let verifierRegistered = false;
  let verifierCookieHeader = "";
  let verifierCleanup = { status: "not_started" };
  const ownerBaselines = [];
  const probes = [];
  let setupError;
  const prdDocumentId = snapshots.prd?.value?.document?.id;
  const artifactId = snapshots.prototype?.value?.artifact?.id;
  const routes = [
    ["conversation", `/conversations/${conversationId}`],
    ["prd", `/conversations/${conversationId}/prd/current`],
    ["prototype", `/conversations/${conversationId}/prototype/current`],
    ["artifact", artifactId ? `/prototype-artifacts/${artifactId}` : ""],
    ["prd-document", prdDocumentId ? `/prd-documents/${prdDocumentId}` : ""],
  ];

  try {
    for (const [name, route] of routes) {
      if (!route) {
        ownerBaselines.push({ name, route, status: 0, passed: false, reason: "owner artifact id missing" });
        continue;
      }
      const response = await requestProbe("GET", route, `owner-baseline:${name}`);
      ownerBaselines.push({ name, route, status: response.status, passed: response.status === 200 });
    }

    cookieHeader = "";
    await requestJson("POST", "/auth/register", {
      username: verifierUsername,
      email: verifierEmail,
      password: `CodexIsolation${verifierRunId}!`,
      displayName: "Codex Isolation Smoke",
    });
    verifierRegistered = true;
    verifierCookieHeader = cookieHeader;

    for (const [name, route] of routes) {
      if (!route) {
        probes.push({ name, route, status: 0, passed: false, reason: "owner artifact id missing" });
        continue;
      }
      const response = await requestProbe("GET", route, `isolation:${name}`);
      probes.push({
        name,
        route,
        status: response.status,
        passed: response.status === 403 || response.status === 404,
      });
    }
  } catch (error) {
    setupError = error instanceof Error ? error.message : String(error);
  } finally {
    if (verifierRegistered) {
      cookieHeader = verifierCookieHeader;
      try {
        const result = await requestJson("DELETE", "/auth/me");
        verifierCleanup = accountCleanupEvidence(result, { requireThreadAttempt: false });
      } catch (error) {
        verifierCleanup = {
          status: "failed",
          route: "/auth/me",
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    } else {
      verifierCleanup = { status: "not_required", reason: "verifier account was not created" };
    }
    cookieHeader = ownerCookieHeader;
  }

  const expectedProbeCount = 5;
  const passed = !setupError
    && ownerBaselines.length === expectedProbeCount
    && ownerBaselines.every((probe) => probe.passed)
    && probes.length === expectedProbeCount
    && probes.every((probe) => probe.passed)
    && verifierCleanup.status === "passed";
  return {
    status: passed ? "passed" : "failed",
    passed,
    verifierUsername,
    ownerBaselines,
    probes,
    verifierCleanup,
    setupError,
  };
}

async function renderOnlinePrototype() {
  const artifact = snapshots.prototype?.value?.artifact;
  if (!artifact?.id) {
    return { status: "skipped", reason: "prototype artifact is not available" };
  }

  let html = typeof artifact.htmlContent === "string"
    ? artifact.htmlContent
    : typeof artifact.html === "string"
      ? artifact.html
      : "";
  const previewRoute = `/prototype-artifacts/${artifact.id}/preview`;
  const previewPath = path.join(outputRoot, "prototype-preview.html");
  const screenshotPath = path.join(outputRoot, "prototype-preview.png");

  try {
    const preview = await requestText("GET", previewRoute);
    if (preview.text.trim()) html = preview.text;
    snapshots.prototypePreview = {
      ok: true,
      value: {
        contentSecurityPolicy: preview.headers.contentSecurityPolicy,
        contentType: preview.headers.contentType,
      },
    };
    await writeFile(
      path.join(outputRoot, "prototypePreview.json"),
      JSON.stringify(snapshots.prototypePreview.value, null, 2),
      "utf8",
    );
  } catch (error) {
    snapshots.prototypePreview = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (!html.trim()) {
    return { status: "failed", reason: "prototype artifact has no html content", artifactId: artifact.id };
  }

  await writeFile(previewPath, html, "utf8");
  return renderPrototypeFile(
    previewPath,
    screenshotPath,
    artifact.id,
    snapshots.prototypePreview?.ok ? snapshots.prototypePreview.value : undefined,
  );
}

async function replayOnlineSmoke(inputRoot) {
  await mkdir(outputRoot, { recursive: true });
  const snapshotMap = {};
  for (const name of ["health", "runtimeStatus", "messages", "conversation", "prd", "prototype", "prototypePreview"]) {
    const filePath = path.join(inputRoot, `${name}.json`);
    const raw = await readTextFile(filePath);
    const value = raw ? parseJson(raw) : undefined;
    snapshotMap[name] = value
      ? { ok: true, value }
      : { ok: false, error: `snapshot missing or invalid: ${filePath}` };
  }

  const rawStream = await readTextFile(path.join(inputRoot, "stream.raw.txt"));
  const previousSummary = parseJson(await readTextFile(path.join(inputRoot, "online-smoke-summary.json"))) ?? {};
  const streamResult = previousSummary.streamResult ?? {
    status: "completed",
    httpStatus: 200,
    bytes: Buffer.byteLength(rawStream),
  };
  const artifact = snapshotMap.prototype?.value?.artifact;
  const html = typeof artifact?.htmlContent === "string"
    ? artifact.htmlContent
    : typeof artifact?.html === "string"
      ? artifact.html
      : "";
  let prototypeRender = { status: "skipped", reason: "prototype artifact is not available" };
  if (artifact?.id && html.trim()) {
    const previewPath = path.join(outputRoot, "prototype-preview.html");
    const screenshotPath = path.join(outputRoot, "prototype-preview.png");
    await writeFile(previewPath, html, "utf8");
    prototypeRender = await renderPrototypeFile(
      previewPath,
      screenshotPath,
      artifact.id,
      snapshotMap.prototypePreview?.ok ? snapshotMap.prototypePreview.value : undefined,
    );
  }

  const accountCleanup = previousSummary.accountCleanup ?? {
    status: "missing_replay_evidence",
    reason: "source summary predates account cleanup verification",
  };
  const isolationCheck = previousSummary.isolationCheck ?? {
    status: "missing_replay_evidence",
    passed: false,
    reason: "source summary predates cross-user isolation verification",
  };
  const replayExpectedBuildSha = previousSummary.expectedBuildSha ?? expectedBuildSha;
  const evaluation = evaluateOnlineResult(rawStream, snapshotMap, streamResult, prototypeRender, accountCleanup, isolationCheck, replayExpectedBuildSha);
  const replay = {
    replaySource: inputRoot,
    outputRoot,
    streamResult,
    accountCleanup,
    isolationCheck,
    expectedBuildSha: replayExpectedBuildSha,
    prototypeRender,
    evaluation,
    snapshots: snapshotMap,
    createdAt: new Date().toISOString(),
  };
  await writeFile(
    path.join(outputRoot, "online-smoke-replay-summary.json"),
    JSON.stringify(replay, null, 2),
    "utf8",
  );
  return replay;
}

async function requestText(method, route) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    signal: AbortSignal.timeout(requestTimeoutMs),
    headers: {
      ...(forwardedProto ? { "x-forwarded-proto": forwardedProto } : {}),
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
    },
  });
  setCookies(response.headers);
  const text = await response.text();
  requests[`${method} ${route}`] = {
    status: response.status,
    ok: response.ok,
    headers: {
      contentSecurityPolicy: response.headers.get("content-security-policy"),
      contentType: response.headers.get("content-type"),
    },
    body: response.ok ? `[text ${Buffer.byteLength(text)} bytes]` : text.slice(0, 500),
  };
  if (!response.ok) {
    throw new Error(`${method} ${route} -> HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  return {
    text,
    headers: {
      contentSecurityPolicy: response.headers.get("content-security-policy") ?? "",
      contentType: response.headers.get("content-type") ?? "",
    },
  };
}

async function requestJson(method, route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    signal: AbortSignal.timeout(requestTimeoutMs),
    headers: {
      "content-type": "application/json",
      ...(forwardedProto ? { "x-forwarded-proto": forwardedProto } : {}),
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  setCookies(response.headers);
  const text = await response.text();
  const json = parseJson(text);
  requests[`${method} ${route}`] = { status: response.status, ok: response.ok, body: redactRequestBody(json) };
  if (!response.ok) {
    throw new Error(`${method} ${route} -> HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  return json;
}

async function requestProbe(method, route, label) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    signal: AbortSignal.timeout(requestTimeoutMs),
    headers: {
      ...(forwardedProto ? { "x-forwarded-proto": forwardedProto } : {}),
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
    },
  });
  setCookies(response.headers);
  const responseText = await response.text();
  requests[`PROBE ${label} ${method} ${route}`] = {
    status: response.status,
    ok: response.ok,
    body: response.ok ? "[unexpected accessible response]" : responseText.slice(0, 200),
  };
  return { status: response.status, ok: response.ok };
}

async function renderPrototypeFile(htmlPath, screenshotPath, artifactId, previewPolicy) {
  const browserPath = findChromeBinary();
  const sourceHtml = await readFile(htmlPath, "utf8");
  const mobileHarnessPath = path.join(outputRoot, "prototype-mobile-viewport.html");
  const useResponsePolicy = evaluatePreviewScriptPolicy(previewPolicy).passed;
  const previewServer = useResponsePolicy ? await startHtmlServer(sourceHtml, previewPolicy) : undefined;
  if (!previewServer) await writeFile(mobileHarnessPath, viewportHarnessHtml(sourceHtml), "utf8");
  const viewports = [
    {
      name: "desktop",
      width: 1440,
      height: 1100,
      screenshotPath,
      targetUrl: previewServer?.url ?? pathToFileURL(htmlPath).href,
    },
    {
      name: "mobile",
      width: 390,
      height: 844,
      screenshotPath: path.join(path.dirname(screenshotPath), "prototype-mobile-390x844.png"),
      targetUrl: previewServer?.url ?? pathToFileURL(mobileHarnessPath).href,
    },
  ];
  if (!browserPath) {
    await previewServer?.close();
    await rm(mobileHarnessPath, { force: true }).catch(() => null);
    return {
      status: "failed",
      artifactId,
      htmlPath,
      screenshotPath,
      viewports,
      reason: "No Chrome/Chromium binary found for prototype render check.",
    };
  }

  const renders = {};
  for (const viewport of viewports) {
    const userDataDir = path.join(outputRoot, `.chrome-profile-${viewport.name}`);
    await mkdir(userDataDir, { recursive: true });
    try {
      await runHeadlessChrome(browserPath, [
        "--disable-gpu",
        "--no-sandbox",
        "--hide-scrollbars",
        "--force-device-scale-factor=1",
        `--user-data-dir=${userDataDir}`,
        `--window-size=${viewport.width},${viewport.height}`,
        `--screenshot=${viewport.screenshotPath}`,
        viewport.targetUrl,
      ]);
      const image = await analyzeScreenshot(viewport.screenshotPath);
      const nonBlankCheck = buildNonBlankCheck(image, viewport);
      renders[viewport.name] = {
        status: nonBlankCheck.passed ? "passed" : "failed",
        viewport: { width: viewport.width, height: viewport.height },
        screenshotPath: viewport.screenshotPath,
        image,
        nonBlankCheck,
      };
    } catch (error) {
      renders[viewport.name] = {
        status: "failed",
        viewport: { width: viewport.width, height: viewport.height },
        screenshotPath: viewport.screenshotPath,
        reason: summarizeCommandError(error),
      };
    } finally {
      await rm(userDataDir, { recursive: true, force: true }).catch(() => null);
    }
  }

  const browserContract = await runBrowserPrototypeContract(browserPath, htmlPath, outputRoot);
  await previewServer?.close();
  await rm(mobileHarnessPath, { force: true }).catch(() => null);
  const screenshotsPassed = viewports.every((viewport) => renders[viewport.name]?.nonBlankCheck?.passed === true);
  const passed = screenshotsPassed && browserContract.passed;
  return {
    status: passed ? "passed" : "failed",
    artifactId,
    browserPath,
    htmlPath,
    screenshotPath,
    renders,
    browserContract,
    nonBlankCheck: {
      passed: screenshotsPassed,
      desktop: renders.desktop?.nonBlankCheck,
      mobile: renders.mobile?.nonBlankCheck,
    },
  };
}

async function startHtmlServer(html, previewPolicy) {
  const server = createServer((request, response) => {
    if (request.url !== "/prototype.html") {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("not found");
      return;
    }
    response.writeHead(200, {
      "Content-Type": previewPolicy.contentType,
      "Content-Security-Policy": previewPolicy.contentSecurityPolicy,
      "Cache-Control": "no-store",
    });
    response.end(html);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("prototype validation server did not expose a TCP port");
  }
  return {
    url: `http://127.0.0.1:${address.port}/prototype.html`,
    close: () => new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    }),
  };
}

function viewportHarnessHtml(sourceHtml, collectorScript = "") {
  const srcdoc = String(sourceHtml)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body{margin:0;overflow:hidden;background:#fff}iframe{display:block;width:390px;height:844px;border:0}</style></head><body><iframe id="prototype-viewport" srcdoc="${srcdoc}"></iframe>${collectorScript}</body></html>`;
}

async function runBrowserPrototypeContract(browserPath, htmlPath, workRoot = outputRoot) {
  const instrumentedPath = path.join(workRoot, "prototype-browser-contract.html");
  const userDataDir = path.join(workRoot, ".chrome-profile-contract");
  const html = await readFile(htmlPath, "utf8");
  const instrumentation = `<script>
(() => {
  const KEY_ACTION = /保存|预览|提交|审核|发布|下线|签到|领取|登录|确认|重试|补偿|导出|上传|删除|新增|创建|发送|搜索|查询/;
  const finish = (result) => {
    const marker = document.createElement("meta");
    marker.id = "agent-smoke-browser-contract-inner";
    for (const [key, value] of Object.entries(result)) marker.dataset[key] = String(value);
    document.head.appendChild(marker);
  };
  window.addEventListener("load", () => setTimeout(async () => {
    const root = document.documentElement;
    const body = document.body;
    const clientWidth = root.clientWidth;
    const scrollWidth = Math.max(root.scrollWidth, body ? body.scrollWidth : 0);
    const buttons = [...document.querySelectorAll("button")];
    const keyButtons = buttons.flatMap((candidate) => {
      const label = (candidate.innerText || candidate.textContent || "").trim();
      const style = getComputedStyle(candidate);
      const rect = candidate.getBoundingClientRect();
      const visible = style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0"
        && rect.width > 0 && rect.height > 0;
      return KEY_ACTION.test(label) && !candidate.disabled && candidate.getAttribute("aria-disabled") !== "true" && visible
        ? [{ button: candidate, label: label.slice(0, 80) }]
        : [];
    });
    if (!keyButtons.length) {
      finish({ clientWidth, scrollWidth, noOverflow: scrollWidth <= clientWidth + 1, keyButton: "", keyButtonCount: 0, changedButtonCount: 0, stateChanged: false, mutations: 0, reason: "visible key button missing" });
      return;
    }
    let dialogCalled = false;
    let activeDialogNodes = [];
    const showDialogEvidence = (message) => {
      dialogCalled = true;
      const node = document.createElement("div");
      node.setAttribute("role", "status");
      node.textContent = String(message || "操作已执行");
      body.appendChild(node);
      activeDialogNodes.push(node);
    };
    window.alert = (message) => showDialogEvidence(message);
    window.confirm = (message) => { showDialogEvidence(message); return true; };
    document.addEventListener("click", (event) => event.preventDefault(), true);
    const formValues = () => [...document.querySelectorAll("input,select,textarea")].map((field) => field.value).join("\u0001");
    const failedButtons = [];
    let changedButtonCount = 0;
    let mutationCount = 0;
    let anyDialogCalled = false;
    for (const item of keyButtons) {
      if (!item.button.isConnected) {
        failedButtons.push(item.label + "(disconnected)");
        continue;
      }
      dialogCalled = false;
      activeDialogNodes = [];
      const before = body.innerHTML + "\u0002" + formValues();
      const mutations = [];
      const observer = new MutationObserver((records) => mutations.push(...records));
      observer.observe(body, { subtree: true, childList: true, characterData: true, attributes: true });
      item.button.click();
      await Promise.resolve();
      mutations.push(...observer.takeRecords());
      observer.disconnect();
      const after = body.innerHTML + "\u0002" + formValues();
      const changed = before !== after || mutations.length > 0 || dialogCalled;
      mutationCount += mutations.length;
      anyDialogCalled ||= dialogCalled;
      if (changed) changedButtonCount += 1;
      else failedButtons.push(item.label);
      for (const node of activeDialogNodes) node.remove();
    }
    finish({
      clientWidth,
      scrollWidth: Math.max(root.scrollWidth, body.scrollWidth),
      noOverflow: Math.max(root.scrollWidth, body.scrollWidth) <= root.clientWidth + 1,
      keyButton: keyButtons[0].label,
      keyButtonCount: keyButtons.length,
      changedButtonCount,
      failedButtons: failedButtons.join("、"),
      stateChanged: failedButtons.length === 0 && changedButtonCount === keyButtons.length,
      mutations: mutationCount,
      dialogCalled: anyDialogCalled,
    });
  }, 100));
})();
</script>`;
  const bodyCloseIndex = html.toLowerCase().lastIndexOf("</body>");
  const instrumentedHtml = bodyCloseIndex >= 0
    ? `${html.slice(0, bodyCloseIndex)}${instrumentation}${html.slice(bodyCloseIndex)}`
    : `${html}${instrumentation}`;
  const collector = `<script>
(() => {
  const frame = document.getElementById("prototype-viewport");
  const copyResult = () => {
    const source = frame.contentDocument && frame.contentDocument.getElementById("agent-smoke-browser-contract-inner");
    if (!source || document.getElementById("agent-smoke-browser-contract")) return false;
    const result = document.createElement("meta");
    result.id = "agent-smoke-browser-contract";
    for (const attribute of source.attributes) {
      if (attribute.name.startsWith("data-")) result.setAttribute(attribute.name, attribute.value);
    }
    document.head.appendChild(result);
    return true;
  };
  const timer = setInterval(() => { if (copyResult()) clearInterval(timer); }, 50);
  setTimeout(() => {
    if (copyResult() || document.getElementById("agent-smoke-browser-contract")) return;
    const result = document.createElement("meta");
    result.id = "agent-smoke-browser-contract";
    result.dataset.reason = "inner browser contract marker missing";
    document.head.appendChild(result);
    clearInterval(timer);
  }, 1400);
})();
</script>`;
  await writeFile(instrumentedPath, viewportHarnessHtml(instrumentedHtml, collector), "utf8");
  await mkdir(userDataDir, { recursive: true });
  try {
    const result = await runHeadlessChrome(browserPath, [
      "--disable-gpu",
      "--no-sandbox",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      "--virtual-time-budget=2000",
      `--user-data-dir=${userDataDir}`,
      "--window-size=390,844",
      "--dump-dom",
      pathToFileURL(instrumentedPath).href,
    ]);
    const dom = String(result?.stdout ?? "");
    const markerId = "agent-smoke-browser-contract";
    const marker = [...dom.matchAll(/<meta\b[^>]*>/gi)]
      .map((match) => match[0])
      .find((tag) => readHtmlAttribute(tag, "id") === markerId) ?? "";
    if (!marker) {
      return { passed: false, interactionPassed: false, noOverflowPassed: false, reason: "browser contract marker missing" };
    }
    const clientWidth = Number(readHtmlAttribute(marker, "data-client-width"));
    const scrollWidth = Number(readHtmlAttribute(marker, "data-scroll-width"));
    const interactionPassed = readHtmlAttribute(marker, "data-state-changed") === "true";
    const noOverflowPassed = readHtmlAttribute(marker, "data-no-overflow") === "true"
      && Number.isFinite(clientWidth)
      && Number.isFinite(scrollWidth)
      && scrollWidth <= clientWidth + 1;
    const keyButton = readHtmlAttribute(marker, "data-key-button");
    const keyButtonCount = Number(readHtmlAttribute(marker, "data-key-button-count"));
    const changedButtonCount = Number(readHtmlAttribute(marker, "data-changed-button-count"));
    const failedButtons = readHtmlAttribute(marker, "data-failed-buttons");
    const allKeyButtonsChanged = Number.isFinite(keyButtonCount)
      && keyButtonCount > 0
      && changedButtonCount === keyButtonCount
      && !failedButtons;
    const currentResult = {
      passed: interactionPassed && allKeyButtonsChanged && noOverflowPassed && Boolean(keyButton),
      interactionPassed: interactionPassed && allKeyButtonsChanged && Boolean(keyButton),
      noOverflowPassed,
      keyButton,
      keyButtonCount,
      changedButtonCount,
      failedButtons: failedButtons || undefined,
      clientWidth,
      scrollWidth,
      mutations: Number(readHtmlAttribute(marker, "data-mutations")) || 0,
      dialogCalled: readHtmlAttribute(marker, "data-dialog-called") === "true",
      reason: readHtmlAttribute(marker, "data-reason") || undefined,
    };
    return currentResult;
  } catch (error) {
    return {
      passed: false,
      interactionPassed: false,
      noOverflowPassed: false,
      reason: summarizeCommandError(error),
    };
  } finally {
    await rm(instrumentedPath, { force: true }).catch(() => null);
    await rm(userDataDir, { recursive: true, force: true }).catch(() => null);
  }
}

async function analyzeScreenshot(screenshotPath) {
  const sharp = (await import("sharp")).default;
  const source = sharp(screenshotPath);
  const metadata = await source.metadata();
  const fileBuffer = await readFile(screenshotPath);
  const { data, info } = await sharp(screenshotPath)
    .resize({ width: 256, withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const sampleCount = info.width * info.height;
  let nonWhite = 0;
  let luminanceSum = 0;
  let luminanceSqSum = 0;
  const colorBuckets = new Set();

  for (let index = 0; index < data.length; index += 4) {
    const r = data[index];
    const g = data[index + 1];
    const b = data[index + 2];
    const alpha = data[index + 3];
    if (alpha > 0 && !(r >= 245 && g >= 245 && b >= 245)) nonWhite += 1;
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    luminanceSum += luminance;
    luminanceSqSum += luminance * luminance;
    colorBuckets.add(`${r >> 4}:${g >> 4}:${b >> 4}:${alpha >> 6}`);
  }

  const luminanceMean = luminanceSum / Math.max(1, sampleCount);
  const variance = luminanceSqSum / Math.max(1, sampleCount) - luminanceMean * luminanceMean;

  return {
    width: metadata.width ?? 0,
    height: metadata.height ?? 0,
    fileSize: fileBuffer.length,
    sampleWidth: info.width,
    sampleHeight: info.height,
    nonWhiteRatio: roundNumber(nonWhite / Math.max(1, sampleCount)),
    luminanceStdDev: roundNumber(Math.sqrt(Math.max(0, variance))),
    colorBucketCount: colorBuckets.size,
  };
}

function buildNonBlankCheck(image, viewport) {
  const desktop = viewport.width >= 1000;
  const minimumFileSize = desktop ? 25_000 : 8_000;
  const passed =
    image.width >= viewport.width &&
    image.height >= viewport.height &&
    image.fileSize >= minimumFileSize &&
    image.nonWhiteRatio >= 0.08 &&
    image.luminanceStdDev >= 8 &&
    image.colorBucketCount >= 12;
  return {
    passed,
    widthOk: image.width >= viewport.width,
    heightOk: image.height >= viewport.height,
    fileSizeOk: image.fileSize >= minimumFileSize,
    expectedWidth: viewport.width,
    expectedHeight: viewport.height,
    minimumFileSize,
    nonWhiteRatio: image.nonWhiteRatio,
    luminanceStdDev: image.luminanceStdDev,
    colorBucketCount: image.colorBucketCount,
  };
}

async function runHeadlessChrome(browserPath, args) {
  try {
    return await execFileAsync(browserPath, ["--headless=new", ...args], {
      timeout: 45_000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    const text = `${error?.stderr ?? ""}\n${error?.stdout ?? ""}`;
    if (/headless=new|unrecognized|unknown option|invalid/i.test(text)) {
      return await execFileAsync(browserPath, ["--headless", ...args], {
        timeout: 45_000,
        maxBuffer: 8 * 1024 * 1024,
      });
    }
    throw error;
  }
}

function findChromeBinary() {
  const pathCandidates = ["google-chrome", "chrome", "chromium", "chromium-browser", "microsoft-edge"]
    .map((name) => findExecutableOnPath(name))
    .filter(Boolean);
  const candidates = [
    process.env.CHROME_PATH,
    process.env.BROWSER_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/opt/google/chrome/chrome",
    ...pathCandidates,
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function findExecutableOnPath(name) {
  for (const dir of String(process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function evaluateOnlineResult(rawStream, snapshotMap, result, renderResult, cleanupResult, isolationResult, expectedCommitSha) {
  const runtimeStatus = snapshotMap.runtimeStatus?.value?.latestRun?.status;
  const prdPresent = Boolean(snapshotMap.prd?.value?.document);
  const prototypePresent = Boolean(snapshotMap.prototype?.value?.artifact);
  const designState = snapshotMap.conversation?.value?.conversationDesignState;
  const streamEvents = parseStreamDataEvents(rawStream);
  const internalToolNoise = findInternalToolNoise(streamEvents);
  const visibleTextNoise = findVisibleTextNoise(streamEvents);
  const rawNoisePatterns = [
    "read_file",
    "write_todos",
    "write_file",
    "messages-tuple",
    "Updated todo list",
    "Context from AI Product Workbench",
  ];
  const rawNoiseHits = rawNoisePatterns.filter((pattern) => rawStream.includes(pattern));
  const noiseHits = [...new Set([...internalToolNoise, ...visibleTextNoise, ...rawNoiseHits])];
  const knowledgeHit = rawStream.includes("已用知识库打底") || rawStream.includes("知识库命中");
  const knowledgeMiss = rawStream.includes("知识库未命中");
  const prdQuality = evaluatePrdDocument(snapshotMap.prd?.value?.document, designState);
  const prototypeQuality = evaluatePrototypeArtifact(
    snapshotMap.prototype?.value?.artifact,
    renderResult,
    designState,
  );
  const consistency = evaluateOnlineConsistency(
    snapshotMap.prd?.value?.document,
    snapshotMap.prototype?.value?.artifact,
    renderResult,
    designState,
  );
  const finalAssistantMessage = evaluateFinalAssistantMessage(snapshotMap.messages?.value);
  const persistedMessageNoise = evaluatePersistedMessageNoise(snapshotMap.messages?.value);
  const runtimeProgress = evaluateRuntimeProgress(snapshotMap.runtimeStatus?.value);
  const buildIdentity = evaluateBuildIdentity(snapshotMap.health?.value, expectedCommitSha);
  const accountCleanupCheck = evaluateAccountCleanup(cleanupResult);
  const ownerIsolationCheck = evaluateOwnerIsolation(isolationResult);
  const previewScriptPolicy = evaluatePreviewScriptPolicy(snapshotMap.prototypePreview?.value);
  const checks = [
    {
      name: "线上版本身份可追溯",
      passed: buildIdentity.passed,
      evidence: buildIdentity.evidence,
    },
    {
      name: "线上流式生成完成",
      passed: result.status === "completed",
      evidence: `${result.status}, http=${result.httpStatus ?? 0}, bytes=${result.bytes ?? 0}`,
    },
    {
      name: "线上知识库命中",
      passed: knowledgeHit && !knowledgeMiss,
      evidence: knowledgeMiss ? "stream contains 知识库未命中" : knowledgeHit ? "knowledge hit text found" : "no knowledge hit text found",
    },
    {
      name: "线上运行状态展示知识库模型联网三段进度",
      passed: runtimeProgress.passed,
      evidence: runtimeProgress.evidence,
    },
    {
      name: "线上流不暴露工具噪音",
      passed: noiseHits.length === 0,
      evidence: noiseHits.length ? noiseHits.join(", ") : "no runtime noise patterns",
    },
    {
      name: "线上持久化消息不暴露内部工具噪音",
      passed: persistedMessageNoise.passed,
      evidence: persistedMessageNoise.evidence,
    },
    {
      name: "线上最终助手提示清晰",
      passed: finalAssistantMessage.passed,
      evidence: finalAssistantMessage.evidence,
    },
    {
      name: "线上 PRD 已落库",
      passed: prdPresent,
      evidence: prdPresent ? "document present" : "document null",
    },
    {
      name: "线上 PRD 内容结构合格",
      passed: prdQuality.structurePassed,
      evidence: prdQuality.structureEvidence,
    },
    {
      name: "线上 PRD 元数据留存知识库和补齐证据",
      passed: prdQuality.traceMetadataPassed,
      evidence: prdQuality.traceMetadataEvidence,
    },
    {
      name: "线上 PRD 知识引用可解释",
      passed: prdQuality.knowledgeRefsExplainablePassed,
      evidence: prdQuality.knowledgeRefsExplainableEvidence,
    },
    {
      name: "线上 Agent 调用覆盖核心知识组",
      passed: prdQuality.requiredKnowledgeGroupsPassed,
      evidence: prdQuality.requiredKnowledgeGroupsEvidence,
    },
    {
      name: "线上 PRD 正文不写补齐证据章节",
      passed: prdQuality.noTraceBodyPassed,
      evidence: prdQuality.noTraceBodyEvidence,
    },
    {
      name: "线上 PRD 不含运行噪音",
      passed: prdQuality.noisePassed,
      evidence: prdQuality.noiseEvidence,
    },
    {
      name: "线上 PRD 渠道表唯一且语义一致",
      passed: prdQuality.channelTablePassed,
      evidence: prdQuality.channelTableEvidence,
    },
    {
      name: "线上 PRD 安全基线 21 行且证据一致",
      passed: prdQuality.safetyBaselinePassed,
      evidence: prdQuality.safetyBaselineEvidence,
    },
    {
      name: "线上原型已落库",
      passed: prototypePresent,
      evidence: prototypePresent ? "artifact present" : "artifact null",
    },
    {
      name: "线上原型动态业务覆盖和高保真合格",
      passed: prototypeQuality.coreLabelsPassed,
      evidence: prototypeQuality.coreLabelsEvidence,
    },
    {
      name: "线上原型不含运行噪音",
      passed: prototypeQuality.noisePassed,
      evidence: prototypeQuality.noiseEvidence,
    },
    {
      name: "线上原型响应式与横向溢出防护合格",
      passed: prototypeQuality.responsivePassed,
      evidence: prototypeQuality.responsiveEvidence,
    },
    {
      name: "线上原型关键按钮具备实际交互",
      passed: prototypeQuality.interactionPassed,
      evidence: prototypeQuality.interactionEvidence,
    },
    {
      name: "线上原型预览 CSP 允许受限脚本交互",
      passed: previewScriptPolicy.passed,
      evidence: previewScriptPolicy.evidence,
    },
    {
      name: "线上运行状态成功",
      passed: runtimeStatus === "succeeded",
      evidence: runtimeStatus ?? "missing runtime status",
    },
    {
      name: "线上原型桌面和移动端预览可渲染截图",
      passed: renderResult.nonBlankCheck?.passed === true,
      evidence: renderResult.renders
        ? ["desktop", "mobile"].map((name) => {
            const check = renderResult.renders?.[name]?.nonBlankCheck;
            return check
              ? `${name}:nonWhite=${check.nonWhiteRatio},stddev=${check.luminanceStdDev},buckets=${check.colorBucketCount}`
              : `${name}:${renderResult.renders?.[name]?.reason ?? "missing"}`;
          }).join("; ")
        : renderResult.reason ?? renderResult.status,
    },
    {
      name: "线上原型 390 视口无页面级横向溢出",
      passed: renderResult.browserContract?.noOverflowPassed === true,
      evidence: renderResult.browserContract
        ? `clientWidth=${renderResult.browserContract.clientWidth ?? "missing"}, scrollWidth=${renderResult.browserContract.scrollWidth ?? "missing"}${renderResult.browserContract.reason ? `, reason=${renderResult.browserContract.reason}` : ""}`
        : renderResult.reason ?? "browser contract missing",
    },
    {
      name: "线上原型关键按钮真实点击产生可见状态变化",
      passed: renderResult.browserContract?.interactionPassed === true,
      evidence: renderResult.browserContract
        ? `buttons=${renderResult.browserContract.changedButtonCount ?? 0}/${renderResult.browserContract.keyButtonCount ?? 0}, first=${renderResult.browserContract.keyButton || "missing"}, failed=${renderResult.browserContract.failedButtons || "none"}, mutations=${renderResult.browserContract.mutations ?? 0}, dialog=${renderResult.browserContract.dialogCalled === true}${renderResult.browserContract.reason ? `, reason=${renderResult.browserContract.reason}` : ""}`
        : renderResult.reason ?? "browser contract missing",
    },
    {
      name: "线上 PRD 与原型核心规则一致",
      passed: consistency.passed,
      evidence: consistency.evidence,
    },
    {
      name: accountCleanupCheck.status === "skipped_by_request" ? "线上烟测账号按请求保留" : "线上烟测账号已清理",
      passed: accountCleanupCheck.passed,
      evidence: accountCleanupCheck.evidence,
    },
    {
      name: "线上 owner 数据跨用户隔离",
      passed: ownerIsolationCheck.passed,
      evidence: ownerIsolationCheck.evidence,
    },
  ];
  return {
    passed: checks.every((item) => item.passed),
    checks,
    prototypeRender: renderResult,
    prdQuality,
    prototypeQuality,
    consistency,
    finalAssistantMessage,
    persistedMessageNoise,
    runtimeProgress,
    buildIdentity,
    accountCleanup: accountCleanupCheck,
    ownerIsolation: ownerIsolationCheck,
    previewScriptPolicy,
  };
}

function evaluateBuildIdentity(healthSnapshot, expectedCommitSha) {
  const commitSha = String(healthSnapshot?.build?.commitSha ?? "").trim();
  const expected = String(expectedCommitSha ?? "").trim();
  const validCommit = /^[0-9a-f]{12}$/i.test(commitSha);
  const validExpected = /^[0-9a-f]{12}$/i.test(expected);
  const matches = validCommit && validExpected && commitSha.toLowerCase() === expected.toLowerCase();
  const healthContract = {
    ok: healthSnapshot?.ok === true,
    service: healthSnapshot?.service === "ai-product-workbench-api",
    phase: healthSnapshot?.phase === "deerflow-first-runtime",
    deerflowEnabled: healthSnapshot?.deerflow?.enabled === true,
    runtimeName: healthSnapshot?.deerflow?.runtimeName === expectedRuntimeName,
    model: healthSnapshot?.deerflow?.modelId === selectedModel
      || (Array.isArray(healthSnapshot?.deerflow?.models) && healthSnapshot.deerflow.models.some((model) => model?.id === selectedModel)),
  };
  const healthPassed = Object.values(healthContract).every(Boolean);
  const passed = validCommit && validExpected && matches && healthPassed;
  return {
    passed,
    commitSha: passed ? commitSha : undefined,
    expectedCommitSha: expected || undefined,
    healthContract,
    evidence: `build.commitSha=${commitSha || "missing"}, expected=${expected || "missing"}, match=${matches}; ${Object.entries(healthContract).map(([name, hit]) => `${name}=${hit}`).join(", ")}`,
  };
}

function evaluatePreviewScriptPolicy(previewSnapshot) {
  const csp = String(previewSnapshot?.contentSecurityPolicy ?? "").trim();
  const contentType = String(previewSnapshot?.contentType ?? "").trim();
  const directives = new Map(csp.split(";").map((value) => value.trim()).filter(Boolean).map((value) => {
    const [name, ...tokens] = value.split(/\s+/);
    return [name.toLowerCase(), tokens];
  }));
  const sandbox = directives.get("sandbox") ?? [];
  const scriptSources = directives.get("script-src") ?? [];
  const frameAncestors = directives.get("frame-ancestors") ?? [];
  const contract = {
    contentType: /^text\/html(?:\s*;|$)/i.test(contentType),
    sandbox: sandbox.length === 1 && sandbox[0] === "allow-scripts",
    defaultSrc: directiveIsExactly(directives, "default-src", ["'none'"]),
    scriptSrc: directiveIsExactly(directives, "script-src", ["'unsafe-inline'"]),
    styleSrc: directiveIsExactly(directives, "style-src", ["'unsafe-inline'"]),
    imageSrc: directiveIsExactly(directives, "img-src", ["data:"]),
    connectSrc: directiveIsExactly(directives, "connect-src", ["'none'"]),
    objectSrc: directiveIsExactly(directives, "object-src", ["'none'"]),
    baseUri: directiveIsExactly(directives, "base-uri", ["'none'"]),
    formAction: directiveIsExactly(directives, "form-action", ["'none'"]),
    frameAncestors: frameAncestors.includes("'self'") && !frameAncestors.includes("*"),
  };
  const passed = Boolean(csp) && Object.values(contract).every(Boolean);
  return {
    passed,
    contract,
    evidence: csp
      ? `${Object.entries(contract).map(([name, hit]) => `${name}=${hit}`).join(", ")}; content-type=${contentType || "missing"}; csp=${csp}`
      : "prototype preview Content-Security-Policy missing",
  };
}

function directiveIsExactly(directives, name, expectedTokens) {
  const actual = directives.get(name) ?? [];
  return actual.length === expectedTokens.length && expectedTokens.every((token) => actual.includes(token));
}

function ownerHasDeerFlowThread() {
  const items = Array.isArray(snapshots.messages?.value?.items) ? snapshots.messages.value.items : [];
  return items.some((item) => typeof item?.metadata?.threadId === "string" && item.metadata.threadId.trim());
}

function accountCleanupEvidence(result, options) {
  const threads = result?.deerFlowThreads ?? result?.cleanup?.deerFlowThreads;
  const attempted = Number(threads?.attempted);
  const failed = Array.isArray(threads?.failed) ? threads.failed.length : Number(threads?.failed);
  const requireThreadAttempt = options?.requireThreadAttempt === true;
  const passed = result?.success === true
    && result?.cleanupComplete === true
    && Number.isFinite(attempted)
    && attempted >= (requireThreadAttempt ? 1 : 0)
    && Number.isFinite(failed)
    && failed === 0;
  return {
    status: passed ? "passed" : "failed",
    route: "/auth/me",
    success: result?.success === true,
    cleanupComplete: result?.cleanupComplete === true,
    requireThreadAttempt,
    deerFlowThreads: {
      attempted: Number.isFinite(attempted) ? attempted : undefined,
      completed: Number.isFinite(Number(threads?.completed)) ? Number(threads.completed) : undefined,
      deleted: Number.isFinite(Number(threads?.deleted)) ? Number(threads.deleted) : undefined,
      notFound: Number.isFinite(Number(threads?.notFound)) ? Number(threads.notFound) : undefined,
      failed: Number.isFinite(failed) ? failed : undefined,
    },
    reason: passed ? undefined : `unexpected cleanup response: ${JSON.stringify(redactRequestBody(result))}`,
  };
}

function cleanupEvidencePassed(cleanupResult, requireThreadAttempt) {
  const attempted = Number(cleanupResult?.deerFlowThreads?.attempted);
  const failed = Number(cleanupResult?.deerFlowThreads?.failed);
  return cleanupResult?.status === "passed"
    && cleanupResult?.cleanupComplete === true
    && Number.isFinite(attempted)
    && attempted >= (requireThreadAttempt ? 1 : 0)
    && Number.isFinite(failed)
    && failed === 0;
}

function evaluateAccountCleanup(cleanupResult) {
  const status = String(cleanupResult?.status ?? "missing");
  const passed = cleanupEvidencePassed(cleanupResult, cleanupResult?.requireThreadAttempt === true)
    || status === "not_required"
    || status === "skipped_by_request";
  return {
    passed,
    status,
    evidence: passed
      ? status === "passed"
        ? `DELETE /auth/me -> cleanupComplete=true, threads attempted=${cleanupResult.deerFlowThreads.attempted}, failed=${cleanupResult.deerFlowThreads.failed}`
        : String(cleanupResult?.reason ?? "account not created")
      : `${status}: ${cleanupResult?.reason ?? "cleanup evidence missing"}`,
  };
}

function evaluateOwnerIsolation(isolationResult) {
  const ownerBaselines = Array.isArray(isolationResult?.ownerBaselines) ? isolationResult.ownerBaselines : [];
  const probes = Array.isArray(isolationResult?.probes) ? isolationResult.probes : [];
  const verifierCleanupPassed = cleanupEvidencePassed(isolationResult?.verifierCleanup, false);
  const passed = isolationResult?.passed === true
    && ownerBaselines.length >= 4
    && ownerBaselines.every((probe) => probe?.passed === true && probe?.status === 200)
    && probes.length >= 4
    && probes.every((probe) => probe?.passed === true && (probe?.status === 403 || probe?.status === 404))
    && verifierCleanupPassed;
  return {
    passed,
    evidence: passed
      ? `owner=${ownerBaselines.map((probe) => `${probe.name}:${probe.status}`).join(", ")}; verifier=${probes.map((probe) => `${probe.name}:${probe.status}`).join(", ")}; verifier DELETE /auth/me -> cleanupComplete=true`
      : `${isolationResult?.status ?? "missing"}; owner=${ownerBaselines.map((probe) => `${probe.name}:${probe.status || "missing"}`).join(", ") || "no baselines"}; verifier=${probes.map((probe) => `${probe.name}:${probe.status || "missing"}`).join(", ") || isolationResult?.reason || isolationResult?.setupError || "no probes"}; verifierCleanup=${isolationResult?.verifierCleanup?.status ?? "missing"}`,
  };
}

function evaluatePersistedMessageNoise(messagesSnapshot) {
  const items = Array.isArray(messagesSnapshot?.items) ? messagesSnapshot.items : [];
  const hits = [];
  for (const item of items) {
    const parts = Array.isArray(item?.metadata?.parts) ? item.metadata.parts : [];
    for (const part of parts) {
      const partType = String(part?.type ?? "");
      const toolName = String(part?.toolName ?? "");
      const toolCallId = String(part?.toolCallId ?? "");
      const isToolPart = partType === "dynamic-tool" || partType.startsWith("tool-") || Boolean(toolName || toolCallId);
      const isArtifactProtocol = toolName === "createDocument"
        || toolCallId.startsWith("prd-document-")
        || toolCallId.startsWith("prototype-artifact-");
      if (isToolPart && !isArtifactProtocol) {
        hits.push(`${item?.id ?? "message"}:${partType || "tool"}${toolName ? `:${toolName}` : ""}`);
        continue;
      }
      if (!isArtifactProtocol) {
        const textValue = flattenText({ text: part?.text, content: part?.content, output: part?.output });
        for (const noise of findRuntimeNoise(textValue)) {
          hits.push(`${item?.id ?? "message"}:${noise}`);
        }
      }
    }
  }
  const unique = [...new Set(hits)];
  return {
    passed: unique.length === 0,
    evidence: unique.length ? unique.slice(0, 12).join(", ") : "metadata.parts contains no internal tool parts or outputs",
    hits: unique,
  };
}

function evaluateRuntimeProgress(runtimeStatus) {
  const events = Array.isArray(runtimeStatus?.latestRun?.events) ? runtimeStatus.latestRun.events : [];
  const labels = events.map((event) => `${event?.label ?? ""}\n${event?.detail ?? ""}`).join("\n");
  const hits = [
    ["knowledge", /已用知识库打底|知识库命中/],
    ["model", /模型补齐|已用模型补齐业务细节/],
    ["external", /公开资料|联网|外部资料|本轮未使用公开资料补齐|公开资料补齐暂不可用/],
  ].map(([label, pattern]) => ({ label, hit: pattern.test(labels) }));
  const noiseHits = findRuntimeNoise(labels);
  return {
    passed: hits.every((item) => item.hit) && noiseHits.length === 0,
    evidence: [
      hits.map((item) => `${item.label}:${item.hit ? "hit" : "miss"}`).join(", "),
      noiseHits.length ? `noise=${noiseHits.join(", ")}` : "no runtime noise patterns",
    ].join("; "),
  };
}

function evaluateFinalAssistantMessage(messagesSnapshot) {
  const items = Array.isArray(messagesSnapshot?.items) ? messagesSnapshot.items : [];
  const assistantMessages = items.filter((item) => String(item?.role ?? "").toLowerCase() === "assistant");
  const last = assistantMessages.at(-1);
  const text = flattenText(last?.content ?? "");
  if (!last || !text) {
    return {
      passed: false,
      evidence: "assistant message missing",
      textLength: 0,
      messageId: undefined,
    };
  }

  const checks = [
    ["PRD", /PRD|需求文档|需求说明书/],
    ["原型", /原型/],
    ["QA", /QA|检查|校验|通过|未通过/],
    ["右侧画布", /右侧画布|画布|查看|继续修改/],
  ].map(([label, pattern]) => ({ label, hit: pattern.test(text) }));
  const noiseHits = findRuntimeNoise(text);
  return {
    passed: checks.every((item) => item.hit) && noiseHits.length === 0,
    evidence: [
      checks.map((item) => `${item.label}:${item.hit ? "hit" : "miss"}`).join(", "),
      noiseHits.length ? `noise=${noiseHits.join(", ")}` : "no runtime noise patterns",
    ].join("; "),
    textLength: text.length,
    messageId: last.id,
  };
}

function evaluatePrdDocument(document, designState) {
  if (!document) {
    return {
      textLength: 0,
      structurePassed: false,
      structureEvidence: "document null",
      traceMetadataPassed: false,
      traceMetadataEvidence: "document null",
      knowledgeRefsExplainablePassed: false,
      knowledgeRefsExplainableEvidence: "document null",
      requiredKnowledgeGroupsPassed: false,
      requiredKnowledgeGroupsEvidence: "document null",
      noTraceBodyPassed: false,
      noTraceBodyEvidence: "document null",
      noisePassed: false,
      noiseEvidence: "document null",
      channelTablePassed: false,
      channelTableEvidence: "document null",
      safetyBaselinePassed: false,
      safetyBaselineEvidence: "document null",
      designCoveragePassed: false,
      designCoverageEvidence: "document null",
    };
  }

  const sectionText = flattenText({ sections: document.sections ?? [] });
  const metadataText = flattenText({
    knowledgeRefs: document.knowledgeRefs,
    validationNotes: document.validationNotes,
    assumptions: document.assumptions,
  });
  const text = `${sectionText}\n${metadataText}`;
  const structureLabels = [
    ["引言/背景", /引言|项目背景|背景/],
    ["业务需求", /业务需求|核心业务规则|功能说明|验收标准/],
    ["核心流程", /核心流程\/状态\/页面要求|核心流程|状态流转|产品流程图/],
    ["产品流程图", /产品流程图|flowchart|sequenceDiagram|graph TD|graph LR/],
    ["产品架构图", /产品架构图|flowchart LR|graph LR/],
    ["降级方案", /降级|异常|补偿|重试/],
    ["安全基线", /安全基线|权限|风控|安全/],
    ["无接口章节", /本需求涉及新增\/修改的接口/],
  ];
  const structureHits = structureLabels.map(([label, pattern]) => ({
    label,
    hit: label === "无接口章节" ? !pattern.test(text) : pattern.test(text),
  }));
  const knowledgeRefs = Array.isArray(document.knowledgeRefs) ? document.knowledgeRefs : [];
  const validationNotes = Array.isArray(document.validationNotes) ? document.validationNotes : [];
  const knowledgeHit = knowledgeRefs.length > 0;
  const enrichmentHit = validationNotes.some((item) => /模型|联网|外部|补齐|公开资料|未使用公开资料/.test(String(item)));
  const hasExternalStatus = /外部补充状态|externalResearchStatus|completed|failed_non_blocking|skipped_tools_unavailable|未使用公开资料/.test(metadataText);
  const hasBoundary = /不发送|不搜索|内部路径|附件原文|真实接口|密钥|不覆盖本地知识库|隐私边界|只补充|公开资料/.test(metadataText);
  const explainableRefs = knowledgeRefs.filter((ref) => {
    if (!ref || typeof ref !== "object") return false;
    const hasSource = Boolean(ref.relatedPath || ref.sourceId || ref.knowledgeId || ref.id);
    const hasExcerpt = Boolean(ref.snippet || ref.summary || ref.content);
    const hasReason = Boolean(ref.reason || ref.score !== undefined);
    return hasSource && hasExcerpt && hasReason;
  });
  const knowledgeTypes = new Set(knowledgeRefs.map((ref) => String(ref?.type ?? "").toLowerCase()));
  const knowledgeText = flattenText(knowledgeRefs);
  const knowledgeGroupChecks = [
    ["文档规范", knowledgeTypes.has("prd_writing_rule") || /PRD标准结构|产品文档规范/i.test(knowledgeText)],
    ["原型规范", knowledgeTypes.has("prototype_rule") || /原型生成总规则|页面框架/i.test(knowledgeText)],
    ["原型资产框架", knowledgeTypes.has("prototype_asset_ref") || /高保真HTML原型框架|Axure|RP资产|HTML原型/i.test(knowledgeText)],
    ["当前业务知识", knowledgeTypes.has("business_concept") || knowledgeTypes.has("product_architecture") || knowledgeTypes.has("reference_case")],
  ].map(([label, hit]) => ({ label, hit: Boolean(hit) }));
  const designCoverage = evaluateDesignCoverage(designState, sectionText, [
    "targetUsers",
    "userScenarios",
    "pages",
    "features",
    "backendConfigs",
    "frontendRules",
    "businessRules",
    "stateRules",
    "exceptionScenarios",
    "acceptanceCriteria",
  ]);
  const traceBodyHits = [
    /联网补齐证据/.test(sectionText) ? "联网补齐证据" : "",
    /模型与联网补齐/.test(sectionText) ? "模型与联网补齐" : "",
    /外部补充状态/.test(sectionText) ? "外部补充状态" : "",
    /https:\/\/(mailchimp\.com|docs\.stripe\.com|developer\.mozilla\.org|[a-z0-9.-]+\.[a-z]{2,})/i.test(sectionText) ? "外部URL" : "",
  ].filter(Boolean);
  const noiseHits = findRuntimeNoise(text);
  const channelValidation = validateChannelTable(document);
  const safetyValidation = validateSafetyBaseline(document);
  return {
    textLength: text.length,
    structurePassed: structureHits.every((item) => item.hit) && designCoverage.passed,
    structureEvidence: `${structureHits.map((item) => `${item.label}:${item.hit ? "hit" : "miss"}`).join(", ")}; ${designCoverage.evidence}`,
    traceMetadataPassed: knowledgeHit && enrichmentHit && hasExternalStatus && hasBoundary,
    traceMetadataEvidence: `knowledgeRefs=${knowledgeRefs.length}, validationNotes=${validationNotes.length}, knowledge=${knowledgeHit ? "hit" : "miss"}, enrichment=${enrichmentHit ? "hit" : "miss"}, status=${hasExternalStatus ? "hit" : "miss"}, boundary=${hasBoundary ? "hit" : "miss"}`,
    knowledgeRefsExplainablePassed: knowledgeRefs.length >= 4 && explainableRefs.length >= Math.min(4, knowledgeRefs.length),
    knowledgeRefsExplainableEvidence: `knowledgeRefs=${knowledgeRefs.length}, explainable=${explainableRefs.length}`,
    requiredKnowledgeGroupsPassed: knowledgeGroupChecks.every((item) => item.hit),
    requiredKnowledgeGroupsEvidence: knowledgeGroupChecks.map((item) => `${item.label}:${item.hit ? "hit" : "miss"}`).join(", "),
    noTraceBodyPassed: traceBodyHits.length === 0,
    noTraceBodyEvidence: traceBodyHits.length ? `body contains ${traceBodyHits.join(", ")}` : "no trace/evidence section in PRD body",
    noisePassed: noiseHits.length === 0,
    noiseEvidence: noiseHits.length ? noiseHits.join(", ") : "no runtime noise patterns",
    channelTablePassed: channelValidation.structurePassed && channelValidation.semanticPassed,
    channelTableEvidence: `${channelValidation.structureEvidence} ${channelValidation.semanticEvidence}`,
    safetyBaselinePassed: safetyValidation.structurePassed && safetyValidation.evidencePassed,
    safetyBaselineEvidence: `${safetyValidation.structureEvidence} ${safetyValidation.evidenceEvidence}`,
    designCoveragePassed: designCoverage.passed,
    designCoverageEvidence: designCoverage.evidence,
  };
}

function validateChannelTable(document) {
  const bodyText = stringifyPrdSectionsForTables(document);
  const channelTables = parseMarkdownTables(bodyText).filter(isChannelTable);
  if (channelTables.length !== 1) {
    return {
      structurePassed: false,
      structureEvidence: `channelTables=${channelTables.length}, expected=1.`,
      semanticPassed: false,
      semanticEvidence: "channel table invalid; semantic comparison unavailable.",
    };
  }
  const table = channelTables[0];
  const channelIndex = table.headers.findIndex((header) => /渠道/.test(normalizeTableCell(header)));
  const statusIndex = table.headers.findIndex((header) => /是否投放|投放状态/.test(normalizeTableCell(header)));
  const rows = CHANNEL_DEFINITIONS.map((definition) => {
    const matches = table.rows.filter((row) => definition.aliases.test(normalizeTableCell(row[channelIndex] ?? "")));
    const selection = matches.length === 1 ? parseBinarySelection(matches[0][statusIndex] ?? "") : "invalid";
    return { definition, matches, selection };
  });
  const structurePassed = table.rows.length === 3
    && channelIndex >= 0
    && statusIndex >= 0
    && rows.every((row) => row.matches.length === 1 && row.selection !== "invalid");
  const structureEvidence = structurePassed
    ? "one channel table with 3 valid rows"
    : `rows=${table.rows.length}; ${rows.map((row) => `${row.definition.label}:count=${row.matches.length},status=${row.selection}`).join("; ")}`;
  if (!structurePassed) {
    return { structurePassed, structureEvidence, semanticPassed: false, semanticEvidence: "invalid structure" };
  }

  const evidenceText = prdBusinessEvidenceText(document);
  const conflicts = rows.flatMap(({ definition, selection }) => {
    const expected = channelExpectedSelection(evidenceText, definition.positive, definition.negative);
    return selection === expected ? [] : [`${definition.label}:table=${selection},evidence=${expected}`];
  });
  return {
    structurePassed,
    structureEvidence,
    semanticPassed: conflicts.length === 0,
    semanticEvidence: conflicts.length ? `conflicts=${conflicts.join("; ")}` : "channel selections match non-table business evidence",
  };
}

function validateSafetyBaseline(document) {
  const bodyText = stringifyPrdSectionsForTables(document);
  const safetyTables = parseMarkdownTables(bodyText).filter(isSafetyBaselineTable);
  if (safetyTables.length !== 1) {
    return {
      structurePassed: false,
      structureEvidence: `safetyTables=${safetyTables.length}, expected=1.`,
      evidencePassed: false,
      evidenceEvidence: "safety table invalid; evidence comparison unavailable.",
    };
  }
  const table = safetyTables[0];
  const indexColumn = table.headers.findIndex((header) => normalizeTableCell(header) === "序号");
  const contentColumn = table.headers.findIndex((header) => /需求安全基线内容|安全基线内容/.test(normalizeTableCell(header)));
  const statusColumn = table.headers.findIndex((header) => /是否涉及/.test(normalizeTableCell(header)));
  const indexes = table.rows.map((row) => Number(normalizeTableCell(row[indexColumn] ?? "")));
  const statuses = table.rows.map((row) => parseSafetyStatus(row[statusColumn] ?? ""));
  const rowDefinitionsMatch = SAFETY_BASELINE_ROW_PATTERNS.every((pattern, offset) => {
    const row = table.rows.find((candidate) => Number(normalizeTableCell(candidate[indexColumn] ?? "")) === offset + 1);
    return Boolean(row && pattern.test(normalizeTableCell(row[contentColumn] ?? "")));
  });
  const structurePassed = table.rows.length === 21
    && indexColumn >= 0
    && contentColumn >= 0
    && statusColumn >= 0
    && indexes.every((value, offset) => value === offset + 1)
    && statuses.every((status) => status !== "invalid")
    && rowDefinitionsMatch;
  const structureEvidence = structurePassed
    ? "one safety table with continuous rows 1-21 and valid statuses"
    : `rows=${table.rows.length}, indexes=${indexes.join(",") || "missing"}, invalidStatus=${statuses.filter((status) => status === "invalid").length}, rowDefinitions=${rowDefinitionsMatch}`;
  if (!structurePassed) {
    return { structurePassed, structureEvidence, evidencePassed: false, evidenceEvidence: "invalid structure" };
  }

  const evidenceText = prdBusinessEvidenceText(document);
  const conflicts = SENSITIVE_SAFETY_ROWS.flatMap(({ index, label, evidence }) => {
    const status = statuses[indexes.indexOf(index)];
    const bodyIncludesBehavior = hasAffirmativeEvidence(evidenceText, evidence);
    if (status === "yes" && !bodyIncludesBehavior) return [`row${index}:${label}:table=yes,body=no`];
    if (status !== "yes" && bodyIncludesBehavior) return [`row${index}:${label}:table=${status},body=yes`];
    return [];
  });
  return {
    structurePassed,
    structureEvidence,
    evidencePassed: conflicts.length === 0,
    evidenceEvidence: conflicts.length ? `bidirectional conflicts=${conflicts.join(", ")}` : "sensitive/third-party rows match non-safety design evidence bidirectionally",
  };
}

function stringifyPrdSectionsForTables(document) {
  return (Array.isArray(document?.sections) ? document.sections : []).map((section) => [
    section?.title ?? "",
    section?.content ?? "",
    ...(Array.isArray(section?.blocks) ? section.blocks.map((block) => `${block?.title ?? ""}\n${block?.content ?? ""}`) : []),
  ].join("\n")).join("\n");
}

function parseMarkdownTables(value) {
  const lines = String(value ?? "").replace(/\r\n/g, "\n").split("\n");
  const tables = [];
  for (let index = 0; index < lines.length - 1; index += 1) {
    const headers = parseMarkdownRow(lines[index]);
    const separator = parseMarkdownRow(lines[index + 1]);
    if (!headers || !separator || separator.length !== headers.length || !separator.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))) continue;
    const rows = [];
    let cursor = index + 2;
    while (cursor < lines.length) {
      const row = parseMarkdownRow(lines[cursor]);
      if (!row) break;
      rows.push(row);
      cursor += 1;
    }
    tables.push({ headers, rows, raw: lines.slice(index, cursor).join("\n") });
    index = cursor - 1;
  }
  return tables;
}

function parseMarkdownRow(line) {
  const trimmed = String(line ?? "").trim();
  if (!trimmed.includes("|") || !/^\|?.+\|?$/.test(trimmed)) return null;
  const cells = trimmed.replace(/^\|/, "").replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.replace(/\\\|/g, "|").trim());
  return cells.length >= 2 ? cells : null;
}

function isChannelTable(table) {
  const headers = table.headers.map(normalizeTableCell);
  return headers.some((header) => /活动投放的可选渠道|投放渠道/.test(header))
    && headers.some((header) => /是否投放|投放状态/.test(header));
}

function isSafetyBaselineTable(table) {
  const headers = table.headers.map(normalizeTableCell);
  return headers.some((header) => /需求安全基线内容|安全基线内容/.test(header))
    && headers.some((header) => /是否涉及/.test(header));
}

function normalizeTableCell(value) {
  return String(value ?? "").replace(/<[^>]+>/g, "").replace(/[`*_]/g, "").replace(/\s+/g, "").trim();
}

function parseBinarySelection(value) {
  const normalized = normalizeTableCell(value);
  const checkedYes = /(?:☑|☒|✅|\[[xX]\])是/.test(normalized);
  const checkedNo = /(?:☑|☒|✅|\[[xX]\])否/.test(normalized);
  if (checkedYes !== checkedNo) return checkedYes ? "yes" : "no";
  if (normalized === "是") return "yes";
  if (normalized === "否" || normalized === "不涉及") return "no";
  return "invalid";
}

function parseSafetyStatus(value) {
  const normalized = normalizeTableCell(value);
  if (normalized === "是") return "yes";
  if (normalized === "否") return "no";
  if (normalized === "不涉及") return "not_applicable";
  return "invalid";
}

function prdBusinessEvidenceText(document) {
  return (Array.isArray(document?.sections) ? document.sections : [])
    .filter((section) => !/安全基线/.test(`${section?.id ?? ""}\n${section?.title ?? ""}`))
    .map((section) => [
      section?.title ?? "",
      stripContractTables(section?.content ?? ""),
      ...(Array.isArray(section?.blocks) ? section.blocks.map((block) => stripContractTables(block?.content ?? "")) : []),
    ].join("\n"))
    .join("\n");
}

function stripContractTables(value) {
  return parseMarkdownTables(value)
    .filter((table) => isChannelTable(table) || isSafetyBaselineTable(table))
    .reduce((textValue, table) => textValue.replace(table.raw, ""), String(value ?? ""));
}

function channelExpectedSelection(textValue, positive, negative) {
  const clauses = splitEvidenceClauses(textValue);
  const positiveHit = clauses.some((clause) => hasAffirmativeEvidence(clause, positive));
  const negativeHit = clauses.some((clause) => negative.test(clause));
  if (positiveHit && negativeHit) return "conflict";
  return positiveHit ? "yes" : "no";
}

function hasAffirmativeEvidence(textValue, pattern) {
  return splitEvidenceClauses(String(textValue ?? ""))
    .some((clause) => pattern.test(clause) && !/(?:不涉及|不包含|不采集|不获取|不跳转|不对接|不支持|不覆盖|不在本期|无需|未设计|可选|候选|如需|如涉及|若涉及|按需)/.test(clause));
}

function splitEvidenceClauses(value) {
  return String(value ?? "").split(/[，,。！？；;\n]/).map((clause) => clause.trim()).filter(Boolean);
}

function evaluatePrototypeArtifact(artifact, renderResult, designState) {
  if (!artifact) {
    return {
      textLength: 0,
      coreLabelsPassed: false,
      coreLabelsEvidence: "artifact null",
      noisePassed: false,
      noiseEvidence: "artifact null",
      responsivePassed: false,
      responsiveEvidence: "artifact null",
      interactionPassed: false,
      interactionEvidence: "artifact null",
      designCoveragePassed: false,
      designCoverageEvidence: "artifact null",
    };
  }

  const text = flattenText({
    title: artifact.title,
    htmlContent: artifact.htmlContent,
    html: artifact.html,
    renderText: renderResult?.renderedText,
  });
  const noiseHits = [
    ...findRuntimeNoise(text),
    ...findPrototypeTraceNoise(text),
  ];
  const html = `${artifact.htmlContent ?? ""}\n${artifact.html ?? ""}`;
  const designCoverage = evaluateDesignCoverage(designState, text, [
    "pages",
    "features",
    "backendConfigs",
    "frontendRules",
    "businessRules",
    "stateRules",
    "exceptionScenarios",
  ]);
  const specCoverage = evaluatePrototypeSpecCoverage(designState?.prototypeSpec, text);
  const responsiveContract = evaluateResponsivePrototypeContract(html);
  const interactionContract = evaluatePrototypeInteractionContract(html);
  const highFidelityChecks = [
    ["完整HTML", /^<!doctype html>/i.test(html.trim()) && /<html[\s\S]*<style[\s\S]*<\/style>[\s\S]*<\/html>/i.test(html)],
    ["非裸HTML", /class=|data-page-id|data-component-id/i.test(html) && /border-radius|box-shadow|grid|flex|padding/i.test(html)],
    ["可评审密度", (html.match(/<(section|div|table|input|select|button)\b/gi) ?? []).length >= 25],
    ["前后台视图", /(后台|运营|管理|配置中心|工作台)/.test(text) && /(前台|用户端|客户端|用户页面|用户入口|移动端)/.test(text)],
    ["交互控件", /<(form|input|select|textarea|button)\b/i.test(html)],
    ["数据结构", /<(table|ul|ol)\b|data-grid|列表|明细|报表|记录/i.test(html)],
  ].map(([label, hit]) => ({ label, hit: Boolean(hit) }));
  return {
    textLength: text.length,
    coreLabelsPassed: highFidelityChecks.every((item) => item.hit) && designCoverage.passed && specCoverage.passed,
    coreLabelsEvidence: [
      highFidelityChecks.map((item) => `${item.label}:${item.hit ? "hit" : "miss"}`).join(", "),
      designCoverage.evidence,
      specCoverage.evidence,
    ].join("; "),
    noisePassed: noiseHits.length === 0,
    noiseEvidence: noiseHits.length ? noiseHits.join(", ") : "no runtime noise patterns",
    responsivePassed: responsiveContract.passed,
    responsiveEvidence: responsiveContract.evidence,
    interactionPassed: interactionContract.passed,
    interactionEvidence: interactionContract.evidence,
    designCoveragePassed: designCoverage.passed,
    designCoverageEvidence: designCoverage.evidence,
  };
}

function evaluateResponsivePrototypeContract(html) {
  const metaTags = String(html ?? "").match(/<meta\b[^>]*>/gi) ?? [];
  const viewportTag = metaTags.find((tag) => readHtmlAttribute(tag, "name").toLowerCase() === "viewport");
  const viewportContent = viewportTag ? readHtmlAttribute(viewportTag, "content") : "";
  const initialScale = viewportContent.match(/(?:^|,)\s*initial-scale\s*=\s*([0-9.]+)/i)?.[1];
  const viewportPassed = /(?:^|,)\s*width\s*=\s*device-width\s*(?:,|$)/i.test(viewportContent)
    && Boolean(initialScale && Number(initialScale) > 0);
  const styleText = (String(html ?? "").match(/<style\b[^>]*>[\s\S]*?<\/style>/gi) ?? []).join("\n");
  const mobileBreakpoints = [...styleText.matchAll(/@media[^\{]*max-width\s*:\s*(\d+)px/gi)]
    .map((match) => Number(match[1]));
  const mobileCssPassed = mobileBreakpoints.some((width) => width > 0 && width <= 768);
  const rootOverflowGuard = /(?:html\s*,\s*body|body\s*,\s*html|html|body)[^{]*\{[^}]*overflow-x\s*:\s*(?:hidden|clip)/i.test(styleText);
  const wideContentGuard = /overflow-x\s*:\s*auto|max-width\s*:\s*100%/i.test(styleText);
  return {
    passed: viewportPassed && mobileCssPassed && rootOverflowGuard && wideContentGuard,
    evidence: `viewport=${viewportPassed ? "valid" : viewportContent || "missing"}, mobile=${mobileCssPassed ? mobileBreakpoints.join(",") : "missing"}, root-overflow=${rootOverflowGuard ? "guarded" : "missing"}, wide-content=${wideContentGuard ? "guarded" : "missing"}`,
  };
}

function readHtmlAttribute(tag, name) {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:(["'])(.*?)\\1|([^\\s>]+))`, "i");
  const match = String(tag ?? "").match(pattern);
  return String(match?.[2] ?? match?.[3] ?? "");
}

function evaluatePrototypeInteractionContract(html) {
  const scripts = (String(html ?? "").match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) ?? [])
    .map((script) => script.replace(/^<script\b[^>]*>|<\/script>$/gi, ""))
    .join("\n");
  const keyActionPattern = /保存|预览|提交|审核|发布|下线|签到|领取|登录|确认|重试|补偿|导出|上传|删除|新增|创建|发送|搜索|查询/;
  const buttons = [...String(html ?? "").matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)]
    .map((match) => ({
      attributes: match[1],
      label: match[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(),
    }));
  const keyButtons = buttons.filter((button) =>
    keyActionPattern.test(button.label)
    && !/(?:^|\s)disabled(?:\s|=|$)|aria-disabled\s*=\s*(["'])?true\1/i.test(button.attributes),
  );
  const hasClickBinding = /addEventListener\s*\(\s*["']click["']|\.onclick\s*=|\bonclick\s*=|\.on\s*\(\s*["']click["']/i.test(`${scripts}\n${html}`);
  const hasVisibleEffect = /classList\.|textContent\s*=|innerHTML\s*=|\.hidden\s*=|style\.[a-z-]+\s*=|setAttribute\s*\(|showModal\s*\(|\balert\s*\(|\bconfirm\s*\(|location\.(?:href|assign)|\.value\s*=/i.test(`${scripts}\n${keyButtons.map((button) => button.attributes).join("\n")}`);
  const genericButtonBinding = /querySelectorAll\s*\(\s*["'][^"']*button[^"']*["']\s*\)[\s\S]{0,240}addEventListener\s*\(\s*["']click["']/i.test(scripts);
  const unbound = keyButtons.filter((button) => {
    if (/\bonclick\s*=/i.test(button.attributes) || genericButtonBinding) return false;
    const references = [
      button.attributes.match(/\bid\s*=\s*(["'])(.*?)\1/i)?.[2],
      button.attributes.match(/\bdata-action\s*=\s*(["'])(.*?)\1/i)?.[2],
      ...(button.attributes.match(/\bclass\s*=\s*(["'])(.*?)\1/i)?.[2].split(/\s+/) ?? []),
    ].filter((value) => value && value.length >= 2);
    return !references.some((reference) => scripts.includes(reference));
  });
  const hasExecutableScript = scripts.trim().length > 0 || keyButtons.some((button) => /\bonclick\s*=/i.test(button.attributes));
  const passed = keyButtons.length > 0 && hasExecutableScript && hasClickBinding && hasVisibleEffect && unbound.length === 0;
  return {
    passed,
    evidence: passed
      ? `keyButtons=${keyButtons.length}, click bindings and visible effects present`
      : `keyButtons=${keyButtons.length}, script=${hasExecutableScript ? "present" : "missing"}, click=${hasClickBinding}, effect=${hasVisibleEffect}, unbound=${unbound.map((button) => button.label).slice(0, 8).join("、") || "none"}`,
  };
}

function evaluateOnlineConsistency(document, artifact, renderResult, designState) {
  const prdText = flattenText({ sections: document?.sections ?? [] });
  const prototypeText = flattenText({
    htmlContent: artifact?.htmlContent,
    html: artifact?.html,
    renderText: renderResult?.renderedText,
  });
  const requirements = collectDesignRequirements(designState, [
    "pages",
    "features",
    "backendConfigs",
    "frontendRules",
    "businessRules",
    "stateRules",
    "exceptionScenarios",
  ]);
  const rows = requirements.map(({ group, label, item }) => ({
    name: `${group}/${label}`,
    prd: artifactCoversEntity(prdText, item),
    prototype: artifactCoversEntity(prototypeText, item),
  }));
  const matched = rows.filter((row) => row.prd && row.prototype).length;
  const ratio = rows.length ? matched / rows.length : 0;
  return {
    passed: rows.length >= 4 && ratio >= 0.75,
    evidence: rows.length
      ? `matched=${matched}/${rows.length}; ${rows.filter((row) => !row.prd || !row.prototype).slice(0, 8).map((row) => `${row.name}:PRD-${row.prd ? "hit" : "miss"}/Prototype-${row.prototype ? "hit" : "miss"}`).join(", ") || "all dynamic requirements matched"}`
      : "conversation design state has no comparable requirements",
  };
}

function evaluateDesignCoverage(designState, artifactText, keys) {
  const requirements = collectDesignRequirements(designState, keys);
  if (!requirements.length) {
    return { passed: false, evidence: "design-state requirements missing", groups: [] };
  }
  const groups = [...new Set(requirements.map((item) => item.group))].map((group) => {
    const items = requirements.filter((item) => item.group === group);
    const missing = items.filter((item) => !artifactCoversEntity(artifactText, item.item));
    const hitCount = items.length - missing.length;
    return { group, total: items.length, hitCount, missing: missing.map((item) => item.label) };
  });
  return {
    passed: groups.every((group) => group.hitCount / group.total >= 0.75),
    evidence: groups.map((group) => `${group.group}:${group.hitCount}/${group.total}${group.missing.length ? ` missing=${group.missing.slice(0, 4).join("、")}` : ""}`).join("; "),
    groups,
  };
}

function evaluatePrototypeSpecCoverage(spec, artifactText) {
  const items = [];
  for (const page of Array.isArray(spec?.pages) ? spec.pages : []) {
    addEntityCoverage(items, page);
    for (const state of Array.isArray(page?.states) ? page.states : []) addEntityCoverage(items, state);
    collectComponentCoverage(page?.components, items);
  }
  const unique = [...new Map(items.map((item) => [item.label, item])).values()];
  if (!unique.length) return { passed: false, evidence: "prototype spec labels missing" };
  const missing = unique.filter((item) => !artifactCoversEntity(artifactText, item.entity));
  const hitCount = unique.length - missing.length;
  return {
    passed: hitCount / unique.length >= 0.75,
    evidence: `prototype-spec:${hitCount}/${unique.length}${missing.length ? ` missing=${missing.slice(0, 8).map((item) => item.label).join("、")}` : ""}`,
  };
}

function collectComponentCoverage(components, output) {
  for (const component of Array.isArray(components) ? components : []) {
    addEntityCoverage(output, component);
    collectComponentCoverage(component?.children, output);
  }
}

function collectDesignRequirements(designState, keys) {
  const results = [];
  for (const key of keys) {
    for (const item of Array.isArray(designState?.[key]) ? designState[key] : []) {
      const label = entityLabel(item);
      if (label.length >= 2) results.push({ group: key, label, item });
    }
  }
  return [...new Map(results.map((item) => [`${item.group}:${item.label}`, item])).values()];
}

function addEntityCoverage(output, item) {
  const label = entityLabel(item);
  if (label.length >= 2) output.push({ label, entity: item });
}

function entityLabel(item) {
  if (!item || typeof item !== "object") return "";
  return String(item.name ?? item.title ?? item.label ?? item.role ?? "").trim();
}

function artifactContainsLabel(artifactText, label) {
  if (artifactContainsStrictLabel(artifactText, label)) return true;
  const haystack = normalizeCoverageText(artifactText);
  const tokens = coverageTokens(label);
  if (!tokens.length) return false;
  const hits = tokens.filter((token) => haystack.includes(token)).length;
  return hits >= Math.max(1, Math.ceil(tokens.length * 0.6));
}

function artifactContainsStrictLabel(artifactText, label) {
  const haystack = normalizeCoverageText(artifactText);
  const needle = normalizeCoverageText(label);
  if (!needle) return true;
  if (haystack.includes(needle)) return true;
  const parts = String(label)
    .split(/[：:、，；;\/\s]+/)
    .map(normalizeCoverageText)
    .filter((part) => part.length >= 2);
  return parts.length >= 2 && parts.filter((part) => haystack.includes(part)).length / parts.length >= 0.75;
}

function artifactCoversEntity(artifactText, entity) {
  const label = entityLabel(entity);
  if (label && artifactContainsLabel(artifactText, label)) return true;
  return Object.entries(entity ?? {}).some(([key, value]) =>
    !["id", "name", "title", "label", "role", "sourcePaths"].includes(key) &&
    artifactContainsEvidence(artifactText, typeof value === "string" ? value : undefined),
  );
}

function artifactContainsEvidence(artifactText, evidence) {
  if (!evidence) return false;
  const haystack = normalizeCoverageText(artifactText);
  const tokens = coverageTokens(evidence);
  if (!tokens.length) return false;
  const hits = tokens.filter((token) => haystack.includes(token)).length;
  const requiredHits = tokens.length <= 3
    ? Math.ceil(tokens.length * 0.6)
    : Math.min(5, Math.max(2, Math.ceil(tokens.length * 0.35)));
  return hits >= requiredHits;
}

function coverageTokens(value) {
  const tokens = [];
  let singleHanBuffer = "";
  const flushSingleHanBuffer = () => {
    if (singleHanBuffer.length >= 2) tokens.push(singleHanBuffer);
    singleHanBuffer = "";
  };

  for (const segment of COVERAGE_SEGMENTER.segment(String(value ?? "").toLowerCase())) {
    if (!segment.isWordLike) {
      flushSingleHanBuffer();
      continue;
    }
    const token = normalizeCoverageText(segment.segment);
    if (!token || COVERAGE_STOP_TOKENS.has(token)) {
      flushSingleHanBuffer();
      continue;
    }
    if (/^[\u4e00-\u9fa5]$/.test(token)) {
      singleHanBuffer += token;
      continue;
    }
    flushSingleHanBuffer();
    if (token.length >= 2) tokens.push(token);
  }
  flushSingleHanBuffer();
  return [...new Set(tokens)];
}

function normalizeCoverageText(value) {
  return String(value ?? "").toLowerCase().replace(/<[^>]+>/g, "").replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "");
}

function findRuntimeNoise(text) {
  const patterns = [
    "read_file",
    "write_todos",
    "write_file",
    "tool-input",
    "tool-output",
    "messages-tuple",
    "Updated todo list",
    "Context from AI Product Workbench",
  ];
  return patterns.filter((pattern) => text.includes(pattern));
}

function findPrototypeTraceNoise(text) {
  const patterns = [
    "知识库打底",
    "公开资料补齐",
    "模型补齐",
    "联网补齐",
    "补齐策略",
    "外部参考",
    "externalResearch",
    "Building an Effective Loyalty Program",
    "Idempotent requests",
    "429 Too Many Requests",
  ];
  return patterns.filter((pattern) => text.includes(pattern));
}

function flattenText(value) {
  const chunks = [];
  visitText(value, chunks);
  return chunks.join("\n").replace(/\s+/g, " ").trim();
}

function visitText(value, chunks) {
  if (value === null || value === undefined) return;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    chunks.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) visitText(item, chunks);
    return;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value)) visitText(item, chunks);
  }
}

function parseStreamDataEvents(rawStream) {
  return rawStream
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean)
    .map((payload) => parseJson(payload))
    .filter((event) => event && typeof event === "object" && !Array.isArray(event));
}

function findInternalToolNoise(events) {
  const toolNames = new Map();
  const noise = [];
  for (const event of events) {
    const type = String(event.type ?? "");
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
    const toolName = typeof event.toolName === "string" ? event.toolName : "";
    if (toolCallId && toolName) toolNames.set(toolCallId, toolName);
    if (!type.startsWith("tool-")) continue;
    const resolvedName = toolName || toolNames.get(toolCallId) || "";
    const isArtifactProtocol =
      resolvedName === "createDocument" ||
      toolCallId.startsWith("prd-document-") ||
      toolCallId.startsWith("prototype-artifact-");
    if (!isArtifactProtocol) {
      noise.push(`${type}${resolvedName ? `:${resolvedName}` : ""}`);
    }
  }
  return noise;
}

function findVisibleTextNoise(events) {
  const noise = [];
  const patterns = [
    "read_file",
    "write_todos",
    "write_file",
    "tool-input",
    "tool-output",
    "messages-tuple",
    "Updated todo list",
    "Context from AI Product Workbench",
  ];
  for (const event of events) {
    const type = String(event.type ?? "");
    if (type.startsWith("tool-")) continue;
    const text = [
      typeof event.text === "string" ? event.text : "",
      typeof event.delta === "string" ? event.delta : "",
      typeof event.content === "string" ? event.content : "",
      typeof event.chunk === "string" ? event.chunk : "",
    ].filter(Boolean).join("\n");
    for (const pattern of patterns) {
      if (text.includes(pattern)) noise.push(`visible-text:${pattern}`);
    }
  }
  return noise;
}

async function runBrowserContractSelfTest() {
  const browserPath = findChromeBinary();
  if (!browserPath) throw new Error("Browser self-test requires Chrome/Chromium.");
  const workRoot = await mkdtemp(path.join(tmpdir(), "aipw-browser-contract-"));
  const htmlPath = path.join(workRoot, "prototype.html");
  try {
    await writeFile(htmlPath, samplePrototypeArtifact().htmlContent, "utf8");
    const result = await runBrowserPrototypeContract(
      browserPath,
      htmlPath,
      workRoot,
    );
    if (!result.passed || result.clientWidth !== 390 || result.scrollWidth > result.clientWidth + 1) {
      throw new Error(`Browser self-test failed: ${JSON.stringify(result)}`);
    }
    await writeFile(
      htmlPath,
      '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body{overflow-x:hidden}</style></head><body><button>保存草稿</button></body></html>',
      "utf8",
    );
    const unboundResult = await runBrowserPrototypeContract(
      browserPath,
      htmlPath,
      workRoot,
    );
    if (unboundResult.passed || unboundResult.interactionPassed || !unboundResult.failedButtons?.includes("保存草稿")) {
      throw new Error(`Browser negative self-test failed: ${JSON.stringify(unboundResult)}`);
    }
    console.log(JSON.stringify({
      browserSelfTest: true,
      browserPath,
      interactionPassed: result.interactionPassed,
      noOverflowPassed: result.noOverflowPassed,
      keyButton: result.keyButton,
      keyButtonCount: result.keyButtonCount,
      changedButtonCount: result.changedButtonCount,
      clientWidth: result.clientWidth,
      scrollWidth: result.scrollWidth,
      mutations: result.mutations,
      unboundButtonRejected: true,
    }, null, 2));
  } finally {
    await rm(workRoot, { recursive: true, force: true }).catch(() => null);
  }
}

function runSelfTest() {
  const allowedArtifactProtocol = [
    "data: " + JSON.stringify({ type: "tool-input-start", toolCallId: "prd-document-1", toolName: "createDocument" }),
    "data: " + JSON.stringify({
      type: "tool-input-available",
      toolCallId: "prd-document-1",
      toolName: "createDocument",
      input: { title: "签到领积分活动需求说明书" },
    }),
    "data: " + JSON.stringify({
      type: "tool-output-available",
      toolCallId: "prd-document-1",
      toolName: "createDocument",
      output: { ok: true },
    }),
    "data: " + JSON.stringify({ type: "text-delta", text: "PRD 和原型已生成。" }),
  ].join("\n");
  const allowedEvaluation = evaluateOnlineResult(
    allowedArtifactProtocol,
    {
      health: { value: sampleHealthSnapshot() },
      runtimeStatus: { value: { latestRun: { status: "succeeded", events: sampleRuntimeEvents() } } },
      messages: { value: { items: [sampleAssistantMessage()] } },
      conversation: { value: { conversationDesignState: sampleDesignState() } },
      prd: { value: { document: samplePrdDocument() } },
      prototype: { value: { artifact: samplePrototypeArtifact() } },
      prototypePreview: { value: samplePrototypePreviewHeaders() },
    },
    { status: "completed", httpStatus: 200, bytes: Buffer.byteLength(allowedArtifactProtocol) },
    samplePrototypeRender(),
    sampleAccountCleanup(1, true),
    sampleIsolationCheck(),
    "0123456789ab",
  );
  assertCheck(allowedEvaluation, "线上版本身份可追溯", true);
  assertCheck(allowedEvaluation, "线上流不暴露工具噪音", true);
  assertCheck(allowedEvaluation, "线上持久化消息不暴露内部工具噪音", true);
  assertCheck(allowedEvaluation, "线上最终助手提示清晰", true);
  assertCheck(allowedEvaluation, "线上 PRD 元数据留存知识库和补齐证据", true);
  assertCheck(allowedEvaluation, "线上 PRD 知识引用可解释", true);
  assertCheck(allowedEvaluation, "线上 Agent 调用覆盖核心知识组", true);
  assertCheck(allowedEvaluation, "线上 PRD 正文不写补齐证据章节", true);
  assertCheck(allowedEvaluation, "线上 PRD 内容结构合格", true);
  assertCheck(allowedEvaluation, "线上 PRD 渠道表唯一且语义一致", true);
  assertCheck(allowedEvaluation, "线上 PRD 安全基线 21 行且证据一致", true);
  assertCheck(allowedEvaluation, "线上原型动态业务覆盖和高保真合格", true);
  assertCheck(allowedEvaluation, "线上原型响应式与横向溢出防护合格", true);
  assertCheck(allowedEvaluation, "线上原型关键按钮具备实际交互", true);
  assertCheck(allowedEvaluation, "线上原型预览 CSP 允许受限脚本交互", true);
  assertCheck(allowedEvaluation, "线上原型桌面和移动端预览可渲染截图", true);
  assertCheck(allowedEvaluation, "线上原型 390 视口无页面级横向溢出", true);
  assertCheck(allowedEvaluation, "线上原型关键按钮真实点击产生可见状态变化", true);
  assertCheck(allowedEvaluation, "线上 PRD 与原型核心规则一致", true);
  assertCheck(allowedEvaluation, "线上运行状态展示知识库模型联网三段进度", true);
  assertCheck(allowedEvaluation, "线上烟测账号已清理", true);
  assertCheck(allowedEvaluation, "线上 owner 数据跨用户隔离", true);
  const staleBuildIdentity = evaluateBuildIdentity(sampleHealthSnapshot(), "deadbeefdead");
  if (staleBuildIdentity.passed) {
    throw new Error(`Self-test failed for stale build identity: ${staleBuildIdentity.evidence}`);
  }

  const semanticCoverage = evaluateDesignCoverage({
    features: [{
      name: "自然日次数控制",
      description: "默认按北京时间自然日统计，每个用户每日成功一次。",
    }],
    businessRules: [{
      name: "幂等防重复发放",
      description: "活动ID、用户ID和业务日期组成幂等键，重复点击不重复记账。",
    }],
  }, "北京时间 00:00 重置，每日次数上限 1 次。幂等规则为活动ID+用户ID+业务日期，重复点击返回已有结果，不重复发放。", [
    "features",
    "businessRules",
  ]);
  if (!semanticCoverage.passed) {
    throw new Error(`Self-test failed for semantic design coverage: ${semanticCoverage.evidence}`);
  }

  const internalToolProtocol = [
    "data: " + JSON.stringify({ type: "tool-input-start", toolCallId: "call-1", toolName: "read_file" }),
    "data: " + JSON.stringify({ type: "tool-output-available", toolCallId: "call-1", toolName: "read_file", output: "Context from AI Product Workbench" }),
  ].join("\n");
  const internalEvaluation = evaluateOnlineResult(
    internalToolProtocol,
    { health: { value: sampleHealthSnapshot() }, runtimeStatus: { value: { latestRun: { status: "cancelled", events: [] } } }, messages: { value: { items: [] } } },
    { status: "failed_or_timeout", httpStatus: 200, bytes: Buffer.byteLength(internalToolProtocol) },
    { status: "skipped", reason: "prototype artifact is not available" },
    { status: "not_required", reason: "account not created" },
    sampleIsolationCheck(),
    "0123456789ab",
  );
  assertCheck(internalEvaluation, "线上流不暴露工具噪音", false);
  assertCheck(internalEvaluation, "线上最终助手提示清晰", false);
  assertCheck(internalEvaluation, "线上运行状态展示知识库模型联网三段进度", false);

  const persistedNoiseEvaluation = evaluateOnlineResult(
    allowedArtifactProtocol,
    {
      health: { value: sampleHealthSnapshot() },
      runtimeStatus: { value: { latestRun: { status: "succeeded", events: sampleRuntimeEvents() } } },
      messages: {
        value: {
          items: [{
            ...sampleAssistantMessage(),
            metadata: { parts: [{ type: "dynamic-tool", toolName: "read_file", toolCallId: "call-internal", output: "runtime skill" }] },
          }],
        },
      },
      conversation: { value: { conversationDesignState: sampleDesignState() } },
      prd: { value: { document: samplePrdDocument() } },
      prototype: { value: { artifact: samplePrototypeArtifact() } },
      prototypePreview: { value: samplePrototypePreviewHeaders() },
    },
    { status: "completed", httpStatus: 200, bytes: Buffer.byteLength(allowedArtifactProtocol) },
    samplePrototypeRender(),
    sampleAccountCleanup(1, true),
    sampleIsolationCheck(),
    "0123456789ab",
  );
  assertCheck(persistedNoiseEvaluation, "线上持久化消息不暴露内部工具噪音", false);

  const unsupportedChannelPrd = samplePrdDocument();
  const unsupportedChannelUsage = unsupportedChannelPrd.sections.find((section) => /使用场景/.test(section.title));
  unsupportedChannelUsage.content = unsupportedChannelUsage.content.replace(
    "| 2 | WAP/H5端外渠道 | □是 ☑否 |",
    "| 2 | WAP/H5端外渠道 | ☑是 □否 |",
  );
  const unsupportedChannelQuality = evaluatePrdDocument(unsupportedChannelPrd, sampleDesignState());
  if (unsupportedChannelQuality.channelTablePassed || !unsupportedChannelQuality.channelTableEvidence.includes("WAP/H5端外渠道")) {
    throw new Error(`Self-test failed for unsupported channel selection: ${unsupportedChannelQuality.channelTableEvidence}`);
  }

  const invalidPrd = samplePrdDocument();
  const usageSection = invalidPrd.sections.find((section) => /使用场景/.test(section.title));
  const safetySection = invalidPrd.sections.find((section) => /安全基线/.test(section.title));
  usageSection.content = `${usageSection.content}\n\n${sampleChannelTable({ endpoint: true, h5: true, miniProgram: true })}`;
  safetySection.content = safetySection.content.replace(/(\| 13 \|[^\n]+\|) 不涉及 \|/, "$1 是 |");
  const invalidPrdQuality = evaluatePrdDocument(invalidPrd, sampleDesignState());
  if (invalidPrdQuality.channelTablePassed || invalidPrdQuality.safetyBaselinePassed) {
    throw new Error(`Self-test failed for invalid PRD contracts: ${invalidPrdQuality.channelTableEvidence}; ${invalidPrdQuality.safetyBaselineEvidence}`);
  }

  const invalidPrototype = samplePrototypeArtifact();
  invalidPrototype.htmlContent = "<!doctype html><html><head><meta name=\"viewport\"><style>body{display:grid}</style></head><body><button>立即签到</button></body></html>";
  const invalidPrototypeQuality = evaluatePrototypeArtifact(invalidPrototype, samplePrototypeRender(), sampleDesignState());
  if (invalidPrototypeQuality.responsivePassed || invalidPrototypeQuality.interactionPassed) {
    throw new Error(`Self-test failed for invalid prototype contracts: ${invalidPrototypeQuality.responsiveEvidence}; ${invalidPrototypeQuality.interactionEvidence}`);
  }
  const blockedPreviewPolicy = evaluatePreviewScriptPolicy({
    contentSecurityPolicy: "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
  });
  if (blockedPreviewPolicy.passed) {
    throw new Error(`Self-test failed for script-blocking preview CSP: ${blockedPreviewPolicy.evidence}`);
  }

  const failedMobileRender = samplePrototypeRender();
  failedMobileRender.status = "failed";
  failedMobileRender.nonBlankCheck.passed = false;
  failedMobileRender.renders.mobile = { status: "failed", reason: "blank mobile screenshot" };
  failedMobileRender.browserContract = {
    passed: false,
    interactionPassed: false,
    noOverflowPassed: false,
    keyButton: "立即签到",
    keyButtonCount: 1,
    changedButtonCount: 0,
    failedButtons: "立即签到",
    clientWidth: 390,
    scrollWidth: 680,
    mutations: 0,
  };
  const failedMobileEvaluation = evaluateOnlineResult(
    allowedArtifactProtocol,
    {
      health: { value: sampleHealthSnapshot() },
      runtimeStatus: { value: { latestRun: { status: "succeeded", events: sampleRuntimeEvents() } } },
      messages: { value: { items: [sampleAssistantMessage()] } },
      conversation: { value: { conversationDesignState: sampleDesignState() } },
      prd: { value: { document: samplePrdDocument() } },
      prototype: { value: { artifact: samplePrototypeArtifact() } },
      prototypePreview: { value: samplePrototypePreviewHeaders() },
    },
    { status: "completed", httpStatus: 200, bytes: Buffer.byteLength(allowedArtifactProtocol) },
    failedMobileRender,
    { status: "failed", reason: "DELETE /auth/me -> HTTP 500" },
    { status: "failed", passed: false, probes: [{ name: "conversation", status: 200, passed: false }], verifierCleanup: sampleAccountCleanup(0, false) },
    "0123456789ab",
  );
  assertCheck(failedMobileEvaluation, "线上原型桌面和移动端预览可渲染截图", false);
  assertCheck(failedMobileEvaluation, "线上原型 390 视口无页面级横向溢出", false);
  assertCheck(failedMobileEvaluation, "线上原型关键按钮真实点击产生可见状态变化", false);
  assertCheck(failedMobileEvaluation, "线上烟测账号已清理", false);
  assertCheck(failedMobileEvaluation, "线上 owner 数据跨用户隔离", false);

  console.log(JSON.stringify({
    ok: true,
    checks: [
      "allowed createDocument protocol is not treated as internal tool noise",
      "internal read_file protocol is treated as tool noise",
      "persisted metadata.parts rejects internal dynamic-tool parts",
      "final assistant message must be clear and clean",
      "PRD metadata must retain explainable knowledge refs, external evidence, and public-data boundary",
      "agent retrieval must cover PRD rules, prototype rules, a domain-relevant prototype asset, and current-domain knowledge",
      "PRD and prototype must cover the dynamic design state and prototype specification",
      "semantic design evidence is accepted without copying entity labels verbatim",
      "PRD body must not include trace/evidence sections",
      "runtime progress must show knowledge, model, and public evidence stages",
      "channel and 21-row safety contracts reject duplicate or unsupported claims",
      "viewport, mobile overflow guards, and script-backed key actions are mandatory",
      "preview CSP must allow inline interaction scripts only inside an opaque sandbox",
      "desktop and 390x844 screenshots must both pass pixel checks",
      "build identity and DELETE /auth/me cleanup evidence are mandatory",
      "a second account must be denied access to owner conversation and artifacts, then be deleted",
    ],
  }, null, 2));
}

function assertCheck(evaluation, name, expected) {
  const check = evaluation.checks.find((item) => item.name === name);
  if (!check) throw new Error(`Self-test missing check: ${name}`);
  if (check.passed !== expected) {
    throw new Error(`Self-test failed for ${name}: expected ${expected}, got ${check.passed} (${check.evidence})`);
  }
}

function sampleDesignState() {
  return {
    targetUsers: [{ name: "用户" }],
    userScenarios: [{ name: "每日签到" }],
    pages: [{ name: "活动配置" }, { name: "前台签到" }, { name: "数据报表" }],
    features: [{ name: "积分发放" }],
    backendConfigs: [{ name: "活动配置" }],
    frontendRules: [{ name: "重复签到" }],
    businessRules: [{ name: "每日签到" }],
    stateRules: [{ name: "已签到" }],
    exceptionScenarios: [{ name: "发放失败" }],
    acceptanceCriteria: [{ name: "数据报表" }],
    prototypeSpec: {
      pages: [
        {
          name: "活动配置",
          components: [{ name: "提交审核" }],
          states: [{ name: "待审核" }],
        },
        {
          name: "前台签到",
          components: [{ name: "立即签到" }],
          states: [{ name: "已签到" }],
        },
        {
          name: "数据报表",
          components: [{ name: "发放失败" }],
          states: [{ name: "补偿中" }],
        },
      ],
    },
  };
}

function samplePrdDocument() {
  return {
    title: "签到领积分活动需求说明书",
    knowledgeRefs: [
      {
        title: "PRD标准结构（04-产品文档规范/PRD标准结构.md）",
        snippet: "需求说明书必须包含引言、业务需求、降级方案和安全基线。",
        type: "prd_writing_rule",
        score: 0.95,
        reason: "标题匹配 PRD",
        relatedPath: "04-产品文档规范/PRD标准结构.md",
      },
      {
        title: "原型生成总规则（05-原型设计规范/原型生成总规则.md）",
        snippet: "原型必须覆盖前后台、字段、状态和异常。",
        type: "prototype_rule",
        score: 0.93,
        reason: "标题匹配 原型",
        relatedPath: "05-原型设计规范/原型生成总规则.md",
      },
      {
        title: "签到活动高保真HTML原型框架（05-原型设计规范/签到活动高保真HTML原型框架.md）",
        snippet: "签到积分原型必须复用 Axure HTML 原型的信息架构、字段密度、状态表达和前后台联动方式。",
        type: "prototype_asset_ref",
        score: 0.92,
        reason: "标题匹配 原型资产",
        relatedPath: "05-原型设计规范/签到活动高保真HTML原型框架.md",
      },
      {
        title: "活动发布与模板配置（02-业务域知识/活动发布与模板配置.md）",
        snippet: "活动发布覆盖草稿、预览、审核、发布、下线和回滚。",
        type: "business_concept",
        score: 0.91,
        reason: "标题匹配 活动",
        relatedPath: "02-业务域知识/活动发布与模板配置.md",
      },
      {
        title: "奖品券与资损核销（02-业务域知识/奖品券与资损核销.md）",
        snippet: "权益发放需要库存、核销、对账、重复领取和资损控制。",
        type: "business_concept",
        score: 0.9,
        reason: "标题匹配 积分",
        relatedPath: "02-业务域知识/奖品券与资损核销.md",
      },
    ],
    validationNotes: [
      "补齐说明：知识库打底，模型补齐默认状态，联网补充公开资料。",
      "外部补充状态：completed",
      "外部参考：https://developer.mozilla.org/en-US/docs/Glossary/Idempotent",
      "补齐边界：外部资料只补充通用经验，不发送内部路径、附件原文、真实接口或密钥，不覆盖本地知识库规则。",
    ],
    sections: [
      { title: "1.1 项目背景", content: "用户每日签到领取积分。" },
      { title: "1.3 使用场景（必填）", content: `用户从端内入口参与签到。\n\n${sampleChannelTable({ endpoint: true, h5: false, miniProgram: false })}` },
      { title: "2.2 核心业务规则", content: "每日签到、已签到、积分奖励、重复签到不重复发放；发放失败进入补偿。" },
      {
        title: "2.3 核心流程/状态/页面要求",
        content: "产品流程图和产品架构图覆盖活动配置、审核发布、前台签到、积分发放、异常补偿和数据报表。",
        blocks: [
          { type: "diagram", title: "产品流程图", diagramSyntax: "mermaid", content: "flowchart TD\nA[运营配置] --> B[审核发布]\nB --> C[前台签到]\nC --> D[积分发放]\nD --> E[数据报表]" },
          { type: "diagram", title: "产品架构图", diagramSyntax: "mermaid", content: "flowchart LR\nOP[运营后台] --> CFG[配置中心]\nCFG --> PAGE[前台页面]\nPAGE --> REPORT[数据报表]" },
        ],
      },
      { title: "3 业务降级方案", content: "积分发放失败进入补偿重试。" },
      { title: "4 需求安全基线要求", content: sampleSafetyBaselineTable() },
    ],
  };
}

function sampleChannelTable(input) {
  const selection = (selected) => selected ? "☑是 □否" : "□是 ☑否";
  return [
    "| 序号 | 活动投放的可选渠道 | 是否投放 |",
    "| --- | --- | --- |",
    `| 1 | 端内渠道 | ${selection(input.endpoint)} |`,
    `| 2 | WAP/H5端外渠道 | ${selection(input.h5)} |`,
    `| 3 | 小程序 | ${selection(input.miniProgram)} |`,
  ].join("\n");
}

function sampleSafetyBaselineTable() {
  const labels = [
    "新开发功能接口或现有功能接口逻辑变动", "业务功能面向公众用户", "新开通公网暴露面", "管理后台个人信息脱敏展示",
    "管理后台水印功能", "管理后台查询条件限制", "管理后台接入4A统一管理", "未接入4A时满足安全要求",
    "后台配置内容敏感词过滤", "前台展示内容先审后发", "展示隐私政策并获取用户同意", "APP或小程序双清单",
    "前台页面采集身份证号码、身份证照片、生物识别或银行卡信息", "免密登录需用户同意隐私政策", "跳转第三方页面或应用",
    "与第三方公司接口对接进行数据交互", "新增API接口台账填报", "用户敏感信息或跨系统API加密传输", "用户信息或重要数据加密存储",
    "数据采集规范", "采集数据完整性和一致性校验",
  ];
  return [
    "安全基线自查如下。",
    "",
    "| 序号 | 需求安全基线内容 | 范围 | 是否涉及 |",
    "| --- | --- | --- | --- |",
    ...labels.map((label, index) => `| ${index + 1} | ${label} | 信息系统 | ${index < 2 ? "是" : "不涉及"} |`),
  ].join("\n");
}

function samplePrototypeArtifact() {
  return {
    title: "签到领积分活动原型",
    htmlContent: `<!doctype html>
<html lang="zh-CN">
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    *{box-sizing:border-box}html,body{overflow-x:hidden}.table-wrap{max-width:100%;overflow-x:auto}.app{display:grid;grid-template-columns:220px 1fr;gap:16px;padding:20px}.panel{border-radius:8px;box-shadow:0 8px 18px #ddd;padding:16px}.badge{border-radius:999px;padding:4px 8px}.status{color:#027a48}@media(max-width:768px){.app{display:block;padding:12px}.panel{max-width:100%}}
  </style>
</head>
<body>
  <main class="app">
    <aside class="panel">后台导航 活动配置 审核发布 数据报表</aside>
    <section class="panel" data-page-id="backend-config">
      <h1>活动配置</h1>
      <div class="field"><input value="签到领积分活动"></div><div class="field"><select><option>全部登录用户</option></select></div><div class="field"><select><option>会员成长活动集</option></select></div><button>提交审核</button><button>保存草稿</button><button>预览活动</button>
      <div class="field">banner 上传位 分享海报 海报开关 隐私协议 目标用户 跳转类型</div>
      <table><thead><tr><th>状态</th><th>说明</th></tr></thead><tbody><tr><td><span class="badge status">待审核</span></td><td>积分奖励、每日库存、失败补偿、补偿重试、额度不足、无资格</td></tr></tbody></table>
    </section>
    <section class="panel" data-page-id="frontend-preview"><h2>前台用户页面 前台签到</h2><div>每日签到</div><div>立即签到</div><div>已签到</div><div>连续签到</div><div>重复签到</div><div>积分发放</div><div>积分奖励</div><div>异常状态</div><div>稍后到账</div></section>
    <section class="panel" data-page-id="report"><div>数据报表</div><div>签到人数</div><div>发放失败</div><div>补偿中</div><div>资损风险</div></section>
  </main>
  <script>document.querySelectorAll("button").forEach((button)=>button.addEventListener("click",()=>{button.textContent="操作已完成";}));</script>
</body>
</html>`,
  };
}

function samplePrototypeRender() {
  const desktop = {
    passed: true,
    nonWhiteRatio: 0.3,
    luminanceStdDev: 30,
    colorBucketCount: 30,
  };
  const mobile = {
    passed: true,
    nonWhiteRatio: 0.32,
    luminanceStdDev: 28,
    colorBucketCount: 26,
  };
  return {
    status: "passed",
    nonBlankCheck: {
      passed: true,
      desktop,
      mobile,
    },
    renders: {
      desktop: { status: "passed", nonBlankCheck: desktop },
      mobile: { status: "passed", nonBlankCheck: mobile },
    },
    browserContract: {
      passed: true,
      interactionPassed: true,
      noOverflowPassed: true,
      keyButton: "立即签到",
      keyButtonCount: 1,
      changedButtonCount: 1,
      clientWidth: 390,
      scrollWidth: 390,
      mutations: 1,
      dialogCalled: false,
    },
  };
}

function sampleAssistantMessage() {
  return {
    id: "assistant-1",
    role: "assistant",
    content: "PRD《签到领积分活动需求说明书》和原型《签到领积分活动原型》已生成，QA 通过。请在右侧画布查看和继续修改。",
    metadata: { parts: [{ type: "text", text: "PRD 和原型已生成。" }] },
  };
}

function sampleHealthSnapshot() {
  return {
    ok: true,
    service: "ai-product-workbench-api",
    phase: "deerflow-first-runtime",
    build: { commitSha: "0123456789ab" },
    deerflow: {
      enabled: true,
      runtimeName: "ai-product-workbench-lead",
      modelId: "datatoken/datatoken-gpt-5-5",
      models: [{ id: "datatoken/datatoken-gpt-5-5" }],
    },
  };
}

function samplePrototypePreviewHeaders() {
  return {
    contentSecurityPolicy: "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
    contentType: "text/html; charset=utf-8",
  };
}

function sampleIsolationCheck() {
  return {
    status: "passed",
    passed: true,
    ownerBaselines: [
      { name: "conversation", status: 200, passed: true },
      { name: "prd", status: 200, passed: true },
      { name: "prototype", status: 200, passed: true },
      { name: "artifact", status: 200, passed: true },
    ],
    probes: [
      { name: "conversation", status: 404, passed: true },
      { name: "prd", status: 404, passed: true },
      { name: "prototype", status: 404, passed: true },
      { name: "artifact", status: 404, passed: true },
    ],
    verifierCleanup: sampleAccountCleanup(0, false),
  };
}

function sampleAccountCleanup(attempted, requireThreadAttempt) {
  return {
    status: "passed",
    route: "/auth/me",
    success: true,
    cleanupComplete: true,
    requireThreadAttempt,
    deerFlowThreads: { attempted, deleted: attempted, notFound: 0, failed: 0 },
  };
}

function sampleRuntimeEvents() {
  return [
    { label: "已用知识库打底，命中 4 条", detail: "活动发布与模板配置" },
    { label: "已用模型补齐业务细节", detail: "模型补齐默认签到状态和异常处理。" },
    { label: "已用公开资料补齐 3 条", detail: "Building an Effective Loyalty Program" },
  ];
}

function setCookies(headers) {
  const raw = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : [headers.get("set-cookie")].filter(Boolean);
  const pairs = raw
    .flatMap((value) => String(value).split(/,(?=[^;,]+=)/))
    .map((value) => value.split(";")[0])
    .filter(Boolean);
  if (!pairs.length) return;
  const cookies = new Map((cookieHeader ? cookieHeader.split("; ") : []).flatMap((pair) => {
    const separator = pair.indexOf("=");
    return separator > 0 ? [[pair.slice(0, separator), pair.slice(separator + 1)]] : [];
  }));
  for (const pair of pairs) {
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    if (value) cookies.set(name, value);
    else cookies.delete(name);
  }
  cookieHeader = [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function parseJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { raw: text };
  }
}

function redactRequestBody(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const clone = { ...value };
  if ("accessToken" in clone) clone.accessToken = "[redacted]";
  return clone;
}

async function readTextFile(filePath) {
  try {
    const { readFile } = await import("node:fs/promises");
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function normalizeBaseUrl(value) {
  return String(value).replace(/\/+$/, "");
}

async function resolveExpectedBuildSha() {
  const configured = process.env.AGENT_WORKFLOW_ONLINE_EXPECTED_COMMIT_SHA?.trim();
  if (configured) return configured;
  try {
    const result = await execFileAsync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: process.cwd(),
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    return String(result.stdout ?? "").trim();
  } catch {
    return "";
  }
}

function topicTitle(value) {
  return String(value)
    .replace(/请?根据知识库内容?/g, "")
    .replace(/生成需求文档和原型|生成需求文档|生成原型/g, "")
    .replace(/我想做一个|我想做|请帮我|帮我/g, "")
    .replace(/[，。！？,.!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40) || "Agent 工作流";
}

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function safeStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function roundNumber(value) {
  return Number(value.toFixed(4));
}

function summarizeCommandError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const stderr = String(error?.stderr ?? "").trim();
  const stdout = String(error?.stdout ?? "").trim();
  return [message, stderr || stdout].filter(Boolean).join(" | ").slice(0, 900);
}
