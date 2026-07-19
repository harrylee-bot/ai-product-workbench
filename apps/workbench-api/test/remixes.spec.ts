import { createHash } from "node:crypto";
import type { Response } from "express";
import { Prisma } from "@workbench/workbench-db";
import {
  boardNodeProtocol,
  canonicalJson,
  createProjectRemixRequestSchema,
} from "@workbench/workbench-contracts";
import { RemixesController } from "../src/modules/remixes/remixes.controller.js";
import {
  hashShareToken,
  RemixesService,
} from "../src/modules/remixes/remixes.service.js";

const token = `wbs_${"A".repeat(43)}`;
const now = new Date("2026-07-13T03:00:00.000Z");

function sha256(value: unknown) {
  return createHash("sha256").update(canonicalJson(value as never)).digest("hex");
}

function sourceShare(overrides: Record<string, unknown> = {}) {
  const board = {
    id: "board_source",
    projectId: "project_source",
    revision: 7,
    viewport: { x: 12, y: 34, zoom: 0.8 },
    nodes: [
      {
        id: "node_inline",
        kind: "artifact",
        parentNodeId: null,
        order: 0,
        position: { x: 1, y: 2 },
        size: { width: 320, height: 480 },
        artifactId: "artifact_inline",
        artifactVersionId: "version_inline",
        data: {
          protocol: boardNodeProtocol,
          nodeType: "artifact",
          title: "Research",
          artifactKind: "data",
          route: "/artifacts/artifact_inline/versions/version_inline",
        },
      },
      {
        id: "node_blob",
        kind: "artifact",
        parentNodeId: null,
        order: 1,
        position: { x: 5, y: 8 },
        size: null,
        artifactId: "artifact_blob",
        artifactVersionId: "version_blob",
        data: {
          protocol: boardNodeProtocol,
          nodeType: "artifact",
          title: "Dataset",
          artifactKind: "data",
        },
      },
    ],
    edges: [
      {
        id: "edge_1",
        sourceNodeId: "node_inline",
        targetNodeId: "node_blob",
        kind: "flow",
        data: { sourceVersion: "version_inline" },
      },
    ],
  };
  const boardChecksum = sha256(board);
  const manifest = {
    protocol: "workbench.project-release.v1",
    projectId: "project_source",
    releaseVersion: 3,
    board: {
      id: "board_source",
      revision: 7,
      checksum: boardChecksum,
    },
    artifacts: [
      {
        position: 0,
        artifactId: "artifact_inline",
        artifactVersionId: "version_inline",
        title: "Research",
        kind: "data",
        version: 4,
        schemaVersion: 2,
        checksum: "a".repeat(64),
        assets: [],
      },
      {
        position: 1,
        artifactId: "artifact_blob",
        artifactVersionId: "version_blob",
        title: "Dataset",
        kind: "data",
        version: 2,
        schemaVersion: 1,
        checksum: "b".repeat(64),
        assets: [],
      },
    ],
  };
  const share = {
    id: "share_1",
    scope: "remix",
    status: "active",
    expiresAt: new Date("2026-08-01T00:00:00.000Z"),
    release: {
      id: "release_1",
      projectId: "project_source",
      status: "ready",
      boardSnapshot: board,
      boardChecksum,
      manifest,
      manifestSha256: sha256(manifest),
      project: { title: "Source project" },
      artifactPins: [
        {
          position: 0,
          artifactId: "artifact_inline",
          artifactVersionId: "version_inline",
          title: "Research",
          kind: "data",
          artifactVersion: {
            id: "version_inline",
            artifactId: "artifact_inline",
            projectId: "project_source",
            version: 4,
            schemaVersion: 2,
            status: "ready",
            content: { rows: [1, 2], citations: [] },
            contentBlobId: null,
            checksum: "a".repeat(64),
            citations: [],
            knowledgeReleaseId: "knowledge_1",
            artifact: {
              id: "artifact_inline",
              projectId: "project_source",
              kind: "data",
              title: "Research renamed after release",
            },
            contentBlob: null,
            knowledgeRelease: {
              id: "knowledge_1",
              status: "ready",
              workspaceId: "workspace_1",
            },
            assets: [],
          },
        },
        {
          position: 1,
          artifactId: "artifact_blob",
          artifactVersionId: "version_blob",
          title: "Dataset",
          kind: "data",
          artifactVersion: {
            id: "version_blob",
            artifactId: "artifact_blob",
            projectId: "project_source",
            version: 2,
            schemaVersion: 1,
            status: "ready",
            content: null,
            contentBlobId: "blob_1",
            checksum: "b".repeat(64),
            citations: [{ source: "asset" }],
            knowledgeReleaseId: null,
            artifact: {
              id: "artifact_blob",
              projectId: "project_source",
              kind: "data",
              title: "Dataset renamed after release",
            },
            contentBlob: {
              id: "blob_1",
              status: "ready",
              byteSize: 2048n,
              deletedAt: null,
            },
            knowledgeRelease: null,
            assets: [],
          },
        },
      ],
    },
    ...overrides,
  };
  return share;
}

