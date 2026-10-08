import { Prisma, PrismaClient } from "@workbench/workbench-db";
import {
  boardNodeProtocol,
  prototypeDocumentSchema,
} from "@workbench/workbench-contracts";
import {
  parseRetrievalProfileV1,
  type RetrievalProfileV1,
} from "@workbench/workbench-knowledge";
import { AccessService } from "../src/modules/access/access.service.js";
import { ProjectDuplicatesService } from "../src/modules/projects/project-duplicates.service.js";
import { ProjectsService } from "../src/modules/projects/projects.service.js";
import { canonicalSha256 } from "../src/modules/releases/release.mapper.js";
import { SharesService } from "../src/modules/shares/shares.service.js";
import { seedPrototypeRelease } from "./prototype-release.fixture.js";

const databaseUrl = process.env.WORKBENCH_TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("Project lifecycle PostgreSQL transaction", () => {
  it("duplicates a private snapshot with fresh ownership and no conversation history", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl });
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const rollback = new Error("ROLLBACK_PROJECT_LIFECYCLE_POSTGRES_TEST");
    let verified = false;

    try {
      await db.$transaction(async (tx) => {
        const owner = await tx.principal.create({
          data: {
            issuer: `project-test-${suffix}`,
            subject: `owner-${suffix}`,
          },
        });
        const viewer = await tx.principal.create({
          data: {
            issuer: `project-test-${suffix}`,
            subject: `viewer-${suffix}`,
          },
        });
        const workspace = await tx.workspace.create({
          data: {
            slug: `project-test-${suffix}`,
            name: "Project lifecycle integration",
            createdById: owner.id,
          },
        });
        await tx.workspaceMember.createMany({
          data: [
            { workspaceId: workspace.id, principalId: owner.id, role: "owner" },
            {
              workspaceId: workspace.id,
              principalId: viewer.id,
              role: "member",
            },
          ],
        });
        const source = await tx.project.create({
          data: {
            workspaceId: workspace.id,
            createdById: owner.id,
            title: "Private source",
            summary: "Snapshot source",
          },
        });
        await tx.projectMember.createMany({
          data: [
            {
              projectId: source.id,
              workspaceId: workspace.id,
              principalId: owner.id,
              role: "owner",
            },
            {
              projectId: source.id,
              workspaceId: workspace.id,
              principalId: viewer.id,
              role: "viewer",
            },
          ],
        });
        const sourceBoard = await tx.board.create({
          data: { projectId: source.id, viewport: { x: 1, y: 2, zoom: 0.75 } },
        });
        const sourceBlob = await tx.blob.create({
          data: {
            sha256: "a".repeat(64),
            storageKey: `project-duplicate/${suffix}/hero.png`,
            mediaType: "image/png",
            byteSize: 256n,
            status: "ready",
            verifiedAt: new Date(),
          },
        });
        const embeddingProfileId =
          `project-duplicate-embedding-${suffix}`.toLowerCase();
        const embeddingProfileSpec = {
          schema: "workbench.embedding-profile.v1",
          id: embeddingProfileId,
          protocol: "tei.embed.v1",
          engine: {
            id: "project-test-tei",
            version: "1.0.0",
            imageDigest: `sha256:${"1".repeat(64)}`,
          },
          model: {
            id: "project-test/model",
            revision: "revision-1",
            artifactSha256: "2".repeat(64),
          },
          tokenizer: {
            id: "project-test/tokenizer",
            revision: "revision-1",
            artifactSha256: "3".repeat(64),
            modelMaximumTokens: 64,
            chunkMaximumTokens: 32,
            overflow: "reject",
          },
          input: {
            queryPrefix: "",
            documentPrefix: "",
            normalization: "utf8-nfc-lf-v1",
          },
          output: {
            dimension: 3,
            dtype: "float32",
            pooling: "cls",
            normalization: "l2",
            distance: "cosine",
          },
          batch: { maximumInputs: 2, maximumTokens: 64 },
          conformanceProbeSha256: "4".repeat(64),
        };
        const embeddingProfileSpecSha256 =
          canonicalSha256(embeddingProfileSpec);
        await tx.embeddingProfile.create({
          data: {
            id: embeddingProfileId,
            spec: embeddingProfileSpec,
            specSha256: embeddingProfileSpecSha256,
            dimension: 3,
          },
        });
        await tx.embeddingProfile.update({
          where: { id: embeddingProfileId },
          data: { status: "poc" },
        });
        await tx.embeddingProfile.update({
          where: { id: embeddingProfileId },
          data: { status: "adopted" },
        });
        const retrievalProfile = parseRetrievalProfileV1(
          projectRetrievalSpec(
            `project-duplicate-retrieval-${suffix}`.toLowerCase(),
            embeddingProfileId,
            embeddingProfileSpecSha256,
          ),
        );
        await tx.retrievalProfile.create({
          data: {
            id: retrievalProfile.spec.id,
            spec: retrievalProfile.spec as unknown as Prisma.InputJsonValue,
            specSha256: retrievalProfile.specSha256,
            embeddingProfileId: retrievalProfile.embeddingProfileId,
            embeddingProfileSpecSha256:
              retrievalProfile.embeddingProfileSpecSha256,
            embeddingDimension: retrievalProfile.embeddingDimension,
          },
        });
        await tx.retrievalProfile.update({
          where: { id: retrievalProfile.spec.id },
          data: { status: "poc" },
        });
        await tx.retrievalProfile.update({
          where: { id: retrievalProfile.spec.id },
          data: { status: "adopted" },
        });
        const knowledgeManifest = {
          protocol: "workbench.knowledge-release.v1",
          documents: [],
          profile: {
            embedding: {
              id: embeddingProfileId,
              specSha256: embeddingProfileSpecSha256,
            },
            retrieval: {
              id: retrievalProfile.spec.id,
              specSha256: retrievalProfile.specSha256,
            },
            segmenter: {
              id: retrievalProfile.spec.segmenter.implementationId,
              version: retrievalProfile.spec.segmenter.version,
              dictionaryChecksum:
                retrievalProfile.spec.segmenter.dictionarySha256,
              stopwordsChecksum:
                retrievalProfile.spec.segmenter.stopwordsSha256,
            },
          },
        };
        const knowledgeRelease = await tx.knowledgeRelease.create({
          data: {
            key: `project-duplicate-${suffix}`,
            workspaceId: workspace.id,
            version: 1,
            status: "ready",
            embeddingProfileId,
            embeddingProfileSpecSha256,
            embeddingDimension: 3,
            retrievalProfileId: retrievalProfile.spec.id,
            retrievalProfileSpecSha256: retrievalProfile.specSha256,
            manifest: knowledgeManifest,
            manifestSha256: canonicalSha256(knowledgeManifest),
            chunksReadyAt: new Date(),
            readyAt: new Date(),
          },
        });
        const sourceArtifactId = `artifact_${suffix}`;
        const sourceVersionId = `version_${suffix}`;
        const sourceArtifact = await tx.artifact.create({
          data: {
            id: sourceArtifactId,
            projectId: source.id,
            kind: "prototype",
            title: "Current prototype",
          },
        });
        const sourceAsset = {
          id: "hero-image",
          kind: "image",
          name: "Hero",
          blobId: sourceBlob.id,
          mediaType: sourceBlob.mediaType,
          byteSize: Number(sourceBlob.byteSize),
          sha256: sourceBlob.sha256,
          width: 16,
          height: 16,
        };
        const literal = (value: number) => ({
          kind: "literal" as const,
          value,
        });
        const nodeBase = (id: string, parentId: string | null) => ({
          id,
          screenId: "screen-home",
          parentId,
          name: id,
          visible: true,
          layout: {
            mode: "absolute" as const,
            x: literal(0),
            y: literal(0),
            width: literal(390),
            height: literal(844),
            display: "flex" as const,
            direction: "column" as const,
            gap: literal(0),
            padding: {
              top: literal(0),
              right: literal(0),
              bottom: literal(0),
              left: literal(0),
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
        });
        const sourceContent = prototypeDocumentSchema.parse({
          protocol: "workbench.prototype.v1",
          documentId: sourceArtifactId,
          title: "Private prototype",
          revision: 1,
          screens: [
            {
              id: "screen-home",
              name: "Home",
              route: "/",
              rootNodeId: "frame-root",
              initialStateId: null,
              viewport: { width: 390, height: 844 },
            },
          ],
          nodes: [
            {
              ...nodeBase("frame-root", null),
              kind: "frame",
              childIds: ["image-hero"],
              clipContent: true,
            },
            {
              ...nodeBase("image-hero", "frame-root"),
              kind: "image",
              assetId: sourceAsset.id,
              fit: "cover",
              alt: "Hero",
            },
          ],
          tokens: [],
          assets: [sourceAsset],
          variables: [],
          states: [],
          actions: [],
          bindings: [],
          motions: [],
        });
        const sourceCitations = [
          {
            id: "citation-scope",
            documentId: "document-scope",
            chunkId: "chunk-scope",
            sourcePath: "knowledge-vault/spec.md",
            title: "Scope",
            quote: "Private snapshot semantics",
            locator: { heading: "Scope", startLine: 1, endLine: 2 },
          },
        ];
        const sourceVersion = await tx.artifactVersion.create({
          data: {
            id: sourceVersionId,
            artifactId: sourceArtifact.id,
            projectId: source.id,
            version: 1,
            schemaVersion: 1,
            status: "staging",
            content: sourceContent,
            checksum: canonicalSha256(sourceContent),
            citations: sourceCitations,
            knowledgeReleaseId: knowledgeRelease.id,
          },
        });
        await tx.artifactVersionAsset.create({
          data: {
            artifactVersionId: sourceVersion.id,
            artifactId: sourceArtifact.id,
            projectId: source.id,
            assetId: sourceAsset.id,
            kind: sourceAsset.kind,
            blobId: sourceBlob.id,
            mediaType: sourceBlob.mediaType,
            byteSize: sourceBlob.byteSize,
            sha256: sourceBlob.sha256,
            metadata: sourceAsset,
          },
        });
        await tx.artifactVersion.update({
          where: { id: sourceVersion.id },
          data: { status: "ready" },
        });
        await tx.artifact.update({
          where: { id: sourceArtifact.id },
          data: { currentVersionId: sourceVersion.id },
        });
        const transientArtifact = await tx.artifact.create({
          data: {
            id: `artifact_transient_${suffix}`,
            projectId: source.id,
            kind: "prototype",
            title: "Unpublished transient prototype",
          },
        });
        await tx.boardNode.createMany({
          data: [
            {
              boardId: sourceBoard.id,
              projectId: source.id,
              nodeKey: "current-prototype",
              sortOrder: 0,
              kind: "artifact",
              position: { x: 10, y: 20 },
              size: { width: 360, height: 240 },
              artifactId: sourceArtifact.id,
              artifactVersionId: sourceVersion.id,
              data: {
                protocol: boardNodeProtocol,
                nodeType: "artifact",
                title: "Current prototype",
                artifactKind: "prototype",
                route: `/projects/${source.id}/artifacts/${sourceArtifact.id}/versions/${sourceVersion.id}`,
              },
            },
            {
              boardId: sourceBoard.id,
              projectId: source.id,
              nodeKey: "source-note",
              sortOrder: 1,
              kind: "frame",
              position: { x: 410, y: 20 },
              size: { width: 320, height: 180 },
              data: {
                protocol: boardNodeProtocol,
                nodeType: "frame",
                title: "Keep this opaque",
                fill: null,
                stroke: "#5f6368",
              },
            },
          ],
        });
        await tx.boardEdge.create({
          data: {
            boardId: sourceBoard.id,
            edgeKey: "prototype-to-note",
            sourceNodeKey: "current-prototype",
            targetNodeKey: "source-note",
            kind: "reference",
            data: { sourceVersionRef: sourceVersion.id, label: "opaque" },
          },
        });

        const serviceDb = {
          projectDuplicate: tx.projectDuplicate,
          $transaction: (callback: (client: typeof tx) => unknown) =>
            callback(tx),
        };
        const service = new ProjectDuplicatesService(
          serviceDb as never,
          new AccessService(tx as never),
        );
        const key = `duplicate:${suffix}`;
        const result = await service.create(viewer.id, source.id, key, {
          title: "Private duplicate",
        });
        const replay = await service.create(viewer.id, source.id, key, {
          title: "Private duplicate",
        });
        expect(replay.project.id).toBe(result.project.id);

        const target = await tx.project.findUniqueOrThrow({
          where: { id: result.project.id },
          include: {
            members: true,
            threads: { include: { entries: true, runs: true } },
            boards: {
              include: {
                nodes: { orderBy: { nodeKey: "asc" } },
                edges: { orderBy: { edgeKey: "asc" } },
              },
            },
            artifacts: { include: { versions: { include: { assets: true } } } },
            files: true,
            releases: true,
            duplicateReceipt: true,
          },
        });
        expect(target).toMatchObject({
          workspaceId: workspace.id,
          createdById: viewer.id,
          title: "Private duplicate",
          summary: "Snapshot source",
        });
        expect(target.members).toEqual([
          expect.objectContaining({ principalId: viewer.id, role: "owner" }),
        ]);
        expect(target.threads).toHaveLength(1);
        expect(target.threads[0]?.entries).toEqual([]);
        expect(target.threads[0]?.runs).toEqual([]);
        expect(target.files).toEqual([]);
        expect(target.releases).toEqual([]);
        expect(target.artifacts).toHaveLength(1);
        expect(target.artifacts).not.toEqual(expect.arrayContaining([
          expect.objectContaining({ title: transientArtifact.title }),
        ]));
        expect(target.artifacts[0]?.versions).toHaveLength(1);
        const targetArtifact = target.artifacts[0]!;
        const targetVersion = targetArtifact.versions[0]!;
        expect(targetArtifact.id).not.toBe(sourceArtifact.id);
        expect(targetArtifact.currentVersionId).toBe(targetVersion.id);
        expect(targetVersion).toMatchObject({
          artifactId: targetArtifact.id,
          projectId: target.id,
          status: "ready",
          checksum: sourceVersion.checksum,
          citations: sourceCitations,
          knowledgeReleaseId: knowledgeRelease.id,
        });
        expect(targetVersion.id).not.toBe(sourceVersion.id);
        expect(targetVersion.content).toEqual(sourceContent);
        expect(targetVersion.checksum).toBe(
          canonicalSha256(targetVersion.content),
        );
        expect(targetVersion.assets).toEqual([
          expect.objectContaining({
            artifactVersionId: targetVersion.id,
            artifactId: targetArtifact.id,
            projectId: target.id,
            assetId: sourceAsset.id,
            blobId: sourceBlob.id,
            sha256: sourceBlob.sha256,
            metadata: sourceAsset,
          }),
        ]);
        const targetBoard = target.boards[0]!;
        expect(targetBoard.viewport).toEqual(sourceBoard.viewport);
        const targetArtifactNode = targetBoard.nodes.find(
          (node) => node.nodeKey === "current-prototype",
        )!;
        expect(targetArtifactNode).toMatchObject({
          projectId: target.id,
          artifactId: targetArtifact.id,
          artifactVersionId: targetVersion.id,
          position: { x: 10, y: 20 },
          size: { width: 360, height: 240 },
          data: {
            protocol: boardNodeProtocol,
            nodeType: "artifact",
            title: "Current prototype",
            artifactKind: "prototype",
            route: `/projects/${source.id}/artifacts/${sourceArtifact.id}/versions/${sourceVersion.id}`,
          },
        });
        expect(
          targetBoard.nodes.find((node) => node.nodeKey === "source-note")
            ?.data,
        ).toEqual({
          protocol: boardNodeProtocol,
          nodeType: "frame",
          title: "Keep this opaque",
          fill: null,
          stroke: "#5f6368",
        });
        expect(targetBoard.edges).toEqual([
          expect.objectContaining({
            sourceNodeKey: "current-prototype",
            targetNodeKey: "source-note",
            data: { sourceVersionRef: sourceVersion.id, label: "opaque" },
          }),
        ]);
        expect(target.duplicateReceipt).toMatchObject({
          sourceProjectId: source.id,
          createdById: viewer.id,
          workspaceId: workspace.id,
        });

        verified = true;
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    } finally {
      await db.$disconnect();
    }
    expect(verified).toBe(true);
  }, 20_000);

  it("keeps ProjectMember identity immutable when moving the source Project's last owner", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl });
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const rollback = new Error("ROLLBACK_PROJECT_MEMBER_IDENTITY_TEST");
    let verified = false;

    try {
      await db.$transaction(async (tx) => {
        const sourceOwner = await tx.principal.create({
          data: {
            issuer: `project-member-identity-${suffix}`,
            subject: `source-${suffix}`,
          },
        });
        const targetOwner = await tx.principal.create({
          data: {
            issuer: `project-member-identity-${suffix}`,
            subject: `target-${suffix}`,
          },
        });
        const workspace = await tx.workspace.create({
          data: {
            slug: `project-member-identity-${suffix}`,
            name: "Project member identity",
            createdById: sourceOwner.id,
          },
        });
        await tx.workspaceMember.createMany({
          data: [
            {
              workspaceId: workspace.id,
              principalId: sourceOwner.id,
              role: "owner",
            },
            {
              workspaceId: workspace.id,
              principalId: targetOwner.id,
              role: "member",
            },
          ],
        });
        const source = await tx.project.create({
          data: {
            workspaceId: workspace.id,
            createdById: sourceOwner.id,
            title: "Source",
          },
        });
        const target = await tx.project.create({
          data: {
            workspaceId: workspace.id,
            createdById: targetOwner.id,
            title: "Target",
          },
        });
        await tx.projectMember.createMany({
          data: [
            {
              projectId: source.id,
              workspaceId: workspace.id,
              principalId: sourceOwner.id,
              role: "owner",
            },
            {
              projectId: target.id,
              workspaceId: workspace.id,
              principalId: targetOwner.id,
              role: "owner",
            },
          ],
        });

        try {
          await tx.$executeRaw`
            UPDATE "project_members"
            SET "project_id" = ${target.id}, "updated_at" = clock_timestamp()
            WHERE "project_id" = ${source.id} AND "principal_id" = ${sourceOwner.id}
          `;
        } catch (error) {
          expect(String(error)).toContain("PROJECT_MEMBER_IDENTITY_IMMUTABLE");
          verified = true;
          throw rollback;
        }
        throw new Error("PostgreSQL moved a ProjectMember identity");
      });
    } catch (error) {
      if (error !== rollback) throw error;
    } finally {
      await db.$disconnect();
    }
    expect(verified).toBe(true);
  }, 20_000);

  it("treats Project search percent, underscore, and backslash as literal characters", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl });
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const rollback = new Error("ROLLBACK_PROJECT_LITERAL_SEARCH_TEST");
    let verified = false;

    try {
      await db.$transaction(async (tx) => {
        const principal = await tx.principal.create({
          data: {
            issuer: `project-search-${suffix}`,
            subject: `owner-${suffix}`,
          },
        });
        const workspace = await tx.workspace.create({
          data: {
            slug: `project-search-${suffix}`,
            name: "Project literal search",
            createdById: principal.id,
          },
        });
        await tx.workspaceMember.create({
          data: {
            workspaceId: workspace.id,
            principalId: principal.id,
            role: "owner",
          },
        });
        const createProject = async (title: string, summary: string | null) => {
          const project = await tx.project.create({
            data: {
              workspaceId: workspace.id,
              createdById: principal.id,
              title,
              summary,
            },
          });
          await tx.projectMember.create({
            data: {
              projectId: project.id,
              workspaceId: workspace.id,
              principalId: principal.id,
              role: "owner",
            },
          });
          return project;
        };
        const percent = await createProject("Roadmap 100% literal", null);
        const underscore = await createProject(
          "Underscore summary",
          "contains_literal_value",
        );
        const backslash = await createProject("Windows \\ archive", null);
        await createProject(
          "Plain alphabetic project",
          "No metacharacters here",
        );
        const service = new ProjectsService(
          tx as never,
          new AccessService(tx as never),
        );

        const percentResult = await service.list(
          principal.id,
          "%",
        );
        const underscoreResult = await service.list(
          principal.id,
          "_",
        );
        const backslashResult = await service.list(
          principal.id,
          "\\",
        );
        expect(percentResult.items.map((project) => project.id)).toEqual([
          percent.id,
        ]);
        expect(underscoreResult.items.map((project) => project.id)).toEqual([
          underscore.id,
        ]);
        expect(backslashResult.items.map((project) => project.id)).toEqual([
          backslash.id,
        ]);

        verified = true;
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    } finally {
      await db.$disconnect();
    }
    expect(verified).toBe(true);
  }, 20_000);

  it("commits one target when the same duplicate command races", async () => {
    const firstDb = new PrismaClient({ datasourceUrl: databaseUrl });
    const secondDb = new PrismaClient({ datasourceUrl: databaseUrl });
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;

    try {
      const fixture = await firstDb.$transaction(async (tx) => {
        const principal = await tx.principal.create({
          data: {
            issuer: `project-duplicate-race-${suffix}`,
            subject: `owner-${suffix}`,
          },
        });
        const workspace = await tx.workspace.create({
          data: {
            slug: `project-duplicate-race-${suffix}`,
            name: "Project duplicate race",
            createdById: principal.id,
          },
        });
        await tx.workspaceMember.create({
          data: {
            workspaceId: workspace.id,
            principalId: principal.id,
            role: "owner",
          },
        });
        const project = await tx.project.create({
          data: {
            workspaceId: workspace.id,
            createdById: principal.id,
            title: "Concurrent source",
          },
        });
        await tx.projectMember.create({
          data: {
            projectId: project.id,
            workspaceId: workspace.id,
            principalId: principal.id,
            role: "owner",
          },
        });
        await tx.board.create({
          data: { projectId: project.id, viewport: { x: 0, y: 0, zoom: 1 } },
        });
        return {
          principalId: principal.id,
          projectId: project.id,
          workspaceId: workspace.id,
        };
      });
      const first = new ProjectDuplicatesService(
        firstDb as never,
        new AccessService(firstDb as never),
      );
      const second = new ProjectDuplicatesService(
        secondDb as never,
        new AccessService(secondDb as never),
      );
      const idempotencyKey = `duplicate-race:${suffix}`;
      const request = { title: "Concurrent target" };

      const results = await Promise.all([
        first.create(
          fixture.principalId,
          fixture.projectId,
          idempotencyKey,
          request,
        ),
        second.create(
          fixture.principalId,
          fixture.projectId,
          idempotencyKey,
          request,
        ),
      ]);

      expect(new Set(results.map((result) => result.project.id)).size).toBe(1);
      expect(
        await firstDb.projectDuplicate.count({
          where: {
            sourceProjectId: fixture.projectId,
            createdById: fixture.principalId,
            idempotencyKey,
          },
        }),
      ).toBe(1);
      expect(
        await firstDb.project.count({
          where: {
            workspaceId: fixture.workspaceId,
            id: { not: fixture.projectId },
          },
        }),
      ).toBe(1);
    } finally {
      await Promise.all([firstDb.$disconnect(), secondDb.$disconnect()]);
    }
  }, 20_000);

  it("does not duplicate from a membership snapshot revoked while waiting for the Project lock", async () => {
    const setup = new PrismaClient({ datasourceUrl: databaseUrl });
    const revoker = new PrismaClient({ datasourceUrl: databaseUrl });
    const duplicator = new PrismaClient({ datasourceUrl: databaseUrl });
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    let releaseRevoker: (() => void) | undefined;
    let revokerLocked: (() => void) | undefined;
    let duplicateAttempted: (() => void) | undefined;
    const releaseFence = new Promise<void>((resolve) => {
      releaseRevoker = resolve;
    });
    const lockHeld = new Promise<void>((resolve) => {
      revokerLocked = resolve;
    });
    const duplicateWaiting = new Promise<void>((resolve) => {
      duplicateAttempted = resolve;
    });

    try {
      const fixture = await setup.$transaction(async (tx) => {
        const owner = await tx.principal.create({
          data: {
            issuer: `project-duplicate-revoke-${suffix}`,
            subject: `owner-${suffix}`,
          },
        });
        const viewer = await tx.principal.create({
          data: {
            issuer: `project-duplicate-revoke-${suffix}`,
            subject: `viewer-${suffix}`,
          },
        });
        const workspace = await tx.workspace.create({
          data: {
            slug: `project-duplicate-revoke-${suffix}`,
            name: "Project duplicate membership revoke",
            createdById: owner.id,
          },
        });
        await tx.workspaceMember.createMany({
          data: [
            { workspaceId: workspace.id, principalId: owner.id, role: "owner" },
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
            title: "Membership revoke source",
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
          ],
        });
        await tx.board.create({
          data: { projectId: project.id, viewport: { x: 0, y: 0, zoom: 1 } },
        });
        return {
          ownerId: owner.id,
          viewerId: viewer.id,
          workspaceId: workspace.id,
          projectId: project.id,
        };
      });

      const revokePromise = revoker.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT "id" FROM "projects" WHERE "id" = ${fixture.projectId} FOR UPDATE
        `;
        revokerLocked?.();
        await releaseFence;
        await tx.projectMember.delete({
          where: {
            projectId_principalId: {
              projectId: fixture.projectId,
              principalId: fixture.viewerId,
            },
          },
        });
      });
      await lockHeld;

      const fencedDb = {
        projectDuplicate: duplicator.projectDuplicate,
        $transaction: (callback: (tx: unknown) => unknown) =>
          duplicator.$transaction(async (tx) => {
            let firstProjectLock = true;
            const fenced = new Proxy(tx as object, {
              get(target, property, receiver) {
                if (property !== "$queryRaw")
                  return Reflect.get(target, property, receiver);
                return async (...args: unknown[]) => {
                  if (firstProjectLock) {
                    firstProjectLock = false;
                    duplicateAttempted?.();
                  }
                  return (
                    tx.$queryRaw as (...values: unknown[]) => Promise<unknown>
                  )(...args);
                };
              },
            });
            return callback(fenced);
          }),
      };
      const duplicates = new ProjectDuplicatesService(
        fencedDb as never,
        new AccessService(duplicator as never),
      );
      let duplicateSettled = false;
      const duplicatePromise = duplicates
        .create(
          fixture.viewerId,
          fixture.projectId,
          `duplicate-revoke:${suffix}`,
          { title: "Must not exist" },
        )
        .finally(() => {
          duplicateSettled = true;
        });
      await duplicateWaiting;
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(duplicateSettled).toBe(false);

      releaseRevoker?.();
      await revokePromise;
      await expect(duplicatePromise).rejects.toMatchObject({ status: 404 });
      expect(
        await setup.project.count({
          where: {
            workspaceId: fixture.workspaceId,
            id: { not: fixture.projectId },
          },
        }),
      ).toBe(0);
      expect(
        await setup.projectDuplicate.count({
          where: { sourceProjectId: fixture.projectId },
        }),
      ).toBe(0);
    } finally {
      releaseRevoker?.();
      await Promise.all([
        setup.$disconnect(),
        revoker.$disconnect(),
        duplicator.$disconnect(),
      ]);
    }
  }, 20_000);

  it("linearizes Share creation before archive and revokes the newly created grant", async () => {
    const setup = new PrismaClient({ datasourceUrl: databaseUrl });
    const producer = new PrismaClient({ datasourceUrl: databaseUrl });
    const archiver = new PrismaClient({ datasourceUrl: databaseUrl });
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    let releaseProducer: (() => void) | undefined;
    let lockObserved: (() => void) | undefined;
    const releaseFence = new Promise<void>((resolve) => {
      releaseProducer = resolve;
    });
    const fenceLocked = new Promise<void>((resolve) => {
      lockObserved = resolve;
    });

    try {
      const fixture = await setup.$transaction(async (tx) => {
        const principal = await tx.principal.create({
          data: {
            issuer: `archive-share-${suffix}`,
            subject: `owner-${suffix}`,
          },
        });
        const workspace = await tx.workspace.create({
          data: {
            slug: `archive-share-${suffix}`,
            name: "Archive Share concurrency",
            createdById: principal.id,
          },
        });
        await tx.workspaceMember.create({
          data: {
            workspaceId: workspace.id,
            principalId: principal.id,
            role: "owner",
          },
        });
        const project = await tx.project.create({
          data: {
            workspaceId: workspace.id,
            createdById: principal.id,
            title: "Archive source",
          },
        });
        await tx.projectMember.create({
          data: {
            projectId: project.id,
            workspaceId: workspace.id,
            principalId: principal.id,
            role: "owner",
          },
        });
        const board = await tx.board.create({
          data: { projectId: project.id, viewport: { x: 0, y: 0, zoom: 1 } },
        });
        const release = await seedPrototypeRelease(tx, project.id, principal.id, board.id);
        return {
          principalId: principal.id,
          projectId: project.id,
          releaseId: release.id,
        };
      });

      const fencedDb = {
        projectRelease: producer.projectRelease,
        $transaction: (callback: (tx: unknown) => unknown) =>
          producer.$transaction(async (tx) => {
            let firstProjectLock = true;
            const fenced = new Proxy(tx as object, {
              get(target, property, receiver) {
                if (property !== "$queryRaw")
                  return Reflect.get(target, property, receiver);
                return async (...args: unknown[]) => {
                  const result = await (
                    tx.$queryRaw as (...values: unknown[]) => Promise<unknown>
                  )(...args);
                  if (firstProjectLock) {
                    firstProjectLock = false;
                    lockObserved?.();
                    await releaseFence;
                  }
                  return result;
                };
              },
            });
            return callback(fenced);
          }),
      };
      const shares = new SharesService(
        fencedDb as never,
        new AccessService(producer as never),
        {} as never,
      );
      const projects = new ProjectsService(
        archiver as never,
        new AccessService(archiver as never),
      );

      const sharePromise = shares.rotate(
        fixture.principalId,
        fixture.projectId,
        `share:archive:${suffix}`,
        {
          releaseId: fixture.releaseId,
          scope: "view",
        },
      );
      await fenceLocked;
      let archiveSettled = false;
      const archivePromise = projects
        .archive(fixture.principalId, fixture.projectId, 0)
        .finally(() => {
          archiveSettled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(archiveSettled).toBe(false);

      releaseProducer?.();
      const [share, archived] = await Promise.all([
        sharePromise,
        archivePromise,
      ]);
      expect(archived.status).toBe("archived");
      const persistedShare = await setup.shareGrant.findUniqueOrThrow({
        where: { id: share.share.id },
      });
      expect(persistedShare.status).toBe("revoked");
      expect(persistedShare.revokedAt).not.toBeNull();
    } finally {
      releaseProducer?.();
      await Promise.all([
        setup.$disconnect(),
        producer.$disconnect(),
        archiver.$disconnect(),
      ]);
    }
  }, 20_000);

  it("linearizes Share creation before project-wide revocation and leaves no active grant", async () => {
    const setup = new PrismaClient({ datasourceUrl: databaseUrl });
    const producer = new PrismaClient({ datasourceUrl: databaseUrl });
    const revoker = new PrismaClient({ datasourceUrl: databaseUrl });
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    let releaseProducer: (() => void) | undefined;
    let lockObserved: (() => void) | undefined;
    const releaseFence = new Promise<void>((resolve) => {
      releaseProducer = resolve;
    });
    const fenceLocked = new Promise<void>((resolve) => {
      lockObserved = resolve;
    });

    try {
      const fixture = await setup.$transaction(async (tx) => {
        const principal = await tx.principal.create({
          data: {
            issuer: `revoke-shares-${suffix}`,
            subject: `owner-${suffix}`,
          },
        });
        const workspace = await tx.workspace.create({
          data: {
            slug: `revoke-shares-${suffix}`,
            name: "Revoke Shares concurrency",
            createdById: principal.id,
          },
        });
        await tx.workspaceMember.create({
          data: {
            workspaceId: workspace.id,
            principalId: principal.id,
            role: "owner",
          },
        });
        const project = await tx.project.create({
          data: {
            workspaceId: workspace.id,
            createdById: principal.id,
            title: "Shared source",
          },
        });
        await tx.projectMember.create({
          data: {
            projectId: project.id,
            workspaceId: workspace.id,
            principalId: principal.id,
            role: "owner",
          },
        });
        const board = await tx.board.create({
          data: { projectId: project.id, viewport: { x: 0, y: 0, zoom: 1 } },
        });
        const release = await seedPrototypeRelease(tx, project.id, principal.id, board.id);
        return {
          principalId: principal.id,
          projectId: project.id,
          releaseId: release.id,
        };
      });

      const fencedDb = {
        projectRelease: producer.projectRelease,
        $transaction: (callback: (tx: unknown) => unknown) =>
          producer.$transaction(async (tx) => {
            let firstProjectLock = true;
            const fenced = new Proxy(tx as object, {
              get(target, property, receiver) {
                if (property !== "$queryRaw")
                  return Reflect.get(target, property, receiver);
                return async (...args: unknown[]) => {
                  const result = await (
                    tx.$queryRaw as (...values: unknown[]) => Promise<unknown>
                  )(...args);
                  if (firstProjectLock) {
                    firstProjectLock = false;
                    lockObserved?.();
                    await releaseFence;
                  }
                  return result;
                };
              },
            });
            return callback(fenced);
          }),
      };
      const creator = new SharesService(
        fencedDb as never,
        new AccessService(producer as never),
        {} as never,
      );
      const projectRevoker = new SharesService(
        revoker as never,
        new AccessService(revoker as never),
        {} as never,
      );

      const sharePromise = creator.rotate(
        fixture.principalId,
        fixture.projectId,
        `share:revoke:${suffix}`,
        {
          releaseId: fixture.releaseId,
          scope: "view",
        },
      );
      await fenceLocked;
      let revocationSettled = false;
      const revocationPromise = projectRevoker
        .revokeProjectShares(fixture.principalId, fixture.projectId)
        .finally(() => {
          revocationSettled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(revocationSettled).toBe(false);

      releaseProducer?.();
      const [share, state] = await Promise.all([
        sharePromise,
        revocationPromise,
      ]);
      expect(state).toEqual({
        projectId: fixture.projectId,
        activeGrantCount: 0,
      });
      const persistedShare = await setup.shareGrant.findUniqueOrThrow({
        where: { id: share.share.id },
      });
      expect(persistedShare.status).toBe("revoked");
      expect(persistedShare.revokedAt).not.toBeNull();
      await expect(
        setup.shareGrant.count({
          where: {
            status: "active",
            release: { is: { projectId: fixture.projectId } },
          },
        }),
      ).resolves.toBe(0);
    } finally {
      releaseProducer?.();
      await Promise.all([
        setup.$disconnect(),
        producer.$disconnect(),
        revoker.$disconnect(),
      ]);
    }
  }, 20_000);
});

function projectRetrievalSpec(
  id: string,
  embeddingProfileId: string,
  embeddingProfileSpecSha256: string,
): RetrievalProfileV1 {
  return {
    schema: "workbench.retrieval-profile.v1",
    id,
    embedding: {
      profileId: embeddingProfileId,
      profileSpecSha256: embeddingProfileSpecSha256,
      dimension: 3,
    },
    segmenter: {
      implementationId: "project-test-segmenter",
      version: "1.0.0",
      artifactSha256: "5".repeat(64),
      algorithm: "cut_for_search",
      hmm: false,
      dictionarySha256: "6".repeat(64),
      stopwordsSha256: "7".repeat(64),
      normalization: "utf8-nfc-lf-v1",
    },
    recall: {
      lexical: {
        algorithm: "plainto_tsquery-simple-ts_rank_cd-32-v1",
        limit: 40,
      },
      dense: { distance: "cosine", limit: 40 },
      fusion: { algorithm: "rrf", k: 60, tieBreak: "workbench-rrf-v1" },
    },
    reranker: {
      protocol: "tei.rerank.v1",
      engine: {
        id: "project-test-reranker-engine",
        version: "1.0.0",
        imageDigest: `sha256:${"8".repeat(64)}`,
      },
      model: {
        id: "project-test/reranker",
        revision: "revision-1",
        artifactSha256: "9".repeat(64),
      },
      tokenizer: {
        id: "project-test/reranker-tokenizer",
        revision: "revision-1",
        artifactSha256: "a".repeat(64),
        maximumInputTokens: 512,
        overflow: "reject",
      },
      candidateLimit: 24,
      finalResultLimit: 10,
      failurePolicy: "degrade_to_rrf",
      conformanceProbeSha256: "b".repeat(64),
    },
    routingPolicy: "workbench-knowledge-route-v1",
    citationSchema: "workbench.knowledge-citation.v1",
  };
}
