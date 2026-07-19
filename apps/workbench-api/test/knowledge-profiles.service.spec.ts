import { KnowledgeProfilesController } from "../src/modules/knowledge/knowledge-profiles.controller.js";
import { KnowledgeProfilesService } from "../src/modules/knowledge/knowledge-profiles.service.js";
import { parseEmbeddingProfileV1 } from "@workbench/workbench-knowledge";
import { HEADERS_METADATA } from "@nestjs/common/constants";

const now = new Date("2026-07-15T08:00:00.000Z");

describe("Knowledge Profile governance", () => {
  it("rejects non-operators before reading or mutating Profiles", async () => {
    const db = {
      knowledgeProfileOperatorEvent: { findFirst: vi.fn().mockResolvedValue(null) },
      embeddingProfile: { findUnique: vi.fn() },
    };
    const service = new KnowledgeProfilesService(db as never);

    await expect(service.get("principal_member", "embedding", "embedding-r1"))
      .rejects.toMatchObject({ status: 403 });
    expect(db.embeddingProfile.findUnique).not.toHaveBeenCalled();
  });

  it("creates only the canonical immutable candidate specification", async () => {
    const spec = embeddingSpec("embedding-r1");
    const db = {
      knowledgeProfileOperatorEvent: { findFirst: vi.fn().mockResolvedValue({ action: "grant" }) },
      embeddingProfile: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation(({ data }) => ({
          ...data,
          status: "candidate",
          createdAt: now,
          updatedAt: now,
        })),
      },
    };
    const service = new KnowledgeProfilesService(db as never);

    const result = await service.create("principal_operator", { kind: "embedding", spec });

    expect(result).toMatchObject({
      kind: "embedding",
      id: spec.id,
      profileVersion: 1,
      status: "candidate",
      scope: "global",
      dimension: 3,
    });
    expect(db.embeddingProfile.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: spec.id,
        spec,
        specSha256: result.specSha256,
        dimension: 3,
      }),
    });
  });

  it("uses profile id plus canonical spec hash as the natural idempotency key", async () => {
    const spec = embeddingSpec("embedding-replay-r1");
    const canonical = parseEmbeddingProfileV1(spec);
    const existing = {
      ...profileRow(),
      id: spec.id,
      spec,
      specSha256: canonical.specSha256,
    };
    const db = {
      knowledgeProfileOperatorEvent: { findFirst: vi.fn().mockResolvedValue({ action: "grant" }) },
      embeddingProfile: { findUnique: vi.fn().mockResolvedValue(existing) },
    };
    const service = new KnowledgeProfilesService(db as never);
    await expect(service.create("principal_operator", { kind: "embedding", spec }))
      .resolves.toMatchObject({ id: spec.id, specSha256: canonical.specSha256 });

    await expect(service.create("principal_operator", {
      kind: "embedding",
      spec: {
        ...spec,
        model: { ...spec.model, revision: "commit-different" },
      },
    })).rejects.toMatchObject({ status: 409 });
  });

  it("commits poc adoption and its immutable actor receipt in one transaction", async () => {
    const before = profileRow({ status: "poc" });
    const after = profileRow({ status: "adopted", updatedAt: new Date(now.getTime() + 1_000) });
    const receipt = {
      id: "adoption_1",
      profileKind: "embedding",
      profileVersion: 1,
      embeddingProfileId: after.id,
      embeddingProfileSpecSha256: after.specSha256,
      retrievalProfileId: null,
      retrievalProfileSpecSha256: null,
      actorPrincipalId: "principal_operator",
      scope: "global",
      adoptedAt: after.updatedAt,
    };
    const tx = {
      embeddingProfile: {
        findUnique: vi.fn()
          .mockResolvedValueOnce(before)
          .mockResolvedValueOnce(after),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      retrievalProfile: {},
      knowledgeProfileAdoptionReceipt: {
        create: vi.fn().mockResolvedValue(receipt),
      },
    };
    const db = {
      knowledgeProfileOperatorEvent: { findFirst: vi.fn().mockResolvedValue({ action: "grant" }) },
      $transaction: vi.fn((callback) => callback(tx)),
    };
    const service = new KnowledgeProfilesService(db as never);

    const result = await service.promote(
      "principal_operator",
      "embedding",
      before.id,
      { expectedStatus: "poc", targetStatus: "adopted" },
    );

    expect(tx.embeddingProfile.updateMany).toHaveBeenCalledWith({
      where: { id: before.id, status: "poc" },
      data: { status: "adopted" },
    });
    expect(tx.knowledgeProfileAdoptionReceipt.create).toHaveBeenCalledWith({
      data: {
        profileKind: "embedding",
        profileVersion: 1,
        embeddingProfileId: after.id,
        embeddingProfileSpecSha256: after.specSha256,
        actorPrincipalId: "principal_operator",
        scope: "global",
      },
    });
    expect(result).toMatchObject({
      profile: { status: "adopted" },
      adoptionReceipt: {
        profileId: after.id,
        profileSpecSha256: after.specSha256,
        actorPrincipalId: "principal_operator",
      },
    });
  });

  it("uses expected status as a compare-and-swap boundary", async () => {
    const current = profileRow({ status: "adopted" });
    const tx = {
      embeddingProfile: { findUnique: vi.fn().mockResolvedValue(current), updateMany: vi.fn() },
      retrievalProfile: {},
    };
    const service = new KnowledgeProfilesService({
      knowledgeProfileOperatorEvent: { findFirst: vi.fn().mockResolvedValue({ action: "grant" }) },
      $transaction: vi.fn((callback) => callback(tx)),
    } as never);

    await expect(service.retire(
      "principal_operator",
      "embedding",
      current.id,
      { expectedStatus: "poc" },
    )).rejects.toMatchObject({ status: 409 });
    expect(tx.embeddingProfile.updateMany).not.toHaveBeenCalled();
  });

  it("rejects repeated and unknown query fields at the controller boundary", () => {
    const controller = new KnowledgeProfilesController({ list: vi.fn() } as never);
    expect(() => controller.list(
      { id: "principal_operator" } as never,
      { kind: ["embedding", "retrieval"] },
    )).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => controller.list(
      { id: "principal_operator" } as never,
      { kind: "embedding", private: "forbidden" },
    )).toThrow(expect.objectContaining({ status: 400 }));
  });

  it("marks every operator response private and non-cacheable", () => {
    for (const method of ["list", "create", "get", "promote", "retire", "listAdoptionReceipts"] as const) {
      expect(Reflect.getMetadata(HEADERS_METADATA, KnowledgeProfilesController.prototype[method]))
        .toContainEqual({ name: "Cache-Control", value: "private, no-store" });
    }
  });
});

