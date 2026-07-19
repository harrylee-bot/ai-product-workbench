import { describe, expect, it } from "vitest";
import {
  createExportJobRequestSchema,
  boardNodeProtocol,
  exportJobSchema,
  exportCapabilitiesSchema,
  externalExportDeliverySchema,
  exportBuildJobSchema,
  exportBuildQueue,
  exportSelectionSchema,
  projectReleaseProtocol,
  projectReleaseSchema,
  publicArtifactVersionDetailSchema,
  publicPrototypeImageAssetSchema,
  revokeProjectShareGrantsResponseSchema,
  resolveExportBoardNodeSelection,
  rotateShareGrantResponseSchema,
  shareGrantSchema,
  shareGrantListSchema,
  shareTokenHashSchema,
  shareTokenSchema,
} from "../src/index.js";

const checksumA = "a".repeat(64);
const checksumB = "b".repeat(64);
const createdAt = "2026-07-13T01:00:00.000Z";
const finishedAt = "2026-07-13T01:01:00.000Z";

const externalDeliveryPayload = {
  exportJobId: "export-1",
  releaseId: "release-1",
  format: "html",
  packaging: "zip",
  selection: { kind: "release" },
  output: {
    mediaType: "application/zip",
    byteSize: 128,
    sha256: checksumA,
    fileName: "workbench-export.zip",
  },
};

const pendingExternalDelivery = {
  id: "delivery-1",
  exportJobId: "export-1",
  createdById: "principal-1",
  target: "netlify",
  authentication: "required",
  status: "pending_confirmation",
  revision: 0,
  attempt: 0,
  payload: externalDeliveryPayload,
  remoteReference: null,
  failure: null,
  createdAt,
  confirmedAt: null,
  startedAt: null,
  transferAuthorizedAt: null,
  finishedAt: null,
  updatedAt: createdAt,
};

const artifactPin = {
  position: 0,
  artifactId: "artifact-1",
  artifactVersionId: "artifact-version-1",
  title: "Prototype",
  kind: "prototype",
  version: 3,
  schemaVersion: 1,
  checksum: checksumA,
  assets: [],
};

const readyRelease = {
  id: "release-1",
  projectId: "project-1",
  version: 4,
  status: "ready",
  createdById: "principal-1",
  boardId: "board-1",
  boardRevision: 7,
  boardSnapshot: {
    id: "board-1",
    projectId: "project-1",
    revision: 7,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [{
      id: "node-1",
      kind: "artifact",
      parentNodeId: null,
      order: 0,
      position: { x: 10, y: 20 },
      size: { width: 320, height: 240 },
      artifactId: "artifact-1",
      artifactVersionId: "artifact-version-1",
      data: {
        protocol: boardNodeProtocol,
        nodeType: "artifact",
        title: "Home",
        artifactKind: "prototype",
      },
    }],
    edges: [],
  },
  boardChecksum: checksumB,
  artifactPins: [artifactPin],
  manifest: {
    protocol: projectReleaseProtocol,
    projectId: "project-1",
    releaseVersion: 4,
    board: { id: "board-1", revision: 7, checksum: checksumB },
    artifacts: [artifactPin],
  },
  manifestSha256: checksumA,
  failure: null,
  createdAt,
  finishedAt,
  updatedAt: finishedAt,
};

