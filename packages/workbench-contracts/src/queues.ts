import { z } from "zod";
import { opaqueIdSchema } from "./common.js";
import { sha256Schema } from "./files.js";

export const runtimeExecuteQueue = "runtime.execute";
export const runtimeCancelQueue = "runtime.cancel";
export const fileVerifyQueue = "file.verify";
export const fileExtractQueue = "file.extract";
export const knowledgeReleaseBuildQueue = "knowledge.release.build";
export const blobGcQueue = "blob.gc";
export const exportBuildQueue = "export.build";
export const exportDeliveryQueue = "export.delivery";
export const importSourceProcessQueue = "import.source.process";

export const importSourceProcessQueueOptions = {
  policy: "short",
  retryLimit: 0,
  retryDelay: 5,
  retryBackoff: true,
  retryDelayMax: 5 * 60,
  expireInSeconds: 20 * 60,
  heartbeatSeconds: 30,
  deleteAfterSeconds: 7 * 24 * 60 * 60,
  notify: true,
} as const;

export const exportDeliveryQueueOptions = {
  policy: "short",
  retryLimit: 3,
  retryDelay: 5,
  retryBackoff: true,
  retryDelayMax: 5 * 60,
  expireInSeconds: 15 * 60,
  heartbeatSeconds: 30,
  deleteAfterSeconds: 7 * 24 * 60 * 60,
  notify: true,
} as const;

// Producers and consumers both create pg-boss queues during startup. Keep the
// full definition shared and assert the persisted queue after createQueue(),
// because pg-boss does not overwrite an existing queue's configuration.
export const runtimeExecuteQueueOptions = {
  policy: "key_strict_fifo",
  retryLimit: 5,
  retryDelay: 2,
  retryBackoff: true,
  retryDelayMax: 60,
  expireInSeconds: 15 * 60,
  heartbeatSeconds: 30,
  deleteAfterSeconds: 7 * 24 * 60 * 60,
  notify: true,
} as const;

export const runtimeCancelQueueOptions = {
  policy: "short",
  retryLimit: 5,
  retryDelay: 1,
  retryBackoff: true,
  retryDelayMax: 30,
  expireInSeconds: 60,
  deleteAfterSeconds: 24 * 60 * 60,
  notify: true,
} as const;

export const fileExtractQueueOptions = {
  policy: "short",
  retryLimit: 5,
  retryDelay: 2,
  retryBackoff: true,
  retryDelayMax: 60,
  expireInSeconds: 12 * 60,
  heartbeatSeconds: 30,
  deleteAfterSeconds: 7 * 24 * 60 * 60,
  notify: true,
} as const;

export const knowledgeReleaseBuildQueueOptions = {
  policy: "exclusive",
  retryLimit: 5,
  retryDelay: 5,
  retryBackoff: true,
  retryDelayMax: 120,
  expireInSeconds: 20 * 60,
  heartbeatSeconds: 30,
  deleteAfterSeconds: 7 * 24 * 60 * 60,
  notify: true,
} as const;

export const blobGcQueueOptions = {
  policy: "short",
  retryLimit: 5,
  retryDelay: 10,
  retryBackoff: true,
  retryDelayMax: 5 * 60,
  expireInSeconds: 5 * 60,
  heartbeatSeconds: 30,
  deleteAfterSeconds: 7 * 24 * 60 * 60,
  notify: true,
} as const;

const runtimeExecuteQueueConfigurationSchema = z.object({
  name: z.literal(runtimeExecuteQueue),
  policy: z.literal(runtimeExecuteQueueOptions.policy),
  retryLimit: z.literal(runtimeExecuteQueueOptions.retryLimit),
  retryDelay: z.literal(runtimeExecuteQueueOptions.retryDelay),
  retryBackoff: z.literal(runtimeExecuteQueueOptions.retryBackoff),
  retryDelayMax: z.literal(runtimeExecuteQueueOptions.retryDelayMax),
  expireInSeconds: z.literal(runtimeExecuteQueueOptions.expireInSeconds),
  heartbeatSeconds: z.literal(runtimeExecuteQueueOptions.heartbeatSeconds),
  deleteAfterSeconds: z.literal(runtimeExecuteQueueOptions.deleteAfterSeconds),
  notify: z.literal(runtimeExecuteQueueOptions.notify),
}).passthrough();

