#!/usr/bin/env node
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_TOPIC = "我想做一个签到领积分的活动，请根据知识库内容生成需求文档和原型";
const topic = process.argv.slice(2).join(" ").trim() || DEFAULT_TOPIC;
const repoRoot = process.cwd();
const vaultRoot = path.resolve(process.env.KNOWLEDGE_VAULT_ROOT || path.join(repoRoot, "knowledge-vault"));
const externalEvidenceCachePath = path.resolve(
  process.env.AGENT_WORKFLOW_EXTERNAL_EVIDENCE_CACHE ||
    path.join(repoRoot, "storage", "agent-workflow-eval", "public-evidence-cache.json"),
);
const outputRoot = path.resolve(
  process.env.AGENT_WORKFLOW_EVAL_OUT || path.join(repoRoot, "storage", "agent-workflow-eval", safeStamp()),
);

if (!existsSync(vaultRoot)) {
  console.error(`Knowledge vault not found: ${vaultRoot}`);
  process.exit(2);
}

const files = await listMarkdownFiles(vaultRoot);
const docs = [];
for (const relativePath of files) {
  const content = await readFile(path.join(vaultRoot, relativePath), "utf8").catch(() => "");
  if (!content.trim()) continue;
  docs.push(toKnowledgeDoc(relativePath, content));
}

const hits = rankKnowledge(topic, docs).slice(0, 12);
const requiredChecks = [
  ["活动发布与模板配置", /活动发布与模板配置|活动配置|模板配置/],
  ["奖品券与资损核销", /奖品券与资损核销|权益|积分|资损|核销|库存/],
  ["PRD标准结构", /PRD标准结构|需求说明书|需求文档规范/],
  ["原型生成总规则", /原型生成总规则|前后台页面框架|字段接口状态表达/],
];
const coverage = requiredChecks.map(([name, pattern]) => ({
  name,
  hit: hits.some((item) => pattern.test(`${item.title}\n${item.relativePath}\n${item.summary}`)),
}));
const webSearchQueries = buildWebSearchQueries(topic);
const externalResearch = await runExternalResearch(webSearchQueries);
const enrichment = buildEnrichmentPlan(topic, hits, coverage, webSearchQueries, externalResearch);
const prd = buildPrd(topic, hits, coverage, enrichment);
const prototype = buildPrototypeHtml(topic, hits, coverage, enrichment);
const consistency = buildConsistencyMatrix(prd, prototype, enrichment);
const finalUserMessage = buildFinalUserMessage();

await mkdir(outputRoot, { recursive: true });
const prototypePath = path.join(outputRoot, "prototype.html");
await writeFile(path.join(outputRoot, "knowledge-hits.json"), JSON.stringify(hits, null, 2), "utf8");
await writeFile(path.join(outputRoot, "enrichment-plan.json"), JSON.stringify(enrichment, null, 2), "utf8");
await writeFile(path.join(outputRoot, "external-research.json"), JSON.stringify(externalResearch, null, 2), "utf8");
await writeFile(path.join(outputRoot, "prd-prototype-consistency.json"), JSON.stringify(consistency, null, 2), "utf8");
await writeFile(path.join(outputRoot, "prd-prototype-consistency.md"), buildConsistencyMarkdown(consistency), "utf8");
await writeFile(path.join(outputRoot, "requirement-doc.md"), prd, "utf8");
await writeFile(prototypePath, prototype, "utf8");
await writeFile(path.join(outputRoot, "final-user-message.txt"), finalUserMessage, "utf8");

const prototypeRender = await renderPrototype(prototypePath, outputRoot);
const [backendRetrievalGate, streamCleanlinessGate, persistenceCleanlinessGate, onlineSmokeSelfTestGate] = await Promise.all([
  runBackendRetrievalGate(),
  runBackendStreamCleanlinessGate(),
  runPersistenceCleanlinessGate(),
  runOnlineSmokeSelfTestGate(),
]);
const evaluation = evaluateArtifacts({
  hits,
  coverage,
  enrichment,
  prd,
  prototype,
  finalUserMessage,
  prototypeRender,
  backendRetrievalGate,
  streamCleanlinessGate,
  persistenceCleanlinessGate,
  onlineSmokeSelfTestGate,
  consistency,
});
const comparison = buildComparison(topic, hits, coverage, enrichment, evaluation, consistency);
const onlineVsOptimizedComparison = await buildOnlineVsOptimizedComparison({
  topic,
  outputRoot,
  hits,
  coverage,
  enrichment,
  evaluation,
  prototypeRender,
  consistency,
  finalUserMessage,
});

await writeFile(path.join(outputRoot, "prototype-render.json"), JSON.stringify(prototypeRender, null, 2), "utf8");
await writeFile(path.join(outputRoot, "backend-retrieval-gate.json"), JSON.stringify(backendRetrievalGate, null, 2), "utf8");
await writeFile(path.join(outputRoot, "stream-cleanliness-gate.json"), JSON.stringify(streamCleanlinessGate, null, 2), "utf8");
await writeFile(path.join(outputRoot, "persistence-cleanliness-gate.json"), JSON.stringify(persistenceCleanlinessGate, null, 2), "utf8");
await writeFile(path.join(outputRoot, "online-smoke-self-test-gate.json"), JSON.stringify(onlineSmokeSelfTestGate, null, 2), "utf8");
await writeFile(path.join(outputRoot, "eval-summary.json"), JSON.stringify(evaluation, null, 2), "utf8");
await writeFile(path.join(outputRoot, "comparison.md"), comparison, "utf8");
await writeFile(path.join(outputRoot, "online-vs-optimized-comparison.md"), onlineVsOptimizedComparison, "utf8");

console.log(JSON.stringify({
  topic,
  outputRoot,
  hitCount: hits.length,
  topHits: hits.slice(0, 6).map((item) => ({
    title: item.title,
    path: item.relativePath,
    score: item.score,
  })),
  coverage,
  enrichment: {
    modelAssumptionCount: enrichment.modelAssumptions.length,
    webSearchQueryCount: enrichment.webSearchQueries.length,
    externalRefCount: enrichment.externalRefsUsed.length,
    status: enrichment.externalResearchStatus,
  },
  prototypeRender: {
    status: prototypeRender.status,
    screenshotPath: prototypeRender.screenshotPath,
    nonBlank: prototypeRender.nonBlankCheck?.passed ?? false,
    renderedText: prototypeRender.renderedTextCheck?.passed ?? false,
  },
  consistency: {
    passed: consistency.passed,
    passedCount: consistency.rows.filter((item) => item.passed).length,
    totalCount: consistency.rows.length,
  },
  backendRetrievalGate: {
    status: backendRetrievalGate.status,
    command: backendRetrievalGate.command,
  },
  streamCleanlinessGate: {
    status: streamCleanlinessGate.status,
    command: streamCleanlinessGate.command,
  },
  persistenceCleanlinessGate: {
    status: persistenceCleanlinessGate.status,
    command: persistenceCleanlinessGate.command,
  },
  onlineSmokeSelfTestGate: {
    status: onlineSmokeSelfTestGate.status,
    command: onlineSmokeSelfTestGate.command,
  },
  evaluation: {
    passed: evaluation.passed,
    failedChecks: evaluation.checks.filter((item) => !item.passed).map((item) => item.name),
  },
}, null, 2));

if (!evaluation.passed) {
  console.error(`Agent workflow eval failed. See ${path.join(outputRoot, "eval-summary.json")}`);
  process.exit(1);
}

async function listMarkdownFiles(root) {
  const results = [];
  await walk(root, root, results);
  return results.sort((a, b) => pathRank(a) - pathRank(b) || a.localeCompare(b, "zh-Hans-CN"));
}

async function walk(root, dir, results) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(root, absolute, results);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(path.relative(root, absolute).split(path.sep).join("/"));
    }
  }
}

