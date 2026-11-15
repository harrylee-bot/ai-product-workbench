import { createHash } from "node:crypto";
import { canonicalJson, prototypeDocumentSchema, prototypePageSchema } from "@workbench/workbench-contracts";
import { Prisma, type PrismaClient } from "@workbench/workbench-db";
import type { PrototypeArtifactIdentity } from "./prototype-artifact-storage.js";
import type { PrototypeBuiltDraftReference, PrototypeDraftReference, PrototypeGenerationInput, PrototypeGenerationResult } from "./temporal-worker.types.js";

const pendingHash = "0".repeat(64);
type Db = PrismaClient | Prisma.TransactionClient;

/** Persist large model/render data before completing the activity. Temporal
 * records only the bounded reference, so retry/history size is independent of
 * the number of pages, embedded assets, and HTML bytes. */
export async function pinGeneratedPrototypeDraft(db: PrismaClient, input: PrototypeGenerationInput, generated: PrototypeGenerationResult): Promise<PrototypeDraftReference> {
  const pages = generated.pages.map(page => prototypePageSchema.parse(page));
  if (pages.length < 1 || pages.length > 50) throw new Error("PROTOTYPE_PAGE_COUNT_INVALID");
  const sourceDocument = generated.sourceDocument ? prototypeDocumentSchema.parse(generated.sourceDocument) : null;
  const reference: PrototypeDraftReference = {
    projectId: input.projectId, planId: input.planId, revisionId: input.revisionId, title: generated.title,
    ...(generated.sourceArtifactVersionId ? { sourceArtifactVersionId: generated.sourceArtifactVersionId } : {}),
    documentSha256: hash(pages), sourceDocumentSha256: sourceDocument ? hash(sourceDocument) : null,
    pageCount: pages.length, byteSize: payloadSize(pages, sourceDocument),
  };
  return db.$transaction(async tx => {
    await lockPlan(tx, reference);
    const { plan, revision } = await loadRows(tx, reference);
    if (revision.documentSha256 !== pendingHash) {
      assertDraft(reference, revision);
      if (!["approved", "generating", "ready"].includes(plan.status) || !["queued", "generating", "ready", "confirmed"].includes(revision.status)) throw new Error("PROTOTYPE_DRAFT_NOT_ACTIVE");
      return reference;
    }
    if (!["approved", "generating"].includes(plan.status)) throw new Error("PROTOTYPE_PLAN_NOT_ACTIVE");
    const updated = await tx.prototypeRevision.updateMany({
      where: { id: revision.id, projectId: input.projectId, revision: revision.revision, documentSha256: pendingHash, status: { in: ["queued", "generating"] } },
      data: { title: generated.title, pages: pages as Prisma.InputJsonValue, ...(sourceDocument ? { sourceDocument: sourceDocument as Prisma.InputJsonValue } : {}), ...(generated.sourceArtifactVersionId ? { sourceArtifactVersionId: generated.sourceArtifactVersionId } : {}), documentSha256: reference.documentSha256, revision: { increment: 1 } },
    });
    if (updated.count !== 1) throw new Error("PROTOTYPE_DRAFT_CONFLICT");
    return reference;
  });
}

export async function readPrototypeDraft(db: Db, reference: PrototypeDraftReference) {
  const { plan, revision } = await loadRows(db, reference);
  if (!["approved", "generating", "ready"].includes(plan.status) || !["queued", "generating", "ready", "confirmed"].includes(revision.status)) throw new Error("PROTOTYPE_DRAFT_NOT_ACTIVE");
  return { ...assertDraft(reference, revision), builtArtifact: storedArtifact(revision) };
}

export async function recordPrototypeBuild(db: PrismaClient, reference: PrototypeDraftReference, artifact: PrototypeArtifactIdentity): Promise<PrototypeBuiltDraftReference> {
  const built = { ...reference, artifactKey: artifact.key, htmlSha256: artifact.sha256, htmlByteSize: artifact.byteSize, htmlMediaType: artifact.mediaType };
  await db.$transaction(async tx => {
    await lockPlan(tx, reference);
    const { plan, revision } = await loadRows(tx, reference);
    assertDraft(reference, revision);
    if (!["approved", "generating", "ready"].includes(plan.status) || !["queued", "generating", "ready", "confirmed"].includes(revision.status)) throw new Error("PROTOTYPE_DRAFT_NOT_ACTIVE");
    const existing = storedArtifact(revision);
    if (existing) { assertBuild(built, existing); return; }
    if (!["approved", "generating"].includes(plan.status)) throw new Error("PROTOTYPE_PLAN_NOT_ACTIVE");
    const updated = await tx.prototypeRevision.updateMany({ where: { id: revision.id, projectId: reference.projectId, revision: revision.revision, documentSha256: reference.documentSha256, status: { in: ["queued", "generating"] }, builtArtifactKey: null }, data: {
      builtArtifactKey: artifact.key, builtArtifactSha256: artifact.sha256, builtArtifactByteSize: artifact.byteSize, builtArtifactMediaType: artifact.mediaType, revision: { increment: 1 },
    } });
    if (updated.count !== 1) throw new Error("PROTOTYPE_BUILD_STATE_CHANGED");
  });
  return built;
}

