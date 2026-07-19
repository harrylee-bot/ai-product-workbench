import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@workbench/workbench-db";
import {
  acceptProjectInvitationResponseSchema,
  createProjectInvitationResponseSchema,
  projectInvitationEmailSchema,
  projectInvitationListSchema,
  projectInvitationPreviewSchema,
  projectInvitationSchema,
  type AcceptProjectInvitationResponse,
  type CreateProjectInvitationRequest,
  type CreateProjectInvitationResponse,
  type ProjectInvitation,
  type ProjectInvitationList,
  type ProjectInvitationPreview,
  type ProjectInvitationStatus,
} from "@workbench/workbench-contracts";
import { hashRequest, validateIdempotencyKey } from "../../common/idempotency.js";
import {
  idempotencyConflictProblem,
  notFoundProblem,
  projectInvitationStateConflictProblem,
  revisionConflictProblem,
  validationProblem,
} from "../../common/problem-details.js";
import { WorkbenchDbService } from "../../platform/database/workbench-db.service.js";
import type { AuthenticatedPrincipal } from "../identity/identity.types.js";
import { mapProjectMember, projectMemberWithPrincipal } from "./project.mapper.js";
import { ProjectInvitationTokenService } from "./project-invitation-token.service.js";

const DEFAULT_INVITATION_TTL_HOURS = 7 * 24;

type InvitationCursor = Readonly<{
  version: 1;
  projectId: string;
  status: ProjectInvitationStatus | null;
  createdAt: string;
  id: string;
}>;

type InvitationRecord = Readonly<{
  id: string;
  projectId: string;
  workspaceId: string;
  email: string;
  role: "owner" | "editor" | "viewer";
  status: ProjectInvitationStatus;
  deliveryStatus: "not_configured";
  createdById: string;
  acceptedById: string | null;
  tokenHash: string;
  tokenKeyId: string;
  revision: number;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}>;

type LockedProject = Readonly<{
  id: string;
  workspaceId: string;
  revision: number;
}>;

@Injectable()
export class ProjectInvitationsService {
  private readonly invitationTtlMs: number;

  constructor(
    private readonly db: WorkbenchDbService,
    private readonly tokens: ProjectInvitationTokenService,
    config: ConfigService,
  ) {
    this.invitationTtlMs = invitationTtlMs(config);
  }

