import { createHash, randomBytes } from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";
import { buildFrozenPrototypeHtml, checkFrozenPrototypeHtml } from "@workbench/workbench-build-worker";
import { prototypeDocumentReactOutput } from "@workbench/workbench-export-core";
import { Prisma, PrismaClient } from "@workbench/workbench-db";
import { pinGeneratedPrototypeDraft, readPrototypeDraft, recordPrototypeBuild, commitPrototypeDraft } from "./prototype-draft.js";
import { assertPrototypeExportActive, startPrototypeExport, finishPrototypeExport, failPrototypeExport, cancelPrototypeExport } from "./prototype-export-state.js";
import { PrototypeArtifactStorage } from "./prototype-artifact-storage.js";
import { DeerFlowRuntimeAdapter } from "../runtime/deerflow-runtime.adapter.js";
import { PrototypeRuntimeBridge, preparePrototypeRuntime } from "./prototype-runtime-bridge.js";
import { PrismaKnowledgeToolGrantIssuer } from "../runtime/knowledge-tool-grant.service.js";
import type { WorkerConfig } from "../config.js";
import { prismaReadyObjectIntegrityRecorder, type ConditionalObjectCreateMode } from "@workbench/workbench-content-security";
import { S3RuntimeReadyBlobReader } from "../storage/s3-runtime-ready-blob-reader.js";
import { loadPrototypeAssets } from "./prototype-assets.js";
import { prototypeDocumentSchema } from "@workbench/workbench-contracts";
import type { RuntimeReadyBlobReader } from "../storage/runtime-ready-blob-reader.port.js";
import type { PrototypeExportInput, PrototypeExportResult, PrototypeWorkflowActivities, PrototypeHeartbeat, PrototypePreviewFreezeInput, PrototypeShareCreateInput, PrototypeShareRevokeInput } from "./temporal-worker.types.js";

export type PrototypeActivitiesConfig = {
  knowledgeTool?: WorkerConfig["knowledgeTool"];
  runtimeBlobStorage?: Pick<WorkerConfig, "s3Bucket" | "s3Region" | "s3InternalEndpoint" | "s3ForcePathStyle" | "runtimeReadyBlobS3AccessKeyId" | "runtimeReadyBlobS3SecretAccessKey">;
  deerFlowUrl: string;
  deerFlowToken: string;
  deerFlowGatewayUrl?: string;
  deerFlowAssistantId?: string;
  deerFlowStreamMode?: string[];
  deerFlowTimeoutMs?: number;
  deerFlowSubmissionTimeoutMs?: number;
  deerFlowIdleTimeoutMs?: number;
  artifactBucket: string;
  artifactPrefix: string;
  artifactEndpoint?: string;
  artifactRegion?: string;
  artifactForcePathStyle?: boolean;
  artifactConditionalCreateMode?: ConditionalObjectCreateMode;
  artifactAccessKeyId?: string;
  artifactSecretAccessKey?: string;
  chromiumExecutablePath?: string;
};

