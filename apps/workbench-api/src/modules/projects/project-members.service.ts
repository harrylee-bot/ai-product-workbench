import { Injectable } from "@nestjs/common";
import { Prisma } from "@workbench/workbench-db";
import type {
  ProjectMember,
  ProjectMemberList,
  ProjectRole,
} from "@workbench/workbench-contracts";
import {
  notFoundProblem,
  projectStateConflictProblem,
  revisionConflictProblem,
} from "../../common/problem-details.js";
import { WorkbenchDbService } from "../../platform/database/workbench-db.service.js";
import { AccessService } from "../access/access.service.js";
import { mapProjectMember, projectMemberWithPrincipal } from "./project.mapper.js";

@Injectable()
export class ProjectMembersService {
  constructor(
    private readonly db: WorkbenchDbService,
    private readonly access: AccessService,
  ) {}

  async list(principalId: string, projectId: string): Promise<ProjectMemberList> {
    await this.access.findProject(principalId, projectId, "read");
    const members = await this.db.projectMember.findMany({
      where: { projectId },
      include: projectMemberWithPrincipal,
      orderBy: [{ role: "asc" }, { principalId: "asc" }],
    });
    return { items: members.map(mapProjectMember) };
  }

  async setRole(
    principalId: string,
    projectId: string,
    targetPrincipalId: string,
    expectedRevision: number,
    role: ProjectRole,
  ): Promise<{ member: ProjectMember; projectRevision: number }> {
    const authorized = await this.access.findProject(principalId, projectId, "owner");
    if (authorized.revision !== expectedRevision) throw revisionConflictProblem();

    return this.db.$transaction(async (tx) => {
      const project = await lockProject(tx, projectId);
      assertRevision(project.revision, expectedRevision);
      await assertOwner(tx, projectId, principalId);

      const eligible = await tx.workspaceMember.findUnique({
        where: {
          workspaceId_principalId: {
            workspaceId: project.workspaceId,
            principalId: targetPrincipalId,
          },
        },
        select: { principalId: true },
      });
      if (!eligible) throw notFoundProblem("Workspace member");

      const current = await tx.projectMember.findUnique({
        where: {
          projectId_principalId: { projectId, principalId: targetPrincipalId },
        },
        include: projectMemberWithPrincipal,
      });
      if (current?.role === role) {
        return {
          member: mapProjectMember(current),
          projectRevision: project.revision,
        };
      }
      if (current?.role === "owner" && role !== "owner") {
        await assertAnotherOwner(tx, projectId, targetPrincipalId);
      }

      const member = await tx.projectMember.upsert({
        where: {
          projectId_principalId: { projectId, principalId: targetPrincipalId },
        },
        create: {
          projectId,
          workspaceId: project.workspaceId,
          principalId: targetPrincipalId,
          role,
        },
        update: { role },
        include: projectMemberWithPrincipal,
      });
      const updatedProject = await tx.project.update({
        where: { id: projectId },
        data: { revision: { increment: 1 } },
        select: { revision: true },
      });
      return {
        member: mapProjectMember(member),
        projectRevision: updatedProject.revision,
      };
    });
  }

  async remove(
    principalId: string,
    projectId: string,
    targetPrincipalId: string,
    expectedRevision: number,
  ): Promise<number> {
    const authorized = await this.access.findProject(principalId, projectId, "owner");
    if (authorized.revision !== expectedRevision) throw revisionConflictProblem();

    return this.db.$transaction(async (tx) => {
      const project = await lockProject(tx, projectId);
      assertRevision(project.revision, expectedRevision);
      await assertOwner(tx, projectId, principalId);
      const current = await tx.projectMember.findUnique({
        where: {
          projectId_principalId: { projectId, principalId: targetPrincipalId },
        },
        select: { role: true },
      });
      if (!current) throw notFoundProblem("Project member");
      if (current.role === "owner") {
        await assertAnotherOwner(tx, projectId, targetPrincipalId);
      }
      await tx.projectMember.delete({
        where: {
          projectId_principalId: { projectId, principalId: targetPrincipalId },
        },
      });
      const updatedProject = await tx.project.update({
        where: { id: projectId },
        data: { revision: { increment: 1 } },
        select: { revision: true },
      });
      return updatedProject.revision;
    });
  }
}

async function lockProject(
  tx: Prisma.TransactionClient,
  projectId: string,
): Promise<{ id: string; workspaceId: string; revision: number }> {
  const rows = await tx.$queryRaw<Array<{ id: string; workspaceId: string; revision: number }>>(Prisma.sql`
    SELECT "id", "workspace_id" AS "workspaceId", "revision"
    FROM "projects"
    WHERE "id" = ${projectId} AND "status" = 'active'
    FOR UPDATE
  `);
  const project = rows[0];
  if (!project) throw notFoundProblem("Project");
  return project;
}

async function assertOwner(
  tx: Prisma.TransactionClient,
  projectId: string,
  principalId: string,
) {
  const owner = await tx.projectMember.findUnique({
    where: { projectId_principalId: { projectId, principalId } },
    select: { role: true },
  });
  if (owner?.role !== "owner") throw notFoundProblem("Project");
}

async function assertAnotherOwner(
  tx: Prisma.TransactionClient,
  projectId: string,
  principalId: string,
) {
  const ownerCount = await tx.projectMember.count({
    where: {
      projectId,
      role: "owner",
      principalId: { not: principalId },
    },
  });
  if (ownerCount === 0) {
    throw projectStateConflictProblem("A Project must retain at least one owner");
  }
}

function assertRevision(actual: number, expected: number) {
  if (actual !== expected) throw revisionConflictProblem();
}