export function assertRuntimeExecuteQueueConfiguration(value: unknown): void {
  const result = runtimeExecuteQueueConfigurationSchema.safeParse(value);
  if (result.success) return;
  const fields = [...new Set(result.error.issues.map((issue) => issue.path.join(".") || "queue"))].join(", ");
  throw new Error(`RUNTIME_EXECUTE_QUEUE_CONFIGURATION_MISMATCH:${fields}`);
}

const runtimeCancelQueueConfigurationSchema = z.object({
  name: z.literal(runtimeCancelQueue),
  policy: z.literal(runtimeCancelQueueOptions.policy),
  retryLimit: z.literal(runtimeCancelQueueOptions.retryLimit),
  retryDelay: z.literal(runtimeCancelQueueOptions.retryDelay),
  retryBackoff: z.literal(runtimeCancelQueueOptions.retryBackoff),
  retryDelayMax: z.literal(runtimeCancelQueueOptions.retryDelayMax),
  expireInSeconds: z.literal(runtimeCancelQueueOptions.expireInSeconds),
  deleteAfterSeconds: z.literal(runtimeCancelQueueOptions.deleteAfterSeconds),
  notify: z.literal(runtimeCancelQueueOptions.notify),
}).passthrough();

export function assertRuntimeCancelQueueConfiguration(value: unknown): void {
  const result = runtimeCancelQueueConfigurationSchema.safeParse(value);
  if (result.success) return;
  const fields = [...new Set(result.error.issues.map((issue) => issue.path.join(".") || "queue"))].join(", ");
  throw new Error(`RUNTIME_CANCEL_QUEUE_CONFIGURATION_MISMATCH:${fields}`);
}

type RuntimeQueueOptions = typeof runtimeExecuteQueueOptions | typeof runtimeCancelQueueOptions;

interface RuntimeQueueManager {
  createQueue(name: string, options: RuntimeQueueOptions): Promise<unknown>;
  getQueue(name: string): Promise<unknown>;
}

type RuntimeQueueMutableOptions = Omit<RuntimeQueueOptions, "policy">;

interface RuntimeQueueReconciliationManager extends RuntimeQueueManager {
  updateQueue(name: string, options: RuntimeQueueMutableOptions): Promise<unknown>;
  deleteQueue(name: string): Promise<unknown>;
}

const runtimeQueueDefinitions = [
  {
    name: runtimeExecuteQueue,
    options: runtimeExecuteQueueOptions,
    assertConfiguration: assertRuntimeExecuteQueueConfiguration,
  },
  {
    name: runtimeCancelQueue,
    options: runtimeCancelQueueOptions,
    assertConfiguration: assertRuntimeCancelQueueConfiguration,
  },
] as const;

export async function createAndAssertRuntimeQueues(manager: RuntimeQueueManager): Promise<void> {
  for (const definition of runtimeQueueDefinitions) {
    await manager.createQueue(definition.name, definition.options);
  }
  for (const definition of runtimeQueueDefinitions) {
    definition.assertConfiguration(await manager.getQueue(definition.name));
  }
}

