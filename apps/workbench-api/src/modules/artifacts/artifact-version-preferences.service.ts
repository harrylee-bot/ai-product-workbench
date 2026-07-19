import { Injectable } from "@nestjs/common";
import type {
  ArtifactVersionFavoriteList,
  ArtifactVersionPreference,
  UpdateArtifactVersionPreferenceRequest,
} from "@workbench/workbench-contracts";
import {
  artifactVersionFavoriteListSchema,
  prototypeDocumentSchema,
} from "@workbench/workbench-contracts";
import { Prisma } from "@workbench/workbench-db";
import {
  notFoundProblem,
  revisionConflictProblem,
  validationProblem,
} from "../../common/problem-details.js";
import { WorkbenchDbService } from "../../platform/database/workbench-db.service.js";
import { AccessService, projectMembershipFilter } from "../access/access.service.js";
import { lockActiveProject } from "../projects/project-lock.js";
import { artifactVersionScreenIds } from "./artifact-screen-reference.js";
import {
  defaultArtifactVersionPreference,
  mapArtifactVersionPreference,
} from "./artifact-version-preference.mapper.js";

const preferenceSelect = {
  artifactId: true,
  artifactVersionId: true,
  screenId: true,
  favorite: true,
  reaction: true,
  revision: true,
  createdAt: true,
  updatedAt: true,
} as const;

const favoriteSelect = {
  artifactId: true,
  artifactVersionId: true,
  screenId: true,
  updatedAt: true,
  artifactVersion: {
    select: {
      version: true,
      content: true,
      contentBlobId: true,
      contentBlob: {
        select: { status: true, deletedAt: true },
      },
      artifact: { select: { kind: true, title: true } },
    },
  },
} as const;

type FavoriteCursor = Readonly<{
  version: 1;
  principalId: string;
  projectId: string;
  updatedAt: string;
  artifactVersionId: string;
  screenId: string;
}>;

type FavoriteRow = Prisma.ArtifactVersionPreferenceGetPayload<{
  select: typeof favoriteSelect;
}>;

@Injectable()
export class ArtifactVersionPreferencesService {
  constructor(
    private readonly db: WorkbenchDbService,
    private readonly access: AccessService,
  ) {}

  async listFavorites(
    principalId: string,
    projectId: string,
    cursor?: string,
    requestedLimit?: number,
  ): Promise<ArtifactVersionFavoriteList> {
    await this.access.findProject(principalId, projectId, "read");
    const limit = clampLimit(requestedLimit, 30, 100);
    const decodedCursor = cursor ? decodeFavoriteCursor(cursor) : undefined;
    if (
      decodedCursor
      && (decodedCursor.principalId !== principalId || decodedCursor.projectId !== projectId)
    ) {
      throw validationProblem("The ArtifactVersion favorite cursor does not belong to this Project");
    }
    const rows = await this.db.artifactVersionPreference.findMany({
      where: {
        principalId,
        projectId,
        favorite: true,
        artifactVersion: {
          status: "ready",
          OR: [
            { contentBlobId: null },
            { contentBlob: { is: { status: "ready", deletedAt: null } } },
          ],
        },
        ...(decodedCursor
          ? {
              OR: [
                { updatedAt: { lt: new Date(decodedCursor.updatedAt) } },
                {
                  updatedAt: new Date(decodedCursor.updatedAt),
                  artifactVersionId: { lt: decodedCursor.artifactVersionId },
                },
                {
                  updatedAt: new Date(decodedCursor.updatedAt),
                  artifactVersionId: decodedCursor.artifactVersionId,
                  screenId: { lt: decodedCursor.screenId },
                },
              ],
            }
          : {}),
      },
      select: favoriteSelect,
      orderBy: [{ updatedAt: "desc" }, { artifactVersionId: "desc" }, { screenId: "desc" }],
      take: limit + 1,
    });
    const hasNextPage = rows.length > limit;
    const page = hasNextPage ? rows.slice(0, limit) : rows;
    const last = page.at(-1);
    return artifactVersionFavoriteListSchema.parse({
      items: page.map(mapFavorite),
      nextCursor: hasNextPage && last
          ? encodeFavoriteCursor({
            version: 1,
            principalId,
            projectId,
            updatedAt: last.updatedAt.toISOString(),
            artifactVersionId: last.artifactVersionId,
            screenId: last.screenId,
          })
        : null,
    });
  }

