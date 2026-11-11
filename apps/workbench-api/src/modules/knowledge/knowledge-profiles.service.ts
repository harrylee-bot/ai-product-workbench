import { Injectable } from "@nestjs/common";
import {
  knowledgeProfileAdoptionReceiptListSchema,
  knowledgeProfileListSchema,
  knowledgeProfilePromotionResultSchema,
  knowledgeProfileSchema,
  type CreateKnowledgeProfileRequest,
  type KnowledgeProfile,
  type KnowledgeProfileAdoptionReceipt,
  type KnowledgeProfileAdoptionReceiptList,
  type KnowledgeProfileKind,
  type KnowledgeProfileList,
  type KnowledgeProfilePromotionResult,
  type KnowledgeProfileStatus,
  type PromoteKnowledgeProfileRequest,
  type RetireKnowledgeProfileRequest,
} from "@workbench/workbench-contracts";
import { Prisma } from "@workbench/workbench-db";
import {
  EmbeddingProfileContractError,
  parseEmbeddingProfileV1,
  parseRetrievalProfileV1,
  RetrievalProfileContractError,
} from "@workbench/workbench-knowledge";
import { z } from "zod";
import {
  forbiddenProblem,
  knowledgeProfileStateConflictProblem,
  notFoundProblem,
  validationProblem,
} from "../../common/problem-details.js";
import { isUniqueConflict } from "../../common/prisma-errors.js";
import { WorkbenchDbService } from "../../platform/database/workbench-db.service.js";
const profileCursorSchema = z.object({
  version: z.literal(1),
  kind: z.enum(["embedding", "retrieval"]),
  status: z.enum(["candidate", "poc", "adopted", "retired"]).nullable(),
  profileId: z.string().min(1).max(128),
}).strict();

const adoptionReceiptCursorSchema = z.object({
  version: z.literal(1),
  kind: z.enum(["embedding", "retrieval"]).nullable(),
  profileId: z.string().min(1).max(128).nullable(),
  receiptId: z.string().min(1).max(128),
}).strict();

type ProfileRow = {
  id: string;
  spec: Prisma.JsonValue;
  specSha256: string;
  status: KnowledgeProfileStatus;
  createdAt: Date;
  updatedAt: Date;
  dimension?: number;
  embeddingProfileId?: string;
  embeddingProfileSpecSha256?: string;
  embeddingDimension?: number;
};

type AdoptionReceiptRow = {
  id: string;
  profileKind: KnowledgeProfileKind;
  profileVersion: number;
  embeddingProfileId: string | null;
  embeddingProfileSpecSha256: string | null;
  retrievalProfileId: string | null;
  retrievalProfileSpecSha256: string | null;
  actorPrincipalId: string;
  scope: "global";
  adoptedAt: Date;
};

@Injectable()
export class KnowledgeProfilesService {
  constructor(private readonly db: WorkbenchDbService) {}

  async create(
    principalId: string,
    request: CreateKnowledgeProfileRequest,
  ): Promise<KnowledgeProfile> {
    await this.assertOperator(principalId);
    const canonical = parseProfileRequest(request);
    const existing = await this.findProfile(request.kind, canonical.id);
    if (existing) return resolveCreateReplay(request.kind, existing, canonical.specSha256);

    if (canonical.kind === "retrieval") {
      await this.assertEmbeddingProfileAvailable({
        id: canonical.embeddingProfileId,
        specSha256: canonical.embeddingProfileSpecSha256,
        dimension: canonical.embeddingDimension,
      });
    }

    try {
      const created = canonical.kind === "embedding"
        ? await this.db.embeddingProfile.create({
            data: {
              id: canonical.id,
              spec: canonical.spec as unknown as Prisma.InputJsonValue,
              specSha256: canonical.specSha256,
              dimension: canonical.dimension,
            },
          })
        : await this.db.retrievalProfile.create({
            data: {
              id: canonical.id,
              spec: canonical.spec as unknown as Prisma.InputJsonValue,
              specSha256: canonical.specSha256,
              embeddingProfileId: canonical.embeddingProfileId,
              embeddingProfileSpecSha256: canonical.embeddingProfileSpecSha256,
              embeddingDimension: canonical.embeddingDimension,
            },
          });
      return mapProfile(request.kind, created as ProfileRow);
    } catch (error) {
      if (isUniqueConflict(error)) {
        const raced = await this.findProfile(request.kind, canonical.id);
        if (raced) return resolveCreateReplay(request.kind, raced, canonical.specSha256);
      }
      throw error;
    }
  }

