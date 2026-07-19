import { createHash } from "node:crypto";
import { boardNodeProtocol, canonicalJson } from "@workbench/workbench-contracts";
import { describe, expect, it, vi } from "vitest";
import { ExportSourceLoader } from "../src/export/source-loader.js";

function fixture() {
  const content = { protocol: "workbench.data.v1", rows: [{ name: "revenue", value: 42 }] };
  const checksum = sha(content);
  const boardSnapshot = {
    id: "board-1",
    projectId: "project-1",
    revision: 2,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [{
      id: "node-1",
      kind: "artifact",
      parentNodeId: null,
      order: 0,
      position: { x: 10, y: 20 },
      size: { width: 400, height: 300 },
      artifactId: "artifact-1",
      artifactVersionId: "version-1",
      data: {
        protocol: boardNodeProtocol,
        nodeType: "artifact",
        title: "Metrics",
        artifactKind: "data",
      },
    }],
    edges: [],
  };
  const pin = {
    position: 0,
    artifactId: "artifact-1",
    artifactVersionId: "version-1",
    title: "Metrics",
    kind: "data",
    version: 1,
    schemaVersion: 1,
    checksum,
    assets: [],
  };
  const manifest = {
    protocol: "workbench.project-release.v1",
    projectId: "project-1",
    releaseVersion: 1,
    board: { id: "board-1", revision: 2, checksum: sha(boardSnapshot) },
    artifacts: [pin],
  };
  const timestamp = new Date("2026-07-13T02:00:00.000Z");
  return {
    id: "export-1",
    createdById: "principal-1",
    format: "html" as const,
    purpose: "export" as const,
    selection: { kind: "release" as const },
    options: {},
    preview: null,
    release: {
      id: "release-1",
      projectId: "project-1",
      version: 1,
      status: "ready" as const,
      createdById: "principal-1",
      boardId: "board-1",
      boardRevision: 2,
      boardSnapshot,
      boardChecksum: sha(boardSnapshot),
      manifest,
      manifestSha256: sha(manifest),
      failureCode: null,
      failureDetail: null,
      createdAt: timestamp,
      finishedAt: timestamp,
      updatedAt: timestamp,
      artifactPins: [{
        releaseId: "release-1",
        projectId: "project-1",
        position: 0,
        artifactId: "artifact-1",
        artifactVersionId: "version-1",
        title: "Metrics",
        kind: "data" as const,
        createdAt: timestamp,
        artifactVersion: {
          id: "version-1",
          artifactId: "artifact-1",
          projectId: "project-1",
          version: 1,
          schemaVersion: 1,
          status: "ready" as const,
          content,
          contentBlobId: null,
          contentBlob: null,
          checksum,
          citations: [],
          createdByRunId: null,
          knowledgeReleaseId: null,
          createdAt: timestamp,
          assets: [],
          artifact: { id: "artifact-1", projectId: "project-1", kind: "data" as const, title: "Mutable current title" },
        },
      }],
    },
  };
}

