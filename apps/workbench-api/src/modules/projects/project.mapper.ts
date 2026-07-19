import type {
  Project,
  ProjectMember,
  ProjectRole,
} from "@workbench/workbench-contracts";

export function mapProject(project: {
  id: string;
  workspaceId: string;
  title: string;
  summary: string | null;
  status: "active" | "archived";
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}): Project {
  return {
    id: project.id,
    workspaceId: project.workspaceId,
    title: project.title,
    summary: project.summary,
    status: project.status,
    revision: project.revision,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}

export function mapProjectMember(member: {
  projectId: string;
  principalId: string;
  role: ProjectRole;
  createdAt: Date;
  updatedAt: Date;
  principal: {
    displayName: string | null;
    email: string | null;
  };
}): ProjectMember {
  return {
    projectId: member.projectId,
    principalId: member.principalId,
    role: member.role,
    displayName: member.principal.displayName,
    email: member.principal.email,
    createdAt: member.createdAt.toISOString(),
    updatedAt: member.updatedAt.toISOString(),
  };
}

export const projectMemberWithPrincipal = {
  principal: {
    select: { displayName: true, email: true },
  },
} as const;