describe("project release contracts", () => {
  it("accepts an immutable ready release snapshot", () => {
    expect(projectReleaseSchema.parse(readyRelease)).toEqual(readyRelease);
  });

  it("rejects duplicate artifact pins", () => {
    const duplicate = {
      ...artifactPin,
      position: 1,
      artifactVersionId: "artifact-version-2",
    };

    expect(projectReleaseSchema.safeParse({
      ...readyRelease,
      artifactPins: [artifactPin, duplicate],
      manifest: { ...readyRelease.manifest, artifacts: [artifactPin, duplicate] },
    }).success).toBe(false);
  });

  it("rejects release state timestamps that contradict status", () => {
    expect(projectReleaseSchema.safeParse({
      ...readyRelease,
      status: "building",
    }).success).toBe(false);

    expect(projectReleaseSchema.safeParse({
      ...readyRelease,
      status: "failed",
      failure: null,
    }).success).toBe(false);
  });

  it("rejects snapshots and manifests that do not match their release", () => {
    expect(projectReleaseSchema.safeParse({
      ...readyRelease,
      boardSnapshot: { ...readyRelease.boardSnapshot, revision: 6 },
    }).success).toBe(false);

    expect(projectReleaseSchema.safeParse({
      ...readyRelease,
      manifest: { ...readyRelease.manifest, releaseVersion: 3 },
    }).success).toBe(false);

    expect(projectReleaseSchema.safeParse({
      ...readyRelease,
      boardSnapshot: {
        ...readyRelease.boardSnapshot,
        nodes: [{
          ...readyRelease.boardSnapshot.nodes[0],
          artifactVersionId: "artifact-version-not-pinned",
        }],
      },
    }).success).toBe(false);
  });

  it("rejects unknown fields at release and nested manifest boundaries", () => {
    expect(projectReleaseSchema.safeParse({ ...readyRelease, tokenHash: checksumA }).success).toBe(false);
    expect(projectReleaseSchema.safeParse({
      ...readyRelease,
      manifest: { ...readyRelease.manifest, legacyProjectId: "project-1" },
    }).success).toBe(false);
  });
});

const activeShare = {
  id: "share-1",
  releaseId: "release-1",
  createdById: "principal-1",
  scope: "view",
  status: "active",
  revision: 0,
  expiresAt: null,
  revokedAt: null,
  createdAt,
  updatedAt: createdAt,
};

describe("share contracts", () => {
  it("reports the complete active count separately from the paginated audit rows", () => {
    expect(shareGrantListSchema.parse({
      items: [activeShare],
      activeCount: 125,
      nextCursor: "next-page",
    })).toMatchObject({ activeCount: 125 });
    expect(shareGrantListSchema.safeParse({
      items: [activeShare],
      nextCursor: null,
    }).success).toBe(false);
  });

  it("uses a stable zero-active response for the idempotent project revoke command", () => {
    expect(revokeProjectShareGrantsResponseSchema.parse({
      projectId: "project-1",
      activeGrantCount: 0,
    })).toEqual({ projectId: "project-1", activeGrantCount: 0 });
    expect(revokeProjectShareGrantsResponseSchema.safeParse({
      projectId: "project-1",
      activeGrantCount: 1,
    }).success).toBe(false);
  });

  it("keeps the raw token one-time response separate from its stored hash", () => {
    const token = `wbs_${"A".repeat(43)}`;

    expect(shareTokenSchema.parse(token)).toBe(token);
    expect(shareTokenSchema.safeParse(checksumA).success).toBe(false);
    expect(shareTokenHashSchema.parse(checksumA)).toBe(checksumA);
    expect(shareTokenHashSchema.safeParse(token).success).toBe(false);
    expect(rotateShareGrantResponseSchema.parse({
      share: activeShare,
      token,
      revokedGrantCount: 2,
    })).toEqual({
      share: activeShare,
      token,
      revokedGrantCount: 2,
    });
  });

  it("does not expose tokenHash in share DTOs", () => {
    expect(shareGrantSchema.safeParse({ ...activeShare, tokenHash: checksumA }).success).toBe(false);
    expect(rotateShareGrantResponseSchema.safeParse({
      share: { ...activeShare, tokenHash: checksumA },
      token: `wbs_${"A".repeat(43)}`,
      revokedGrantCount: 0,
    }).success).toBe(false);
  });

  it("enforces share terminal timestamps", () => {
    expect(shareGrantSchema.safeParse({ ...activeShare, status: "revoked" }).success).toBe(false);
    expect(shareGrantSchema.safeParse({
      ...activeShare,
      status: "revoked",
      revokedAt: finishedAt,
    }).success).toBe(true);
    expect(shareGrantSchema.safeParse({
      ...activeShare,
      status: "expired",
      revokedAt: finishedAt,
    }).success).toBe(false);
  });

  it("keeps Blob identity out of public shared ArtifactVersion projections", () => {
    const publicBlobDetail = {
      artifactId: "artifact-1",
      artifactVersionId: "artifact-version-1",
      version: 3,
      kind: "document",
      schemaVersion: 1,
      status: "ready",
      checksum: checksumA,
      citations: [],
      createdAt,
      contentMode: "blob",
      blob: {
        mediaType: "application/pdf",
        byteSize: 1_024,
        sha256: checksumB,
        fileName: null,
      },
    };
    expect(publicArtifactVersionDetailSchema.parse(publicBlobDetail)).toEqual(publicBlobDetail);
    expect(publicArtifactVersionDetailSchema.safeParse({
      ...publicBlobDetail,
      createdByRunId: "run-internal",
    }).success).toBe(false);
    expect(publicArtifactVersionDetailSchema.safeParse({
      ...publicBlobDetail,
      blob: { ...publicBlobDetail.blob, blobId: "blob-internal" },
    }).success).toBe(false);

    const publicImageAsset = {
      id: "hero-image",
      kind: "image",
      name: "Hero",
      mediaType: "image/png",
      byteSize: 1_024,
      sha256: checksumA,
      width: 640,
      height: 480,
    };
    expect(publicPrototypeImageAssetSchema.parse(publicImageAsset)).toEqual(publicImageAsset);
    expect(publicPrototypeImageAssetSchema.safeParse({
      ...publicImageAsset,
      blobId: "blob-internal",
    }).success).toBe(false);
  });
});

