import { createHash, randomUUID } from "node:crypto";
import { boardNodeProtocol } from "@workbench/workbench-contracts";
import { Prisma, PrismaClient } from "@workbench/workbench-db";
import { RunProcessor, sha256Canonical } from "../src/runs/run-processor.js";
import { prototypeScreenProjectionChecksum } from "../src/runs/prototype-patch-applier.js";
import {
  RuntimeAttemptService,
  type RuntimeExecutionClaim,
} from "../src/runtime/runtime-attempt.service.js";
import type { RuntimeArtifactTarget } from "../src/runtime/runtime.port.js";

const databaseUrl =
  process.env.WORKBENCH_RUN_PROCESSOR_TEST_DATABASE_URL
  ?? process.env.WORKBENCH_TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const noKnowledgeToolGrants = () => ({ issue: vi.fn(async () => null) });

type DocumentDraft = {
  kind: "document";
  schemaVersion: number;
  title: string;
  citations: [];
  operation: { kind: "create" };
  content: { text: string };
};

type ProcessorInternals = {
  prepare(runId: string, approvalIds: string[]): Promise<unknown>;
  waitForInput(claim: RuntimeExecutionClaim, input: {
    protocol: "workbench.runtime.input-required.v1";
    approvals: Array<{
      key: string;
      kind: string;
      prompt: string;
      options: [];
    }>;
  }): Promise<void>;
  persistProgress(claim: RuntimeExecutionClaim, event: unknown): Promise<void>;
  persistDelta(claim: RuntimeExecutionClaim, entryId: string, fullText: string, delta: string): Promise<void>;
  persistArtifactDraft(claim: RuntimeExecutionClaim, event: {
    type: "artifact.draft";
    artifactIndex: number;
    sourceEventId: string;
    draft: unknown;
    checkpointScreens: Array<{ screenId: string; revision: number; checksum: string }>;
  }, sources: [], designAssets: [], artifactTargets?: RuntimeArtifactTarget[]): Promise<void>;
  publishResult(claim: RuntimeExecutionClaim, entryId: string, streamedText: string, result: {
    protocol: "workbench.runtime.result.v1";
    message: string;
    artifacts: unknown[];
  }): Promise<void>;
};

