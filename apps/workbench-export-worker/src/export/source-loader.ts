import { createHash } from "node:crypto";
import {
  canonicalJson,
  designSystemDocumentSchema,
  projectReleaseSchema,
  prototypeDocumentSchema,
  resolveExportBoardNodeSelection,
  type ExportSelection,
  type JsonValue,
} from "@workbench/workbench-contracts";
import {
  TerminalExportError,
  artifactCanonicalChecksum,
  verifySourcePrototypeDocument,
  type ExportArtifactSource,
  type ExportBinaryAsset,
  type ExportReleaseSource,
} from "@workbench/workbench-export-core";
import type { ExportWorkerConfig } from "../config.js";
import type { ExportStoragePort } from "../storage/storage.port.js";
import type { ExportCommand } from "./export.store.js";

export class ExportSourceLoader {
  constructor(
    private readonly storage: ExportStoragePort,
    private readonly config: Pick<ExportWorkerConfig, "maximumInputBytes">,
  ) {}

  async load(command: NonNullable<ExportCommand>, signal?: AbortSignal): Promise<ExportReleaseSource> {
    const release = sourceSnapshot(command);
    if (release.status !== "ready" || release.finishedAt === null || release.failureCode !== null || release.failureDetail !== null) {
      throw new TerminalExportError("EXPORT_RELEASE_NOT_READY", "Export jobs may consume only a ready immutable ProjectRelease");
    }
    const artifactPins = release.artifactPins.map((pin) => ({
      position: pin.position,
      artifactId: pin.artifactId,
      artifactVersionId: pin.artifactVersionId,
      title: pin.title,
      kind: pin.kind,
      version: pin.artifactVersion.version,
      schemaVersion: pin.artifactVersion.schemaVersion,
      checksum: pin.artifactVersion.checksum,
      assets: pin.artifactVersion.assets.map((asset) => ({
        assetId: asset.assetId,
        kind: asset.kind,
        blobId: asset.blobId,
        mediaType: asset.mediaType,
        byteSize: safeByteSize(asset.byteSize),
        sha256: asset.sha256,
        metadata: asset.metadata,
      })),
    }));
    const releaseDto = projectReleaseSchema.safeParse({
      id: release.id,
      projectId: release.projectId,
      version: release.version,
      status: release.status,
      createdById: release.createdById,
      boardId: release.boardId,
      boardRevision: release.boardRevision,
      boardSnapshot: release.boardSnapshot,
      boardChecksum: release.boardChecksum,
      artifactPins,
      manifest: release.manifest,
      manifestSha256: release.manifestSha256,
      failure: null,
      createdAt: release.createdAt.toISOString(),
      finishedAt: release.finishedAt.toISOString(),
      updatedAt: release.updatedAt.toISOString(),
    });
    if (!releaseDto.success) {
      throw new TerminalExportError("EXPORT_RELEASE_CONTRACT_INVALID", "ProjectRelease snapshot violates the release contract", { cause: releaseDto.error });
    }
    if (sha256Canonical(releaseDto.data.boardSnapshot) !== release.boardChecksum) {
      throw new TerminalExportError("EXPORT_BOARD_CHECKSUM_MISMATCH", "ProjectRelease board snapshot checksum does not match its immutable pin");
    }
    if (sha256Canonical(releaseDto.data.manifest) !== release.manifestSha256) {
      throw new TerminalExportError("EXPORT_MANIFEST_CHECKSUM_MISMATCH", "ProjectRelease manifest checksum does not match its immutable pin");
    }

    let remaining = this.config.maximumInputBytes;
    remaining = consumeBudget(remaining, Buffer.byteLength(canonicalJson(releaseDto.data.boardSnapshot), "utf8"));
    remaining = consumeBudget(remaining, Buffer.byteLength(canonicalJson(releaseDto.data.manifest), "utf8"));
    const selectionPins = release.artifactPins.map((pin) => ({
      position: pin.position,
      artifactId: pin.artifactId,
      artifactVersionId: pin.artifactVersionId,
      title: pin.title,
      kind: pin.kind,
      artifactVersion: pin.artifactVersion,
    }));
    const selectedPins = selectArtifactPins(
      command.selection,
      releaseDto.data.boardSnapshot.nodes,
      selectionPins,
    );
    const artifacts: ExportArtifactSource[] = [];
    const assetCache = new Map<string, Omit<ExportBinaryAsset, "assetId" | "kind">>();
    for (const pin of selectedPins) {
      const version = pin.artifactVersion;
      if (version.status !== "ready"
        || version.projectId !== release.projectId
        || version.artifact.projectId !== release.projectId) {
        throw new TerminalExportError("EXPORT_ARTIFACT_VERSION_NOT_READY", `ArtifactVersion ${version.id} is not a ready member of this release`);
      }
      if (pin.artifactId !== version.artifactId || pin.artifactVersionId !== version.id || version.checksum !== artifactPins[pin.position]?.checksum) {
        throw new TerminalExportError("EXPORT_ARTIFACT_PIN_MISMATCH", `Release pin ${pin.position} does not match its ArtifactVersion`);
      }
      let content: JsonValue | Uint8Array;
      let contentMediaType: string;
      if (version.contentBlobId === null) {
        if (version.content === null || version.contentBlob !== null) throw new TerminalExportError("EXPORT_ARTIFACT_CONTENT_MODE_INVALID", `ArtifactVersion ${version.id} has invalid inline content`);
        content = version.content as JsonValue;
        contentMediaType = "application/json";
        remaining = consumeBudget(remaining, Buffer.byteLength(canonicalJson(content), "utf8"));
      } else {
        const blob = version.contentBlob;
        if (version.content !== null || !blob || blob.status !== "ready" || blob.deletedAt !== null) {
          throw new TerminalExportError("EXPORT_ARTIFACT_BLOB_UNAVAILABLE", `ArtifactVersion ${version.id} Blob is unavailable`);
        }
        const byteSize = safeByteSize(blob.byteSize);
        remaining = consumeBudget(remaining, byteSize);
        content = await this.storage.readVerified({
          storageKey: blob.storageKey,
          byteSize,
          sha256: blob.sha256,
          mediaType: blob.mediaType,
        }, remaining + byteSize, signal);
        contentMediaType = blob.mediaType;
      }
      const artifact: ExportArtifactSource = {
        position: pin.position,
        artifactId: version.artifactId,
        artifactVersionId: version.id,
        kind: pin.kind,
        title: pin.title,
        version: version.version,
        schemaVersion: version.schemaVersion,
        checksum: version.checksum,
        content,
        contentMediaType,
        assets: [],
      };
      if (artifactCanonicalChecksum(artifact) !== artifact.checksum) {
        throw new TerminalExportError("EXPORT_ARTIFACT_CHECKSUM_MISMATCH", `ArtifactVersion ${version.id} content checksum does not match its immutable pin`);
      }
      const expectedAssets = pinnedAssets(artifact);
      if (expectedAssets.length !== version.assets.length) {
        throw new TerminalExportError("EXPORT_ARTIFACT_ASSET_PIN_MISMATCH", `ArtifactVersion ${version.id} asset pin count changed`);
      }
      for (const [index, relation] of version.assets.entries()) {
        const expected = expectedAssets[index];
        const blob = relation.blob;
        if (!expected
          || relation.assetId !== expected.id
          || relation.kind !== expected.kind
          || relation.blobId !== expected.blobId
          || relation.mediaType !== expected.mediaType
          || safeByteSize(relation.byteSize) !== expected.byteSize
          || relation.sha256 !== expected.sha256
          || canonicalJson(relation.metadata) !== canonicalJson(expected)
          || !blob
          || blob.status !== "ready"
          || blob.deletedAt !== null
          || blob.id !== relation.blobId
          || blob.mediaType !== relation.mediaType
          || safeByteSize(blob.byteSize) !== expected.byteSize
          || blob.sha256 !== relation.sha256) {
          throw new TerminalExportError("EXPORT_ARTIFACT_ASSET_PIN_MISMATCH", `ArtifactVersion ${version.id} asset ${relation.assetId} changed after publication`);
        }
        let loaded = assetCache.get(blob.id);
        if (loaded) {
          if (loaded.mediaType !== blob.mediaType
            || loaded.byteSize !== expected.byteSize
            || loaded.sha256 !== blob.sha256
            || loaded.bytes.byteLength !== expected.byteSize) {
            throw new TerminalExportError("EXPORT_ASSET_BLOB_IDENTITY_CONFLICT", `Asset Blob ${blob.id} has conflicting immutable pins`);
          }
        } else {
          remaining = consumeBudget(remaining, expected.byteSize);
          const bytes = await this.storage.readVerified({
            storageKey: blob.storageKey,
            byteSize: expected.byteSize,
            sha256: blob.sha256,
            mediaType: blob.mediaType,
          }, remaining + expected.byteSize, signal);
          loaded = {
            blobId: blob.id,
            mediaType: blob.mediaType,
            byteSize: expected.byteSize,
            sha256: blob.sha256,
            bytes,
          };
          assetCache.set(blob.id, loaded);
        }
        artifact.assets.push({
          assetId: relation.assetId,
          kind: expected.kind,
          ...loaded,
        });
      }
      artifacts.push(artifact);
    }
    return {
      releaseId: release.id,
      projectId: release.projectId,
      releaseVersion: release.version,
      boardSnapshot: releaseDto.data.boardSnapshot,
      manifest: releaseDto.data.manifest,
      artifacts,
    };
  }
}

