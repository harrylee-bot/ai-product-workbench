import { createHash, randomUUID } from "node:crypto";
import {
  applyPrototypePatch,
  canonicalJson,
  type PrototypeDocument,
  type PrototypePatchBatch,
  type RuntimeProgressEvent,
} from "@workbench/workbench-contracts";
import { Prisma, PrismaClient } from "@workbench/workbench-db";
import { prototypeScreenProjectionChecksum } from "../src/runs/prototype-patch-applier.js";
import { PrototypePatchService } from "../src/runs/prototype-patch.service.js";
import { RunEventStore } from "../src/runs/run-event.store.js";
import { RunProcessor } from "../src/runs/run-processor.js";

const databaseUrl = process.env.WORKBENCH_TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("Prototype Patch PostgreSQL transactions", () => {
  it("replays the exact receipt after terminal settlement and rejects source conflicts", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const fixture = await seedFixture(db);
    const service = new PrototypePatchService(db);
    const patch = patchReplacingText(fixture.document, 0, 1, "Applied once");
    const patchedDocument = applyPrototypePatch(fixture.document, patch).document;
    const event = patchEvent("source-apply-once", patch);

    try {
      const first = await service.persistPatch(
        fixture.runId,
        fixture.runtimeAttemptId,
        event,
      );
      expect(first).toMatchObject({ created: true, outcome: "applied" });

      const finishedAt = new Date();
      await db.$transaction(async (tx) => {
        await service.finalizeVersionTx(
          tx,
          fixture.artifactVersionId,
          patchedDocument,
          finishedAt,
        );
        await tx.runtimeAttempt.update({
          where: { id: fixture.runtimeAttemptId },
          data: { status: "succeeded", finishedAt },
        });
        await tx.run.update({
          where: { id: fixture.runId },
          data: { status: "succeeded", finishedAt },
        });
      });

      await expect(service.persistPatch(
        fixture.runId,
        fixture.runtimeAttemptId,
        event,
      )).resolves.toMatchObject({ ...first, created: false, runId: fixture.runId });

      const conflicting = patchEvent(
        event.sourceEventId,
        patchReplacingText(fixture.document, 0, 1, "Conflicting replay"),
      );
      await expect(service.persistPatch(
        fixture.runId,
        fixture.runtimeAttemptId,
        conflicting,
      )).rejects.toThrow("RUNTIME_PROTOTYPE_PATCH_SOURCE_CONFLICT");
      await expect(service.persistPatch(
        `other-${fixture.runId}`,
        fixture.runtimeAttemptId,
        event,
      )).rejects.toThrow("RUNTIME_PROTOTYPE_PATCH_SOURCE_CONFLICT");

      const [version, projection, applications, events] = await Promise.all([
        db.artifactVersion.findUniqueOrThrow({ where: { id: fixture.artifactVersionId } }),
        db.prototypePatchProjection.findUniqueOrThrow({
          where: {
            artifactVersionId_screenId: {
              artifactVersionId: fixture.artifactVersionId,
              screenId: "screen-home",
            },
          },
        }),
        db.prototypePatchApplication.findMany({ where: { runId: fixture.runId } }),
        db.runEvent.findMany({ where: { runId: fixture.runId } }),
      ]);
      expect(version.content).toMatchObject({ nodes: expect.arrayContaining([
        expect.objectContaining({ id: "text-home", text: "Applied once" }),
      ]) });
      expect(projection).toMatchObject({ revision: 1, status: "finalized" });
      expect(applications).toHaveLength(1);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "artifact.prototype.patch.created" });
    } finally {
      await cleanupFixture(db, fixture);
      await db.$disconnect();
    }
  }, 120_000);

  it("serializes concurrent exact first deliveries onto one receipt", async () => {
    const firstDb = new PrismaClient({ datasourceUrl: databaseUrl! });
    const secondDb = new PrismaClient({ datasourceUrl: databaseUrl! });
    const fixture = await seedFixture(firstDb);
    const first = new PrototypePatchService(firstDb);
    const second = new PrototypePatchService(secondDb);
    const event = patchEvent(
      "source-concurrent-exact",
      patchReplacingText(fixture.document, 0, 1, "Applied exactly once"),
    );

    try {
      const results = await Promise.all([
        first.persistPatch(fixture.runId, fixture.runtimeAttemptId, event),
        second.persistPatch(fixture.runId, fixture.runtimeAttemptId, event),
      ]);

      expect(results.map((result) => result.created).sort()).toEqual([false, true]);
      expect(new Set(results.map((result) => result.id))).toEqual(new Set([results[0]!.id]));
      await expect(firstDb.prototypePatchApplication.count({
        where: {
          runtimeAttemptId: fixture.runtimeAttemptId,
          sourceEventId: event.sourceEventId,
        },
      })).resolves.toBe(1);
      await expect(firstDb.runEvent.count({
        where: { runId: fixture.runId, sourceId: event.sourceEventId },
      })).resolves.toBe(1);
    } finally {
      await cleanupFixture(firstDb, fixture);
      await Promise.all([firstDb.$disconnect(), secondDb.$disconnect()]);
    }
  }, 120_000);

  it("serializes two patches with the same base and records the loser as degraded", async () => {
    const firstDb = new PrismaClient({ datasourceUrl: databaseUrl! });
    const secondDb = new PrismaClient({ datasourceUrl: databaseUrl! });
    const fixture = await seedFixture(firstDb);
    const first = new PrototypePatchService(firstDb);
    const second = new PrototypePatchService(secondDb);
    const events = [
      patchEvent("source-concurrent-a", patchReplacingText(fixture.document, 0, 1, "Winner A")),
      patchEvent("source-concurrent-b", patchReplacingText(fixture.document, 0, 1, "Winner B")),
    ] as const;

    try {
      const results = await Promise.all([
        first.persistPatch(fixture.runId, fixture.runtimeAttemptId, events[0]),
        second.persistPatch(fixture.runId, fixture.runtimeAttemptId, events[1]),
      ]);
      expect(results.map((result) => result.outcome).sort()).toEqual(["applied", "degraded"]);

      const [projection, applications] = await Promise.all([
        firstDb.prototypePatchProjection.findUniqueOrThrow({
          where: {
            artifactVersionId_screenId: {
              artifactVersionId: fixture.artifactVersionId,
              screenId: "screen-home",
            },
          },
        }),
        firstDb.prototypePatchApplication.findMany({
          where: { runId: fixture.runId },
          orderBy: { appliedAt: "asc" },
        }),
      ]);
      expect(projection).toMatchObject({ revision: 1, status: "degraded" });
      expect(applications.filter((application) => application.outcome === "applied")).toHaveLength(1);
      expect(applications.filter((application) => application.outcome === "degraded"))
        .toEqual([expect.objectContaining({ degradedReason: "revision_gap" })]);
      await expect(firstDb.$transaction((tx) => first.loadRunBaselinesTx(tx, fixture.runId)))
        .resolves.toEqual([expect.objectContaining({
          screens: [expect.objectContaining({
            revision: 1,
            status: "degraded",
            recoveryRevision: 1,
          })],
        })]);
    } finally {
      await cleanupFixture(firstDb, fixture);
      await Promise.all([firstDb.$disconnect(), secondDb.$disconnect()]);
    }
  }, 120_000);

  it("recovers a degraded gap from a trusted checkpoint and continues at its consumed revision", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const fixture = await seedFixture(db);
    const service = new PrototypePatchService(db);
    const skippedPatch = patchReplacingText(fixture.document, 2, 3, "Recovered checkpoint");
    const recovered = applyPrototypePatch(fixture.document, skippedPatch).document;

    try {
      await expect(service.persistPatch(
        fixture.runId,
        fixture.runtimeAttemptId,
        patchEvent("source-gap", skippedPatch),
      )).resolves.toMatchObject({ outcome: "degraded" });

      await expect(db.$transaction((tx) => service.loadRunBaselinesTx(tx, fixture.runId)))
        .resolves.toEqual([expect.objectContaining({
          artifactIndex: 0,
          artifactVersionId: fixture.artifactVersionId,
          document: fixture.document,
          screens: [expect.objectContaining({
            screenId: "screen-home",
            revision: 0,
            status: "degraded",
            recoveryRevision: 3,
          })],
        })]);

      await db.$transaction(async (tx) => {
        await tx.artifactVersion.update({
          where: { id: fixture.artifactVersionId },
          data: {
            content: recovered as Prisma.InputJsonValue,
            checksum: sha256Canonical(recovered),
          },
        });
        const states = await service.synchronizeCheckpointTx(tx, {
          runId: fixture.runId,
          artifactVersionId: fixture.artifactVersionId,
          artifactId: fixture.artifactId,
          projectId: fixture.projectId,
          document: recovered,
          checkpointScreens: [{
            screenId: "screen-home",
            revision: 3,
            checksum: screenChecksum(recovered, "screen-home", 3),
          }],
        });
        expect(states).toEqual([{
          id: "screen-home",
          name: recovered.screens[0]!.name,
          route: recovered.screens[0]!.route,
          viewport: recovered.screens[0]!.viewport,
          revision: 3,
          checksum: screenChecksum(recovered, "screen-home", 3),
        }]);
      });

      const nextPatch = patchReplacingText(recovered, 3, 4, "Continued after recovery");
      await expect(service.persistPatch(
        fixture.runId,
        fixture.runtimeAttemptId,
        patchEvent("source-after-recovery", nextPatch),
      )).resolves.toMatchObject({ outcome: "applied" });
      await expect(db.prototypePatchProjection.findUniqueOrThrow({
        where: {
          artifactVersionId_screenId: {
            artifactVersionId: fixture.artifactVersionId,
            screenId: "screen-home",
          },
        },
      })).resolves.toMatchObject({ revision: 4, status: "active" });
    } finally {
      await cleanupFixture(db, fixture);
      await db.$disconnect();
    }
  }, 120_000);

  it("records checksum and apply failures as degraded without changing last-good content", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const checksumFixture = await seedFixture(db);
    const applyFixture = await seedFixture(db);
    const service = new PrototypePatchService(db);
    const mismatched = {
      ...patchReplacingText(checksumFixture.document, 0, 1, "Checksum mismatch"),
      resultingChecksum: "f".repeat(64),
    };
    const root = applyFixture.document.nodes.find((node) => node.id === "root-home")!;
    const rejected: PrototypePatchBatch = {
      screenId: "screen-home",
      baseRevision: 0,
      nextRevision: 1,
      operations: [{ kind: "remove_node", nodeId: root.id }],
      resultingChecksum: "e".repeat(64),
    };

    try {
      await expect(service.persistPatch(
        checksumFixture.runId,
        checksumFixture.runtimeAttemptId,
        patchEvent("source-checksum-mismatch", mismatched),
      )).resolves.toMatchObject({ outcome: "degraded" });
      await expect(service.persistPatch(
        applyFixture.runId,
        applyFixture.runtimeAttemptId,
        patchEvent("source-apply-rejected", rejected),
      )).resolves.toMatchObject({ outcome: "degraded" });

      await expect(db.prototypePatchApplication.findMany({
        where: { runId: { in: [checksumFixture.runId, applyFixture.runId] } },
        orderBy: { degradedReason: "asc" },
      })).resolves.toEqual([
        expect.objectContaining({ degradedReason: "checksum_mismatch" }),
        expect.objectContaining({ degradedReason: "patch_rejected" }),
      ]);
      for (const fixture of [checksumFixture, applyFixture]) {
        await expect(db.artifactVersion.findUniqueOrThrow({
          where: { id: fixture.artifactVersionId },
        })).resolves.toMatchObject({
          content: fixture.document,
          checksum: sha256Canonical(fixture.document),
        });
        await expect(db.prototypePatchProjection.findUniqueOrThrow({
          where: {
            artifactVersionId_screenId: {
              artifactVersionId: fixture.artifactVersionId,
              screenId: "screen-home",
            },
          },
        })).resolves.toMatchObject({ revision: 0, status: "degraded" });
      }
    } finally {
      await cleanupFixture(db, checksumFixture);
      await cleanupFixture(db, applyFixture);
      await db.$disconnect();
    }
  }, 120_000);

  it("loads the last-good revision after waiting-input is queued for a new Attempt", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const fixture = await seedFixture(db);
    const service = new PrototypePatchService(db);
    const patch = patchReplacingText(fixture.document, 0, 1, "Before approval");
    const document = applyPrototypePatch(fixture.document, patch).document;

    try {
      await service.persistPatch(
        fixture.runId,
        fixture.runtimeAttemptId,
        patchEvent("source-before-approval", patch),
      );
      await db.$transaction(async (tx) => {
        await tx.$queryRaw(Prisma.sql`
          SELECT "id" FROM "runs" WHERE "id" = ${fixture.runId} FOR UPDATE
        `);
        await tx.run.update({
          where: { id: fixture.runId },
          data: { status: "waiting_input" },
        });
        await service.pauseRunTx(tx, fixture.runId);
        await tx.runtimeAttempt.update({
          where: { id: fixture.runtimeAttemptId },
          data: { status: "waiting_input", finishedAt: new Date() },
        });
        await tx.run.update({
          where: { id: fixture.runId },
          data: { status: "queued" },
        });
      });

      const processor = new RunProcessor(
        db,
        {} as never,
        { issue: vi.fn(async () => null) },
      ) as unknown as {
        prepare(runId: string, approvalIds: string[]): Promise<{
          prototypePatchBaselines: unknown[];
        }>;
      };
      await expect(processor.prepare(fixture.runId, []))
        .resolves.toMatchObject({
          prototypePatchBaselines: [{
            artifactIndex: 0,
            artifactVersionId: fixture.artifactVersionId,
            document,
            screens: [{
              screenId: "screen-home",
              revision: 1,
              checksum: patch.resultingChecksum,
              status: "active",
              recoveryRevision: null,
            }],
          }],
        });
      await expect(db.run.findUniqueOrThrow({ where: { id: fixture.runId } }))
        .resolves.toMatchObject({ status: "running", attempt: 2 });
      await expect(db.prototypePatchProjection.findUniqueOrThrow({
        where: {
          artifactVersionId_screenId: {
            artifactVersionId: fixture.artifactVersionId,
            screenId: "screen-home",
          },
        },
      })).resolves.toMatchObject({ status: "active", revision: 1 });
    } finally {
      await cleanupFixture(db, fixture);
      await db.$disconnect();
    }
  }, 120_000);

  it("rejects a canonical patch payload above 256 KiB before opening a transaction", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const fixture = await seedFixture(db);
    const service = new PrototypePatchService(db);
    const current = fixture.document.nodes.find((node) => node.id === "text-home");
    if (!current || current.kind !== "text") throw new Error("TEST_TEXT_NODE_MISSING");
    const oversized: PrototypePatchBatch = {
      screenId: "screen-home",
      baseRevision: 0,
      nextRevision: 1,
      operations: Array.from({ length: 3 }, (_, index) => ({
        kind: "replace_node" as const,
        nodeId: current.id,
        node: { ...current, text: String(index).repeat(100_000) },
      })),
      resultingChecksum: "d".repeat(64),
    };

    try {
      await expect(service.persistPatch(
        fixture.runId,
        fixture.runtimeAttemptId,
        patchEvent("source-oversized", oversized),
      )).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
      await expect(db.prototypePatchApplication.count({
        where: { runId: fixture.runId },
      })).resolves.toBe(0);
      await expect(db.runEvent.count({ where: { runId: fixture.runId } })).resolves.toBe(0);
      await expect(db.prototypePatchProjection.findUniqueOrThrow({
        where: {
          artifactVersionId_screenId: {
            artifactVersionId: fixture.artifactVersionId,
            screenId: "screen-home",
          },
        },
      })).resolves.toMatchObject({ revision: 0, status: "active" });
    } finally {
      await cleanupFixture(db, fixture);
      await db.$disconnect();
    }
  }, 120_000);

  it("rejects forged application receipts and ready checkpoint receipts in database triggers", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const applicationFixture = await seedFixture(db);
    const readyFixture = await seedFixture(db);
    const events = new RunEventStore(db);
    const patch = patchReplacingText(applicationFixture.document, 0, 1, "Forged receipt");
    const applied = applyPrototypePatch(applicationFixture.document, patch).document;
    const requestSha256 = "c".repeat(64);

    try {
      await expect(db.$transaction(async (tx) => {
        await tx.artifactVersion.update({
          where: { id: applicationFixture.artifactVersionId },
          data: {
            content: applied as Prisma.InputJsonValue,
            checksum: sha256Canonical(applied),
          },
        });
        await tx.prototypePatchProjection.update({
          where: {
            artifactVersionId_screenId: {
              artifactVersionId: applicationFixture.artifactVersionId,
              screenId: "screen-home",
            },
          },
          data: { revision: 1, checksum: patch.resultingChecksum },
        });
        const appended = await events.appendOnce(
          tx,
          applicationFixture.runId,
          "artifact.prototype.patch.created",
          {
            attempt: 1,
            runtimeAttemptId: applicationFixture.runtimeAttemptId,
            artifactIndex: 0,
            artifactId: "forged-artifact-id",
            artifactVersionId: applicationFixture.artifactVersionId,
            sourceEventId: "source-forged-receipt",
            requestSha256,
            ...patch,
          },
          "source-forged-receipt",
        );
        await tx.prototypePatchApplication.create({
          data: {
            runtimeAttemptId: applicationFixture.runtimeAttemptId,
            runId: applicationFixture.runId,
            artifactVersionId: applicationFixture.artifactVersionId,
            artifactId: applicationFixture.artifactId,
            projectId: applicationFixture.projectId,
            screenId: patch.screenId,
            sourceEventId: "source-forged-receipt",
            outcome: "applied",
            baseRevision: patch.baseRevision,
            nextRevision: patch.nextRevision,
            requestSha256,
            operations: patch.operations as Prisma.InputJsonArray,
            resultingChecksum: patch.resultingChecksum,
            runEventId: appended.event.id,
          },
        });
      })).rejects.toThrow(/PROTOTYPE_PATCH_APPLICATION_SCOPE_INVALID/);

      const readyDocument = readyFixture.document;
      await events.appendOnce(
        db as never,
        readyFixture.runId,
        "artifact.draft.created",
        {
          attempt: 1,
          artifactIndex: 0,
          artifactId: readyFixture.artifactId,
          artifactVersionId: readyFixture.artifactVersionId,
          kind: "prototype",
          checksum: sha256Canonical(readyDocument),
          draftChecksum: "b".repeat(64),
          screens: [{
            id: readyDocument.screens[0]!.id,
            name: readyDocument.screens[0]!.name,
            route: readyDocument.screens[0]!.route,
            viewport: readyDocument.screens[0]!.viewport,
            revision: 0,
            checksum: "0".repeat(64),
          }],
        },
        "source-forged-ready-checkpoint",
      );
      const readyService = new PrototypePatchService(db);
      await expect(db.$transaction(async (tx) => {
        await readyService.finalizeVersionTx(
          tx,
          readyFixture.artifactVersionId,
          readyDocument,
          new Date(),
        );
        await tx.artifactVersion.update({
          where: { id: readyFixture.artifactVersionId },
          data: { status: "ready" },
        });
      })).rejects.toThrow(/PROTOTYPE_PATCH_READY_CHECKPOINT_DIVERGED/);
      await expect(db.prototypePatchProjection.findUniqueOrThrow({
        where: {
          artifactVersionId_screenId: {
            artifactVersionId: readyFixture.artifactVersionId,
            screenId: "screen-home",
          },
        },
      })).resolves.toMatchObject({ status: "active", revision: 0 });
    } finally {
      await cleanupFixture(db, applicationFixture);
      await cleanupFixture(db, readyFixture);
      await db.$disconnect();
    }
  }, 120_000);

  it("enforces the ready gate and keeps RunEvent audit facts after staging cascade cleanup", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const fixture = await seedFixture(db);
    const service = new PrototypePatchService(db);
    const patch = patchReplacingText(fixture.document, 0, 1, "Before cleanup");

    try {
      await service.persistPatch(
        fixture.runId,
        fixture.runtimeAttemptId,
        patchEvent("source-before-cleanup", patch),
      );
      await expect(db.artifactVersion.update({
        where: { id: fixture.artifactVersionId },
        data: { status: "ready" },
      })).rejects.toThrow(/PROTOTYPE_PATCH_PROJECTION_NOT_FINALIZED/);

      const document = applyPrototypePatch(fixture.document, patch).document;
      const projectionChecksum = screenChecksum(document, "screen-home", 1);
      const events = new RunEventStore(db);
      await db.$transaction(async (tx) => {
        await events.appendOnce(
          tx,
          fixture.runId,
          "artifact.draft.created",
          {
            attempt: 1,
            artifactIndex: 0,
            artifactId: fixture.artifactId,
            artifactVersionId: fixture.artifactVersionId,
            kind: "prototype",
            checksum: sha256Canonical(document),
            draftChecksum: sha256Canonical({
              kind: "prototype",
              schemaVersion: 1,
              title: "Prototype Patch test",
              citations: [],
              operation: { kind: "create" },
              content: document,
            }),
            screens: [{
              id: document.screens[0]!.id,
              name: document.screens[0]!.name,
              route: document.screens[0]!.route,
              viewport: document.screens[0]!.viewport,
              revision: 1,
              checksum: projectionChecksum,
            }],
          },
          "checkpoint-before-ready",
        );
        await service.finalizeVersionTx(tx, fixture.artifactVersionId, document, new Date());
        await tx.artifactVersion.update({
          where: { id: fixture.artifactVersionId },
          data: { status: "ready" },
        });
      });
      await expect(db.prototypePatchProjection.findUniqueOrThrow({
        where: {
          artifactVersionId_screenId: {
            artifactVersionId: fixture.artifactVersionId,
            screenId: "screen-home",
          },
        },
      })).resolves.toMatchObject({ status: "finalized", revision: 1 });
      await expect(db.prototypePatchProjection.update({
        where: {
          artifactVersionId_screenId: {
            artifactVersionId: fixture.artifactVersionId,
            screenId: "screen-home",
          },
        },
        data: { checksum: "f".repeat(64) },
      })).rejects.toThrow(/PROTOTYPE_PATCH_PROJECTION_/);

      const eventCount = await db.runEvent.count({ where: { runId: fixture.runId } });
      expect(eventCount).toBe(2);
      await db.artifactVersion.delete({ where: { id: fixture.artifactVersionId } });
      await expect(db.prototypePatchProjection.count({
        where: { artifactVersionId: fixture.artifactVersionId },
      })).resolves.toBe(0);
      await expect(db.prototypePatchApplication.count({
        where: { artifactVersionId: fixture.artifactVersionId },
      })).resolves.toBe(0);
      await expect(db.runEvent.count({ where: { runId: fixture.runId } })).resolves.toBe(2);
    } finally {
      await cleanupFixture(db, fixture);
      await db.$disconnect();
    }
  }, 120_000);
});

