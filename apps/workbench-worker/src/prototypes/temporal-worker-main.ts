import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client, Connection, CancelledFailure, WorkflowFailedError, WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { decodeKnowledgeToolSecret } from "@workbench/workbench-knowledge";
import { PrismaClient } from "@workbench/workbench-db";
import { createPrototypeActivities } from "./prototype-activities.js";
import { loadPrototypeArtifactStorageConfig } from "./prototype-artifact-storage.config.js";
import { createTemporalSdkActivities } from "./temporal-sdk-activities.js";
import { PrototypeTemporalWorker } from "./temporal-worker.js";
import { PROTOTYPE_EXPORT_WORKFLOW_VERSION, PROTOTYPE_GENERATION_WORKFLOW_VERSION, PROTOTYPE_TEMPORAL_WORKFLOW_VERSION } from "./temporal-sdk-workflows.js";

const db = new PrismaClient();
const knowledgeEndpoint = process.env.WORKBENCH_KNOWLEDGE_TOOL_URL;
const knowledgeSecret = process.env.WORKBENCH_KNOWLEDGE_TOOL_SECRET;
if (!knowledgeEndpoint || !knowledgeSecret) throw new Error("WORKBENCH_KNOWLEDGE_TOOL_NOT_CONFIGURED");
const knowledgeUrl = new URL(knowledgeEndpoint);
if (!["http:", "https:"].includes(knowledgeUrl.protocol) || knowledgeUrl.username || knowledgeUrl.password || knowledgeUrl.search || knowledgeUrl.hash || (process.env.NODE_ENV === "production" && knowledgeUrl.protocol !== "https:")) throw new Error("WORKBENCH_KNOWLEDGE_TOOL_URL_INVALID");
const knowledgeTtlSeconds = Number(process.env.WORKBENCH_KNOWLEDGE_TOOL_MAX_TTL_SECONDS || 3600);
if (!Number.isInteger(knowledgeTtlSeconds) || knowledgeTtlSeconds < 1860 || knowledgeTtlSeconds > 3600) throw new Error("WORKBENCH_KNOWLEDGE_TOOL_TTL_INVALID");
const runtimeBlobAccessKey = process.env.WORKBENCH_RUNTIME_READY_BLOB_S3_ACCESS_KEY_ID;
const runtimeBlobSecretKey = process.env.WORKBENCH_RUNTIME_READY_BLOB_S3_SECRET_ACCESS_KEY;
if (!runtimeBlobAccessKey || !runtimeBlobSecretKey || !process.env.WORKBENCH_S3_BUCKET) throw new Error("WORKBENCH_RUNTIME_READY_BLOB_STORAGE_NOT_CONFIGURED");
const configured = {
  runtimeBlobStorage: {
    s3Bucket: process.env.WORKBENCH_S3_BUCKET,
    s3Region: process.env.WORKBENCH_S3_REGION || "us-east-1",
    s3InternalEndpoint: process.env.WORKBENCH_S3_INTERNAL_ENDPOINT || undefined,
    s3ForcePathStyle: process.env.WORKBENCH_S3_INTERNAL_FORCE_PATH_STYLE ? process.env.WORKBENCH_S3_INTERNAL_FORCE_PATH_STYLE === "true" : Boolean(process.env.WORKBENCH_S3_INTERNAL_ENDPOINT),
    runtimeReadyBlobS3AccessKeyId: runtimeBlobAccessKey,
    runtimeReadyBlobS3SecretAccessKey: runtimeBlobSecretKey,
  },
  knowledgeTool: {
    endpoint: knowledgeEndpoint,
    secret: decodeKnowledgeToolSecret(knowledgeSecret),
    maximumTtlSeconds: knowledgeTtlSeconds,
  },
  deerFlowUrl: process.env.DEERFLOW_LANGGRAPH_URL || "",
  deerFlowToken: process.env.DEERFLOW_INTERNAL_AUTH_TOKEN || "",
  deerFlowGatewayUrl: process.env.DEERFLOW_GATEWAY_URL || process.env.DEERFLOW_LANGGRAPH_URL || "",
  deerFlowAssistantId: process.env.DEERFLOW_ASSISTANT_ID || "lead_agent",
  deerFlowStreamMode: (process.env.DEERFLOW_STREAM_MODE || "messages-tuple,values").split(",").map((item) => item.trim()).filter(Boolean),
  deerFlowTimeoutMs: Number(process.env.DEERFLOW_TIMEOUT_MS || 600_000),
  deerFlowSubmissionTimeoutMs: Number(process.env.DEERFLOW_SUBMISSION_TIMEOUT_MS || 120_000),
  deerFlowIdleTimeoutMs: Number(process.env.DEERFLOW_IDLE_TIMEOUT_MS || 120_000),
  ...loadPrototypeArtifactStorageConfig(),
  chromiumExecutablePath: process.env.WORKBENCH_EXPORT_CHROMIUM_PATH,
};
if (!configured.deerFlowUrl || !configured.deerFlowToken || !configured.artifactBucket) throw new Error("Missing Temporal prototype worker configuration");