function createHarness(share = sourceShare()) {
  const targetProject = {
    id: "project_target",
    workspaceId: "workspace_1",
    createdById: "principal_1",
    title: "My remix",
    summary: null,
    status: "active",
    revision: 0,
    createdAt: now,
    updatedAt: now,
  };
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(2),
    $queryRaw: vi.fn()
      .mockResolvedValueOnce([{ id: "share_1" }])
      .mockResolvedValueOnce([{ workspaceId: "workspace_1" }]),
    shareGrant: { findUnique: vi.fn().mockResolvedValue(share) },
    project: { create: vi.fn().mockResolvedValue(targetProject) },
    projectMember: { create: vi.fn().mockResolvedValue({}) },
    thread: { create: vi.fn().mockResolvedValue({ id: "thread_target" }) },
    board: { create: vi.fn().mockResolvedValue({ id: "board_target" }) },
    artifact: {
      createMany: vi.fn().mockResolvedValue({ count: 2 }),
    },
    artifactVersion: {
      createMany: vi.fn().mockResolvedValue({ count: 2 }),
      updateMany: vi.fn().mockResolvedValue({ count: 2 }),
    },
    artifactVersionAsset: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    boardNode: { createMany: vi.fn().mockResolvedValue({ count: 2 }) },
    boardEdge: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    projectLineage: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({
        targetProjectId: "project_target",
        sourceReleaseId: "release_1",
        sourceShareId: "share_1",
        createdById: "principal_1",
        workspaceId: "workspace_1",
        idempotencyKey: "remix-key-1",
        requestHash: sha256({ workspaceId: "workspace_1", title: "My remix" }),
        createdAt: now,
        targetProject,
      }),
    },
  };
  const db = {
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    projectLineage: { findFirst: vi.fn().mockResolvedValue(null) },
  };
  return { tx, db, service: new RemixesService(db as never) };
}

