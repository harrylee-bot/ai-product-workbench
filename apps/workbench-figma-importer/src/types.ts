import type { FigmaExportDocument } from "@workbench/workbench-contracts";

export const FIGMA_IMPORT_EVENTS = {
  document: "WORKBENCH_IMPORT_DOCUMENT",
  progress: "WORKBENCH_IMPORT_PROGRESS",
  completed: "WORKBENCH_IMPORT_COMPLETED",
  failed: "WORKBENCH_IMPORT_FAILED",
} as const;

/** Asset identity is scoped by the pinned ArtifactVersion, not only assetId. */
export type FigmaImportAssetBytes = Record<string, Uint8Array>;

export function figmaImportAssetKey(artifactVersionId: string, assetId: string): string {
  return `${artifactVersionId}\u0000${assetId}`;
}

export type FigmaImportPayload = {
  document: FigmaExportDocument;
  assets: FigmaImportAssetBytes;
};

export type ImportDocumentHandler = (payload: FigmaImportPayload) => void | Promise<void>;
export type ImportDocumentEvent = {
  name: typeof FIGMA_IMPORT_EVENTS.document;
  handler: ImportDocumentHandler;
};
export type ImportProgressHandler = (progress: {
  phase: "validating" | "creating" | "finished";
  completed: number;
  total: number;
  message: string;
}) => void;
export type ImportProgressEvent = {
  name: typeof FIGMA_IMPORT_EVENTS.progress;
  handler: ImportProgressHandler;
};
export type ImportCompletedHandler = (result: {
  pageCount: number;
  screenCount: number;
  nodeCount: number;
}) => void;
export type ImportCompletedEvent = {
  name: typeof FIGMA_IMPORT_EVENTS.completed;
  handler: ImportCompletedHandler;
};
export type ImportFailedHandler = (failure: {
  code: string;
  message: string;
}) => void;
export type ImportFailedEvent = {
  name: typeof FIGMA_IMPORT_EVENTS.failed;
  handler: ImportFailedHandler;
};