  async list(
    principalId: string,
    kind: KnowledgeProfileKind,
    status?: KnowledgeProfileStatus,
    cursor?: string,
    requestedLimit?: number,
  ): Promise<KnowledgeProfileList> {
    await this.assertOperator(principalId);
    const decoded = cursor ? decodeProfileCursor(cursor) : undefined;
    if (decoded && (decoded.kind !== kind || decoded.status !== (status ?? null))) {
      throw validationProblem("The Knowledge Profile cursor does not belong to these filters");
    }
    const limit = boundedLimit(requestedLimit);
    const where = {
      ...(status ? { status } : {}),
      ...(decoded ? { id: { gt: decoded.profileId } } : {}),
    };
    const rows = kind === "embedding"
      ? await this.db.embeddingProfile.findMany({ where, orderBy: { id: "asc" }, take: limit + 1 })
      : await this.db.retrievalProfile.findMany({ where, orderBy: { id: "asc" }, take: limit + 1 });
    const hasNextPage = rows.length > limit;
    const page = hasNextPage ? rows.slice(0, limit) : rows;
    const last = page.at(-1);
    return knowledgeProfileListSchema.parse({
      items: page.map((row) => mapProfile(kind, row as ProfileRow)),
      nextCursor: hasNextPage && last
        ? encodeCursor({ version: 1, kind, status: status ?? null, profileId: last.id })
        : null,
    });
  }

  async get(
    principalId: string,
    kind: KnowledgeProfileKind,
    profileId: string,
  ): Promise<KnowledgeProfile> {
    await this.assertOperator(principalId);
    const profile = await this.findProfile(kind, profileId);
    if (!profile) throw notFoundProblem("Knowledge Profile");
    return mapProfile(kind, profile as ProfileRow);
  }

  async promote(
    principalId: string,
    kind: KnowledgeProfileKind,
    profileId: string,
    request: PromoteKnowledgeProfileRequest,
  ): Promise<KnowledgeProfilePromotionResult> {
    await this.assertOperator(principalId);
    return this.db.$transaction(async (tx) => {
      const current = await findProfileIn(tx, kind, profileId);
      if (!current) throw notFoundProblem("Knowledge Profile");
      if (current.status === request.targetStatus) {
        const receipt = request.targetStatus === "adopted"
          ? await findAdoptionReceipt(tx, kind, profileId)
          : null;
        if (request.targetStatus === "adopted" && !receipt) {
          throw knowledgeProfileStateConflictProblem(
            "KNOWLEDGE_PROFILE_ADOPTION_RECEIPT_MISSING",
            "The adopted Knowledge Profile is missing its required immutable receipt",
          );
        }
        return mapPromotion(kind, current, receipt);
      }
      if (current.status !== request.expectedStatus) throw lifecycleConflict(current.status);

      const updatedCount = kind === "embedding"
        ? await tx.embeddingProfile.updateMany({
            where: { id: profileId, status: request.expectedStatus },
            data: { status: request.targetStatus },
          })
        : await tx.retrievalProfile.updateMany({
            where: { id: profileId, status: request.expectedStatus },
            data: { status: request.targetStatus },
          });
      if (updatedCount.count !== 1) throw lifecycleConflict(current.status);

      const updated = await findProfileIn(tx, kind, profileId);
      if (!updated) throw notFoundProblem("Knowledge Profile");
      const receipt = request.targetStatus === "adopted"
        ? await tx.knowledgeProfileAdoptionReceipt.create({
            data: kind === "embedding"
              ? {
                  profileKind: kind,
                  profileVersion: 1,
                  embeddingProfileId: updated.id,
                  embeddingProfileSpecSha256: updated.specSha256,
                  actorPrincipalId: principalId,
                  scope: "global",
                }
              : {
                  profileKind: kind,
                  profileVersion: 1,
                  retrievalProfileId: updated.id,
                  retrievalProfileSpecSha256: updated.specSha256,
                  actorPrincipalId: principalId,
                  scope: "global",
                },
          })
        : null;
      return mapPromotion(kind, updated, receipt);
    });
  }

