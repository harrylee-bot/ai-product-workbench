import { createHash, randomUUID } from "node:crypto";
import {
  canonicalJson,
  computePrototypeScreenProjectionChecksum,
  projectPrototypeScreen,
  type PrototypeDocument,
} from "@workbench/workbench-contracts";
import { Prisma, PrismaClient } from "@workbench/workbench-db";
import { seedReadyKnowledge } from "../../../scripts/test-support/knowledge-fixture.mjs";
import { PrototypePatchCheckpointsService } from "../src/modules/prototype-patches/prototype-patch-checkpoints.service.js";

const databaseUrl = process.env.WORKBENCH_TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("Prototype Patch checkpoint PostgreSQL authorization", () => {
  it("returns one coherent member snapshot and hides it from a non-member", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const rollback = new Error("ROLLBACK_PROTOTYPE_PATCH_CHECKPOINT_TEST");
    let verified = false;

    try {
      await expect(db.$transaction(async (tx) => {
        const fixture = await seedCheckpoint(tx);
        const service = new PrototypePatchCheckpointsService(tx as never);

        await expect(service.get(
          fixture.ownerId,
          fixture.runId,
          fixture.artifactVersionId,
        )).resolves.toMatchObject({
          projectId: fixture.projectId,
          runId: fixture.runId,
          runtimeAttemptId: fixture.runtimeAttemptId,
          artifactVersionId: fixture.artifactVersionId,
          document: fixture.document,
          documentChecksum: sha256Canonical(fixture.document),
          screens: [{
            screenId: "screen-home",
            revision: 2,
            checksum: screenChecksum(fixture.document, "screen-home", 2),
          }],
        });
        await expect(service.get(
          fixture.ownerId,
          fixture.runId,
          fixture.artifactVersionId,
          "screen-home",
        )).resolves.toMatchObject({
          screens: [expect.objectContaining({ screenId: "screen-home" })],
        });
        await expect(service.get(
          fixture.outsiderId,
          fixture.runId,
          fixture.artifactVersionId,
        )).rejects.toMatchObject({ status: 404 });

        verified = true;
        throw rollback;
      })).rejects.toBe(rollback);
      expect(verified).toBe(true);
    } finally {
      await db.$disconnect();
    }
  }, 120_000);
});

async function seedCheckpoint(tx: Prisma.TransactionClient) {
  const suffix = randomUUID().replaceAll("-", "");
  const ownerId = `principal_owner_${suffix}`;
  const outsiderId = `principal_outsider_${suffix}`;
  const workspaceId = `workspace_${suffix}`;
  const projectId = `project_${suffix}`;
  const threadId = `thread_${suffix}`;
  const runId = `run_${suffix}`;
  const runtimeAttemptId = `attempt_${suffix}`;
  const bindingId = `binding_${suffix}`;
  const artifactId = `artifact_${suffix}`;
  const artifactVersionId = `version_${suffix}`;
  const document = prototypeDocument();

  await tx.principal.createMany({
    data: [
      { id: ownerId, issuer: `checkpoint-test-${suffix}`, subject: ownerId },
      { id: outsiderId, issuer: `checkpoint-test-${suffix}`, subject: outsiderId },
    ],
  });
  await tx.workspace.create({
    data: { id: workspaceId, slug: `checkpoint-test-${suffix}`, name: "Checkpoint test", createdById: ownerId },
  });
  await tx.workspaceMember.create({
    data: { workspaceId, principalId: ownerId, role: "owner" },
  });
  await tx.project.create({
    data: { id: projectId, workspaceId, createdById: ownerId, title: "Checkpoint test" },
  });
  await tx.projectMember.create({
    data: { projectId, workspaceId, principalId: ownerId, role: "owner" },
  });
  await tx.thread.create({
    data: { id: threadId, projectId, createdById: ownerId, title: "Checkpoint test" },
  });
  await tx.runtimeBinding.create({
    data: {
      id: bindingId,
      threadId,
      adapter: "deerflow",
      externalThreadId: `external_thread_${suffix}`,
      metadata: { workbenchThreadId: threadId },
    },
  });
  await tx.run.create({
    data: {
      knowledgeReleaseId: await seedReadyKnowledge(tx),
      id: runId,
      projectId,
      threadId,
      createdById: ownerId,
      idempotencyKey: `checkpoint-${suffix}`,
      requestHash: "a".repeat(64),
      requestId: `request_${suffix}`,
      request: {
        prompt: "Build it",
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
      id: runtimeAttemptId,
      runId,
      runtimeBindingId: bindingId,
      attempt: 1,
      adapter: "deerflow",
      externalThreadId: `external_thread_${suffix}`,
    },
  });
  await tx.runtimeAttempt.update({
    where: { id: runtimeAttemptId },
    data: {
      status: "submitting",
      startedAt: new Date(),
      providerIdempotencyKey: `wbrt:${createHash("sha256").update(runtimeAttemptId).digest("hex")}`,
    },
  });
  await tx.runtimeAttempt.update({
    where: { id: runtimeAttemptId },
    data: { status: "running", externalRunId: `external_run_${suffix}` },
  });
  await tx.artifact.create({
    data: { id: artifactId, projectId, kind: "prototype", title: "Checkpoint test" },
  });
  await tx.artifactVersion.create({
    data: {
      id: artifactVersionId,
      artifactId,
      projectId,
      version: 1,
      schemaVersion: 1,
      content: document as Prisma.InputJsonValue,
      checksum: sha256Canonical(document),
      citations: [],
      createdByRunId: runId,
      runtimeDraftSourceId: `checkpoint_${suffix}`,
      runtimeDraftIndex: 0,
      runtimeDraftTitle: "Checkpoint test",
    },
  });
  await tx.prototypePatchProjection.create({
    data: {
      artifactVersionId,
      artifactId,
      projectId,
      runId,
      screenId: "screen-home",
      revision: 2,
      checksum: screenChecksum(document, "screen-home", 2),
    },
  });
  return {
    ownerId,
    outsiderId,
    projectId,
    runId,
    runtimeAttemptId,
    artifactVersionId,
    document,
  };
}

function prototypeDocument(): PrototypeDocument {
  const literal = (value: number) => ({ kind: "literal" as const, value });
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
    nodes: [{
      id: "root-home",
      screenId: "screen-home",
      parentId: null,
      name: "Root",
      kind: "frame",
      visible: true,
      layout: {
        mode: "absolute",
        x: literal(0),
        y: literal(0),
        width: literal(390),
        height: literal(844),
        display: "block",
        direction: "column",
        gap: literal(0),
        padding: { top: literal(0), right: literal(0), bottom: literal(0), left: literal(0) },
        align: "stretch",
        justify: "start",
        gridColumns: null,
        overflow: "hidden",
      },
      style: {
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
}

function screenChecksum(document: PrototypeDocument, screenId: string, revision: number) {
  return computePrototypeScreenProjectionChecksum(
    projectPrototypeScreen(document, screenId, revision),
    (value) => createHash("sha256").update(value).digest("hex"),
  );
}

function sha256Canonical(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
