import { hashRequest } from "../src/common/idempotency.js";
import {
  notFoundProblem,
  runtimeModelCatalogTimeoutProblem,
  runtimeModelCatalogUnavailableProblem,
  runtimeModelNotFoundProblem,
} from "../src/common/problem-details.js";
import { RunsService } from "../src/modules/runs/runs.service.js";
import { createHash } from "node:crypto";
import {
  canonicalJson,
  prdDocumentV2Example,
} from "@workbench/workbench-contracts";

const now = new Date("2026-07-12T00:00:00.000Z");
const designSystemContent = {
  protocol: "workbench.design-system.v1" as const,
  documentId: "design-main",
  title: "Product UI",
  tokens: [],
  assets: [],
  principles: [],
  guidelines: [],
  components: [],
};
const designSystemChecksum = createHash("sha256").update(canonicalJson(designSystemContent)).digest("hex");
const targetPrototypeContent = {
  protocol: "workbench.prototype.v1" as const,
  documentId: "target-prototype",
  title: "Target Prototype",
  revision: 1,
  screens: [{
    id: "screen-home",
    name: "Home",
    route: "/",
    rootNodeId: "root-home",
    initialStateId: null,
    viewport: { width: 390, height: 844 },
  }],
  nodes: [{
    id: "root-home",
    screenId: "screen-home",
    parentId: null,
    name: "Home",
    kind: "frame" as const,
    visible: true,
    layout: {
      mode: "absolute" as const,
      x: { kind: "literal" as const, value: 0 },
      y: { kind: "literal" as const, value: 0 },
      width: { kind: "literal" as const, value: 390 },
      height: { kind: "literal" as const, value: 844 },
      display: "block" as const,
      direction: "column" as const,
      gap: { kind: "literal" as const, value: 0 },
      padding: {
        top: { kind: "literal" as const, value: 0 },
        right: { kind: "literal" as const, value: 0 },
        bottom: { kind: "literal" as const, value: 0 },
        left: { kind: "literal" as const, value: 0 },
      },
      align: "stretch" as const,
      justify: "start" as const,
      gridColumns: null,
      overflow: "hidden" as const,
    },
    style: {
      opacity: 1,
      rotation: 0,
      transformOrigin: { x: 0.5, y: 0.5 },
      fill: null,
      stroke: null,
      radii: {
        topLeft: { kind: "literal" as const, value: 0 },
        topRight: { kind: "literal" as const, value: 0 },
        bottomRight: { kind: "literal" as const, value: 0 },
        bottomLeft: { kind: "literal" as const, value: 0 },
      },
      shadowTokenIds: [],
      typography: null,
    },
    actionIds: [],
    bindingIds: [],
    motionIds: [],
    childIds: [],
    clipContent: true,
  }],
  tokens: [],
  assets: [],
  variables: [],
  states: [],
  actions: [],
  bindings: [],
  motions: [],
};
const request = {
  prompt: "Use both sources",
  modelId: "quality",
  workflow: "generate" as const,
  generationIntent: null,
  targetSurface: "app" as const,
  designStyle: { kind: "automatic" as const },
  sourceIds: ["source_2", "source_1"],
  artifactTargets: [],
  requestedArtifactKinds: ["prd" as const],
  canvasSnapshot: null,
};

function canvasSnapshot() {
  const capturedAt = new Date();
  const reference = {
    boardNodeId: "board-node-home",
    artifactId: "artifact-prototype-1",
    artifactVersionId: "version-prototype-1",
    screenId: "screen-home",
  };
  return {
    protocol: "workbench.canvas-snapshot.v1" as const,
    projectId: "project_1",
    threadId: "thread_1",
    runId: null,
    boardId: "board_1",
    clientSessionId: "canvas-session-1",
    projectSessionGeneration: 1,
    boardRevision: 7,
    canvasStateRevision: 3,
    capturedAt: capturedAt.toISOString(),
    expiresAt: new Date(capturedAt.getTime() + 60_000).toISOString(),
    viewport: { x: 120, y: 80, zoom: 1.25 },
    screens: [{
      reference,
      name: "Home",
      route: "/",
      phase: "complete" as const,
      viewport: { width: 390, height: 844 },
    }],
    visibleScreens: [reference],
    selectedScreens: [reference],
  };
}

