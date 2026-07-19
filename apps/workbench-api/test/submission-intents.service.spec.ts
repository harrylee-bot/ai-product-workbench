import { runtimeModelCatalogUnavailableProblem } from "../src/common/problem-details.js";
import { SubmissionIntentsService } from "../src/modules/submission-intents/submission-intents.service.js";

const now = new Date("2026-07-15T00:00:00.000Z");
const request = {
  prompt: "Build a product dashboard",
  modelId: "quality",
  workflow: "generate" as const,
  generationIntent: null,
  targetSurface: "web" as const,
  designStyle: { kind: "automatic" as const },
  artifactTargets: [],
  requestedArtifactKinds: [],
};

function intentRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "intent_1",
    projectId: "project_1",
    threadId: "thread_1",
    createdById: "principal_1",
    status: "pending" as const,
    request,
    requestHash: "a".repeat(64),
    idempotencyKey: "intent:key:12345678",
    runIdempotencyKey: "intent:run:12345678",
    runId: null,
    lastFailureCode: null,
    lastFailureDetail: null,
    lastFailureRetryable: null,
    revision: 0,
    submittedAt: null,
    cancelledAt: null,
    createdAt: now,
    updatedAt: now,
    attachments: [],
    ...overrides,
  };
}

function dependencies() {
  const db = {
    submissionIntent: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
    $transaction: vi.fn(),
  };
  const access = {
    findThread: vi.fn().mockResolvedValue({
      id: "thread_1",
      projectId: "project_1",
      project: { id: "project_1", workspaceId: "workspace_1" },
    }),
  };
  const runs = {
    start: vi.fn(),
    get: vi.fn(),
  };
  const runtimeModels = { assertAvailable: vi.fn().mockResolvedValue(undefined) };
  const importSources = {
    materializeSubmissionFileSource: vi.fn().mockResolvedValue("source_file_1"),
  };
  return {
    db,
    access,
    runs,
    runtimeModels,
    importSources,
    service: new SubmissionIntentsService(
      db as never,
      access as never,
      runs as never,
      runtimeModels as never,
      importSources as never,
    ),
  };
}