describe("Project remix command", () => {
  it("copies a ready immutable release into a new Project and remaps all Board artifact ids", async () => {
    const { tx, db, service } = createHarness();

    const result = await service.create("principal_1", token, "remix-key-1", {
      workspaceId: "workspace_1",
      title: "My remix",
    });

    expect(result).toEqual({
      project: {
        id: "project_target",
        workspaceId: "workspace_1",
        title: "My remix",
        summary: null,
        status: "active",
        revision: 0,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
      lineage: {
        targetProjectId: "project_target",
        sourceReleaseId: "release_1",
        sourceShareId: "share_1",
        createdById: "principal_1",
        workspaceId: "workspace_1",
        createdAt: now.toISOString(),
      },
    });
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({
      isolationLevel: "ReadCommitted",
    }));
    expect(tx.shareGrant.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { tokenHash: hashShareToken(token) },
    }));
    expect(JSON.stringify(tx.shareGrant.findUnique.mock.calls[0]?.[0]?.select)).not.toContain("storageKey");

    expect(tx.thread.create).toHaveBeenCalledWith({
      data: { projectId: "project_target", createdById: "principal_1", title: "Main" },
    });
    expect(tx.projectMember.create).toHaveBeenCalledWith({
      data: {
        projectId: "project_target",
        workspaceId: "workspace_1",
        principalId: "principal_1",
        role: "owner",
      },
    });
    expect(tx.board.create).toHaveBeenCalledWith({
      data: {
        projectId: "project_target",
        viewport: { x: 12, y: 34, zoom: 0.8 },
      },
    });
    const artifacts = tx.artifact.createMany.mock.calls[0]?.[0]?.data;
    expect(artifacts).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^artifact_/),
        projectId: "project_target",
        kind: "data",
        title: "Research",
      }),
      expect.objectContaining({
        id: expect.stringMatching(/^artifact_/),
        projectId: "project_target",
        kind: "data",
        title: "Dataset",
      }),
    ]);
    const targetInlineArtifactId = artifacts[0].id;
    const targetBlobArtifactId = artifacts[1].id;
    const sourceArtifactSelect = tx.shareGrant.findUnique.mock.calls[0]?.[0]
      ?.select?.release?.select?.artifactPins?.select?.artifactVersion?.select?.artifact?.select;
    expect(sourceArtifactSelect).not.toHaveProperty("title");
    const versions = tx.artifactVersion.createMany.mock.calls[0]?.[0]?.data;
    expect(versions[0]).toEqual(expect.objectContaining({
        id: expect.stringMatching(/^version_/),
        artifactId: targetInlineArtifactId,
        projectId: "project_target",
        version: 1,
        status: "staging",
        content: { rows: [1, 2], citations: [] },
        citations: [],
        knowledgeReleaseId: "knowledge_1",
    }));
    expect(versions[0]).not.toHaveProperty("createdByRunId");
    expect(versions[1]).toEqual(expect.objectContaining({
        id: expect.stringMatching(/^version_/),
        artifactId: targetBlobArtifactId,
        contentBlobId: "blob_1",
        checksum: "b".repeat(64),
        citations: [{ source: "asset" }],
    }));
    expect(versions[1]).not.toHaveProperty("content");
    const targetInlineVersionId = versions[0].id;
    const targetBlobVersionId = versions[1].id;
    expect(tx.artifactVersion.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [targetInlineVersionId, targetBlobVersionId] } },
      data: { status: "ready" },
    });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);

    const nodes = tx.boardNode.createMany.mock.calls[0]?.[0]?.data;
    expect(nodes[0]).toMatchObject({
      artifactId: targetInlineArtifactId,
      artifactVersionId: targetInlineVersionId,
      parentNodeKey: null,
      data: {
        protocol: boardNodeProtocol,
        nodeType: "artifact",
        title: "Research",
        artifactKind: "data",
        route: "/artifacts/artifact_inline/versions/version_inline",
      },
    });
    expect(nodes[1]).toMatchObject({
      artifactId: targetBlobArtifactId,
      artifactVersionId: targetBlobVersionId,
    });
    expect(tx.boardEdge.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({
        sourceNodeKey: "node_inline",
        targetNodeKey: "node_blob",
        data: { sourceVersion: "version_inline" },
      })],
    });
    expect(tx.projectLineage.create).toHaveBeenCalledWith({
      data: {
        targetProjectId: "project_target",
        sourceReleaseId: "release_1",
        sourceShareId: "share_1",
        createdById: "principal_1",
        workspaceId: "workspace_1",
        idempotencyKey: "remix-key-1",
        requestHash: sha256({ workspaceId: "workspace_1", title: "My remix" }),
      },
      include: { targetProject: true },
    });
    expect(JSON.stringify(result)).not.toContain("tokenHash");
    expect(JSON.stringify(result)).not.toContain("contentBlobId");
    expect(JSON.stringify(result)).not.toContain("idempotencyKey");
    expect(JSON.stringify(result)).not.toContain("requestHash");
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it("conceals inactive, expired, and view-only Shares without creating a Project", async () => {
    for (const share of [
      sourceShare({ scope: "view" }),
      sourceShare({ status: "revoked" }),
      sourceShare({ expiresAt: new Date("2020-01-01T00:00:00.000Z") }),
    ]) {
      const { tx, service } = createHarness(share);
      await expect(service.create("principal_1", token, "remix-key-1", { workspaceId: "workspace_1" }))
        .rejects.toMatchObject({ status: 404 });
      expect(tx.project.create).not.toHaveBeenCalled();
      expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    }
  });

  it("preserves private Knowledge provenance and atomically rejects a cross-Workspace target", async () => {
    const { tx, service } = createHarness();
    tx.$queryRaw.mockReset();
    tx.$queryRaw
      .mockResolvedValueOnce([{ id: "share_1" }])
      .mockResolvedValueOnce([{ workspaceId: "workspace_2" }]);

    await expect(service.create("principal_1", token, "remix-key-1", { workspaceId: "workspace_2" }))
      .rejects.toMatchObject({
        status: 409,
        response: { code: "REMIX_KNOWLEDGE_SCOPE_CONFLICT" },
      });
    expect(tx.project.create).not.toHaveBeenCalled();
    expect(tx.artifactVersion.createMany).not.toHaveBeenCalled();
    expect(tx.projectLineage.create).not.toHaveBeenCalled();
  });

  it("copies immutable Prototype asset pins before publishing the target Version", async () => {
    const share = sourceShare();
    const metadata = {
      id: "asset_image_1",
      kind: "image",
      blobId: "blob_asset_1",
      mediaType: "image/png",
      byteSize: 321,
      sha256: "f".repeat(64),
    };
    const manifestPin = share.release.manifest.artifacts[1];
    manifestPin.kind = "prototype";
    manifestPin.title = "Prototype";
    manifestPin.assets = [{
      assetId: metadata.id,
      kind: metadata.kind,
      blobId: metadata.blobId,
      mediaType: metadata.mediaType,
      byteSize: metadata.byteSize,
      sha256: metadata.sha256,
      metadata,
    }];
    const pin = share.release.artifactPins[1];
    pin.kind = "prototype";
    pin.title = "Prototype";
    pin.artifactVersion.artifact.kind = "prototype";
    pin.artifactVersion.content = {
      protocol: "workbench.prototype.v1",
      assets: [metadata],
    };
    pin.artifactVersion.contentBlobId = null;
    pin.artifactVersion.contentBlob = null;
    pin.artifactVersion.assets = [{
      artifactVersionId: "version_blob",
      artifactId: "artifact_blob",
      projectId: "project_source",
      assetId: "asset_image_1",
      kind: "image",
      blobId: "blob_asset_1",
      mediaType: "image/png",
      byteSize: 321n,
      sha256: "f".repeat(64),
      metadata,
      blob: { id: "blob_asset_1", status: "ready", deletedAt: null },
    }];
    share.release.manifestSha256 = sha256(share.release.manifest);
    const { tx, service } = createHarness(share);

    await service.create("principal_1", token, "remix-key-asset", {
      workspaceId: "workspace_1",
      title: "Asset remix",
    });

    const artifacts = tx.artifact.createMany.mock.calls[0]?.[0]?.data;
    const versions = tx.artifactVersion.createMany.mock.calls[0]?.[0]?.data;
    expect(versions[1]).toEqual(expect.objectContaining({
        artifactId: artifacts[1].id,
        status: "staging",
        content: { protocol: "workbench.prototype.v1", assets: [metadata] },
    }));
    expect(tx.artifactVersionAsset.createMany).toHaveBeenCalledWith({
      data: [{
        artifactVersionId: versions[1].id,
        artifactId: artifacts[1].id,
        projectId: "project_target",
        assetId: "asset_image_1",
        kind: "image",
        blobId: "blob_asset_1",
        mediaType: "image/png",
        byteSize: 321n,
        sha256: "f".repeat(64),
        metadata,
      }],
    });
    expect(tx.artifactVersion.updateMany).toHaveBeenCalledWith({
      where: { id: { in: versions.map((version: { id: string }) => version.id) } },
      data: { status: "ready" },
    });
  });

  it("rejects malformed raw tokens before touching persistence", async () => {
    const { db, service } = createHarness();
    await expect(service.create(
      "principal_1",
      "not-a-share-token",
      "remix-key-1",
      { workspaceId: "workspace_1" },
    ))
      .rejects.toMatchObject({ status: 404 });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("keeps request and response contracts strict", () => {
    expect(createProjectRemixRequestSchema.parse({ workspaceId: "workspace_1" })).toEqual({
      workspaceId: "workspace_1",
    });
    expect(() => createProjectRemixRequestSchema.parse({
      workspaceId: "workspace_1",
      sourceReleaseId: "caller-controlled",
    })).toThrow();
  });

  it("replays one durable target Project after its Share is revoked and expired", async () => {
    const { tx, service } = createHarness(sourceShare({
      status: "revoked",
      expiresAt: new Date("2020-01-01T00:00:00.000Z"),
    }));
    tx.projectLineage.findUnique.mockResolvedValue({
      targetProjectId: "project_target",
      sourceReleaseId: "release_1",
      sourceShareId: "share_1",
      createdById: "principal_1",
      workspaceId: "workspace_1",
      idempotencyKey: "remix-key-1",
      requestHash: sha256({ workspaceId: "workspace_1", title: "My remix" }),
      createdAt: now,
      targetProject: {
        id: "project_target",
        workspaceId: "workspace_1",
        title: "My remix",
        summary: null,
        status: "active",
        revision: 0,
        createdAt: now,
        updatedAt: now,
      },
    });

    await expect(service.create("principal_1", token, "remix-key-1", {
      workspaceId: "workspace_1",
      title: "My remix",
    })).resolves.toMatchObject({ project: { id: "project_target" } });
    expect(tx.project.create).not.toHaveBeenCalled();
    expect(tx.projectLineage.create).not.toHaveBeenCalled();
  });

  it("scopes receipts by both Principal and key so another command creates a new Project", async () => {
    const { tx, service } = createHarness();
    await service.create("principal_2", token, "remix-key-2", {
      workspaceId: "workspace_1",
      title: "Independent remix",
    });
    expect(tx.projectLineage.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        sourceShareId_createdById_idempotencyKey: {
          sourceShareId: "share_1",
          createdById: "principal_2",
          idempotencyKey: "remix-key-2",
        },
      },
    }));
    expect(tx.project.create).toHaveBeenCalledWith({
      data: {
        workspaceId: "workspace_1",
        createdById: "principal_2",
        title: "Independent remix",
      },
    });
  });

  it("rejects reusing one command receipt with a different target request", async () => {
    const { tx, service } = createHarness();
    tx.projectLineage.findUnique.mockResolvedValue({
      targetProjectId: "project_target",
      sourceReleaseId: "release_1",
      sourceShareId: "share_1",
      createdById: "principal_1",
      workspaceId: "workspace_1",
      idempotencyKey: "remix-key-1",
      requestHash: sha256({ workspaceId: "workspace_1", title: "Original" }),
      createdAt: now,
      targetProject: {
        id: "project_target",
        workspaceId: "workspace_1",
        title: "Original",
        summary: null,
        status: "active",
        revision: 0,
        createdAt: now,
        updatedAt: now,
      },
    });

    await expect(service.create("principal_1", token, "remix-key-1", {
      workspaceId: "workspace_1",
      title: "Different",
    })).rejects.toMatchObject({ status: 409 });
    expect(tx.project.create).not.toHaveBeenCalled();
  });

  it("resolves a concurrent unique-key race to the winning Project", async () => {
    const { db, service } = createHarness();
    const request = { workspaceId: "workspace_1", title: "My remix" };
    const race = new Prisma.PrismaClientKnownRequestError("duplicate", {
      code: "P2002",
      clientVersion: "6.19.3",
    });
    db.$transaction.mockRejectedValue(race);
    db.projectLineage.findFirst.mockResolvedValue({
      targetProjectId: "project_winner",
      sourceReleaseId: "release_1",
      sourceShareId: "share_1",
      createdById: "principal_1",
      workspaceId: "workspace_1",
      idempotencyKey: "remix-key-1",
      requestHash: sha256(request),
      createdAt: now,
      targetProject: {
        id: "project_winner",
        workspaceId: "workspace_1",
        title: "My remix",
        summary: null,
        status: "active",
        revision: 0,
        createdAt: now,
        updatedAt: now,
      },
    });

    await expect(service.create("principal_1", token, "remix-key-1", request))
      .resolves.toMatchObject({ project: { id: "project_winner" } });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.projectLineage.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        createdById: "principal_1",
        idempotencyKey: "remix-key-1",
      }),
    }));
  });

  it("uses a stable default title without reading mutable source Project metadata", async () => {
    const { tx, service } = createHarness();
    await service.create("principal_1", token, "remix-key-2", { workspaceId: "workspace_1" });
    expect(tx.project.create).toHaveBeenCalledWith({
      data: {
        workspaceId: "workspace_1",
        createdById: "principal_1",
        title: "Remixed project",
      },
    });
    const releaseSelect = tx.shareGrant.findUnique.mock.calls[0]?.[0]?.select?.release?.select;
    expect(releaseSelect).not.toHaveProperty("project");
  });
});