function prototypeFixture() {
  const command: any = fixture();
  const bytes = Buffer.from("pinned-image-bytes", "utf8");
  const asset = {
    id: "asset-image",
    kind: "image" as const,
    name: "Hero",
    blobId: "blob-image",
    mediaType: "image/png" as const,
    byteSize: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    width: 640,
    height: 360,
  };
  const literal = (value: number) => ({ kind: "literal" as const, value });
  const base = (id: string, parentId: string | null) => ({
    id,
    screenId: "screen-home",
    parentId,
    name: id,
    visible: true,
    layout: {
      mode: "absolute" as const,
      x: literal(0),
      y: literal(0),
      width: literal(640),
      height: literal(360),
      display: "block" as const,
      direction: "column" as const,
      gap: literal(0),
      padding: { top: literal(0), right: literal(0), bottom: literal(0), left: literal(0) },
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
      radii: { topLeft: literal(0), topRight: literal(0), bottomRight: literal(0), bottomLeft: literal(0) },
      shadowTokenIds: [],
      typography: null,
    },
    actionIds: [],
    bindingIds: [],
    motionIds: [],
  });
  const content = {
    protocol: "workbench.prototype.v1" as const,
    documentId: "document-1",
    title: "Checkout",
    revision: 1,
    screens: [{ id: "screen-home", name: "Home", route: "/", rootNodeId: "root-home", initialStateId: null, viewport: { width: 640, height: 360 } }],
    nodes: [
      { ...base("root-home", null), kind: "frame" as const, childIds: ["hero-image"], clipContent: true },
      { ...base("hero-image", "root-home"), kind: "image" as const, assetId: asset.id, fit: "cover" as const, alt: "Hero" },
    ],
    tokens: [],
    assets: [asset],
    variables: [],
    states: [],
    actions: [],
    bindings: [],
    motions: [],
  };
  const checksum = sha(content);
  const assetPin = {
    assetId: asset.id,
    kind: asset.kind,
    blobId: asset.blobId,
    mediaType: asset.mediaType,
    byteSize: asset.byteSize,
    sha256: asset.sha256,
    metadata: structuredClone(asset),
  };
  const pin = {
    position: 0,
    artifactId: "artifact-1",
    artifactVersionId: "version-1",
    title: "Checkout",
    kind: "prototype" as const,
    version: 1,
    schemaVersion: 1,
    checksum,
    assets: [assetPin],
  };
  command.release.artifactPins[0] = {
    ...command.release.artifactPins[0],
    title: pin.title,
    kind: pin.kind,
    artifactVersion: {
      ...command.release.artifactPins[0].artifactVersion,
      content,
      checksum,
      assets: [{
        artifactVersionId: "version-1",
        artifactId: "artifact-1",
        projectId: "project-1",
        ...assetPin,
        metadata: structuredClone(asset),
        byteSize: BigInt(asset.byteSize),
        createdAt: command.release.createdAt,
        blob: {
          id: asset.blobId,
          storageKey: "canonical/assets/blob-image",
          status: "ready",
          deletedAt: null,
          mediaType: asset.mediaType,
          byteSize: BigInt(asset.byteSize),
          sha256: asset.sha256,
        },
      }],
      artifact: {
        ...command.release.artifactPins[0].artifactVersion.artifact,
        kind: pin.kind,
      },
    },
  };
  command.release.manifest = { ...command.release.manifest, artifacts: [pin] };
  command.release.manifestSha256 = sha(command.release.manifest);
  return { command, bytes };
}

function refreshPrototypeChecksum(command: any) {
  const artifactPin = command.release.artifactPins[0];
  const checksum = sha(artifactPin.artifactVersion.content);
  artifactPin.artifactVersion.checksum = checksum;
  const manifestPin = command.release.manifest.artifacts[0];
  manifestPin.checksum = checksum;
  command.release.manifestSha256 = sha(command.release.manifest);
}