function persistedRun(overrides: Record<string, unknown> = {}) {
  return {
    id: "run_1",
    requestId: "request_1",
    projectId: "project_1",
    threadId: "thread_1",
    retryOfRunId: null,
    createdById: "principal_1",
    knowledgeReleaseId: null,
    idempotencyKey: "run:key:12345678",
    requestHash: hashRequest(request),
    designStyleSnapshotSha256: null,
    request,
    status: "queued" as const,
    phase: null,
    phaseLabel: null,
    progress: null,
    modelId: "quality",
    traceId: "trace_1",
    attempt: 0,
    eventSequence: 1,
    cancelRequestedAt: null,
    startedAt: null,
    finishedAt: null,
    errorCode: null,
    errorDetail: null,
    errorRetryable: null,
    cancellationReason: null,
    outputEntryId: null,
    createdAt: now,
    updatedAt: now,
    sourceSnapshots: [sourceSnapshot("source_2", "file_2", "blob_2", 0), sourceSnapshot("source_1", "file_1", "blob_1", 1)],
    ...overrides,
  };
}

function sourceSnapshot(sourceId: string, fileAssetId: string, blobId: string, position: number) {
  const checksum = position === 0 ? "a".repeat(64) : "b".repeat(64);
  return {
    id: `run_source_${position}`,
    runId: "run_1",
    projectId: "project_1",
    position,
    sourceId,
    kind: "file" as const,
    label: `${fileAssetId}.pdf`,
    checksum,
    descriptor: {
      kind: "file",
      fileAssetId,
      originalName: `${fileAssetId}.pdf`,
      mediaType: "application/pdf",
    },
    snapshot: {
      protocol: "workbench.import-source-snapshot.v1",
      sourceRevision: 1,
      checksum,
      blobs: [{
        position: 0,
        blobId,
        role: "primary",
        path: null,
        mediaType: "application/pdf",
        byteSize: 100 + position,
        sha256: checksum,
      }],
    },
    createdAt: now,
  };
}

function readySource(sourceId: string, fileAssetId: string, blobId: string, position: number) {
  const checksum = position === 0 ? "a".repeat(64) : "b".repeat(64);
  return {
    id: sourceId,
    projectId: "project_1",
    kind: "file" as const,
    status: "ready" as const,
    deletedAt: null,
    label: `${fileAssetId}.pdf`,
    descriptor: {
      kind: "file",
      fileAssetId,
      originalName: `${fileAssetId}.pdf`,
      mediaType: "application/pdf",
    },
    checksum,
    revision: 1,
    blobs: [{
      position: 0,
      blobId,
      role: "primary",
      path: null,
      mediaType: "application/pdf",
      byteSize: 100n + BigInt(position),
      sha256: checksum,
      blob: {
        status: "ready" as const,
        deletedAt: null,
      },
    }],
  };
}

