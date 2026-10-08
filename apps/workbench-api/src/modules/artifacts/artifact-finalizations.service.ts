import { createHash, randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { artifactFinalizationStateSchema, canonicalJson, knowledgeReleaseBuildQueue } from "@workbench/workbench-contracts";
import { Prisma } from "@workbench/workbench-db";
import { notFoundProblem, validationProblem } from "../../common/problem-details.js";
import { WorkbenchDbService } from "../../platform/database/workbench-db.service.js";
import { WorkbenchQueueService } from "../../platform/queue/workbench-queue.service.js";
import { AccessService } from "../access/access.service.js";
import { assertProjectCapability } from "../projects/project-lock.js";

const detailInclude = { ingestionJob: { include: { releases: {
  select: { id: true, version: true, status: true, parentReleaseId: true },
  orderBy: { version: "desc" as const },
} } } } as const;

@Injectable()
export class ArtifactFinalizationsService {
  constructor(
    private readonly db: WorkbenchDbService,
    private readonly access: AccessService,
    private readonly queue: WorkbenchQueueService,
  ) {}

  async get(principalId: string, artifactId: string, versionId: string) {
    await this.authorize(principalId, artifactId, versionId);
    return this.db.artifactFinalization.findUnique({
      where: { artifactVersionId: versionId }, include: detailInclude,
    });
  }

  async confirm(principalId: string, artifactId: string, versionId: string, checksum: string) {
    const version = await this.authorize(principalId, artifactId, versionId);
    if (version.checksum !== checksum) throw validationProblem("ARTIFACT_FINALIZATION_CHECKSUM_MISMATCH");
    return this.db.$transaction(async (tx) => {
      await lockProjectKnowledgeWrite(tx, version.projectId, principalId);
      const existing = await tx.artifactFinalization.findUnique({ where: { artifactVersionId: versionId }, include: detailInclude });
      if (existing) return existing;
      if (!["prd", "document", "prototype"].includes(version.artifact.kind) || version.content === null) {
        throw validationProblem("Only ready, structured PRD, document and Prototype versions can be finalized");
      }
      if (digest(canonicalJson(version.content)) !== version.checksum) throw validationProblem("ARTIFACT_CONTENT_CHECKSUM_MISMATCH");
      // The snapshot is immutable and project-private; never write generated content to public Quartz.
      const markdown = artifactKnowledgeMarkdown(`${version.artifact.title} (v${version.version})`, version.content);
      const finalization = await tx.artifactFinalization.create({ data: {
        artifactVersionId: version.id, projectId: version.projectId, confirmedById: principalId,
        checksum: version.checksum,
        ingestionJob: { create: {
          sourcePath: `02-finalized/${version.id}.md`, markdown, checksum: digest(markdown),
        } },
      }, include: { ingestionJob: true } });
      await this.enqueue(tx, version.projectId, finalization.ingestionJob!.id);
      return tx.artifactFinalization.findUniqueOrThrow({ where: { id: finalization.id }, include: detailInclude });
    });
  }

  async retry(principalId: string, artifactId: string, versionId: string) {
    const version = await this.authorize(principalId, artifactId, versionId);
    return this.db.$transaction(async (tx) => {
      await lockProjectKnowledgeWrite(tx, version.projectId, principalId);
      const finalization = await tx.artifactFinalization.findUnique({ where: { artifactVersionId: versionId }, include: { ingestionJob: true } });
      if (!finalization?.ingestionJob) throw notFoundProblem("Artifact finalization");
      if (finalization.status === "withdrawn") throw validationProblem("ARTIFACT_FINALIZATION_WITHDRAWN");
      if (finalization.ingestionJob.status === "failed") await this.enqueue(tx, version.projectId, finalization.ingestionJob.id);
      return tx.artifactFinalization.findUniqueOrThrow({ where: { id: finalization.id }, include: detailInclude });
    });
  }

  async withdraw(principalId: string, artifactId: string, versionId: string) {
    const version = await this.authorize(principalId, artifactId, versionId);
    return this.db.$transaction(async (tx) => {
      await lockProjectKnowledgeWrite(tx, version.projectId, principalId);
      const finalization = await tx.artifactFinalization.findUnique({ where: { artifactVersionId: versionId }, include: { ingestionJob: true } });
      if (!finalization?.ingestionJob) throw notFoundProblem("Artifact finalization");
      if (finalization.status === "withdrawn") return tx.artifactFinalization.findUniqueOrThrow({ where: { id: finalization.id }, include: detailInclude });
      // Descendants contain the withdrawn source too. Retire them atomically, retaining all immutable content.
      const descendants = await tx.$queryRaw<Array<{ id: string; jobId: string | null }>>(Prisma.sql`
        WITH RECURSIVE descendants AS (
          SELECT id, ingestion_job_id FROM knowledge_releases WHERE ingestion_job_id = ${finalization.ingestionJob.id}
          UNION
          SELECT child.id, child.ingestion_job_id FROM knowledge_releases child
          JOIN descendants parent ON child.parent_release_id = parent.id
        )
        SELECT release.id, release.ingestion_job_id AS "jobId"
        FROM knowledge_releases release JOIN descendants ON descendants.id = release.id
        ORDER BY release.id FOR UPDATE OF release
      `);
      const ids = descendants.map((row) => row.id);
      const jobIds = [...new Set([finalization.ingestionJob.id, ...descendants.flatMap((row) => row.jobId ? [row.jobId] : [])])];
      await tx.knowledgeRelease.updateMany({ where: { id: { in: ids }, status: "ready" }, data: { status: "retired" } });
      await tx.knowledgeRelease.updateMany({ where: { id: { in: ids }, status: "building" }, data: { status: "failed", leaseToken: null, leaseExpiresAt: null } });
      await tx.knowledgeIngestionJob.updateMany({ where: { id: { in: jobIds } }, data: { status: "withdrawn", errorCode: "KNOWLEDGE_SOURCE_WITHDRAWN" } });
      await tx.artifactFinalization.updateMany({ where: { ingestionJob: { id: { in: jobIds } } }, data: { status: "withdrawn", withdrawnAt: new Date() } });
      return tx.artifactFinalization.findUniqueOrThrow({ where: { id: finalization.id }, include: detailInclude });
    }, { timeout: 30_000 });
  }

  private async authorize(principalId: string, artifactId: string, versionId: string) {
    const version = await this.db.artifactVersion.findFirst({
      where: { id: versionId, artifactId, status: "ready" }, include: { artifact: true },
    });
    if (!version) throw notFoundProblem("Ready Artifact version");
    await this.access.findProject(principalId, version.projectId, "owner");
    return version;
  }

  private async enqueue(tx: Prisma.TransactionClient, projectId: string, jobId: string) {
    const pending = await tx.knowledgeIngestionJob.findFirst({ where: {
      id: { not: jobId }, finalization: { projectId }, status: { in: ["queued", "converting", "indexing", "publishing"] },
    } });
    if (pending) throw validationProblem("KNOWLEDGE_INGESTION_IN_PROGRESS");
    const project = await tx.project.findUniqueOrThrow({ where: { id: projectId } });
    const parent = await tx.knowledgeRelease.findFirst({
      where: { projectId, status: "ready" }, orderBy: { version: "desc" },
    }) ?? await tx.knowledgeRelease.findFirst({
      where: { projectId: null, status: "ready", OR: [{ workspaceId: project.workspaceId }, { workspaceId: null }] },
      orderBy: [{ version: "desc" }, { createdAt: "desc" }],
    });
    if (!parent) throw validationProblem("KNOWLEDGE_RELEASE_REQUIRED");
    const key = `project:${projectId}`;
    const latest = await tx.knowledgeRelease.aggregate({ where: { key }, _max: { version: true } });
    const releaseVersion = (latest._max.version ?? 0) + 1;
    const manifest = {
      schema: "workbench.knowledge-release.building.v1", releaseKey: key, releaseVersion,
      parentReleaseId: parent.id,
      profile: {
        embedding: { id: parent.embeddingProfileId, specSha256: parent.embeddingProfileSpecSha256 },
        retrieval: { id: parent.retrievalProfileId, specSha256: parent.retrievalProfileSpecSha256 },
      },
    };
    const release = await tx.knowledgeRelease.create({ data: {
      id: `krel_${randomUUID()}`, key, version: releaseVersion, projectId, workspaceId: project.workspaceId,
      parentReleaseId: parent.id, ingestionJobId: jobId,
      embeddingProfileId: parent.embeddingProfileId, embeddingProfileSpecSha256: parent.embeddingProfileSpecSha256,
      embeddingDimension: parent.embeddingDimension, retrievalProfileId: parent.retrievalProfileId,
      retrievalProfileSpecSha256: parent.retrievalProfileSpecSha256,
      manifest, manifestSha256: digest(canonicalJson(manifest)),
    } });
    const job = await tx.knowledgeIngestionJob.update({
      where: { id: jobId }, data: { status: "queued", attempt: { increment: 1 }, errorCode: null },
    });
    await tx.artifactFinalization.update({ where: { id: job.finalizationId }, data: { status: "ingesting" } });
    await this.queue.sendInTransaction(tx, knowledgeReleaseBuildQueue, { releaseId: release.id }, { singletonKey: release.id });
  }
}

export function artifactKnowledgeMarkdown(title: string, content: Prisma.JsonValue): string {
  const lines: string[] = [];
  const visit = (value: Prisma.JsonValue, key = "") => {
    if (typeof value === "string") {
      if (["text", "title", "label", "description", "summary", "markdown", "name", "remarks",
        "statement", "actor", "trigger", "outcome", "notes", "needs", "painPoints", "successMetric"].includes(key)) lines.push(value);
    } else if (Array.isArray(value)) {
      value.forEach((item) => visit(item, key));
    } else if (value) {
      for (const [childKey, child] of Object.entries(value)) {
        if (child !== undefined && !["citations", "assets", "source", "metadata"].includes(childKey)) visit(child, childKey);
      }
    }
  };
  visit(content, "text");
  if (!lines.some((line) => line.trim())) throw validationProblem("ARTIFACT_KNOWLEDGE_TEXT_REQUIRED");
  // Escape source markup so a document cannot inject vault links or storage declarations.
  const escape = (line: string) => line.replace(/[\\`*_[\]<>#]/gu, "\\$&").replace(/storage\//gu, "storage&#47;");
  const escaped = lines.map(escape).join("\n\n");
  return `---\ntitle: ${JSON.stringify(title)}\nstatus: 已生效\ntags: [finalized]\naliases: []\n---\n\n# ${escape(title.replace(/[\r\n]/gu, " "))}\n\n${escaped}\n`.normalize("NFC");
}

function digest(value: string) { return createHash("sha256").update(value).digest("hex"); }

async function lockProjectKnowledgeWrite(tx: Prisma.TransactionClient, projectId: string, principalId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM projects WHERE id = ${projectId} AND status = 'active' FOR UPDATE
  `);
  if (!rows.length) throw notFoundProblem("Project");
  await assertProjectCapability(tx, projectId, principalId, "owner");
}

export function mapArtifactFinalization(row: Awaited<ReturnType<ArtifactFinalizationsService["get"]>>) {
  if (!row) return null;
  const job = row.ingestionJob;
  return artifactFinalizationStateSchema.parse({
    ...row, confirmedAt: row.confirmedAt.toISOString(), withdrawnAt: row.withdrawnAt?.toISOString() ?? null,
    ingestionJob: job ? {
      id: job.id, status: job.status, attempt: job.attempt, errorCode: job.errorCode,
      createdAt: job.createdAt.toISOString(), updatedAt: job.updatedAt.toISOString(), releases: job.releases,
    } : null,
  });
}