export function createPrototypeActivities(db: PrismaClient, config: PrototypeActivitiesConfig): PrototypeWorkflowActivities {
  const storage = new PrototypeArtifactStorage({
    bucket: config.artifactBucket,
    prefix: config.artifactPrefix,
    conditionalCreateMode: config.artifactConditionalCreateMode,
    client: new S3Client({
      region: config.artifactRegion || "us-east-1",
      endpoint: config.artifactEndpoint,
      forcePathStyle: config.artifactForcePathStyle ?? Boolean(config.artifactEndpoint),
      credentials: config.artifactAccessKeyId && config.artifactSecretAccessKey
        ? { accessKeyId: config.artifactAccessKeyId, secretAccessKey: config.artifactSecretAccessKey }
        : undefined,
    }),
  });
  const sourceReader: RuntimeReadyBlobReader | undefined = config.runtimeBlobStorage
    ? new S3RuntimeReadyBlobReader(config.runtimeBlobStorage, prismaReadyObjectIntegrityRecorder(db)) : undefined;
  const runtime = new DeerFlowRuntimeAdapter({
    deerFlowLangGraphUrl: config.deerFlowUrl,
    deerFlowGatewayUrl: config.deerFlowGatewayUrl || config.deerFlowUrl,
    deerFlowAssistantId: config.deerFlowAssistantId || "lead_agent",
    deerFlowInternalToken: config.deerFlowToken,
    deerFlowStreamMode: config.deerFlowStreamMode || ["messages-tuple", "values"],
    deerFlowTimeoutMs: config.deerFlowTimeoutMs || 600_000,
    deerFlowSubmissionTimeoutMs: config.deerFlowSubmissionTimeoutMs || 120_000,
    deerFlowIdleTimeoutMs: config.deerFlowIdleTimeoutMs || 120_000,
  }, sourceReader ?? { getObject: async () => { throw new Error("DEERFLOW_PROTOTYPE_SOURCE_READER_UNAVAILABLE"); } } satisfies RuntimeReadyBlobReader);
  const generation = new PrototypeRuntimeBridge(db, runtime, new PrismaKnowledgeToolGrantIssuer(db, config.knowledgeTool ?? null), undefined, sourceReader);
  return {
    preparePrototypeGeneration: async (input) => preparePrototypeRuntime(db, input),
    generatePrototype: async (input, signal, heartbeat, retry) => {
      const generated = await generation.generate(input, signal, heartbeat, retry);
      signal.throwIfAborted();
      heartbeat("draft:persist");
      return pinGeneratedPrototypeDraft(db, input, generated);
    },
    buildPrototype: async (input, heartbeat, signal) => {
      signal?.throwIfAborted();
      const draft = await readPrototypeDraft(db, input);
      if (draft.builtArtifact) {
        heartbeat("storage:verify");
        await storage.verifyImmutable(draft.builtArtifact, signal);
        signal?.throwIfAborted();
        return recordPrototypeBuild(db, input, draft.builtArtifact);
      }
      const assets = draft.sourceDocument ? await loadPrototypeAssets(db, draft.sourceDocument, input.projectId, sourceReader, signal) : undefined;
      const built = await buildFrozenPrototypeHtml(input.revisionId, draft.title, draft.pages, { chromiumExecutablePath: config.chromiumExecutablePath, onProgress: heartbeat, sourceDocument: draft.sourceDocument, assets, signal });
      signal?.throwIfAborted();
      heartbeat("storage:freeze");
      const artifact = await storage.putImmutable({ key: `${input.projectId}/${input.revisionId}/preview.html`, sha256: built.htmlSha256, byteSize: built.byteSize, mediaType: "text/html; charset=utf-8" }, Buffer.from(built.html, "utf8"), signal);
      signal?.throwIfAborted();
      return recordPrototypeBuild(db, input, artifact);
    },
    persistPrototypeRevision: (input) => commitPrototypeDraft(db, input),
    persistPrototypeExport: async (input, heartbeat, signal) => persistExport(db, storage, input, config.chromiumExecutablePath, heartbeat, signal, sourceReader),
    freezePrototypePreview: async (input, signal) => freezePrototypePreview(db, storage, input, signal),
    createPrototypeShare: async (input) => createPrototypeShare(db, input),
    revokePrototypeShare: async (input) => revokePrototypeShare(db, input),
    markPlanFailed: async (input) => {
      // Retry this cleanup activity until provider cancellation is acknowledged;
      // cancellation must never be claimed merely because Temporal stopped waiting.
      const status = await generation.settlePlanFailure(input.planId);
      const code = status === "cancelled" ? "PROTOTYPE_WORKFLOW_CANCELLED" : "PROTOTYPE_GENERATION_FAILED";
      const detail = code === input.code ? input.detail
        : status === "cancelled" ? "Prototype generation was cancelled" : "Prototype generation failed";
      await db.$transaction(async (tx) => {
        await tx.prototypePlan.updateMany({ where: { id: input.planId, status: { in: ["approved", "generating"] } }, data: { status, failureCode: code, failureDetail: detail, revision: { increment: 1 } } });
        await tx.prototypeRevision.updateMany({ where: { id: `revision_${input.planId}`, status: { in: ["queued", "generating"] } }, data: { status, failureCode: code, failureDetail: detail, revision: { increment: 1 } } });
      });
    },
    markExportFailed: (input) => failPrototypeExport(db, input),
    markExportCancelled: (input) => cancelPrototypeExport(db, input),
  };
}