describeWithPostgres("Run processor PostgreSQL cancellation fences", () => {
  it("leaves queued preparation untouched when cancellation wins before the Run lock", async () => {
    const worker = new PrismaClient({ datasourceUrl: databaseUrl! });
    const canceller = new PrismaClient({ datasourceUrl: databaseUrl! });
    const fixture = await seedRunFixture(worker, "prepare");
    const lockRequested = deferred<void>();
    const releaseLock = deferred<void>();
    const processor = processorWithRunLockFence(worker, lockRequested, releaseLock);
    const outcome = processor.prepare(fixture.runId, []).then(
      (value) => ({ value, error: null }),
      (error: unknown) => ({ value: null, error }),
    );

    try {
      await lockRequested.promise;
      await cancelActiveRun(canceller, fixture.runId);
      releaseLock.resolve();

      const result = await outcome;
      expect(result.error).toBeNull();
      expect(result.value).toBeNull();
      await expect(worker.run.findUniqueOrThrow({ where: { id: fixture.runId } })).resolves.toMatchObject({
        status: "cancelling",
        attempt: 0,
        startedAt: null,
        outputEntryId: null,
        cancelRequestedAt: expect.any(Date),
      });
      await expect(worker.thread.findUniqueOrThrow({ where: { id: fixture.threadId } })).resolves.toMatchObject({
        entrySequence: 0,
      });
      await expect(worker.threadEntry.count({ where: { threadId: fixture.threadId } })).resolves.toBe(0);
      await expect(worker.runEvent.count({ where: { runId: fixture.runId } })).resolves.toBe(0);
    } finally {
      releaseLock.resolve();
      await outcome;
      await cleanupFixture(worker, fixture);
      await Promise.all([worker.$disconnect(), canceller.$disconnect()]);
    }
  }, 120_000);

  it("does not persist a message delta when cancellation commits before the Run lock", async () => {
    const worker = new PrismaClient({ datasourceUrl: databaseUrl! });
    const canceller = new PrismaClient({ datasourceUrl: databaseUrl! });
    const fixture = await seedRunFixture(worker, "publish");
    const claim = await claimRunFixture(worker, fixture);
    const lockRequested = deferred<void>();
    const releaseLock = deferred<void>();
    const processor = processorWithRunLockFence(worker, lockRequested, releaseLock);
    const outcome = processor.persistDelta(
      claim,
      fixture.outputEntryId!,
      "partial response",
      "response",
    ).then(
      () => ({ error: null }),
      (error: unknown) => ({ error }),
    );

    try {
      await lockRequested.promise;
      await cancelActiveRun(canceller, fixture.runId);
      releaseLock.resolve();

      const result = await outcome;
      expect(result.error).toMatchObject({ message: "RUNTIME_CANCELLED" });
      await expect(worker.runDraft.count({ where: { runId: fixture.runId } })).resolves.toBe(0);
      await expect(worker.runEvent.count({
        where: { runId: fixture.runId, type: "message.delta" },
      })).resolves.toBe(0);
    } finally {
      releaseLock.resolve();
      await outcome;
      await cleanupFixture(worker, fixture);
      await Promise.all([worker.$disconnect(), canceller.$disconnect()]);
    }
  }, 120_000);

  it("does not persist progress when cancellation commits before the Run lock", async () => {
    const worker = new PrismaClient({ datasourceUrl: databaseUrl! });
    const canceller = new PrismaClient({ datasourceUrl: databaseUrl! });
    const fixture = await seedRunFixture(worker, "wait");
    const claim = await claimRunFixture(worker, fixture);
    const lockRequested = deferred<void>();
    const releaseLock = deferred<void>();
    const processor = processorWithRunLockFence(worker, lockRequested, releaseLock);
    const outcome = processor.persistProgress(claim, {
      type: "phase",
      phase: "generating",
      label: "Generating prototype",
      progress: 0.5,
    }).then(
      () => ({ error: null }),
      (error: unknown) => ({ error }),
    );

    try {
      await lockRequested.promise;
      await cancelActiveRun(canceller, fixture.runId);
      releaseLock.resolve();

      const result = await outcome;
      expect(result.error).toMatchObject({ message: "RUNTIME_CANCELLED" });
      await expect(worker.run.findUniqueOrThrow({ where: { id: fixture.runId } })).resolves.toMatchObject({
        status: "cancelling",
        phase: null,
        phaseLabel: null,
        progress: null,
      });
      await expect(worker.runEvent.count({
        where: { runId: fixture.runId, type: "run.phase.changed" },
      })).resolves.toBe(0);
    } finally {
      releaseLock.resolve();
      await outcome;
      await cleanupFixture(worker, fixture);
      await Promise.all([worker.$disconnect(), canceller.$disconnect()]);
    }
  }, 120_000);

  it("rolls back waiting-input state and approvals when cancellation wins", async () => {
    const worker = new PrismaClient({ datasourceUrl: databaseUrl! });
    const canceller = new PrismaClient({ datasourceUrl: databaseUrl! });
    const fixture = await seedRunFixture(worker, "wait");
    const claim = await claimRunFixture(worker, fixture);
    const lockRequested = deferred<void>();
    const releaseLock = deferred<void>();
    const processor = processorWithRunLockFence(worker, lockRequested, releaseLock);
    const outcome = processor.waitForInput(claim, {
      protocol: "workbench.runtime.input-required.v1",
      approvals: [{ key: "scope", kind: "choice", prompt: "Choose scope", options: [] }],
    }).then(
      () => ({ error: null }),
      (error: unknown) => ({ error }),
    );

    try {
      await lockRequested.promise;
      await cancelActiveRun(canceller, fixture.runId);
      releaseLock.resolve();

      const result = await outcome;
      expect(result.error).toMatchObject({ message: "RUNTIME_CANCELLED" });
      await expect(worker.run.findUniqueOrThrow({ where: { id: fixture.runId } })).resolves.toMatchObject({
        status: "cancelling",
      });
      await expect(worker.runtimeAttempt.findUniqueOrThrow({
        where: { id: fixture.runtimeAttemptId! },
      })).resolves.toMatchObject({
        status: "running",
        finishedAt: null,
      });
      await expect(worker.runApproval.count({ where: { runId: fixture.runId } })).resolves.toBe(0);
      await expect(worker.runEvent.count({ where: { runId: fixture.runId } })).resolves.toBe(0);
    } finally {
      releaseLock.resolve();
      await outcome;
      await cleanupFixture(worker, fixture);
      await Promise.all([worker.$disconnect(), canceller.$disconnect()]);
    }
  }, 120_000);

  it("keeps the staging draft unpublished when cancellation wins publication", async () => {
    const worker = new PrismaClient({ datasourceUrl: databaseUrl! });
    const canceller = new PrismaClient({ datasourceUrl: databaseUrl! });
    const fixture = await seedRunFixture(worker, "publish");
    const claim = await claimRunFixture(worker, fixture);
    const draft = documentDraft("Cancelled document", "must roll back");
    const checkpointProcessor = new RunProcessor(
      worker,
      {} as never,
      noKnowledgeToolGrants(),
    ) as unknown as ProcessorInternals;
    await checkpointProcessor.persistArtifactDraft(
      claim,
      {
        type: "artifact.draft",
        artifactIndex: 0,
        sourceEventId: "deerflow:cancelled-document-draft",
        draft,
        checkpointScreens: [],
      },
      [],
      [],
    );
    const fenceReached = deferred<void>();
    const releaseFence = deferred<void>();
    const processor = processorWithRunReadFence(worker, {
      runId: fixture.runId,
      reached: fenceReached,
      release: releaseFence,
    });
    const outcome = processor.publishResult(
      claim,
      fixture.outputEntryId!,
      "streamed draft",
      {
        protocol: "workbench.runtime.result.v1",
        message: "Published result",
        artifacts: [draft],
      },
    ).then(
      () => ({ error: null }),
      (error: unknown) => ({ error }),
    );

    try {
      await fenceReached.promise;
      await cancelActiveRun(canceller, fixture.runId);
      releaseFence.resolve();

      const result = await outcome;
      expect(result.error).toMatchObject({ message: "RUNTIME_CANCELLED" });
      await expect(worker.run.findUniqueOrThrow({ where: { id: fixture.runId } })).resolves.toMatchObject({
        status: "cancelling",
        progress: null,
        finishedAt: null,
      });
      await expect(worker.runtimeAttempt.findUniqueOrThrow({
        where: { id: fixture.runtimeAttemptId! },
      })).resolves.toMatchObject({
        status: "running",
        finishedAt: null,
      });
      await expect(worker.threadEntry.findUniqueOrThrow({
        where: { id: fixture.outputEntryId! },
      })).resolves.toMatchObject({
        content: { protocol: "workbench.entry.v1", type: "assistant.message", text: "" },
      });
      await expect(worker.artifact.findFirstOrThrow({
        where: { projectId: fixture.projectId },
      })).resolves.toMatchObject({ currentVersionId: null });
      await expect(worker.artifactVersion.findFirstOrThrow({
        where: { createdByRunId: fixture.runId },
      })).resolves.toMatchObject({ status: "staging" });
      await expect(worker.artifactVersion.count({
        where: { createdByRunId: fixture.runId, status: "ready" },
      })).resolves.toBe(0);
      await expect(worker.boardNode.count({ where: { boardId: fixture.boardId } })).resolves.toBe(0);
      await expect(worker.runEvent.count({
        where: {
          runId: fixture.runId,
          type: { in: ["artifact.version.created", "message.completed", "run.completed"] },
        },
      })).resolves.toBe(0);
    } finally {
      releaseFence.resolve();
      await outcome;
      await cleanupFixture(worker, fixture);
      await Promise.all([worker.$disconnect(), canceller.$disconnect()]);
    }
  }, 120_000);

  it("commits publication and ordered completion events when the success fence wins", async () => {
    const worker = new PrismaClient({ datasourceUrl: databaseUrl! });
    const fixture = await seedRunFixture(worker, "publish");
    const claim = await claimRunFixture(worker, fixture);
    const processor = new RunProcessor(
      worker,
      {} as never,
      noKnowledgeToolGrants(),
    ) as unknown as ProcessorInternals;
    const draft = documentDraft("Published document", "committed");

    try {
      await processor.persistArtifactDraft(
        claim,
        {
          type: "artifact.draft",
          artifactIndex: 0,
          sourceEventId: "deerflow:published-document-draft",
          draft,
          checkpointScreens: [],
        },
        [],
        [],
      );
      await processor.publishResult(
        claim,
        fixture.outputEntryId!,
        "streamed draft",
        {
          protocol: "workbench.runtime.result.v1",
          message: "Published result",
          artifacts: [draft],
        },
      );

      await expect(worker.run.findUniqueOrThrow({ where: { id: fixture.runId } })).resolves.toMatchObject({
        status: "succeeded",
        progress: 1,
        finishedAt: expect.any(Date),
      });
      await expect(worker.runtimeAttempt.findUniqueOrThrow({
        where: { id: fixture.runtimeAttemptId! },
      })).resolves.toMatchObject({
        status: "succeeded",
        finishedAt: expect.any(Date),
      });
      await expect(worker.artifact.count({ where: { projectId: fixture.projectId } })).resolves.toBe(1);
      await expect(worker.boardNode.count({ where: { boardId: fixture.boardId } })).resolves.toBe(1);
      await expect(worker.runEvent.findMany({
        where: { runId: fixture.runId },
        orderBy: { sequence: "asc" },
        select: { type: true },
      })).resolves.toEqual([
        { type: "artifact.draft.created" },
        { type: "artifact.version.created" },
        { type: "message.completed" },
        { type: "run.completed" },
      ]);
    } finally {
      await cleanupFixture(worker, fixture);
      await worker.$disconnect();
    }
  }, 120_000);

  it("creates a new Prototype from a pinned source screen without mutating the source Artifact", async () => {
    const worker = new PrismaClient({ datasourceUrl: databaseUrl! });
    let sourceArtifactId = "";
    let sourceVersionId = "";
    const fixture = await seedRunFixture(worker, "publish", (ids) => {
      sourceArtifactId = `source_artifact_${ids.runId}`;
      sourceVersionId = `source_version_${ids.runId}`;
      return {
        prompt: "Generate a new Prototype from the selected source screen",
        modelId: "quality",
        workflow: "generate",
        generationIntent: "interactive-prototype",
        targetSurface: "app",
        designStyle: { kind: "automatic" },
        sourceIds: [],
        artifactTargets: [{
          artifactId: sourceArtifactId,
          artifactVersionId: sourceVersionId,
          screenIds: ["screen-home"],
        }],
        requestedArtifactKinds: ["prototype"],
      };
    });
    const sourceBlobId = `source_blob_${fixture.runId}`;
    const assetSha256 = "d".repeat(64);
    const sourceAsset = {
      id: "source-hero",
      kind: "image" as const,
      name: "Source hero",
      blobId: sourceBlobId,
      mediaType: "image/png" as const,
      byteSize: 16,
      sha256: assetSha256,
      width: 320,
      height: 180,
    };
    const sourceDocument = {
      ...canvasPrototypeDocumentWithImage(sourceAsset),
      title: "Source Prototype",
    };
    const generatedAsset = {
      ...sourceAsset,
      id: "generated-hero",
      name: "Generated hero",
    };
    const generatedDocument = {
      ...canvasPrototypeDocumentWithImage(generatedAsset),
      documentId: "generated-prototype",
      title: "Generated Prototype",
    };
    const draft = {
      kind: "prototype" as const,
      schemaVersion: 1 as const,
      title: generatedDocument.title,
      citations: [],
      operation: { kind: "create" as const },
      content: generatedDocument,
    };
    const processor = new RunProcessor(
      worker,
      {} as never,
      noKnowledgeToolGrants(),
    ) as unknown as ProcessorInternals;

    try {
      await worker.$transaction(async (tx) => {
        await tx.blob.create({
          data: {
            id: sourceBlobId,
            sha256: assetSha256,
            storageKey: `runtime-source/${fixture.runId}/hero.png`,
            mediaType: sourceAsset.mediaType,
            byteSize: BigInt(sourceAsset.byteSize),
            status: "ready",
            verifiedAt: new Date(),
          },
        });
        await tx.artifact.create({
          data: {
            id: sourceArtifactId,
            projectId: fixture.projectId,
            kind: "prototype",
            title: sourceDocument.title,
          },
        });
        await tx.artifactVersion.create({
          data: {
            id: sourceVersionId,
            artifactId: sourceArtifactId,
            projectId: fixture.projectId,
            version: 1,
            schemaVersion: 1,
            status: "staging",
            content: sourceDocument,
            checksum: sha256Canonical(sourceDocument),
            citations: [],
          },
        });
        await tx.artifactVersionAsset.create({
          data: {
            artifactVersionId: sourceVersionId,
            artifactId: sourceArtifactId,
            projectId: fixture.projectId,
            assetId: sourceAsset.id,
            kind: sourceAsset.kind,
            blobId: sourceAsset.blobId,
            mediaType: sourceAsset.mediaType,
            byteSize: BigInt(sourceAsset.byteSize),
            sha256: sourceAsset.sha256,
            metadata: sourceAsset,
          },
        });
        await tx.artifactVersion.update({
          where: { id: sourceVersionId },
          data: { status: "ready" },
        });
        await tx.artifact.update({
          where: { id: sourceArtifactId },
          data: { currentVersionId: sourceVersionId },
        });
      });

      const prepared = await processor.prepare(fixture.runId, []) as {
        artifactTargets: RuntimeArtifactTarget[];
      };
      const claim = await claimRunFixture(worker, fixture);
      expect(prepared.artifactTargets).toMatchObject([{
        artifactId: sourceArtifactId,
        artifactVersionId: sourceVersionId,
        assets: [{ assetId: sourceAsset.id, blobId: sourceBlobId }],
      }]);
      await worker.$transaction(async (tx) => {
        const sequencedRun = await tx.run.update({
          where: { id: fixture.runId },
          data: { eventSequence: { increment: 1 } },
        });
        await tx.runEvent.create({
          data: {
            runId: fixture.runId,
            sourceId: "system:generate-source-thinking",
            sequence: sequencedRun.eventSequence,
            type: "run.generation.stage.changed",
            payload: { attempt: 1, stage: "thinking" },
            traceId: sequencedRun.traceId,
          },
        });
      });
      for (const stage of ["design-system", "mapping-components", "creating-flows", "generating-ui"] as const) {
        await processor.persistProgress(claim, {
          type: "generation.stage",
          stage,
          sourceEventId: `deerflow:generate-source-${stage}`,
        });
      }
      await processor.persistArtifactDraft(
        claim,
        {
          type: "artifact.draft",
          artifactIndex: 0,
          sourceEventId: "deerflow:generate-from-source-draft",
          draft,
          checkpointScreens: generatedDocument.screens.map(({ id }) => ({
            screenId: id,
            revision: 0,
            checksum: prototypeScreenProjectionChecksum(generatedDocument, id, 0),
          })),
        },
        [],
        [],
        prepared.artifactTargets,
      );
      await processor.publishResult(
        claim,
        fixture.outputEntryId!,
        "streamed source generation",
        {
          protocol: "workbench.runtime.result.v1",
          message: "Generated from source",
          artifacts: [draft],
        },
      );

      const source = await worker.artifact.findUniqueOrThrow({
        where: { id: sourceArtifactId },
        include: { currentVersion: true },
      });
      expect(source.currentVersionId).toBe(sourceVersionId);
      expect(source.currentVersion).toMatchObject({
        id: sourceVersionId,
        version: 1,
        content: sourceDocument,
      });
      const generatedVersion = await worker.artifactVersion.findFirstOrThrow({
        where: { createdByRunId: fixture.runId },
        include: { artifact: true, assets: true },
      });
      expect(generatedVersion.artifactId).not.toBe(sourceArtifactId);
      expect(generatedVersion.id).not.toBe(sourceVersionId);
      expect(generatedVersion.artifact.currentVersionId).toBe(generatedVersion.id);
      expect(generatedVersion.assets).toMatchObject([{
        assetId: generatedAsset.id,
        blobId: sourceBlobId,
        metadata: generatedAsset,
      }]);
      await expect(worker.boardNode.findMany({
        where: { boardId: fixture.boardId },
        select: { artifactId: true, artifactVersionId: true },
      })).resolves.toEqual([{
        artifactId: generatedVersion.artifactId,
        artifactVersionId: generatedVersion.id,
      }]);
    } finally {
      await cleanupFixture(worker, fixture);
      await worker.blob.deleteMany({ where: { id: sourceBlobId } });
      await worker.$disconnect();
    }
  }, 120_000);

  it.each(["quick_edit", "direct"] as const)(
    "publishes %s through the real Canvas invocation and Board guards",
    async (mode) => {
      const worker = new PrismaClient({ datasourceUrl: databaseUrl! });
      const fixture = await seedCanvasEditPublicationFixture(worker, mode);
      const processor = new RunProcessor(
        worker,
        {} as never,
        noKnowledgeToolGrants(),
      ) as unknown as ProcessorInternals;

      try {
        await processor.publishResult(
          fixture.claim,
          fixture.outputEntryId!,
          "streamed edit",
          fixture.result as never,
        );

        const artifact = await worker.artifact.findUniqueOrThrow({
          where: { id: fixture.artifactId },
          include: { currentVersion: true },
        });
        expect(artifact.currentVersionId).not.toBe(fixture.baseVersionId);
        expect(artifact.currentVersion).toMatchObject({
          status: "ready",
          createdByRunId: fixture.runId,
        });
        const invocations = await worker.canvasToolInvocation.findMany({
          where: { agentSessionId: fixture.agentSessionId },
          orderBy: { sequence: "asc" },
        });
        expect(invocations).toHaveLength(mode === "direct" ? 2 : 1);
        expect(invocations.every((invocation) => (
          invocation.resultArtifactVersionId === artifact.currentVersionId
          && invocation.boardRevisionAfter === fixture.baseBoardRevision + 1
        ))).toBe(true);
        await expect(worker.canvasAgentSession.findUniqueOrThrow({
          where: { id: fixture.agentSessionId },
        })).resolves.toMatchObject({
          status: "completed",
          boardRevision: fixture.baseBoardRevision + 1,
        });
        await expect(worker.board.findUniqueOrThrow({
          where: { id: fixture.boardId },
        })).resolves.toMatchObject({ revision: fixture.baseBoardRevision + 1 });
        await expect(worker.boardNode.count({
          where: { boardId: fixture.boardId },
        })).resolves.toBe(mode === "direct" ? 2 : 1);
        const document = artifact.currentVersion?.content as ReturnType<typeof canvasPrototypeDocument>;
        expect(document.nodes.find((node) => node.id === "frame-home")?.name).toBe("ai-edited-home");
        if (mode === "direct") {
          expect(document.screens.find((screen) => screen.id === "screen-home")?.name).toBe("Agent Home");
          expect(document.screens).toHaveLength(2);
        }
      } finally {
        await cleanupFixture(worker, fixture);
        await worker.$disconnect();
      }
    },
    120_000,
  );
});