function designSystemFixture() {
  const { command, bytes: imageBytes } = prototypeFixture();
  const artifactPin = command.release.artifactPins[0];
  const imageAsset = structuredClone(artifactPin.artifactVersion.assets[0].metadata);
  const imageRelation = artifactPin.artifactVersion.assets[0];
  const fontBytes = Buffer.from("pinned-design-system-font", "utf8");
  const fontAsset = {
    id: "asset-font",
    kind: "font" as const,
    name: "Product UI Semibold",
    blobId: "blob-font",
    mediaType: "font/woff2",
    byteSize: fontBytes.byteLength,
    sha256: createHash("sha256").update(fontBytes).digest("hex"),
    family: "Product UI",
    weight: 600,
    style: "normal" as const,
  };
  const fontRelation = {
    ...imageRelation,
    assetId: fontAsset.id,
    kind: fontAsset.kind,
    blobId: fontAsset.blobId,
    mediaType: fontAsset.mediaType,
    byteSize: BigInt(fontAsset.byteSize),
    sha256: fontAsset.sha256,
    metadata: structuredClone(fontAsset),
    blob: {
      ...imageRelation.blob,
      id: fontAsset.blobId,
      storageKey: "canonical/assets/blob-font",
      mediaType: fontAsset.mediaType,
      byteSize: BigInt(fontAsset.byteSize),
      sha256: fontAsset.sha256,
    },
  };
  artifactPin.artifactVersion.assets = [fontRelation, imageRelation];
  artifactPin.kind = "design_system";
  artifactPin.title = "Product UI";
  artifactPin.artifactVersion.artifact.kind = "design_system";
  artifactPin.artifactVersion.content = {
    protocol: "workbench.design-system.v1",
    documentId: "design-main",
    title: "Product UI",
    tokens: [],
    assets: [imageAsset, fontAsset],
    principles: [],
    guidelines: [],
    components: [],
  };
  const checksum = sha(artifactPin.artifactVersion.content);
  artifactPin.artifactVersion.checksum = checksum;
  command.release.manifest.artifacts[0] = {
    ...command.release.manifest.artifacts[0],
    title: "Product UI",
    kind: "design_system",
    checksum,
    assets: artifactPin.artifactVersion.assets.map((relation: any) => ({
      assetId: relation.assetId,
      kind: relation.kind,
      blobId: relation.blobId,
      mediaType: relation.mediaType,
      byteSize: Number(relation.byteSize),
      sha256: relation.sha256,
      metadata: structuredClone(relation.metadata),
    })),
  };
  command.release.manifestSha256 = sha(command.release.manifest);
  return { command, imageBytes, fontBytes };
}

