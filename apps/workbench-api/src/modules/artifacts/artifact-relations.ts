import { artifactRelationVersionSchema } from "@workbench/workbench-contracts";
import { Prisma } from "@workbench/workbench-db";

export const relationVersionSelect = {
  id: true,
  artifactId: true,
  projectId: true,
  version: true,
  schemaVersion: true,
  status: true,
  createdByRunId: true,
  sourcePrdVersionId: true,
  createdAt: true,
  artifact: { select: { title: true, kind: true } },
} as const;
type RelationVersion = Prisma.ArtifactVersionGetPayload<{
  select: typeof relationVersionSelect;
}>;

export async function relationVersion(
  tx: Prisma.TransactionClient,
  row: RelationVersion,
) {
  const revision =
    row.artifact.kind === "prototype"
      ? await tx.prototypeRevision.findFirst({
          where: {
            projectId: row.projectId,
            sourceArtifactVersionId: row.id,
            status: { in: ["ready", "confirmed", "rejected"] },
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: { id: true, planId: true, version: true },
        })
      : null;
  const owner = revision
    ? await tx.prototypePlan.findFirst({
        where: {
          projectId: row.projectId,
          contentVersion: revision.version,
          OR: [{ id: revision.planId }, { rootPlanId: revision.planId }],
        },
        select: { id: true },
      })
    : null;
  return artifactRelationVersionSchema.parse({
    artifactId: row.artifactId,
    artifactVersionId: row.id,
    version: row.version,
    schemaVersion: row.schemaVersion,
    kind: row.artifact.kind,
    title: row.artifact.title,
    status: row.status,
    createdByRunId: row.createdByRunId,
    prototypeRevision: revision
      ? { ...revision, planId: owner?.id ?? revision.planId }
      : null,
  });
}
