import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import { unzipSync } from "fflate";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const increment = "在云溪营销极速发布平台现有活动管理列表中，为策划人员增加渠道类型筛选。只筛当前角色已授权区域内活动，已有登录、导航、审核发布和报表保持不变。筛选项为全部、企微、短信，默认全部；与现有分页联动，改变筛选重置第一页，空结果提示无匹配活动，失败保留条件可重试。复用当前活动列表查询能力，仅扩展筛选参数，不接新外部系统，不改业务流程。目标为Web端，沿用原设计规范。";
const interactionSpec = "原型交互验收：列表页包含标签为渠道类型的原生select、全部/企微/短信三个选项，和占位文字搜索活动的搜索框。提供企微活动与短信活动各两条，切换渠道后真实隐藏其他渠道的行。输入搜索词真实按活动名称过滤，不存在的名称显示无匹配活动；清空搜索恢复列表。点击活动旁查看详情打开第二个活动详情页，详情提供返回列表按钮，点击后可返回。两页均可实际操作，不新增登录页或报表页。";

export async function runStudioLiveScenarios({ page, browser, webOrigin, outDir, runId, dbUrl, sql, waitUntil, evidence, step, runCmd }) {
  const query = async (text, values = []) => (await sql(text, values, dbUrl)).rows;
  const api = async (method, url, body) => page.evaluate(async ({ method, url, body, key }) => {
    const response = await fetch(`/api/v1${url}`, { method, headers: { "content-type": "application/json", "Idempotency-Key": key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }, { method, url, body, key: `studio-live:${randomUUID()}` });
  const checkpoint = () => writeFile(path.join(outDir, "scenario-progress.json"), JSON.stringify(evidence, null, 2));
  evidence.scenarios = [];

  step("Register through the real Studio authentication UI");
  await page.goto(`${webOrigin}/register`);
  await waitUntil(async () => await page.locator("#username").count() === 1, "Hydrated registration form", 30000);
  await page.locator("#username").fill(`studio_${runId}`);
  await page.locator("#email").fill(`studio_${runId}@example.test`);
  await page.locator("#password").fill(randomBytes(24).toString("base64url") + "!1aA");
  await page.getByRole("button", { name: "创建工作台", exact: true }).click();
  await page.waitForURL(`${webOrigin}/`, { timeout: 60000 });

  async function createProject(label) {
    await page.goto(`${webOrigin}/`);
    await page.getByRole("textbox", { name: "新项目名称" }).fill(`真实Flash验收 ${label} ${runId}`);
    await page.getByRole("button", { name: "创建项目 →", exact: true }).click();
    await page.waitForURL(/\/studio\//);
    const id = new URL(page.url()).pathname.split("/").at(-1);
    await waitUntil(async () => (await page.getByRole("combobox", { name: "模型", exact: true }).inputValue()) === "deepseek-flash", "Flash selector ready");
    return id;
  }

  async function discussAndGenerate(projectId, output, prompt, label) {
    step(`${label}: discuss, review, confirm once, and observe real generation`);
    const result = { label, projectId, output, status: "running", intermediate: [] };
    evidence.scenarios.push(result);
    const beforeRuns = Number((await query("SELECT count(*) AS n FROM workbench.runs WHERE project_id=$1", [projectId]))[0].n);
    await page.getByRole("combobox", { name: "输出类型", exact: true }).selectOption(output);
    await page.getByRole("textbox", { name: "描述需求或修改" }).fill(prompt);
    const messageReply = page.waitForResponse(r => r.request().method() === "POST" && /\/requirement-sessions\/[^/]+\/messages$/.test(new URL(r.url()).pathname));
    await page.getByRole("button", { name: "发送需求", exact: true }).click();
    const sent = await messageReply;
    assert.ok(sent.ok(), `Discussion HTTP ${sent.status()}`);
    const session = await sent.json();
    result.sessionId = session.id;
    assert.equal(sent.request().postDataJSON().generationRequest.modelId, "deepseek-flash");
    await waitUntil(async () => {
      const [state] = await query("SELECT s.state, t.status AS turn_status, t.failure_code FROM workbench.requirement_sessions s LEFT JOIN workbench.requirement_turns t ON t.id=s.current_turn_id WHERE s.id=$1", [session.id]);
      if (state?.turn_status === "failed") throw Object.assign(new Error(`Requirement turn failed: ${state.failure_code}`), { fatal: true });
      if (state?.turn_status === "succeeded" && state.state !== "ready_to_confirm") {
        result.discussionText = await page.locator(".studio-requirement").innerText().catch(() => "");
        throw Object.assign(new Error(`Sufficient request was not ready: ${state.state}`), { fatal: true });
      }
      return state?.state === "ready_to_confirm";
    }, "ready confirmation from real Flash", 180000, 1000);
    assert.equal(Number((await query("SELECT count(*) AS n FROM workbench.runs WHERE project_id=$1", [projectId]))[0].n), beforeRuns, "Ordinary discussion must not start a Run");
    result.ordinarySendCreatedNoRun = true;
    await page.getByRole("region", { name: "本次改动确认", exact: true }).waitFor();
    result.confirmationCard = await page.getByRole("region", { name: "本次改动确认", exact: true }).innerText();
    assert.equal(await page.getByRole("checkbox", { name: "我同意将以上平台级改造纳入本次范围" }).count(), 0, "Increment must not unexpectedly add platform changes");
    const reply = page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === `/api/v1/requirement-sessions/${session.id}/confirm`);
    await page.getByRole("button", { name: "确认需求并生成", exact: true }).click();
    const accepted = await reply;
    assert.ok(accepted.ok(), `Confirmation HTTP ${accepted.status()}`);
    const receipt = (await accepted.json()).confirmation;
    assert.ok(receipt?.id);
    result.confirmationId = receipt.id;
    const frozen = await waitUntil(async () => {
      const [row] = await query("SELECT * FROM workbench.requirement_confirmations WHERE id=$1", [receipt.id]);
      if (row?.last_failure_code) throw Object.assign(new Error(`Confirmation dispatch: ${row.last_failure_code}`), { fatal: true });
      return row?.status === "started" && row.run_id ? row : false;
    }, "confirmed Run dispatch", 120000, 1000);
    result.runId = frozen.run_id; result.planId = frozen.plan_id;
    result.baselineChecksum = digest(JSON.stringify(frozen.baseline));
    assert.ok(frozen.input_snapshot.knowledgeReleaseId, "Confirmation pins a published knowledge release");
    assert.ok(frozen.baseline.evidence?.length, "Confirmation includes real authorized knowledge evidence");
    const seen = new Set();
    await waitUntil(async () => {
      const [run] = await query("SELECT status, request, knowledge_release_id FROM workbench.runs WHERE id=$1", [frozen.run_id]);
      if (["failed", "cancelled", "waiting_input"].includes(run?.status)) throw Object.assign(new Error(`Generation reached ${run.status}`), { fatal: true });
      if (run?.status !== "succeeded" && output !== "prd") {
        const nodes = await page.locator(".visual-draft [data-draft-node]").evaluateAll(elements => elements.map(el => ({ id: el.dataset.draftNode, text: el.childNodes[0]?.textContent, style: el.getAttribute("style") })));
        const signature = digest(JSON.stringify(nodes));
        if (nodes.length && !seen.has(signature)) {
          seen.add(signature); result.intermediate.push({ at: new Date().toISOString(), signature, nodeCount: nodes.length });
          if (result.intermediate.length <= 3) await page.screenshot({ path: path.join(outDir, `${label}-intermediate-${result.intermediate.length}.png`) });
        }
      }
      return run?.status === "succeeded" ? run : false;
    }, `${label} real generation`, 1200000, 500);
    const outputs = await query("SELECT a.kind, v.id, v.artifact_id, v.status, v.knowledge_release_id, v.citations FROM workbench.artifact_versions v JOIN workbench.artifacts a ON a.id=v.artifact_id WHERE v.created_by_run_id=$1", [frozen.run_id]);
    const ready = outputs.filter(item => item.status === "ready");
    for (const kind of output === "both" ? ["prd", "prototype"] : [output]) assert.ok(ready.some(item => item.kind === kind), `${label} ready ${kind} output`);
    const confirmations = await query("SELECT id FROM workbench.requirement_confirmations WHERE session_id=$1", [session.id]);
    assert.equal(confirmations.length, 1, "Exactly one confirmation for this scenario");
    const [after] = await query("SELECT baseline FROM workbench.requirement_confirmations WHERE id=$1", [receipt.id]);
    assert.equal(digest(JSON.stringify(after.baseline)), result.baselineChecksum);
    result.outputs = outputs;
    for (const item of ready) {
      assert.equal(item.knowledge_release_id, frozen.input_snapshot.knowledgeReleaseId);
      assert.ok(item.citations.length, "Every delivered output retains knowledge citations");
    }
    const retrievals = await query("SELECT i.id,i.status,i.response FROM workbench.knowledge_retrieval_invocations i JOIN workbench.runtime_attempts a ON a.id=i.runtime_attempt_id WHERE a.run_id=$1", [frozen.run_id]);
    assert.ok(retrievals.some(row => row.status === "succeeded" && row.response?.items?.length), "Actual generation must retrieve authorized knowledge");
    result.retrievals = retrievals.map(row => ({ id: row.id, status: row.status, citationIds: row.response?.items?.map(item => item.citation.id) ?? [] }));
    if (output !== "prd") {
      assert.ok(result.intermediate.length >= 2, "At least two distinct visible intermediate projections before completion");
      await waitUntil(async () => (await page.frameLocator(".visual-paper iframe").locator("[data-wb-screen]").count()) > 0, "Final generated iframe", 60000);
      await verifyActivityInteraction(page.frameLocator(".visual-paper iframe"));
      result.finalInteraction = true;
    }
    await page.screenshot({ path: path.join(outDir, `${label}-completed.png`) });
    result.status = "passed"; await checkpoint();
    return result;
  }

  const prototypeProject = await createProject("原型");
  const prototype = await discussAndGenerate(prototypeProject, "prototype", increment + "只输出交互原型。" + interactionSpec, "prototype");
  step("Save real anchored feedback and generate a derived revision through discussion");
  const [sourceRevision] = await query("SELECT id FROM workbench.prototype_revisions WHERE plan_id=$1 ORDER BY created_at DESC LIMIT 1", [prototype.planId]);
  await page.getByRole("button", { name: "选择元素", exact: true }).click();
  await page.frameLocator(".visual-paper iframe").locator("[data-wb-node]").first().click();
  await page.getByRole("textbox", { name: "当前版本批注", exact: true }).fill("渠道筛选区域增加说明文字：仅显示当前授权区域内的活动。保持原有筛选、搜索与详情交互。");
  await page.getByRole("button", { name: "保存批注", exact: true }).click();
  await page.getByRole("checkbox", { name: "用于本次修改", exact: true }).first().check();
  await page.getByRole("button", { name: "讨论所选 1 条批注", exact: true }).click();
  const revision = await discussAndGenerate(prototypeProject, "prototype", "按照所选批注，仅在渠道筛选区域增加说明文字：仅显示当前授权区域内的活动。保持已有页面、功能和样式，不更改权限逻辑，不新增平台能力。" + interactionSpec, "revision");
  const [child] = await query("SELECT source_revision_id FROM workbench.prototype_plans WHERE id=$1", [revision.planId]);
  assert.equal(child.source_revision_id, sourceRevision.id);
  evidence.checks.fixedSourceFeedbackRevision = true;

  await page.locator(".studio-top-actions").getByRole("button", { name: "版本", exact: true }).click();
  await page.getByRole("button", { name: "确认版本", exact: true }).click();
  await page.getByText(/已确认/).first().waitFor();
  await page.locator(".studio-top-actions").getByRole("button", { name: "分享 / 导出", exact: true }).click();
  await verifyPrototypeDelivery(prototypeProject, revision);

  const prdProject = await createProject("文档");
  await discussAndGenerate(prdProject, "prd", increment + "只输出需求文档，包括字段、状态、筛选逻辑、权限边界、异常处理和验收条件。", "prd");
  await verifyDocumentDelivery(prdProject, "prd");
  const jointProject = await createProject("联合");
  await discussAndGenerate(jointProject, "both", increment + "同时输出需求文档和交互原型，范围与术语一致。" + interactionSpec, "joint");
  await verifyDocumentDelivery(jointProject, "joint");
  const ids = [prototypeProject, prdProject, jointProject];
  const runs = await query("SELECT id,status,request->>'modelId' AS model_id FROM workbench.runs WHERE project_id=ANY($1::text[])", [ids]);
  const turns = await query("SELECT id,status,model_id FROM workbench.requirement_turns WHERE project_id=ANY($1::text[])", [ids]);
  assert.ok(runs.length >= 4 && turns.length >= 4);
  assert.ok([...runs, ...turns].every(item => item.model_id === "deepseek-flash"));
  evidence.runs = runs; evidence.turns = turns; evidence.checks.allDatabaseRunsAndTurnsUsedFlash = true;

  async function verifyPrototypeDelivery(projectId, scenario) {
    step("Verify anonymous share, revoke, natural expiry, downloaded HTML and installed React execution");
    await page.getByRole("button", { name: "创建分享", exact: true }).click();
    const link = page.getByRole("link", { name: "打开分享链接", exact: true }).first();
    await link.waitFor();
    const href = new URL(await link.getAttribute("href"), webOrigin).href;
    const anon = await browser.newContext(); const publicPage = await anon.newPage();
    try {
      await publicPage.goto(href); await publicPage.locator("iframe").waitFor();
      await page.getByRole("button", { name: "撤销", exact: true }).first().click();
      await page.getByText("已撤销").first().waitFor();
      await publicPage.reload(); await publicPage.getByText(/此分享已撤销|分享已失效/).first().waitFor();
      const [current] = await query("SELECT id FROM workbench.prototype_revisions WHERE plan_id=$1 ORDER BY created_at DESC LIMIT 1", [scenario.planId]);
      // Exercise real server expiry without changing its clock or stored rows.
      const expiring = await api("POST", `/projects/${projectId}/prototype-v2/shares`, { revisionId: current.id, expiresAt: new Date(Date.now() + 5000).toISOString() });
      assert.ok([200, 201].includes(expiring.status));
      await waitUntil(() => Date.now() > Date.parse(expiring.body.expiresAt), "Share expiry elapsed", 10000, 500);
      await publicPage.goto(new URL(expiring.body.url, webOrigin).href);
      await publicPage.getByText(/到期|过期|分享已失效/).first().waitFor();
    } finally { await anon.close(); }
    evidence.checks.publicShareRevocationAndNaturalExpiry = true;
    const downloads = {};
    for (const format of ["html", "react"]) {
      const reply = page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname.endsWith("/prototype-v2/exports"));
      await page.getByRole("button", { name: `导出 ${format === "html" ? "HTML" : "React"}`, exact: true }).click();
      const created = await (await reply).json();
      const row = await waitUntil(async () => {
        const [job] = await query("SELECT status,artifact_sha256,byte_size FROM workbench.prototype_exports WHERE id=$1", [created.id]);
        if (job?.status === "failed") throw Object.assign(new Error(`${format} export failed`), { fatal: true });
        return job?.status === "succeeded" ? job : false;
      }, `${format} export succeeded`, 180000, 1000);
      const rowElement = page.locator(`[data-studio-export-id="${created.id}"]`);
      const button = rowElement.getByRole("button", { name: "下载", exact: true });
      const downloaded = page.waitForEvent("download"); await button.click();
      const file = path.join(outDir, format === "html" ? "prototype.html" : "prototype-react.zip");
      await (await downloaded).saveAs(file); const bytes = await readFile(file);
      assert.equal(bytes.length, Number(row.byte_size)); assert.equal(digest(bytes), row.artifact_sha256);
      downloads[format] = { path: file, byteSize: bytes.length, sha256: digest(bytes) };
    }
    evidence.downloads = downloads;
    const directory = await mkdtemp(path.join(tmpdir(), "studio-export-run-"));
    try {
      const entries = unzipSync(await readFile(downloads.react.path));
      assert.ok(entries["package.json"] && entries["src/main.jsx"]);
      for (const [name, bytes] of Object.entries(entries)) {
        const destination = path.resolve(directory, name);
        assert.ok(destination.startsWith(directory + path.sep), "ZIP path must remain inside extraction root");
        await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, bytes);
      }
      const npmCli = process.env.WORKBENCH_STUDIO_LIVE_NPM_CLI;
      assert.ok(npmCli, "Provide the existing npm CLI for export installation");
      const environment = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, NPM_CONFIG_USERCONFIG: "/dev/null", NPM_CONFIG_CACHE: path.join(directory, ".npm-cache") };
      await runCmd("react-install", [npmCli, "install", "--ignore-scripts", "--no-audit", "--no-fund"], directory, environment);
      await runCmd("react-build", [npmCli, "run", "build", "--", "--base=./"], directory, environment);
      await withStaticServer(directory, async origin => {
        const standalone = await browser.newPage();
        try { await standalone.goto(`${origin}/dist/index.html`); await verifyActivityInteraction(standalone); }
        finally { await standalone.close(); }
      });
      await withStaticServer(outDir, async origin => {
        const standalone = await browser.newPage();
        try { await standalone.goto(`${origin}/prototype.html`); await verifyActivityInteraction(standalone); }
        finally { await standalone.close(); }
      });
      evidence.checks.realHtmlAndInstalledReactInteraction = true;
    } finally { await rm(directory, { recursive: true, force: true }); }
    await checkpoint();
  }

  async function verifyDocumentDelivery(projectId, label) {
    step(`${label}: publish exact PRD version and download actual DOCX/PDF`);
    await page.goto(`${webOrigin}/studio/${projectId}?view=publishing`);
    await page.getByRole("button", { name: "创建项目发布", exact: true }).click();
    const files = [];
    for (const format of ["docx", "pdf"]) {
      const reply = page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === `/api/v1/projects/${projectId}/exports`);
      await page.getByRole("button", { name: `导出 ${format.toUpperCase()}`, exact: true }).first().click();
      const job = await (await reply).json();
      const row = await waitUntil(async () => {
        const [record] = await query("SELECT e.status,e.failure_code,b.sha256,b.byte_size FROM workbench.export_jobs e LEFT JOIN workbench.blobs b ON b.id=e.output_blob_id WHERE e.id=$1", [job.id]);
        if (record?.status === "failed") throw Object.assign(new Error(`${format} failed: ${record.failure_code}`), { fatal: true });
        return record?.status === "succeeded" ? record : false;
      }, `${label} ${format} export`, 180000, 1000);
      const downloaded = page.waitForEvent("download");
      await page.getByRole("article", { name: `导出 ${job.id}`, exact: true }).getByRole("button", { name: "下载并校验", exact: true }).click();
      const target = path.join(outDir, `${label}.${format}`); await (await downloaded).saveAs(target);
      const bytes = await readFile(target); assert.equal(bytes.length, Number(row.byte_size)); assert.equal(digest(bytes), row.sha256);
      if (format === "docx") {
        const document = unzipSync(bytes)["word/document.xml"]; assert.ok(document); assert.match(Buffer.from(document).toString("utf8"), /渠道|活动/);
      } else assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
      files.push({ format, path: target, sha256: digest(bytes), byteSize: bytes.length });
    }
    evidence[`${label}DocumentDownloads`] = files;
    await checkpoint();
  }
}

async function verifyActivityInteraction(frame) {
  const channel = frame.getByRole("combobox", { name: "渠道类型", exact: true });
  await channel.waitFor(); await channel.selectOption({ label: "企微" });
  assert.equal(await channel.locator("option:checked").innerText(), "企微");
  const search = frame.getByPlaceholder("搜索活动", { exact: true });
  await search.fill("不存在的验收活动");
  await frame.getByText("无匹配活动", { exact: true }).waitFor();
  await search.fill(""); await channel.selectOption({ label: "全部" });
  await frame.getByRole("button", { name: "查看详情", exact: true }).first().click();
  await frame.getByRole("button", { name: "返回列表", exact: true }).click();
  await channel.waitFor();
}

async function withStaticServer(directory, action) {
  const server = http.createServer(async (req, res) => {
    try {
      const target = path.resolve(directory, "." + decodeURIComponent(new URL(req.url, "http://localhost").pathname));
      assert.ok(target.startsWith(directory + path.sep));
      const bytes = await readFile(target);
      const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" }[path.extname(target)] || "application/octet-stream";
      res.writeHead(200, { "content-type": mime }); res.end(bytes);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try { await action(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
