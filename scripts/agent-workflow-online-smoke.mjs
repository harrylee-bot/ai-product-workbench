#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const COVERAGE_SEGMENTER = new Intl.Segmenter("zh-CN", { granularity: "word" });
const COVERAGE_STOP_TOKENS = new Set([
  "与", "和", "及", "或", "的", "了", "为", "并", "在", "后", "时", "中", "内", "按", "对", "将",
  "可", "需", "应", "每个", "当前", "相关", "至少", "默认", "进行", "通过", "支持",
]);

const DEFAULT_TOPIC = "我想做一个签到领积分的活动，请根据知识库内容生成需求文档和原型";
const topic = process.argv.slice(2).join(" ").trim() || process.env.AGENT_WORKFLOW_ONLINE_TOPIC || DEFAULT_TOPIC;
const baseUrl = normalizeBaseUrl(process.env.AGENT_WORKFLOW_ONLINE_BASE_URL || "https://aionbench.com/api");
const forwardedProto = process.env.AGENT_WORKFLOW_ONLINE_FORWARDED_PROTO?.trim();
// A full artifact run may include the initial generation plus two QA repair turns.
const timeoutMs = numberFromEnv("AGENT_WORKFLOW_ONLINE_TIMEOUT_MS", 1_200_000);
const strict = process.env.AGENT_WORKFLOW_ONLINE_STRICT !== "0";
const keepConversation = process.env.AGENT_WORKFLOW_ONLINE_KEEP_CONVERSATION === "1";
const outputRoot = path.resolve(
  process.env.AGENT_WORKFLOW_ONLINE_OUT || path.join(process.cwd(), "storage", "agent-workflow-online-smoke", safeStamp()),
);

if (process.env.AGENT_WORKFLOW_ONLINE_SELF_TEST === "1") {
  runSelfTest();
  process.exit(0);
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

let streamResult = { status: "not_started" };
try {
  await requestJson("POST", "/auth/register", {
    username,
    email,
    password,
    displayName: "Codex Prod Smoke",
  });
  const created = await requestJson("POST", "/conversations", {
    conversationId,
    title: `Codex 线上冒烟：${topicTitle(topic)}`,
  });
  conversationId = created?.conversation?.id ?? conversationId;

  streamResult = await streamChat();
  await fetchSnapshots();
  prototypeRender = await renderOnlinePrototype();
} catch (error) {
  streamResult = {
    ...streamResult,
    setupError: error instanceof Error ? error.message : String(error),
  };
} finally {
  if (conversationId && !keepConversation) {
    await requestJson("DELETE", `/conversations/${conversationId}`).catch(() => null);
  }

  const rawStream = await readTextFile(path.join(outputRoot, "stream.raw.txt"));
  const evaluation = evaluateOnlineResult(rawStream, snapshots, streamResult, prototypeRender);
  const summary = {
    baseUrl,
    topic,
    outputRoot,
    username,
    email,
    conversationId,
    cookieCaptured: Boolean(cookieHeader),
    keepConversation,
    streamResult,
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
    evaluation,
  }, null, 2));
  if (strict && !evaluation.passed) {
    process.exit(1);
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
        selectedChatModel: process.env.AGENT_WORKFLOW_ONLINE_MODEL || "datatoken/datatoken-gpt-5-5",
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
    if (preview.trim()) html = preview;
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
  return renderPrototypeFile(previewPath, screenshotPath, artifact.id);
}

