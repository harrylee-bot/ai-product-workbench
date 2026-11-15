import type { PrototypeDocument, PrototypePage } from "@workbench/workbench-contracts";

export type PrototypeGenerationInput = { projectId: string; planId: string; revisionId: string; prompt: string; title: string; createdById: string };
export type PrototypeGenerationStartInput = { projectId: string; planId: string };
export type PrototypeGenerationResult = { pages: PrototypePage[]; title: string; sourceDocument?: PrototypeDocument };
/** Bounded activity payload: document bodies are pinned in the revision row. */
export type PrototypeDraftReference = {
  projectId: string; planId: string; revisionId: string; title: string;
  documentSha256: string; sourceDocumentSha256: string | null; pageCount: number; byteSize: number;
};
export type PrototypeBuiltDraftReference = PrototypeDraftReference & { artifactKey: string; htmlSha256: string; htmlByteSize: number; htmlMediaType: string };
export type PrototypeExportExecution = { projectId: string; exportId: string; commandId: string };
export type PrototypeExportInput = PrototypeExportExecution & { revisionId: string; format: "html" | "react" };
export type PrototypeExportResult = { sha256: string; byteSize: number; mediaType: string; key: string };
export type PrototypePreviewFreezeInput = { projectId: string; revisionId: string };
export type PrototypePreviewFreezeResult = { ok: true; projectId: string; revisionId: string; documentSha256: string; artifactSha256: string } | { ok: false; code: "PROTOTYPE_REVISION_NOT_READY" | "PROTOTYPE_REVISION_NOT_FOUND" };
export type PrototypeShareCreateInput = {
  projectId: string;
  revisionId: string;
  createdById: string;
  tokenHash: string;
  idempotencyKey: string;
  requestHash: string;
  expiresAt: string | null;
};
export type PrototypeShareCreateResult = { id: string; revision: number; status: "active" | "revoked" | "expired" };
export type PrototypeShareRevokeInput = { projectId: string; shareId: string; expectedRevision: number; commandId: string };
export type PrototypeShareRevokeResult = { ok: boolean; revision?: number; status?: "revoked" | "active" };
export type PrototypeHeartbeat = (details: string) => void;
export type PrototypeWorkflowActivities = {
  preparePrototypeGeneration?: (input: PrototypeGenerationStartInput) => Promise<PrototypeGenerationInput>;
  generatePrototype(input: PrototypeGenerationInput, signal: AbortSignal, heartbeat: PrototypeHeartbeat, retry?: { retryCount: number; retryLimit: number }): Promise<PrototypeDraftReference>;
  buildPrototype(input: PrototypeDraftReference, heartbeat: PrototypeHeartbeat, signal?: AbortSignal): Promise<PrototypeBuiltDraftReference>;
  persistPrototypeRevision(input: PrototypeBuiltDraftReference): Promise<void>;
  persistPrototypeExport(input: PrototypeExportInput, heartbeat: PrototypeHeartbeat, signal?: AbortSignal): Promise<PrototypeExportResult>;
  freezePrototypePreview(input: PrototypePreviewFreezeInput, signal?: AbortSignal): Promise<PrototypePreviewFreezeResult>;
  createPrototypeShare(input: PrototypeShareCreateInput): Promise<PrototypeShareCreateResult>;
  revokePrototypeShare(input: PrototypeShareRevokeInput): Promise<PrototypeShareRevokeResult>;
  markPlanFailed(input: { planId: string; code: string; detail: string }): Promise<void>;
  markExportFailed(input: PrototypeExportExecution & { code: string; detail: string }): Promise<void>;
  markExportCancelled?: (input: PrototypeExportExecution & { detail: string }) => Promise<void>;
};