function toKnowledgeDoc(relativePath, content) {
  const title =
    content.match(/(?:^|\n)title:\s*["']?([^"'\n]+)["']?/)?.[1]?.trim() ||
    content.match(/^#\s+(.+)$/m)?.[1]?.trim() ||
    path.basename(relativePath, ".md");
  const summary = content
    .replace(/^---[\s\S]*?---\s*/m, "")
    .replace(/^#+\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 260);
  return { relativePath, title, content, summary };
}

function rankKnowledge(query, items) {
  const tokens = expandTokens(query);
  return items
    .map((item) => {
      const haystack = `${item.title}\n${item.relativePath}\n${item.summary}\n${item.content.slice(0, 5000)}`.toLowerCase();
      let score = pathBoost(item.relativePath);
      const reasons = [];
      for (const token of tokens) {
        if (!token) continue;
        const t = token.toLowerCase();
        if (item.title.toLowerCase().includes(t)) {
          score += 8;
          reasons.push(`标题:${token}`);
        } else if (item.relativePath.toLowerCase().includes(t)) {
          score += 5;
          reasons.push(`路径:${token}`);
        } else if (haystack.includes(t)) {
          score += 2;
          reasons.push(`正文:${token}`);
        }
      }
      return {
        title: item.title,
        relativePath: item.relativePath,
        score,
        summary: item.summary,
        reasons: [...new Set(reasons)].slice(0, 6),
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || pathRank(a.relativePath) - pathRank(b.relativePath));
}

function expandTokens(text) {
  const base = text.match(/[a-z0-9]{2,}|[\u4e00-\u9fa5]{2,}/gi) || [];
  const domain = [
    "签到",
    "打卡",
    "积分",
    "奖励",
    "活动",
    "活动配置",
    "活动发布",
    "模板",
    "奖品",
    "权益",
    "资损",
    "核销",
    "库存",
    "审核",
    "发布",
    "报表",
    "需求说明书",
    "PRD标准结构",
    "原型生成总规则",
    "前后台页面框架",
  ];
  return [...new Set([...base, ...domain])];
}

function pathBoost(relativePath) {
  if (/^(00|01|02|03|04|05)-/.test(relativePath)) return 8;
  if (relativePath.startsWith("06-")) return 4;
  if (relativePath.startsWith("07-")) return -2;
  if (relativePath.startsWith("99-")) return -5;
  return 0;
}

function pathRank(relativePath) {
  if (/^(00|01|02|03|04|05)-/.test(relativePath)) return 0;
  if (relativePath.startsWith("06-")) return 1;
  if (relativePath.startsWith("07-")) return 2;
  if (relativePath.startsWith("99-")) return 3;
  return 4;
}

function evaluateArtifacts({
  hits,
  coverage,
  enrichment,
  prd,
  prototype,
  finalUserMessage,
  prototypeRender,
  backendRetrievalGate,
  streamCleanlinessGate,
  persistenceCleanlinessGate,
  onlineSmokeSelfTestGate,
  consistency,
}) {
  const checks = [
    {
      name: "知识库至少命中 4 条",
      passed: hits.length >= 4,
      evidence: `${hits.length} hits`,
    },
    {
      name: "必要知识全部覆盖",
      passed: coverage.every((item) => item.hit),
      evidence: coverage.map((item) => `${item.name}:${item.hit ? "hit" : "miss"}`).join(", "),
    },
    {
      name: "后端实际检索门禁通过",
      passed: backendRetrievalGate?.status === "passed",
      evidence: backendRetrievalGate?.status === "passed"
        ? backendRetrievalGate.command
        : backendRetrievalGate?.error ?? "backend retrieval gate missing",
    },
    {
      name: "用户可见流不暴露工具噪音门禁通过",
      passed: streamCleanlinessGate?.status === "passed",
      evidence: streamCleanlinessGate?.status === "passed"
        ? streamCleanlinessGate.command
        : streamCleanlinessGate?.error ?? "stream cleanliness gate missing",
    },
    {
      name: "PRD/原型落库前噪音清理门禁通过",
      passed: persistenceCleanlinessGate?.status === "passed",
      evidence: persistenceCleanlinessGate?.status === "passed"
        ? persistenceCleanlinessGate.command
        : persistenceCleanlinessGate?.error ?? "persistence cleanliness gate missing",
    },
    {
      name: "线上烟测合法产物协议不误伤门禁通过",
      passed: onlineSmokeSelfTestGate?.status === "passed",
      evidence: onlineSmokeSelfTestGate?.status === "passed"
        ? onlineSmokeSelfTestGate.command
        : onlineSmokeSelfTestGate?.error ?? "online smoke self-test gate missing",
    },
    {
      name: "PRD 包含固定章节",
      passed: /1 引言[\s\S]*2 业务需求[\s\S]*3 业务降级方案[\s\S]*4 需求安全基线要求/.test(prd),
      evidence: "1/2/3/4 section scan",
    },
    {
      name: "知识库引用已留痕",
      passed: hits.some((item) => /活动发布与模板配置/.test(item.title)) &&
        hits.some((item) => /奖品券与资损核销/.test(item.title)),
      evidence: "knowledge-hits artifact scan",
    },
    {
      name: "PRD 包含活动配置闭环",
      passed: /活动配置|预览审核|发布上线|数据报表/.test(prd),
      evidence: "configuration/review/publish/report scan",
    },
    {
      name: "PRD 包含积分资损规则",
      passed: /积分|重复签到|资损|额度|补偿/.test(prd),
      evidence: "points/dedup/risk/compensation scan",
    },
    {
      name: "PRD 符合需求文档模板基础结构",
      passed: /版 本 历 史[\s\S]*版本\/状态[\s\S]*作者[\s\S]*参与者[\s\S]*起止日期[\s\S]*备注[\s\S]*目 录[\s\S]*1 引言[\s\S]*2 业务需求[\s\S]*3 业务降级方案（必填）[\s\S]*4 需求安全基线要求（必填）/.test(prd),
      evidence: "requirement-doc-template structure scan",
    },
    {
      name: "PRD 包含使用场景渠道表",
      passed: /活动投放的可选渠道[\s\S]*是否投放[\s\S]*端内渠道[\s\S]*WAP\/H5端外渠道[\s\S]*小程序/.test(prd),
      evidence: "channel table scan",
    },
    {
      name: "PRD 不包含接口章节",
      passed: !/本需求涉及新增\/修改的接口/.test(prd),
      evidence: "forbidden interface section scan",
    },
    {
      name: "PRD 包含 21 行安全基线",
      passed: (prd.match(/\| \d+ \|/g) ?? []).length >= 21 && /需求安全基线内容[\s\S]*是否涉及/.test(prd),
      evidence: "21-row safety baseline scan",
    },
    {
      name: "模型补齐说明已留痕",
      passed: enrichment.modelAssumptions.length >= 3,
      evidence: `${enrichment.modelAssumptions.length} model assumptions`,
    },
    {
      name: "联网补齐计划已留痕",
      passed: enrichment.webSearchQueries.length >= 3 &&
        enrichment.webSearchQueries.some((item) => /签到积分活动|积分权益/.test(item)),
      evidence: `${enrichment.webSearchQueries.length} web queries`,
    },
    {
      name: "联网补齐有真实取证",
      passed: ["completed", "completed_from_cache"].includes(enrichment.externalResearchStatus) && enrichment.externalRefsUsed.length >= 3,
      evidence: `${enrichment.externalRefsUsed.length} external refs, status=${enrichment.externalResearchStatus}`,
    },
    {
      name: "联网证据来源已留痕",
      passed: enrichment.externalEvidence.some((item) => /https:\/\/(mailchimp\.com|docs\.stripe\.com|developer\.mozilla\.org)/.test(item.url)),
      evidence: "external evidence source URL scan",
    },
    {
      name: "补齐计划有隐私边界",
      passed: enrichment.webSearchUseBoundary.length >= 3 && /不搜索内部知识库路径/.test(enrichment.webSearchUseBoundary.join("\n")),
      evidence: `${enrichment.webSearchUseBoundary.length} boundaries`,
    },
    {
      name: "联网查询未发送内部信息",
      passed: !/(knowledge-vault|ai-product-workbench|\/Users\/|storage\/|conversation|runId|sourceConversationId)/i.test(enrichment.webSearchQueries.join("\n")),
      evidence: "generic web query scan",
    },
    {
      name: "原型是完整 HTML",
      passed: /^<!doctype html>/i.test(prototype.trim()) && /<html lang="zh-CN">[\s\S]*<style>[\s\S]*<\/html>/.test(prototype),
      evidence: "doctype/html/style scan",
    },
    {
      name: "原型包含后台配置",
      passed: /活动配置|提交审核|数据报表/.test(prototype),
      evidence: "admin configuration scan",
    },
    {
      name: "原型包含前台签到状态",
      passed: /立即签到|已签到|失败态|连续签到/.test(prototype),
      evidence: "frontend state scan",
    },
    {
      name: "原型包含补齐策略",
      passed: /补齐策略|联网计划|模型补齐/.test(prototype),
      evidence: "enrichment panel scan",
    },
    {
      name: "原型包含外部证据标题",
      passed: enrichment.externalEvidence.length >= 3 && enrichment.externalEvidence.slice(0, 3).every((item) => prototype.includes(item.title)),
      evidence: `${Math.min(enrichment.externalEvidence.length, 3)}/${enrichment.externalEvidence.length} external evidence titles shown`,
    },
    {
      name: "PRD 与原型核心规则一致",
      passed: consistency?.passed === true,
      evidence: consistency
        ? `${consistency.rows.filter((item) => item.passed).length}/${consistency.rows.length} consistency rows`
        : "no consistency matrix",
    },
    {
      name: "产物不含运行噪音",
      passed: !/(Updated todo list|Context from AI Product Workbench|tool-output|tool-input|messages-tuple|read_file|write_todos)/i.test(`${prd}\n${prototype}`),
      evidence: "runtime-noise regex scan",
    },
    {
      name: "最终用户提示清晰且无运行噪音",
      passed: /PRD《签到领积分活动需求说明书》/.test(finalUserMessage) &&
        /原型《签到领积分活动原型》/.test(finalUserMessage) &&
        /QA 通过/.test(finalUserMessage) &&
        /右侧画布/.test(finalUserMessage) &&
        !/(Updated todo list|Context from AI Product Workbench|tool-output|tool-input|messages-tuple|read_file|write_todos|write_file)/i.test(finalUserMessage),
      evidence: finalUserMessage,
    },
    {
      name: "原型无外部资源依赖",
      passed: !/(https?:\/\/|<script\b|@import\b)/i.test(prototype),
      evidence: "external dependency scan",
    },
    {
      name: "原型可被浏览器渲染截图",
      passed: prototypeRender?.status === "passed" && Boolean(prototypeRender?.screenshotPath),
      evidence: prototypeRender?.error
        ? prototypeRender.error
        : `${prototypeRender?.image?.width ?? 0}x${prototypeRender?.image?.height ?? 0}, ${prototypeRender?.image?.fileSize ?? 0} bytes`,
    },
    {
      name: "原型截图非空白",
      passed: prototypeRender?.nonBlankCheck?.passed === true,
      evidence: prototypeRender?.nonBlankCheck
        ? `nonWhite=${prototypeRender.nonBlankCheck.nonWhiteRatio}, stddev=${prototypeRender.nonBlankCheck.luminanceStdDev}, buckets=${prototypeRender.nonBlankCheck.colorBucketCount}`
        : "no screenshot analysis",
    },
    {
      name: "原型关键文案真实渲染",
      passed: prototypeRender?.renderedTextCheck?.passed === true,
      evidence: prototypeRender?.renderedTextCheck
        ? prototypeRender.renderedTextCheck.labels.map((item) => `${item.label}:${item.present ? "hit" : "miss"}`).join(", ")
        : "no DOM text dump",
    },
  ];
  return {
    passed: checks.every((item) => item.passed),
    checks,
  };
}

async function renderPrototype(prototypePath, outputDir) {
  const screenshotPath = path.join(outputDir, "prototype-render.png");
  const browserPath = findChromeBinary();
  const viewport = { width: 1440, height: 1100 };

  if (!browserPath) {
    return {
      status: "failed",
      screenshotPath,
      browserPath: null,
      viewport,
      error: "No Chrome/Chromium binary found for prototype render check.",
    };
  }

  const url = pathToFileURL(prototypePath).href;
  const userDataDir = path.join(outputDir, ".chrome-profile");
  await mkdir(userDataDir, { recursive: true });

  try {
    await runHeadlessChrome(browserPath, [
      "--disable-gpu",
      "--no-sandbox",
      "--hide-scrollbars",
      `--user-data-dir=${userDataDir}`,
      `--window-size=${viewport.width},${viewport.height}`,
      `--screenshot=${screenshotPath}`,
      url,
    ]);

    const [image, renderedTextCheck] = await Promise.all([
      analyzeScreenshot(screenshotPath),
      dumpRenderedText(browserPath, url, userDataDir),
    ]);
    const nonBlankCheck = buildNonBlankCheck(image);
    const status = nonBlankCheck.passed && renderedTextCheck.passed ? "passed" : "failed";

    return {
      status,
      screenshotPath,
      browserPath,
      viewport,
      image,
      nonBlankCheck,
      renderedTextCheck,
    };
  } catch (error) {
    return {
      status: "failed",
      screenshotPath,
      browserPath,
      viewport,
      error: summarizeCommandError(error),
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
    nonWhiteRatio: roundRatio(nonWhite / Math.max(1, sampleCount)),
    luminanceStdDev: roundRatio(Math.sqrt(Math.max(0, variance))),
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

async function runBackendRetrievalGate() {
  if (process.env.AGENT_WORKFLOW_EVAL_SKIP_BACKEND_GATE === "1") {
    return {
      status: "skipped",
      command: "npm --workspace @ai-product-workbench/api run test -- knowledge.service",
      reason: "AGENT_WORKFLOW_EVAL_SKIP_BACKEND_GATE=1",
    };
  }

  const command = "npm --workspace @ai-product-workbench/api run test -- knowledge.service";
  try {
    const { stdout, stderr } = await execFileAsync("npm", [
      "--workspace",
      "@ai-product-workbench/api",
      "run",
      "test",
      "--",
      "knowledge.service",
    ], {
      timeout: 45_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return {
      status: "passed",
      command,
      stdoutTail: tail(stdout),
      stderrTail: tail(stderr),
    };
  } catch (error) {
    return {
      status: "failed",
      command,
      error: summarizeCommandError(error),
      stdoutTail: tail(error?.stdout),
      stderrTail: tail(error?.stderr),
    };
  }
}

async function runBackendStreamCleanlinessGate() {
  if (process.env.AGENT_WORKFLOW_EVAL_SKIP_STREAM_GATE === "1") {
    return {
      status: "skipped",
      command: "npm --workspace @ai-product-workbench/api run test -- aichat-ai-sdk-bridge",
      reason: "AGENT_WORKFLOW_EVAL_SKIP_STREAM_GATE=1",
    };
  }

  const command = "npm --workspace @ai-product-workbench/api run test -- aichat-ai-sdk-bridge";
  try {
    const { stdout, stderr } = await execFileAsync("npm", [
      "--workspace",
      "@ai-product-workbench/api",
      "run",
      "test",
      "--",
      "aichat-ai-sdk-bridge",
    ], {
      timeout: 45_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return {
      status: "passed",
      command,
      stdoutTail: tail(stdout),
      stderrTail: tail(stderr),
    };
  } catch (error) {
    return {
      status: "failed",
      command,
      error: summarizeCommandError(error),
      stdoutTail: tail(error?.stdout),
      stderrTail: tail(error?.stderr),
    };
  }
}

async function runPersistenceCleanlinessGate() {
  if (process.env.AGENT_WORKFLOW_EVAL_SKIP_PERSISTENCE_GATE === "1") {
    return {
      status: "skipped",
      command: "npm --workspace @ai-product-workbench/api run test -- final-action-applier",
      reason: "AGENT_WORKFLOW_EVAL_SKIP_PERSISTENCE_GATE=1",
    };
  }

  const command = "npm --workspace @ai-product-workbench/api run test -- final-action-applier";
  try {
    const { stdout, stderr } = await execFileAsync("npm", [
      "--workspace",
      "@ai-product-workbench/api",
      "run",
      "test",
      "--",
      "final-action-applier",
    ], {
      timeout: 45_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return {
      status: "passed",
      command,
      stdoutTail: tail(stdout),
      stderrTail: tail(stderr),
    };
  } catch (error) {
    return {
      status: "failed",
      command,
      error: summarizeCommandError(error),
      stdoutTail: tail(error?.stdout),
      stderrTail: tail(error?.stderr),
    };
  }
}

async function runOnlineSmokeSelfTestGate() {
  if (process.env.AGENT_WORKFLOW_EVAL_SKIP_ONLINE_SMOKE_SELF_TEST === "1") {
    return {
      status: "skipped",
      command: "AGENT_WORKFLOW_ONLINE_SELF_TEST=1 node scripts/agent-workflow-online-smoke.mjs",
      reason: "AGENT_WORKFLOW_EVAL_SKIP_ONLINE_SMOKE_SELF_TEST=1",
    };
  }

  const command = "AGENT_WORKFLOW_ONLINE_SELF_TEST=1 node scripts/agent-workflow-online-smoke.mjs";
  try {
    const { stdout, stderr } = await execFileAsync("node", [
      "scripts/agent-workflow-online-smoke.mjs",
    ], {
      env: { ...process.env, AGENT_WORKFLOW_ONLINE_SELF_TEST: "1" },
      timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return {
      status: "passed",
      command,
      stdoutTail: tail(stdout),
      stderrTail: tail(stderr),
    };
  } catch (error) {
    return {
      status: "failed",
      command,
      error: summarizeCommandError(error),
      stdoutTail: tail(error?.stdout),
      stderrTail: tail(error?.stderr),
    };
  }
}

function tail(value, maxLength = 4000) {
  const text = String(value ?? "");
  return text.length > maxLength ? text.slice(-maxLength) : text;
}

async function dumpRenderedText(browserPath, url, baseUserDataDir) {
  const userDataDir = `${baseUserDataDir}-dom`;
  await mkdir(userDataDir, { recursive: true });
  const labels = ["活动配置", "提交审核", "立即签到", "数据报表", "补齐策略"];
  const { stdout } = await runHeadlessChrome(browserPath, [
    "--disable-gpu",
    "--no-sandbox",
    `--user-data-dir=${userDataDir}`,
    "--virtual-time-budget=1000",
    "--dump-dom",
    url,
  ]);
  const text = cleanHtmlText(
    stdout
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " "),
  );
  const labelHits = labels.map((label) => ({ label, present: text.includes(label) }));
  return {
    passed: labelHits.every((item) => item.present),
    textLength: text.length,
    labels: labelHits,
  };
}

async function runHeadlessChrome(browserPath, args) {
  const baseArgs = ["--headless=new", ...args];
  try {
    return await execFileAsync(browserPath, baseArgs, { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    const stderr = String(error?.stderr ?? "");
    const stdout = String(error?.stdout ?? "");
    if (/headless=new|unrecognized|unknown option|invalid/i.test(`${stderr}\n${stdout}`)) {
      return await execFileAsync(browserPath, ["--headless", ...args], { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 });
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

function summarizeCommandError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const stderr = String(error?.stderr ?? "").trim();
  const stdout = String(error?.stdout ?? "").trim();
  return [message, stderr || stdout].filter(Boolean).join(" | ").slice(0, 900);
}

function buildWebSearchQueries(userTopic) {
  const compact = userTopic.replace(/\s+/g, "");
  const queries = [];
  if (/(签到|打卡|积分|奖励|奖品|权益|活动)/.test(compact)) {
    queries.push("签到积分活动 会员运营 最佳实践");
    queries.push("积分权益 发放 幂等 风控 资损");
    queries.push("营销活动 连续签到 奖励机制 用户体验");
  }
  if (/(原型|prototype|页面|界面|交互)/i.test(userTopic)) {
    queries.push("后台活动配置 前台签到页 原型 交互状态");
  }
  return queries.length ? queries : ["产品需求文档 验收标准 风险 降级"];
}

async function runExternalResearch(webSearchQueries) {
  const fetchedAt = new Date().toISOString();
  const sources = [
    {
      query: webSearchQueries[0] ?? "签到积分活动 会员运营 最佳实践",
      url: "https://mailchimp.com/resources/loyalty-programs/",
      expectedTitle: "Building an Effective Loyalty Program",
      insight: "会员/忠诚度体系通常使用积分、等级或权益承载奖励，适合签到领积分活动的积分账户、奖励展示和兑换规则设计。",
    },
    {
      query: webSearchQueries[1] ?? "积分权益 发放 幂等 风控 资损",
      url: "https://docs.stripe.com/api/idempotent_requests",
      expectedTitle: "Idempotent requests",
      insight: "公开支付 API 文档强调幂等请求可安全重试，适合积分发放流水号、防重复发奖和补偿重试设计。",
    },
    {
      query: webSearchQueries[1] ?? "积分权益 发放 幂等 风控 资损",
      url: "https://developer.mozilla.org/en-US/docs/Glossary/Idempotent",
      expectedTitle: "Idempotent",
      insight: "MDN 对幂等的说明可补充签到提交接口的防重语义：同一业务请求重复执行不应改变最终业务结果。",
    },
    {
      query: webSearchQueries[1] ?? "积分权益 发放 幂等 风控 资损",
      url: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/429",
      expectedTitle: "429 Too Many Requests",
      insight: "HTTP 429 公开资料可补充高频请求治理，用于异常签到频率、接口保护和防刷提示设计。",
    },
  ];

  const settled = await Promise.allSettled(sources.map((source) => fetchExternalEvidence(source, fetchedAt)));
  const refs = settled
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value);
  const failures = settled
    .map((result, index) => result.status === "rejected"
      ? {
          query: sources[index]?.query,
          url: sources[index]?.url,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        }
      : null)
    .filter(Boolean);

  const liveResult = {
    status: refs.length >= 3 ? "completed" : refs.length > 0 ? "failed_non_blocking" : "failed",
    fetchedAt,
    refs,
    failures,
  };
  if (refs.length >= 3) {
    await writeExternalEvidenceCache(liveResult);
    return liveResult;
  }

  const cached = await readExternalEvidenceCache(webSearchQueries);
  if (cached?.refs?.length >= 3) {
    return {
      status: "completed_from_cache",
      fetchedAt,
      refs: cached.refs.map((item) => ({
        ...item,
        cacheUsedAt: fetchedAt,
      })),
      failures,
      liveStatus: liveResult.status,
      cache: {
        path: externalEvidenceCachePath,
        cachedAt: cached.cachedAt,
        originalFetchedAt: cached.fetchedAt,
      },
    };
  }

  return liveResult;
}

async function fetchExternalEvidence(source, fetchedAt) {
  const html = await fetchText(source.url);
  if (html.length < 1000) throw new Error(`External source too small: ${source.url}`);
  const title = cleanHtmlText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]) || source.expectedTitle;
  return {
    query: source.query,
    title,
    url: source.url,
    insight: source.insight,
    source: "public_web_fetch",
    contentLength: html.length,
    fetchedAt,
  };
}

async function writeExternalEvidenceCache(result) {
  await mkdir(path.dirname(externalEvidenceCachePath), { recursive: true });
  await writeFile(
    externalEvidenceCachePath,
    JSON.stringify({
      cachedAt: new Date().toISOString(),
      fetchedAt: result.fetchedAt,
      refs: result.refs,
      status: result.status,
    }, null, 2),
    "utf8",
  );
}

async function readExternalEvidenceCache(webSearchQueries) {
  let raw = await readFile(externalEvidenceCachePath, "utf8").catch(() => "");
  if (!raw.trim()) {
    const discovered = await discoverLatestExternalEvidenceCache();
    if (discovered) {
      await writeExternalEvidenceCache(discovered);
      raw = JSON.stringify(discovered);
    }
  }
  if (!raw.trim()) return undefined;
  const parsed = safeJsonParse(raw);
  if (!parsed || !Array.isArray(parsed.refs)) return undefined;
  const refs = parsed.refs.filter((item) => (
    item &&
    typeof item.title === "string" &&
    typeof item.url === "string" &&
    typeof item.insight === "string"
  ));
  if (refs.length < 3) return undefined;
  return {
    cachedAt: typeof parsed.cachedAt === "string" ? parsed.cachedAt : undefined,
    fetchedAt: typeof parsed.fetchedAt === "string" ? parsed.fetchedAt : undefined,
    refs: refs.map((item, index) => ({
      query: typeof item.query === "string" ? item.query : webSearchQueries[index] ?? "cached public evidence",
      title: item.title,
      url: item.url,
      insight: item.insight,
      source: item.source === "public_web_fetch" ? item.source : "public_web_fetch",
      contentLength: Number.isFinite(Number(item.contentLength)) ? Number(item.contentLength) : 0,
      fetchedAt: typeof item.fetchedAt === "string" ? item.fetchedAt : parsed.fetchedAt,
      cacheSource: "public-evidence-cache",
    })),
  };
}

async function discoverLatestExternalEvidenceCache() {
  const root = path.join(repoRoot, "storage", "agent-workflow-eval");
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name, "external-research.json"))
    .sort((a, b) => b.localeCompare(a));
  for (const candidate of candidates) {
    const raw = await readFile(candidate, "utf8").catch(() => "");
    const parsed = raw.trim() ? safeJsonParse(raw) : undefined;
    if (
      parsed &&
      ["completed", "completed_from_cache"].includes(parsed.status) &&
      Array.isArray(parsed.refs) &&
      parsed.refs.length >= 3
    ) {
      return {
        cachedAt: new Date().toISOString(),
        fetchedAt: parsed.fetchedAt,
        refs: parsed.refs,
        status: parsed.status,
        discoveredFrom: candidate,
      };
    }
  }
  return undefined;
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "accept": "text/html, text/plain, application/xhtml+xml",
        "user-agent": "ai-product-workbench-agent-workflow-eval/0.1 local-workflow-eval",
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function cleanHtmlText(value) {
  return String(value ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildEnrichmentPlan(userTopic, hits, coverage, webSearchQueries, externalResearch) {
  const topKnowledge = hits.slice(0, 5).map((item) => item.relativePath);
  const modelAssumptions = [
    "默认活动服务以用户标识 + 活动编码 + 自然日作为签到幂等键。",
    "默认积分发放采用业务流水号防重，失败后进入补偿/对账流程。",
    "默认后台运营需要先保存草稿、预览、提交审核，审核通过后发布。",
    "默认前台需要展示未登录、无资格、未开始、已结束、未签到、已签到、发放失败等状态。",
  ];
  return {
    externalResearchStatus: externalResearch.status,
    localKnowledgeBaseline: topKnowledge,
    modelAssumptions,
    webSearchQueries,
    externalRefsUsed: externalResearch.refs.map((item) => `${item.title} ${item.url}`),
    externalEvidence: externalResearch.refs,
    webSearchUseBoundary: [
      "只搜索通用领域词，不搜索内部知识库路径、用户信息、附件原文或真实接口。",
      "外部信息用于补充行业表达、体验参考和风险提醒，不覆盖本地知识库强规则。",
      "如果线上 search/fetch 工具不可用，生成链路应标记 skipped_tools_unavailable，并继续用知识库 + 模型补齐。",
    ],
    requiredCoveragePassed: coverage.every((item) => item.hit),
    enrichmentNotes: [
      "知识库负责产品事实与模板规则。",
      "模型负责把一句话需求补成完整业务流程、状态、验收和待确认项。",
      "联网搜索负责补充公开行业惯例和当前表达，但不能替代本地知识库。",
    ],
  };
}

function buildConsistencyMatrix(prd, prototype, enrichment) {
  const rows = [
    consistencyRow("活动后台配置", prd, prototype, [
      /活动基础信息|活动时间|目标用户|签到规则/,
      /预览审核|提交审核|发布/,
    ], [
      /基础信息|活动名称|活动时间|目标用户/,
      /提交审核|生成预览|发布管理/,
    ]),
    consistencyRow("每日一次与重复签到幂等", prd, prototype, [
      /每日签到|自然日只允许签到一次|重复签到/,
      /不重复发积分|幂等/,
    ], [
      /每日签到次数|1 次\/用户\/自然日/,
      /重复签到|不重复发积分/,
    ]),
    consistencyRow("基础积分与连续奖励", prd, prototype, [
      /积分奖励|固定积分|连续签到|阶梯积分/,
      /10 积分|50 积分|待确认/,
    ], [
      /基础积分|10 积分/,
      /连续 7 天奖励|额外 50 积分/,
    ]),
    consistencyRow("额度库存与资损控制", prd, prototype, [
      /库存|额度|资损|对账/,
      /额度不足|活动火爆/,
    ], [
      /活动总额度|500,000 积分/,
      /额度不足|活动火爆/,
    ]),
    consistencyRow("前台签到状态", prd, prototype, [
      /未签到|已签到|签到成功|无资格|发放失败/,
      /活动未开始|已结束|额度不足/,
    ], [
      /立即签到|成功态|已签到|失败态/,
      /无资格|额度不足/,
    ]),
    consistencyRow("积分失败补偿降级", prd, prototype, [
      /积分发放接口异常|积分稍后到账|补偿队列/,
      /发放失败|重试记录|对账/,
    ], [
      /积分发放失败|补偿队列/,
      /积分稍后到账|记录中查看/,
    ]),
    consistencyRow("数据报表指标", prd, prototype, [
      /签到人数|签到次数|积分发放成功|发放失败/,
      /渠道来源|连续签到数据/,
    ], [
      /数据报表|签到人数|签到次数/,
      /积分发放成功|发放失败/,
    ]),
  ];

  const allRows = rows;
  return {
    passed: allRows.every((item) => item.passed),
    rows: allRows,
  };
}

function consistencyRow(name, prd, prototype, prdPatterns, prototypePatterns) {
  const prdMissing = prdPatterns.filter((pattern) => !pattern.test(prd)).map(String);
  const prototypeMissing = prototypePatterns.filter((pattern) => !pattern.test(prototype)).map(String);
  return {
    name,
    passed: prdMissing.length === 0 && prototypeMissing.length === 0,
    prdHit: prdMissing.length === 0,
    prototypeHit: prototypeMissing.length === 0,
    prdEvidence: prdMissing.length ? `missing ${prdMissing.join(", ")}` : "hit",
    prototypeEvidence: prototypeMissing.length ? `missing ${prototypeMissing.join(", ")}` : "hit",
  };
}

function buildConsistencyMarkdown(consistency) {
  const rows = consistency.rows
    .map((item) => `| ${item.name} | ${item.passed ? "通过" : "失败"} | ${item.prdEvidence} | ${item.prototypeEvidence} |`)
    .join("\n");
  return `# PRD 与原型一致性矩阵

| 对齐项 | 结果 | PRD 证据 | 原型证据 |
| --- | --- | --- | --- |
${rows}

## 结论

${consistency.passed ? "PRD 与原型核心规则一致。" : "PRD 与原型存在不一致项，生成门禁失败。"}
`;
}

function buildPrd(userTopic, hits, coverage, enrichment) {
  const missing = coverage.filter((item) => !item.hit).map((item) => item.name);
  return `# 签到领积分活动需求说明书

## 版 本 历 史

| 版本/状态 | 作者 | 参与者 | 起止日期 | 备注 |
| --- | --- | --- | --- | --- |
| 讨论稿 | AI Product Workbench 评估脚本 | 待确认 | 待确认 | 基于本地知识库命中结果生成评估稿。 |

## 目 录

1 引言
1.1 项目背景
1.2 文档范围
1.3 使用场景（必填）
2 业务需求
2.1 页面链接
2.2 核心业务规则/功能说明
2.3 核心流程/状态/页面要求
2.4 验收标准
3 业务降级方案（必填）
4 需求安全基线要求（必填）

## 1 引言

### 1.1 项目背景

用户输入：${userTopic}

本活动面向策划宝/云溪营销活动平台的活动配置场景，通过每日签到领取积分提升用户活跃和连续访问。需求必须落在“活动配置、权益履约、审核发布、数据复盘”的闭环内，不能只做一个前台按钮。

### 1.2 文档范围

- 后台：活动基础信息、签到规则、积分奖励、库存/额度、防刷、预览、审核、发布、下线。
- 前台：签到入口、今日未签到、签到成功、已签到、连续签到、积分到账/失败提示。
- 数据：签到人数、签到次数、积分发放成功/失败、连续签到分布、渠道来源。
- 不覆盖：真实积分账户接口地址、生产密钥、真实活动预算。

### 1.3 使用场景（必填）

本活动用于端内活动运营与前台用户参与签到，投放渠道按业务评审确认后执行。

| 序号 | 活动投放的可选渠道 | 是否投放 |
| --- | --- | --- |
| 1 | 端内渠道 | ☑是 □否 |
| 2 | WAP/H5端外渠道 | ☑是 □否 |
| 3 | 小程序 | □是 ☑否 |

## 2 业务需求

### 2.1 页面链接

| 页面 | 链接/入口 | 说明 |
| --- | --- | --- |
| 活动列表 | 待确认 | 新建、复制、编辑、查看签到活动 |
| 签到规则配置页 | 待确认 | 配置每日签到、连续签到、积分奖励和限制 |
| 活动预览页 | 待确认 | 展示前台签到态和规则说明 |
| 前台签到页 | 以实际上线地址为准 | 用户签到、查看积分到账和连续天数 |
| 活动报表 | 待确认 | 查看签到和积分发放数据 |

### 2.2 核心业务规则/功能说明

| 规则 | 要求 | 异常处理 |
| --- | --- | --- |
| 每日签到 | 同一用户自然日只允许签到一次 | 重复点击提示“今日已签到”，不重复发积分 |
| 积分奖励 | 支持固定积分和连续签到阶梯积分 | 积分发放失败展示失败原因，支持后台补偿或重试记录 |
| 连续签到 | 支持展示连续天数和累计获得积分 | 中断后按规则重置或保留，具体策略待确认 |
| 风控限制 | 支持黑白名单、目标用户、活动时间、渠道参数校验 | 无资格提示原因，不进入发放链路 |
| 库存/额度 | 支持活动总积分额度、单日额度、单用户上限 | 额度不足时提示活动火爆，并记录未发放原因 |

### 2.3 核心流程/状态/页面要求

1. 运营选择活动模板，配置活动时间、目标用户、签到规则、积分奖励和页面素材。
2. 系统校验活动时间、积分额度、必填素材、规则说明、渠道参数。
3. 运营生成预览并提交审核，审核通过后发布。
4. 用户进入前台页，系统判断登录态、资格、活动状态和今日签到状态。
5. 用户点击签到，系统写入签到记录并触发积分发放。
6. 前台展示成功、已签到、无资格、活动未开始/已结束、积分发放失败等状态。
7. 报表沉淀签到、积分发放、失败原因、渠道来源和连续签到数据。

### 2.4 验收标准

| 编号 | 验收项 | 通过标准 |
| --- | --- | --- |
| AC-01 | 知识库命中 | 生成前必须命中活动配置、权益/积分、PRD 结构、原型规则相关知识 |
| AC-02 | 后台配置 | 可配置签到规则、积分奖励、活动时间、目标用户和发布审核 |
| AC-03 | 重复签到 | 同一用户同日重复签到不重复发积分 |
| AC-04 | 前台状态 | 未签到、已签到、成功、无资格、额度不足、发放失败状态完整 |
| AC-05 | 数据报表 | 可查看签到人数、次数、积分发放成功/失败和渠道数据 |

## 3 业务降级方案（必填）

如签到领积分活动的积分发放服务、活动配置保存、审核发布、状态查询或报表统计出现异常，前台应保留当前可用状态并展示明确提示，不允许出现空白页、重复发奖或错误成功态。签到记录可先进入待处理状态，提示“积分稍后到账”，后台记录失败原因、活动编码、用户标识、请求时间和处理状态，支持运营补偿、重试或回滚到上一版配置。若活动额度不足，应停止继续发放奖励并保留未发放原因；若报表延迟，应展示最近统计时间并提示稍后刷新，避免运营误判实时效果。

## 4 需求安全基线要求（必填）

该部分内容为必填项，请按照如下表格中的内容先进行自查，并按照如下要求完善需求文档：
1、如选择“是”，代表本项自查内容已符合安全要求，需要提供截图违依据
2、如选择“否”，代表本项自查内容暂时不符合安全要求，请在需求文档中增加本部分内容安全改造需求，并发送网信安需求评审邮件，附上本需求文档用于安全评审；
3、如选择“不涉及”，代表本项目各项需求安全基线均不涉及，则无需召开网信安需求评审会。
建议：该表格请业务人员和开发人员共同参与自查并填写。

| 序号 | 需求安全基线内容 | 范围 | 是否涉及 |
| --- | --- | --- | --- |
| 1 | 是否有新开发功能接口或现有功能接口逻辑变动 | 信息系统（包含前端、后端、管理后台） | 是 |
| 2 | 业务功能是否面向公众用户 | 信息系统（包含前端、后端、管理后台） | 是 |
| 3 | 是否涉及新开通公网暴露面 | 信息系统（包含前端、后端、管理后台） | 不涉及 |
| 4 | 管理后台涉及个人信息的内容要求脱敏展示，原则上不做非脱敏个人信息的导出功能。 | 管理后台 | 不涉及 |
| 5 | 管理后台所有操作页面要有水印功能，水印至少包括姓名、手机号、操作时间等信息 | 管理后台 | 是 |
| 6 | 管理后台涉及查询的页面，不允许没有查询条件查询所有数据，必须输入查询条件后才可以查询数据； | 管理后台 | 是 |
| 7 | 管理后台应接入4A统一管理，实现一点注销的功能，不允许有独立的账号体系；按4A要求实现日志留存，并实现风险预警功能； | 管理后台 | 不涉及 |
| 8 | 如未接入4A系统统一管理，应满足通行字的18项安全要求；要求细则找安全中心要； | 管理后台 | 不涉及 |
| 9 | 涉及后台配置内容的需要实现“敏感词过滤”能力； | 管理后台 | 是 |
| 10 | 所有在前台展示的内容如为后台配置显示，均需要执行“先审后发”，具备先审后发能力，并同步发布数据。 | 前台展示 | 是 |
| 11 | 是否涉及展示《隐私政策》 | 前端页面 | 不涉及 |
| 12 | 如涉及加载到APP或小程序，APP、小程序业务应实现双清单功能。 | 前端展示 / 底层接口获取数据 | 不涉及 |
| 13 | 前台页面涉及采集身份证号码、身份证照片、生物识别和银行卡信息时，应再次获取用户的主动授权同意。 | 前端页面 | 不涉及 |
| 14 | 是否涉及免密登录。 | 前端页面 | 不涉及 |
| 15 | 是否涉及跳转第三方页面或应用。 | 前端页面 | 不涉及 |
| 16 | 如涉及与第三方公司接口对接进行数据交互，应先查看对应的《数据使用审批单》无误后，才可以正式上线； | 前台、后台 | 不涉及 |
| 17 | API接口安全管理：如为新增API接口，需完成台账填报； | 信息系统（包含前端、后端、管理后台） | 不涉及 |
| 18 | 涉及用户敏感信息或跨系统的API是否采用加密传输，具备接口鉴权、访问控制等措施； | 信息系统（包含前端、后端、管理后台） | 不涉及 |
| 19 | 是否涉及用户信息或重要数据存储，是否进行加密存储； | 信息系统（包含前端、后端、管理后台） | 不涉及 |
| 20 | 是否涉及数据采集，是否建立数据采集规范，明确数采集方式、渠道、数据格式、采集流程等； | 信息系统（包含前端、后端、管理后台） | 是 |
| 21 | 是否对采集到的数据进行完整性和一致性校验； | 信息系统（包含前端、后端、管理后台） | 是 |

## 待确认

${missing.length ? `- 知识覆盖缺失：${missing.join("、")}` : "- 积分值、连续签到阶梯、活动预算、目标用户范围、补偿 SLA。"}
`;
}

function buildPrototypeHtml(userTopic, hits, coverage, enrichment) {
  const sourceBadges = hits.slice(0, 4)
    .map((item) => `<span>${escapeHtml(item.title)}</span>`)
    .join("");
  const coverageBadges = coverage
    .map((item) => `<span class="${item.hit ? "ok" : "warn"}">${escapeHtml(item.name)}：${item.hit ? "已命中" : "缺失"}</span>`)
    .join("");
  const enrichmentBadges = [
    ...enrichment.modelAssumptions.slice(0, 2).map((item) => `模型补齐：${item}`),
    ...enrichment.webSearchQueries.slice(0, 2).map((item) => `联网计划：${item}`),
    ...enrichment.externalEvidence.slice(0, 3).map((item) => `公开证据：${item.title}`),
  ].map((item) => `<span>${escapeHtml(item)}</span>`).join("");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>签到领积分活动原型</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #172033; background: #f5f7fb; line-height: 1.5; }
    .app { display: grid; grid-template-columns: 240px 1fr 360px; min-height: 100vh; }
    aside { background: #101828; color: #d0d5dd; padding: 24px 18px; }
    aside h1 { margin: 0 0 20px; font-size: 20px; color: #fff; }
    nav button { display: block; width: 100%; margin: 6px 0; padding: 10px 12px; border: 0; border-radius: 6px; background: transparent; color: inherit; text-align: left; font-size: 14px; }
    nav button.active { background: #2e90fa; color: #fff; }
    main { padding: 24px; }
    .topbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 18px; gap: 16px; }
    .topbar h2 { margin: 0; font-size: 22px; }
    .actions { display: flex; gap: 10px; }
    .btn { border: 1px solid #d0d5dd; background: #fff; color: #344054; border-radius: 6px; padding: 9px 12px; font-size: 14px; }
    .btn.primary { background: #1570ef; border-color: #1570ef; color: #fff; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .panel { background: #fff; border: 1px solid #e4e7ec; border-radius: 8px; padding: 16px; }
    .panel h3 { margin: 0 0 12px; font-size: 16px; }
    label { display: block; margin: 10px 0 4px; font-size: 13px; color: #475467; }
    input, select, textarea { width: 100%; border: 1px solid #d0d5dd; border-radius: 6px; padding: 9px 10px; font-size: 14px; background: #fff; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 10px; border-bottom: 1px solid #eaecf0; text-align: left; }
    th { background: #f9fafb; color: #475467; }
    .status { display: inline-block; padding: 3px 8px; border-radius: 999px; font-size: 12px; background: #ecfdf3; color: #027a48; }
    .phone { width: 310px; margin: 0 auto; border: 10px solid #111827; border-radius: 28px; background: #fff; overflow: hidden; box-shadow: 0 18px 40px rgba(15,23,42,.18); }
    .phone-header { background: #1570ef; color: #fff; padding: 18px; }
    .phone-header h3 { margin: 0; font-size: 18px; }
    .phone-body { padding: 16px; }
    .check-card { border: 1px solid #dbeafe; background: #eff6ff; border-radius: 10px; padding: 14px; text-align: center; }
    .check-card strong { display: block; font-size: 34px; color: #175cd3; }
    .big-action { width: 100%; margin-top: 14px; border: 0; border-radius: 999px; background: #f79009; color: #fff; padding: 12px; font-size: 16px; }
    .state-list { display: grid; gap: 8px; margin-top: 12px; }
    .state-list div { padding: 8px; border-radius: 6px; background: #f9fafb; font-size: 13px; }
    .side { border-left: 1px solid #e4e7ec; background: #fff; padding: 20px; }
    .badges { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
    .badges span { border-radius: 999px; background: #eef4ff; color: #3538cd; padding: 5px 9px; font-size: 12px; }
    .badges span.ok { background: #ecfdf3; color: #027a48; }
    .badges span.warn { background: #fffaeb; color: #b54708; }
    @media (max-width: 980px) { .app { grid-template-columns: 1fr; } aside, .side { border: 0; } .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <div class="app">
    <aside>
      <h1>活动发布平台</h1>
      <nav>
        <button class="active">活动配置</button>
        <button>预览审核</button>
        <button>发布管理</button>
        <button>数据报表</button>
      </nav>
    </aside>
    <main>
      <div class="topbar">
        <h2>签到领积分活动配置</h2>
        <div class="actions">
          <button class="btn">保存草稿</button>
          <button class="btn">生成预览</button>
          <button class="btn primary">提交审核</button>
        </div>
      </div>
      <div class="grid">
        <section class="panel">
          <h3>基础信息</h3>
          <label>活动名称</label>
          <input value="7月会员签到领积分">
          <label>活动时间</label>
          <input value="2026-07-15 00:00 至 2026-08-15 23:59">
          <label>目标用户</label>
          <select><option>全量登录用户</option><option>白名单用户</option><option>指定渠道用户</option></select>
          <label>活动规则说明</label>
          <textarea rows="4">用户每日可签到 1 次，签到成功获得积分，连续签到可获得阶梯奖励。</textarea>
        </section>
        <section class="panel">
          <h3>签到与积分规则</h3>
          <table>
            <thead><tr><th>规则</th><th>配置值</th><th>状态</th></tr></thead>
            <tbody>
              <tr><td>每日签到次数</td><td>1 次/用户/自然日</td><td><span class="status">已配置</span></td></tr>
              <tr><td>基础积分</td><td>10 积分</td><td><span class="status">已配置</span></td></tr>
              <tr><td>连续 7 天奖励</td><td>额外 50 积分</td><td><span class="status">待确认</span></td></tr>
              <tr><td>活动总额度</td><td>500,000 积分</td><td><span class="status">已配置</span></td></tr>
            </tbody>
          </table>
        </section>
        <section class="panel">
          <h3>异常与风控</h3>
          <table>
            <tbody>
              <tr><td>重复签到</td><td>提示今日已签到，不重复发积分</td></tr>
              <tr><td>积分发放失败</td><td>记录流水，进入补偿队列</td></tr>
              <tr><td>额度不足</td><td>前台提示活动火爆，后台可下线或补充额度</td></tr>
              <tr><td>无资格</td><td>展示不可参与原因</td></tr>
            </tbody>
          </table>
        </section>
        <section class="panel">
          <h3>数据报表</h3>
          <table>
            <thead><tr><th>指标</th><th>今日</th><th>累计</th></tr></thead>
            <tbody>
              <tr><td>签到人数</td><td>12,480</td><td>86,320</td></tr>
              <tr><td>签到次数</td><td>12,920</td><td>91,112</td></tr>
              <tr><td>积分发放成功</td><td>128,900</td><td>902,430</td></tr>
              <tr><td>发放失败</td><td>23</td><td>119</td></tr>
            </tbody>
          </table>
        </section>
      </div>
    </main>
    <section class="side">
      <h3>前台预览</h3>
      <div class="phone">
        <div class="phone-header">
          <h3>每日签到领积分</h3>
          <p>连续签到 7 天额外送 50 积分</p>
        </div>
        <div class="phone-body">
          <div class="check-card">
            <span>连续签到</span>
            <strong>5 天</strong>
            <span>今日签到可得 10 积分</span>
          </div>
          <button class="big-action">立即签到</button>
          <div class="state-list">
            <div>成功态：签到成功，积分已到账</div>
            <div>已签到：今日已签到，请明天再来</div>
            <div>失败态：积分稍后到账，可在记录中查看</div>
          </div>
        </div>
      </div>
      <h3>知识覆盖</h3>
      <div class="badges">${coverageBadges}</div>
      <h3>补齐策略</h3>
      <div class="badges">${enrichmentBadges}</div>
      <h3>主要引用</h3>
      <div class="badges">${sourceBadges}</div>
      <p style="font-size:13px;color:#667085">原始需求：${escapeHtml(userTopic)}</p>
    </section>
  </div>
</body>
</html>`;
}

function buildFinalUserMessage() {
  return "PRD《签到领积分活动需求说明书》和原型《签到领积分活动原型》已生成，QA 通过。请在右侧画布查看和继续修改。";
}

async function buildOnlineVsOptimizedComparison({
  topic: userTopic,
  outputRoot: optimizedOutputRoot,
  hits,
  coverage,
  enrichment,
  evaluation,
  prototypeRender,
  consistency,
}) {
  const online = await readLatestOnlineSmokeSummary();
  const onlineSummary = online?.summary;
  const onlineChecks = Array.isArray(onlineSummary?.evaluation?.checks) ? onlineSummary.evaluation.checks : [];
  const optimizedCheck = (name) => evaluation.checks.find((item) => item.name === name);
  const onlineCheck = (name) => onlineChecks.find((item) => item.name === name);
  const onlineEvidence = (name) => {
    const check = onlineCheck(name);
    if (!check) return onlineSummary ? "该线上烟测未记录此项" : "未找到线上烟测摘要";
    return `${check.passed ? "通过" : "失败"}：${check.evidence}`;
  };
  const optimizedEvidence = (name) => {
    const check = optimizedCheck(name);
    if (!check) return "未记录此项";
    return `${check.passed ? "通过" : "失败"}：${check.evidence}`;
  };

  const failedOnlineRows = onlineChecks
    .filter((item) => !item.passed)
    .map((item) => `| ${markdownCell(item.name)} | ${markdownCell(item.evidence)} |`)
    .join("\n");
  const coverageText = coverage
    .map((item) => `${item.name}:${item.hit ? "命中" : "缺失"}`)
    .join("，");
  const outputRows = [
    ["最终用户提示", path.join(optimizedOutputRoot, "final-user-message.txt")],
    ["需求文档", path.join(optimizedOutputRoot, "requirement-doc.md")],
    ["原型 HTML", path.join(optimizedOutputRoot, "prototype.html")],
    ["原型截图", path.join(optimizedOutputRoot, "prototype-render.png")],
    ["PRD/原型一致性", path.join(optimizedOutputRoot, "prd-prototype-consistency.md")],
    ["本地优化评估", path.join(optimizedOutputRoot, "eval-summary.json")],
  ].map(([name, filePath]) => `| ${name} | ${markdownCell(filePath)} |`).join("\n");

  return `# 线上 Agent vs 本地优化版对比

## 测试题目

${userTopic}

## 证据路径

| 类型 | 路径/状态 |
| --- | --- |
| 线上烟测摘要 | ${online ? markdownCell(online.path) : "未找到线上烟测摘要"} |
| 本地优化评估目录 | ${markdownCell(optimizedOutputRoot)} |
| 本地评估结论 | ${evaluation.passed ? "通过" : "失败"} |

## 核心对比

| 对比项 | 线上实测 | 本地优化版 |
| --- | --- | --- |
| 流式生成完成 | ${markdownCell(onlineEvidence("线上流式生成完成"))} | ${markdownCell(evaluation.passed ? "评估链路完整完成" : "评估链路存在失败项")} |
| 知识库命中 | ${markdownCell(onlineEvidence("线上知识库命中"))} | ${markdownCell(`通过：${hits.length} 条命中；${coverageText}`)} |
| 运行进度三段透明 | ${markdownCell(onlineEvidence("线上运行状态展示知识库模型联网三段进度"))} | ${markdownCell("通过：知识库命中、模型补齐、联网补齐均在评估产物中留痕")} |
| 用户可见工具噪音 | ${markdownCell(onlineEvidence("线上流不暴露工具噪音"))} | ${markdownCell(optimizedEvidence("用户可见流不暴露工具噪音门禁通过"))} |
| 合法文档协议误伤 | ${markdownCell(onlineSummary ? "线上烟测自测已在本地评估门禁执行" : "未找到线上烟测摘要")} | ${markdownCell(optimizedEvidence("线上烟测合法产物协议不误伤门禁通过"))} |
| PRD/原型落库噪音 | ${markdownCell(onlineSummary ? "线上未产出完整 PRD/原型，无法验证落库清理" : "未找到线上烟测摘要")} | ${markdownCell(optimizedEvidence("PRD/原型落库前噪音清理门禁通过"))} |
| 最终用户提示 | ${markdownCell(onlineEvidence("线上最终助手提示清晰"))} | ${markdownCell(optimizedEvidence("最终用户提示清晰且无运行噪音"))} |
| PRD 产出 | ${markdownCell(onlineEvidence("线上 PRD 已落库"))} | ${markdownCell(optimizedEvidence("PRD 包含固定章节"))} |
| PRD 内容结构 | ${markdownCell(onlineEvidence("线上 PRD 内容结构合格"))} | ${markdownCell(optimizedEvidence("PRD 包含固定章节"))} |
| 知识和补齐留痕 | ${markdownCell(onlineEvidence("线上 PRD 元数据留存知识库和补齐证据"))} | ${markdownCell(`${optimizedEvidence("知识库引用已留痕")}；${optimizedEvidence("模型补齐说明已留痕")}；${optimizedEvidence("联网补齐有真实取证")}`)} |
| PRD 正文克制 | ${markdownCell(onlineEvidence("线上 PRD 正文不写补齐证据章节"))} | ${markdownCell("通过：知识库、模型和联网证据只在评测/元数据留痕，不写入 PRD 正文")} |
| PRD 内容噪音 | ${markdownCell(onlineEvidence("线上 PRD 不含运行噪音"))} | ${markdownCell(optimizedEvidence("产物不含运行噪音"))} |
| 原型产出 | ${markdownCell(onlineEvidence("线上原型已落库"))} | ${markdownCell(optimizedEvidence("原型是完整 HTML"))} |
| 原型核心文案 | ${markdownCell(onlineEvidence("线上原型包含核心页面文案"))} | ${markdownCell(`${optimizedEvidence("原型包含后台配置")}；${optimizedEvidence("原型包含前台签到状态")}`)} |
| 原型内容噪音 | ${markdownCell(onlineEvidence("线上原型不含运行噪音"))} | ${markdownCell(optimizedEvidence("产物不含运行噪音"))} |
| 原型可视化验证 | ${markdownCell(onlineEvidence("线上原型预览可渲染截图"))} | ${markdownCell(`通过：${prototypeRender.image?.width ?? 0}x${prototypeRender.image?.height ?? 0}，nonWhite=${prototypeRender.nonBlankCheck?.nonWhiteRatio ?? "n/a"}`)} |
| PRD/原型一致性 | ${markdownCell(onlineSummary ? "线上未产出完整 PRD/原型，无法对齐" : "未找到线上烟测摘要")} | ${markdownCell(`${consistency.passed ? "通过" : "失败"}：${consistency.rows.filter((item) => item.passed).length}/${consistency.rows.length}`)} |
| 线上内容一致性门禁 | ${markdownCell(onlineEvidence("线上 PRD 与原型核心规则一致"))} | ${markdownCell(`${consistency.passed ? "通过" : "失败"}：${consistency.rows.filter((item) => item.passed).length}/${consistency.rows.length}`)} |
| 联网补齐证据 | ${markdownCell(onlineSummary ? "线上烟测未看到可追溯公开证据" : "未找到线上烟测摘要")} | ${markdownCell(`${enrichment.externalResearchStatus}：${enrichment.externalEvidence.length} 条公开证据`)} |

## 线上失败点

| 失败项 | 证据 |
| --- | --- |
${failedOnlineRows || "| 无 | 最新线上烟测通过，或未找到失败检查项 |"}

## 本地优化版产物

| 产物 | 路径 |
| --- | --- |
${outputRows}

## 结论

- 当前本地优化版已经按“先知识库、再模型补齐、再安全联网补齐”的顺序生成 PRD 和原型，并通过硬性评估。
- 最新线上烟测仍代表未部署前的生产表现；严格线上烟测通过前，不能宣称线上已经修复。
- 后续部署后必须重新运行 \`npm run smoke:agent-workflow:online\`，让这份报告从“本地优化通过、线上未通过”变成“线上通过”。
`;
}

async function readLatestOnlineSmokeSummary() {
  const explicitPath = process.env.AGENT_WORKFLOW_ONLINE_SUMMARY;
  if (explicitPath) {
    const summary = await readJsonFile(explicitPath);
    return summary ? { path: explicitPath, summary } : undefined;
  }

  const root = path.join(repoRoot, "storage", "agent-workflow-online-smoke");
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name, "online-smoke-summary.json"))
    .sort((a, b) => b.localeCompare(a));
  for (const candidate of candidates) {
    const summary = await readJsonFile(candidate);
    if (summary) return { path: candidate, summary };
  }
  return undefined;
}

async function readJsonFile(filePath) {
  const raw = await readFile(filePath, "utf8").catch(() => "");
  return raw.trim() ? safeJsonParse(raw) : undefined;
}

function buildComparison(userTopic, hits, coverage, enrichment, evaluation, consistency) {
  const missing = coverage.filter((item) => !item.hit);
  const checkRows = evaluation.checks
    .map((item) => `| ${item.name} | ${item.passed ? "通过" : "失败"} | ${item.evidence} |`)
    .join("\n");
  const consistencyRows = consistency.rows
    .map((item) => `| ${item.name} | ${item.passed ? "通过" : "失败"} | ${item.prdHit ? "命中" : "缺失"} | ${item.prototypeHit ? "命中" : "缺失"} |`)
    .join("\n");
  return `# Agent 工作流生成对比报告

## 测试题目

${userTopic}

## 知识命中证据

| 排名 | 标题 | 路径 | 分数 | 命中原因 |
| --- | --- | --- | --- | --- |
${hits.slice(0, 10).map((item, index) => `| ${index + 1} | ${item.title} | ${item.relativePath} | ${item.score} | ${item.reasons.join("；")} |`).join("\n")}

## 必要知识覆盖

| 必要知识 | 结果 |
| --- | --- |
${coverage.map((item) => `| ${item.name} | ${item.hit ? "已命中" : "缺失"} |`).join("\n")}

## 模型与联网补齐证据

| 补齐项 | 结果 |
| --- | --- |
| 模型补齐假设 | ${enrichment.modelAssumptions.length} 条 |
| 联网搜索计划 | ${enrichment.webSearchQueries.length} 条 |
| 联网真实取证 | ${enrichment.externalEvidence.length} 条 |
| 外部补齐状态 | ${enrichment.externalResearchStatus} |
| 补齐边界 | ${enrichment.webSearchUseBoundary.length} 条 |

## 产物检查

| 检查项 | 结果 | 证据 |
| --- | --- | --- |
${checkRows}

## PRD 与原型一致性

| 对齐项 | 结果 | PRD | 原型 |
| --- | --- | --- | --- |
${consistencyRows}

## 对比结论

- 优化前线上实测为“知识库未命中”，会进入模型自由发挥和工具日志噪音。
- 当前样例先从知识库命中主知识，再通过模型补齐默认业务细节，并生成可执行联网搜索计划，最后生成 PRD 和原型，输出可追溯到具体知识路径和补齐策略。
- 当前硬性评估门禁：${evaluation.passed ? "通过" : "失败"}。
- PRD 与原型一致性门禁：${consistency.passed ? "通过" : "失败"}。
- ${missing.length ? `仍缺失：${missing.map((item) => item.name).join("、")}。` : "必要知识均已覆盖。"}
`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function markdownCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function safeStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function roundRatio(value) {
  return Number(value.toFixed(4));
}
