import { randomUUID } from "node:crypto";
import { PrismaClient } from "@workbench/workbench-db";
import { AccessService } from "../src/modules/access/access.service.js";
import { FileApiConfig } from "../src/modules/files/file-api.config.js";
import { FileUploadsService } from "../src/modules/files/file-uploads.service.js";
import { ImportSourcesService } from "../src/modules/import-sources/import-sources.service.js";
import { RunEventStore } from "../src/modules/runs/run-event.store.js";
import { RunsService } from "../src/modules/runs/runs.service.js";
import { SubmissionIntentsService } from "../src/modules/submission-intents/submission-intents.service.js";
import type { MultipartStoragePort } from "../src/platform/object-storage/object-storage.port.js";

import { seedReadyKnowledge } from "../../../scripts/test-support/knowledge-fixture.mjs";

const databaseUrl = process.env.WORKBENCH_TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("SubmissionIntent PostgreSQL vertical slice", () => {
  it("recovers upload intent state across refresh and submits one Run concurrently", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl });
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const principalIds: string[] = [];
    let workspaceId: string | undefined;
    let blobId: string | undefined;

    try {
      const [owner, editor] = await Promise.all([
        db.principal.create({
          data: { issuer: `submission-intent-${suffix}`, subject: `owner-${suffix}` },
        }),
        db.principal.create({
          data: { issuer: `submission-intent-${suffix}`, subject: `editor-${suffix}` },
        }),
      ]);
      principalIds.push(owner.id, editor.id);
      const workspace = await db.workspace.create({
        data: {
          slug: `submission-intent-${suffix}`,
          name: "Submission intent integration",
          createdById: owner.id,
        },
      });
      workspaceId = workspace.id;
      await db.workspaceMember.createMany({
        data: [
          { workspaceId: workspace.id, principalId: owner.id, role: "owner" },
          { workspaceId: workspace.id, principalId: editor.id, role: "member" },
        ],
      });
      const project = await db.$transaction(async (tx) => {
        const created = await tx.project.create({
          data: {
            workspaceId: workspace.id,
            createdById: owner.id,
            title: "Durable submission recovery",
          },
        });
        await tx.projectMember.create({
          data: {
            projectId: created.id,
            workspaceId: workspace.id,
            principalId: owner.id,
            role: "owner",
          },
        });
        return created;
      });
      await db.projectMember.create({
        data: {
            projectId: project.id,
            workspaceId: workspace.id,
            principalId: editor.id,
            role: "editor",
          },
      });
      const thread = await db.thread.create({
        data: { projectId: project.id, createdById: owner.id, title: "Main" },
      });

      const access = new AccessService(db as never);
      const queue = { sendInTransaction: vi.fn().mockResolvedValue("job_submission") };
      const runtimeModels = { assertAvailable: vi.fn().mockResolvedValue(undefined) };
      const importSources = new ImportSourcesService(db as never, access);
      const runs = new RunsService(
        db as never,
        access,
        new RunEventStore(db as never),
        queue as never,
        runtimeModels as never,
        { resolve: vi.fn() } as never,
      );
      const intents = new SubmissionIntentsService(
        db as never,
        access,
        runs,
        runtimeModels as never,
        importSources,
      );
      const storage = multipartStorage();
      const uploads = new FileUploadsService(
        db as never,
        storage,
        queue as never,
        fileConfig(),
      );
      const durableRequest = {
        prompt: "Redesign the uploaded product screen",
        modelId: "quality",
        workflow: "redesign" as const,
        targetSurface: "web" as const,
        designStyle: { kind: "automatic" as const },
        artifactTargets: [],
        requestedArtifactKinds: ["prototype" as const],
      };
      const attachment = {
        kind: "upload" as const,
        clientFingerprint: "submission-file:slot_1",
        fileName: "中文 产品截图.png",
        declaredMediaType: "image/png",
        byteSize: 1_024,
        lastModified: 1_786_771_200_000,
      };

      const created = await intents.create(
        owner.id,
        thread.id,
        `intent:create:${suffix}`,
        { request: durableRequest, attachments: [attachment] },
      );
      await expect(intents.create(
        owner.id,
        thread.id,
        `intent:create:${suffix}`,
        { request: durableRequest, attachments: [attachment] },
      )).resolves.toMatchObject({ id: created.id, revision: 0 });

      const refreshedIntents = new SubmissionIntentsService(
        db as never,
        new AccessService(db as never),
        runs,
        runtimeModels as never,
        importSources,
      );
      await expect(refreshedIntents.current(owner.id, thread.id)).resolves.toMatchObject({
        item: {
          id: created.id,
          request: durableRequest,
          attachments: [{
            kind: "upload",
            position: 0,
            fileAssetId: null,
            fileStatus: null,
            clientFingerprint: attachment.clientFingerprint,
            fileName: attachment.fileName,
            lastModified: attachment.lastModified,
          }],
        },
      });
      await expect(refreshedIntents.current(editor.id, thread.id)).resolves.toEqual({ item: null });
      await expect(refreshedIntents.get(editor.id, created.id)).rejects.toMatchObject({ status: 404 });

      const binding = {
        submissionIntentId: created.id,
        attachmentPosition: 0,
        clientFingerprint: attachment.clientFingerprint,
      };
      await expect(uploads.create(
        editor.id,
        project.id,
        `upload:foreign:${suffix}`,
        {
          fileName: attachment.fileName,
          declaredMediaType: attachment.declaredMediaType,
          byteSize: attachment.byteSize,
          submissionIntent: binding,
        },
      )).rejects.toMatchObject({ status: 404 });
      await expect(uploads.create(
        owner.id,
        project.id,
        `upload:unknown:${suffix}`,
        {
          fileName: attachment.fileName,
          declaredMediaType: attachment.declaredMediaType,
          byteSize: attachment.byteSize,
          submissionIntent: { ...binding, attachmentPosition: 1 },
        },
      )).rejects.toMatchObject({ status: 404 });
      await expect(uploads.create(
        owner.id,
        project.id,
        `upload:mismatch:${suffix}`,
        {
          fileName: "不匹配.png",
          declaredMediaType: attachment.declaredMediaType,
          byteSize: attachment.byteSize,
          submissionIntent: binding,
        },
      )).rejects.toMatchObject({
        status: 409,
        response: expect.objectContaining({ code: "SUBMISSION_INTENT_UPLOAD_BINDING_MISMATCH" }),
      });

      const uploadRequest = {
        fileName: attachment.fileName,
        declaredMediaType: attachment.declaredMediaType,
        byteSize: attachment.byteSize,
        submissionIntent: binding,
      };
      const upload = await uploads.create(
        owner.id,
        project.id,
        `upload:create:${suffix}`,
        uploadRequest,
      );
      const uploadReplay = await uploads.create(
        owner.id,
        project.id,
        `upload:create:${suffix}`,
        uploadRequest,
      );
      expect(uploadReplay.file.id).toBe(upload.file.id);
      expect(storage.createMultipartUpload).toHaveBeenCalledTimes(1);
      await expect(refreshedIntents.current(owner.id, thread.id)).resolves.toMatchObject({
        item: {
          attachments: [{ fileAssetId: upload.file.id, fileStatus: "uploading" }],
        },
      });

      const verifiedAt = new Date();
      const contentSha256 = randomUUID().replaceAll("-", "").padEnd(64, "a");
      const blob = await db.blob.create({
        data: {
          id: `blob_${randomUUID()}`,
          sha256: contentSha256,
          storageKey: `submission-intent/${suffix}/source.png`,
          mediaType: "image/png",
          byteSize: BigInt(attachment.byteSize),
          status: "ready",
          verifiedAt,
        },
      });
      blobId = blob.id;
      await db.blobScan.create({
        data: {
          blobId: blob.id,
          attempt: 1,
          status: "clean",
          scanner: "test-scanner",
          scannerVersion: "1.0.0",
          signatureVersion: "test-signatures",
          evidence: { clean: true },
          finishedAt: verifiedAt,
        },
      });
      await db.fileAsset.update({
        where: { id: upload.file.id },
        data: { status: "verifying", revision: { increment: 1 } },
      });
      await db.fileAsset.update({
        where: { id: upload.file.id },
        data: {
          status: "ready",
          blobId: blob.id,
          detectedMediaType: "image/png",
          verifiedAt,
          revision: { increment: 1 },
        },
      });
      await expect(refreshedIntents.current(owner.id, thread.id)).resolves.toMatchObject({
        item: { attachments: [{ fileAssetId: upload.file.id, fileStatus: "ready" }] },
      });

      await db.$transaction((tx) => seedReadyKnowledge(tx));
      const [firstReceipt, secondReceipt] = await Promise.all([
        intents.submit(owner.id, created.id),
        refreshedIntents.submit(owner.id, created.id),
      ]);
      expect(firstReceipt.run.id).toBe(secondReceipt.run.id);
      expect(firstReceipt.intent).toMatchObject({
        id: created.id,
        status: "submitted",
        runId: firstReceipt.run.id,
      });
      expect(firstReceipt.run.sources).toMatchObject([{
        position: 0,
        kind: "file",
        descriptor: {
          fileAssetId: upload.file.id,
          originalName: attachment.fileName,
        },
      }]);
      await expect(db.run.count({
        where: { threadId: thread.id, idempotencyKey: { startsWith: "submission-intent:" } },
      })).resolves.toBe(1);
      await expect(refreshedIntents.current(owner.id, thread.id)).resolves.toEqual({ item: null });
      await expect(refreshedIntents.submit(editor.id, created.id)).rejects.toMatchObject({ status: 404 });

      const cancellable = await intents.create(
        owner.id,
        thread.id,
        `intent:cancel:${suffix}`,
        {
          request: {
            ...durableRequest,
            prompt: "Prepare a later follow-up",
            workflow: "generate",
          },
          attachments: [],
        },
      );
      await expect(intents.cancel(owner.id, cancellable.id, cancellable.revision + 1))
        .rejects.toMatchObject({ status: 412 });
      await intents.cancel(owner.id, cancellable.id, cancellable.revision);
      await expect(intents.get(owner.id, cancellable.id)).resolves.toMatchObject({
        status: "cancelled",
        cancelledAt: expect.any(String),
      });

      const constrained = await intents.create(
        owner.id,
        thread.id,
        `intent:constraints:${suffix}`,
        {
          request: {
            ...durableRequest,
            prompt: "Keep this pending for constraint checks",
            workflow: "generate",
          },
          attachments: [],
        },
      );
      await expect(db.submissionIntent.create({
        data: {
          projectId: project.id,
          threadId: thread.id,
          createdById: owner.id,
          request: constrained.request,
          requestHash: "b".repeat(64),
          idempotencyKey: `intent:duplicate-active:${suffix}`,
          runIdempotencyKey: `intent:duplicate-run:${suffix}`,
        },
      })).rejects.toBeDefined();
      await expect(db.submissionIntent.update({
        where: { id: constrained.id },
        data: {
          request: { ...constrained.request, prompt: "Mutated" },
          revision: { increment: 1 },
        },
      })).rejects.toBeDefined();
      await expect(db.submissionIntentAttachment.create({
        data: {
          submissionIntentId: constrained.id,
          projectId: project.id,
          position: 0,
          kind: "existing",
        },
      })).rejects.toBeDefined();
      await expect(db.submissionIntent.create({
        data: {
          projectId: project.id,
          threadId: thread.id,
          createdById: editor.id,
          status: "submitted",
          request: constrained.request,
          requestHash: "c".repeat(64),
          idempotencyKey: `intent:invalid-terminal:${suffix}`,
          runIdempotencyKey: `intent:invalid-terminal-run:${suffix}`,
        },
      })).rejects.toBeDefined();
    } finally {
      if (workspaceId) {
        await db.fileAsset.updateMany({
          where: { project: { workspaceId }, status: { not: "deleted" } },
          data: {
            status: "deleted",
            deletedAt: new Date(),
            revision: { increment: 1 },
          },
        }).catch(() => undefined);
        await db.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
      }
      if (blobId) {
        const deletedAt = new Date();
        await db.blob.update({
          where: { id: blobId },
          data: { status: "deleted", deletedAt, storageDeletedAt: deletedAt },
        }).catch(() => undefined);
      }
      if (principalIds.length > 0) {
        await db.principal.deleteMany({ where: { id: { in: principalIds } } }).catch(() => undefined);
      }
      await db.$disconnect();
    }
  }, 60_000);
});

function multipartStorage(): MultipartStoragePort & Record<string, ReturnType<typeof vi.fn>> {
  return {
    createMultipartUpload: vi.fn().mockResolvedValue({ uploadId: `provider_${randomUUID()}` }),
    signMultipartPart: vi.fn(),
    listMultipartParts: vi.fn(),
    completeMultipartUpload: vi.fn(),
    abortMultipartUpload: vi.fn(),
    statObject: vi.fn(),
  } as never;
}

function fileConfig(): FileApiConfig {
  return {
    stagingPrefix: "test/submission-intents",
    preferredPartSize: 8 * 1024 * 1024,
    sessionTtlSeconds: 86_400,
    signedUrlTtlSeconds: 900,
  } as FileApiConfig;
}
