import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client, Connection } from "@temporalio/client";
import pg from "pg";

const prompt = "在云溪营销极速发布平台现有活动管理列表中，为策划人员增加渠道类型筛选。仅在当前用户已有数据权限内筛选，选项为全部、企微、短信，默认全部。筛选变化返回第一页，空结果显示无匹配活动，失败保留条件并可重试。沿用现有查询、分页、样式、登录和导航，不新增页面、系统或权限。请生成 Web 端列表原型，表格包含企微及短信各两条活动，切换使用可实际操作的原生下拉框。";
const sha = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fatal = message => Object.assign(new Error(message), { fatal: true });

export async function runStudioLiveStopScenarios({ page, webOrigin, outDir, runId, dbUrl, sql, waitUntil, evidence, step, temporalAddress, providerRunStatus }) {
  const selection = process.env.WORKBENCH_STUDIO_LIVE_STOP_CASE;
  assert.ok(selection === undefined || ["queued", "running"].includes(selection));
  const results = evidence.stopScenarios = [];
  const save = () => writeFile(path.join(outDir, "stop-progress.json"), JSON.stringify(results, null, 2));
  const query = async (text, values = []) => (await sql(text, values, dbUrl)).rows;
  const [database] = await query("SELECT current_database() AS name");
  assert.equal(database.name, `workbench_studio_live_test_${runId}`);
  const connection = await Connection.connect({ address: temporalAddress });
  const temporal = new Client({ connection });
  const workflow = planId => temporal.workflow.getHandle(`workbench-prototype-generation-v3-${planId}`);
  const actionResponse = suffix => page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname.endsWith(suffix));
  const workflowCommands = id => query("SELECT kind, attempts, delivered_at, last_error_code FROM workbench.prototype_workflow_commands WHERE target_id=$1 ORDER BY sequence", [id]);
  const attempts = id => query(`SELECT a.id,a.attempt,a.status,a.external_thread_id,a.external_run_id,a.external_event_sequence,
    a.provider_cancellation_operation_epoch,b.metadata->>'workbenchPrincipalId' AS owner_id
    FROM workbench.runtime_attempts a JOIN workbench.runtime_bindings b ON b.id=a.runtime_binding_id
    WHERE a.run_id=$1 ORDER BY a.attempt`, [id]);
  const readRun = async id => (await query(`SELECT id,thread_id,status,attempt,model_id,request,request_hash,knowledge_release_id,
    design_style_artifact_version_id,design_style_snapshot_sha256,retry_of_run_id,started_at,finished_at,
    cancel_requested_at,error_code FROM workbench.runs WHERE id=$1`, [id]))[0];
  const readPlan = async id => (await query("SELECT id,status,root_plan_id,retry_of_plan_id,runtime_run_id,source_revision_id,feedback_ids,generation_request FROM workbench.prototype_plans WHERE id=$1", [id]))[0];

  async function lock(queryText, values = []) {
    const lease = new pg.Client({ connectionString: dbUrl });
    await lease.connect();
    try {
      await lease.query("BEGIN");
      await lease.query("SET LOCAL lock_timeout = '3s'");
      await lease.query(queryText, values);
      return async () => {
        await lease.query("ROLLBACK").catch(() => undefined);
        await lease.end();
      };
    } catch (error) {
      await lease.end();
      throw error;
    }
  }

  async function fingerprint(id) {
    const [snapshot] = await query(`SELECT
      (SELECT jsonb_agg(jsonb_build_array(sequence,type,md5(payload::text)) ORDER BY sequence) FROM workbench.run_events WHERE run_id=$1) AS events,
      (SELECT jsonb_agg(jsonb_build_array(sequence,md5(payload::text)) ORDER BY sequence) FROM workbench.runtime_external_events WHERE run_id=$1) AS external_events,
      (SELECT jsonb_agg(jsonb_build_array(id,md5(content::text)) ORDER BY id) FROM workbench.thread_entries WHERE produced_by_run_id=$1) AS entries,
      (SELECT jsonb_build_array(version,md5(content::text)) FROM workbench.run_drafts WHERE run_id=$1) AS draft,
      (SELECT jsonb_agg(jsonb_build_array(id,status,checksum) ORDER BY id) FROM workbench.artifact_versions WHERE created_by_run_id=$1) AS artifacts,
      (SELECT count(*)::int FROM workbench.artifact_versions WHERE created_by_run_id=$1 AND status='ready') AS ready_artifacts`, [id]);
    return snapshot;
  }

  async function discuss(projectId, label) {
    await page.getByRole("combobox", { name: "输出类型", exact: true }).selectOption("prototype");
    const sent = actionResponse("/messages");
    await page.getByRole("textbox", { name: "描述需求或修改" }).fill(prompt);
    await page.getByRole("button", { name: "发送需求", exact: true }).click();
    const response = await sent;
    assert.ok(response.ok(), `Requirement discussion HTTP ${response.status()}`);
    assert.equal(response.request().postDataJSON().generationRequest.modelId, "deepseek-flash");
    const { id } = await response.json();
    await waitUntil(async () => {
      const [row] = await query(`SELECT s.state,t.status,t.failure_code,t.model_id FROM workbench.requirement_sessions s
        JOIN workbench.requirement_turns t ON t.id=s.current_turn_id WHERE s.id=$1 AND s.project_id=$2`, [id, projectId]);
      if (row?.status === "failed" || (row?.status === "succeeded" && row.state !== "ready_to_confirm")) {
        throw fatal(`Real Flash analysis did not reach confirmation: ${row.failure_code ?? row.state}`);
      }
      return row?.state === "ready_to_confirm" && row.model_id === "deepseek-flash";
    }, `${label} requirement ready`, 180000, 500);
    return id;
  }

  async function confirm(sessionId) {
    const reply = actionResponse(`/requirement-sessions/${sessionId}/confirm`);
    await page.getByRole("article", { name: "本次改动确认", exact: true }).getByRole("button", { name: "确认需求并生成", exact: true }).click();
    const accepted = await reply;
    assert.equal(accepted.status(), 202);
    const { confirmation } = await accepted.json();
    assert.ok(confirmation?.id);
    return waitUntil(async () => {
      const [row] = await query("SELECT id,status,run_id,plan_id,baseline,input_snapshot,last_failure_code FROM workbench.requirement_confirmations WHERE id=$1", [confirmation.id]);
      if (row?.last_failure_code) throw fatal(`Confirmation dispatch: ${row.last_failure_code}`);
      return row?.status === "started" && row.run_id && row.plan_id ? row : false;
    }, "confirmed Run dispatched", 90000, 100);
  }

  async function retry(original, originalPlan, result) {
    const reply = actionResponse(`/plans/${originalPlan.id}/retry`);
    await page.getByRole("button", { name: "重试生成", exact: true }).click();
    const accepted = await reply;
    assert.equal(accepted.status(), 202);
    const { id } = await accepted.json();
    assert.notEqual(id, originalPlan.id);
    const plan = await readPlan(id);
    const run = await readRun(plan.runtime_run_id);
    assert.notEqual(run.id, original.id);
    assert.equal(plan.retry_of_plan_id, originalPlan.id);
    assert.equal(plan.root_plan_id, originalPlan.root_plan_id ?? originalPlan.id);
    assert.equal(plan.source_revision_id, originalPlan.source_revision_id);
    assert.deepEqual(plan.feedback_ids, originalPlan.feedback_ids);
    assert.deepEqual(plan.generation_request, originalPlan.generation_request);
    for (const key of ["request", "request_hash", "model_id", "knowledge_release_id", "design_style_artifact_version_id", "design_style_snapshot_sha256", "thread_id"]) {
      assert.deepEqual(run[key], original[key], `Frozen ${key}`);
    }
    assert.equal(run.retry_of_run_id, original.id);
    const snapshots = runId => query("SELECT position, source_id, kind, checksum, descriptor, snapshot FROM workbench.run_source_snapshots WHERE run_id=$1 ORDER BY position", [runId]);
    assert.deepEqual(await snapshots(run.id), await snapshots(original.id));
    result.retry = { planId: id, runId: run.id, retryOfPlanId: plan.retry_of_plan_id, retryOfRunId: run.retry_of_run_id, frozenRequestSha256: sha(run.request), modelId: run.model_id, knowledgeReleaseId: run.knowledge_release_id };
    await save();
    await waitUntil(async () => {
      const [current, retryPlan] = await Promise.all([readRun(run.id), readPlan(id)]);
      if (["failed", "cancelled"].includes(current.status) || ["failed", "cancelled"].includes(retryPlan.status)) throw fatal(`Retry did not complete: ${current.error_code ?? retryPlan.status}`);
      return current.status === "succeeded" && retryPlan.status === "ready";
    }, "real retry delivered a new frozen revision", 1200000, 1000);
    assert.ok((await attempts(run.id)).some(attempt => attempt.status === "succeeded" && attempt.external_run_id));
    assert.equal((await fingerprint(run.id)).ready_artifacts, 1);
    await waitUntil(async () => (await workflow(id).describe()).status.name === "COMPLETED", "retry Temporal workflow completed", 10000, 100);
    assert.deepEqual(await readRun(original.id), original);
    const latestPlan = await readPlan(originalPlan.id);
    assert.deepEqual(latestPlan, originalPlan);
    result.retry.status = "succeeded";
  }

  async function stop(label) {
    const result = { label, status: "running" };
    results.push(result);
    step(`Validate real Studio ${label} cancellation and frozen retry`);
    await page.goto(`${webOrigin}/`);
    await page.getByRole("textbox", { name: "新项目名称" }).fill(`Flash停止验收 ${label} ${runId}`);
    await page.getByRole("button", { name: "创建项目 →", exact: true }).click();
    await page.waitForURL(/\/studio\//);
    const projectId = result.projectId = new URL(page.url()).pathname.split("/").at(-1);
    await waitUntil(async () => (await page.getByRole("combobox", { name: "模型", exact: true }).inputValue()) === "deepseek-flash", "Flash model selector");
    const sessionId = result.sessionId = await discuss(projectId, label);
    // For the queued case the real Prepare activity waits on a read-only test
    // transaction. The actual API dispatcher and Temporal gateway stay live.
    let releasePrepare, releaseRun;
    let original, originalPlan;
    try {
      if (label === "queued") {
        releasePrepare = await lock("LOCK TABLE workbench.prototype_revisions IN SHARE MODE");
      }
      const frozen = await confirm(sessionId);
      const id = result.runId = frozen.run_id;
      const planId = result.planId = frozen.plan_id;
      result.confirmationId = frozen.id;
      result.baselineSha256 = sha(frozen.baseline);
      result.inputSnapshotSha256 = sha(frozen.input_snapshot);
      const initial = await readRun(id);
      assert.equal(initial.model_id, "deepseek-flash");
      assert.equal(initial.request.requirementConfirmationId, frozen.id);
      assert.equal(initial.knowledge_release_id, frozen.input_snapshot.knowledgeReleaseId);
      const handle = workflow(planId);
      let external;
      if (releasePrepare) {
        releaseRun = await lock("SELECT id FROM workbench.runs WHERE id=$1 FOR UPDATE", [id]);
        assert.equal(initial.status, "queued");
        assert.equal(initial.attempt, 0);
        assert.deepEqual(await attempts(id), []);
      } else {
        external = await waitUntil(async () => {
          const state = await readRun(id);
          if (["failed", "succeeded", "cancelled"].includes(state.status)) throw fatal(`Run reached ${state.status} before running cancellation`);
          const [attempt] = await attempts(id);
          if (state.status !== "running" || !attempt?.external_run_id || !attempt.external_event_sequence) return false;
          const provider = await providerRunStatus(attempt);
          return provider === "running" ? { ...attempt, provider } : false;
        }, "real Flash provider running with streamed event", 150000, 200);
        result.providerBefore = { id: external.external_run_id, status: external.provider, externalEventSequence: external.external_event_sequence };
      }
      await page.getByRole("button", { name: "详情", exact: true }).click();
      await page.getByRole("button", { name: "停止生成", exact: true }).waitFor();
      const beforeClick = await readRun(id);
      assert.equal(beforeClick.status, label);
      result.beforeStop = { run: beforeClick.status, plan: (await readPlan(planId)).status, temporal: (await handle.describe()).status.name, attempt: beforeClick.attempt };
      assert.equal(result.beforeStop.temporal, "RUNNING");
      await save();

      const reply = actionResponse(`/plans/${planId}/cancel`);
      await page.getByRole("button", { name: "停止生成", exact: true }).click();
      if (releasePrepare) {
        await waitUntil(async () => (await handle.fetchHistory()).events.some(event => event.activityTaskCancelRequestedEventAttributes), "Temporal accepted cancellation of real Prepare activity", 4500, 75);
        await releasePrepare();
        releasePrepare = undefined;
      }
      const accepted = await reply;
      assert.equal(accepted.status(), 202);
      const body = await accepted.json();
      assert.ok(["approved", "generating"].includes(body.status));
      const toast = page.getByText("停止请求已提交，等待运行确认", { exact: true });
      await toast.waitFor();
      result.accepted = { http: accepted.status(), plan: body.status, run: (await readRun(id)).status, ui: await toast.innerText() };
      if (releaseRun) assert.equal(result.accepted.run, "queued", "Queue observed accepted acknowledgement before Run reaches terminal state");
      await page.screenshot({ path: path.join(outDir, `${label}-stop-accepted.png`) });
      await save();

      if (releaseRun) {
        await releaseRun();
        releaseRun = undefined;
      }
      await waitUntil(async () => {
        const [run, plan, description, commands] = await Promise.all([readRun(id), readPlan(planId), handle.describe(), workflowCommands(planId)]);
        if (["failed", "succeeded"].includes(run.status) || ["FAILED", "COMPLETED"].includes(description.status.name)) throw fatal(`Stop failed: Run ${run.status}, workflow ${description.status.name}`);
        if (run.status !== "cancelled" || plan.status !== "cancelled" || description.status.name !== "CANCELLED" || commands.some(command => !command.delivered_at)) return false;
        original = run;
        originalPlan = plan;
        result.terminal = { run: run.status, plan: plan.status, temporal: description.status.name, commands, cancelRequestedAt: run.cancel_requested_at, finishedAt: run.finished_at };
        return true;
      }, "confirmed cancellation and durable workflow delivery", 120000, 500);
      const history = await handle.fetchHistory();
      assert.ok(history.events.some(event => event.workflowExecutionCancelRequestedEventAttributes));
      assert.ok(history.events.some(event => event.workflowExecutionCanceledEventAttributes));
      assert.deepEqual(result.terminal.commands.map(command => command.kind), ["plan_start", "plan_cancel"]);
      const finalAttempts = await attempts(id);
      if (external) {
        const finalAttempt = finalAttempts.find(attempt => attempt.id === external.id);
        assert.equal(finalAttempt.status, "cancelled");
        assert.ok(finalAttempt.provider_cancellation_operation_epoch >= 1);
        const status = await providerRunStatus(external);
        assert.equal(status, "interrupted");
        result.providerAfter = { id: external.external_run_id, status, attempt: finalAttempt.status, cancellationEpoch: finalAttempt.provider_cancellation_operation_epoch };
      } else {
        assert.deepEqual(finalAttempts, [], "Queued cancellation must never submit a model Run");
        assert.equal(original.attempt, 0);
      }

      await page.getByRole("button", { name: "重试生成", exact: true }).waitFor();
      await page.getByRole("status").filter({ hasText: /^已取消$/ }).first().waitFor();
      await page.getByText("本次生成已停止", { exact: true }).waitFor();
      await page.screenshot({ path: path.join(outDir, `${label}-stop-terminal.png`) });
      const terminalFingerprint = await fingerprint(id);
      assert.equal(terminalFingerprint.ready_artifacts, 0);
      const revisions = await query("SELECT status,built_artifact_key IS NOT NULL AS has_built_artifact FROM workbench.prototype_revisions WHERE id=$1", [`revision_${planId}`]);
      assert.ok(revisions.every(revision => revision.status === "cancelled" && !revision.has_built_artifact));
      assert.deepEqual(terminalFingerprint.events.filter(event => /^run\.(cancelled|completed|failed)$/.test(event[1])).map(event => event[1]), ["run.cancelled"]);
      await delay(2000);
      assert.deepEqual(await fingerprint(id), terminalFingerprint);
      result.stoppedWritesSha256 = sha(terminalFingerprint);
      await save();
      try {
        await retry(original, originalPlan, result);
      } finally {
        assert.deepEqual(await fingerprint(id), terminalFingerprint, "Stopped Run produced a late write during the real retry");
        result.stableThroughRetry = true;
      }
      const [confirmed] = await query("SELECT run_id,plan_id,baseline,input_snapshot FROM workbench.requirement_confirmations WHERE session_id=$1", [sessionId]);
      assert.deepEqual([confirmed.run_id, confirmed.plan_id, sha(confirmed.baseline), sha(confirmed.input_snapshot)], [id, planId, result.baselineSha256, result.inputSnapshotSha256]);
      result.status = "passed";
      await save();
    } catch (error) {
      result.status = "failed";
      result.failure = error.message;
      throw error;
    } finally {
      await releasePrepare?.();
      await releaseRun?.();
      await save();
    }
  }

  try {
    await page.goto(`${webOrigin}/register`);
    await waitUntil(async () => await page.locator("#username").count() === 1, "Hydrated registration form", 30000);
    await page.locator("#username").fill(`flash_stop_${runId}`);
    await page.locator("#email").fill(`flash_stop_${runId}@example.test`);
    await page.locator("#password").fill(randomBytes(24).toString("base64url") + "!1aA");
    await page.getByRole("button", { name: "创建工作台", exact: true }).click();
    await page.waitForURL(`${webOrigin}/`, { timeout: 60000 });
    const failures = [];
    for (const label of selection ? [selection] : ["queued", "running"]) {
      try { await stop(label); }
      catch (error) { failures.push(error); }
    }
    if (failures.length) throw new Error(failures.map(error => error.message).join("\n"));
  } finally {
    await save();
    await connection.close();
  }
}
