import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { PrismaClient } from "@workbench/workbench-db";
import { canonicalJson } from "@workbench/workbench-contracts";
import { describe, expect, it, vi } from "vitest";
import { S3ExportStorageAdapter } from "../src/storage/s3-export-storage.adapter.js";
import { PrismaExportStore } from "../src/export/export.store.js";

const databaseUrl = process.env.WORKBENCH_EXPORT_SHARED_OBJECT_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite("shared export object ownership on PostgreSQL", () => {
  it("keeps a concurrent publisher's canonical bytes when another verifier fails", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const suffix = randomUUID();
    let ownerId: string | undefined;
    let workspaceId: string | undefined;
    let projectId: string | undefined;
    let boardId: string | undefined;
    let releaseId: string | undefined;
    let exportJobId: string | undefined;
    let blobId: string | undefined;
    const bytes = Buffer.from(`shared export ${suffix}`);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const identity = {
      storageKey: "blobs/shared/output/g1",
      byteSize: bytes.byteLength,
      sha256,
      mediaType: "text/html; charset=utf-8",
    };
    const objects = new Map<string, Buffer>();
    let putAttempts = 0;
    let getAttempts = 0;
    let releaseSecondPut!: () => void;
    const secondPut = new Promise<void>((resolve) => { releaseSecondPut = resolve; });
    const client = {
      send: vi.fn(async (command: unknown) => {
        if (command instanceof HeadObjectCommand) {
          const object = objects.get(command.input.Key!);
          if (!object) throw { name: "NotFound" };
          return { ContentLength: object.byteLength, ContentType: identity.mediaType, Metadata: { sha256, "byte-size": String(object.byteLength) } };
        }
        if (command instanceof PutObjectCommand) {
          putAttempts += 1;
          const existed = objects.has(command.input.Key!);
          if (!existed) objects.set(command.input.Key!, Buffer.from(command.input.Body as Uint8Array));
          if (putAttempts === 2) releaseSecondPut();
          await secondPut;
          if (existed) throw { name: "PreconditionFailed" };
          return {};
        }
        if (command instanceof GetObjectCommand) {
          getAttempts += 1;
          const object = objects.get(command.input.Key!);
          if (!object) throw { name: "NoSuchKey" };
          const observed = getAttempts === 1 ? Buffer.alloc(object.byteLength, 7) : object;
          return { Body: Readable.from([observed]), ContentLength: observed.byteLength, ContentType: identity.mediaType };
        }
        throw new Error("UNEXPECTED_S3_COMMAND");
      }),
    };
    const storage = new S3ExportStorageAdapter({
      s3Bucket: "workbench",
      s3Region: "us-east-1",
      s3InternalEndpoint: "http://127.0.0.1:9000",
      s3ForcePathStyle: true,
      s3ConditionalCreateMode: "s3-if-none-match",
      exportS3AccessKeyId: "fixture-access",
      exportS3SecretAccessKey: "fixture-secret",
    }, vi.fn(async () => undefined), client as never);
    const store = new PrismaExportStore(db, { pendingBlobPrefix: "pending/exports", canonicalBlobPrefix: "blobs" });

    try {
      const fixture = await db.$transaction(async (tx) => {
        const owner = await tx.principal.create({ data: { issuer: "export-shared-object", subject: suffix } });
        const workspace = await tx.workspace.create({ data: { slug: `export-shared-${suffix}`, name: "Export shared object", createdById: owner.id } });
        await tx.workspaceMember.create({ data: { workspaceId: workspace.id, principalId: owner.id, role: "owner" } });
        const project = await tx.project.create({ data: { workspaceId: workspace.id, createdById: owner.id, title: "Shared export" } });
        await tx.projectMember.create({ data: { projectId: project.id, workspaceId: workspace.id, principalId: owner.id, role: "owner" } });
        const board = await tx.board.create({ data: { projectId: project.id, viewport: { x: 0, y: 0, zoom: 1 } } });
        const boardSnapshot = { id: board.id, projectId: project.id, revision: board.revision, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [] };
        const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value as never)).digest("hex");
        const manifest = { protocol: "workbench.project-release.v1", projectId: project.id, releaseVersion: 1, board: { id: board.id, revision: board.revision, checksum: digest(boardSnapshot) }, artifacts: [] };
        const release = await tx.projectRelease.create({ data: { projectId: project.id, version: 1, createdById: owner.id, idempotencyKey: suffix, requestHash: "a".repeat(64), boardId: board.id, boardRevision: board.revision, boardSnapshot, boardChecksum: digest(boardSnapshot), manifest, manifestSha256: digest(manifest) } });
        await tx.projectRelease.update({ where: { id: release.id }, data: { status: "ready", finishedAt: new Date() } });
        const job = await tx.exportJob.create({ data: { releaseId: release.id, createdById: owner.id, idempotencyKey: suffix, requestHash: "b".repeat(64), format: "html", packaging: "single_file", selectionKind: "release", options: {} } });
        return { ownerId: owner.id, workspaceId: workspace.id, projectId: project.id, boardId: board.id, releaseId: release.id, exportJobId: job.id };
      }, { timeout: 60_000 });
      ({ ownerId, workspaceId, projectId, boardId, releaseId, exportJobId } = fixture);
      const job = await db.exportJob.findUniqueOrThrow({ where: { id: exportJobId } });
      const started = await store.start(job.id);
      expect(started.kind).toBe("run");

      const first = await store.reserveOutput(identity);
      const second = await store.reserveOutput(identity);
      blobId = first.blobId;
      expect(second.blobId).toBe(first.blobId);
      const firstUpload = { ...identity, storageKey: first.storageKey };
      const secondUpload = { ...identity, storageKey: second.storageKey };
      const outcomes = await Promise.allSettled([
        storage.putVerified(firstUpload, bytes),
        storage.putVerified(secondUpload, bytes),
      ]);
      expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(1);
      await store.abandonOutput(first);
      await expect(store.publishSucceeded(job.id, second)).resolves.toBe("succeeded");
      expect(objects.get(first.storageKey)).toEqual(bytes);
      const persisted = await db.blob.findUniqueOrThrow({ where: { id: first.blobId } });
      const completed = await db.exportJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(persisted).toMatchObject({ status: "ready", storageKey: first.storageKey, sha256, byteSize: BigInt(bytes.byteLength) });
      expect(completed).toMatchObject({ status: "succeeded", outputBlobId: first.blobId });
    } finally {
      await db.$transaction(async (tx) => {
        // The fixture intentionally reaches a terminal ExportJob and Release.
        // Disable user triggers only inside this test cleanup transaction so
        // terminal immutability does not retain disposable rows.
        await tx.$executeRawUnsafe('ALTER TABLE "export_jobs" DISABLE TRIGGER USER');
        await tx.$executeRawUnsafe('ALTER TABLE "project_releases" DISABLE TRIGGER USER');
        try {
          if (exportJobId) await tx.exportJob.deleteMany({ where: { id: exportJobId } });
          if (blobId) await tx.blob.deleteMany({ where: { id: blobId } });
          if (releaseId) await tx.projectRelease.deleteMany({ where: { id: releaseId } });
          if (boardId) await tx.board.deleteMany({ where: { id: boardId } });
          if (projectId) {
            await tx.projectMember.deleteMany({ where: { projectId } });
            await tx.project.deleteMany({ where: { id: projectId } });
          }
          if (workspaceId) {
            await tx.workspaceMember.deleteMany({ where: { workspaceId } });
            await tx.workspace.deleteMany({ where: { id: workspaceId } });
          }
          if (ownerId) await tx.principal.deleteMany({ where: { id: ownerId } });
        } finally {
          await tx.$executeRawUnsafe('ALTER TABLE "project_releases" ENABLE TRIGGER USER');
          await tx.$executeRawUnsafe('ALTER TABLE "export_jobs" ENABLE TRIGGER USER');
        }
      });
      await db.$disconnect();
    }
  }, 60_000);
});