function createHarness(options: {
  lockedSources?: Array<{ id: string }>;
  sources?: ReturnType<typeof readySource>[];
  existing?: ReturnType<typeof persistedRun> | null;
  designStyleVersions?: Array<{
    id: string;
    artifactId: string;
    status: string;
    kind: string;
    schemaVersion: number;
    checksum: string;
  }>;
  targetVersions?: Array<{
    artifactId: string;
    content: unknown;
    contentBlobId: string | null;
    id: string;
    kind: string;
    schemaVersion: number;
  }>;
  runtimeModels?: { assertAvailable: ReturnType<typeof vi.fn> };
} = {}) {
  const sources = options.sources ?? [
    readySource("source_1", "file_1", "blob_1", 1),
    readySource("source_2", "file_2", "blob_2", 0),
  ];
  const lockedSources = options.lockedSources ?? [
    { id: "source_1" },
    { id: "source_2" },
  ];
  const created = persistedRun({ sourceSnapshots: [] });
  let createdRetryOfRunId: string | null = null;
  let createdRequest: Record<string, unknown> = request;
  const tx = {
    $queryRaw: vi.fn().mockImplementation(async (query) => {
      const sql = query?.strings?.join(" ") ?? "";
      if (sql.includes('FROM "projects"')) return [{ id: "project_1", revision: 0 }];
      if (sql.includes('FROM "threads"')) return [{ status: "active" }];
      if (sql.includes('FROM "import_sources"')) return lockedSources;
      if (sql.includes('FROM "artifact_versions"')) {
        return options.targetVersions ?? options.designStyleVersions ?? [];
      }
      return [];
    }),
    run: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async ({ data }: { data: {
        request?: Record<string, unknown>;
        retryOfRunId?: string | null;
      } }) => {
        createdRetryOfRunId = data.retryOfRunId ?? null;
        createdRequest = data.request ?? request;
        return {
          ...created,
          id: createdRetryOfRunId ? "run_retry_1" : created.id,
          retryOfRunId: createdRetryOfRunId,
        };
      }),
      findUniqueOrThrow: vi.fn().mockImplementation(async () => {
        const runId = createdRetryOfRunId ? "run_retry_1" : "run_1";
        return persistedRun({
          id: runId,
          retryOfRunId: createdRetryOfRunId,
          request: createdRequest,
          sourceSnapshots: [
            { ...sourceSnapshot("source_2", "file_2", "blob_2", 0), id: `run_source_${runId}_0`, runId },
            { ...sourceSnapshot("source_1", "file_1", "blob_1", 1), id: `run_source_${runId}_1`, runId },
          ],
        });
      }),
    },
    projectMember: { findUnique: vi.fn().mockResolvedValue({ role: "owner" }) },
    importSource: { findMany: vi.fn().mockResolvedValue(sources) },
    runSourceSnapshot: {
      createMany: vi.fn().mockResolvedValue({ count: 2 }),
      findMany: vi.fn().mockResolvedValue([
        sourceSnapshot("source_2", "file_2", "blob_2", 0),
        sourceSnapshot("source_1", "file_1", "blob_1", 1),
      ]),
    },
    artifactVersion: {
      findUnique: vi.fn().mockImplementation(({ where }) => (
        where.id === "version_style_1"
          ? {
              id: "version_style_1",
              artifactId: "artifact_style_1",
              projectId: "project_1",
              content: designSystemContent,
              contentBlobId: null,
              assets: [],
            }
          : null
      )),
    },
    board: {
      findUnique: vi.fn().mockResolvedValue({
        id: "board_1",
        revision: 7,
        nodes: [{
          nodeKey: "board-node-home",
          artifactId: "artifact-prototype-1",
          artifactVersionId: "version-prototype-1",
          data: { screenId: "screen-home" },
        }],
      }),
    },
    knowledgeRelease: { findFirst: vi.fn().mockResolvedValue(null) },
    thread: { update: vi.fn().mockResolvedValue({ entrySequence: 1 }) },
    threadEntry: { create: vi.fn().mockResolvedValue({ id: "entry_1" }) },
  };
  const db = {
    run: { findUnique: vi.fn().mockResolvedValue(options.existing ?? null) },
    $transaction: vi.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  const access = {
    findThread: vi.fn().mockResolvedValue({
      id: "thread_1",
      projectId: "project_1",
      project: { id: "project_1", workspaceId: "workspace_1" },
    }),
    findRun: vi.fn().mockResolvedValue(persistedRun({
      status: "failed",
      errorCode: "RUNTIME_UNAVAILABLE",
      errorDetail: "Runtime temporarily unavailable",
      errorRetryable: true,
      finishedAt: now,
    })),
  };
  const events = { append: vi.fn().mockResolvedValue({}) };
  const queue = { sendInTransaction: vi.fn().mockResolvedValue("job_1") };
  const runtimeModels = options.runtimeModels ?? {
    assertAvailable: vi.fn().mockResolvedValue(undefined),
  };
  return {
    service: new RunsService(
      db as never,
      access as never,
      events as never,
      queue as never,
      runtimeModels as never,
      { resolve: vi.fn() } as never,
    ),
    access,
    db,
    tx,
    events,
    queue,
    runtimeModels,
  };
}

