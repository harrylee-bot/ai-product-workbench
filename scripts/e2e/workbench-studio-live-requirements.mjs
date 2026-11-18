// Run against a dedicated local API in development-auth mode and its migrated test DB.
// The published suite uses a copy of a real release. The scopes suite uses a
// separately indexed, synthetic two-source conflict plus a platform capability map.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer, request as forward } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { PrismaClient } from "@workbench/workbench-db";
import { canonicalJson } from "@workbench/workbench-contracts";
import { chromium } from "playwright";
import { scopeFixtureId, seedRequirementScopes } from "../test-support/studio-requirement-scope-fixture.mjs";

const database = new URL(process.env.WORKBENCH_REQUIREMENTS_TEST_DATABASE_URL);
assert.equal(database.hostname, "127.0.0.1");
assert.match(database.pathname, /_test_/u);
const suite = process.argv[2] ?? "published";
if (suite === "seed-scopes") {
  await seedRequirementScopes(database.href, process.env.WORKBENCH_STUDIO_LIVE_SERVICE_ROOT);
  process.exit(0);
}
const origin = new URL(process.env.WORKBENCH_REQUIREMENTS_TEST_API_URL);
assert.equal(origin.hostname, "127.0.0.1");
assert.ok(["published", "scopes", "restricted", "long-input"].includes(suite));
const db = new PrismaClient({ datasourceUrl: database.href });
const browser = await chromium.launch({ headless: true, executablePath: process.env.WORKBENCH_EXPORT_CHROMIUM_PATH });
const subject = "requirement-proof-" + randomUUID();
// A same-origin HTML page permits normal browser fetches. Every API call is
// forwarded unchanged to Nest, whose API responses carry a restrictive CSP.
const gateway = createServer((req, res) => {
  if (req.url === "/") return res.writeHead(200, { "content-type": "text/html" }).end("<title>Requirement API client</title>");
  if (!req.url.startsWith("/api/v1/")) return res.writeHead(404).end();
  const upstream = forward(new URL(req.url, origin), { method: req.method, headers: { ...req.headers, host: origin.host } }, reply => {
    res.writeHead(reply.statusCode, reply.headers);
    reply.pipe(res);
  });
  upstream.on("error", () => res.writeHead(502).end());
  req.pipe(upstream);
});
await new Promise(resolve => gateway.listen(0, "127.0.0.1", resolve));
const browserOrigin = "http://127.0.0.1:" + gateway.address().port;
const context = await browser.newContext();
const pages = await Promise.all([context.newPage(), context.newPage()]);
const published = ["published", "long-input"].includes(suite)
  ? JSON.parse(await readFile(process.env.WORKBENCH_STUDIO_LIVE_PUBLISHED_KNOWLEDGE, "utf8"))
  : null;