async function freezePrototypePreview(db: PrismaClient, storage: PrototypeArtifactStorage, input: PrototypePreviewFreezeInput, signal?: AbortSignal) {
  const revision = await db.prototypeRevision.findUnique({ where: { id: input.revisionId }, select: { projectId: true, status: true, documentSha256: true, builtArtifactKey: true, builtArtifactSha256: true, builtArtifactByteSize: true, builtArtifactMediaType: true } });
  if (!revision || revision.projectId !== input.projectId) return { ok: false as const, code: "PROTOTYPE_REVISION_NOT_FOUND" as const };
  if (revision.status !== "ready" && revision.status !== "confirmed") return { ok: false as const, code: "PROTOTYPE_REVISION_NOT_READY" as const };
  if (!revision.builtArtifactKey || !revision.builtArtifactSha256 || !revision.builtArtifactByteSize || !revision.builtArtifactMediaType) return { ok: false as const, code: "PROTOTYPE_REVISION_NOT_READY" as const };
  await storage.verifyImmutable({ key: revision.builtArtifactKey, sha256: revision.builtArtifactSha256, byteSize: revision.builtArtifactByteSize, mediaType: revision.builtArtifactMediaType }, signal);
  return { ok: true as const, projectId: input.projectId, revisionId: input.revisionId, documentSha256: revision.documentSha256, artifactSha256: revision.builtArtifactSha256 };
}

async function createPrototypeShare(db: PrismaClient, input: PrototypeShareCreateInput) {
  const existing = await db.prototypeShare.findFirst({ where: { projectId: input.projectId, createdById: input.createdById, idempotencyKey: input.idempotencyKey } });
  if (existing) {
    if (existing.requestHash !== input.requestHash) throw new Error("PROTOTYPE_SHARE_IDEMPOTENCY_CONFLICT");
    return { id: existing.id, revision: existing.revision, status: existing.status };
  }
  try {
    const created = await db.prototypeShare.create({ data: { id: `share_${randomBytes(12).toString("hex")}`, projectId: input.projectId, revisionId: input.revisionId, createdById: input.createdById, tokenHash: input.tokenHash, idempotencyKey: input.idempotencyKey, requestHash: input.requestHash, status: "active", revision: 0, expiresAt: input.expiresAt ? new Date(input.expiresAt) : null } });
    return { id: created.id, revision: created.revision, status: created.status };
  } catch (error) {
    const replay = await db.prototypeShare.findFirst({ where: { projectId: input.projectId, createdById: input.createdById, idempotencyKey: input.idempotencyKey } });
    if (replay && replay.requestHash === input.requestHash) return { id: replay.id, revision: replay.revision, status: replay.status };
    throw error;
  }
}