  async list(
    principalId: string,
    projectId: string,
    status?: ProjectInvitationStatus,
    cursor?: string,
    requestedLimit?: number,
  ): Promise<ProjectInvitationList> {
    const decoded = cursor ? decodeProjectInvitationCursor(cursor) : undefined;
    if (decoded && (decoded.projectId !== projectId || decoded.status !== (status ?? null))) {
      throw validationProblem("The Project invitation cursor does not belong to these list filters");
    }
    const limit = Math.min(Math.max(requestedLimit ?? 30, 1), 100);
    return this.db.$transaction(async (tx) => {
      await lockProjectForRead(tx, projectId);
      await assertProjectOwner(tx, projectId, principalId);
      await expirePendingInvitations(tx, projectId, new Date());
      const rows = await tx.projectInvitation.findMany({
        where: {
          projectId,
          ...(status ? { status } : {}),
          ...(decoded ? {
            OR: [
              { createdAt: { lt: new Date(decoded.createdAt) } },
              { createdAt: new Date(decoded.createdAt), id: { lt: decoded.id } },
            ],
          } : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
      });
      const hasNextPage = rows.length > limit;
      const page = hasNextPage ? rows.slice(0, limit) : rows;
      const last = page.at(-1);
      return projectInvitationListSchema.parse({
        items: page.map((row) => ({
          invitation: mapProjectInvitation(row as InvitationRecord),
          token: row.status === "pending"
            ? this.issuePersistedToken(row as InvitationRecord)
            : null,
        })),
        nextCursor: hasNextPage && last
          ? encodeProjectInvitationCursor({
              version: 1,
              projectId,
              status: status ?? null,
              createdAt: last.createdAt.toISOString(),
              id: last.id,
            })
          : null,
      });
    });
  }

  async create(
    principalId: string,
    projectId: string,
    expectedRevision: number,
    idempotencyKey: string,
    request: CreateProjectInvitationRequest,
  ): Promise<{ response: CreateProjectInvitationResponse; projectRevision: number }> {
    validateIdempotencyKey(idempotencyKey);
    const normalizedRequest = {
      email: normalizeProjectInvitationEmail(request.email),
      role: request.role,
    };
    const requestHash = hashRequest(normalizedRequest);
    const invitationId = randomUUID();
    const issued = this.tokens.issue(invitationId);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.invitationTtlMs);

    return this.db.$transaction(async (tx) => {
      const project = await lockProject(tx, projectId);
      await assertProjectOwner(tx, projectId, principalId);
      await expirePendingInvitations(tx, projectId, now);

      const replay = await tx.projectInvitation.findFirst({
        where: { projectId, createdById: principalId, idempotencyKey },
      });
      if (replay) {
        if (replay.requestHash !== requestHash) throw idempotencyConflictProblem();
        return {
          response: createProjectInvitationResponseSchema.parse({
            invitation: mapProjectInvitation(replay as InvitationRecord),
            token: this.issuePersistedToken(replay as InvitationRecord),
            deliveryStatus: "not_configured",
          }),
          projectRevision: project.revision,
        };
      }

      assertRevision(project.revision, expectedRevision);
      await assertEmailIsNotProjectMember(tx, projectId, normalizedRequest.email);
      const pending = await tx.projectInvitation.findFirst({
        where: { projectId, email: normalizedRequest.email, status: "pending" },
        select: { id: true },
      });
      if (pending) {
        throw projectInvitationStateConflictProblem(
          "A pending invitation already exists for this email and Project",
        );
      }

      const invitation = await tx.projectInvitation.create({
        data: {
          id: invitationId,
          projectId,
          workspaceId: project.workspaceId,
          email: normalizedRequest.email,
          role: normalizedRequest.role,
          createdById: principalId,
          idempotencyKey,
          requestHash,
          tokenHash: this.tokens.hash(issued.token),
          tokenKeyId: issued.keyId,
          expiresAt,
        },
      });
      const updatedProject = await tx.project.update({
        where: { id: projectId },
        data: { revision: { increment: 1 } },
        select: { revision: true },
      });
      return {
        response: createProjectInvitationResponseSchema.parse({
          invitation: mapProjectInvitation(invitation as InvitationRecord),
          token: issued.token,
          deliveryStatus: "not_configured",
        }),
        projectRevision: updatedProject.revision,
      };
    });
  }

  async revoke(
    principalId: string,
    projectId: string,
    invitationId: string,
    expectedRevision: number,
  ): Promise<{ invitation: ProjectInvitation; projectRevision: number }> {
    const result = await this.db.$transaction(async (tx) => {
      const project = await lockProject(tx, projectId);
      await assertProjectOwner(tx, projectId, principalId);
      assertRevision(project.revision, expectedRevision);
      await expirePendingInvitations(tx, projectId, new Date());

      const current = await tx.projectInvitation.findFirst({
        where: { id: invitationId, projectId },
      });
      if (!current) throw notFoundProblem("Project invitation");
      if (current.status === "revoked") {
        return {
          kind: "success" as const,
          invitation: mapProjectInvitation(current as InvitationRecord),
          projectRevision: project.revision,
        };
      }
      if (current.status !== "pending") {
        return { kind: "conflict" as const, status: current.status };
      }

      const revoked = await tx.projectInvitation.update({
        where: { id: invitationId },
        data: {
          status: "revoked",
          revokedAt: new Date(),
          revision: { increment: 1 },
        },
      });
      const updatedProject = await tx.project.update({
        where: { id: projectId },
        data: { revision: { increment: 1 } },
        select: { revision: true },
      });
      return {
        kind: "success" as const,
        invitation: mapProjectInvitation(revoked as InvitationRecord),
        projectRevision: updatedProject.revision,
      };
    });
    if (result.kind === "conflict") {
      throw projectInvitationStateConflictProblem(
        `The invitation cannot be revoked while it is ${result.status}`,
      );
    }
    return result;
  }

  async preview(
    principal: AuthenticatedPrincipal,
    token: string,
  ): Promise<ProjectInvitationPreview> {
    const located = await this.findTokenInvitation(token);
    await expirePendingInvitations(this.db, located.projectId, new Date(), located.id);
    const invitation = await this.db.projectInvitation.findUnique({
      where: { id: located.id },
      include: {
        project: { select: { title: true, status: true } },
        workspace: { select: { name: true } },
      },
    });
    if (!invitation || invitation.project.status !== "active") {
      throw notFoundProblem("Project invitation");
    }
    assertMatchingEmail(principal.email, invitation.email);
    if (invitation.status === "accepted" && invitation.acceptedById !== principal.id) {
      throw projectInvitationStateConflictProblem(
        "This invitation was accepted by a different account",
      );
    }
    return projectInvitationPreviewSchema.parse({
      invitationId: invitation.id,
      projectId: invitation.projectId,
      projectTitle: invitation.project.title,
      workspaceId: invitation.workspaceId,
      workspaceName: invitation.workspace.name,
      email: invitation.email,
      role: invitation.role,
      status: invitation.status,
      expiresAt: invitation.expiresAt.toISOString(),
    });
  }

  async accept(
    principal: AuthenticatedPrincipal,
    token: string,
  ): Promise<{ response: AcceptProjectInvitationResponse; projectRevision: number }> {
    const located = await this.findTokenInvitation(token);
    const normalizedPrincipalEmail = matchingEmail(principal.email, located.email);
    const now = new Date();
    const result = await this.db.$transaction(async (tx) => {
      const project = await lockProject(tx, located.projectId);
      await lockInvitation(tx, located.id);
      const current = await tx.projectInvitation.findUnique({ where: { id: located.id } });
      if (!current || !this.matchesPersistedToken(current as InvitationRecord, token, located.keyId)) {
        throw notFoundProblem("Project invitation");
      }
      if (current.email !== normalizedPrincipalEmail) {
        throw projectInvitationStateConflictProblem(
          "Sign in with the email address that received this invitation",
        );
      }
      if (current.status === "accepted") {
        if (current.acceptedById !== principal.id) {
          return { kind: "conflict" as const, status: "accepted-by-another-account" };
        }
        const existingMember = await tx.projectMember.findUnique({
          where: { projectId_principalId: { projectId: current.projectId, principalId: principal.id } },
          include: projectMemberWithPrincipal,
        });
        if (!existingMember) {
          return { kind: "conflict" as const, status: "accepted-membership-removed" };
        }
        return {
          kind: "success" as const,
          response: acceptProjectInvitationResponseSchema.parse({
            invitation: mapProjectInvitation(current as InvitationRecord),
            member: mapProjectMember(existingMember),
          }),
          projectRevision: project.revision,
        };
      }
      if (current.status !== "pending") {
        return { kind: "conflict" as const, status: current.status };
      }
      if (current.expiresAt.getTime() <= now.getTime()) {
        await tx.projectInvitation.update({
          where: { id: current.id },
          data: { status: "expired", revision: { increment: 1 } },
        });
        return { kind: "conflict" as const, status: "expired" };
      }

      const existingMember = await tx.projectMember.findUnique({
        where: { projectId_principalId: { projectId: current.projectId, principalId: principal.id } },
        select: { principalId: true },
      });
      if (existingMember) {
        return { kind: "conflict" as const, status: "already-a-project-member" };
      }
      const member = await tx.projectMember.create({
        data: {
          projectId: current.projectId,
          workspaceId: current.workspaceId,
          principalId: principal.id,
          role: current.role,
        },
        include: projectMemberWithPrincipal,
      });
      const accepted = await tx.projectInvitation.update({
        where: { id: current.id },
        data: {
          status: "accepted",
          acceptedById: principal.id,
          acceptedAt: now,
          revision: { increment: 1 },
        },
      });
      const updatedProject = await tx.project.update({
        where: { id: project.id },
        data: { revision: { increment: 1 } },
        select: { revision: true },
      });
      return {
        kind: "success" as const,
        response: acceptProjectInvitationResponseSchema.parse({
          invitation: mapProjectInvitation(accepted as InvitationRecord),
          member: mapProjectMember(member),
        }),
        projectRevision: updatedProject.revision,
      };
    });
    if (result.kind === "conflict") {
      throw projectInvitationStateConflictProblem(acceptConflictDetail(result.status));
    }
    return result;
  }

  private async findTokenInvitation(token: string) {
    const verified = this.tokens.verify(token);
    if (!verified) throw notFoundProblem("Project invitation");
    const invitation = await this.db.projectInvitation.findUnique({
      where: { id: verified.invitationId },
    });
    if (!invitation || !this.matchesPersistedToken(invitation as InvitationRecord, token, verified.keyId)) {
      throw notFoundProblem("Project invitation");
    }
    return {
      id: invitation.id,
      projectId: invitation.projectId,
      email: invitation.email,
      keyId: verified.keyId,
    };
  }

  private matchesPersistedToken(invitation: InvitationRecord, token: string, keyId: string) {
    return invitation.tokenKeyId === keyId && invitation.tokenHash === this.tokens.hash(token);
  }

  private issuePersistedToken(invitation: InvitationRecord) {
    const issued = this.tokens.issue(invitation.id, invitation.tokenKeyId);
    if (this.tokens.hash(issued.token) !== invitation.tokenHash) {
      throw new Error("PROJECT_INVITATION_TOKEN_INTEGRITY_MISMATCH");
    }
    return issued.token;
  }
}

export function normalizeProjectInvitationEmail(value: string) {
  return projectInvitationEmailSchema.parse(value.normalize("NFKC"));
}

export function encodeProjectInvitationCursor(cursor: InvitationCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeProjectInvitationCursor(value: string): InvitationCursor {
  try {
    if (!/^[A-Za-z0-9_-]{1,2048}$/.test(value)) throw new Error("invalid cursor encoding");
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") throw new Error("invalid cursor payload");
    const cursor = parsed as Partial<InvitationCursor>;
    if (
      cursor.version !== 1
      || typeof cursor.projectId !== "string"
      || cursor.projectId.length < 1
      || cursor.projectId.length > 128
      || !(
        cursor.status === null
        || ["pending", "accepted", "revoked", "expired"].includes(String(cursor.status))
      )
      || typeof cursor.createdAt !== "string"
      || !Number.isFinite(Date.parse(cursor.createdAt))
      || new Date(cursor.createdAt).toISOString() !== cursor.createdAt
      || typeof cursor.id !== "string"
      || cursor.id.length < 1
      || cursor.id.length > 128
    ) {
      throw new Error("invalid cursor fields");
    }
    return cursor as InvitationCursor;
  } catch {
    throw validationProblem("The Project invitation cursor is invalid");
  }
}

function mapProjectInvitation(row: InvitationRecord): ProjectInvitation {
  return projectInvitationSchema.parse({
    id: row.id,
    projectId: row.projectId,
    workspaceId: row.workspaceId,
    email: row.email,
    role: row.role,
    status: row.status,
    deliveryStatus: row.deliveryStatus,
    createdById: row.createdById,
    acceptedById: row.acceptedById,
    revision: row.revision,
    expiresAt: row.expiresAt.toISOString(),
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

async function lockProject(tx: Prisma.TransactionClient, projectId: string): Promise<LockedProject> {
  const rows = await tx.$queryRaw<LockedProject[]>(Prisma.sql`
    SELECT
      "id",
      "workspace_id" AS "workspaceId",
      "revision"
    FROM "projects"
    WHERE "id" = ${projectId} AND "status" = 'active'
    FOR UPDATE
  `);
  const project = rows[0];
  if (!project) throw notFoundProblem("Project");
  return project;
}

async function lockProjectForRead(
  tx: Prisma.TransactionClient,
  projectId: string,
): Promise<LockedProject> {
  const rows = await tx.$queryRaw<LockedProject[]>(Prisma.sql`
    SELECT
      "id",
      "workspace_id" AS "workspaceId",
      "revision"
    FROM "projects"
    WHERE "id" = ${projectId} AND "status" = 'active'
    FOR SHARE
  `);
  const project = rows[0];
  if (!project) throw notFoundProblem("Project");
  return project;
}

async function lockInvitation(tx: Prisma.TransactionClient, invitationId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "project_invitations"
    WHERE "id" = ${invitationId}
    FOR UPDATE
  `);
  if (!rows[0]) throw notFoundProblem("Project invitation");
}

async function assertProjectOwner(
  tx: Prisma.TransactionClient,
  projectId: string,
  principalId: string,
) {
  const member = await tx.projectMember.findUnique({
    where: { projectId_principalId: { projectId, principalId } },
    select: { role: true },
  });
  if (member?.role !== "owner") throw notFoundProblem("Project");
}

async function assertEmailIsNotProjectMember(
  tx: Prisma.TransactionClient,
  projectId: string,
  email: string,
) {
  const rows = await tx.$queryRaw<Array<{ exists: boolean }>>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1
      FROM "project_members" AS project_member
      INNER JOIN "principals" AS principal
        ON principal."id" = project_member."principal_id"
      WHERE project_member."project_id" = ${projectId}
        AND lower(btrim(principal."email")) = ${email}
    ) AS "exists"
  `);
  if (rows[0]?.exists) {
    throw projectInvitationStateConflictProblem(
      "This email already belongs to a Project member",
    );
  }
}

async function expirePendingInvitations(
  db: Pick<Prisma.TransactionClient, "projectInvitation">,
  projectId: string,
  now: Date,
  invitationId?: string,
) {
  await db.projectInvitation.updateMany({
    where: {
      projectId,
      status: "pending",
      expiresAt: { lte: now },
      ...(invitationId ? { id: invitationId } : {}),
    },
    data: { status: "expired", revision: { increment: 1 } },
  });
}

function matchingEmail(principalEmail: string | null, invitationEmail: string) {
  if (!principalEmail) {
    throw projectInvitationStateConflictProblem(
      "The signed-in account does not expose an email address",
    );
  }
  let normalized: string;
  try {
    normalized = normalizeProjectInvitationEmail(principalEmail);
  } catch {
    throw projectInvitationStateConflictProblem(
      "The signed-in account does not expose a valid email address",
    );
  }
  if (normalized !== invitationEmail) {
    throw projectInvitationStateConflictProblem(
      "Sign in with the email address that received this invitation",
    );
  }
  return normalized;
}

function assertMatchingEmail(principalEmail: string | null, invitationEmail: string) {
  matchingEmail(principalEmail, invitationEmail);
}

function assertRevision(actual: number, expected: number) {
  if (actual !== expected) throw revisionConflictProblem();
}

function invitationTtlMs(config: ConfigService) {
  const raw = config.get<string>("WORKBENCH_INVITATION_TTL_HOURS")?.trim();
  if (!raw) return DEFAULT_INVITATION_TTL_HOURS * 60 * 60 * 1_000;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error("WORKBENCH_INVITATION_TTL_HOURS must be a positive integer");
  }
  const hours = Number(raw);
  if (!Number.isSafeInteger(hours) || hours > 30 * 24) {
    throw new Error("WORKBENCH_INVITATION_TTL_HOURS must be between 1 and 720");
  }
  return hours * 60 * 60 * 1_000;
}

function acceptConflictDetail(status: string) {
  if (status === "revoked") return "This invitation has been revoked";
  if (status === "expired") return "This invitation has expired";
  if (status === "accepted-by-another-account") {
    return "This invitation was accepted by a different account";
  }
  if (status === "accepted-membership-removed") {
    return "This accepted invitation no longer grants active Project membership";
  }
  if (status === "already-a-project-member") {
    return "This account is already a Project member; ask a Project owner to revoke the pending invitation";
  }
  return `This invitation cannot be accepted while it is ${status}`;
}
