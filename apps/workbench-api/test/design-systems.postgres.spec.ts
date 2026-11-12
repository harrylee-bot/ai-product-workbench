import { createHash } from "node:crypto";
import {
  canonicalJson,
  runtimeDesignStyleSnapshotSchema,
  startRunRequestSchema,
} from "@workbench/workbench-contracts";
import { Prisma, PrismaClient } from "@workbench/workbench-db";
import { AccessService } from "../src/modules/access/access.service.js";
import { DesignSystemImportsService } from "../src/modules/design-systems/design-system-imports.service.js";
import { DesignSystemsService } from "../src/modules/design-systems/design-systems.service.js";
import { RunEventStore } from "../src/modules/runs/run-event.store.js";
import { RunsService } from "../src/modules/runs/runs.service.js";

import { seedReadyKnowledge } from "../../../scripts/test-support/knowledge-fixture.mjs";

const databaseUrl = process.env.WORKBENCH_TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

function designSystemDocument() {
  return {
    protocol: "workbench.design-system.v1" as const,
    documentId: "design-main",
    title: "Product UI",
    tokens: [
      {
        id: "token-primary",
        path: "color.primary",
        type: "color" as const,
        value: { kind: "literal" as const, value: "#112233" },
        description: null,
      },
      {
        id: "token-link",
        path: "color.link",
        type: "color" as const,
        value: { kind: "alias" as const, path: "color.primary" },
        description: null,
      },
    ],
    assets: [],
    principles: [],
    guidelines: [],
    components: [],
  };
}