type Fixture = {
  principalId: string;
  workspaceId: string;
  projectId: string;
  threadId: string;
  runId: string;
  runtimeAttemptId: string;
  artifactId: string;
  artifactVersionId: string;
  document: PrototypeDocument;
};

async function seedFixture(db: PrismaClient): Promise<Fixture> {
  const suffix = randomUUID().replaceAll("-", "");
  const fixture: Fixture = {
    principalId: `principal_${suffix}`,
    workspaceId: `workspace_${suffix}`,
    projectId: `project_${suffix}`,
    threadId: `thread_${suffix}`,
    runId: `run_${suffix}`,
    runtimeAttemptId: `attempt_${suffix}`,
    artifactId: `artifact_${suffix}`,
    artifactVersionId: `version_${suffix}`,
    document: prototypeDocument(),
  };
  const bindingId = `binding_${suffix}`;
  await db.$transaction(async (tx) => {
    await tx.principal.create({
      data: { id: fixture.principalId, issuer: `patch-test-${suffix}`, subject: fixture.principalId },
    });
    await tx.workspace.create({
      data: {
        id: fixture.workspaceId,
        slug: `patch-test-${suffix}`,
        name: "Prototype Patch test",
        createdById: fixture.principalId,
      },
    });
    await tx.workspaceMember.create({
      data: { workspaceId: fixture.workspaceId, principalId: fixture.principalId, role: "owner" },
    });
    await tx.project.create({
      data: {
        id: fixture.projectId,
        workspaceId: fixture.workspaceId,
        createdById: fixture.principalId,
        title: "Prototype Patch test",
      },
    });
    await tx.projectMember.create({
      data: {
        projectId: fixture.projectId,
        workspaceId: fixture.workspaceId,
        principalId: fixture.principalId,
        role: "owner",
      },
    });
    await tx.thread.create({
      data: {
        id: fixture.threadId,
        projectId: fixture.projectId,
        createdById: fixture.principalId,
        title: "Prototype Patch test",
      },
    });
    await tx.runtimeBinding.create({
      data: {
        id: bindingId,
        threadId: fixture.threadId,
        adapter: "deerflow",
        externalThreadId: `external_thread_${suffix}`,
        metadata: {
          workbenchProjectId: fixture.projectId,
          workbenchThreadId: fixture.threadId,
          workbenchPrincipalId: fixture.principalId,
        },
      },
    });
    await tx.run.create({
      data: {
        id: fixture.runId,
        projectId: fixture.projectId,
        threadId: fixture.threadId,
        createdById: fixture.principalId,
        idempotencyKey: `prototype-patch-${suffix}`,
        requestHash: "a".repeat(64),
        requestId: `request_${suffix}`,
        request: {
          prompt: "Build a prototype",
          modelId: "quality",
          workflow: "generate",
          targetSurface: "app",
          designStyle: { kind: "automatic" },
          sourceIds: [],
          artifactTargets: [],
          requestedArtifactKinds: ["prototype"],
        },
        modelId: "quality",
        traceId: `trace_${suffix}`,
        status: "running",
        attempt: 1,
        startedAt: new Date(),
      },
    });
    await tx.runtimeAttempt.create({
      data: {
        id: fixture.runtimeAttemptId,
        runId: fixture.runId,
        runtimeBindingId: bindingId,
        attempt: 1,
        adapter: "deerflow",
        externalThreadId: `external_thread_${suffix}`,
      },
    });
    await tx.runtimeAttempt.update({
      where: { id: fixture.runtimeAttemptId },
      data: {
        status: "submitting",
        startedAt: new Date(),
        providerIdempotencyKey: `wbrt:${createHash("sha256")
          .update(fixture.runtimeAttemptId)
          .digest("hex")}`,
      },
    });
    await tx.runtimeAttempt.update({
      where: { id: fixture.runtimeAttemptId },
      data: { status: "running", externalRunId: `external_run_${suffix}` },
    });
    await tx.artifact.create({
      data: {
        id: fixture.artifactId,
        projectId: fixture.projectId,
        kind: "prototype",
        title: "Prototype Patch test",
      },
    });
    await tx.artifactVersion.create({
      data: {
        id: fixture.artifactVersionId,
        artifactId: fixture.artifactId,
        projectId: fixture.projectId,
        version: 1,
        schemaVersion: 1,
        status: "staging",
        content: fixture.document as Prisma.InputJsonValue,
        checksum: sha256Canonical(fixture.document),
        citations: [],
        createdByRunId: fixture.runId,
        runtimeDraftSourceId: `checkpoint_${suffix}`,
        runtimeDraftIndex: 0,
        runtimeDraftTitle: "Prototype Patch test",
      },
    });
  });
  const service = new PrototypePatchService(db);
  await db.$transaction(async (tx) => {
    await service.synchronizeCheckpointTx(tx, {
      runId: fixture.runId,
      artifactVersionId: fixture.artifactVersionId,
      artifactId: fixture.artifactId,
      projectId: fixture.projectId,
      document: fixture.document,
      checkpointScreens: [{
        screenId: "screen-home",
        revision: 0,
        checksum: screenChecksum(fixture.document, "screen-home", 0),
      }],
    });
  });
  return fixture;
}

