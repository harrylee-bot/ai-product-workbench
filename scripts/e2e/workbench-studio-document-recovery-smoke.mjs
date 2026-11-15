// Real Studio document editor and browser storage; strict controlled API, no model acceptance claim.
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { prdDocumentV3Example } from "@workbench/workbench-contracts/test-fixtures";
import {
  artifactSchema,
  artifactVersionDetailSchema,
  createArtifactVersionRequestSchema,
  artifactVersionRelationsSchema,
  canonicalJson,
} from "@workbench/workbench-contracts";
const origin = process.env.WORKBENCH_E2E_WEB_ORIGIN ?? "http://127.0.0.1:18930";
const output = new URL(
  "../../output/audit/1.0.0/studio-document-recovery/",
  import.meta.url,
);
await mkdir(output, { recursive: true });
const now = "2026-11-16T00:00:00Z",
  projectId = "document-project";
const project = {
  id: projectId,
  workspaceId: "workspace-1",
  title: "文档编辑与恢复",
  summary: null,
  status: "active",
  revision: 1,
  createdAt: now,
  updatedAt: now,
};
const thread = {
  id: "thread-1",
  projectId,
  title: "需求",
  status: "active",
  revision: 1,
  createdAt: now,
  updatedAt: now,
};
const artifact = {
  id: "prd-one",
  projectId,
  kind: "prd",
  title: "示例需求",
  revision: 1,
  currentVersion: null,
  createdAt: now,
  updatedAt: now,
};
const versions = new Map(),
  receipts = new Map(),
  writes = [];
let lose = true,
  conflict = false,
  delayed = false,
  releaseRead,
  readStarted = false,
  role = "owner";
