import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "@workbench/workbench-contracts";
import { publishPrd, auditPrd } from "./studio-live-prd-artifacts.mjs";

const prompt =
  "在云溪营销极速发布平台已有的 Web 端活动管理列表，为策划人员增加渠道类型筛选。复用已有列表查询和区域权限，只扩展查询参数；全部、企微、短信三个选项，默认全部。切换筛选时保留其他查询条件并回到第一页；无匹配活动时显示空状态；查询失败保留当前筛选，允许原地重试。沿用当前设计规范和登录、导航、审核发布、报表，不新增角色、页面、外部系统或审批流程。只输出本次增量的需求文档，写明字段、权限、状态和逐条可运行的验收标准。";
const hash = (value) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
const fatal = (message) => Object.assign(new Error(message), { fatal: true });

export async function runStudioPrd({
  page,
  webOrigin,
  outDir,
  runId,
  dbUrl,
  sql,
  waitUntil,
  evidence,
  step,
}) {
  const query = async (stmt, values = []) =>
    (await sql(stmt, values, dbUrl)).rows;
  const prd = (evidence.prd = {
    startedAt: new Date().toISOString(),
    prompt,
    events: [],
  });
  const save = (name, value) =>
    writeFile(path.join(outDir, name), JSON.stringify(value, null, 2));
  const checkpoint = () => save("prd-progress.json", prd);
  const post = (route) =>
    page.waitForResponse(
      (res) =>
        res.request().method() === "POST" &&
        route.test(new URL(res.url()).pathname),
      { timeout: 120000 },
    );
  let confirmationsPosted = 0;
  const observedExternal = new Set();
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (
      req.method() === "POST" &&
      /\/requirement-sessions\/[^/]+\/confirm$/.test(url.pathname)
    )
      confirmationsPosted++;
    if (
      /^https?:$/.test(url.protocol) &&
      !["127.0.0.1", "localhost"].includes(url.hostname)
    )
      observedExternal.add(url.origin);
  });
  step("Register a distinct Studio account and start a PRD-only discussion");
  await page.goto(webOrigin + "/register");
  await waitUntil(
    async () => (await page.locator("#username").count()) === 1,
    "Registration form hydrated",
    30000,
  );
  await page.locator("#username").fill("prd_" + runId);
  await page.locator("#email").fill("prd_" + runId + "@example.test");
  await page
    .locator("#password")
    .fill(randomBytes(24).toString("hex") + "!1aA");
  await page.getByRole("button", { name: "创建工作台", exact: true }).click();
  await page.waitForURL(webOrigin + "/");
  await page
    .getByRole("textbox", { name: "新项目名称" })
    .fill("真实 PRD 渠道筛选 " + runId);
  await page.getByRole("button", { name: "创建项目 →", exact: true }).click();
  await page.waitForURL(/\/studio\//);
  const project = (prd.projectId = new URL(page.url()).pathname
    .split("/")
    .at(-1));
  await waitUntil(
    async () =>
      (await page
        .getByRole("combobox", { name: "模型", exact: true })
        .inputValue()) === "deepseek-flash",
    "Flash selected",
  );
  await page
    .getByRole("combobox", { name: "输出类型", exact: true })
    .selectOption("prd");
  await page.getByRole("textbox", { name: "描述需求或修改" }).fill(prompt);
  const sent = post(/\/requirement-sessions\/[^/]+\/messages$/);
  await page.getByRole("button", { name: "发送需求", exact: true }).click();
  const msg = await sent;
  assert.ok(msg.ok(), "Request discussion HTTP " + msg.status());
  assert.equal(
    msg.request().postDataJSON().generationRequest.modelId,
    "deepseek-flash",
  );
  const session = (prd.sessionId = (await msg.json()).id);
  await checkpoint();
  await waitUntil(
    async () => {
      const [s] = await query(
        "SELECT s.state,t.status,t.failure_code FROM workbench.requirement_sessions s JOIN workbench.requirement_turns t ON t.id=s.current_turn_id WHERE s.id=$1",
        [session],
      );
      if (s?.status === "failed")
        throw fatal("Requirement discussion failed: " + s.failure_code);
      if (s?.status === "succeeded" && s.state !== "ready_to_confirm")
        throw fatal("Discussion needs clarification: " + s.state);
      return s?.state === "ready_to_confirm";
    },
    "Confirmed business summary available",
    240000,
  );
  const pending = await query(
    "SELECT id FROM workbench.runs WHERE project_id=$1",
    [project],
  );
  assert.equal(pending.length, 0);
  const card = page.getByRole("article", { name: "本次改动确认", exact: true });
  await card.waitFor();
  await card.getByText("影响页面、流程及保持的范围", { exact: true }).click();
  prd.confirmationText = await card.innerText();
  await page.screenshot({ path: path.join(outDir, "prd-confirmation.png") });
  await checkpoint();
  assert.equal(
    await card
      .getByRole("checkbox", { name: "我同意将以上平台级改造纳入本次范围" })
      .count(),
    0,
  );
  step(
    "Confirm the frozen knowledge-backed PRD baseline and follow its originating Run",
  );
  const accepted = post(/\/requirement-sessions\/[^/]+\/confirm$/);
  await card
    .getByRole("button", { name: "确认需求并生成", exact: true })
    .click();
  const response = await accepted;
  assert.ok(response.ok(), "Confirmation HTTP " + response.status());
  const receipt = (prd.confirmationId = (
    await response.json()
  ).confirmation.id);
  const frozen = await waitUntil(
    async () => {
      const [r] = await query(
        "SELECT * FROM workbench.requirement_confirmations WHERE id=$1",
        [receipt],
      );
      if (r?.last_failure_code)
        throw fatal("Dispatch failed: " + r.last_failure_code);
      return r?.status === "started" && r.run_id ? r : false;
    },
    "PRD Run dispatch",
    120000,
  );
  const run = (prd.runId = frozen.run_id);
  prd.frozenRelease = frozen.input_snapshot.knowledgeReleaseId;
  prd.baselineSha256 = hash(frozen.baseline);
  assert.deepEqual(frozen.generation_request.requestedArtifactKinds, ["prd"]);
  assert.deepEqual(
    frozen.generation_request.outputOperations.map((v) => [
      v.kind,
      v.operation.kind,
    ]),
    [["prd", "create"]],
  );
  assert.deepEqual(frozen.baseline.card.outputKinds, ["prd"]);
  assert.equal(frozen.plan_id, null);
  assert.ok(frozen.baseline.evidence.length && prd.frozenRelease);
  await save("prd-confirmed-baseline.json", {
    card: frozen.baseline.card,
    evidence: frozen.baseline.evidence,
    releaseId: prd.frozenRelease,
    summaryChecksum: frozen.baseline.summaryChecksum,
    baselineSha256: prd.baselineSha256,
  });
  await checkpoint();
  let lastSequence = 0;
  prd.visiblePhases = [];
  const finished = await waitUntil(
    async () => {
      const [r] = await query(
        "SELECT status,request,knowledge_release_id,error_code FROM workbench.runs WHERE id=$1",
        [run],
      );
      const rows = await query(
        "SELECT sequence,type,occurred_at,CASE WHEN type='run.phase.changed' THEN payload->>'label' END AS label FROM workbench.run_events WHERE run_id=$1 AND sequence>$2 ORDER BY sequence",
        [run, lastSequence],
      );
      if (rows.length) {
        lastSequence = rows.at(-1).sequence;
        prd.events.push(...rows);
        await checkpoint();
      }
      if (r?.status === "running") {
        const heading = page.locator(".studio-direct-run summary").first();
        if (await heading.isVisible()) {
          const label = (await heading.innerText()).trim();
          const source = prd.events.findLast((event) => event.label === label);
          if (
            source &&
            !prd.visiblePhases.some((item) => item.sequence === source.sequence)
          ) {
            prd.visiblePhases.push({
              label,
              sequence: source.sequence,
              observedAt: new Date().toISOString(),
            });
            await page.screenshot({
              path: path.join(outDir, "prd-phase-" + source.sequence + ".png"),
            });
            await checkpoint();
          }
        }
      }
      if (["failed", "cancelled", "waiting_input"].includes(r?.status))
        throw fatal(
          "PRD generation ended " + r.status + " " + (r.error_code ?? ""),
        );
      return r?.status === "succeeded" && r;
    },
    "Real Flash PRD generation",
    1800000,
    1250,
  );
  prd.generatedAt = new Date().toISOString();
  assert.equal(finished.knowledge_release_id, prd.frozenRelease);
  assert.equal(finished.request.modelId, "deepseek-flash");
  const [latest] = await query(
    "SELECT baseline FROM workbench.requirement_confirmations WHERE id=$1",
    [receipt],
  );
  assert.equal(hash(latest.baseline), prd.baselineSha256);
  const outputs = await query(
    "SELECT a.kind,v.id,v.artifact_id,v.status,v.knowledge_release_id,v.content,v.citations,v.checksum FROM workbench.artifact_versions v JOIN workbench.artifacts a ON a.id=v.artifact_id WHERE v.created_by_run_id=$1 AND v.status='ready'",
    [run],
  );
  assert.deepEqual(
    outputs.map((v) => v.kind),
    ["prd"],
  );
  const [artifact] = outputs;
  const turns = await query(
    "SELECT model_id,status FROM workbench.requirement_turns WHERE session_id=$1",
    [session],
  );
  assert.ok(
    turns.length &&
      turns.every(
        (t) => t.model_id === "deepseek-flash" && t.status === "succeeded",
      ),
  );
  assert.equal(confirmationsPosted, 1);
  assert.equal(
    (
      await query(
        "SELECT id FROM workbench.requirement_confirmations WHERE session_id=$1",
        [session],
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await query("SELECT id FROM workbench.runs WHERE project_id=$1", [
        project,
      ])
    ).length,
    1,
  );
  await save("prd-generated-content.json", artifact.content);
  prd.output = {
    id: artifact.id,
    artifactId: artifact.artifact_id,
    checksum: artifact.checksum,
    knowledgeReleaseId: artifact.knowledge_release_id,
  };
  prd.turns = turns;
  prd.confirmationsPosted = confirmationsPosted;
  await checkpoint();
  await publishPrd({
    page,
    webOrigin,
    outDir,
    project,
    artifact,
    post,
    query,
    waitUntil,
    prd,
    step,
    checkpoint,
  });
  prd.semanticAudit = await auditPrd({
    query,
    artifact,
    frozen,
    downloads: prd.downloads,
  });
  prd.externalBrowserOrigins = [...observedExternal];
  assert.deepEqual(prd.externalBrowserOrigins, []);
  prd.completedAt = new Date().toISOString();
  await checkpoint();
}