const temporalAddress = process.env.WORKBENCH_TEMPORAL_ADDRESS || "127.0.0.1:7233";
const temporalNamespace = process.env.WORKBENCH_TEMPORAL_NAMESPACE || "default";
const temporalTaskQueue = process.env.WORKBENCH_TEMPORAL_TASK_QUEUE || "workbench-prototype-v2";
const temporalConnectTimeoutMs = Number(process.env.WORKBENCH_TEMPORAL_CONNECT_TIMEOUT_MS || 10_000);
const workflowPath = fileURLToPath(new URL("./temporal-sdk-workflows.js", import.meta.url));

await db.$connect();
const activities = createPrototypeActivities(db, configured);
const sdkActivities = createTemporalSdkActivities(activities);
let nativeConnection: NativeConnection | undefined;
let clientConnection: Connection | undefined;
let sdkWorker: Worker | undefined;
let workerRun: Promise<void> | undefined;
let temporalClient: Client | undefined;

function generationWorkflowId(planId: string): string { return `workbench-prototype-generation-${PROTOTYPE_GENERATION_WORKFLOW_VERSION}-${planId}`; }
function exportWorkflowId(exportId: string, commandId: unknown): string {
  if (typeof commandId !== "string" || !commandId.startsWith("prototype_command_")) throw new Error("PROTOTYPE_EXPORT_COMMAND_REQUIRED");
  return `workbench-prototype-export-${PROTOTYPE_EXPORT_WORKFLOW_VERSION}-${exportId}-${createHash("sha256").update(commandId).digest("hex")}`;
}
function shareWorkflowId(action: string, projectId: string, targetId: string, principalId: string, idempotencyKey: string): string {
  const scope = createHash("sha256").update(JSON.stringify({ action, projectId, targetId, principalId, idempotencyKey })).digest("hex");
  return `workbench-prototype-share-${PROTOTYPE_TEMPORAL_WORKFLOW_VERSION}-${scope}`;
}


