import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import YAML from "yaml";

const root = new URL("../", import.meta.url);
const alertsPath = "deploy/observability/workbench-runtime-alerts.yaml";
const runbookPath = "README.md";

test("Runtime alerts are well-formed and every runbook link resolves", async () => {
  const [alertSource, runbook] = await Promise.all([
    readFile(new URL(alertsPath, root), "utf8"),
    readFile(new URL(runbookPath, root), "utf8"),
  ]);
  const document = YAML.parse(alertSource);
  assert.match(runbook, /Provider State/u);
  assert.equal(document?.kind, "PrometheusRule");
  const rules = document?.spec?.groups?.flatMap((group) => group.rules ?? []) ?? [];
  assert(rules.length >= 9, "Runtime observability must keep the complete alert inventory");

  const alerts = new Set();
  for (const rule of rules) {
    assert.match(rule.alert ?? "", /^Workbench[A-Z][A-Za-z0-9]+$/u);
    assert(!alerts.has(rule.alert), `duplicate Runtime alert: ${rule.alert}`);
    alerts.add(rule.alert);
    assert.equal(typeof rule.expr, "string");
    assert(rule.expr.trim().length > 0, `${rule.alert} must define a PromQL expression`);
    assert.equal(typeof rule.labels?.owner, "string");
    assert.match(rule.labels?.severity ?? "", /^(?:warning|critical)$/u);
    assert.equal(typeof rule.annotations?.summary, "string");
    const runbookUrl = rule.annotations?.runbook_url ?? "";
    assert.match(runbookUrl, /^README\.md#[a-z0-9-]+$/u);
    const anchor = runbookUrl.slice(runbookUrl.indexOf("#") + 1);
    assert(markdownAnchors(runbook).has(anchor), `${rule.alert} links to missing runbook anchor #${anchor}`);
  }
});

test("alert series and labels are emitted by reachable production boundaries", async () => {
  const [
    alertSource,
    telemetry,
    attempts,
    backfill,
    liveness,
    processor,
    worker,
    cancellationReconciler,
    executionReconciler,
    knowledge,
  ] = await Promise.all([
    readFile(new URL(alertsPath, root), "utf8"),
    readFile(new URL("packages/workbench-telemetry/src/index.ts", root), "utf8"),
    readFile(new URL("apps/workbench-worker/src/runtime/runtime-attempt.service.ts", root), "utf8"),
    readFile(new URL("apps/workbench-worker/src/runtime/runtime-provider-state-backfill.ts", root), "utf8"),
    readFile(new URL("apps/workbench-worker/src/runtime/runtime-liveness.ts", root), "utf8"),
    readFile(new URL("apps/workbench-worker/src/runs/run-processor.ts", root), "utf8"),
    readFile(new URL("apps/workbench-worker/src/main.ts", root), "utf8"),
    readFile(new URL("apps/workbench-worker/src/runs/runtime-cancellation-reconciler.ts", root), "utf8"),
    readFile(new URL("apps/workbench-worker/src/runs/runtime-execution-reconciler.ts", root), "utf8"),
    readFile(new URL("apps/workbench-api/src/modules/knowledge/knowledge-tool.service.ts", root), "utf8"),
  ]);
  const alertDocument = YAML.parse(alertSource);
  const alertExpressions = new Map(
    alertDocument.spec.groups
      .flatMap((group) => group.rules ?? [])
      .map((rule) => [rule.alert, rule.expr]),
  );

  for (const metric of [
    "workbench.runtime.provider_state.failures",
    "workbench.runtime.provider_state.projection_lag",
    "workbench.runtime.transaction.p2028",
    "workbench.runtime.liveness.events",
    "workbench.runtime.liveness.duration",
    "workbench.knowledge.visibility.events",
  ]) {
    assert(telemetry.includes(`\"${metric}\"`), `telemetry does not declare ${metric}`);
    assert(alertSource.includes(metric.replaceAll(".", "_")), `alerts do not consume ${metric}`);
  }

  assert(attempts.includes("/^P\\d{4}$/u"), "Prisma P2028 codes must reach provider-state metrics");
  assert.match(attempts, /recordRuntimeProviderStateMetric\([\s\S]{0,300}operation:\s*"(?:read|update)"/u);
  assert.match(backfill, /recordRuntimeProviderStateMetric\([\s\S]{0,300}operation:\s*"backfill"/u);
  assert.match(liveness, /recordRuntimeLivenessMetric\([\s\S]{0,300}operation:\s*"wall-clock"/u);
  assert.match(liveness, /operation:\s*this\.phase === "submission" \? "provider-first-byte" : "stream-idle"/u);
  assert.match(processor, /recordRuntimeLivenessMetric\([\s\S]{0,300}operation:\s*"wall-clock"/u);
  assert.match(processor, /recordRuntimeLivenessMetric\([\s\S]{0,300}operation:\s*"cancel"/u);
  assert.match(worker, /recordRuntimeLivenessMetric\([\s\S]{0,300}operation:\s*"queue-age"/u);
  assert.match(worker, /recordRuntimeLivenessMetric\([\s\S]{0,300}operation:\s*"terminal-drift"/u);
  assert.match(cancellationReconciler, /recordRuntimeLivenessMetric\([\s\S]{0,300}operation:\s*"reconcile"/u);
  assert.match(executionReconciler, /recordRuntimeLivenessMetric\([\s\S]{0,300}operation:\s*"reconcile"/u);
  assert.match(knowledge, /recordKnowledgeVisibilityMetric\([\s\S]{0,240}operation:\s*"execution"[\s\S]{0,160}outcome:\s*"blocked"/u);
  assert.equal(
    alertExpressions.get("WorkbenchRuntimeProviderStateP2028"),
    "increase(workbench_runtime_transaction_p2028_total[5m]) > 0",
  );
  assert.equal(
    alertExpressions.get("WorkbenchRuntimeProjectionInvariant"),
    "increase(workbench_runtime_provider_state_failures_total{operation=~\"read|update|shadow-verify\",error_code=~\"RUNTIME_PROVIDER_STATE_.*\"}[5m]) > 0",
  );
  assert.equal(
    alertExpressions.get("WorkbenchRuntimeBackfillConflict"),
    "increase(workbench_runtime_provider_state_failures_total{operation=\"backfill\"}[5m]) > 0",
  );
  assert.equal(
    alertExpressions.get("WorkbenchRuntimeTerminalRunDrift"),
    "increase(workbench_runtime_liveness_events_total{operation=\"terminal-drift\",outcome=\"error\"}[5m]) > 0",
  );
  assert.equal(
    alertExpressions.get("WorkbenchRuntimeLeaseTakeoverBurst"),
    "increase(workbench_runtime_liveness_events_total{operation=\"lease-takeover\",outcome=\"recovered\"}[10m]) > 5",
  );
  assert.equal(
    alertExpressions.get("WorkbenchKnowledgeUnauthorizedExecution"),
    "increase(workbench_knowledge_visibility_events_total{operation=\"execution\",outcome=\"blocked\"}[5m]) > 0",
  );

  const wallClockExpression = alertExpressions.get("WorkbenchRuntimeWallClockNearLimit");
  assert.equal(typeof wallClockExpression, "string");
  assert(
    wallClockExpression.includes("workbench_runtime_liveness_duration_milliseconds_bucket"),
    "OTLP ms histograms use the standard Prometheus _milliseconds suffix",
  );
  assert(!wallClockExpression.includes("workbench_runtime_liveness_duration_bucket"));
  assert.match(
    telemetry,
    /livenessDuration:\s*meter\.createHistogram\("workbench\.runtime\.liveness\.duration",\s*\{[\s\S]{0,180}unit:\s*"ms"/u,
  );

  const metricAttributeBlock = telemetry.slice(
    telemetry.indexOf("function metricAttributes"),
    telemetry.indexOf("function finishHttpSpan"),
  );
  for (const forbidden of ["runId", "runtimeAttemptId", "principalId", "projectId", "externalEventId", "prompt"]) {
    assert(!metricAttributeBlock.includes(forbidden), `metric attributes must not include ${forbidden}`);
    assert(!alertSource.includes(forbidden), `alert labels must not include ${forbidden}`);
  }
});

function markdownAnchors(markdown) {
  return new Set(markdown.split("\n")
    .filter((line) => /^#{1,6}\s+/u.test(line))
    .map((line) => line.replace(/^#{1,6}\s+/u, "").trim().toLowerCase()
      .replace(/[^a-z0-9\s-]/gu, "")
      .replace(/\s+/gu, "-")
      .replace(/-+/gu, "-")));
}
