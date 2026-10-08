import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { artifactVersionDetailSchema, createArtifactVersionRequestSchema, exportCapabilitiesSchema, projectReleaseSchema } from "@workbench/workbench-contracts";
import { prdDocumentV2Example } from "@workbench/workbench-contracts/test-fixtures";

// Controlled browser fixture: validates UI transport and durable draft behavior,
// not the quality or availability of a production model/knowledge provider.
const origin = new URL(process.env.WORKBENCH_E2E_WEB_ORIGIN ?? "http://localhost:3000").origin;
const output = fileURLToPath(new URL("../../output/audit/1.0.0/browser-remediation/", import.meta.url));
const timestamp = "2026-10-08T00:00:00.000Z";
const checksum = "a".repeat(64);
const project = { id: "project-prd-remediation", workspaceId: "workspace-1", title: "PRD 草稿验收", summary: null, status: "active", revision: 1, createdAt: timestamp, updatedAt: timestamp };
const thread = { id: "thread-prd", projectId: project.id, title: "需求", status: "active", revision: 1, createdAt: timestamp, updatedAt: timestamp };
const documents = new Map([["prd-v1", structuredClone(prdDocumentV2Example)]]);
let artifactRevision = 1;
let currentVersionId = "prd-v1";
let failSave = false;
let projectCreates = 0;
const submissions = [];
const mutations = [];
const unknownRequests = [];
const releases = [];
const exportJobs = [];
const probes = [];
const pageErrors = [];
let board = {
  id: "board-prd", projectId: project.id, revision: 1,
  viewport: { x: 320, y: 55, zoom: 0.8 },
  nodes: [{ id: "node-prd", kind: "artifact", parentNodeId: null, order: 0,
    position: { x: 10, y: 10 }, size: { width: 750, height: 1000 },
    artifactId: "artifact-prd", artifactVersionId: "prd-v1",
    data: { protocol: "workbench.board-node.v1", nodeType: "artifact", title: "示例工单需求说明书", artifactKind: "prd" } }],
  edges: [],
};
function version(id = currentVersionId) {
  return { artifactId: "artifact-prd", artifactVersionId: id, version: Number(id.slice(5)), kind: "prd", schemaVersion: 2,
    status: "ready", checksum, createdByRunId: null, createdAt: timestamp };
}
function artifact() {
  return { id: "artifact-prd", projectId: project.id, kind: "prd", title: "示例工单需求说明书", revision: artifactRevision,
    currentVersion: version(), createdAt: timestamp, updatedAt: timestamp };
}
function detail(id) {
  return artifactVersionDetailSchema.parse({ ...version(id), citations: [], knowledgeReleaseId: null, contentMode: "inline", content: documents.get(id) });
}
function release() {
  const pin = { position: 0, artifactId: "artifact-prd", artifactVersionId: currentVersionId, title: artifact().title,
    kind: "prd", version: version().version, schemaVersion: 2, checksum, assets: [] };
  return projectReleaseSchema.parse({
    id: `release-${releases.length + 1}`, projectId: project.id, version: releases.length + 1, status: "ready", createdById: "principal-1",
    boardId: board.id, boardRevision: board.revision, boardSnapshot: structuredClone(board), boardChecksum: checksum,
    artifactPins: [pin], manifest: { protocol: "workbench.project-release.v1", projectId: project.id, releaseVersion: releases.length + 1,
      board: { id: board.id, revision: board.revision, checksum }, artifacts: [pin] }, manifestSha256: checksum,
    failure: null, createdAt: timestamp, finishedAt: timestamp, updatedAt: timestamp,
  });
}
const available = { available: true, authentication: "not_required", reasonCode: null };
async function json(route, value, headers = {}, status = 200) {
  await route.fulfill({ status, contentType: "application/json", headers, body: JSON.stringify(value) });
}
async function until(predicate, page, description) {
  const started = Date.now();
  while (!predicate() && Date.now() - started < 12_000) await page.waitForTimeout(50);
  assert.ok(predicate(), description);
}
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1501, height: 1000 } });
await context.addCookies([{ name: "workbench.session_token", value: "fixture-prd-session", url: origin }]);
await context.route("**/api/auth/**", (route) => json(route, {
  session: { id: "session-prd", token: "fixture-prd-session", userId: "principal-1", expiresAt: "2099-01-01T00:00:00.000Z", createdAt: timestamp, updatedAt: timestamp, ipAddress: null, userAgent: "Playwright" },
  user: { id: "principal-1", name: "PRD Reviewer", email: "prd@example.test", emailVerified: true, image: null, createdAt: timestamp, updatedAt: timestamp },
}));
await context.route("**/api/v1/**", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  const p = url.pathname;
  const method = request.method();
  if (method === "GET" && p === "/api/v1/identity/me") return json(route, { id: "principal-1", issuer: "https://identity.example.test", subject: "prd", email: "prd@example.test", displayName: "PRD Reviewer", defaultWorkspaceId: "workspace-1" });
  if (method === "GET" && p === "/api/v1/identity/preferences") return json(route, { productUpdatesEmail: false, researchInvitations: false, revision: 0, createdAt: null, updatedAt: null }, { etag: '"0"' });
  if (method === "GET" && p === "/api/v1/runtime/models") return json(route, { items: [{ id: "model-1", displayName: "Controlled Model", description: null, supportedWorkflows: ["generate", "redesign", "ideate", "edit"], supportsThinking: true, supportsReasoningEffort: false }] });
  if (method === "GET" && p === "/api/v1/design-presets") return json(route, { items: [] });
  if (method === "GET" && p === "/api/v1/projects") return json(route, { items: [{ ...project, role: "owner", relationship: "owned" }], nextCursor: null });
  if (method === "POST" && p === "/api/v1/workspaces/workspace-1/projects") { projectCreates += 1; return json(route, project, { etag: '"1"' }, 201); }
  if (method === "GET" && p === "/api/v1/workspaces/workspace-1/design-systems") return json(route, { items: [], nextCursor: null });
  if (method === "GET" && p === `/api/v1/projects/${project.id}/bootstrap`) return json(route, { project, access: { role: "owner" }, threads: [thread], selectedThreadId: thread.id, entries: [], board, artifacts: [artifact()], latestRun: null }, { etag: '"1"' });
  if (method === "GET" && p === `/api/v1/threads/${thread.id}/submission-intents/current`) return json(route, { item: null });
  if (method === "POST" && p === `/api/v1/threads/${thread.id}/submission-intents`) {
    submissions.push(request.postDataJSON());
    return json(route, { code: "CONTROLLED_FIXTURE_STOP", message: "Controlled fixture stops before model execution" }, {}, 503);
  }
  if (method === "GET" && p === `/api/v1/projects/${project.id}/import-sources`) return json(route, { items: [], nextCursor: null });
  if (method === "GET" && p === `/api/v1/projects/${project.id}/artifacts`) return json(route, { items: [artifact()], nextCursor: null });
  if (method === "GET" && p === `/api/v1/projects/${project.id}/board`) return json(route, board, { etag: `"${board.revision}"` });
  if (method === "PUT" && p === `/api/v1/projects/${project.id}/board`) {
    assert.equal(request.headers()["if-match"], `"${board.revision}"`);
    board = { ...board, ...request.postDataJSON(), revision: board.revision + 1 };
    mutations.push({ operation: "board.save", artifactVersionId: board.nodes[0].artifactVersionId, revision: board.revision });
    return json(route, board, { etag: `"${board.revision}"` });
  }
  if (method === "GET" && p === "/api/v1/artifacts/artifact-prd") return json(route, artifact(), { etag: `"${artifactRevision}"` });
  if (method === "GET" && p === "/api/v1/artifacts/artifact-prd/versions") return json(route, { items: [...documents.keys()].map(version), nextCursor: null });
  const versionMatch = p.match(/^\/api\/v1\/artifacts\/artifact-prd\/versions\/(prd-v\d+)(?:\/(preference|finalization))?$/u);
  if (method === "GET" && versionMatch) {
    if (versionMatch[2] === "finalization") return json(route, null);
    if (versionMatch[2] === "preference") return json(route, { artifactId: "artifact-prd", artifactVersionId: versionMatch[1], screenId: null, favorite: false, reaction: null, revision: 0, createdAt: null, updatedAt: null }, { etag: `"avp1.0.${"a".repeat(43)}"` });
    return json(route, detail(versionMatch[1]), { etag: `"${checksum}"` });
  }
  if (method === "POST" && p === "/api/v1/artifacts/artifact-prd/versions") {
    const body = createArtifactVersionRequestSchema.parse(request.postDataJSON());
    assert.equal(request.headers()["if-match"], `"${artifactRevision}"`);
    assert.ok(request.headers()["idempotency-key"]);
    if (failSave) {
      mutations.push({ operation: "version.failed", author: body.document.versionHistory[0].author });
      return json(route, { code: "CONTROLLED_SAVE_FAILURE", message: "受控测试：草稿暂时无法保存" }, {}, 503);
    }
    artifactRevision += 1;
    currentVersionId = `prd-v${artifactRevision}`;
    documents.set(currentVersionId, structuredClone(body.document));
    mutations.push({ operation: "version.save", artifactVersionId: currentVersionId, author: body.document.versionHistory[0].author });
    return json(route, detail(currentVersionId), { etag: `"${artifactRevision}"` }, 201);
  }
  if (method === "GET" && p === `/api/v1/projects/${project.id}/releases`) return json(route, { items: releases, nextCursor: null });
  if (method === "POST" && p === `/api/v1/projects/${project.id}/releases`) {
    assert.equal(request.headers()["if-match"], `"${board.revision}"`);
    assert.equal(request.postDataJSON().boardRevision, board.revision);
    const value = release();
    releases.push(value);
    mutations.push({ operation: "release.create", artifactVersionId: value.artifactPins[0].artifactVersionId, boardRevision: value.boardRevision });
    return json(route, value, { etag: `"${checksum}"` }, 201);
  }
  if (method === "GET" && p === `/api/v1/projects/${project.id}/shares`) return json(route, { items: [], activeCount: 0, nextCursor: null });
  if (method === "GET" && p === `/api/v1/projects/${project.id}/exports`) return json(route, { items: exportJobs, nextCursor: null });
  if (method === "GET" && p === "/api/v1/exports/capabilities") return json(route, exportCapabilitiesSchema.parse({
    formats: Object.fromEntries(["html", "react", "figma", "mcp", "docx", "pdf"].map((f) => [f, available])),
    packaging: { single_file: available, zip: available },
    external: Object.fromEntries(["ai_studio", "netlify", "lovable", "bolt"].map((f) => [f, { available: false, authentication: "required", reasonCode: "EXPORT_EXTERNAL_AUTHENTICATION_REQUIRED" }])),
  }));
  if (method === "POST" && p === `/api/v1/projects/${project.id}/exports`) {
    const body = request.postDataJSON();
    mutations.push({ operation: "export.create", ...body });
    const value = { id: `export-${exportJobs.length + 1}`, createdById: "principal-1", ...body, status: "queued", revision: 0,
      output: null, failure: null, createdAt: timestamp, startedAt: null, finishedAt: null, updatedAt: timestamp };
    exportJobs.push(value);
    return json(route, value, { etag: '"0"' }, 201);
  }
  if (method === "GET" && /^\/api\/v1\/exports\/export-\d+$/u.test(p)) return json(route, exportJobs.find((job) => p.endsWith(`/${job.id}`)), { etag: '"0"' });
  unknownRequests.push(`${method} ${p}`);
  return json(route, { code: "FIXTURE_ROUTE_MISSING" }, {}, 404);
});
const page = await context.newPage();
page.setDefaultTimeout(15_000);
page.on("dialog", (dialog) => dialog.accept());
page.on("pageerror", (error) => { pageErrors.push(error.stack ?? error.message); console.error("[browser-error]", error.stack ?? error.message); });
page.on("console", (message) => { if (message.type() === "error") console.error("[browser-console]", message.text()); });
try {
  await page.goto(origin, { waitUntil: "networkidle" });
  const home = page.locator("[data-home-composer]");
  await home.waitFor();
  assert.match(await home.getByRole("button", { name: "选择生成类型" }).innerText(), /需求文档＋原型/u);
  const prompt = home.getByRole("textbox", { name: "提示词" });
  await prompt.fill("请根据知识库生成订单管理需求文档和原型");
  await prompt.dispatchEvent("compositionstart", { data: "型" });
  await prompt.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true, bubbles: true });
  await page.waitForTimeout(200);
  assert.equal(projectCreates, 0, "IME confirmation must not create a project");
  await prompt.dispatchEvent("compositionend", { data: "型" });
  await prompt.press("Shift+Enter");
  await page.waitForTimeout(100);
  assert.equal(projectCreates, 0, "Shift+Enter must not submit");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "知识库", exact: true }).waitFor({ state: "visible" });
  await page.screenshot({ path: `${output}/home-mobile-ime.png`, animations: "disabled", fullPage: true });
  await page.setViewportSize({ width: 1501, height: 1000 });
  await prompt.press("Enter");
  await until(() => submissions.length === 1, page, "Home prompt must reach the controlled submission endpoint");
  assert.deepEqual(submissions[0].requestedArtifactKinds ?? submissions[0].request?.requestedArtifactKinds, ["prd", "prototype"]);
  probes.push({ name: "home-dual-output-ime-mobile-knowledge", passed: true, projectCreates, submissions: submissions.length, requestedArtifactKinds: ["prd", "prototype"] });

  await page.goto(`${origin}/projects/${project.id}`, { waitUntil: "networkidle" });
  await page.locator("[data-workbench-project]").waitFor();
  assert.match(await page.locator("[data-project-composer]").getByRole("button", { name: "选择生成类型" }).innerText(), /需求文档＋原型/u);
  const node = page.locator('.react-flow__node[data-id="node-prd"]');
  async function selectPrd() { await node.focus(); await node.press("Enter"); await page.getByRole("textbox", { name: "版本1作者" }).waitFor(); }
  await selectPrd();
  await page.getByRole("textbox", { name: "版本1作者" }).fill("草稿刷新保留作者");
  await page.locator(".react-flow__pane").click({ position: { x: 1100, y: 250 } });
  await page.locator("[data-prd-editor=active]").waitFor({ state: "hidden" });
  await selectPrd();
  assert.equal(await page.getByRole("textbox", { name: "版本1作者" }).inputValue(), "草稿刷新保留作者");
  await page.reload({ waitUntil: "networkidle" });
  await selectPrd();
  assert.equal(await page.getByRole("textbox", { name: "版本1作者" }).inputValue(), "草稿刷新保留作者");
  assert.equal(documents.size, 1, "Local draft must not silently create a server version");
  probes.push({ name: "prd-deselect-and-reload", passed: true, persistedServerVersion: "prd-v1" });
  await writeFile(`${output}/prd-draft-snapshot.txt`, await page.locator("body").ariaSnapshot());
  await page.screenshot({ path: `${output}/prd-restored-draft.png`, animations: "disabled", fullPage: true });

  failSave = true;
  await page.locator("button[data-global-panel-trigger]").filter({ hasText: "导出" }).click();
  const panel = page.locator("[data-workbench-export-panel]");
  await panel.getByRole("button", { name: "导出 Download Word", exact: true }).click();
  await until(() => mutations.some((m) => m.operation === "version.failed"), page, "Export must attempt draft save");
  await page.waitForTimeout(200);
  assert.equal(releases.length, 0, "Failed draft save must block release publication");
  assert.equal(exportJobs.length, 0, "Failed draft save must block stale export");
  await page.locator("button[data-global-panel-trigger]").filter({ hasText: "导出" }).click();
  await selectPrd();
  assert.equal(await page.getByRole("textbox", { name: "版本1作者" }).inputValue(), "草稿刷新保留作者");
  probes.push({ name: "prd-failed-save-blocks-publication", passed: true, releases: 0, exports: 0, draftRetained: true });

  failSave = false;
  await page.locator("button[data-global-panel-trigger]").filter({ hasText: "导出" }).click();
  await panel.getByRole("button", { name: /^(导出|重试导出) Download Word$/u }).click();
  await until(() => exportJobs.length === 1, page, "Retry must save and export the current draft");
  const saved = mutations.findIndex((m) => m.operation === "version.save");
  const boardSaved = mutations.findIndex((m, i) => i > saved && m.operation === "board.save" && m.artifactVersionId === "prd-v2");
  const published = mutations.findIndex((m) => m.operation === "release.create");
  const exported = mutations.findIndex((m) => m.operation === "export.create");
  assert.ok(saved >= 0 && saved < boardSaved && boardSaved < published && published < exported, JSON.stringify(mutations));
  assert.equal(documents.get("prd-v2").versionHistory[0].author, "草稿刷新保留作者");
  assert.equal(releases[0].artifactPins[0].artifactVersionId, "prd-v2");
  assert.equal(exportJobs[0].selection.artifactVersionId, "prd-v2");
  assert.equal(exportJobs[0].format, "docx");
  await panel.getByRole("button", { name: "取消导出 Download Word", exact: true }).waitFor();
  probes.push({ name: "prd-export-saves-current-draft", passed: true, artifactVersionId: "prd-v2", mutationOrder: ["version.save", "board.save", "release.create", "export.create"] });
  await page.screenshot({ path: `${output}/prd-export-current-version.png`, animations: "disabled", fullPage: true });
  await page.locator("button[data-global-panel-trigger]").filter({ hasText: "导出" }).click();
  await selectPrd();
  assert.equal(await page.getByRole("textbox", { name: "版本1作者" }).inputValue(), "草稿刷新保留作者");
  assert.equal(await page.getByRole("button", { name: "保存 PRD", exact: true }).isEnabled(), false);
  assert.deepEqual(pageErrors, [], "The saved version must render without runtime errors");
  assert.deepEqual(unknownRequests, [], "Every API call must have an explicit controlled fixture");
  const evidence = { version: "1.0.0", evidenceLevel: "controlled-browser-fixture", ok: true, probes, mutations };
  await writeFile(`${output}/prd-remediation.json`, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  console.error(error);
  console.error(JSON.stringify({ probes, pageErrors, unknownRequests, projectCreates, submissions, mutations }, null, 2));
  await Promise.allSettled([
    page.locator("body").ariaSnapshot({ timeout: 5_000 }).then((snapshot) => writeFile(`${output}/prd-failure-snapshot.txt`, snapshot)),
    page.screenshot({ path: `${output}/prd-failure.png`, animations: "disabled", fullPage: true, timeout: 5_000 }),
  ]);
  throw error;
} finally {
  await browser.close();
}