const temporalWorker = new PrototypeTemporalWorker({
  healthPort: Number(process.env.WORKBENCH_TEMPORAL_WORKER_HEALTH_PORT || 4310),
  activities,
  isTemporalWorkerRunning: () => sdkWorker?.getState() === "RUNNING",
  registerTemporalWorker: async () => {
    nativeConnection = await NativeConnection.connect({ address: temporalAddress });
    clientConnection = await Connection.connect({ address: temporalAddress, connectTimeout: temporalConnectTimeoutMs });
    temporalClient = new Client({ connection: clientConnection, namespace: temporalNamespace });
    sdkWorker = await Worker.create({ connection: nativeConnection, namespace: temporalNamespace, taskQueue: temporalTaskQueue, workflowsPath: workflowPath, activities: sdkActivities });
    workerRun = sdkWorker.run();
    void workerRun.catch((error) => { console.error("[prototype-temporal-worker] Temporal worker stopped", error); process.exitCode = 1; });
  },
  stopTemporalWorker: async () => {
    sdkWorker?.shutdown();
    await workerRun?.catch(() => undefined);
    await clientConnection?.close().catch(() => undefined);
    await nativeConnection?.close().catch(() => undefined);
    sdkWorker = undefined;
    workerRun = undefined;
    temporalClient = undefined;
    clientConnection = undefined;
    nativeConnection = undefined;
  },
  onStart: async (payload) => {
    if (!temporalClient) throw new Error("TEMPORAL_CLIENT_NOT_READY");
    if (payload.workflow === "visualPrototypeGeneration") {
      const projectId = String(payload.projectId);
      const planId = String(payload.planId);
      await temporalClient.workflow.start("visualPrototypeGenerationV3", { workflowId: generationWorkflowId(planId), workflowIdConflictPolicy: "USE_EXISTING", workflowIdReusePolicy: "REJECT_DUPLICATE", taskQueue: temporalTaskQueue, args: [{ projectId, planId }] }).catch((error: unknown) => { if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error; });
      return;
    }
    if (payload.workflow === "visualPrototypeExport") {
      const exportId = String(payload.exportId);
      await temporalClient.workflow.start("visualPrototypeExportV3", { workflowId: exportWorkflowId(exportId, payload.commandId), workflowIdConflictPolicy: "USE_EXISTING", workflowIdReusePolicy: "REJECT_DUPLICATE", taskQueue: temporalTaskQueue, args: [{ projectId: String(payload.projectId), exportId, commandId: String(payload.commandId), revisionId: String(payload.revisionId), format: payload.format === "react" ? "react" : "html" }] }).catch((error: unknown) => { if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error; });
      return;
    }
    throw new Error("PROTOTYPE_WORKFLOW_UNKNOWN");
  },
  onCancel: async (payload) => {
    if (!temporalClient) throw new Error("TEMPORAL_CLIENT_NOT_READY");
    const workflowId = payload.workflow === "visualPrototypeExport" ? exportWorkflowId(String(payload.exportId), payload.commandId) : generationWorkflowId(String(payload.planId));
    const handle = temporalClient.workflow.getHandle(workflowId);
    await handle.cancel();
    if (payload.workflow === "visualPrototypeGeneration") {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          handle.result().catch((error: unknown) => {
            if (!(error instanceof WorkflowFailedError && error.cause instanceof CancelledFailure)) throw error;
          }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("PROTOTYPE_CANCELLATION_PENDING")), 20_000); }),
        ]);
      } finally { if (timer) clearTimeout(timer); }
    }
  },
  onExecute: async (payload) => {
    if (!temporalClient) throw new Error("TEMPORAL_CLIENT_NOT_READY");
    if (payload.workflow !== "visualPrototypeShare") throw new Error("PROTOTYPE_WORKFLOW_UNKNOWN");
    const action = payload.action === "revoke" ? "revoke" : payload.action === "freeze" ? "freeze" : "create";
    const targetId = action === "revoke" ? String(payload.shareId) : action === "freeze" ? String(payload.revisionId) : String(payload.idempotencyKey);
    const workflowId = shareWorkflowId(action, String(payload.projectId), targetId, String(payload.createdById ?? ""), String(payload.idempotencyKey));
    return temporalClient.workflow.execute("visualPrototypeShareV2", {
      workflowId,
      workflowIdConflictPolicy: "USE_EXISTING",
      workflowIdReusePolicy: "ALLOW_DUPLICATE_FAILED_ONLY",
      taskQueue: temporalTaskQueue,
      args: action === "create"
        ? [{ action, preview: { projectId: String(payload.projectId), revisionId: String(payload.revisionId) }, input: { projectId: String(payload.projectId), revisionId: String(payload.revisionId), createdById: String(payload.createdById), tokenHash: String(payload.tokenHash), idempotencyKey: String(payload.idempotencyKey), requestHash: String(payload.requestHash), expiresAt: payload.expiresAt ? String(payload.expiresAt) : null } }]
        : action === "freeze"
          ? [{ action, preview: { projectId: String(payload.projectId), revisionId: String(payload.revisionId) } }]
        : [{ action, input: { projectId: String(payload.projectId), shareId: String(payload.shareId), expectedRevision: Number(payload.expectedRevision), commandId: String(payload.commandId) } }],
    }).catch(async (error: unknown) => {
      if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
      return temporalClient!.workflow.getHandle(workflowId).result();
    });
  },
});
await temporalWorker.start();
const shutdown = async () => { await temporalWorker.stop().catch(() => undefined); await db.$disconnect().catch(() => undefined); };
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
console.log(`[prototype-temporal-worker] ready address=${temporalAddress} namespace=${temporalNamespace} taskQueue=${temporalTaskQueue}`);