const expectedSource = published?.release.id ?? scopeFixtureId;
const directory = new URL("../../output/audit/1.0.0/requirements/", import.meta.url);
const report = { suite, database: database.pathname.slice(1), browser: browser.version(), subject, turns: [], checks: {} };
const hash = text => createHash("sha256").update(text).digest("hex");
const sufficient = "在现有数字化营销活动平台活动管理模块的 Web 活动列表，为具有原列表访问权限的运营用户增加一个渠道筛选。渠道取自活动已有的渠道枚举；默认全部，允许单选，下拉清除后恢复原列表，筛选与已有搜索组合，切换或清除时回到第一页。无匹配显示现有空状态，记录或渠道为空归为未标记。沿用现有样式、列表接口和权限数据范围，不增加新报表、账户、导航、外部对接或其他页面，不涉及资金、埋点或审批。";
const prd = ["prd"];
let project;
async function request(path, { page = pages[0], body, actor = subject, key, etag, status = body ? 201 : 200 } = {}) {
  const result = await page.evaluate(async ({ url, actor, body, key, etag }) => {
    const response = await fetch(url, { method: body ? "POST" : "GET", headers: {
      "x-workbench-dev-subject": actor, ...(body && { "content-type": "application/json" }),
      ...(key && { "idempotency-key": key }), ...(etag && { "if-match": etag }),
    }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, etag: response.headers.get("etag"), data: await response.json().catch(() => null) };
  }, { url: browserOrigin + "/api/v1" + path, actor, body, key, etag });
  assert.equal(result.status, status, `${path}: HTTP ${result.status} ${result.data?.code ?? ""}`);
  return result;
}
const configuration = (prompt, kinds = prd, sourceIds = []) => ({
  modelId: "deepseek-flash", workflow: "generate", prompt, requestedArtifactKinds: kinds,
  targetSurface: "web", designStyle: { kind: "automatic" }, sourceIds,
});
const url = session => "/requirement-sessions/" + session.data.id;
async function start(title, prompt, kinds, sourceIds) {
  const { data: thread } = await request(`/projects/${project.id}/threads`, { body: { title }, key: randomUUID() });
  return request(`/threads/${thread.id}/requirement-sessions`, { body: { generationRequest: configuration(prompt, kinds, sourceIds) }, key: randomUUID() });
}
function send(session, text, options = {}) {
  const { generationRequest, intent = "discuss", ...overrides } = options;
  return request(url(session) + "/messages", { body: { text, intent, ...(generationRequest && { generationRequest }) },
    key: randomUUID(), etag: session.etag, status: 202, ...overrides });
}
async function wait(session, predicate) {
  const deadline = Date.now() + 145_000;
  while (Date.now() < deadline) {
    const current = await request(url(session));
    if (predicate(current.data)) return current;
    await delay(600);
  }
  throw Error("Timed out waiting for requirement session " + session.data.id);
}
async function analyzed(name, session) {
  const current = await wait(session, item => ["succeeded", "failed"].includes(item.activeTurn.status));
  const value = current.data, turn = value.activeTurn;
  assert.equal(turn.status, "succeeded", name + ": " + turn.failureCode);
  assert.equal(turn.modelId, "deepseek-flash");
  assert.ok(turn.inputTokens > 0 && turn.outputTokens > 0);
  const saved = await db.requirementSummary.findUniqueOrThrow({ where: { sessionId_version: { sessionId: value.id, version: value.summaryVersion } } });
  assert.equal(saved.checksum, value.summaryChecksum);
  assert.equal(hash(canonicalJson(saved.card)), hash(canonicalJson(value.card)));
  const retrieval = saved.contextSnapshot.retrievalEvidence;
  assert.equal(retrieval.length, 2);
  assert.ok(retrieval.every(x => x.mode === "hybrid" && x.candidateCounts.dense > 0 && x.reranker.status === "applied" && !x.degraded));
  const chunks = await db.knowledgeChunk.findMany({ where: { releaseId: saved.knowledgeReleaseId, id: { in: value.evidence.map(x => x.chunkId) } }, include: { document: { include: { release: true } } } });
  for (const citation of value.evidence) {
    const chunk = chunks.find(x => x.id === citation.chunkId);
    assert.ok(chunk && chunk.content.includes(citation.quote), "Quotation must resolve in its release");
    assert.equal(chunk.documentId, citation.documentId);
    assert.equal(chunk.document.release.version, citation.releaseVersion);
    assert.equal(chunk.document.sourcePath, citation.sourcePath);
    assert.equal(hash(citation.quote), citation.checksum);
    const metadata = chunk.document.metadata;
    assert.equal(metadata.copiedFromPublishedRelease.id, expectedSource);
    if (published) {
      assert.equal(metadata.copiedFromPublishedRelease.version, published.release.version);
      assert.ok(published.chunks.some(original => original.document_id === metadata.originalDocumentId
        && metadata.originalChunkIds.includes(original.chunk_id) && original.source_path === citation.sourcePath
        && original.content.includes(chunk.content)), "Indexed chunk must resolve to the original published bytes");
    }
  }
  assert.ok(chunks.length > 0);
  assert.equal(await db.run.count({ where: { threadId: value.threadId } }), 0);
  report.turns.push({ name, sessionId: value.id, turnId: turn.id, state: value.state, model: turn.modelId, inputTokens: turn.inputTokens,
    outputTokens: turn.outputTokens, summaryChecksum: saved.checksum, releaseId: saved.knowledgeReleaseId,
    sourceRelease: expectedSource, sourceVersion: chunks[0].document.metadata.copiedFromPublishedRelease.version, citations: value.evidence.length,
    rerank: retrieval.map(x => x.reranker.status), issues: (value.card?.issues ?? []).map(x => ({ kind: x.kind, impact: x.impact, refs: x.evidenceIds.length })) });
  console.log(name, value.state, value.id);
  return current;
}
function consent(session) {
  return { summaryVersion: session.data.summaryVersion, summaryChecksum: session.data.summaryChecksum,
    acceptedAssumptionIds: (session.data.card?.assumptions ?? []).map(x => x.id), acceptedPlatformChanges: false };
}
async function scenario(name, prompt, intent) {
  return analyzed(name, await send(await start(name, prompt), prompt, { intent }));
}
async function verifyLongInput() {
  const rules = [
    "运营打开列表时显示全部渠道，筛选入口继续使用既有列表的筛选区域，默认不替用户新增任何渠道选项。",
    "依次选择新的渠道值时应替换上一次选择，已有活动名称搜索条件和原有时间筛选均保留。",
    "切换渠道时列表回到第一页，当前其余过滤条件保持生效，用户清空渠道后能看到原数据范围。",
    "运营看到的活动永远受其原有区域及项目权限限制，渠道选项本身不能扩大访问范围。",
    "空渠道值显示为未标记，查询没有匹配活动时复用列表的现有空状态，不新增页面或其他模块。",
    "渠道字段是现有活动字段，不需要新增业务审批，不创建管理渠道枚举的后台或修改活动录入流程。",
    "沿用现有接口、现有分页与请求失败提示；禁用越权数据，不为前端筛选新增跨省数据权限。",
    "活动列表原有列布局、导航与登录保持现状，不纳入账户、支付、审计和报表重建。",
    "发布说明应覆盖默认值、切换、清空、组合条件、分页、无匹配、异常恢复和数据范围。",
    "评审时使用活动运营角色查看 Web 列表；本次具备上线条件的验收范围只包含渠道筛选这项增量。",
    "不增加其他交付，需求文档可使用现有章节安排，避免将局部字段变化写成一套新系统。",
  ];
  const prompt = [sufficient, ...rules, "仅输出需求文档；保留所有原文用于评审。"].join("\n");
  assert.ok(prompt.length > 650);
  const ready = await scenario("long-prd-input", prompt);
  assert.equal(ready.data.state, "ready_to_confirm");
  const receipt = await request(url(ready) + "/confirm", { body: consent(ready), key: randomUUID(), etag: ready.etag, status: 202 });
  const current = await wait(receipt, s => s.confirmation?.status === "started");
  const id = current.data.confirmation.id;
  const frozen = await db.requirementConfirmation.findUniqueOrThrow({ where: { id } });
  const run = await db.run.findUniqueOrThrow({ where: { id: current.data.confirmation.runId } });
  assert.equal(hash(canonicalJson(frozen.baseline.card)), hash(canonicalJson(ready.data.card)));
  assert.ok(frozen.baseline.entries.some(x => x.role === "user" && x.content.text === prompt));
  assert.equal(run.knowledgeReleaseId, ready.data.evidence[0].releaseId);
  assert.equal(hash(canonicalJson(run.request)), hash(canonicalJson(frozen.generationRequest)));
  const extra = "下一版再增加渠道筛选的使用提示，当前不改。";
  await send(current, extra);
  const after = await db.requirementConfirmation.findUniqueOrThrow({ where: { id } });
  assert.equal(hash(canonicalJson(after.baseline)), hash(canonicalJson(frozen.baseline)));
  assert.equal(hash(canonicalJson(after.inputSnapshot)), hash(canonicalJson(frozen.inputSnapshot)));
  assert.equal(await db.run.count({ where: { threadId: ready.data.threadId } }), 1);
  report.checks = { longCharacters: prompt.length, frozenConfirmationId: id, runId: run.id, appendedWhileGenerating: true };
}

async function verifyRestrictedSource() {
  const other = (await request("/identity/me", { actor: subject + "-other" })).data;
  const otherProject = (await request("/workspaces/" + other.defaultWorkspaceId + "/projects", {
    actor: subject + "-other", body: { title: "资料所有者项目" },
  })).data;
  // This suite has no import worker. The private source descriptor stays in
  // the owner's project, and no external content is requested.
  const secretLabel = "private-source-" + randomUUID();
  const selected = (await request("/projects/" + otherProject.id + "/import-sources", {
    actor: subject + "-other", body: { kind: "url_snapshot", sourceUrl: "https://example.test/synthetic-rule", label: secretLabel }, key: randomUUID(),
  })).data;
  const prompt = "按所选依据核对活动规则";
  for (const sourceId of [selected.id, randomUUID()]) {
    const session = await send(await start("restricted-source", prompt, prd, [sourceId]), prompt);
    const failure = (await wait(session, x => x.activeTurn.status === "failed")).data;
    assert.equal(failure.activeTurn.failureCode, "REQUIREMENT_SOURCE_UNAVAILABLE");
    assert.equal(failure.activeTurn.inputTokens, null);
    assert.deepEqual(failure.evidence, []);
    assert.ok(!JSON.stringify(failure).includes(secretLabel));
    assert.equal(await db.requirementSummary.count({ where: { sessionId: failure.id } }), 0);
    assert.equal(await db.run.count({ where: { threadId: failure.threadId } }), 0);
    report.turns.push({ name: "source-access", sessionId: failure.id, code: failure.activeTurn.failureCode });
  }
  report.checks.hiddenForeignAndMissingSourcesIndistinguishable = true;
}
async function verifyScopes() {
  const conflict = await scenario("conflict", "请根据已发布的《青岚试点周一发券规则》和《青岚试点周一补充规则》确定青岚试点周一发券额度，两个文件均生效，发布方尚未裁决差异。请按建议生成。", "confirm_suggestion");
  assert.equal(conflict.data.state, "needs_clarification");
  const issue = conflict.data.card.issues.find(x => x.kind === "conflict" && x.blocking);
  assert.ok(issue);
  const sides = conflict.data.evidence.filter(x => issue.evidenceIds.includes(x.id));
  assert.ok(new Set(sides.filter(x => x.scope === "regional").map(x => x.documentId)).size >= 2);
  assert.equal(conflict.data.confirmation, null);
  const regional = await scenario("regional", "请核实青岚省春风活动试点的发券限额是否适用于全国。依据全国和本省的资料标明范围，不能把省级规定升级为全国规定。");
  const capabilities = regional.data.card.existingCapabilities;
  assert.ok(capabilities.some(x => x.scope === "regional"));
  for (const item of capabilities.filter(x => x.scope === "platform")) {
    assert.ok(regional.data.evidence.some(source => item.evidenceIds.includes(source.id) && source.scope === "platform"));
    assert.ok(!/全国.{0,16}(每人.{0,6})?[一三13]张/u.test(item.description), "Regional quota promoted into platform scope");
  }
  report.checks.conflictingRegionalVersionsAndNoAutomaticGeneration = true;
}
async function verifyPublished() {
  const short = await scenario("short", "优化活动");
  assert.equal(short.data.state, "needs_clarification");
  const messages = (await request(url(short) + "/messages")).data.items;
  assert.ok(messages.some(x => x.role === "assistant"));
  assert.ok((short.data.card?.issues?.length ?? 0) <= 3);
  const missing = await scenario("missing-knowledge", "为营销活动平台新增合作银行现金返还功能。请按现有银行清算协议确定返现金额与结算规则，只有协议被核对后才能落地。我目前无法提供结算协议或规则。", "confirm_suggestion");
  assert.equal(missing.data.state, "needs_clarification");
  assert.ok(missing.data.card.issues.some(x => x.kind === "knowledge_missing" && x.blocking));
  assert.equal(missing.data.confirmation, null);
  const platform = await scenario("platform-change", "在既有营销活动平台的活动导出模块增加 CSV 渠道字段，使用现有权限和现有渠道值，不新增页面。另有待评估建议：升级全平台审批权限引擎，覆盖全部系统及省份。请单列其改造成本及受影响模块，在我同意之前不能纳入交付。仅需需求文档。");
  assert.ok(platform.data.card.modules.length && platform.data.card.platformChanges.some(x => /权限|审批/u.test(x)));
  assert.ok(/成本|投入|评估|工作量|迁移|改造|测试/u.test(platform.data.card.platformChanges.join(" ")));
  await request(url(platform) + "/confirm", { body: consent(platform), key: randomUUID(), etag: platform.etag, status: 409 });
  const initial = await start("concurrent", sufficient);
  const [initialA, initialB] = await Promise.all(pages.map(page => request(url(initial), { page })));
  const messageKey = randomUUID();
  const results = await Promise.all([initialA, initialB].map((s, i) => send(s, sufficient, { key: messageKey, page: pages[i] })));
  assert.equal(results[0].data.activeTurn.id, results[1].data.activeTurn.id);
  const ready = await analyzed("sufficient", results[0]);
  assert.equal(ready.data.state, "ready_to_confirm");
  assert.ok(/渠道/u.test(ready.data.card.changes.join(" ")));
  assert.ok(/列表|筛选/u.test(ready.data.card.reuse.join(" ")));
  assert.ok(ready.data.card.existingCapabilities.every(x => x.evidenceIds.length));
  const newKinds = ["prd", "prototype"];
  const edit = "保留上述业务规则，渠道筛选控件名称显示为“活动渠道”。交付调整为需求文档和可交互的 Web 原型。";
  const latest = await send(ready, edit, { page: pages[1], generationRequest: configuration(edit, newKinds) });
  await request(url(ready) + "/confirm", { body: consent(ready), etag: ready.etag, key: randomUUID(), status: 412 });
  const original = await send(initial, sufficient, { key: messageKey });
  assert.equal(original.data.activeTurn.id, results[0].data.activeTurn.id);
  const updated = await analyzed("revised-output", latest);
  assert.equal(updated.data.state, "ready_to_confirm");
  assert.deepEqual(updated.data.card.outputKinds.toSorted(), newKinds);
  assert.notEqual(ready.data.summaryChecksum, updated.data.summaryChecksum);
  await request(url(updated) + "/confirm", { body: consent(ready), etag: updated.etag, key: randomUUID(), status: 409 });
  const confirmationKey = randomUUID();
  const confirm = page => request(url(updated) + "/confirm", { page, body: consent(updated), etag: updated.etag, key: confirmationKey, status: 202 });
  const receipts = await Promise.all(pages.map(confirm));
  assert.equal(receipts[0].data.confirmation.id, receipts[1].data.confirmation.id);
  await pages[0].reload();
  assert.equal((await confirm(pages[0])).data.confirmation.id, receipts[0].data.confirmation.id);
  const row = await db.requirementConfirmation.findUniqueOrThrow({ where: { id: receipts[0].data.confirmation.id } });
  assert.equal(hash(canonicalJson(row.baseline.card)), hash(canonicalJson(updated.data.card)));
  assert.equal(hash(canonicalJson(row.baseline.evidence)), hash(canonicalJson(updated.data.evidence)));
  assert.equal(row.baseline.summaryChecksum, updated.data.summaryChecksum);
  assert.equal(row.inputSnapshot.knowledgeReleaseId, updated.data.evidence[0].releaseId);
  assert.deepEqual(row.generationRequest.requestedArtifactKinds.toSorted(), newKinds);
  assert.equal(hash(canonicalJson(row.baseline.entries.filter(x => x.role === "user").map(x => x.content.text))), hash(canonicalJson([sufficient, edit])));
  assert.equal(await db.requirementConfirmation.count({ where: { sessionId: updated.data.id } }), 1);
  const journal = (await request(url(updated) + "/messages?limit=1")).data;
  const older = (await request(url(updated) + "/messages?limit=1&cursor=" + encodeURIComponent(journal.nextCursor))).data;
  assert.equal(hash(older.items[0].content.text), hash(edit));
  const member = await request("/identity/me", { actor: subject + "-viewer" });
  await db.workspaceMember.create({ data: { workspaceId: project.workspaceId, principalId: member.data.id, role: "member" } });
  await db.projectMember.create({ data: { workspaceId: project.workspaceId, projectId: project.id, principalId: member.data.id, role: "viewer" } });
  const forbidden = await request(url(updated) + "/messages", { actor: subject + "-viewer", status: 404 });
  assert.ok(!JSON.stringify(forbidden.data).includes(edit));
  await request(url(updated), { actor: subject + "-outsider", status: 404 });
  await request("/threads/" + updated.data.threadId + "/requirement-sessions", { actor: subject + "-viewer", body: { generationRequest: configuration(edit) }, key: randomUUID(), status: 404 });
  const extra = "后续再讨论不同渠道的空状态文案，暂不生成。";
  await send(await request(url(updated)), extra);
  const unchanged = await db.requirementConfirmation.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(hash(canonicalJson(unchanged.baseline)), hash(canonicalJson(row.baseline)));
  assert.equal(hash(canonicalJson(unchanged.inputSnapshot)), hash(canonicalJson(row.inputSnapshot)));
  report.checks = { twoBrowserTabs: true, messageAndConfirmationReplay: true, pagesBoundToSession: true, viewerAndNonMemberDenied: true,
    staleRevisionAndChecksumRejected: true, frozenConfirmationId: row.id, baselineSha256: hash(canonicalJson(row.baseline)), appendedOutsideBaseline: true };
}
try {
  await Promise.all(pages.map(page => page.goto(browserOrigin)));
  const me = (await request("/identity/me")).data;
  assert.ok(await db.principal.findUnique({ where: { id: me.id } }), "API and test database must match");
  project = (await request("/workspaces/" + me.defaultWorkspaceId + "/projects", { body: { title: "活动管理需求专项" } })).data;
  report.project = project.id;
  if (suite === "long-input") await verifyLongInput();
  else if (suite === "restricted") await verifyRestrictedSource();
  else if (suite === "scopes") await verifyScopes();
  else await verifyPublished();
  report.status = "passed";
} finally {
  await mkdir(directory, { recursive: true });
  await writeFile(new URL(suite + "-" + subject + ".json", directory), JSON.stringify(report, null, 2));
  await browser.close();
  await new Promise(resolve => gateway.close(resolve));
  await db.$disconnect();
}
