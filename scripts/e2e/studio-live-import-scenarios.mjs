import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { externalImportCases, missingWebsite } from "./studio-live-import-upstream.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const fatal = message => Object.assign(new Error(message), { fatal: true });

export async function runStudioLiveImportScenarios({ page, browser, webOrigin, runId, outDir, dbUrl, sql, waitUntil, evidence, step, fixtures, s3, bucket }) {
  const report = evidence.externalImports = {
    upstream: "Loopback HTTP fixture with injected provider DNS and socket transport; real URL, GitHub and Figma provider adapters",
    model: "Loopback catalog for selection only; analysis model intentionally unconfigured",
    sources: [],
  };
  const query = async (text, values = []) => (await sql(text, values, dbUrl)).rows;
  const checkpoint = () => writeFile(path.join(outDir, "imports-progress.json"), JSON.stringify(report, null, 2));
  const api = (tab, method, route, body) => tab.evaluate(async args => {
    const response = await fetch("/api/v1" + args.route, {
      method: args.method,
      ...(args.body ? { body: JSON.stringify(args.body), headers: { "Content-Type": "application/json", "Idempotency-Key": args.key } } : {}),
    });
    return { status: response.status, data: await response.json().catch(() => null) };
  }, { method, route, body, key: randomUUID() });

  async function register(tab, role) {
    await tab.goto(`${webOrigin}/register`);
    await waitUntil(async () => await tab.locator("#username").count() === 1, "Hydrated registration form", 30000);
    const name = `imports_${role}_${runId}`;
    await tab.locator("#username").fill(name);
    await tab.locator("#email").fill(`${name}@example.test`);
    await tab.locator("#password").fill(randomBytes(24).toString("base64url") + "!1aA");
    await tab.getByRole("button", { name: "创建工作台", exact: true }).click();
    await tab.waitForURL(`${webOrigin}/`);
  }

  step("Register and import three original source locators in real Studio");
  await register(page, "owner");
  await page.getByRole("textbox", { name: "新项目名称" }).fill(`外部资料验收 ${runId}`);
  await page.getByRole("button", { name: "创建项目 →", exact: true }).click();
  await page.waitForURL(/\/studio\//);
  const projectId = report.projectId = new URL(page.url()).pathname.split("/").at(-1);
  const resources = page.locator(".studio-rail").getByRole("button", { name: "资料", exact: true });
  await resources.click();
  const endpoint = `/api/v1/projects/${projectId}/import-sources`;
  const submitImport = async ({ kind, locator, ref }) => {
    await page.getByRole("combobox", { name: "资料类型" }).selectOption(kind);
    await page.getByRole("textbox", { name: "资料地址" }).fill(locator);
    if (ref) await page.getByRole("textbox", { name: "Git 分支" }).fill(ref);
    const reply = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === endpoint);
    await page.getByRole("button", { name: "导入", exact: true }).click();
    const accepted = await reply;
    assert.equal(accepted.status(), 201);
    assert.deepEqual(accepted.request().postDataJSON(), kind === "url_snapshot"
      ? { kind, sourceUrl: locator }
      : kind === "github_snapshot" ? { kind, repository: locator, ref } : { kind, fileKey: locator });
    const source = await accepted.json();
    assert.equal(source.projectId, projectId);
    assert.equal(source.kind, kind);
    assert.equal(source.status, "pending");
    return source;
  };

  for (const fixture of externalImportCases) {
    const created = await submitImport(fixture);
    const row = await waitUntil(async () => {
      const [source] = await query(`SELECT s.status,s.descriptor,s.checksum,s.failure_code,a.status AS attempt_status,
        a.queue_job_id,a.attempt FROM workbench.import_sources s
        JOIN workbench.import_source_attempts a ON a.import_source_id=s.id
        WHERE s.project_id=$1 AND s.id=$2 ORDER BY a.attempt DESC LIMIT 1`, [projectId, created.id]);
      if (source?.status === "failed") throw fatal(`${fixture.kind} rejected: ${source.failure_code}`);
      return source?.status === "ready" ? source : false;
    }, `${fixture.kind} real Import Worker terminal state`, 90000, 300);
    assert.deepEqual(row.descriptor, fixture.descriptor);
    assert.equal(row.attempt_status, "succeeded");
    assert.equal(row.attempt, 1);
    assert.ok(row.queue_job_id);
    assert.match(row.checksum, /^[0-9a-f]{64}$/u);
    const blobs = await query(`SELECT m.blob_id,m.path,m.sha256,m.byte_size,b.storage_key,b.status,scan.status AS scan,scan.scanner
      FROM workbench.import_source_blobs m JOIN workbench.blobs b ON b.id=m.blob_id
      JOIN LATERAL (SELECT status,scanner FROM workbench.blob_scans WHERE blob_id=b.id ORDER BY attempt DESC LIMIT 1) scan ON true
      WHERE m.import_source_id=$1 AND m.project_id=$2 ORDER BY m.position`, [created.id, projectId]);
    assert.equal(blobs.length, fixture.blobs.length);
    for (const [index, blob] of blobs.entries()) {
      const expected = fixture.blobs[index];
      assert.equal(blob.path, expected.path);
      assert.equal(blob.sha256, sha(expected.body));
      assert.equal(blob.status, "ready");
      assert.equal(blob.scan, "clean");
      assert.equal(blob.scanner, "clamav");
      const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: blob.storage_key }));
      const bytes = await object.Body.transformToByteArray();
      assert.equal(sha(bytes), blob.sha256);
      assert.equal(bytes.byteLength, Number(blob.byte_size));
    }
    const source = await api(page, "GET", `/import-sources/${created.id}`);
    assert.equal(source.status, 200);
    assert.equal(source.data.status, "ready");
    const resource = page.locator(".studio-resource-list article").filter({ has: page.getByRole("heading", { name: created.label, exact: true }) });
    await resource.getByText("可用于生成", { exact: false }).waitFor();
    const item = { id: created.id, label: created.label, descriptor: row.descriptor, checksum: row.checksum, queueJobId: row.queue_job_id, attempt: row.attempt, blobs: blobs.map(blob => ({ id: blob.blob_id, path: blob.path, sha256: blob.sha256, byteSize: Number(blob.byte_size), scanner: blob.scanner })) };
    report.sources.push(item);
    await checkpoint();
  }

  step("Verify failed imports stay unavailable for selection");
  const failed = await submitImport({ kind: "url_snapshot", locator: missingWebsite });
  const failedResource = page.locator(".studio-resource-list article").filter({ has: page.getByRole("heading", { name: failed.label, exact: true }) });
  await failedResource.getByText("导入失败", { exact: false }).waitFor();
  assert.equal(await failedResource.getByRole("checkbox", { name: `本次引用 ${failed.label}` }).isDisabled(), true);
  const [failure] = await query("SELECT failure_code FROM workbench.import_sources WHERE id=$1 AND project_id=$2 AND status='failed'", [failed.id, projectId]);
  assert.equal(failure.failure_code, "IMPORT_REMOTE_NOT_FOUND");
  report.failedSource = { id: failed.id, failureCode: failure.failure_code, resourceSelectionDisabled: true };

  step("Select all original imports in the real Composer and send the exact Source IDs");
  await page.locator(".studio-rail").getByRole("button", { name: "页面", exact: true }).click();
  const composer = page.getByLabel("需求输入");
  const picker = composer.getByRole("button", { name: /^资料(?: \d+)?$/u });
  await picker.click();
  for (const item of report.sources) await composer.getByRole("checkbox", { name: item.label + " · ready", exact: true }).check();
  assert.equal(await composer.getByRole("checkbox", { name: failed.label + " · failed", exact: true }).isDisabled(), true);
  await picker.click();
  await page.getByRole("combobox", { name: "模型", exact: true }).waitFor();
  await waitUntil(async () => (await page.getByRole("combobox", { name: "模型", exact: true }).inputValue()) === "deepseek-flash", "Loopback model catalog selector", 30000);
  const sent = page.waitForResponse(response => response.request().method() === "POST" && /\/api\/v1\/requirement-sessions\/[^/]+\/messages$/u.test(new URL(response.url()).pathname));
  await page.getByRole("textbox", { name: "描述需求或修改" }).fill("请核对这三份活动渠道资料。");
  await page.screenshot({ path: path.join(outDir, "external-imports-selected.png") });
  await page.getByRole("button", { name: "发送需求", exact: true }).click();
  const accepted = await sent;
  assert.ok(accepted.ok());
  const payload = accepted.request().postDataJSON();
  const { id: sessionId } = await accepted.json();
  const expected = report.sources.map(item => item.id);
  assert.deepEqual([...payload.generationRequest.sourceIds].sort(), [...expected].sort());
  assert.equal(payload.generationRequest.modelId, "deepseek-flash");
  assert.deepEqual(payload.generationRequest.requestedArtifactKinds, ["prd", "prototype"]);
  const [turn] = await query(`SELECT s.id AS session_id,t.id AS turn_id,t.input->'request' AS request
     FROM workbench.requirement_sessions s JOIN workbench.requirement_turns t ON t.id=s.current_turn_id
     WHERE s.id=$1 AND s.project_id=$2`, [sessionId, projectId]);
  assert.deepEqual(turn.request.sourceIds, payload.generationRequest.sourceIds);
  const [runs] = await query("SELECT count(*)::int AS count FROM workbench.runs WHERE project_id=$1", [projectId]);
  assert.equal(runs.count, 0);
  report.composer = { sessionId, turnId: turn.turn_id, actualSourceIds: payload.generationRequest.sourceIds, modelId: payload.generationRequest.modelId, requestedArtifactKinds: payload.generationRequest.requestedArtifactKinds, status: accepted.status(), generationRunsCreated: runs.count };
  await checkpoint();

  step("Verify outsider concealment and viewer write denial on the real API");
  const viewerContext = await browser.newContext();
  try {
    const viewer = await viewerContext.newPage();
    await register(viewer, "viewer");
    const read = `/import-sources/${report.sources[0].id}`;
    assert.equal((await api(viewer, "GET", read)).status, 404);
    const { data: identity } = await api(viewer, "GET", "/identity/me");
    // Fixture-only membership setup. The following reads and writes use the real BFF.
    const membershipDb = new URL(dbUrl);
    membershipDb.searchParams.set("options", "-c search_path=workbench,public");
    await sql(`INSERT INTO workbench.project_members(project_id,workspace_id,principal_id,role,updated_at)
      SELECT id,workspace_id,$2,'viewer',now() FROM workbench.projects WHERE id=$1`, [projectId, identity.id], membershipDb.href);
    assert.equal((await api(viewer, "GET", read)).status, 200);
    const denied = await api(viewer, "POST", `/projects/${projectId}/import-sources`, { kind: "url_snapshot", sourceUrl: missingWebsite });
    assert.ok([403, 404].includes(denied.status));
    report.access = { outsiderRead: 404, viewerRead: 200, viewerWrite: denied.status, membership: "Isolated SQL viewer fixture" };
  } finally {
    await viewerContext.close();
  }
  report.upstreamCalls = fixtures.upstreamCalls;
  for (const host of ["api.github.com", "api.figma.com"]) assert.ok(report.upstreamCalls.some(call => call.host === host && call.authenticated));
  assert.equal(fixtures.modelCalls.some(call => call.method === "POST"), false);
  report.modelCatalogRequests = fixtures.modelCalls.filter(call => call.method === "GET" && call.route === "/api/models").length;
  assert.ok(report.modelCatalogRequests > 0);
  const [analysis] = await query("SELECT status,failure_code FROM workbench.requirement_turns WHERE id=$1", [turn.turn_id]);
  report.composer.analysisTurn = { status: analysis.status, failureCode: analysis.failure_code };
  report.status = "passed";
  await checkpoint();
}
