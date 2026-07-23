import { decodeKnowledgeToolSecret } from "@workbench/workbench-knowledge";
import { decodeCanvasToolCapabilitySecret } from "@workbench/workbench-canvas-tools";
import { runtimeExecuteQueueOptions } from "@workbench/workbench-contracts";

export type WorkerConfig = ReturnType<typeof loadWorkerConfig>;

export function loadWorkerConfig() {
  const databaseUrl = required("WORKBENCH_DATABASE_URL");
  const s3InternalEndpoint = optionalUrl("WORKBENCH_S3_INTERNAL_ENDPOINT");
  const runtimeReadyBlobS3AccessKeyId = required("WORKBENCH_RUNTIME_READY_BLOB_S3_ACCESS_KEY_ID");
  const runtimeReadyBlobS3SecretAccessKey = required("WORKBENCH_RUNTIME_READY_BLOB_S3_SECRET_ACCESS_KEY");
  const knowledgeToolEndpoint = optionalUrl("WORKBENCH_KNOWLEDGE_TOOL_URL", {
    rejectQuery: true,
    requireHttps: process.env.NODE_ENV === "production",
  });
  const knowledgeToolSecretValue = optional("WORKBENCH_KNOWLEDGE_TOOL_SECRET");
  if (Boolean(knowledgeToolEndpoint) !== Boolean(knowledgeToolSecretValue)) {
    throw new Error("WORKBENCH_KNOWLEDGE_TOOL_URL and WORKBENCH_KNOWLEDGE_TOOL_SECRET must be configured together");
  }
  const canvasToolEndpoint = optionalUrl("WORKBENCH_CANVAS_TOOL_URL", {
    rejectQuery: true,
    requireHttps: process.env.NODE_ENV === "production",
  });
  const canvasToolSecretValue = optional("WORKBENCH_CANVAS_TOOL_SECRET");
  if (Boolean(canvasToolEndpoint) !== Boolean(canvasToolSecretValue)) {
    throw new Error("WORKBENCH_CANVAS_TOOL_URL and WORKBENCH_CANVAS_TOOL_SECRET must be configured together");
  }
  const canvasVisualEndpoint = optionalUrl("WORKBENCH_CANVAS_VISUAL_URL", {
    rejectQuery: true,
    requireHttps: process.env.NODE_ENV === "production",
  });
  if (Boolean(canvasToolEndpoint) !== Boolean(canvasVisualEndpoint)) {
    throw new Error("WORKBENCH_CANVAS_TOOL_URL and WORKBENCH_CANVAS_VISUAL_URL must be configured together");
  }
  if (canvasToolEndpoint && canvasVisualEndpoint) {
    const toolUrl = new URL(canvasToolEndpoint);
    const visualUrl = new URL(canvasVisualEndpoint);
    if (
      toolUrl.origin !== visualUrl.origin
      || toolUrl.pathname !== "/api/v1/runtime/canvas/tools/execute"
      || visualUrl.pathname !== "/api/v1/runtime/canvas/visuals"
    ) {
      throw new Error("Canvas tool and visual URLs must share one origin and use their canonical capability paths");
    }
  }
  const deerFlowTimeoutMs = positiveInteger("DEERFLOW_TIMEOUT_MS", 600_000);
  const deerFlowSubmissionTimeoutMs = boundedInteger(
    "DEERFLOW_SUBMISSION_TIMEOUT_MS",
    120_000,
    1_000,
    10 * 60_000,
  );
  const runtimeExecutionLeaseMs = boundedInteger(
    "WORKBENCH_RUNTIME_EXECUTION_LEASE_MS",
    45_000,
    10_000,
    300_000,
  );
  const runtimeExecutionHeartbeatMs = boundedInteger(
    "WORKBENCH_RUNTIME_EXECUTION_HEARTBEAT_MS",
    15_000,
    1_000,
    120_000,
  );
  const runtimeProviderStateMode = enumValue(
    "WORKBENCH_RUNTIME_PROVIDER_STATE_MODE",
    ["legacy-read", "shadow-verify", "projection-required"] as const,
    "legacy-read",
  );
  const runtimeExecutionMaximumWallClockMs = boundedInteger(
    "WORKBENCH_RUNTIME_EXECUTION_MAX_WALL_CLOCK_MS",
    30 * 60_000,
    60_000,
    4 * 60 * 60_000,
  );
  const runtimeExecutionDeadlineCancelMs = boundedInteger(
    "WORKBENCH_RUNTIME_EXECUTION_DEADLINE_CANCEL_MS",
    30_000,
    1_000,
    5 * 60_000,
  );
  if (runtimeExecutionHeartbeatMs * 2 >= runtimeExecutionLeaseMs) {
    throw new Error("WORKBENCH_RUNTIME_EXECUTION_HEARTBEAT_MS must be less than half the execution lease");
  }
  if (
    runtimeExecutionMaximumWallClockMs + runtimeExecutionDeadlineCancelMs
      >= runtimeExecuteQueueOptions.expireInSeconds * 1_000
  ) {
    throw new Error(
      "Runtime max wall clock plus deadline cancellation must be less than the pg-boss handler deadline",
    );
  }
  return {
    databaseUrl,
    queueConnectionString: pgConnectionString(databaseUrl),
    deerFlowLangGraphUrl: trimTrailingSlash(required("DEERFLOW_LANGGRAPH_URL")),
    deerFlowGatewayUrl: trimTrailingSlash(required("DEERFLOW_GATEWAY_URL")),
    deerFlowAssistantId: process.env.DEERFLOW_ASSISTANT_ID || "lead_agent",
    deerFlowInternalToken: process.env.DEERFLOW_INTERNAL_AUTH_TOKEN || "",
    deerFlowStreamMode: (process.env.DEERFLOW_STREAM_MODE || "messages,values")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    deerFlowTimeoutMs,
    deerFlowSubmissionTimeoutMs,
    deerFlowIdleTimeoutMs: boundedInteger(
      "DEERFLOW_IDLE_TIMEOUT_MS",
      120_000,
      1_000,
      10 * 60_000,
    ),
    // Keep queue execution and cancellation polling bounded even if an
    // operator supplies an unexpectedly large environment value.
    concurrency: boundedInteger("WORKBENCH_RUNTIME_CONCURRENCY", 2, 1, 64),
    runtimeCancellationPollIntervalMs: boundedInteger(
      "WORKBENCH_RUNTIME_CANCELLATION_POLL_INTERVAL_MS",
      1_000,
      250,
      10_000,
    ),
    runtimeCancellationQueryBatchSize: boundedInteger(
      "WORKBENCH_RUNTIME_CANCELLATION_QUERY_BATCH_SIZE",
      100,
      1,
      1_000,
    ),
    runtimeExecutionLeaseMs,
    runtimeExecutionHeartbeatMs,
    runtimeExecutionMaximumWallClockMs,
    runtimeExecutionDeadlineCancelMs,
    runtimeProviderStateMode,
    runtimeExecutionReconcileIntervalMs: boundedInteger(
      "WORKBENCH_RUNTIME_EXECUTION_RECONCILE_INTERVAL_MS",
      5_000,
      1_000,
      60_000,
    ),
    runtimeExecutionReconcileBatchSize: boundedInteger(
      "WORKBENCH_RUNTIME_EXECUTION_RECONCILE_BATCH_SIZE",
      100,
      1,
      1_000,
    ),
    runtimeCancelRecoveryWindowMs: deerFlowTimeoutMs + boundedInteger(
      "WORKBENCH_RUNTIME_CANCEL_VISIBILITY_GRACE_MS",
      60_000,
      10_000,
      10 * 60_000,
    ),
    runtimeCancelReconcileIntervalMs: boundedInteger(
      "WORKBENCH_RUNTIME_CANCEL_RECONCILE_INTERVAL_MS",
      5_000,
      1_000,
      60_000,
    ),
    runtimeCancelReconcileStaleMs: boundedInteger(
      "WORKBENCH_RUNTIME_CANCEL_RECONCILE_STALE_MS",
      5_000,
      1_000,
      60_000,
    ),
    runtimeCancelReconcileBatchSize: boundedInteger(
      "WORKBENCH_RUNTIME_CANCEL_RECONCILE_BATCH_SIZE",
      100,
      1,
      1_000,
    ),
    knowledgeTool: knowledgeToolEndpoint && knowledgeToolSecretValue ? {
      endpoint: knowledgeToolEndpoint,
      secret: decodeKnowledgeToolSecret(knowledgeToolSecretValue),
      maximumTtlSeconds: boundedInteger("WORKBENCH_KNOWLEDGE_TOOL_MAX_TTL_SECONDS", 900, 60, 3_600),
    } : null,
    canvasTool: canvasToolEndpoint && canvasToolSecretValue ? {
      endpoint: canvasToolEndpoint,
      visualEndpoint: canvasVisualEndpoint!,
      secret: decodeCanvasToolCapabilitySecret(canvasToolSecretValue),
      maximumTtlSeconds: boundedInteger("WORKBENCH_CANVAS_TOOL_MAX_TTL_SECONDS", 300, 60, 3_600),
    } : null,
    s3Bucket: required("WORKBENCH_S3_BUCKET"),
    s3Region: optional("WORKBENCH_S3_REGION") ?? "us-east-1",
    s3InternalEndpoint,
    s3ForcePathStyle: booleanValue(
      "WORKBENCH_S3_INTERNAL_FORCE_PATH_STYLE",
      Boolean(s3InternalEndpoint),
    ),
    runtimeReadyBlobS3AccessKeyId,
    runtimeReadyBlobS3SecretAccessKey,
  } satisfies Record<string, unknown>;
}