const results = { checks: [], errors: [], unknown: [], requests: [] };
const addVersion = (content) => {
  const version = versions.size + 1,
    id = `prd-v${version}`,
    checksum = createHash("sha256")
      .update(canonicalJson(content))
      .digest("hex");
  const summary = {
    artifactId: artifact.id,
    artifactVersionId: id,
    version,
    kind: "prd",
    schemaVersion: 3,
    status: "ready",
    checksum,
    createdByRunId: null,
    createdAt: now,
  };
  const detail = artifactVersionDetailSchema.parse({
    ...summary,
    contentMode: "inline",
    citations: content.citations,
    knowledgeReleaseId: null,
    sourcePrdVersionId: null,
    content,
  });
  versions.set(id, { summary, detail });
  artifact.currentVersion = summary;
  return detail;
};
addVersion(structuredClone(prdDocumentV3Example));
artifactSchema.parse(artifact);
const bootstrap = () => ({
  project,
  access: { role },
  threads: [thread],
  selectedThreadId: thread.id,
  entries: [],
  board: {
    id: "board-1",
    projectId,
    revision: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    edges: [],
  },
  artifacts: [artifact],
  latestRun: null,
});
const json = (route, value, status = 200, etag = '"1"') =>
  route.fulfill({
    status,
    contentType: "application/json",
    headers: { etag },
    body: JSON.stringify(value),
  });
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
});
await context.addCookies([
  { name: "workbench.session_token", value: "fixture", url: origin },
]);
await context.route("**/api/**", async (route) => {
  const request = route.request(),
    url = new URL(request.url()),
    path = url.pathname,
    method = request.method();
  results.requests.push(`${method} ${path}`);
  if (path === "/api/auth/get-session")
    return json(route, {
      session: {
        id: "session",
        token: "media-fixture",
        userId: "owner-1",
        expiresAt: "2099-01-01T00:00:00Z",
        createdAt: now,
        updatedAt: now,
      },
      user: {
        id: "owner-1",
        name: "图片验收",
        email: "owner@example.test",
        emailVerified: true,
        image: null,
        createdAt: now,
        updatedAt: now,
      },
    });
  if (path.endsWith("/identity/me"))
    return json(route, {
      id: "owner-1",
      issuer: "https://identity.example.test",
      subject: "owner",
      email: "owner@example.test",
      displayName: "图片验收",
      defaultWorkspaceId: "workspace-1",
    });
  if (path.endsWith("/identity/preferences"))
    return json(route, {
      productUpdatesEmail: false,
      researchInvitations: false,
      revision: 0,
      createdAt: null,
      updatedAt: null,
    });
  if (path.endsWith("/bootstrap")) return json(route, bootstrap());
  if (path.endsWith("/runtime/models") || path.endsWith("/design-presets"))
    return json(route, { items: [] });
  if (path.endsWith("/submission-intents/current"))
    return json(route, { item: null });
  if (
    [
      "/prototype-v2/plans",
      "/prototype-v2/shares",
      "/prototype-v2/exports",
    ].some((s) => path.endsWith(s))
  )
    return json(route, []);

  if (path === `/api/v1/projects/${projectId}/artifacts`)
    return json(route, { items: [artifact], nextCursor: null });
  if (path === `/api/v1/artifacts/${artifact.id}`) {
    if (delayed) {
      readStarted = true;
      await new Promise((resolve) => {
        releaseRead = resolve;
      });
      delayed = false;
    }
    return json(route, artifact, 200, `"${artifact.revision}"`);
  }
  if (path === `/api/v1/artifacts/${artifact.id}/versions`) {
    if (method === "GET")
      return json(route, {
        items: [...versions.values()].map((v) => ({
          ...v.summary,
          contentMode: "inline",
        })),
        nextCursor: null,
      });
    const body = createArtifactVersionRequestSchema.parse(
        request.postDataJSON(),
      ),
      key = request.headers()["idempotency-key"],
      etag = request.headers()["if-match"];
    writes.push({ body, key, etag });
    assert(key);
    if (receipts.has(key)) {
      assert.deepEqual(body, receipts.get(key).body);
      assert.equal(etag, receipts.get(key).etag);
      return json(route, receipts.get(key).detail, 201);
    }
    if (conflict)
      return json(
        route,
        {
          status: 412,
          title: "Newer version exists",
          type: "about:blank",
          code: "PRECONDITION_FAILED",
        },
        412,
      );
    assert.equal(etag, `"${artifact.revision}"`);
    assert.equal(
      body.baseArtifactVersionId,
      artifact.currentVersion.artifactVersionId,
    );
    const baseline = versions.get(body.baseArtifactVersionId).detail.content;
    assert.equal(body.document.documentId, baseline.documentId);
    assert.equal(body.document.revision.number, baseline.revision.number + 1);
    assert.deepEqual(body.document.citations, baseline.citations);
    const detail = addVersion(body.document);
    artifact.revision++;
    receipts.set(key, { body, etag, detail });
    if (lose) {
      lose = false;
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
    }
    return json(route, detail, 201);
  }
  const version = [...versions.values()].find((v) =>
    path.startsWith(
      `/api/v1/artifacts/${artifact.id}/versions/${v.summary.artifactVersionId}`,
    ),
  );
  if (version) {
    if (path.endsWith("/relations"))
      return json(
        route,
        artifactVersionRelationsSchema.parse({
          version: {
            ...Object.fromEntries(
              Object.entries(version.summary).filter(
                ([key]) => !["checksum", "createdAt"].includes(key),
              ),
            ),
            title: artifact.title,
            prototypeRevision: null,
          },
          sourcePrd: null,
          derivedPrototypes: [],
          nextCursor: null,
        }),
      );
    return json(route, version.detail, 200, `"${version.summary.checksum}"`);
  }
  if (
    ["/import-sources", "/design-systems", "/releases"].some((s) =>
      path.endsWith(s),
    )
  )
    return json(route, { items: [], nextCursor: null });
  results.unknown.push(`${method} ${path}`);
  return json(route, { status: 404, title: "Missing fixture" }, 404);
});
const page = await context.newPage();
page.setDefaultTimeout(20000);
page.on("pageerror", (e) => results.errors.push(e.message));
const open = async (version = "prd-v1") =>
  page.goto(
    `${origin}/studio/${projectId}?view=documents&artifact=prd-one${version ? `&artifactVersion=${version}` : ""}`,
    { waitUntil: "networkidle" },
  );