const exportOutput = {
  blobId: "blob-1",
  mediaType: "text/html",
  byteSize: 1_024,
  sha256: checksumA,
  fileName: "prototype.html",
};

const queuedExport = {
  id: "export-1",
  releaseId: "release-1",
  createdById: "principal-1",
  format: "html",
  packaging: "single_file",
  selection: { kind: "release" },
  status: "queued",
  revision: 0,
  options: {},
  output: null,
  failure: null,
  createdAt,
  startedAt: null,
  finishedAt: null,
  updatedAt: createdAt,
};

describe("export contracts", () => {
  it("publishes an exact capability catalog without server proof material", () => {
    const available = { available: true as const, authentication: "not_required" as const, reasonCode: null };
    const catalog = {
      formats: {
        html: available,
        react: available,
        figma: { available: false as const, authentication: "not_required" as const, reasonCode: "EXPORT_FIGMA_UNAVAILABLE" as const },
        mcp: available,
      },
      packaging: { single_file: available, zip: available },
      external: {
        ai_studio: { available: false as const, authentication: "not_required" as const, reasonCode: "EXPORT_EXTERNAL_AI_STUDIO_UNAVAILABLE" as const },
        netlify: { available: false as const, authentication: "required" as const, reasonCode: "EXPORT_EXTERNAL_AUTHENTICATION_REQUIRED" as const },
        lovable: { available: false as const, authentication: "required" as const, reasonCode: "EXPORT_EXTERNAL_AUTHENTICATION_REQUIRED" as const },
        bolt: { available: false as const, authentication: "required" as const, reasonCode: "EXPORT_EXTERNAL_AUTHENTICATION_REQUIRED" as const },
      },
    };
    expect(exportCapabilitiesSchema.parse(catalog)).toEqual(catalog);
    expect(exportCapabilitiesSchema.safeParse({
      ...catalog,
      formats: {
        ...catalog.formats,
        figma: { available: true, authentication: "not_required", reasonCode: null, internalProof: "not-public" },
      },
    }).success).toBe(false);
  });

  it("uses one strict pg-boss command envelope", () => {
    expect(exportBuildQueue).toBe("export.build");
    expect(exportBuildJobSchema.parse({ exportJobId: "export-1" })).toEqual({ exportJobId: "export-1" });
    expect(exportBuildJobSchema.safeParse({ exportJobId: "export-1", releaseId: "release-1" }).success).toBe(false);
  });

  it("uses an exact discriminated union for export selection", () => {
    expect(exportSelectionSchema.parse({ kind: "release" })).toEqual({ kind: "release" });
    expect(exportSelectionSchema.parse({
      kind: "board_nodes",
      nodeIds: ["node-a", "node-z"],
    })).toEqual({
      kind: "board_nodes",
      nodeIds: ["node-a", "node-z"],
    });
    expect(exportSelectionSchema.parse({
      kind: "artifact",
      artifactId: "artifact-1",
      artifactVersionId: "artifact-version-1",
      screenId: "screen-checkout",
    })).toEqual({
      kind: "artifact",
      artifactId: "artifact-1",
      artifactVersionId: "artifact-version-1",
      screenId: "screen-checkout",
    });
    expect(exportSelectionSchema.safeParse({
      kind: "release",
      artifactId: "artifact-1",
      artifactVersionId: "artifact-version-1",
    }).success).toBe(false);
    expect(exportSelectionSchema.safeParse({
      kind: "artifact",
      artifactId: "artifact-1",
    }).success).toBe(false);
    expect(exportSelectionSchema.safeParse({
      kind: "board",
      screenId: "screen-checkout",
    }).success).toBe(false);
    expect(exportSelectionSchema.safeParse({
      kind: "board_nodes",
      nodeIds: [],
    }).success).toBe(false);
    expect(exportSelectionSchema.safeParse({
      kind: "board_nodes",
      nodeIds: ["node-1", "node-1"],
    }).success).toBe(false);
    expect(exportSelectionSchema.safeParse({
      kind: "board_nodes",
      nodeIds: ["node-z", "node-a"],
    }).success).toBe(false);
    expect(exportSelectionSchema.safeParse({
      kind: "board_nodes",
      nodeIds: ["\ue000", "\u{10000}"],
    }).success).toBe(true);
    expect(exportSelectionSchema.safeParse({
      kind: "board_nodes",
      nodeIds: ["\u{10000}", "\ue000"],
    }).success).toBe(false);
  });

  it("resolves selected Frames to their complete descendant closure", () => {
    const nodes = [
      { id: "frame-root", kind: "frame", parentNodeId: null },
      { id: "frame-nested", kind: "frame", parentNodeId: "frame-root" },
      { id: "artifact-child", kind: "artifact", parentNodeId: "frame-nested" },
      { id: "drawing-child", kind: "drawing", parentNodeId: "frame-root" },
      { id: "artifact-outside", kind: "artifact", parentNodeId: null },
    ];

    expect(resolveExportBoardNodeSelection(nodes, ["frame-root"])).toEqual({
      selectedNodes: nodes.slice(0, 4),
      missingNodeIds: [],
    });
    expect(resolveExportBoardNodeSelection(nodes, ["artifact-child", "missing-node"])).toEqual({
      selectedNodes: [nodes[2]],
      missingNodeIds: ["missing-node"],
    });
  });

  it("accepts only the supported export formats", () => {
    expect(createExportJobRequestSchema.safeParse({
      releaseId: "release-1",
      format: "react",
      packaging: "zip",
      selection: { kind: "board" },
    }).success).toBe(true);
    expect(createExportJobRequestSchema.safeParse({
      releaseId: "release-1",
      format: "pdf",
      packaging: "zip",
      selection: { kind: "board" },
    }).success).toBe(false);
    expect(createExportJobRequestSchema.safeParse({
      releaseId: "release-1",
      format: "figma",
      packaging: "zip",
      selection: { kind: "board" },
      options: { converter: "client-supplied" },
    }).success).toBe(false);
  });

  it("enforces output and timestamps for terminal export states", () => {
    expect(exportJobSchema.parse(queuedExport)).toEqual(queuedExport);
    expect(exportJobSchema.safeParse({ ...queuedExport, output: exportOutput }).success).toBe(false);
    expect(exportJobSchema.safeParse({
      ...queuedExport,
      status: "succeeded",
      revision: 2,
      startedAt: createdAt,
      finishedAt,
      output: exportOutput,
      updatedAt: finishedAt,
    }).success).toBe(true);
    expect(exportJobSchema.safeParse({
      ...queuedExport,
      status: "succeeded",
      startedAt: createdAt,
      finishedAt,
      output: { ...exportOutput, byteSize: 0 },
    }).success).toBe(false);
  });

  it("rejects request hashes and other internal fields in public DTOs", () => {
    expect(exportJobSchema.safeParse({ ...queuedExport, requestHash: checksumA }).success).toBe(false);
  });
});

