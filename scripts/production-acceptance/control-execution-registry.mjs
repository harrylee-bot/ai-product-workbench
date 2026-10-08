const GENERAL_RUNBOOK = "README.md";
const RECOVERY_RUNBOOK = "README.md";

const general = Object.freeze({ kind: "runbook", path: GENERAL_RUNBOOK, section: "执行控制项" });
const recovery = Object.freeze({ kind: "runbook", path: RECOVERY_RUNBOOK, section: "执行演练" });
const command = (argv, evidenceKind) => Object.freeze({ kind: "command", argv: Object.freeze(argv), evidenceKind });

export const CONTROL_EXECUTION_REGISTRY = Object.freeze({
  "G5.DATABASE.LEAST_PRIVILEGE": command(["node", "scripts/assert-workbench-database-role-contract.mjs"], "database-role-report"),
  "G5.MIGRATION.FRESH": general,
  "G5.MIGRATION.UPGRADE": general,
  "G5.RECOVERY.BACKUP_RESTORE": recovery,
  "G5.RECOVERY.RPO": recovery,
  "G5.RECOVERY.RTO": recovery,
  "G6.AUTH.KEY_ROTATION_KMS": general,
  "G6.AUTH.PASSWORD_LOGIN": general,
  "G6.AUTH.PUBLIC_SIGNUP_CLOSED": general,
  "G6.AUTH.SESSION_JWT_LIFECYCLE": general,
  "G6.CANVAS.READY_OBJECT_AUTH_INTEGRITY": general,
  "G6.EDGE.WIREGUARD_ORIGIN_AUTH": command(["sh", "deploy/edge/workbench-edge-preflight.sh"], "edge-preflight-report"),
  "G6.SECURITY.TENANT_SSRF_AUDIT": general,
  "G6.STORAGE.IAM_SCAN_CHECKSUM": general,
  "G7.CANVAS.VIEW_SCREEN_IMAGE": general,
  "G7.DEERFLOW.SUPPLY_CHAIN": command(["node", "scripts/assert-deerflow-production-deployment.mjs"], "deerflow-deployment-report"),
  "G7.RUNTIME.DURABLE_REPLAY": general,
  "G7.RUNTIME.PROVIDER_FAILURE_MATRIX": general,
  "G7.RUNTIME.REQUEST_SCOPED_SECRETS": command(["node", "scripts/assert-deerflow-secret-channel-attestation.mjs"], "secret-channel-attestation"),
  "G7.TOOLS.DECLARED_SCOPE": command(["node", "scripts/deerflow-workbench-tool-contract.mjs"], "tool-scope-report"),
  "G8.EXPORT.PROVIDER_FAILURES": command(["node", "scripts/e2e/workbench-export-recovery-smoke.mjs"], "browser-smoke-report"),
  "G8.IMPORT.SCAN_QUARANTINE": general,
  "G8.PREVIEW.DUAL_ORIGIN": command(["node", "scripts/e2e/workbench-isolated-preview-smoke.mjs"], "browser-smoke-report"),
  "G8.PUBLICATION.EXPLICIT_CONFIRMATION": command(["node", "scripts/e2e/workbench-approval-preferences-smoke.mjs"], "browser-smoke-report"),
  "G8.STORAGE.MULTIPART_CHECKSUM": general,
  "G9.CITATION.ROUTE_ISOLATION": general,
  "G9.MODEL.DIGEST_ADOPTION": command(["node", "scripts/workbench-knowledge-conformance.mjs"], "knowledge-conformance-report"),
  "G9.QUARTZ.DELIVERY": general,
  "G9.RETRIEVAL.CHINESE_BENCHMARK": command(["node", "scripts/workbench-knowledge-retrieval-eval.mjs"], "knowledge-evaluation-report"),
  "G10.CAPACITY.ACTIVE_RUNS": general,
  "G10.CAPACITY.BATCH_SIZE": general,
  "G10.CAPACITY.CANCEL_LATENCY": general,
  "G10.CAPACITY.POLLER_QPS_PER_REPLICA": general,
  "G10.CAPACITY.PROFILE_BINDING": general,
  "G10.CAPACITY.RECOVERY_TIME": general,
  "G10.EDGE.TLS_WIREGUARD": general,
  "G10.OBSERVABILITY.OTLP_ALERT": general,
  "G10.RECOVERY.FAILURE_MATRIX": general,
  "G10.SLO.BLOCKING_INCIDENTS": general,
  "G10.TOPOLOGY.CLEAN_HOST": general,
  "G11.ACCESSIBILITY.REDUCED_MOTION": command(["node", "scripts/e2e/run-workbench-web-smoke.mjs"], "browser-smoke-report"),
  "G11.BROWSER.VIEWPORT_MATRIX": command(["node", "scripts/e2e/run-workbench-web-smoke.mjs"], "browser-smoke-report"),
  "G11.FIGMA.SCOPE": general,
  "G11.PRODUCT.ACCOUNT_PROJECT": command(["node", "scripts/e2e/workbench-navigation-guard-smoke.mjs"], "browser-smoke-report"),
  "G11.PRODUCT.IMPORT_EXPORT_PREVIEW": command(["node", "scripts/e2e/workbench-export-recovery-smoke.mjs"], "browser-smoke-report"),
  "G11.PRODUCT.RUN_CANVAS_PROTOTYPE": command(["node", "scripts/e2e/workbench-run-preview-smoke.mjs"], "browser-smoke-report"),
  "G11.QUALITY.CONSOLE_ERRORS": command(["node", "scripts/e2e/run-workbench-web-smoke.mjs"], "browser-smoke-report"),
  "G11.QUALITY.FAILED_NETWORK_REQUESTS": command(["node", "scripts/e2e/run-workbench-web-smoke.mjs"], "browser-smoke-report"),
});

export const PRODUCTION_CONTROL_RUNNER_PATH = "scripts/production-acceptance/run-control.mjs";
export const PRODUCTION_CONTROL_RUNNER_NAME = "workbench-production-control-runner";

export function executionForControl(controlId) {
  return CONTROL_EXECUTION_REGISTRY[controlId] ?? null;
}