describe("SubmissionIntentsService", () => {
  it("rejects ambiguous Generate targets before touching persistence", async () => {
    const harness = dependencies();

    await expect(harness.service.create(
      "principal_1",
      "thread_1",
      "intent:create:12345678",
      {
        request: {
          ...request,
          artifactTargets: [{
            artifactId: "artifact_source",
            artifactVersionId: "version_source",
            screenIds: [],
          }],
        },
        attachments: [],
      },
    )).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ path: ["request", "requestedArtifactKinds"] }),
        expect.objectContaining({ path: ["request", "artifactTargets", 0, "screenIds"] }),
      ]),
    });
    expect(harness.access.findThread).not.toHaveBeenCalled();
    expect(harness.db.$transaction).not.toHaveBeenCalled();
    expect(harness.runtimeModels.assertAvailable).not.toHaveBeenCalled();
  });

  it("returns a strict null item for a Thread without an active intent", async () => {
    const harness = dependencies();
    harness.db.submissionIntent.findFirst.mockResolvedValue(null);

    await expect(harness.service.current("principal_1", "thread_1"))
      .resolves.toEqual({ item: null });
    expect(harness.access.findThread).toHaveBeenCalledWith("principal_1", "thread_1", "read");
    expect(harness.db.submissionIntent.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        threadId: "thread_1",
        createdById: "principal_1",
        status: { in: ["pending", "submitting"] },
      },
    }));
  });

  it("rejects an unknown existing File before persisting an intent", async () => {
    const harness = dependencies();
    harness.db.submissionIntent.findUnique.mockResolvedValue(null);
    harness.db.submissionIntent.findFirst.mockResolvedValue(null);
    const tx = {
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([{ id: "project_1", revision: 0 }])
        .mockResolvedValueOnce([{ projectId: "project_1", status: "active" }])
        .mockResolvedValueOnce([]),
      projectMember: { findUnique: vi.fn().mockResolvedValue({ role: "editor" }) },
      submissionIntent: {
        findUnique: vi.fn().mockResolvedValue(null),
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn(),
      },
      submissionIntentAttachment: { createMany: vi.fn() },
    };
    harness.db.$transaction.mockImplementation(
      async (callback: (client: typeof tx) => unknown) => callback(tx),
    );

    await expect(harness.service.create(
      "principal_1",
      "thread_1",
      "intent:create:12345678",
      {
        request,
        attachments: [{ kind: "existing", fileAssetId: "file_missing" }],
      },
    )).rejects.toMatchObject({ status: 404 });
    expect(harness.runtimeModels.assertAvailable).toHaveBeenCalledWith("quality", "generate");
    expect(tx.submissionIntent.create).not.toHaveBeenCalled();
  });

  it("resets a failed start to pending with a bounded public failure snapshot", async () => {
    const harness = dependencies();
    let current = intentRecord({
      attachments: [{
        position: 0,
        kind: "upload" as const,
        fileAssetId: "file_1",
        clientFingerprint: "submission-file:slot_1",
        fileName: "中文 需求稿.pdf",
        declaredMediaType: "application/pdf",
        byteSize: 1_024n,
        lastModified: 1_786_771_200_000n,
        file: { status: "ready" as const },
      }],
    });
    harness.db.submissionIntent.findFirst.mockResolvedValue(current);
    const tx = {
      $queryRaw: vi.fn().mockImplementation(async () => {
        const call = tx.$queryRaw.mock.calls.length;
        if (call === 1) return [{ id: "project_1", revision: 0 }];
        if (call === 3) return [{ id: "file_1", status: "ready" }];
        return [{ id: "intent_1" }];
      }),
      projectMember: { findUnique: vi.fn().mockResolvedValue({ role: "editor" }) },
      submissionIntent: {
        findUnique: vi.fn().mockImplementation(async () => current),
        findUniqueOrThrow: vi.fn().mockImplementation(async () => current),
        updateMany: vi.fn().mockImplementation(async () => {
          current = { ...current, status: "submitting" as const, revision: current.revision + 1 };
          return { count: 1 };
        }),
        update: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
          current = {
            ...current,
            status: "pending" as const,
            lastFailureCode: data.lastFailureCode as string,
            lastFailureDetail: data.lastFailureDetail as string,
            lastFailureRetryable: data.lastFailureRetryable as boolean,
            revision: current.revision + 1,
          };
          return current;
        }),
      },
    };
    harness.db.$transaction.mockImplementation(
      async (callback: (client: typeof tx) => unknown) => callback(tx),
    );
    harness.runs.start.mockRejectedValue(runtimeModelCatalogUnavailableProblem());

    await expect(harness.service.submit("principal_1", "intent_1"))
      .rejects.toMatchObject({ status: 502 });
    expect(harness.runs.start).toHaveBeenCalledWith(
      "principal_1",
      "thread_1",
      "intent:run:12345678",
      { ...request, sourceIds: ["source_file_1"], canvasSnapshot: null },
    );
    expect(harness.importSources.materializeSubmissionFileSource).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        principalId: "principal_1",
        projectId: "project_1",
        submissionIntentId: "intent_1",
        position: 0,
        fileAssetId: "file_1",
      }),
    );
    expect(current).toMatchObject({
      status: "pending",
      lastFailureCode: "RUNTIME_MODEL_CATALOG_UNAVAILABLE",
      lastFailureDetail: "The runtime model catalog could not be loaded",
      lastFailureRetryable: true,
      revision: 2,
    });
    expect(current).not.toHaveProperty("stack");
  });

  it("recovers a crashed submitting claim when its upload slot is still unlinked", async () => {
    const harness = dependencies();
    let current = intentRecord({
      status: "submitting" as const,
      revision: 1,
      attachments: [{
        position: 0,
        kind: "upload" as const,
        fileAssetId: null,
        clientFingerprint: "submission-file:slot_1",
        fileName: "pending.pdf",
        declaredMediaType: "application/pdf",
        byteSize: 1_024n,
        lastModified: 0n,
        file: null,
      }],
    });
    harness.db.submissionIntent.findFirst.mockResolvedValue(current);
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "intent_1" }]),
      projectMember: { findUnique: vi.fn().mockResolvedValue({ role: "editor" }) },
      submissionIntent: {
        findUnique: vi.fn().mockImplementation(async () => current),
        update: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
          current = {
            ...current,
            status: "pending" as const,
            lastFailureCode: data.lastFailureCode as string,
            lastFailureDetail: data.lastFailureDetail as string,
            lastFailureRetryable: data.lastFailureRetryable as boolean,
            revision: current.revision + 1,
          };
          return current;
        }),
      },
    };
    harness.db.$transaction.mockImplementation(
      async (callback: (client: typeof tx) => unknown) => callback(tx),
    );

    await expect(harness.service.submit("principal_1", "intent_1"))
      .rejects.toMatchObject({
        status: 409,
        response: expect.objectContaining({ code: "SUBMISSION_INTENT_ATTACHMENTS_INCOMPLETE" }),
      });
    expect(harness.runs.start).not.toHaveBeenCalled();
    expect(current).toMatchObject({
      status: "pending",
      lastFailureCode: "SUBMISSION_INTENT_ATTACHMENTS_INCOMPLETE",
      lastFailureRetryable: true,
      revision: 2,
    });
  });
});
