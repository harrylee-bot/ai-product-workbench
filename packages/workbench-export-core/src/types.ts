import type {
  ExportFormat,
  ExportPackaging,
  ExportSelection,
  JsonValue,
  ProjectReleaseBoardSnapshot,
  ProjectReleaseManifest,
} from "@workbench/workbench-contracts";

export type ExportBinaryAsset = {
  assetId: string;
  kind: "image" | "font";
  blobId: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
  bytes: Uint8Array;
};

export type ExportArtifactSource = {
  position: number;
  artifactId: string;
  artifactVersionId: string;
  kind: "prd" | "prototype" | "image" | "code" | "document" | "data" | "design_system";
  title: string;
  version: number;
  schemaVersion: number;
  checksum: string;
  content: JsonValue | Uint8Array;
  contentMediaType: string;
  assets: ExportBinaryAsset[];
};

export type ExportReleaseSource = {
  releaseId: string;
  projectId: string;
  releaseVersion: number;
  boardSnapshot: ProjectReleaseBoardSnapshot;
  manifest: ProjectReleaseManifest;
  artifacts: ExportArtifactSource[];
};

export type ExportBuildRequest = {
  format: ExportFormat;
  packaging: ExportPackaging;
  selection: ExportSelection;
  initialScreenId?: string;
  options: Record<string, JsonValue>;
  source: ExportReleaseSource;
};

export type ExportBuildExecution = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type ExportBuildOutput = {
  bytes: Uint8Array;
  mediaType: string;
  fileName: string;
  validationTarget: "html" | "archive" | "figma-package";
  validationBytes?: Uint8Array;
};

export type RenderedHtml = {
  document: string;
  bodyMarkup: string;
  styles: string;
  runtimeSource: string;
  runtimeData: JsonValue;
  fontAssets: RenderedFontAsset[];
  title: string;
};

export type RenderedFontAsset = {
  artifactVersionId: string;
  assetId: string;
  family: string;
  weight: number;
  style: "normal" | "italic";
  mediaType: string;
  byteSize: number;
  sha256: string;
  bytes: Uint8Array;
};