export async function reconcileRuntimeQueues(
  manager: RuntimeQueueReconciliationManager,
  options: { allowPolicyRecreate: boolean },
): Promise<void> {
  for (const definition of runtimeQueueDefinitions) {
    let persisted = await manager.getQueue(definition.name);
    if (persisted === null || persisted === undefined) {
      await manager.createQueue(definition.name, definition.options);
      persisted = await manager.getQueue(definition.name);
      definition.assertConfiguration(persisted);
      continue;
    }

    try {
      definition.assertConfiguration(persisted);
      continue;
    } catch {
      assertRuntimeQueueIdle(definition.name, persisted);
    }

    const record = runtimeQueueRecord(definition.name, persisted);
    if (record.policy !== definition.options.policy) {
      if (!options.allowPolicyRecreate) {
        throw new Error(`RUNTIME_QUEUE_POLICY_RECREATE_REQUIRED:${definition.name}`);
      }
      await manager.deleteQueue(definition.name);
      await manager.createQueue(definition.name, definition.options);
    } else {
      const { policy: _policy, ...mutableOptions } = definition.options;
      await manager.updateQueue(definition.name, mutableOptions);
    }

    definition.assertConfiguration(await manager.getQueue(definition.name));
  }
}

function assertRuntimeQueueIdle(name: string, persisted: unknown) {
  const record = runtimeQueueRecord(name, persisted);
  const counts = ["queuedCount", "deferredCount", "activeCount"] as const;
  for (const field of counts) {
    if (!Number.isInteger(record[field]) || Number(record[field]) < 0) {
      throw new Error(`RUNTIME_QUEUE_COUNTS_INVALID:${name}:${field}`);
    }
  }
  if (counts.some((field) => Number(record[field]) > 0)) {
    throw new Error(`RUNTIME_QUEUE_RECONCILIATION_REQUIRES_DRAIN:${name}`);
  }
}

function runtimeQueueRecord(name: string, persisted: unknown): Record<string, unknown> {
  if (!persisted || typeof persisted !== "object" || Array.isArray(persisted)) {
    throw new Error(`RUNTIME_QUEUE_CONFIGURATION_MISSING:${name}`);
  }
  return persisted as Record<string, unknown>;
}

const knowledgeReleaseBuildQueueConfigurationSchema = z.object({
  name: z.literal(knowledgeReleaseBuildQueue),
  policy: z.literal(knowledgeReleaseBuildQueueOptions.policy),
  retryLimit: z.literal(knowledgeReleaseBuildQueueOptions.retryLimit),
  retryDelay: z.literal(knowledgeReleaseBuildQueueOptions.retryDelay),
  retryBackoff: z.literal(knowledgeReleaseBuildQueueOptions.retryBackoff),
  retryDelayMax: z.literal(knowledgeReleaseBuildQueueOptions.retryDelayMax),
  expireInSeconds: z.literal(knowledgeReleaseBuildQueueOptions.expireInSeconds),
  heartbeatSeconds: z.literal(knowledgeReleaseBuildQueueOptions.heartbeatSeconds),
  deleteAfterSeconds: z.literal(knowledgeReleaseBuildQueueOptions.deleteAfterSeconds),
  notify: z.literal(knowledgeReleaseBuildQueueOptions.notify),
}).passthrough();

export function assertKnowledgeReleaseBuildQueueConfiguration(value: unknown): void {
  const result = knowledgeReleaseBuildQueueConfigurationSchema.safeParse(value);
  if (result.success) return;
  const fields = [...new Set(result.error.issues.map((issue) => issue.path.join(".") || "queue"))].join(", ");
  throw new Error(`KNOWLEDGE_RELEASE_QUEUE_CONFIGURATION_MISMATCH:${fields}`);
}

const blobGcQueueConfigurationSchema = z.object({
  name: z.literal(blobGcQueue),
  policy: z.literal(blobGcQueueOptions.policy),
  retryLimit: z.literal(blobGcQueueOptions.retryLimit),
  retryDelay: z.literal(blobGcQueueOptions.retryDelay),
  retryBackoff: z.literal(blobGcQueueOptions.retryBackoff),
  retryDelayMax: z.literal(blobGcQueueOptions.retryDelayMax),
  expireInSeconds: z.literal(blobGcQueueOptions.expireInSeconds),
  heartbeatSeconds: z.literal(blobGcQueueOptions.heartbeatSeconds),
  deleteAfterSeconds: z.literal(blobGcQueueOptions.deleteAfterSeconds),
  notify: z.literal(blobGcQueueOptions.notify),
}).passthrough();

