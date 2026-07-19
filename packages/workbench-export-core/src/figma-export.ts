import { createHash } from "node:crypto";
import {
  canonicalJson,
  figmaExportDocumentSchema,
  prototypeDocumentSchema,
  workbenchFigmaImporterVersion,
  type FigmaExportAsset,
  type FigmaExportDocument,
  type PrototypeAsset,
} from "@workbench/workbench-contracts";
import { createDeterministicZip, type ArchiveEntry } from "./archive.js";
import { TerminalExportError } from "./errors.js";
import { safeFileStem } from "./encoding.js";
import { selectExportArtifacts } from "./html-renderer.js";
import type {
  ExportArtifactSource,
  ExportBinaryAsset,
  ExportBuildOutput,
  ExportBuildRequest,
} from "./types.js";

const documentEntryName = "figma-export.json";

export async function figmaOutput(request: ExportBuildRequest): Promise<ExportBuildOutput> {
  const selected = selectExportArtifacts(
    request.source.artifacts,
    request.selection,
    request.source.boardSnapshot.nodes,
  );
  if (!selected.some((artifact) => artifact.kind === "prototype")) {
    throw new TerminalExportError(
      "EXPORT_FIGMA_PROTOTYPE_REQUIRED",
      "Figma Export requires at least one pinned Prototype ArtifactVersion",
    );
  }
  if (selected.some((artifact) => artifact.kind !== "prototype")) {
    throw new TerminalExportError(
      "EXPORT_FIGMA_SELECTION_UNSUPPORTED",
      "Figma Export cannot silently omit non-Prototype ArtifactVersions from a mixed selection",
    );
  }

  const archiveAssets = new Map<string, Uint8Array>();
  const assets: FigmaExportAsset[] = [];
  const prototypes = selected.map((artifact) => {
    const document = parsePrototype(artifact);
    const selectedScreenIds = request.selection.kind === "artifact"
      && request.selection.artifactVersionId === artifact.artifactVersionId
      && request.selection.screenId
      ? [request.selection.screenId]
      : document.screens.map((screen) => screen.id);

    for (const asset of document.assets) {
      if (asset.kind === "icon") continue;
      const binary = requireAsset(artifact, asset);
      const archivePath = `assets/${asset.sha256}.${assetExtension(asset.mediaType)}`;
      const existing = archiveAssets.get(archivePath);
      if (existing && !equalBytes(existing, binary.bytes)) {
        throw new TerminalExportError(
          "EXPORT_FIGMA_ASSET_IDENTITY_CONFLICT",
          `Content-addressed Figma Export asset ${archivePath} has conflicting bytes`,
        );
      }
      archiveAssets.set(archivePath, binary.bytes);
      assets.push({
        artifactVersionId: artifact.artifactVersionId,
        assetId: asset.id,
        kind: asset.kind,
        mediaType: asset.mediaType,
        byteSize: asset.byteSize,
        sha256: asset.sha256,
        archivePath,
      });
    }

    return {
      artifactId: artifact.artifactId,
      artifactVersionId: artifact.artifactVersionId,
      title: artifact.title,
      version: artifact.version,
      checksum: artifact.checksum,
      selectedScreenIds,
      document,
    };
  });

  const figmaDocument = figmaExportDocumentSchema.parse({
    protocol: "workbench.figma-export.v1",
    schemaVersion: 1,
    importer: {
      minimumVersion: workbenchFigmaImporterVersion,
      pluginName: "产品工作台 Importer",
    },
    release: {
      id: request.source.releaseId,
      projectId: request.source.projectId,
      version: request.source.releaseVersion,
    },
    selection: request.selection,
    prototypes,
    assets: assets.sort((left, right) => (
      left.artifactVersionId.localeCompare(right.artifactVersionId, "en")
      || left.assetId.localeCompare(right.assetId, "en")
    )),
  } satisfies FigmaExportDocument);
  const documentJson = `${canonicalJson(figmaDocument)}\n`;
  const documentSha256 = createHash("sha256").update(documentJson).digest("hex");
  const manifest = {
    protocol: "workbench.figma-package.v1",
    release: figmaDocument.release,
    importer: figmaDocument.importer,
    document: {
      path: documentEntryName,
      sha256: documentSha256,
      byteSize: Buffer.byteLength(documentJson),
    },
    assets: [...archiveAssets.entries()]
      .map(([archivePath, bytes]) => ({
        archivePath,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        byteSize: bytes.byteLength,
      }))
      .sort((left, right) => left.archivePath.localeCompare(right.archivePath, "en")),
  };
  const entries: ArchiveEntry[] = [
    { name: documentEntryName, content: documentJson },
    { name: "manifest.json", content: `${canonicalJson(manifest)}\n` },
    {
      name: "README.md",
      content: [
        "# 产品工作台 Figma 导出包",
        "",
        `此包遵循 \`workbench.figma-export.v1\`，需要“产品工作台 Importer” ${workbenchFigmaImporterVersion} 或更高兼容版本。`,
        "在 Figma Desktop 中安装固定 Importer 后，选择本 ZIP 即可导入。",
        "此文件不是私有 `.fig`/Kiwi 文件，也不依赖剪贴板协议。",
        "",
      ].join("\n"),
    },
    ...[...archiveAssets.entries()].map(([name, content]) => ({ name, content })),
  ];
  const bytes = await createDeterministicZip(entries);
  const stem = request.selection.kind === "artifact"
    ? safeFileStem(selected[0]?.title ?? "prototype")
    : `release-${request.source.releaseVersion}`;
  return {
    bytes,
    mediaType: "application/zip",
    fileName: `${stem}-figma.zip`,
    validationTarget: "figma-package",
  };
}