function sourceSnapshot(command: NonNullable<ExportCommand>) {
  if (command.purpose === "export") {
    if (!command.release || command.preview) {
      throw new TerminalExportError(
        "EXPORT_SOURCE_SNAPSHOT_INVALID",
        "A public Export must consume exactly one immutable ProjectRelease",
      );
    }
    return command.release;
  }
  if (command.release || !command.preview) {
    throw new TerminalExportError(
      "EXPORT_PREVIEW_SNAPSHOT_INVALID",
      "A private Preview must consume exactly one immutable ProjectPreview",
    );
  }
  if (command.preview.expiresAt <= new Date()) {
    throw new TerminalExportError("PREVIEW_EXPIRED", "The temporary Project Preview has expired");
  }
  return previewAsRelease(command);
}

function previewAsRelease(command: NonNullable<ExportCommand>) {
  const preview = command.preview;
  if (!preview) throw new TerminalExportError("EXPORT_PREVIEW_SNAPSHOT_MISSING", "Preview snapshot is unavailable");
  return {
    id: `preview:${preview.id}`,
    projectId: preview.projectId,
    version: 1,
    status: "ready" as const,
    createdById: command.createdById,
    boardId: preview.boardId,
    boardRevision: preview.boardRevision,
    boardSnapshot: preview.boardSnapshot,
    boardChecksum: preview.boardChecksum,
    manifest: preview.manifest,
    manifestSha256: preview.manifestSha256,
    failureCode: null,
    failureDetail: null,
    createdAt: preview.createdAt,
    finishedAt: preview.createdAt,
    updatedAt: preview.updatedAt,
    artifactPins: preview.artifactPins,
  };
}