type FixtureKind = "prepare" | "wait" | "publish";

type RunFixture = {
  principalId: string;
  workspaceId: string;
  projectId: string;
  boardId: string;
  threadId: string;
  runId: string;
  runtimeAttemptId: string | null;
  outputEntryId: string | null;
};

async function seedRunFixture(
  db: PrismaClient,
  kind: FixtureKind,
  requestFactory?: (ids: RunFixture) => Prisma.InputJsonValue,
): Promise<RunFixture> {
  const suffix = randomUUID().replaceAll("-", "");
  const ids: RunFixture = {
    principalId: `principal_${suffix}`,
    workspaceId: `workspace_${suffix}`,
    projectId: `project_${suffix}`,
    boardId: `board_${suffix}`,
    threadId: `thread_${suffix}`,
    runId: `run_${suffix}`,
    runtimeAttemptId: kind === "prepare" ? null : `attempt_${suffix}`,
    outputEntryId: kind === "publish" ? `entry_${suffix}` : null,
  };
  await db.$transaction(async (tx) => {
    await tx.principal.create({
      data: {
        id: ids.principalId,
        issuer: `run-race-${suffix}`,
        subject: ids.principalId,
      },
    });
    await tx.workspace.create({
      data: {
        id: ids.workspaceId,
        slug: `run-race-${suffix}`,
        name: "Run cancellation race",
        createdById: ids.principalId,
      },
    });
    await tx.workspaceMember.create({
      data: {
        workspaceId: ids.workspaceId,
        principalId: ids.principalId,
        role: "owner",
      },
    });
    await tx.project.create({
      data: {
        id: ids.projectId,
        workspaceId: ids.workspaceId,
        createdById: ids.principalId,
        title: "Run cancellation race",
      },
    });
    await tx.projectMember.create({
      data: {
        projectId: ids.projectId,
        workspaceId: ids.workspaceId,
        principalId: ids.principalId,
        role: "owner",
      },
    });
    await tx.board.create({
      data: {
        id: ids.boardId,
        projectId: ids.projectId,
        viewport: { x: 0, y: 0, zoom: 1 },
      },
    });
    await tx.thread.create({
      data: {
        id: ids.threadId,
        projectId: ids.projectId,
        createdById: ids.principalId,
        title: "Run cancellation race",
      },
    });
    const externalThreadId = `external_thread_${suffix}`;
    const bindingId = `binding_${suffix}`;
    if (ids.runtimeAttemptId) {
      await tx.runtimeBinding.create({
        data: {
          id: bindingId,
          threadId: ids.threadId,
          adapter: "deerflow",
          externalThreadId,
          metadata: { workbenchThreadId: ids.threadId },
        },
      });
    }
    const running = kind !== "prepare";
    await tx.run.create({
      data: {
        id: ids.runId,
        projectId: ids.projectId,
        threadId: ids.threadId,
        createdById: ids.principalId,
        idempotencyKey: `run-race-${suffix}`,
        requestHash: "a".repeat(64),
        requestId: `request_${suffix}`,
        request: requestFactory?.(ids) ?? {
          prompt: "Build it",
          modelId: "quality",
          workflow: "generate",
          targetSurface: "app",
          designStyle: { kind: "automatic" },
          sourceIds: [],
          artifactTargets: [],
          requestedArtifactKinds: [],
        },
        modelId: "quality",
        traceId: `trace_${suffix}`,
        status: running ? "running" : "queued",
        attempt: running ? 1 : 0,
        startedAt: running ? new Date() : null,
      },
    });
    if (ids.outputEntryId) {
      await tx.threadEntry.create({
        data: {
          id: ids.outputEntryId,
          threadId: ids.threadId,
          sequence: 1,
          role: "assistant",
          kind: "message",
          producedByRunId: ids.runId,
          content: { protocol: "workbench.entry.v1", type: "assistant.message", text: "" },
        },
      });
      await tx.thread.update({
        where: { id: ids.threadId },
        data: { entrySequence: 1 },
      });
      await tx.run.update({
        where: { id: ids.runId },
        data: { outputEntryId: ids.outputEntryId },
      });
    }
    if (ids.runtimeAttemptId) {
      await tx.runtimeAttempt.create({
        data: {
          id: ids.runtimeAttemptId,
          runId: ids.runId,
          runtimeBindingId: bindingId,
          attempt: 1,
          adapter: "deerflow",
          externalThreadId,
        },
      });
      await tx.runtimeAttempt.update({
        where: { id: ids.runtimeAttemptId },
        data: {
          status: "submitting",
          startedAt: new Date(),
          providerIdempotencyKey: `wbrt:${createHash("sha256")
            .update(ids.runtimeAttemptId)
            .digest("hex")}`,
        },
      });
      await tx.runtimeAttempt.update({
        where: { id: ids.runtimeAttemptId },
        data: {
          externalRunId: `external_run_${suffix}`,
          status: "running",
        },
      });
    }
  });
  return ids;
}