describe("external export delivery contracts", () => {
  it("accepts confirmation, execution, compensation, and terminal snapshots", () => {
    const queued = {
      ...pendingExternalDelivery,
      status: "queued",
      revision: 1,
      confirmedAt: createdAt,
    };
    const running = {
      ...queued,
      status: "running",
      revision: 2,
      attempt: 1,
      startedAt: createdAt,
    };
    const authorizedAt = "2026-07-13T01:00:30.000Z";
    const cancelling = {
      ...running,
      status: "cancelling",
      revision: 4,
      transferAuthorizedAt: authorizedAt,
      remoteReference: "site_1",
    };

    expect(externalExportDeliverySchema.parse(pendingExternalDelivery)).toEqual(pendingExternalDelivery);
    expect(externalExportDeliverySchema.parse(queued)).toEqual(queued);
    expect(externalExportDeliverySchema.parse(running)).toEqual(running);
    expect(externalExportDeliverySchema.parse(cancelling)).toEqual(cancelling);
    expect(externalExportDeliverySchema.safeParse({
      ...running,
      status: "succeeded",
      transferAuthorizedAt: authorizedAt,
      remoteReference: "site_1",
      finishedAt,
    }).success).toBe(true);
    expect(externalExportDeliverySchema.safeParse({
      ...running,
      status: "failed",
      finishedAt,
      failure: { code: "EXPORT_EXTERNAL_TARGET_UNAVAILABLE", detail: null },
    }).success).toBe(true);
    expect(externalExportDeliverySchema.safeParse({
      ...pendingExternalDelivery,
      status: "cancelled",
      revision: 1,
      finishedAt,
    }).success).toBe(true);
  });

  it("requires execution evidence before exposing a remote receipt", () => {
    expect(externalExportDeliverySchema.safeParse({
      ...pendingExternalDelivery,
      status: "cancelling",
      attempt: 1,
      confirmedAt: createdAt,
      startedAt: createdAt,
      remoteReference: "site_without_authorization",
    }).success).toBe(false);
    expect(externalExportDeliverySchema.safeParse({
      ...pendingExternalDelivery,
      status: "cancelled",
      transferAuthorizedAt: createdAt,
      finishedAt,
    }).success).toBe(false);
    expect(externalExportDeliverySchema.safeParse({
      ...pendingExternalDelivery,
      status: "succeeded",
      attempt: 1,
      confirmedAt: createdAt,
      startedAt: createdAt,
      transferAuthorizedAt: createdAt,
      finishedAt,
    }).success).toBe(false);
  });

  it("keeps lease ownership and request hashes out of the public DTO", () => {
    expect(externalExportDeliverySchema.safeParse({
      ...pendingExternalDelivery,
      leaseToken: "internal-lease",
    }).success).toBe(false);
    expect(externalExportDeliverySchema.safeParse({
      ...pendingExternalDelivery,
      requestHash: checksumA,
    }).success).toBe(false);
  });
});