describeWithPostgres("Design System PostgreSQL vertical slice", () => {
  it("creates, imports, snapshots a Run, and enforces direct-SQL integrity", async () => {
    const root = new PrismaClient({ datasourceUrl: databaseUrl });
    const rollback = new Error("ROLLBACK_DESIGN_SYSTEM_POSTGRES_TEST");
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    let verified = false;

    try {
      await root.$transaction(async (tx) => {
        await seedReadyKnowledge(tx);
        const owner = await tx.principal.create({
          data: { issuer: `design-system-test-${suffix}`, subject: `owner-${suffix}` },
        });
        const viewer = await tx.principal.create({
          data: { issuer: `design-system-test-${suffix}`, subject: `viewer-${suffix}` },
        });
        const otherEditor = await tx.principal.create({
          data: { issuer: `design-system-test-${suffix}`, subject: `editor-${suffix}` },
        });
        const workspace = await tx.workspace.create({
          data: {
            slug: `design-system-${suffix}`,
            name: "Design System integration",
            createdById: owner.id,
          },
        });
        await tx.workspaceMember.createMany({
          data: [
            { workspaceId: workspace.id, principalId: owner.id, role: "owner" },
            { workspaceId: workspace.id, principalId: viewer.id, role: "member" },
            { workspaceId: workspace.id, principalId: otherEditor.id, role: "member" },
          ],
        });
        const sourceProject = await tx.project.create({
          data: { workspaceId: workspace.id, createdById: owner.id, title: "Design source" },
        });
        const targetProject = await tx.project.create({
          data: { workspaceId: workspace.id, createdById: owner.id, title: "Product target" },
        });
        await tx.projectMember.createMany({
          data: [
            { projectId: sourceProject.id, workspaceId: workspace.id, principalId: owner.id, role: "owner" },
            { projectId: targetProject.id, workspaceId: workspace.id, principalId: owner.id, role: "owner" },
            { projectId: targetProject.id, workspaceId: workspace.id, principalId: viewer.id, role: "viewer" },
            { projectId: targetProject.id, workspaceId: workspace.id, principalId: otherEditor.id, role: "editor" },
          ],
        });
        const thread = await tx.thread.create({
          data: { projectId: targetProject.id, createdById: owner.id, title: "Main" },
        });
        const transactionalDb = sameTransactionClient(tx);
        const access = new AccessService(tx as never);
        const creations = new DesignSystemsService(transactionalDb as never, access);
        const imports = new DesignSystemImportsService(transactionalDb as never, access);

        await expect(creations.create(
          viewer.id,
          targetProject.id,
          `design:viewer:${suffix}`,
          { title: "Forbidden", document: designSystemDocument() },
        )).rejects.toMatchObject({ status: 404 });

        const created = await creations.create(
          owner.id,
          sourceProject.id,
          `design:create:${suffix}`,
          { title: "Product UI", document: designSystemDocument() },
        );
        const imported = await imports.create(
          owner.id,
          targetProject.id,
          `design:import:${suffix}`,
          { sourceArtifactVersionId: created.artifactVersionId },
        );
        expect(imported).toMatchObject({
          sourceProjectId: sourceProject.id,
          sourceArtifactId: created.artifactId,
          sourceArtifactVersionId: created.artifactVersionId,
          sourceChecksum: created.checksum,
          targetProjectId: targetProject.id,
        });
        const otherActorReplay = await imports.create(
          otherEditor.id,
          targetProject.id,
          `design:import:${suffix}`,
          { sourceArtifactVersionId: created.artifactVersionId },
        ).catch((error: unknown) => error);
        expect(otherActorReplay).toMatchObject({
          status: 409,
          response: expect.objectContaining({ code: "IDEMPOTENCY_KEY_REUSED" }),
        });
        expect(JSON.stringify((otherActorReplay as { response: unknown }).response))
          .not.toMatch(new RegExp(`${sourceProject.id}|${created.artifactId}|${created.artifactVersionId}`));
        await expect(imports.create(
          viewer.id,
          targetProject.id,
          `design:import:${suffix}`,
          { sourceArtifactVersionId: created.artifactVersionId },
        )).rejects.toMatchObject({ status: 404 });

        const runs = new RunsService(
          transactionalDb as never,
          access,
          new RunEventStore(),
          { sendInTransaction: vi.fn().mockResolvedValue("job_design") } as never,
          { assertAvailable: vi.fn().mockResolvedValue(undefined) } as never,
          { resolve: vi.fn() } as never,
        );
        const request = {
          prompt: "Build with the imported design language",
          modelId: "quality",
          workflow: "generate" as const,
          targetSurface: "web" as const,
          designStyle: {
            kind: "artifact" as const,
            artifactVersionId: imported.targetArtifactVersionId,
          },
          sourceIds: [],
          artifactTargets: [],
          requestedArtifactKinds: ["prototype" as const],
        };
        const normalizedRequest = startRunRequestSchema.parse(request);
        const run = await runs.start(owner.id, thread.id, `run:design:${suffix}`, request);
        const persistedRun = await tx.run.findUniqueOrThrow({ where: { id: run.id } });
        expect(persistedRun.request).toEqual(normalizedRequest);
        const snapshot = runtimeDesignStyleSnapshotSchema.parse(persistedRun.designStyleSnapshot);
        expect(snapshot).toMatchObject({
          source: {
            projectId: targetProject.id,
            artifactId: imported.targetArtifactId,
            artifactVersionId: imported.targetArtifactVersionId,
            checksum: imported.sourceChecksum,
          },
          tokens: [
            { path: "color.primary", value: "#112233" },
            { path: "color.link", value: "#112233" },
          ],
        });
        const snapshotSha = createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
        expect(persistedRun.designStyleSnapshotSha256).toBe(snapshotSha);
        expect(persistedRun.requestHash).toBe(createHash("sha256").update(canonicalJson({
          request: normalizedRequest,
          designStyleSnapshotSha256: snapshotSha,
        })).digest("hex"));

        const malformedArtifact = await tx.artifact.create({
          data: { projectId: targetProject.id, kind: "design_system", title: "Malformed" },
        });
        const malformedContent = {
          ...designSystemDocument(),
          documentId: "malformed-design",
          assets: [{ id: "bad-asset", kind: "scalar" }],
        };
        const malformedVersion = await tx.artifactVersion.create({
          data: {
            artifactId: malformedArtifact.id,
            projectId: targetProject.id,
            version: 1,
            schemaVersion: 1,
            status: "staging",
            content: malformedContent,
            checksum: createHash("sha256").update(canonicalJson(malformedContent)).digest("hex"),
            citations: [],
          },
        });
        await expectPostgresReject(tx, "malformed_asset", () => tx.$executeRaw(Prisma.sql`
          UPDATE "artifact_versions" SET "status" = 'ready' WHERE "id" = ${malformedVersion.id}
        `), "DESIGN_SYSTEM_ASSET_PIN_MISMATCH");

        await expectPostgresReject(tx, "receipt_update", () => tx.$executeRaw(Prisma.sql`
          UPDATE "design_system_imports"
          SET "source_checksum" = ${"f".repeat(64)}
          WHERE "id" = ${imported.id}
        `), "DESIGN_SYSTEM_IMPORT_RECEIPT_IMMUTABLE");

        await expectPostgresReject(tx, "run_snapshot_update", () => tx.$executeRaw(Prisma.sql`
          UPDATE "runs"
          SET "design_style_snapshot_sha256" = ${"f".repeat(64)}
          WHERE "id" = ${run.id}
        `), "RUN_IDENTITY_IMMUTABLE");

        verified = true;
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    } finally {
      await root.$disconnect();
    }
    expect(verified).toBe(true);
  }, 20_000);
});

function sameTransactionClient(tx: Prisma.TransactionClient) {
  return new Proxy(tx as object, {
    get(target, property, receiver) {
      if (property === "$transaction") {
        return (callback: (client: Prisma.TransactionClient) => unknown) => callback(tx);
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

async function expectPostgresReject(
  tx: Prisma.TransactionClient,
  name: string,
  operation: () => Promise<unknown>,
  message: string,
) {
  const savepoint = `design_system_${name}`;
  await tx.$executeRawUnsafe(`SAVEPOINT ${savepoint}`);
  let failure: unknown;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${savepoint}`);
  expect(failure).toBeDefined();
  expect(String(failure)).toContain(message);
}