function parsePrototype(artifact: ExportArtifactSource) {
  if (artifact.content instanceof Uint8Array) {
    try {
      return prototypeDocumentSchema.parse(JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(artifact.content),
      ));
    } catch (cause) {
      throw new TerminalExportError(
        "EXPORT_PROTOTYPE_IR_INVALID",
        `Prototype ${artifact.artifactVersionId} is not valid workbench.prototype.v1 JSON`,
        { cause },
      );
    }
  }
  const parsed = prototypeDocumentSchema.safeParse(artifact.content);
  if (!parsed.success) {
    throw new TerminalExportError(
      "EXPORT_PROTOTYPE_IR_INVALID",
      `Prototype ${artifact.artifactVersionId} does not conform to workbench.prototype.v1`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

function requireAsset(
  artifact: ExportArtifactSource,
  asset: Exclude<PrototypeAsset, { kind: "icon" }>,
): ExportBinaryAsset {
  const binary = artifact.assets.find((candidate) => candidate.assetId === asset.id);
  if (!binary
    || binary.kind !== asset.kind
    || binary.blobId !== asset.blobId
    || binary.mediaType !== asset.mediaType
    || binary.byteSize !== asset.byteSize
    || binary.sha256 !== asset.sha256
    || binary.bytes.byteLength !== asset.byteSize
    || createHash("sha256").update(binary.bytes).digest("hex") !== asset.sha256) {
    throw new TerminalExportError(
      "EXPORT_FIGMA_ASSET_IDENTITY_MISMATCH",
      `Prototype asset ${artifact.artifactVersionId}/${asset.id} is missing or changed`,
    );
  }
  return binary;
}

function assetExtension(mediaType: FigmaExportAsset["mediaType"]): string {
  const extensions: Record<FigmaExportAsset["mediaType"], string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "font/woff": "woff",
    "font/woff2": "woff2",
  };
  return extensions[mediaType];
}

function equalBytes(left: Uint8Array, right: Uint8Array) {
  return left.byteLength === right.byteLength
    && left.every((value, index) => value === right[index]);
}
