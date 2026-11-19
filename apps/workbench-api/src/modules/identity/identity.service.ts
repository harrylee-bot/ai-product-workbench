import { Injectable, UnauthorizedException } from "@nestjs/common";
import { WorkbenchDbService } from "../../platform/database/workbench-db.service.js";
import type { AuthenticatedPrincipal, ExternalPrincipalClaims } from "./identity.types.js";

@Injectable()
export class IdentityService {
  constructor(private readonly db: WorkbenchDbService) {}

  async resolvePrincipal(claims: ExternalPrincipalClaims): Promise<AuthenticatedPrincipal> {
    const where = { issuer_subject: { issuer: claims.issuer, subject: claims.subject } };
    const email = claims.email ?? null;
    const existing = await this.db.principal.findUnique({
      where,
      select: {
        id: true,
        issuer: true,
        subject: true,
        email: true,
        displayName: true,
        status: true,
        memberships: { orderBy: { createdAt: "asc" }, take: 1, select: { workspaceId: true } },
      },
    });
    if (existing) {
      const { status, memberships, ...principal } = existing;
      if (status !== "active") throw new UnauthorizedException("Principal access is disabled");
      const defaultWorkspaceId = memberships[0]?.workspaceId;
      // Parallel Studio requests normally carry the same claims. Avoid
      // taking a write lock on the Principal row for each such request.
      if (defaultWorkspaceId && principal.email === email
          && (claims.displayName === undefined || principal.displayName === claims.displayName)) {
        return { ...principal, defaultWorkspaceId };
      }
    }

    return this.db.$transaction(async (tx) => {
      const principal = await tx.principal.upsert({
        where,
        create: {
          issuer: claims.issuer,
          subject: claims.subject,
          email,
          displayName: claims.displayName,
        },
        update: {
          // Clear a previously trusted email when the current identity token
          // no longer carries a verified address.
          email,
          displayName: claims.displayName,
        },
      });
      if (principal.status !== "active") {
        throw new UnauthorizedException("Principal access is disabled");
      }

      const membership = await tx.workspaceMember.findFirst({
        where: { principalId: principal.id },
        orderBy: { createdAt: "asc" },
      });

      let defaultWorkspaceId = membership?.workspaceId;
      if (!defaultWorkspaceId) {
        const workspace = await tx.workspace.upsert({
          where: { slug: `personal-${principal.id}` },
          create: {
            slug: `personal-${principal.id}`,
            name: claims.displayName ? `${claims.displayName}'s workspace` : "My workspace",
            createdById: principal.id,
          },
          update: {},
        });
        await tx.workspaceMember.upsert({
          where: {
            workspaceId_principalId: {
              workspaceId: workspace.id,
              principalId: principal.id,
            },
          },
          create: {
            workspaceId: workspace.id,
            principalId: principal.id,
            role: "owner",
          },
          update: { role: "owner" },
        });
        defaultWorkspaceId = workspace.id;
      }

      return {
        id: principal.id,
        issuer: principal.issuer,
        subject: principal.subject,
        email: principal.email,
        displayName: principal.displayName,
        defaultWorkspaceId,
      };
    });
  }
}
