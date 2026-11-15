import { createHash } from "node:crypto";
import { PrismaClient } from "@workbench/workbench-db";
import { ArtifactsService } from "../src/modules/artifacts/artifacts.service.js";

const databaseUrl = process.env.WORKBENCH_TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("Image edits preserve immutable verified versions", () => {
  it("publishes a verified image version with CAS, replay, authorization and blob source validation", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl });
    const rollback = new Error("ROLLBACK_IMAGE_EDIT_TEST");
    let passed = false;
    try {
      await db.$transaction(
        async (tx) => {
          const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
          const owner = await tx.principal.create({
            data: { issuer: `image-edit-${suffix}`, subject: "owner" },
          });
          const viewer = await tx.principal.create({
            data: { issuer: `image-edit-${suffix}`, subject: "viewer" },
          });
          const workspace = await tx.workspace.create({
            data: {
              slug: `image-edit-${suffix}`,
              name: "Image edits",
              createdById: owner.id,
            },
          });
          await tx.workspaceMember.createMany({
            data: [
              {
                workspaceId: workspace.id,
                principalId: owner.id,
                role: "owner",
              },
              {
                workspaceId: workspace.id,
                principalId: viewer.id,
                role: "member",
              },
            ],
          });
          const project = await tx.project.create({
            data: {
              workspaceId: workspace.id,
              createdById: owner.id,
              title: "Image versions",
            },
          });
          const other = await tx.project.create({
            data: {
              workspaceId: workspace.id,
              createdById: owner.id,
              title: "Other project",
            },
          });
          await tx.projectMember.createMany({
            data: [
              {
                projectId: project.id,
                workspaceId: workspace.id,
                principalId: owner.id,
                role: "owner",
              },
              {
                projectId: project.id,
                workspaceId: workspace.id,
                principalId: viewer.id,
                role: "viewer",
              },
              {
                projectId: other.id,
                workspaceId: workspace.id,
                principalId: owner.id,
                role: "owner",
              },
            ],
          });
          const makeFile = async (
            key: string,
            scope = project.id,
            mediaType = "image/png",
            status: "ready" | "verifying" = "ready",
          ) => {
            const bytes = Buffer.from(`${suffix}-${key}`),
              sha256 = createHash("sha256").update(bytes).digest("hex");
            const blob = await tx.blob.create({
              data: {
                sha256,
                storageKey: `image-edit/${suffix}/${key}`,
                mediaType,
                byteSize: BigInt(bytes.length),
                status: "ready",
                verifiedAt: new Date(),
              },
            });
            await tx.blobScan.create({
              data: {
                blobId: blob.id,
                attempt: 1,
                status: "clean",
                scanner: "test",
                scannerVersion: "1",
                signatureVersion: "1",
                evidence: { result: "clean" },
                startedAt: new Date(),
                finishedAt: new Date(),
              },
            });
            const file = await tx.fileAsset.create({
              data: {
                projectId: scope,
                blobId: blob.id,
                uploadedById: owner.id,
                originalName: key + ".png",
                declaredMediaType: mediaType,
                detectedMediaType: mediaType,
                byteSize: blob.byteSize,
                status,
                verifiedAt: status === "ready" ? new Date() : null,
              },
            });
            return { file, blob };
          };
          const original = await makeFile("original"),
            edited = await makeFile("edited"),
            foreign = await makeFile("foreign", other.id),
            unsupported = await makeFile(
              "unsupported",
              project.id,
              "text/plain",
            ),
            pending = await makeFile(
              "pending",
              project.id,
              "image/png",
              "verifying",
            );
          const host = new Proxy(tx, {
            get(target, name) {
              return name === "$transaction"
                ? async (callback: (tx: typeof target) => unknown) =>
                    callback(target)
                : Reflect.get(target, name);
            },
          });
          const service = new ArtifactsService(host as never, {} as never);
          const created = await service.create(
            owner.id,
            project.id,
            `image:create-${suffix}`,
            {
              kind: "image",
              title: "Original",
              source: { kind: "file", fileAssetId: original.file.id },
            },
          );
          const a = created.artifact,
            base = created.artifactVersion;
          const command = {
            kind: "image" as const,
            baseArtifactVersionId: base.artifactVersionId,
            source: { kind: "file" as const, fileAssetId: edited.file.id },
          };
          await expect(
            service.createVersion(
              viewer.id,
              a.id,
              a.revision,
              `image:viewer-${suffix}`,
              command,
            ),
          ).rejects.toMatchObject({ status: 404 });
          for (const file of [foreign.file, pending.file]) {
            await expect(
              service.createVersion(
                owner.id,
                a.id,
                a.revision,
                `image:bad-${file.id}`,
                { ...command, source: { kind: "file", fileAssetId: file.id } },
              ),
            ).rejects.toMatchObject({
              status: 409,
              response: expect.objectContaining({
                code: "ARTIFACT_SOURCE_FILE_NOT_READY",
              }),
            });
          }
          await expect(
            service.createVersion(
              owner.id,
              a.id,
              a.revision,
              `image:type-${suffix}`,
              {
                ...command,
                source: { kind: "file", fileAssetId: unsupported.file.id },
              },
            ),
          ).rejects.toMatchObject({
            status: 409,
            response: expect.objectContaining({
              code: "ARTIFACT_SOURCE_MEDIA_TYPE_UNSUPPORTED",
            }),
          });
          await expect(
            service.createVersion(
              owner.id,
              a.id,
              a.revision + 1,
              `image:cas-${suffix}`,
              command,
            ),
          ).rejects.toMatchObject({ status: 412 });
          expect(
            await tx.artifactVersion.count({ where: { artifactId: a.id } }),
          ).toBe(1);
          const key = `image:edit-${suffix}`;
          const result = await service.createVersion(
            owner.id,
            a.id,
            a.revision,
            key,
            command,
          );
          expect(result.artifactRevision).toBe(a.revision + 1);
          expect(result.detail).toMatchObject({
            kind: "image",
            contentMode: "blob",
            version: 2,
            checksum: edited.blob.sha256,
            blob: { blobId: edited.blob.id, sha256: edited.blob.sha256 },
          });
          expect(
            await service.createVersion(
              owner.id,
              a.id,
              a.revision,
              key,
              command,
            ),
          ).toEqual(result);
          await expect(
            service.createVersion(owner.id, a.id, a.revision, key, {
              ...command,
              source: { kind: "file", fileAssetId: original.file.id },
            }),
          ).rejects.toMatchObject({ status: 409 });
          await expect(
            service.createVersion(
              owner.id,
              a.id,
              result.artifactRevision,
              `image:stale-${suffix}`,
              command,
            ),
          ).rejects.toMatchObject({
            status: 409,
            response: expect.objectContaining({
              code: "ARTIFACT_VERSION_BASE_NOT_CURRENT",
            }),
          });
          expect(
            await tx.artifactVersion.count({ where: { artifactId: a.id } }),
          ).toBe(2);
          expect(
            await tx.artifactVersion.findUnique({
              where: { id: base.artifactVersionId },
            }),
          ).toMatchObject({
            checksum: original.blob.sha256,
            contentBlobId: original.blob.id,
            status: "ready",
          });
          const receipt = await tx.artifactVersionEditReceipt.findUniqueOrThrow(
            {
              where: {
                resultArtifactVersionId: result.detail.artifactVersionId,
              },
            },
          );
          expect(receipt.baseArtifactVersionId).toBe(base.artifactVersionId);
          await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
          await tx.$executeRawUnsafe("SET CONSTRAINTS ALL DEFERRED");
          await tx.$executeRawUnsafe("SAVEPOINT immutable_image_version");
          await expect(
            tx.artifactVersion.update({
              where: { id: base.artifactVersionId },
              data: { checksum: edited.blob.sha256 },
            }),
          ).rejects.toThrow();
          await tx.$executeRawUnsafe(
            "ROLLBACK TO SAVEPOINT immutable_image_version",
          );
          await tx.$executeRawUnsafe("SAVEPOINT immutable_image_receipt");
          await expect(
            tx.artifactVersionEditReceipt.update({
              where: { id: receipt.id },
              data: { requestHash: "f".repeat(64) },
            }),
          ).rejects.toThrow();
          await tx.$executeRawUnsafe(
            "ROLLBACK TO SAVEPOINT immutable_image_receipt",
          );
          const creationReplay = await service.create(owner.id, project.id, `image:create-${suffix}`, {
            kind: "image", title: "Original", source: {kind: "file", fileAssetId: original.file.id},
          });
          expect(creationReplay.artifactVersion.artifactVersionId).toBe(base.artifactVersionId);
          expect(creationReplay.artifact.currentVersion?.artifactVersionId).toBe(result.detail.artifactVersionId);
          passed = true;
          throw rollback;
        },
        { timeout: 30_000 },
      );
    } catch (error) {
      if (error !== rollback) throw error;
    } finally {
      await db.$disconnect();
    }
    expect(passed).toBe(true);
  });
});
