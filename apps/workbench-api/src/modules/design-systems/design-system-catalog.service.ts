import { Injectable } from "@nestjs/common";
import {
  designSystemCatalogSchema,
  type DesignSystemCatalog,
} from "@workbench/workbench-contracts";
import { validationProblem } from "../../common/problem-details.js";
import { WorkbenchDbService } from "../../platform/database/workbench-db.service.js";
import { projectMembershipFilter, AccessService } from "../access/access.service.js";

type DesignSystemCatalogCursor = {
  workspaceId: string;
  q: string | null;
  updatedAt: string;
  artifactId: string;
};

@Injectable()
export class DesignSystemCatalogService {
  constructor(
    private readonly db: WorkbenchDbService,
    private readonly access: AccessService,
  ) {}

  async list(
    principalId: string,
    workspaceId: string,
    query?: string,
    cursor?: string,
    requestedLimit?: number,
  ): Promise<DesignSystemCatalog> {
    await this.access.assertWorkspaceMember(principalId, workspaceId);
    const normalizedQuery = normalizeCatalogQuery(query);
    const containsPattern = normalizedQuery === undefined
      ? undefined
      : escapeCatalogContainsPattern(normalizedQuery);
    const decodedCursor = cursor ? decodeDesignSystemCatalogCursor(cursor) : undefined;
    if (
      decodedCursor
      && (
        decodedCursor.workspaceId !== workspaceId
        || decodedCursor.q !== (normalizedQuery ?? null)
      )
    ) {
      throw validationProblem("The Design System cursor does not belong to these list filters");
    }

    const limit = Math.min(Math.max(requestedLimit ?? 30, 1), 100);
    const artifacts = await this.db.artifact.findMany({
      where: {
        kind: "design_system",
        currentVersion: {
          is: {
            status: "ready",
            schemaVersion: 1,
            contentBlobId: null,
          },
        },
        project: {
          is: {
            workspaceId,
            status: "active",
            members: projectMembershipFilter(principalId, "read"),
          },
        },
        AND: [
          ...(containsPattern ? [{
            OR: [
              { title: { contains: containsPattern, mode: "insensitive" as const } },
              { project: { is: { title: { contains: containsPattern, mode: "insensitive" as const } } } },
            ],
          }] : []),
          ...(decodedCursor ? [{
            OR: [
              { updatedAt: { lt: new Date(decodedCursor.updatedAt) } },
              {
                updatedAt: new Date(decodedCursor.updatedAt),
                id: { lt: decodedCursor.artifactId },
              },
            ],
          }] : []),
        ],
      },
      select: {
        id: true,
        title: true,
        updatedAt: true,
        project: { select: { id: true, title: true } },
        currentVersion: {
          select: {
            id: true,
            version: true,
            checksum: true,
            createdAt: true,
          },
        },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });

    const hasNextPage = artifacts.length > limit;
    const page = hasNextPage ? artifacts.slice(0, limit) : artifacts;
    const last = page.at(-1);
    return designSystemCatalogSchema.parse({
      items: page.map((artifact) => {
        if (!artifact.currentVersion) {
          throw new Error("Design System catalog current-version invariant violated");
        }
        return {
          projectId: artifact.project.id,
          projectTitle: artifact.project.title,
          artifactId: artifact.id,
          artifactTitle: artifact.title,
          artifactVersionId: artifact.currentVersion.id,
          version: artifact.currentVersion.version,
          checksum: artifact.currentVersion.checksum,
          createdAt: artifact.currentVersion.createdAt.toISOString(),
          updatedAt: artifact.updatedAt.toISOString(),
        };
      }),
      nextCursor: hasNextPage && last
        ? encodeDesignSystemCatalogCursor({
            workspaceId,
            q: normalizedQuery ?? null,
            updatedAt: last.updatedAt.toISOString(),
            artifactId: last.id,
          })
        : null,
    });
  }
}

export function encodeDesignSystemCatalogCursor(cursor: DesignSystemCatalogCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeDesignSystemCatalogCursor(value: string): DesignSystemCatalogCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<DesignSystemCatalogCursor>;
    if (
      typeof parsed.workspaceId !== "string"
      || parsed.workspaceId.length === 0
      || typeof parsed.artifactId !== "string"
      || parsed.artifactId.length === 0
      || typeof parsed.updatedAt !== "string"
      || !isCanonicalIsoDateTime(parsed.updatedAt)
      || !(
        parsed.q === null
        || (
          typeof parsed.q === "string"
          && parsed.q.length <= 160
          && normalizeCatalogQuery(parsed.q) === parsed.q
        )
      )
    ) throw new Error("invalid cursor");
    return {
      workspaceId: parsed.workspaceId,
      q: parsed.q,
      updatedAt: parsed.updatedAt,
      artifactId: parsed.artifactId,
    };
  } catch {
    throw validationProblem("The Design System cursor is invalid");
  }
}

export function normalizeCatalogQuery(value?: string) {
  if (value === undefined) return undefined;
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) throw validationProblem("q must not be blank");
  if (normalized.length > 160) throw validationProblem("q must not exceed 160 characters");
  return normalized;
}

export function escapeCatalogContainsPattern(value: string) {
  return value.replace(/[\\%_]/g, "\\$&");
}

function isCanonicalIsoDateTime(value: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}