export function assertBlobGcQueueConfiguration(value: unknown): void {
  const result = blobGcQueueConfigurationSchema.safeParse(value);
  if (result.success) return;
  const fields = [...new Set(result.error.issues.map((issue) => issue.path.join(".") || "queue"))].join(", ");
  throw new Error(`BLOB_GC_QUEUE_CONFIGURATION_MISMATCH:${fields}`);
}

const importSourceProcessQueueConfigurationSchema = z.object({
  name: z.literal(importSourceProcessQueue),
  policy: z.literal(importSourceProcessQueueOptions.policy),
  retryLimit: z.literal(importSourceProcessQueueOptions.retryLimit),
  retryDelay: z.literal(importSourceProcessQueueOptions.retryDelay),
  retryBackoff: z.literal(importSourceProcessQueueOptions.retryBackoff),
  retryDelayMax: z.literal(importSourceProcessQueueOptions.retryDelayMax),
  expireInSeconds: z.literal(importSourceProcessQueueOptions.expireInSeconds),
  heartbeatSeconds: z.literal(importSourceProcessQueueOptions.heartbeatSeconds),
  deleteAfterSeconds: z.literal(importSourceProcessQueueOptions.deleteAfterSeconds),
  notify: z.literal(importSourceProcessQueueOptions.notify),
}).passthrough();

export function assertImportSourceProcessQueueConfiguration(value: unknown): void {
  const result = importSourceProcessQueueConfigurationSchema.safeParse(value);
  if (result.success) return;
  const fields = [...new Set(result.error.issues.map((issue) => issue.path.join(".") || "queue"))].join(", ");
  throw new Error(`IMPORT_SOURCE_PROCESS_QUEUE_CONFIGURATION_MISMATCH:${fields}`);
}

export const runtimeExecuteJobSchema = z.object({
  runId: opaqueIdSchema,
  approvalIds: z.array(opaqueIdSchema).max(50).optional(),
}).strict().superRefine((job, context) => {
  if (job.approvalIds && new Set(job.approvalIds).size !== job.approvalIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["approvalIds"],
      message: "approvalIds must be unique",
    });
  }
});

export const runtimeCancelJobSchema = z.object({
  runId: opaqueIdSchema,
}).strict();

export const fileVerifyJobSchema = z.object({
  uploadSessionId: opaqueIdSchema,
}).strict();

export const fileExtractJobSchema = z.object({
  extractionId: opaqueIdSchema,
}).strict();

export const knowledgeReleaseBuildJobSchema = z.object({
  releaseId: opaqueIdSchema,
}).strict();

export const blobGcJobSchema = z.object({
  blobId: opaqueIdSchema,
}).strict();

export const exportBuildJobSchema = z.object({
  exportJobId: opaqueIdSchema,
}).strict();

export const exportDeliveryJobSchema = z.object({
  deliveryId: opaqueIdSchema,
}).strict();

export const importSourceProcessJobSchema = z.object({
  sourceId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  requestHash: sha256Schema,
}).strict();

export function importSourceProcessJobOptions(
  job: Pick<z.infer<typeof importSourceProcessJobSchema>, "sourceId">,
) {
  return { singletonKey: job.sourceId } as const;
}

export type RuntimeExecuteJob = z.infer<typeof runtimeExecuteJobSchema>;
export type RuntimeCancelJob = z.infer<typeof runtimeCancelJobSchema>;
export type FileVerifyJob = z.infer<typeof fileVerifyJobSchema>;
export type FileExtractJob = z.infer<typeof fileExtractJobSchema>;
export type KnowledgeReleaseBuildJob = z.infer<typeof knowledgeReleaseBuildJobSchema>;
export type BlobGcJob = z.infer<typeof blobGcJobSchema>;
export type ExportBuildJob = z.infer<typeof exportBuildJobSchema>;
export type ExportDeliveryJob = z.infer<typeof exportDeliveryJobSchema>;
export type ImportSourceProcessJob = z.infer<typeof importSourceProcessJobSchema>;