async function revokePrototypeShare(db: PrismaClient, input: PrototypeShareRevokeInput) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM prototype_workflow_commands WHERE id = ${input.commandId} FOR UPDATE`);
    const command = await tx.prototypeWorkflowCommand.findUnique({ where: { id: input.commandId } });
    if (!command || command.projectId !== input.projectId || command.targetId !== input.shareId || command.kind !== "share_revoke" || Number((command.payload as Record<string, string>).expectedRevision) !== input.expectedRevision) throw new Error("PROTOTYPE_SHARE_COMMAND_INVALID");
    if (command.result) return command.result as unknown as { ok: boolean; revision?: number; status: "revoked" | "active" };
    const updated = await tx.prototypeShare.updateMany({ where: { id: input.shareId, projectId: input.projectId, revision: input.expectedRevision, status: "active" }, data: { status: "revoked", revokedAt: new Date(), revision: { increment: 1 } } });
    const result = updated.count === 1 ? { ok: true, revision: input.expectedRevision + 1, status: "revoked" as const } : { ok: false, status: "active" as const };
    await tx.prototypeWorkflowCommand.update({ where: { id: command.id }, data: { result } });
    return result;
  });
}

async function persistExport(db: PrismaClient, storage: PrototypeArtifactStorage, input: PrototypeExportInput, chromiumExecutablePath: string | undefined, heartbeat: PrototypeHeartbeat, signal?: AbortSignal, sourceReader?: RuntimeReadyBlobReader): Promise<PrototypeExportResult> {
  const throwIfAborted = () => { if (signal?.aborted) throw new DOMException("Workflow cancelled", "AbortError"); };
  throwIfAborted();
  const replay = await startPrototypeExport(db, input);
  if (replay) {
    await storage.verifyImmutable(replay, signal);
    return replay;
  }
  const revision = await db.prototypeRevision.findUnique({ where: { id: input.revisionId }, select: { title: true, pages: true, projectId: true, status: true, sourceDocument: true, builtArtifactKey: true, builtArtifactSha256: true, builtArtifactByteSize: true, builtArtifactMediaType: true } });
  if (!revision || revision.projectId !== input.projectId) throw new Error("PROTOTYPE_REVISION_NOT_FOUND");
  if (!["ready", "confirmed"].includes(revision.status)) throw new Error("PROTOTYPE_REVISION_NOT_READY");
  if (!revision.builtArtifactKey || !revision.builtArtifactSha256 || !revision.builtArtifactByteSize || !revision.builtArtifactMediaType) throw new Error("PROTOTYPE_BUILD_EVIDENCE_REQUIRED");
  heartbeat("storage:read");
  const frozen = await storage.readImmutable({ key: revision.builtArtifactKey, sha256: revision.builtArtifactSha256, byteSize: revision.builtArtifactByteSize, mediaType: revision.builtArtifactMediaType }, signal);
  throwIfAborted();
  heartbeat("build:artifact");
  let body: Uint8Array;
  if (input.format === "react") {
    if (!revision.sourceDocument) throw new Error("PROTOTYPE_REACT_SOURCE_UNAVAILABLE");
    const react = await prototypeDocumentReactOutput(revision.sourceDocument, { revisionId: input.revisionId, assets: await loadPrototypeAssets(db, prototypeDocumentSchema.parse(revision.sourceDocument), input.projectId, sourceReader, signal) });
    heartbeat("react:validate");
    await checkFrozenPrototypeHtml(Buffer.from(react.validationBytes).toString("utf8"), { executablePath: chromiumExecutablePath, onProgress: heartbeat, signal });
    body = react.bytes;
  } else {
    body = frozen;
  }
  const mediaType = input.format === "react" ? "application/zip" : "text/html; charset=utf-8";
  const sha256 = createHash("sha256").update(body).digest("hex");
  heartbeat("storage:put");
  throwIfAborted();
  await assertPrototypeExportActive(db, input);
  const stored = await storage.putImmutable({ key: `${input.projectId}/${input.revisionId}/${input.exportId}/${input.commandId}.${input.format === "react" ? "zip" : "html"}`, sha256, byteSize: body.byteLength, mediaType }, body, signal);
  heartbeat("storage:committed");
  throwIfAborted();
  await finishPrototypeExport(db, input, stored);
  return { key: stored.key, sha256: stored.sha256, byteSize: stored.byteSize, mediaType: stored.mediaType };
}
