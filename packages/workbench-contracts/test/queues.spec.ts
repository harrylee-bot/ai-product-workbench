import { describe, expect, it, vi } from "vitest";

import {
  assertImportSourceProcessQueueConfiguration,
  assertKnowledgeReleaseBuildQueueConfiguration,
  assertRuntimeCancelQueueConfiguration,
  assertRuntimeExecuteQueueConfiguration,
  createAndAssertRuntimeQueues,
  fileExtractQueue,
  fileExtractQueueOptions,
  importSourceProcessJobOptions,
  importSourceProcessJobSchema,
  importSourceProcessQueue,
  importSourceProcessQueueOptions,
  knowledgeReleaseBuildJobSchema,
  knowledgeReleaseBuildQueue,
  knowledgeReleaseBuildQueueOptions,
  reconcileRuntimeQueues,
  runtimeCancelQueue,
  runtimeCancelQueueOptions,
  runtimeExecuteQueue,
  runtimeExecuteQueueOptions,
} from "../src/index.js";

describe("shared pg-boss queue definitions", () => {
  it("pins and provisions both Runtime queues from one persisted contract", async () => {
    expect(runtimeExecuteQueueOptions).toEqual({
      policy: "key_strict_fifo",
      retryLimit: 5,
      retryDelay: 2,
      retryBackoff: true,
      retryDelayMax: 60,
      expireInSeconds: 900,
      heartbeatSeconds: 30,
      deleteAfterSeconds: 604_800,
      notify: true,
    });
    expect(runtimeCancelQueueOptions).toEqual({
      policy: "short",
      retryLimit: 5,
      retryDelay: 1,
      retryBackoff: true,
      retryDelayMax: 30,
      expireInSeconds: 60,
      deleteAfterSeconds: 86_400,
      notify: true,
    });

    const persisted = new Map<string, unknown>([
      [runtimeExecuteQueue, { name: runtimeExecuteQueue, ...runtimeExecuteQueueOptions }],
      [runtimeCancelQueue, { name: runtimeCancelQueue, ...runtimeCancelQueueOptions }],
    ]);
    const createQueue = vi.fn(async () => undefined);
    const getQueue = vi.fn(async (name: string) => persisted.get(name));

    await expect(createAndAssertRuntimeQueues({ createQueue, getQueue })).resolves.toBeUndefined();
    expect(createQueue.mock.calls).toEqual([
      [runtimeExecuteQueue, runtimeExecuteQueueOptions],
      [runtimeCancelQueue, runtimeCancelQueueOptions],
    ]);
    expect(getQueue.mock.calls).toEqual([[runtimeExecuteQueue], [runtimeCancelQueue]]);
  });

  it("fails startup when either persisted Runtime queue has drifted", async () => {
    const executePersisted = { name: runtimeExecuteQueue, ...runtimeExecuteQueueOptions };
    const cancelPersisted = { name: runtimeCancelQueue, ...runtimeCancelQueueOptions };
    expect(() => assertRuntimeExecuteQueueConfiguration(executePersisted)).not.toThrow();
    expect(() => assertRuntimeCancelQueueConfiguration(cancelPersisted)).not.toThrow();
    expect(() => assertRuntimeExecuteQueueConfiguration({ ...executePersisted, retryLimit: 0 }))
      .toThrow("RUNTIME_EXECUTE_QUEUE_CONFIGURATION_MISMATCH:retryLimit");
    expect(() => assertRuntimeCancelQueueConfiguration({ ...cancelPersisted, policy: "standard" }))
      .toThrow("RUNTIME_CANCEL_QUEUE_CONFIGURATION_MISMATCH:policy");

    await expect(createAndAssertRuntimeQueues({
      createQueue: async () => undefined,
      getQueue: async (name) => name === runtimeExecuteQueue
        ? executePersisted
        : { ...cancelPersisted, retryDelayMax: 31 },
    })).rejects.toThrow("RUNTIME_CANCEL_QUEUE_CONFIGURATION_MISMATCH:retryDelayMax");
  });

  it("creates missing Runtime queues during deployment reconciliation", async () => {
    const persisted = new Map<string, unknown>();
    const manager = {
      createQueue: vi.fn(async (name: string, options: object) => {
        persisted.set(name, runtimeQueue(name, options));
      }),
      deleteQueue: vi.fn(async () => undefined),
      getQueue: vi.fn(async (name: string) => persisted.get(name) ?? null),
      updateQueue: vi.fn(async () => undefined),
    };

    await expect(reconcileRuntimeQueues(manager, { allowPolicyRecreate: false }))
      .resolves.toBeUndefined();
    expect(manager.createQueue).toHaveBeenCalledTimes(2);
    expect(manager.updateQueue).not.toHaveBeenCalled();
    expect(manager.deleteQueue).not.toHaveBeenCalled();
  });

  it("updates mutable Runtime queue options only after the queue is drained", async () => {
    const persisted = runtimeQueue(runtimeExecuteQueue, {
      ...runtimeExecuteQueueOptions,
      retryLimit: 0,
    });
    const manager = runtimeQueueManager(new Map([
      [runtimeExecuteQueue, persisted],
      [runtimeCancelQueue, runtimeQueue(runtimeCancelQueue, runtimeCancelQueueOptions)],
    ]));

    await expect(reconcileRuntimeQueues(manager, { allowPolicyRecreate: false }))
      .resolves.toBeUndefined();
    expect(manager.updateQueue).toHaveBeenCalledWith(
      runtimeExecuteQueue,
      expect.objectContaining({ retryLimit: 5 }),
    );
    expect(manager.deleteQueue).not.toHaveBeenCalled();
  });

  it("refuses to mutate a Runtime queue while old jobs remain", async () => {
    const manager = runtimeQueueManager(new Map([
      [runtimeExecuteQueue, {
        ...runtimeQueue(runtimeExecuteQueue, { ...runtimeExecuteQueueOptions, retryLimit: 0 }),
        queuedCount: 1,
        readyCount: 1,
      }],
      [runtimeCancelQueue, runtimeQueue(runtimeCancelQueue, runtimeCancelQueueOptions)],
    ]));

    await expect(reconcileRuntimeQueues(manager, { allowPolicyRecreate: true }))
      .rejects.toThrow(`RUNTIME_QUEUE_RECONCILIATION_REQUIRES_DRAIN:${runtimeExecuteQueue}`);
    expect(manager.updateQueue).not.toHaveBeenCalled();
    expect(manager.deleteQueue).not.toHaveBeenCalled();
  });

  it("requires explicit authorization before recreating a drifted queue policy", async () => {
    const queues = new Map<string, unknown>([
      [runtimeExecuteQueue, runtimeQueue(runtimeExecuteQueue, {
        ...runtimeExecuteQueueOptions,
        policy: "standard",
      })],
      [runtimeCancelQueue, runtimeQueue(runtimeCancelQueue, runtimeCancelQueueOptions)],
    ]);
    const manager = runtimeQueueManager(queues);

    await expect(reconcileRuntimeQueues(manager, { allowPolicyRecreate: false }))
      .rejects.toThrow(`RUNTIME_QUEUE_POLICY_RECREATE_REQUIRED:${runtimeExecuteQueue}`);
    expect(manager.deleteQueue).not.toHaveBeenCalled();
  });

  it("recreates an empty drifted policy only with explicit authorization", async () => {
    const queues = new Map<string, unknown>([
      [runtimeExecuteQueue, runtimeQueue(runtimeExecuteQueue, {
        ...runtimeExecuteQueueOptions,
        policy: "standard",
      })],
      [runtimeCancelQueue, runtimeQueue(runtimeCancelQueue, runtimeCancelQueueOptions)],
    ]);
    const manager = runtimeQueueManager(queues);

    await expect(reconcileRuntimeQueues(manager, { allowPolicyRecreate: true }))
      .resolves.toBeUndefined();
    expect(manager.deleteQueue).toHaveBeenCalledWith(runtimeExecuteQueue);
    expect(manager.createQueue).toHaveBeenCalledWith(runtimeExecuteQueue, runtimeExecuteQueueOptions);
  });

  it("pins file extraction retry and expiration semantics for every service", () => {
    expect(fileExtractQueue).toBe("file.extract");
    expect(fileExtractQueueOptions).toEqual({
      policy: "short",
      retryLimit: 5,
      retryDelay: 2,
      retryBackoff: true,
      retryDelayMax: 60,
      expireInSeconds: 720,
      heartbeatSeconds: 30,
      deleteAfterSeconds: 604_800,
      notify: true,
    });
  });

  it("pins one queued-or-active Knowledge build per release and validates persisted queue drift", () => {
    expect(knowledgeReleaseBuildQueue).toBe("knowledge.release.build");
    expect(knowledgeReleaseBuildQueueOptions).toEqual({
      policy: "exclusive",
      retryLimit: 5,
      retryDelay: 5,
      retryBackoff: true,
      retryDelayMax: 120,
      expireInSeconds: 1_200,
      heartbeatSeconds: 30,
      deleteAfterSeconds: 604_800,
      notify: true,
    });
    expect(knowledgeReleaseBuildJobSchema.parse({ releaseId: "release_1" }))
      .toEqual({ releaseId: "release_1" });
    expect(() => knowledgeReleaseBuildJobSchema.parse({ releaseId: "release_1", profileId: "forged" }))
      .toThrow();

    const persisted = {
      name: knowledgeReleaseBuildQueue,
      ...knowledgeReleaseBuildQueueOptions,
      queuedCount: 0,
    };
    expect(() => assertKnowledgeReleaseBuildQueueConfiguration(persisted)).not.toThrow();
    expect(() => assertKnowledgeReleaseBuildQueueConfiguration({ ...persisted, policy: "short" }))
      .toThrow("KNOWLEDGE_RELEASE_QUEUE_CONFIGURATION_MISMATCH:policy");
    expect(() => assertKnowledgeReleaseBuildQueueConfiguration({ ...persisted, retryLimit: 4 }))
      .toThrow("KNOWLEDGE_RELEASE_QUEUE_CONFIGURATION_MISMATCH:retryLimit");
  });

  it("pins external Import Source processing to one job identity per source", () => {
    expect(importSourceProcessQueue).toBe("import.source.process");
    expect(importSourceProcessQueueOptions).toEqual({
      policy: "short",
      retryLimit: 0,
      retryDelay: 5,
      retryBackoff: true,
      retryDelayMax: 300,
      expireInSeconds: 1_200,
      heartbeatSeconds: 30,
      deleteAfterSeconds: 604_800,
      notify: true,
    });

    const job = {
      sourceId: "source_1",
      projectId: "project_1",
      requestHash: "a".repeat(64),
    };
    expect(importSourceProcessJobSchema.parse(job)).toEqual(job);
    expect(importSourceProcessJobOptions(job)).toEqual({ singletonKey: "source_1" });
    expect(importSourceProcessJobSchema.safeParse({ ...job, requestHash: "not-a-digest" }).success)
      .toBe(false);
    expect(importSourceProcessJobSchema.safeParse({ ...job, sourceUrl: "https://example.com" }).success)
      .toBe(false);

    const persisted = { name: importSourceProcessQueue, ...importSourceProcessQueueOptions };
    expect(() => assertImportSourceProcessQueueConfiguration(persisted)).not.toThrow();
    expect(() => assertImportSourceProcessQueueConfiguration({ ...persisted, retryLimit: 1 }))
      .toThrow("IMPORT_SOURCE_PROCESS_QUEUE_CONFIGURATION_MISMATCH:retryLimit");
    expect(() => assertImportSourceProcessQueueConfiguration({ ...persisted, expireInSeconds: 60 }))
      .toThrow("IMPORT_SOURCE_PROCESS_QUEUE_CONFIGURATION_MISMATCH:expireInSeconds");
  });
});

function runtimeQueue(name: string, options: object) {
  return {
    name,
    ...options,
    deferredCount: 0,
    queuedCount: 0,
    readyCount: 0,
    activeCount: 0,
    failedCount: 0,
    totalCount: 0,
  };
}

function runtimeQueueManager(queues: Map<string, unknown>) {
  return {
    createQueue: vi.fn(async (name: string, options: object) => {
      queues.set(name, runtimeQueue(name, options));
    }),
    deleteQueue: vi.fn(async (name: string) => {
      queues.delete(name);
    }),
    getQueue: vi.fn(async (name: string) => queues.get(name) ?? null),
    updateQueue: vi.fn(async (name: string, options: object) => {
      const current = queues.get(name) as Record<string, unknown>;
      queues.set(name, { ...current, ...options });
    }),
  };
}