function profileRow(overrides: Record<string, unknown> = {}) {
  const spec = embeddingSpec("embedding-r1");
  return {
    id: spec.id,
    spec,
    specSha256: "a".repeat(64),
    dimension: 3,
    status: "candidate",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function embeddingSpec(id: string) {
  return {
    schema: "workbench.embedding-profile.v1" as const,
    id,
    protocol: "tei.embed.v1" as const,
    engine: {
      id: "text-embeddings-inference",
      version: "1.8.0",
      imageDigest: `sha256:${"1".repeat(64)}`,
    },
    model: {
      id: "workbench/embedding",
      revision: "commit-123",
      artifactSha256: "2".repeat(64),
    },
    tokenizer: {
      id: "workbench/tokenizer",
      revision: "commit-123",
      artifactSha256: "3".repeat(64),
      modelMaximumTokens: 512,
      chunkMaximumTokens: 256,
      overflow: "reject" as const,
    },
    input: { queryPrefix: "", documentPrefix: "", normalization: "utf8-nfc-lf-v1" as const },
    output: {
      dimension: 3,
      dtype: "float32" as const,
      pooling: "cls" as const,
      normalization: "l2" as const,
      distance: "cosine" as const,
    },
    batch: { maximumInputs: 16, maximumTokens: 4_096 },
    conformanceProbeSha256: "4".repeat(64),
  };
}
