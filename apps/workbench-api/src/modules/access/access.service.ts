import { Injectable } from "@nestjs/common";
import { Prisma } from "@workbench/workbench-db";
import { WorkbenchDbService } from "../../platform/database/workbench-db.service.js";
import { notFoundProblem } from "../../common/problem-details.js";

export type ProjectCapability = "read" | "edit" | "owner";

export function projectMembershipFilter(
  principalId: string,
  capability: ProjectCapability = "read",
): Prisma.ProjectMemberListRelationFilter {
  return {
    some: {
      principalId,
      ...(capability === "owner"
        ? { role: "owner" as const }
        : capability === "edit"
          ? { role: { in: ["owner", "editor"] } }
          : {}),
    },
  };
}

@Injectable()
export class AccessService {
  constructor(private readonly db: WorkbenchDbService) {}

  async assertWorkspaceMember(principalId: string, workspaceId: string) {
    const membership = await this.db.workspaceMember.findUnique({
      where: { workspaceId_principalId: { workspaceId, principalId } },
    });
    if (!membership) throw notFoundProblem("Workspace");
    return membership;
  }

  async findProject(
    principalId: string,
    projectId: string,
    capability: ProjectCapability = "read",
  ) {
    const project = await this.db.project.findFirst({
      where: {
        id: projectId,
        status: "active",
        members: projectMembershipFilter(principalId, capability),
      },
      include: {
        members: {
          where: { principalId },
          select: { role: true },
        },
      },
    });
    if (!project) throw notFoundProblem("Project");
    return project;
  }

  async findThread(
    principalId: string,
    threadId: string,
    capability: ProjectCapability = "read",
  ) {
    const thread = await this.db.thread.findFirst({
      where: {
        id: threadId,
        status: "active",
        project: {
          status: "active",
          members: projectMembershipFilter(principalId, capability),
        },
      },
      include: { project: true },
    });
    if (!thread) throw notFoundProblem("Thread");
    return thread;
  }

  async findRun(
    principalId: string,
    runId: string,
    capability: ProjectCapability = "read",
  ) {
    const run = await this.db.run.findFirst({
      where: {
        id: runId,
        thread: {
          status: "active",
          project: {
            status: "active",
            members: projectMembershipFilter(principalId, capability),
          },
        },
      },
      include: {
        sourceSnapshots: { orderBy: { position: "asc" } },
        thread: { include: { project: true } },
      },
    });
    if (!run) throw notFoundProblem("Run");
    return run;
  }
}