describe("Run model catalog validation", () => {
  it("rejects an unknown model before opening the write transaction", async () => {
    const runtimeModels = { assertAvailable: vi.fn().mockRejectedValue(runtimeModelNotFoundProblem()) };
    const harness = createHarness({ runtimeModels });

    await expect(harness.service.start(
      "principal_1",
      "thread_1",
      "run:model:unknown:12345678",
      { ...request, modelId: "invented-model" },
    )).rejects.toMatchObject({
      status: 400,
      response: expect.objectContaining({ code: "RUNTIME_MODEL_NOT_FOUND" }),
    });
    expect(harness.access.findThread).toHaveBeenCalledWith("principal_1", "thread_1", "edit");
    expect(runtimeModels.assertAvailable).toHaveBeenCalledWith("invented-model", "generate");
    expect(runtimeModels.assertAvailable).toHaveBeenCalledAfter(harness.db.run.findUnique);
    expect(harness.db.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    ["unavailable", runtimeModelCatalogUnavailableProblem(), 502, "RUNTIME_MODEL_CATALOG_UNAVAILABLE"],
    ["timeout", runtimeModelCatalogTimeoutProblem(), 504, "RUNTIME_MODEL_CATALOG_TIMEOUT"],
  ])("fails closed when the model catalog is %s", async (_label, problem, status, code) => {
    const runtimeModels = { assertAvailable: vi.fn().mockRejectedValue(problem) };
    const harness = createHarness({ runtimeModels });

    await expect(harness.service.start(
      "principal_1",
      "thread_1",
      `run:model:${_label}:12345678`,
      request,
    )).rejects.toMatchObject({
      status,
      response: expect.objectContaining({ code }),
    });
    expect(harness.db.$transaction).not.toHaveBeenCalled();
  });

  it("does not let a principal without edit access probe the model catalog", async () => {
    const harness = createHarness();
    harness.access.findThread = vi.fn().mockRejectedValue(notFoundProblem("Thread"));

    await expect(harness.service.start(
      "principal_without_access",
      "thread_1",
      "run:model:private:12345678",
      { ...request, modelId: "probe-model" },
    )).rejects.toMatchObject({ status: 404 });
    expect(harness.db.run.findUnique).not.toHaveBeenCalled();
    expect(harness.runtimeModels.assertAvailable).not.toHaveBeenCalled();
    expect(harness.db.$transaction).not.toHaveBeenCalled();
  });

  it("replays an authorized idempotent Run without consulting an unavailable catalog", async () => {
    const runtimeModels = {
      assertAvailable: vi.fn().mockRejectedValue(runtimeModelCatalogUnavailableProblem()),
    };
    const harness = createHarness({ existing: persistedRun(), runtimeModels });

    await expect(harness.service.start(
      "principal_1",
      "thread_1",
      "run:key:12345678",
      request,
    )).resolves.toMatchObject({ id: "run_1", modelId: "quality" });
    expect(harness.access.findThread).toHaveBeenCalledWith("principal_1", "thread_1", "edit");
    expect(runtimeModels.assertAvailable).not.toHaveBeenCalled();
    expect(harness.db.$transaction).not.toHaveBeenCalled();
  });

  it("validates the persisted source model for a new retry but skips it for retry replay", async () => {
    const removedModels = {
      assertAvailable: vi.fn().mockRejectedValue(runtimeModelNotFoundProblem()),
    };
    const removed = createHarness({ runtimeModels: removedModels });
    await expect(removed.service.retry(
      "principal_1",
      "run_1",
      "retry:model:removed:12345678",
    )).rejects.toMatchObject({
      status: 400,
      response: expect.objectContaining({ code: "RUNTIME_MODEL_NOT_FOUND" }),
    });
    expect(removedModels.assertAvailable).toHaveBeenCalledWith("quality", "generate");
    expect(removed.db.$transaction).not.toHaveBeenCalled();

    const fresh = createHarness();
    await fresh.service.retry("principal_1", "run_1", "retry:model:fresh:12345678");
    expect(fresh.runtimeModels.assertAvailable).toHaveBeenCalledWith("quality", "generate");
    expect(fresh.db.$transaction).toHaveBeenCalledAfter(fresh.runtimeModels.assertAvailable);

    const runtimeModels = {
      assertAvailable: vi.fn().mockRejectedValue(runtimeModelCatalogUnavailableProblem()),
    };
    const replay = createHarness({
      existing: persistedRun({
        id: "run_retry_1",
        retryOfRunId: "run_1",
        sourceSnapshots: [
          { ...sourceSnapshot("source_2", "file_2", "blob_2", 0), id: "run_source_run_retry_1_0", runId: "run_retry_1" },
          { ...sourceSnapshot("source_1", "file_1", "blob_1", 1), id: "run_source_run_retry_1_1", runId: "run_retry_1" },
        ],
      }),
      runtimeModels,
    });
    await expect(replay.service.retry(
      "principal_1",
      "run_1",
      "retry:model:replay:12345678",
    )).resolves.toMatchObject({ id: "run_retry_1", retryOfRunId: "run_1" });
    expect(runtimeModels.assertAvailable).not.toHaveBeenCalled();
    expect(replay.db.$transaction).not.toHaveBeenCalled();
  });
});

describe("Run immutable Import Source snapshots", () => {
  it("creates a retry from the persisted source request and records its lineage", async () => {
    const harness = createHarness();

    const retry = await harness.service.retry(
      "principal_1",
      "run_1",
      "retry:key:12345678",
    );

    expect(harness.tx.run.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        retryOfRunId: "run_1",
        request,
        modelId: request.modelId,
      }),
    });
    expect(retry.retryOfRunId).toBe("run_1");
  });

  it("preserves the immutable Canvas snapshot when creating a retry", async () => {
    const snapshot = canvasSnapshot();
    const sourceRequest = { ...request, canvasSnapshot: snapshot };
    const harness = createHarness();
    harness.access.findRun = vi.fn().mockResolvedValue(persistedRun({
      request: sourceRequest,
      status: "failed",
      errorCode: "RUNTIME_UNAVAILABLE",
      errorDetail: "Runtime temporarily unavailable",
      errorRetryable: true,
      finishedAt: now,
    }));

    await harness.service.retry(
      "principal_1",
      "run_1",
      "retry:canvas-snapshot:12345678",
    );

    expect(harness.tx.board.findUnique).toHaveBeenCalledWith({
      where: { projectId: "project_1" },
      include: { nodes: true },
    });
    expect(harness.tx.run.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        retryOfRunId: "run_1",
        request: sourceRequest,
      }),
    });
  });

  it("rejects replaying a Canvas snapshot over a newer Board revision", async () => {
    const snapshot = canvasSnapshot();
    const harness = createHarness();
    harness.access.findRun = vi.fn().mockResolvedValue(persistedRun({
      request: { ...request, canvasSnapshot: snapshot },
      status: "failed",
      errorCode: "RUNTIME_UNAVAILABLE",
      errorDetail: "Runtime temporarily unavailable",
      errorRetryable: true,
      finishedAt: now,
    }));
    harness.tx.board.findUnique = vi.fn().mockResolvedValue({
      id: "board_1",
      revision: snapshot.boardRevision + 1,
      nodes: [],
    });

    await expect(harness.service.retry(
      "principal_1",
      "run_1",
      "retry:canvas-revision:12345678",
    )).rejects.toMatchObject({
      status: 412,
      response: expect.objectContaining({ code: "REVISION_MISMATCH" }),
    });
    expect(harness.tx.run.create).not.toHaveBeenCalled();
  });

  it("rejects retry for a source failure that the server marked terminal", async () => {
    const harness = createHarness();
    harness.access.findRun = vi.fn().mockResolvedValue(persistedRun({
      status: "failed",
      errorCode: "INVALID_OUTPUT",
      errorDetail: "Invalid output",
      errorRetryable: false,
      finishedAt: now,
    }));

    await expect(harness.service.retry(
      "principal_1",
      "run_1",
      "retry:key:12345678",
    )).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: "RUN_RETRY_NOT_ALLOWED" }),
    });
    expect(harness.tx.run.create).not.toHaveBeenCalled();
  });

  it("locks ready Import Sources and snapshots their manifests in request order before queueing", async () => {
    const harness = createHarness();

    const run = await harness.service.start(
      "principal_1",
      "thread_1",
      "run:key:12345678",
      request,
    );

    expect(run.sources.map(({ sourceId, position }) => ({ sourceId, position }))).toEqual([
      { sourceId: "source_2", position: 0 },
      { sourceId: "source_1", position: 1 },
    ]);
    expect(run).toMatchObject({
      workflow: "generate",
      targetSurface: "app",
      designStyle: { kind: "automatic" },
    });
    expect(harness.runtimeModels.assertAvailable).toHaveBeenCalledWith("quality", "generate");
    expect(harness.runtimeModels.assertAvailable).toHaveBeenCalledAfter(harness.db.run.findUnique);
    expect(harness.db.$transaction).toHaveBeenCalledAfter(harness.runtimeModels.assertAvailable);
    expect(harness.tx.run.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ designStyleArtifactVersionId: null }),
    });
    expect(harness.tx.runSourceSnapshot.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ sourceId: "source_2", position: 0, kind: "file" }),
        expect.objectContaining({ sourceId: "source_1", position: 1, kind: "file" }),
      ],
    });
    expect(harness.events.append).toHaveBeenCalledWith(
      harness.tx,
      "run_1",
      "run.queued",
      { position: null },
    );
    expect(harness.queue.sendInTransaction).toHaveBeenCalledAfter(
      harness.tx.runSourceSnapshot.createMany,
    );
  });

  it("rejects selected Import Sources that materialize more than fifty runtime blobs", async () => {
    const expand = (source: ReturnType<typeof readySource>, count: number) => ({
      ...source,
      blobs: Array.from({ length: count }, (_, position) => ({
        ...source.blobs[0]!,
        position,
        blobId: `${source.id}_blob_${position}`,
        path: `${source.id}/${position}.txt`,
        byteSize: 1n,
      })),
    });
    const harness = createHarness({
      sources: [
        expand(readySource("source_1", "file_1", "blob_1", 1), 25),
        expand(readySource("source_2", "file_2", "blob_2", 0), 26),
      ],
    });

    await expect(harness.service.start(
      "principal_1",
      "thread_1",
      "run:key:12345678",
      request,
    )).rejects.toMatchObject({
      status: 400,
      response: expect.objectContaining({ code: "VALIDATION_ERROR" }),
    });
    expect(harness.tx.run.create).not.toHaveBeenCalled();
    expect(harness.tx.runSourceSnapshot.createMany).not.toHaveBeenCalled();
    expect(harness.queue.sendInTransaction).not.toHaveBeenCalled();
  });

  it("returns the same conflict for missing and cross-project source ids without writes", async () => {
    const harness = createHarness({
      lockedSources: [{ id: "source_1" }],
    });

    await expect(harness.service.start(
      "principal_1",
      "thread_1",
      "run:key:12345678",
      request,
    )).rejects.toMatchObject({ status: 409, response: expect.objectContaining({ code: "RUN_IMPORT_SOURCE_NOT_READY" }) });
    expect(harness.tx.run.create).not.toHaveBeenCalled();
    expect(harness.tx.runSourceSnapshot.createMany).not.toHaveBeenCalled();
    expect(harness.queue.sendInTransaction).not.toHaveBeenCalled();
  });

  it("rejects a visible but non-ready Import Source with a stable conflict", async () => {
    const harness = createHarness({
      lockedSources: [{ id: "source_2" }],
      sources: [{ ...readySource("source_2", "file_2", "blob_2", 0), status: "pending" as const }],
    });
    const oneSource = { ...request, sourceIds: ["source_2"] };

    await expect(harness.service.start(
      "principal_1",
      "thread_1",
      "run:key:12345678",
      oneSource,
    )).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: "RUN_IMPORT_SOURCE_NOT_READY" }),
    });
    expect(harness.tx.run.create).not.toHaveBeenCalled();
  });

  it("requires every source blob to remain ready and undeleted", async () => {
    const harness = createHarness({
      lockedSources: [{ id: "source_2" }],
      sources: [{
        ...readySource("source_2", "file_2", "blob_2", 0),
        blobs: [{
          ...readySource("source_2", "file_2", "blob_2", 0).blobs[0]!,
          blob: { status: "deleted" as const, deletedAt: now },
        }],
      }],
    });

    await expect(harness.service.start(
      "principal_1",
      "thread_1",
      "run:key:12345678",
      { ...request, sourceIds: ["source_2"] },
    )).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: "RUN_IMPORT_SOURCE_NOT_READY" }),
    });
    expect(harness.tx.runSourceSnapshot.createMany).not.toHaveBeenCalled();
  });

  it("replays the original snapshots and rejects changed source ordering", async () => {
    const existing = persistedRun();
    const replay = createHarness({ existing });

    await expect(replay.service.start(
      "principal_1",
      "thread_1",
      "run:key:12345678",
      request,
    )).resolves.toMatchObject({
      id: "run_1",
      sources: [{ sourceId: "source_2" }, { sourceId: "source_1" }],
    });
    expect(replay.db.$transaction).not.toHaveBeenCalled();

    await expect(replay.service.start(
      "principal_1",
      "thread_1",
      "run:key:12345678",
      { ...request, sourceIds: [...request.sourceIds].reverse() },
    )).rejects.toMatchObject({ status: 409 });
  });

  it("locks ready PRD v1/v2 targets and freezes their request order and idempotency", async () => {
    const targetedRequest = {
      ...request,
      workflow: "edit" as const,
      artifactTargets: [
        { artifactId: "artifact_target_2", artifactVersionId: "version_target_2", screenIds: [] },
        { artifactId: "artifact_target_1", artifactVersionId: "version_target_1", screenIds: [] },
      ],
    };
    const ready = createHarness({
      targetVersions: [
        { id: "version_target_1", artifactId: "artifact_target_1", kind: "prd", schemaVersion: 2, content: prdDocumentV2Example, contentBlobId: null },
        { id: "version_target_2", artifactId: "artifact_target_2", kind: "prd", schemaVersion: 1, content: null, contentBlobId: null },
      ],
    });

    await expect(ready.service.start(
      "principal_1",
      "thread_1",
      "run:key:targets:12345678",
      targetedRequest,
    )).resolves.toMatchObject({
      artifactTargets: targetedRequest.artifactTargets,
    });
    expect(ready.tx.run.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        request: targetedRequest,
        requestHash: hashRequest(targetedRequest),
      }),
    });

    const replay = createHarness({ existing: persistedRun({
      request: targetedRequest,
      requestHash: hashRequest(targetedRequest),
    }) });
    await expect(replay.service.start(
      "principal_1",
      "thread_1",
      "run:key:12345678",
      { ...targetedRequest, artifactTargets: [...targetedRequest.artifactTargets].reverse() },
    )).rejects.toMatchObject({ status: 409 });

    const retry = createHarness({
      targetVersions: [
        { id: "version_target_1", artifactId: "artifact_target_1", kind: "prd", schemaVersion: 2, content: prdDocumentV2Example, contentBlobId: null },
        { id: "version_target_2", artifactId: "artifact_target_2", kind: "prd", schemaVersion: 1, content: null, contentBlobId: null },
      ],
    });
    retry.access.findRun = vi.fn().mockResolvedValue(persistedRun({
      request: targetedRequest,
      requestHash: hashRequest(targetedRequest),
      status: "failed",
      errorCode: "RUNTIME_UNAVAILABLE",
      errorDetail: "Runtime temporarily unavailable",
      errorRetryable: true,
      finishedAt: now,
    }));
    await retry.service.retry("principal_1", "run_1", "retry:targets:12345678");
    expect(retry.tx.run.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        retryOfRunId: "run_1",
        request: targetedRequest,
      }),
    });
  });

  it("accepts only screens owned by the exact inline Prototype target", async () => {
    const targetVersion = {
      id: "version_target_prototype",
      artifactId: "artifact_target_prototype",
      kind: "prototype",
      schemaVersion: 1,
      content: targetPrototypeContent,
      contentBlobId: null,
    };
    const valid = createHarness({ targetVersions: [targetVersion] });
    await expect(valid.service.start(
      "principal_1",
      "thread_1",
      "run:key:screen-valid:12345678",
      {
        ...request,
        workflow: "edit",
        artifactTargets: [{
          artifactId: targetVersion.artifactId,
          artifactVersionId: targetVersion.id,
          screenIds: ["screen-home"],
        }],
      },
    )).resolves.toMatchObject({
      artifactTargets: [{ screenIds: ["screen-home"] }],
    });

    const forged = createHarness({ targetVersions: [targetVersion] });
    await expect(forged.service.start(
      "principal_1",
      "thread_1",
      "run:key:screen-forged:12345678",
      {
        ...request,
        workflow: "edit",
        artifactTargets: [{
          artifactId: targetVersion.artifactId,
          artifactVersionId: targetVersion.id,
          screenIds: ["screen-forged"],
        }],
      },
    )).rejects.toMatchObject({ status: 404 });
    expect(forged.tx.run.create).not.toHaveBeenCalled();
  });

  it("accepts Generate Prototype only from exact same-Project ready inline Prototype screens", async () => {
    const targetVersion = {
      id: "version_target_prototype",
      artifactId: "artifact_target_prototype",
      kind: "prototype",
      schemaVersion: 1,
      content: targetPrototypeContent,
      contentBlobId: null,
    };
    const generatePrototypeRequest = {
      ...request,
      workflow: "generate" as const,
      generationIntent: "interactive-prototype" as const,
      artifactTargets: [{
        artifactId: targetVersion.artifactId,
        artifactVersionId: targetVersion.id,
        screenIds: ["screen-home"],
      }],
      requestedArtifactKinds: ["prototype" as const],
    };
    const valid = createHarness({ targetVersions: [targetVersion] });
    await expect(valid.service.start(
      "principal_1",
      "thread_1",
      "run:key:generate-prototype:12345678",
      generatePrototypeRequest,
    )).resolves.toMatchObject({
      workflow: "generate",
      artifactTargets: generatePrototypeRequest.artifactTargets,
      requestedArtifactKinds: ["prototype"],
    });

    const forgedScreen = createHarness({ targetVersions: [targetVersion] });
    await expect(forgedScreen.service.start(
      "principal_1",
      "thread_1",
      "run:key:generate-forged:12345678",
      {
        ...generatePrototypeRequest,
        artifactTargets: [{ ...generatePrototypeRequest.artifactTargets[0], screenIds: ["screen-forged"] }],
      },
    )).rejects.toMatchObject({ status: 404 });
    expect(forgedScreen.tx.run.create).not.toHaveBeenCalled();

    const unavailable = createHarness({ targetVersions: [] });
    await expect(unavailable.service.start(
      "principal_1",
      "thread_1",
      "run:key:generate-private:12345678",
      generatePrototypeRequest,
    )).rejects.toMatchObject({ status: 404 });
    expect(unavailable.tx.run.create).not.toHaveBeenCalled();

    const blobBacked = createHarness({
      targetVersions: [{ ...targetVersion, content: null, contentBlobId: "blob_prototype" }],
    });
    await expect(blobBacked.service.start(
      "principal_1",
      "thread_1",
      "run:key:generate-blob:12345678",
      generatePrototypeRequest,
    )).rejects.toMatchObject({
      status: 400,
      response: expect.objectContaining({
        errors: {
          artifactTargets: ["Select screens from a ready inline Prototype in this Project"],
        },
      }),
    });
    expect(blobBacked.tx.run.create).not.toHaveBeenCalled();

    const unsupportedSchema = createHarness({
      targetVersions: [{ ...targetVersion, schemaVersion: 2 }],
    });
    await expect(unsupportedSchema.service.start(
      "principal_1",
      "thread_1",
      "run:key:generate-prototype-v2:12345678",
      generatePrototypeRequest,
    )).rejects.toMatchObject({
      status: 400,
      response: expect.objectContaining({
        errors: {
          artifactTargets: ["Select screens from a ready inline Prototype in this Project"],
        },
      }),
    });
    expect(unsupportedSchema.tx.run.create).not.toHaveBeenCalled();
  });

  it("returns the same 404 for missing, cross-Project, and non-ready target versions", async () => {
    const unavailable = createHarness({
      targetVersions: [{
        id: "version_target_1",
        artifactId: "artifact_target_1",
        kind: "prd",
        schemaVersion: 1,
        content: null,
        contentBlobId: null,
      }],
    });

    await expect(unavailable.service.start(
      "principal_1",
      "thread_1",
      "run:key:targets:12345678",
      {
        ...request,
        workflow: "edit",
        artifactTargets: [
          { artifactId: "artifact_target_1", artifactVersionId: "version_target_1", screenIds: [] },
          { artifactId: "artifact_private", artifactVersionId: "version_private_or_staging", screenIds: [] },
        ],
      },
    )).rejects.toMatchObject({ status: 404 });
    expect(unavailable.tx.run.create).not.toHaveBeenCalled();
    expect(unavailable.queue.sendInTransaction).not.toHaveBeenCalled();
  });

  it("pins only a ready design-system ArtifactVersion from the same Project", async () => {
    const ready = createHarness({
      designStyleVersions: [{
        id: "version_style_1",
        artifactId: "artifact_style_1",
        status: "ready",
        kind: "design_system",
        schemaVersion: 1,
        checksum: designSystemChecksum,
      }],
    });
    const styledRequest = {
      ...request,
      designStyle: { kind: "artifact" as const, artifactVersionId: "version_style_1" },
    };

    await ready.service.start("principal_1", "thread_1", "run:key:style:12345678", styledRequest);
    expect(ready.tx.run.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        designStyleArtifactVersionId: "version_style_1",
        designStyleSnapshot: expect.objectContaining({
          protocol: "workbench.runtime.design-style.v1",
          source: expect.objectContaining({ artifactVersionId: "version_style_1" }),
        }),
        designStyleSnapshotSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        request: styledRequest,
      }),
    });
    const persisted = ready.tx.run.create.mock.calls[0]?.[0].data;
    expect(persisted.requestHash).toBe(hashRequest({
      request: styledRequest,
      designStyleSnapshotSha256: persisted.designStyleSnapshotSha256,
    }));
    expect(persisted.requestHash).not.toBe(hashRequest(styledRequest));

    const unavailable = createHarness({
      designStyleVersions: [{
        id: "version_style_1",
        artifactId: "artifact_style_1",
        status: "staging",
        kind: "design_system",
        schemaVersion: 1,
        checksum: designSystemChecksum,
      }],
    });
    await expect(unavailable.service.start(
      "principal_1",
      "thread_1",
      "run:key:style:12345678",
      styledRequest,
    )).rejects.toMatchObject({ status: 404 });
    expect(unavailable.tx.run.create).not.toHaveBeenCalled();
  });
});