  async retire(
    principalId: string,
    kind: KnowledgeProfileKind,
    profileId: string,
    request: RetireKnowledgeProfileRequest,
  ): Promise<KnowledgeProfile> {
    await this.assertOperator(principalId);
    return this.db.$transaction(async (tx) => {
      const current = await findProfileIn(tx, kind, profileId);
      if (!current) throw notFoundProblem("Knowledge Profile");
      if (current.status === "retired") return mapProfile(kind, current);
      if (current.status !== request.expectedStatus) throw lifecycleConflict(current.status);

      const updatedCount = kind === "embedding"
        ? await tx.embeddingProfile.updateMany({
            where: { id: profileId, status: request.expectedStatus },
            data: { status: "retired" },
          })
        : await tx.retrievalProfile.updateMany({
            where: { id: profileId, status: request.expectedStatus },
            data: { status: "retired" },
          });
      if (updatedCount.count !== 1) throw lifecycleConflict(current.status);
      const updated = await findProfileIn(tx, kind, profileId);
      if (!updated) throw notFoundProblem("Knowledge Profile");
      return mapProfile(kind, updated);
    });
  }

  async listAdoptionReceipts(
    principalId: string,
    kind?: KnowledgeProfileKind,
    profileId?: string,
    cursor?: string,
    requestedLimit?: number,
  ): Promise<KnowledgeProfileAdoptionReceiptList> {
    await this.assertOperator(principalId);
    const decoded = cursor ? decodeAdoptionReceiptCursor(cursor) : undefined;
    if (decoded && (decoded.kind !== (kind ?? null) || decoded.profileId !== (profileId ?? null))) {
      throw validationProblem("The Knowledge Profile adoption cursor does not belong to these filters");
    }
    const limit = boundedLimit(requestedLimit);
    const rows = await this.db.knowledgeProfileAdoptionReceipt.findMany({
      where: {
        ...(kind ? { profileKind: kind } : {}),
        ...(profileId && kind === "embedding" ? { embeddingProfileId: profileId } : {}),
        ...(profileId && kind === "retrieval" ? { retrievalProfileId: profileId } : {}),
        ...(profileId && !kind ? {
          OR: [{ embeddingProfileId: profileId }, { retrievalProfileId: profileId }],
        } : {}),
        ...(decoded ? { id: { gt: decoded.receiptId } } : {}),
      },
      orderBy: { id: "asc" },
      take: limit + 1,
    });
    const hasNextPage = rows.length > limit;
    const page = hasNextPage ? rows.slice(0, limit) : rows;
    const last = page.at(-1);
    return knowledgeProfileAdoptionReceiptListSchema.parse({
      items: page.map((receipt) => mapAdoptionReceipt(receipt as AdoptionReceiptRow)),
      nextCursor: hasNextPage && last
        ? encodeCursor({
            version: 1,
            kind: kind ?? null,
            profileId: profileId ?? null,
            receiptId: last.id,
          })
        : null,
    });
  }

  private async assertOperator(principalId: string) {
    const event = await this.db.knowledgeProfileOperatorEvent.findFirst({
      where: { principalId },
      orderBy: { id: "desc" },
      select: { action: true },
    });
    if (event?.action !== "grant") throw forbiddenProblem();
  }

  private findProfile(kind: KnowledgeProfileKind, profileId: string) {
    return kind === "embedding"
      ? this.db.embeddingProfile.findUnique({ where: { id: profileId } })
      : this.db.retrievalProfile.findUnique({ where: { id: profileId } });
  }

  private async assertEmbeddingProfileAvailable(identity: {
    id: string;
    specSha256: string;
    dimension: number;
  }) {
    const profile = await this.db.embeddingProfile.findFirst({
      where: {
        id: identity.id,
        specSha256: identity.specSha256,
        dimension: identity.dimension,
      },
      select: { status: true },
    });
    if (!profile || profile.status === "retired") {
      throw knowledgeProfileStateConflictProblem(
        "KNOWLEDGE_PROFILE_EMBEDDING_INVALID",
        "The Retrieval Profile must pin an existing non-retired Embedding Profile",
      );
    }
  }
}

function parseProfileRequest(request: CreateKnowledgeProfileRequest) {
  try {
    if (request.kind === "embedding") {
      const profile = parseEmbeddingProfileV1(request.spec);
      return {
        kind: "embedding",
        id: profile.spec.id,
        spec: profile.spec,
        specSha256: profile.specSha256,
        dimension: profile.dimension,
      } as const;
    }
    const profile = parseRetrievalProfileV1(request.spec);
    return {
      kind: "retrieval",
      id: profile.spec.id,
      spec: profile.spec,
      specSha256: profile.specSha256,
      embeddingProfileId: profile.embeddingProfileId,
      embeddingProfileSpecSha256: profile.embeddingProfileSpecSha256,
      embeddingDimension: profile.embeddingDimension,
    } as const;
  } catch (error) {
    if (error instanceof EmbeddingProfileContractError || error instanceof RetrievalProfileContractError) {
      throw validationProblem(error.message);
    }
    throw error;
  }
}