const textField = () =>
  page.getByLabel(
    "编辑 sections / introduction / background / blocks / 0 / content / 0 / text",
    { exact: true },
  );
try {
  await open(null);
  await page.waitForURL(/artifactVersion=prd-v1/);
  await page.getByRole("button", { name: "编辑文档", exact: true }).click();
  await textField().fill(
    "修改后的项目背景；保留原始版本，形成可追溯文档修订。",
  );
  await page
    .getByRole("button", { name: "退出编辑并保留草稿", exact: true })
    .click();
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: "恢复文档编辑", exact: true }).click();
  assert.equal(
    await textField().inputValue(),
    "修改后的项目背景；保留原始版本，形成可追溯文档修订。",
  );
  assert.equal(versions.size, 1);
  results.checks.push(
    "nested PRD edit survives close and reload without changing its frozen source version",
  );
  await page.getByRole("button", { name: "保存新版本", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Response lost" }).waitFor();
  assert.equal(versions.size, 2);
  const command = structuredClone(writes[0]);
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: "恢复文档编辑", exact: true }).click();
  await page.getByRole("button", { name: "保存新版本", exact: true }).click();
  await page.waitForURL(/artifactVersion=prd-v2/);
  assert.equal(versions.size, 2);
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1], command);
  assert.equal(versions.get("prd-v1").detail.content.revision.number, 1);
  assert.equal(versions.get("prd-v2").detail.content.revision.number, 2);
  assert.equal(
    versions.get("prd-v1").detail.content.sections.introduction.background
      .blocks[0].content[0].text,
    prdDocumentV3Example.sections.introduction.background.blocks[0].content[0]
      .text,
  );
  results.checks.push(
    "manual save advances revision and preserves base; accepted/lost response replays identical body, key and ETag after reload although current version advanced",
  );
  await page.getByRole("button", { name: "编辑文档", exact: true }).click();
  await textField().fill("冲突中的本地修改仍需保留。");
  conflict = true;
  await page.getByRole("button", { name: "保存新版本", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "输入内容已保留" }).waitFor();
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: "恢复文档编辑", exact: true }).click();
  assert.equal(await textField().inputValue(), "冲突中的本地修改仍需保留。");
  assert.equal(versions.size, 2);
  await page.getByRole("button", { name: "放弃文档草稿", exact: true }).click();
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(
    await page
      .getByRole("button", { name: "恢复文档编辑", exact: true })
      .count(),
    0,
  );
  results.checks.push(
    "CAS conflict retains editable draft after refresh; explicit discard clears only the local draft",
  );
  conflict = false;
  await page.getByRole("button", { name: "编辑文档", exact: true }).click();
  await textField().fill("离开文档后不得继续提交。");
  delayed = true;
  const before = writes.length;
  await page.getByRole("button", { name: "保存新版本", exact: true }).click();
  for (let i = 0; !readStarted && i < 100; i++) await page.waitForTimeout(20);
  assert(readStarted);
  await page
    .locator(".studio-rail")
    .getByRole("button", { name: "资料", exact: true })
    .click();
  releaseRead();
  await page.waitForTimeout(500);
  assert.equal(writes.length, before);
  results.checks.push(
    "late artifact preflight after leaving editor cannot create another version",
  );
  role = "viewer";
  await open("prd-v2");
  assert(
    await page
      .getByRole("button", { name: "恢复文档编辑", exact: true })
      .isDisabled(),
  );
  assert.deepEqual(results.unknown, []);
  assert.deepEqual(results.errors, []);
  results.checks.push(
    "viewer cannot resume another editable session or save a version",
  );
  results.status = "passed";
} catch (error) {
  results.status = "failed";
  results.error = String(error.stack ?? error);
  await page.screenshot({ path: new URL("failure.png", output).pathname });
  throw error;
} finally {
  await writeFile(
    new URL("results.json", output),
    JSON.stringify({ ...results, writes }, null, 2),
  );
  await browser.close();
}
console.log(JSON.stringify({ status: results.status, checks: results.checks }));