async function seedCanvasEditPublicationFixture(
  db: PrismaClient,
  mode: "quick_edit" | "direct",
) {
  let artifactId = "";
  let baseVersionId = "";
  const fixture = await seedRunFixture(db, "publish", (ids) => {
    artifactId = `canvas_artifact_${ids.runId}`;
    baseVersionId = `canvas_base_${ids.runId}`;
    return {
      prompt: "Edit the selected screen",
      modelId: "quality",
      workflow: "edit",
      targetSurface: "app",
      designStyle: { kind: "automatic" },
      sourceIds: [],
      artifactTargets: [{
        artifactId,
        artifactVersionId: baseVersionId,
        screenIds: ["screen-home"],
      }],
      requestedArtifactKinds: ["prototype"],
    };
  });
  const base = canvasPrototypeDocument();
  const ai = structuredClone(base);
  ai.revision = 2;
  ai.nodes[0]!.name = "ai-edited-home";
  const target = {
    artifactId,
    artifactVersionId: baseVersionId,
    screenIds: ["screen-home"],
  };
  const draft = {
    kind: "prototype" as const,
    schemaVersion: 1 as const,
    title: "Edited prototype",
    citations: [],
    operation: { kind: "revise" as const, target },
    content: ai,
  };
  const result = {
    protocol: "workbench.runtime.result.v1" as const,
    message: "Edited",
    artifacts: [draft],
  };
  const agentSessionId = randomUUID();
  const grantId = randomUUID();
  const boardNodeKey = `canvas-node-${fixture.runId}`;
  const expiresAt = new Date(Date.now() + 120_000);

  await db.$transaction(async (tx) => {
    await tx.artifact.create({
      data: {
        id: artifactId,
        projectId: fixture.projectId,
        kind: "prototype",
        title: "Base prototype",
      },
    });
    await tx.artifactVersion.create({
      data: {
        id: baseVersionId,
        artifactId,
        projectId: fixture.projectId,
        version: 1,
        schemaVersion: 1,
        status: "staging",
        content: base,
        checksum: sha256Canonical(base),
        citations: [],
      },
    });
    await tx.artifactVersion.update({
      where: { id: baseVersionId },
      data: { status: "ready" },
    });
    await tx.artifact.update({
      where: { id: artifactId },
      data: { currentVersionId: baseVersionId },
    });
    await tx.boardNode.create({
      data: {
        boardId: fixture.boardId,
        projectId: fixture.projectId,
        nodeKey: boardNodeKey,
        sortOrder: 0,
        kind: "artifact",
        position: { x: 0, y: 0 },
        size: { width: 390, height: 844 },
        artifactId,
        artifactVersionId: baseVersionId,
        data: {
          protocol: boardNodeProtocol,
          nodeType: "artifact",
          title: "Home",
          artifactKind: "prototype",
          screenId: "screen-home",
          route: "/",
        },
      },
    });
    const board = await tx.board.findUniqueOrThrow({ where: { id: fixture.boardId } });
    const tools = mode === "direct"
      ? ["rename_screen", "duplicate_screen"]
      : ["quick_edit"];
    const snapshotSha256 = "d".repeat(64);
    await tx.canvasAgentSession.create({
      data: {
        id: agentSessionId,
        runtimeAttemptId: fixture.runtimeAttemptId!,
        runId: fixture.runId,
        projectId: fixture.projectId,
        threadId: fixture.threadId,
        principalId: fixture.principalId,
        boardId: fixture.boardId,
        clientSessionId: `client_${fixture.runId}`.slice(0, 128),
        projectSessionGeneration: 1,
        profile: "edit",
        declaredTools: tools,
        declarationHash: "a".repeat(64),
        snapshotSha256,
        boardRevision: board.revision,
        canvasStateRevision: 1,
        invocationSequence: tools.length,
        selectedNodeIds: [boardNodeKey],
        visibleNodeIds: [boardNodeKey],
        viewport: { x: 0, y: 0, zoom: 1 },
        expiresAt,
      },
    });
    await tx.canvasToolGrant.create({
      data: {
        id: grantId,
        agentSessionId,
        payloadSha256: grantId.replaceAll("-", "").repeat(2),
        declarationHash: "a".repeat(64),
        snapshotSha256,
        issuedAt: new Date(),
        expiresAt,
      },
    });
    const reference = {
      boardNodeId: boardNodeKey,
      artifactId,
      artifactVersionId: baseVersionId,
      screenId: "screen-home",
    };
    const intents = mode === "direct"
      ? [
          { toolName: "rename_screen", input: { target: reference, title: "Agent Home" } },
          { toolName: "duplicate_screen", input: { target: reference } },
        ]
      : [{ toolName: "quick_edit", input: { target: reference, instruction: "Edit the home screen" } }];
    for (const [index, intent] of intents.entries()) {
      const toolCallId = `canvas-call-${index + 1}`;
      const data = intent.toolName === "rename_screen"
        ? { runId: fixture.runId, target: reference, title: "Agent Home", accepted: true }
        : { runId: fixture.runId, target: reference, accepted: true };
      await tx.canvasToolInvocation.create({
        data: {
          id: randomUUID(),
          agentSessionId,
          grantId,
          runId: fixture.runId,
          projectId: fixture.projectId,
          principalId: fixture.principalId,
          toolCallId,
          toolName: intent.toolName,
          sequence: index + 1,
          requestHash: String(index + 1).padStart(64, "0"),
          request: { input: intent.input },
          status: "succeeded",
          leaseToken: null,
          leaseExpiresAt: null,
          boardRevisionBefore: board.revision,
          boardRevisionAfter: board.revision,
          canvasStateRevisionBefore: 1,
          canvasStateRevisionAfter: 1,
          canvasStateSha256Before: snapshotSha256,
          canvasStateSha256After: snapshotSha256,
          response: {
            protocol: "workbench.canvas-agent-tool.v1",
            agentSessionId,
            toolCallId,
            toolName: intent.toolName,
            status: "succeeded",
            boardRevision: board.revision,
            canvasStateRevision: 1,
            responseSha256: "c".repeat(64),
            data,
            failure: null,
            approvalId: null,
            clientCommandId: null,
          },
          targetBoardNodeId: boardNodeKey,
          targetArtifactId: artifactId,
          targetArtifactVersionId: baseVersionId,
          targetScreenId: "screen-home",
          satisfiesRunTarget: true,
          completedAt: new Date(),
        },
      });
    }
    const sequencedRun = await tx.run.update({
      where: { id: fixture.runId },
      data: { eventSequence: { increment: 1 } },
    });
    await tx.runEvent.create({
      data: {
        runId: fixture.runId,
        sourceId: `system:canvas-${mode}-thinking`,
        sequence: sequencedRun.eventSequence,
        type: "run.generation.stage.changed",
        payload: { attempt: 1, stage: "thinking" },
        traceId: sequencedRun.traceId,
      },
    });
  });

  const draftProcessor = new RunProcessor(
    db,
    {} as never,
    noKnowledgeToolGrants(),
  ) as unknown as ProcessorInternals;
  const claim = await claimRunFixture(db, fixture);
  for (const stage of ["design-system", "mapping-components", "creating-flows", "generating-ui"] as const) {
    await draftProcessor.persistProgress(claim, {
      type: "generation.stage",
      stage,
      sourceEventId: `deerflow:canvas-${mode}-${stage}`,
    });
  }
  await draftProcessor.persistArtifactDraft(
    claim,
    {
      type: "artifact.draft",
      artifactIndex: 0,
      sourceEventId: `deerflow:canvas-${mode}-draft`,
      draft,
      checkpointScreens: draft.content.screens.map(({ id }) => ({
        screenId: id,
        revision: 0,
        checksum: prototypeScreenProjectionChecksum(draft.content, id, 0),
      })),
    },
    [],
    [],
  );
  const board = await db.board.findUniqueOrThrow({ where: { id: fixture.boardId } });
  return {
    ...fixture,
    agentSessionId,
    artifactId,
    baseVersionId,
    baseBoardRevision: board.revision,
    claim,
    result,
  };
}

