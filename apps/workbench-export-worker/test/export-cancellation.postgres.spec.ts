import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { PrismaClient } from "@workbench/workbench-db";
import { buildExport } from "@workbench/workbench-export-core";
import { AccessService } from "../../workbench-api/src/modules/access/access.service.js";
import { ExportsService } from "../../workbench-api/src/modules/exports/exports.service.js";
import { exportRequest } from "../../../packages/workbench-export-core/test/fixtures.js";
import { describe, expect, it, vi } from "vitest";
import { BrowserExportService } from "../src/browser/browser-export.service.js";
import { ExportProcessor } from "../src/export/export.processor.js";
import { PrismaExportStore } from "../src/export/export.store.js";
import { S3ExportStorageAdapter } from "../src/storage/s3-export-storage.adapter.js";

const databaseUrl = process.env.WORKBENCH_EXPORT_CANCELLATION_TEST_DATABASE_URL;
const chromiumExecutablePath = process.env.WORKBENCH_EXPORT_CHROMIUM_PATH
  ?? "/Users/harry/Library/Caches/ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-mac-arm64/chrome-headless-shell";
const suite = databaseUrl && existsSync(chromiumExecutablePath) ? describe : describe.skip;

suite("export cancellation PostgreSQL and browser fixture", () => {
  it("aborts an S3 write after API cancellation and only then publishes cancelled", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    let ownerId: string | undefined;
    let workspaceId: string | undefined;
    let projectId: string | undefined;
    let boardId: string | undefined;
    let releaseId: string | undefined;
    let exportJobId: string | undefined;
    let outputSha256: string | undefined;
    let processing: Promise<unknown> | undefined;
    let controller: AbortController | undefined;
    let releasePut = () => undefined;
    const objects = new Map<string, Buffer>();
    let putEntered!: () => void;
    const putStarted = new Promise<void>((resolve) => { putEntered = resolve; });

    const client = {
      send: vi.fn(async (command: unknown, options?: { abortSignal?: AbortSignal }) => {
        if (command instanceof HeadObjectCommand) {
          const object = objects.get(command.input.Key!);
          if (!object) throw { name: "NotFound" };
          return {
            ContentLength: object.byteLength,
            ContentType: "text/html; charset=utf-8",
            Metadata: {},
          };
        }
        if (command instanceof PutObjectCommand) {
          putEntered();
          const signal = options?.abortSignal;
          await new Promise<void>((resolve, reject) => {
            let settled = false;
            const finish = (callback: () => void) => {
              if (settled) return;
              settled = true;
              signal?.removeEventListener("abort", onAbort);
              callback();
            };
            const onAbort = () => finish(() => reject(signal?.reason ?? new Error("EXPORT_ABORTED")));
            if (signal?.aborted) {
              onAbort();
              return;
            }
            signal?.addEventListener("abort", onAbort, { once: true });
            releasePut = () => finish(resolve);
          });
          const body = command.input.Body;
          objects.set(command.input.Key!, Buffer.from(body as Uint8Array));
          return {};
        }
        throw new Error("UNEXPECTED_S3_COMMAND");
      }),
    };

    try {
      const fixture = await db.$transaction(async (tx) => {
        const owner = await tx.principal.create({ data: { issuer: "export-cancel-fixture", subject: suffix } });
        const workspace = await tx.workspace.create({ data: { slug: `export-cancel-${suffix}`, name: "Export cancellation", createdById: owner.id } });
        await tx.workspaceMember.create({ data: { workspaceId: workspace.id, principalId: owner.id, role: "owner" } });
        const project = await tx.project.create({ data: { workspaceId: workspace.id, createdById: owner.id, title: "Export cancellation" } });
        await tx.projectMember.create({ data: { projectId: project.id, workspaceId: workspace.id, principalId: owner.id, role: "owner" } });
        const board = await tx.board.create({ data: { projectId: project.id, viewport: { x: 0, y: 0, zoom: 1 } } });
        const boardSnapshot = {
          id: board.id,
          projectId: project.id,
          revision: board.revision,
          viewport: { x: 0, y: 0, zoom: 1 },
          nodes: [],
          edges: [],
        };
        const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
        const manifest = {
          protocol: "workbench.project-release.v1",
          projectId: project.id,
          releaseVersion: 1,
          board: { id: board.id, revision: board.revision, checksum: digest(boardSnapshot) },
          artifacts: [],
        };
        const release = await tx.projectRelease.create({
          data: {
            projectId: project.id,
            version: 1,
            createdById: owner.id,
            idempotencyKey: suffix,
            requestHash: "a".repeat(64),
            boardId: board.id,
            boardRevision: board.revision,
            boardSnapshot,
            boardChecksum: digest(boardSnapshot),
            manifest,
            manifestSha256: digest(manifest),
          },
        });
        await tx.projectRelease.update({ where: { id: release.id }, data: { status: "ready", finishedAt: new Date() } });
        const job = await tx.exportJob.create({
          data: {
            releaseId: release.id,
            createdById: owner.id,
            idempotencyKey: suffix,
            requestHash: "b".repeat(64),
            format: "html",
            packaging: "single_file",
            selectionKind: "release",
            options: {},
          },
        });
        return {
          ownerId: owner.id,
          workspaceId: workspace.id,
          projectId: project.id,
          boardId: board.id,
          releaseId: release.id,
          exportJobId: job.id,
        };
      }, { timeout: 60_000 });
      ({ ownerId, workspaceId, projectId, boardId, releaseId, exportJobId } = fixture);

      await expect(db.exportJob.update({
        where: { id: exportJobId },
        data: { status: "cancelled", finishedAt: new Date(), revision: 1 },
      })).rejects.toThrow("EXPORT_JOB_STATUS_TRANSITION_INVALID");

      const store = new PrismaExportStore(db, {
        pendingBlobPrefix: "pending/exports",
        canonicalBlobPrefix: "blobs",
      });
      const request = exportRequest();
      const expectedOutput = await buildExport(request);
      outputSha256 = createHash("sha256").update(expectedOutput.bytes).digest("hex");
      vi.spyOn(store, "loadRunning").mockResolvedValue({
        id: exportJobId!,
        createdById: ownerId!,
        format: "html",
        packaging: "single_file",
        selection: request.selection,
        options: {},
        purpose: "export",
        release: {},
        preview: null,
      } as never);
      const storage = new S3ExportStorageAdapter({
        s3Bucket: "workbench",
        s3Region: "us-east-1",
        s3InternalEndpoint: "http://127.0.0.1:9000",
        s3ForcePathStyle: true,
        s3ConditionalCreateMode: "s3-if-none-match",
        exportS3AccessKeyId: "fixture-access",
        exportS3SecretAccessKey: "fixture-secret",
      }, vi.fn(async () => undefined), client as never);
      const browser = new BrowserExportService({ chromiumExecutablePath, browserTimeoutMs: 20_000 });
      const processor = new ExportProcessor(
        store,
        { load: vi.fn(async () => request.source) } as never,
        storage,
        browser,
        { maximumOutputBytes: 50 * 1024 * 1024 },
      );
      const queue = { sendInTransaction: vi.fn().mockResolvedValue("export-cancel-job") };
      const service = new ExportsService(
        db as never,
        new AccessService(db as never),
        queue as never,
        {} as never,
        {} as never,
        { catalog: () => ({ formats: [] }) } as never,
      );
      controller = new AbortController();
      processing = processor.process(exportJobId, controller.signal, { retryCount: 0, retryLimit: 0 });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        putStarted,
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("EXPORT_S3_PUT_NOT_REACHED")), 30_000); }),
      ]);
      if (timeout) clearTimeout(timeout);

      const accepted = await service.cancel(ownerId, exportJobId, 1);
      expect(accepted).toMatchObject({ status: "cancelling", revision: 2, finishedAt: null });
      controller.abort(new Error("EXPORT_CANCEL_REQUESTED"));
      const result = await processing;
      expect(result).toMatchObject({ kind: "terminal", status: "cancelled" });
      expect(queue.sendInTransaction).toHaveBeenCalledWith(
        expect.anything(),
        "export.cancel",
        { exportJobId },
        { singletonKey: exportJobId },
      );
      const completed = await db.exportJob.findUniqueOrThrow({ where: { id: exportJobId } });
      expect(completed).toMatchObject({ status: "cancelled", outputBlobId: null });
      expect(completed.finishedAt).not.toBeNull();
      const blob = await db.blob.findUnique({ where: { sha256_generation: { sha256: outputSha256!, generation: 1 } } });
      expect(blob).toMatchObject({ status: "pending" });
      expect(blob?.gcEligibleAt).not.toBeNull();
      expect(objects).toHaveLength(0);
    } finally {
      controller?.abort(new Error("EXPORT_TEST_CLEANUP"));
      releasePut();
      await processing?.catch(() => undefined);
      if (db) {
        await db.$transaction(async (tx) => {
          await tx.$executeRawUnsafe('ALTER TABLE "export_jobs" DISABLE TRIGGER USER');
          await tx.$executeRawUnsafe('ALTER TABLE "project_releases" DISABLE TRIGGER USER');
          try {
            if (exportJobId) await tx.exportJob.deleteMany({ where: { id: exportJobId } });
            if (outputSha256) await tx.blob.deleteMany({ where: { sha256: outputSha256 } });
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
        }).catch(() => undefined);
        await db.$disconnect();
      }
    }

  }, 60_000);
});