  async get(
    principalId: string,
    artifactId: string,
    artifactVersionId: string,
    screenId: string | null,
  ): Promise<ArtifactVersionPreference> {
    const version = await this.db.artifactVersion.findFirst({
      where: authorizedReadyVersionWhere(principalId, artifactId, artifactVersionId),
      select: {
        content: true,
        contentBlobId: true,
        artifact: { select: { kind: true } },
      },
    });
    if (!version) throw notFoundProblem("Artifact version");
    assertScreenTarget(version, screenId);
    const storedScreenId = screenId ?? "";

    const preference = await this.db.artifactVersionPreference.findUnique({
      where: {
        principalId_artifactVersionId_screenId: {
          principalId,
          artifactVersionId,
          screenId: storedScreenId,
        },
      },
      select: preferenceSelect,
    });
    return preference
      ? mapArtifactVersionPreference(preference)
      : defaultArtifactVersionPreference(artifactId, artifactVersionId, screenId);
  }

  async update(
    principalId: string,
    artifactId: string,
    artifactVersionId: string,
    screenId: string | null,
    expectedRevision: number,
    input: UpdateArtifactVersionPreferenceRequest,
  ): Promise<ArtifactVersionPreference> {
    try {
      return await this.db.$transaction(async (tx) => {
        const scope = await tx.artifactVersion.findFirst({
          where: readyVersionWhere(artifactId, artifactVersionId),
          select: {
            projectId: true,
            content: true,
            contentBlobId: true,
            artifact: { select: { kind: true } },
          },
        });
        if (!scope) throw notFoundProblem("Artifact version");
        await lockActiveProject(tx, scope.projectId, principalId, "read");
        assertScreenTarget(scope, screenId);
        const storedScreenId = screenId ?? "";

        if (expectedRevision === 0) {
          const created = await tx.artifactVersionPreference.create({
            data: {
              principalId,
              projectId: scope.projectId,
              artifactId,
              artifactVersionId,
              screenId: storedScreenId,
              favorite: input.favorite,
              reaction: input.reaction,
            },
            select: preferenceSelect,
          });
          return mapArtifactVersionPreference(created);
        }

        const updated = await tx.artifactVersionPreference.updateMany({
          where: {
            principalId,
            artifactVersionId,
            screenId: storedScreenId,
            artifactId,
            projectId: scope.projectId,
            revision: expectedRevision,
          },
          data: {
            favorite: input.favorite,
            reaction: input.reaction,
            revision: { increment: 1 },
            updatedAt: new Date(),
          },
        });
        if (updated.count !== 1) throw revisionConflictProblem();

        const preference = await tx.artifactVersionPreference.findUnique({
          where: {
            principalId_artifactVersionId_screenId: {
              principalId,
              artifactVersionId,
              screenId: storedScreenId,
            },
          },
          select: preferenceSelect,
        });
        if (!preference) throw revisionConflictProblem();
        return mapArtifactVersionPreference(preference);
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw revisionConflictProblem();
      }
      throw error;
    }
  }
}

function mapFavorite(row: FavoriteRow) {
  if (row.artifactVersion.contentBlobId === null) {
    if (row.artifactVersion.content == null) throw invalidFavoriteContentError();
  } else if (
    row.artifactVersion.content !== null
    || !row.artifactVersion.contentBlob
    || row.artifactVersion.contentBlob.status !== "ready"
    || row.artifactVersion.contentBlob.deletedAt !== null
  ) {
    throw invalidFavoriteContentError();
  }

  const { artifact } = row.artifactVersion;
  if (artifact.kind === "prototype") {
    if (row.screenId.length === 0 || row.artifactVersion.contentBlobId !== null) {
      throw invalidFavoriteScreenError();
    }
    const parsed = prototypeDocumentSchema.safeParse(row.artifactVersion.content);
    if (!parsed.success) throw invalidFavoriteScreenError();
    const screen = parsed.data.screens.find((candidate) => candidate.id === row.screenId);
    if (!screen) throw invalidFavoriteScreenError();
    return {
      artifactId: row.artifactId,
      artifactVersionId: row.artifactVersionId,
      artifactKind: artifact.kind,
      artifactTitle: artifact.title,
      artifactVersion: row.artifactVersion.version,
      screenId: row.screenId,
      screenName: screen.name,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
  if (row.screenId.length > 0) throw invalidFavoriteScreenError();
  return {
    artifactId: row.artifactId,
    artifactVersionId: row.artifactVersionId,
    artifactKind: artifact.kind,
    artifactTitle: artifact.title,
    artifactVersion: row.artifactVersion.version,
    screenId: null,
    screenName: null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function invalidFavoriteScreenError() {
  return new Error("ARTIFACT_VERSION_FAVORITE_SCREEN_INVALID");
}

function invalidFavoriteContentError() {
  return new Error("ARTIFACT_VERSION_FAVORITE_CONTENT_INVALID");
}

export function encodeFavoriteCursor(cursor: FavoriteCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeFavoriteCursor(
  value: string,
): FavoriteCursor {
  try {
    if (!/^[A-Za-z0-9_-]{1,2048}$/.test(value)) throw new Error("invalid cursor encoding");
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<FavoriteCursor>;
    if (
      parsed.version !== 1
      || typeof parsed.principalId !== "string"
      || parsed.principalId.length < 1
      || parsed.principalId.length > 128
      || typeof parsed.projectId !== "string"
      || parsed.projectId.length < 1
      || parsed.projectId.length > 128
      || typeof parsed.updatedAt !== "string"
      || Number.isNaN(Date.parse(parsed.updatedAt))
      || typeof parsed.artifactVersionId !== "string"
      || parsed.artifactVersionId.length < 1
      || parsed.artifactVersionId.length > 128
      || typeof parsed.screenId !== "string"
      || parsed.screenId.length > 128
    ) {
      throw new Error("invalid cursor");
    }
    return parsed as FavoriteCursor;
  } catch {
    throw validationProblem("The ArtifactVersion favorite cursor is invalid");
  }
}

function clampLimit(value: number | undefined, fallback: number, maximum: number) {
  return Math.min(Math.max(value ?? fallback, 1), maximum);
}

function assertScreenTarget(
  version: { content: unknown; contentBlobId: string | null; artifact: { kind: string } },
  screenId: string | null,
) {
  if (screenId === null) {
    if (version.artifact.kind === "prototype") {
      throw validationProblem("screenId is required for prototype ArtifactVersion preferences");
    }
    return;
  }
  if (version.artifact.kind !== "prototype") {
    throw validationProblem("screenId is only valid for prototype ArtifactVersion preferences");
  }
  const screenIds = artifactVersionScreenIds(version);
  if (!screenIds?.has(screenId)) {
    throw notFoundProblem("Artifact version screen");
  }
}

function readyVersionWhere(
  artifactId: string,
  artifactVersionId: string,
): Prisma.ArtifactVersionWhereInput {
  return {
    id: artifactVersionId,
    artifactId,
    status: "ready",
    OR: [
      { contentBlobId: null },
      { contentBlob: { is: { status: "ready", deletedAt: null } } },
    ],
  };
}

function authorizedReadyVersionWhere(
  principalId: string,
  artifactId: string,
  artifactVersionId: string,
): Prisma.ArtifactVersionWhereInput {
  return {
    ...readyVersionWhere(artifactId, artifactVersionId),
    artifact: {
      is: {
        id: artifactId,
        project: {
          is: {
            status: "active",
            members: projectMembershipFilter(principalId, "read"),
          },
        },
      },
    },
  };
}