function selectArtifactPins<Pin extends {
  artifactId: string;
  artifactVersionId: string;
}>(
  selection: ExportSelection,
  boardNodes: ReadonlyArray<{
    id: string;
    kind: string;
    parentNodeId: string | null;
    artifactVersionId: string | null;
  }>,
  pins: readonly Pin[],
): Pin[] {
  if (selection.kind === "release") return [...pins];
  if (selection.kind === "artifact") {
    const selected = pins.filter((pin) => pin.artifactId === selection.artifactId
      && pin.artifactVersionId === selection.artifactVersionId);
    if (selected.length !== 1) {
      throw new TerminalExportError(
        "EXPORT_SELECTION_NOT_PINNED",
        "The selected ArtifactVersion is not pinned by this ProjectRelease",
      );
    }
    return selected;
  }

  const boardSelection = selection.kind === "board_nodes"
    ? resolveExportBoardNodeSelection(boardNodes, selection.nodeIds)
    : null;
  if (boardSelection !== null && boardSelection.missingNodeIds.length > 0) {
    throw new TerminalExportError(
      "EXPORT_BOARD_NODE_SELECTION_NOT_PINNED",
      "Every selected Board node must belong to this ProjectRelease",
    );
  }
  const selectedNodes = boardSelection?.selectedNodes ?? boardNodes;
  const versionIds = new Set(selectedNodes.flatMap((node) => (
    node.artifactVersionId ? [node.artifactVersionId] : []
  )));
  return pins.filter((pin) => versionIds.has(pin.artifactVersionId));
}

function pinnedAssets(artifact: ExportArtifactSource) {
  if (artifact.kind !== "prototype" && artifact.kind !== "design_system") return [];
  let content: unknown = artifact.content;
  if (content instanceof Uint8Array) {
    try {
      content = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content));
    } catch (cause) {
      throw new TerminalExportError("EXPORT_ARTIFACT_JSON_INVALID", `Artifact ${artifact.artifactVersionId} is not valid UTF-8 JSON`, { cause });
    }
  }
  if (artifact.kind === "prototype" && artifact.schemaVersion === 2) {
    verifySourcePrototypeDocument(content);
    return [];
  }
  const parsed = artifact.kind === "prototype"
    ? prototypeDocumentSchema.safeParse(content)
    : designSystemDocumentSchema.safeParse(content);
  if (!parsed.success) {
    throw new TerminalExportError(
      "EXPORT_ARTIFACT_IR_INVALID",
      `Artifact ${artifact.artifactVersionId} violates its workbench IR contract`,
      { cause: parsed.error },
    );
  }
  return parsed.data.assets
    .filter((asset): asset is Extract<typeof asset, { kind: "image" | "font" }> => asset.kind !== "icon")
    .sort((left, right) => left.id.localeCompare(right.id, "en"));
}

function consumeBudget(remaining: number, byteSize: number) {
  if (byteSize > remaining) throw new TerminalExportError("EXPORT_INPUT_SIZE_LIMIT_EXCEEDED", "Pinned ArtifactVersions and assets exceed the export input byte limit");
  return remaining - byteSize;
}

function sha256Canonical(value: JsonValue) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function safeByteSize(value: bigint) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new TerminalExportError("EXPORT_BLOB_SIZE_INVALID", "A pinned Blob has an invalid byte size");
  return number;
}