function canvasPrototypeDocument() {
  const literal = (value: number) => ({ kind: "literal" as const, value });
  return {
    protocol: "workbench.prototype.v1" as const,
    documentId: "prototype-doc",
    title: "Canvas edit",
    revision: 1,
    screens: [{
      id: "screen-home",
      name: "Home",
      route: "/",
      rootNodeId: "frame-home",
      initialStateId: null,
      viewport: { width: 390, height: 844 },
    }],
    nodes: [{
      id: "frame-home",
      screenId: "screen-home",
      parentId: null,
      name: "base-home",
      visible: true,
      layout: {
        mode: "absolute" as const,
        x: literal(0), y: literal(0), width: literal(390), height: literal(844),
        display: "block" as const,
        direction: "column" as const,
        gap: literal(0),
        padding: { top: literal(0), right: literal(0), bottom: literal(0), left: literal(0) },
        align: "stretch" as const,
        justify: "start" as const,
        gridColumns: null,
        overflow: "hidden" as const,
      },
      style: {
        opacity: 1,
        rotation: 0,
        transformOrigin: { x: 0.5, y: 0.5 },
        fill: { kind: "literal" as const, value: "#ffffff" },
        stroke: null,
        radii: { topLeft: literal(0), topRight: literal(0), bottomRight: literal(0), bottomLeft: literal(0) },
        shadowTokenIds: [],
        typography: null,
      },
      actionIds: [],
      bindingIds: [],
      motionIds: [],
      kind: "frame" as const,
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
}

function canvasPrototypeDocumentWithImage(asset: {
  id: string;
  kind: "image";
  name: string;
  blobId: string;
  mediaType: "image/png";
  byteSize: number;
  sha256: string;
  width: number;
  height: number;
}) {
  const document = canvasPrototypeDocument();
  const root = document.nodes[0]!;
  const imageNode = {
    id: "image-hero",
    screenId: root.screenId,
    parentId: root.id,
    name: asset.name,
    visible: true,
    layout: root.layout,
    style: root.style,
    actionIds: [],
    bindingIds: [],
    motionIds: [],
    kind: "image" as const,
    assetId: asset.id,
    fit: "cover" as const,
    alt: asset.name,
  };
  return {
    ...document,
    nodes: [{ ...root, childIds: [imageNode.id] }, imageNode],
    assets: [asset],
  };
}

function processorWithRunLockFence(
  client: PrismaClient,
  lockRequested: Deferred<void>,
  releaseLock: Deferred<void>,
) {
  let stopped = false;
  const database = {
    $transaction: <T>(callback: (tx: Prisma.TransactionClient) => Promise<T>) =>
      client.$transaction(async (tx) => callback(new Proxy(tx, {
        get(target, property, receiver) {
          if (property === "$queryRaw") {
            const queryRaw = target.$queryRaw.bind(target) as (...args: unknown[]) => Promise<unknown>;
            return async (...args: unknown[]) => {
              if (!stopped) {
                stopped = true;
                lockRequested.resolve();
                await releaseLock.promise;
              }
              return queryRaw(...args);
            };
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as Prisma.TransactionClient), { timeout: 30_000 }),
  };
  return new RunProcessor(
    database as never,
    {} as never,
    noKnowledgeToolGrants(),
  ) as unknown as ProcessorInternals;
}

function processorWithRunReadFence(
  client: PrismaClient,
  fence: {
    runId: string;
    reached: Deferred<void>;
    release: Deferred<void>;
  },
) {
  let stopped = false;
  const database = {
    $transaction: <T>(callback: (tx: Prisma.TransactionClient) => Promise<T>) =>
      client.$transaction(async (tx) => callback(new Proxy(tx, {
        get(target, property, receiver) {
          if (property === "$queryRaw") {
            const queryRaw = target.$queryRaw.bind(target) as (...args: unknown[]) => Promise<unknown>;
            return async (...args: unknown[]) => {
              if (!stopped) {
                stopped = true;
                fence.reached.resolve();
                await fence.release.promise;
              }
              return queryRaw(...args);
            };
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as Prisma.TransactionClient), { timeout: 30_000 }),
  };
  return new RunProcessor(
    database as never,
    {} as never,
    noKnowledgeToolGrants(),
  ) as unknown as ProcessorInternals;
}

function documentDraft(title: string, text: string): DocumentDraft {
  return {
    kind: "document",
    schemaVersion: 1,
    title,
    citations: [],
    operation: { kind: "create" },
    content: { text },
  };
}

async function cancelActiveRun(db: PrismaClient, runId: string) {
  const cancelled = await db.run.updateMany({
    where: { id: runId, status: { in: ["queued", "running", "waiting_input"] } },
    data: { status: "cancelling", cancelRequestedAt: new Date() },
  });
  expect(cancelled.count).toBe(1);
}

async function claimRunFixture(db: PrismaClient, fixture: RunFixture) {
  if (!fixture.runtimeAttemptId) throw new Error("RUNTIME_ATTEMPT_FIXTURE_MISSING");
  return new RuntimeAttemptService(db, 120_000).claim(
    fixture.runId,
    fixture.runtimeAttemptId,
    `run-processor-pg:${randomUUID()}`,
  );
}

async function cleanupFixture(db: PrismaClient, fixture: RunFixture) {
  await db.workspace.deleteMany({ where: { id: fixture.workspaceId } });
  await db.principal.deleteMany({ where: { id: fixture.principalId } });
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value?: T | PromiseLike<T>): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}
