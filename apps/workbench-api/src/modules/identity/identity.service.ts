import { Injectable, UnauthorizedException } from "@nestjs/common";
import { WorkbenchDbService } from "../../platform/database/workbench-db.service.js";
import type { AuthenticatedPrincipal, ExternalPrincipalClaims } from "./identity.types.js";

@Injectable()
export class IdentityService {
  constructor(private readonly db: WorkbenchDbService) {}

  async resolvePrincipal(claims: ExternalPrincipalClaims): Promise<AuthenticatedPrincipal> {
    return this.db.$transaction(async (tx) => {
      const principal = await tx.principal.upsert({
        where: {
          issuer_subject: {
            issuer: claims.issuer,
            subject: claims.subject,
          },
        },
        create: {
          issuer: claims.issuer,
          subject: claims.subject,
          email: claims.email ?? null,
          displayName: claims.displayName,
        },
        update: {
          // Clear a previously trusted email when the current identity token
          // no longer carries a verified address.
          email: claims.email ?? null,
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