async function cleanupFixture(db: PrismaClient, fixture: Fixture) {
  await db.artifactVersion.deleteMany({ where: { id: fixture.artifactVersionId } });
  await db.artifact.deleteMany({ where: { id: fixture.artifactId } });
  await db.run.deleteMany({ where: { id: fixture.runId } });
  await db.thread.deleteMany({ where: { id: fixture.threadId } });
  await db.project.deleteMany({ where: { id: fixture.projectId } });
  await db.workspace.deleteMany({ where: { id: fixture.workspaceId } });
  await db.principal.deleteMany({ where: { id: fixture.principalId } });
}

function patchEvent(
  sourceEventId: string,
  patch: PrototypePatchBatch,
): Extract<RuntimeProgressEvent, { type: "artifact.prototype.patch" }> {
  return {
    type: "artifact.prototype.patch",
    sourceEventId,
    patch: {
      protocol: "workbench.runtime.prototype-patch.v1",
      artifactIndex: 0,
      ...patch,
    },
  };
}

function patchReplacingText(
  document: PrototypeDocument,
  baseRevision: number,
  nextRevision: number,
  text: string,
): PrototypePatchBatch {
  const current = document.nodes.find((node) => node.id === "text-home");
  if (!current || current.kind !== "text") throw new Error("TEST_TEXT_NODE_MISSING");
  const patch = {
    screenId: "screen-home",
    baseRevision,
    nextRevision,
    operations: [{ kind: "replace_node" as const, nodeId: current.id, node: { ...current, text } }],
    resultingChecksum: "0".repeat(64),
  };
  const applied = applyPrototypePatch(document, patch);
  return {
    ...patch,
    resultingChecksum: createHash("sha256").update(applied.canonicalProjection).digest("hex"),
  };
}

