import { Prisma } from "@workbench/workbench-db";
import { notFoundProblem } from "../../common/problem-details.js";
import type { ProjectCapability } from "../access/access.service.js";

export async function lockActiveProject(
  tx: Prisma.TransactionClient,
  projectId: string,
  principalId: string,
  capability: ProjectCapability,
) {
  const rows = await tx.$queryRaw<Array<{ id: string; revision: number }>>(Prisma.sql`
    SELECT "id", "revision"
    FROM "projects"
    WHERE "id" = ${projectId} AND "status" = 'active'
    FOR SHARE
  `);
  const project = rows[0];
  if (!project) throw notFoundProblem("Project");
  await assertProjectCapability(tx, projectId, principalId, capability);
  return project;
}

export async function assertProjectCapability(
  tx: Prisma.TransactionClient,
  projectId: string,
  principalId: string,
  capability: ProjectCapability,
) {
  const membership = await tx.projectMember.findUnique({
    where: { projectId_principalId: { projectId, principalId } },
    select: { role: true },
  });
  const authorized = membership && (
    capability === "read"
    || membership.role === "owner"
    || (capability === "edit" && membership.role === "editor")
  );
  if (!authorized) throw notFoundProblem("Project");
  return membership;
}