async function findProfileIn(
  tx: Prisma.TransactionClient,
  kind: KnowledgeProfileKind,
  profileId: string,
): Promise<ProfileRow | null> {
  const row = kind === "embedding"
    ? await tx.embeddingProfile.findUnique({ where: { id: profileId } })
    : await tx.retrievalProfile.findUnique({ where: { id: profileId } });
  return row as ProfileRow | null;
}

function findAdoptionReceipt(
  tx: Prisma.TransactionClient,
  kind: KnowledgeProfileKind,
  profileId: string,
) {
  return tx.knowledgeProfileAdoptionReceipt.findFirst({
    where: kind === "embedding"
      ? { profileKind: kind, embeddingProfileId: profileId }
      : { profileKind: kind, retrievalProfileId: profileId },
  });
}

function mapProfile(kind: KnowledgeProfileKind, row: ProfileRow): KnowledgeProfile {
  const base = {
    kind,
    id: row.id,
    profileVersion: 1,
    specSha256: row.specSha256,
    status: row.status,
    scope: "global",
    spec: row.spec,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  } as const;
  return knowledgeProfileSchema.parse(kind === "embedding"
    ? { ...base, dimension: row.dimension }
    : {
        ...base,
        embedding: {
          profileId: row.embeddingProfileId,
          profileSpecSha256: row.embeddingProfileSpecSha256,
          dimension: row.embeddingDimension,
        },
      });
}

function mapPromotion(
  kind: KnowledgeProfileKind,
  profile: ProfileRow,
  receipt: AdoptionReceiptRow | null,
): KnowledgeProfilePromotionResult {
  return knowledgeProfilePromotionResultSchema.parse({
    profile: mapProfile(kind, profile),
    adoptionReceipt: receipt ? mapAdoptionReceipt(receipt) : null,
  });
}

function mapAdoptionReceipt(receipt: AdoptionReceiptRow): KnowledgeProfileAdoptionReceipt {
  const embedding = receipt.profileKind === "embedding";
  return {
    id: receipt.id,
    profileKind: receipt.profileKind,
    profileId: (embedding ? receipt.embeddingProfileId : receipt.retrievalProfileId)!,
    profileVersion: 1,
    profileSpecSha256: (
      embedding ? receipt.embeddingProfileSpecSha256 : receipt.retrievalProfileSpecSha256
    )!,
    actorPrincipalId: receipt.actorPrincipalId,
    scope: receipt.scope,
    adoptedAt: receipt.adoptedAt.toISOString(),
  };
}

function resolveCreateReplay(
  kind: KnowledgeProfileKind,
  existing: ProfileRow,
  expectedSpecSha256: string,
) {
  if (existing.specSha256 !== expectedSpecSha256) {
    throw knowledgeProfileStateConflictProblem(
      "KNOWLEDGE_PROFILE_IDENTITY_CONFLICT",
      "The Knowledge Profile id is already bound to a different immutable specification",
    );
  }
  return mapProfile(kind, existing);
}

function lifecycleConflict(currentStatus: KnowledgeProfileStatus) {
  return knowledgeProfileStateConflictProblem(
    "KNOWLEDGE_PROFILE_STATUS_CONFLICT",
    `The Knowledge Profile changed and is currently ${currentStatus}`,
  );
}

function boundedLimit(requested?: number) {
  return Math.min(Math.max(requested ?? 30, 1), 100);
}

function encodeCursor(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeProfileCursor(value: string) {
  return decodeCursor(value, profileCursorSchema, "Knowledge Profile cursor");
}

function decodeAdoptionReceiptCursor(value: string) {
  return decodeCursor(value, adoptionReceiptCursorSchema, "Knowledge Profile adoption cursor");
}

function decodeCursor<T>(value: string, schema: z.ZodType<T>, label: string): T {
  try {
    if (!/^[A-Za-z0-9_-]{1,2048}$/u.test(value)) throw new Error("invalid encoding");
    return schema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
  } catch {
    throw validationProblem(`The ${label} is invalid`);
  }
}