function prototypeDocument(): PrototypeDocument {
  const literal = (value: number) => ({ kind: "literal" as const, value });
  const layout = {
    mode: "absolute" as const,
    x: literal(0),
    y: literal(0),
    width: literal(390),
    height: literal(844),
    display: "block" as const,
    direction: "column" as const,
    gap: literal(0),
    padding: { top: literal(0), right: literal(0), bottom: literal(0), left: literal(0) },
    align: "stretch" as const,
    justify: "start" as const,
    gridColumns: null,
    overflow: "hidden" as const,
  };
  const style = {
    opacity: 1,
    rotation: 0,
    transformOrigin: { x: 0.5, y: 0.5 },
    fill: null,
    stroke: null,
    radii: {
      topLeft: literal(0),
      topRight: literal(0),
      bottomRight: literal(0),
      bottomLeft: literal(0),
    },
    shadowTokenIds: [],
    typography: null,
  };
  const shared = { visible: true, layout, style, actionIds: [], bindingIds: [], motionIds: [] };
  return {
    protocol: "workbench.prototype.v1",
    documentId: "document-1",
    title: "Prototype",
    revision: 1,
    screens: [{
      id: "screen-home",
      name: "Home",
      route: "/",
      rootNodeId: "root-home",
      initialStateId: null,
      viewport: { width: 390, height: 844 },
    }],
    nodes: [
      {
        ...shared,
        id: "root-home",
        screenId: "screen-home",
        parentId: null,
        name: "Root",
        kind: "frame",
        childIds: ["text-home"],
        clipContent: true,
      },
      {
        ...shared,
        id: "text-home",
        screenId: "screen-home",
        parentId: "root-home",
        name: "Status",
        kind: "text",
        text: "Initial",
        maxLines: null,
      },
    ],
    tokens: [],
    assets: [],
    variables: [],
    states: [],
    actions: [],
    bindings: [],
    motions: [],
  };
}

function sha256Canonical(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function screenChecksum(document: PrototypeDocument, screenId: string, revision: number) {
  return prototypeScreenProjectionChecksum(document, screenId, revision);
}