export async function commitPrototypeDraft(db: PrismaClient, reference: PrototypeBuiltDraftReference): Promise<void> {
  if (!/^[a-f0-9]{64}$/u.test(reference.htmlSha256) || !Number.isSafeInteger(reference.htmlByteSize) || reference.htmlByteSize <= 0) throw new Error("PROTOTYPE_BUILD_EVIDENCE_REQUIRED");
  await db.$transaction(async tx => {
    await lockPlan(tx, reference);
    const { plan, revision } = await loadRows(tx, reference);
    assertDraft(reference, revision);
    const artifact = storedArtifact(revision);
    if (!artifact) throw new Error("PROTOTYPE_BUILD_EVIDENCE_REQUIRED");
    assertBuild(reference, artifact);
    if (plan.status === "ready" && ["ready", "confirmed"].includes(revision.status)) return;
    const planUpdate = await tx.prototypePlan.updateMany({ where: { id: plan.id, projectId: reference.projectId, revision: plan.revision, status: { in: ["approved", "generating"] } }, data: { status: "ready", revision: { increment: 1 } } });
    if (planUpdate.count !== 1) throw new Error("PROTOTYPE_PLAN_NOT_ACTIVE");
    const updated = await tx.prototypeRevision.updateMany({ where: { id: revision.id, projectId: reference.projectId, revision: revision.revision, documentSha256: reference.documentSha256, status: { in: ["queued", "generating"] } }, data: { status: "ready", revision: { increment: 1 } } });
    if (updated.count !== 1) throw new Error("PROTOTYPE_REVISION_NOT_ACTIVE");
  });
}

async function lockPlan(tx: Prisma.TransactionClient, reference: PrototypeDraftReference) {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "prototype_plans" WHERE "id" = ${reference.planId} AND "project_id" = ${reference.projectId} FOR UPDATE`);
}

async function loadRows(db: Db, reference: PrototypeDraftReference) {
  const plan = await db.prototypePlan.findFirst({ where: { id: reference.planId, projectId: reference.projectId } });
  const revision = await db.prototypeRevision.findFirst({ where: { id: reference.revisionId, planId: plan?.rootPlanId ?? reference.planId, projectId: reference.projectId } });
  if (!plan || !revision) throw new Error("PROTOTYPE_REVISION_NOT_FOUND");
  return { plan, revision };
}

function assertDraft(reference: PrototypeDraftReference, revision: { title: string; pages: unknown; sourceDocument: unknown; documentSha256: string; sourceArtifactVersionId?: string | null }) {
  const pages = Array.isArray(revision.pages) ? revision.pages.map(page => prototypePageSchema.parse(page)) : [];
  const sourceDocument = revision.sourceDocument ? prototypeDocumentSchema.parse(revision.sourceDocument) : null;
  if ((reference.sourceArtifactVersionId && reference.sourceArtifactVersionId !== revision.sourceArtifactVersionId) || revision.title !== reference.title || revision.documentSha256 !== reference.documentSha256 || hash(pages) !== reference.documentSha256
    || (sourceDocument ? hash(sourceDocument) : null) !== reference.sourceDocumentSha256 || pages.length !== reference.pageCount
    || payloadSize(pages, sourceDocument) !== reference.byteSize) throw new Error("PROTOTYPE_DRAFT_INTEGRITY_FAILURE");
  return { title: revision.title, pages, sourceDocument };
}

function hash(value: unknown) { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
function payloadSize(pages: unknown, sourceDocument: unknown) { return Buffer.byteLength(canonicalJson({ pages, sourceDocument }), "utf8"); }

function storedArtifact(revision: { builtArtifactKey: string | null; builtArtifactSha256: string | null; builtArtifactByteSize: number | null; builtArtifactMediaType: string | null }): PrototypeArtifactIdentity | undefined {
  if (!revision.builtArtifactKey) return undefined;
  if (!revision.builtArtifactSha256 || !revision.builtArtifactByteSize || !revision.builtArtifactMediaType) throw new Error("PROTOTYPE_BUILD_MANIFEST_INVALID");
  return { key: revision.builtArtifactKey, sha256: revision.builtArtifactSha256, byteSize: revision.builtArtifactByteSize, mediaType: revision.builtArtifactMediaType };
}
function assertBuild(reference: PrototypeBuiltDraftReference, artifact: PrototypeArtifactIdentity) {
  if (reference.artifactKey !== artifact.key || reference.htmlSha256 !== artifact.sha256 || reference.htmlByteSize !== artifact.byteSize || reference.htmlMediaType !== artifact.mediaType) throw new Error("PROTOTYPE_BUILD_INTEGRITY_FAILURE");
}