async function requestText(method, route) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
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
    body: response.ok ? `[text ${Buffer.byteLength(text)} bytes]` : text.slice(0, 500),
  };
  if (!response.ok) {
    throw new Error(`${method} ${route} -> HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  return text;
}

async function requestJson(method, route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
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

async function renderPrototypeFile(htmlPath, screenshotPath, artifactId) {
  const browserPath = findChromeBinary();
  const viewport = { width: 1440, height: 1100 };
  if (!browserPath) {
    return {
      status: "failed",
      artifactId,
      htmlPath,
      screenshotPath,
      viewport,
      reason: "No Chrome/Chromium binary found for prototype render check.",
    };
  }

  const userDataDir = path.join(outputRoot, ".chrome-profile");
  await mkdir(userDataDir, { recursive: true });
  try {
    await runHeadlessChrome(browserPath, [
      "--disable-gpu",
      "--no-sandbox",
      "--hide-scrollbars",
      `--user-data-dir=${userDataDir}`,
      `--window-size=${viewport.width},${viewport.height}`,
      `--screenshot=${screenshotPath}`,
      pathToFileURL(htmlPath).href,
    ]);
    const image = await analyzeScreenshot(screenshotPath);
    const nonBlankCheck = buildNonBlankCheck(image);
    return {
      status: nonBlankCheck.passed ? "passed" : "failed",
      artifactId,
      browserPath,
      htmlPath,
      screenshotPath,
      viewport,
      image,
      nonBlankCheck,
    };
  } catch (error) {
    return {
      status: "failed",
      artifactId,
      browserPath,
      htmlPath,
      screenshotPath,
      viewport,
      reason: summarizeCommandError(error),
    };
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

function buildNonBlankCheck(image) {
  const passed =
    image.width >= 1000 &&
    image.height >= 800 &&
    image.fileSize >= 25_000 &&
    image.nonWhiteRatio >= 0.08 &&
    image.luminanceStdDev >= 8 &&
    image.colorBucketCount >= 12;
  return {
    passed,
    widthOk: image.width >= 1000,
    heightOk: image.height >= 800,
    fileSizeOk: image.fileSize >= 25_000,
    nonWhiteRatio: image.nonWhiteRatio,
    luminanceStdDev: image.luminanceStdDev,
    colorBucketCount: image.colorBucketCount,
  };
}

async function runHeadlessChrome(browserPath, args) {
  try {
    return await execFileAsync(browserPath, ["--headless=new", ...args], {
      timeout: 20_000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    const text = `${error?.stderr ?? ""}\n${error?.stdout ?? ""}`;
    if (/headless=new|unrecognized|unknown option|invalid/i.test(text)) {
      return await execFileAsync(browserPath, ["--headless", ...args], {
        timeout: 20_000,
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

function evaluateOnlineResult(rawStream, snapshotMap, result, renderResult) {
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
  const runtimeProgress = evaluateRuntimeProgress(snapshotMap.runtimeStatus?.value);
  const checks = [
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
      name: "线上运行状态成功",
      passed: runtimeStatus === "succeeded",
      evidence: runtimeStatus ?? "missing runtime status",
    },
    {
      name: "线上原型预览可渲染截图",
      passed: renderResult.status === "passed" && renderResult.nonBlankCheck?.passed === true,
      evidence: renderResult.nonBlankCheck
        ? `nonWhite=${renderResult.nonBlankCheck.nonWhiteRatio}, stddev=${renderResult.nonBlankCheck.luminanceStdDev}, buckets=${renderResult.nonBlankCheck.colorBucketCount}`
        : renderResult.reason ?? renderResult.status,
    },
    {
      name: "线上 PRD 与原型核心规则一致",
      passed: consistency.passed,
      evidence: consistency.evidence,
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
    runtimeProgress,
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
    designCoveragePassed: designCoverage.passed,
    designCoverageEvidence: designCoverage.evidence,
  };
}

function evaluatePrototypeArtifact(artifact, renderResult, designState) {
  if (!artifact) {
    return {
      textLength: 0,
      coreLabelsPassed: false,
      coreLabelsEvidence: "artifact null",
      noisePassed: false,
      noiseEvidence: "artifact null",
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
    designCoveragePassed: designCoverage.passed,
    designCoverageEvidence: designCoverage.evidence,
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
      runtimeStatus: { value: { latestRun: { status: "succeeded", events: sampleRuntimeEvents() } } },
      messages: { value: { items: [sampleAssistantMessage()] } },
      conversation: { value: { conversationDesignState: sampleDesignState() } },
      prd: { value: { document: samplePrdDocument() } },
      prototype: { value: { artifact: samplePrototypeArtifact() } },
    },
    { status: "completed", httpStatus: 200, bytes: Buffer.byteLength(allowedArtifactProtocol) },
    samplePrototypeRender(),
  );
  assertCheck(allowedEvaluation, "线上流不暴露工具噪音", true);
  assertCheck(allowedEvaluation, "线上最终助手提示清晰", true);
  assertCheck(allowedEvaluation, "线上 PRD 元数据留存知识库和补齐证据", true);
  assertCheck(allowedEvaluation, "线上 PRD 知识引用可解释", true);
  assertCheck(allowedEvaluation, "线上 Agent 调用覆盖核心知识组", true);
  assertCheck(allowedEvaluation, "线上 PRD 正文不写补齐证据章节", true);
  assertCheck(allowedEvaluation, "线上 PRD 内容结构合格", true);
  assertCheck(allowedEvaluation, "线上原型动态业务覆盖和高保真合格", true);
  assertCheck(allowedEvaluation, "线上 PRD 与原型核心规则一致", true);
  assertCheck(allowedEvaluation, "线上运行状态展示知识库模型联网三段进度", true);

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
    { runtimeStatus: { value: { latestRun: { status: "cancelled", events: [] } } }, messages: { value: { items: [] } } },
    { status: "failed_or_timeout", httpStatus: 200, bytes: Buffer.byteLength(internalToolProtocol) },
    { status: "skipped", reason: "prototype artifact is not available" },
  );
  assertCheck(internalEvaluation, "线上流不暴露工具噪音", false);
  assertCheck(internalEvaluation, "线上最终助手提示清晰", false);
  assertCheck(internalEvaluation, "线上运行状态展示知识库模型联网三段进度", false);

  console.log(JSON.stringify({
    ok: true,
    checks: [
      "allowed createDocument protocol is not treated as internal tool noise",
      "internal read_file protocol is treated as tool noise",
      "final assistant message must be clear and clean",
      "PRD metadata must retain explainable knowledge refs, external evidence, and public-data boundary",
      "agent retrieval must cover PRD rules, prototype rules, a domain-relevant prototype asset, and current-domain knowledge",
      "PRD and prototype must cover the dynamic design state and prototype specification",
      "semantic design evidence is accepted without copying entity labels verbatim",
      "PRD body must not include trace/evidence sections",
      "runtime progress must show knowledge, model, and public evidence stages",
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
      { title: "4 需求安全基线要求", content: "控制资损、风控、权限和报表。" },
    ],
  };
}

function samplePrototypeArtifact() {
  return {
    title: "签到领积分活动原型",
    htmlContent: `<!doctype html>
<html lang="zh-CN">
<head>
  <style>
    *{box-sizing:border-box}.app{display:grid;grid-template-columns:220px 1fr;gap:16px;padding:20px}.panel{border-radius:8px;box-shadow:0 8px 18px #ddd;padding:16px}.badge{border-radius:999px;padding:4px 8px}.status{color:#027a48}
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
</body>
</html>`,
  };
}

function samplePrototypeRender() {
  return {
    status: "passed",
    nonBlankCheck: {
      passed: true,
      nonWhiteRatio: 0.3,
      luminanceStdDev: 30,
      colorBucketCount: 30,
    },
  };
}

function sampleAssistantMessage() {
  return {
    id: "assistant-1",
    role: "assistant",
    content: "PRD《签到领积分活动需求说明书》和原型《签到领积分活动原型》已生成，QA 通过。请在右侧画布查看和继续修改。",
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
  cookieHeader = [...new Set([...(cookieHeader ? cookieHeader.split("; ") : []), ...pairs])].join("; ");
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