describe("ExportSourceLoader", () => {
  it("accepts only checksum-verified immutable release and inline ArtifactVersion data", async () => {
    const store = { loadReadyAssetBlobs: vi.fn(async () => []) };
    const storage = { readVerified: vi.fn() };
    const loader = new ExportSourceLoader(store as never, storage as never, { maximumInputBytes: 1024 * 1024 });
    const result = await loader.load(fixture() as never);
    expect(result.releaseId).toBe("release-1");
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]).toMatchObject({ artifactVersionId: "version-1", title: "Metrics", checksum: fixture().release.artifactPins[0]!.artifactVersion.checksum });
    expect(storage.readVerified).not.toHaveBeenCalled();
  });

  it("loads a Preview snapshot without requiring a formal ProjectRelease", async () => {
    const base = fixture() as any;
    const preview = {
      id: "preview-1",
      projectId: "project-1",
      boardId: "board-1",
      boardRevision: base.release.boardRevision,
      boardSnapshot: base.release.boardSnapshot,
      boardChecksum: base.release.boardChecksum,
      manifest: base.release.manifest,
      manifestSha256: base.release.manifestSha256,
      createdById: "viewer-1",
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: base.release.createdAt,
      updatedAt: base.release.updatedAt,
      artifactPins: base.release.artifactPins.map((pin: any) => ({
        ...pin,
        releaseId: undefined,
      })),
    };
    const command = {
      ...base,
      purpose: "preview",
      createdById: "viewer-1",
      release: null,
      preview,
    };
    const loader = new ExportSourceLoader(
      { loadReadyAssetBlobs: vi.fn(async () => []) } as never,
      { readVerified: vi.fn() } as never,
      { maximumInputBytes: 1024 * 1024 },
    );

    const result = await loader.load(command as never);
    expect(result.releaseId).toBe("preview:preview-1");
    expect(result.projectId).toBe("project-1");
    expect(result.artifacts).toHaveLength(1);
  });

  it("rejects expired or purpose-ambiguous Preview snapshots before loading content", async () => {
    const base = fixture() as any;
    const preview = {
      id: "preview-1",
      projectId: "project-1",
      boardId: "board-1",
      boardRevision: base.release.boardRevision,
      boardSnapshot: base.release.boardSnapshot,
      boardChecksum: base.release.boardChecksum,
      manifest: base.release.manifest,
      manifestSha256: base.release.manifestSha256,
      createdById: "viewer-1",
      expiresAt: new Date(Date.now() - 1_000),
      createdAt: base.release.createdAt,
      updatedAt: base.release.updatedAt,
      artifactPins: base.release.artifactPins,
    };
    const loader = new ExportSourceLoader(
      {} as never,
      { readVerified: vi.fn() } as never,
      { maximumInputBytes: 1024 * 1024 },
    );

    await expect(loader.load({
      ...base,
      purpose: "preview",
      release: null,
      preview,
    } as never)).rejects.toMatchObject({ code: "PREVIEW_EXPIRED" });
    await expect(loader.load({
      ...base,
      purpose: "preview",
      preview: { ...preview, expiresAt: new Date(Date.now() + 60_000) },
    } as never)).rejects.toMatchObject({ code: "EXPORT_PREVIEW_SNAPSHOT_INVALID" });
  });

  it("loads Artifacts in the complete descendant closure of selected Frames", async () => {
    const { command, bytes } = prototypeFixture();
    command.release.boardSnapshot.nodes[0].parentNodeId = "frame-nested";
    command.release.boardSnapshot.nodes[0].order = 0;
    command.release.boardSnapshot.nodes.push({
      id: "frame-root",
      kind: "frame",
      parentNodeId: null,
      order: 0,
      position: { x: 0, y: 0 },
      size: { width: 720, height: 420 },
      artifactId: null,
      artifactVersionId: null,
      data: {
        protocol: boardNodeProtocol,
        nodeType: "frame",
        title: "Selected flow",
        fill: null,
        stroke: "#5f6368",
      },
    }, {
      id: "frame-nested",
      kind: "frame",
      parentNodeId: "frame-root",
      order: 0,
      position: { x: 20, y: 20 },
      size: { width: 680, height: 380 },
      artifactId: null,
      artifactVersionId: null,
      data: {
        protocol: boardNodeProtocol,
        nodeType: "frame",
        title: "Nested flow",
        fill: null,
        stroke: "#5f6368",
      },
    });
    command.release.boardChecksum = sha(command.release.boardSnapshot);
    command.release.manifest.board.checksum = command.release.boardChecksum;
    command.release.manifestSha256 = sha(command.release.manifest);
    command.selection = { kind: "board_nodes", nodeIds: ["frame-root"] };
    const storage = { readVerified: vi.fn(async () => bytes) };
    const loader = new ExportSourceLoader({} as never, storage as never, { maximumInputBytes: 1024 * 1024 });

    const result = await loader.load(command as never);

    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]).toMatchObject({ artifactVersionId: "version-1" });
    expect(storage.readVerified).toHaveBeenCalledTimes(1);
  });

  it("rejects a replayed Board-node selection outside the Release before reading Artifact bytes", async () => {
    const { command } = prototypeFixture();
    command.selection = { kind: "board_nodes", nodeIds: ["node-outside-release"] };
    const storage = { readVerified: vi.fn() };
    const loader = new ExportSourceLoader({} as never, storage as never, { maximumInputBytes: 1024 * 1024 });

    await expect(loader.load(command as never)).rejects.toMatchObject({
      code: "EXPORT_BOARD_NODE_SELECTION_NOT_PINNED",
    });
    expect(storage.readVerified).not.toHaveBeenCalled();
  });

  it("rejects a changed board snapshot or changed ArtifactVersion content", async () => {
    const loader = new ExportSourceLoader({ loadReadyAssetBlobs: vi.fn(async () => []) } as never, { readVerified: vi.fn() } as never, { maximumInputBytes: 1024 * 1024 });
    const boardChanged = fixture();
    boardChanged.release.boardSnapshot.nodes[0]!.position.x = 999;
    await expect(loader.load(boardChanged as never)).rejects.toMatchObject({ code: "EXPORT_BOARD_CHECKSUM_MISMATCH" });

    const contentChanged = fixture();
    contentChanged.release.artifactPins[0]!.artifactVersion.content.rows[0]!.value = 43;
    await expect(loader.load(contentChanged as never)).rejects.toMatchObject({ code: "EXPORT_ARTIFACT_CHECKSUM_MISMATCH" });
  });

  it("loads Prototype bytes only through the immutable asset relation", async () => {
    const { command, bytes } = prototypeFixture();
    const storage = { readVerified: vi.fn(async () => bytes) };
    const loader = new ExportSourceLoader({} as never, storage as never, { maximumInputBytes: 1024 * 1024 });

    const result = await loader.load(command as never);

    expect(storage.readVerified).toHaveBeenCalledTimes(1);
    expect(storage.readVerified).toHaveBeenCalledWith({
      storageKey: "canonical/assets/blob-image",
      byteSize: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      mediaType: "image/png",
    }, expect.any(Number), undefined);
    expect(result.artifacts[0]!.assets).toEqual([{
      assetId: "asset-image",
      kind: "image",
      blobId: "blob-image",
      mediaType: "image/png",
      byteSize: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes,
    }]);
  });

  it("carries a Design System Artifact and verifies all of its immutable asset pins", async () => {
    const { command, imageBytes, fontBytes } = designSystemFixture();
    const storage = {
      readVerified: vi.fn(async ({ storageKey }: { storageKey: string }) => (
        storageKey.endsWith("blob-font") ? fontBytes : imageBytes
      )),
    };
    const loader = new ExportSourceLoader({} as never, storage as never, { maximumInputBytes: 1024 * 1024 });

    const result = await loader.load(command as never);

    expect(result.artifacts[0]).toMatchObject({
      kind: "design_system",
      title: "Product UI",
      assets: [
        { assetId: "asset-font", kind: "font", blobId: "blob-font", bytes: fontBytes },
        { assetId: "asset-image", kind: "image", blobId: "blob-image", bytes: imageBytes },
      ],
    });
    expect(storage.readVerified).toHaveBeenCalledTimes(2);
  });

  it("requires the manifest, asset relation, and Prototype asset metadata to be canonically identical", async () => {
    const manifestChanged = prototypeFixture();
    manifestChanged.command.release.manifest.artifacts[0].assets[0].metadata.name = "Changed in manifest";
    manifestChanged.command.release.manifestSha256 = sha(manifestChanged.command.release.manifest);
    await expect(new ExportSourceLoader({} as never, { readVerified: vi.fn() } as never, { maximumInputBytes: 1024 * 1024 })
      .load(manifestChanged.command as never)).rejects.toMatchObject({ code: "EXPORT_RELEASE_CONTRACT_INVALID" });

    const relationChanged = prototypeFixture();
    relationChanged.command.release.artifactPins[0].artifactVersion.assets[0].metadata.name = "Changed in relation";
    relationChanged.command.release.manifest.artifacts[0].assets[0].metadata.name = "Changed in relation";
    relationChanged.command.release.manifestSha256 = sha(relationChanged.command.release.manifest);
    await expect(new ExportSourceLoader({} as never, { readVerified: vi.fn() } as never, { maximumInputBytes: 1024 * 1024 })
      .load(relationChanged.command as never)).rejects.toMatchObject({ code: "EXPORT_ARTIFACT_ASSET_PIN_MISMATCH" });
  });

  it("rejects an unpinned Prototype blobId before reading storage", async () => {
    const { command } = prototypeFixture();
    command.release.artifactPins[0].artifactVersion.content.assets[0].blobId = "blob-unpinned";
    refreshPrototypeChecksum(command);
    const storage = { readVerified: vi.fn() };
    const loader = new ExportSourceLoader({} as never, storage as never, { maximumInputBytes: 1024 * 1024 });

    await expect(loader.load(command as never)).rejects.toMatchObject({ code: "EXPORT_ARTIFACT_ASSET_PIN_MISMATCH" });
    expect(storage.readVerified).not.toHaveBeenCalled();
  });
});

function sha(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