describe("RemixesController", () => {
  it("returns an opaque bootstrap Location and never returns the raw Share token", async () => {
    const result = {
      project: { id: "project_target", revision: 0 },
      lineage: { sourceShareId: "share_1" },
    };
    const remixes = { create: vi.fn().mockResolvedValue(result) };
    const controller = new RemixesController(remixes as never);
    const response = { setHeader: vi.fn() };

    await expect(controller.create(
      { id: "principal_1" } as never,
      token,
      "remix-key-1",
      { workspaceId: "workspace_1" },
      response as unknown as Response,
    )).resolves.toBe(result);
    expect(remixes.create).toHaveBeenCalledWith(
      "principal_1",
      token,
      "remix-key-1",
      { workspaceId: "workspace_1" },
    );
    expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(response.setHeader).toHaveBeenCalledWith("ETag", '"0"');
    expect(response.setHeader).toHaveBeenCalledWith(
      "Location",
      "/api/v1/projects/project_target/bootstrap",
    );
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it("requires an Idempotency-Key before invoking the command", async () => {
    const remixes = { create: vi.fn() };
    const controller = new RemixesController(remixes as never);
    await expect(controller.create(
      { id: "principal_1" } as never,
      token,
      undefined,
      { workspaceId: "workspace_1" },
      { setHeader: vi.fn() } as unknown as Response,
    )).rejects.toMatchObject({ status: 400 });
    expect(remixes.create).not.toHaveBeenCalled();
  });
});