export function pgConnectionString(value: string) {
  const url = new URL(value);
  url.searchParams.delete("schema");
  return url.toString();
}

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function optional(name: string) {
  return process.env[name]?.trim() || undefined;
}

function optionalUrl(name: string, options: {
  readonly rejectQuery?: boolean;
  readonly requireHttps?: boolean;
} = {}) {
  const value = optional(name);
  if (!value) return undefined;
  const url = new URL(value);
  if (
    !url.hostname
    || !["http:", "https:"].includes(url.protocol)
    || url.username
    || url.password
    || url.hash
    || (options.rejectQuery && url.search)
    || (options.requireHttps && url.protocol !== "https:")
  ) {
    throw new Error(`${name} must be a safe HTTP(S) URL; production capability endpoints require HTTPS`);
  }
  return trimTrailingSlash(value);
}

function booleanValue(name: string, fallback: boolean) {
  const value = optional(name);
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function positiveInteger(name: string, fallback: number) {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function boundedInteger(name: string, fallback: number, minimum: number, maximum: number) {
  const value = optional(name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function enumValue<const T extends readonly string[]>(
  name: string,
  values: T,
  fallback: T[number],
): T[number] {
  const value = optional(name) ?? fallback;
  if (!values.includes(value)) {
    throw new Error(`${name} must be one of: ${values.join(", ")}`);
  }
  return value;
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}
