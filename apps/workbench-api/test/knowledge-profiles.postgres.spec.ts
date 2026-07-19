import { PrismaClient } from "@workbench/workbench-db";
import { KnowledgeProfilesService } from "../src/modules/knowledge/knowledge-profiles.service.js";

const databaseUrl = process.env.WORKBENCH_TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("Knowledge Profile governed lifecycle", () => {
  it("requires an operator, couples adoption to an immutable receipt, and permits later retirement", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl });
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`.toLowerCase();
    const profileId = `profile-lifecycle-${suffix}`;
    try {
      const operator = await db.principal.create({
        data: { issuer: `knowledge-profile-test-${suffix}`, subject: "operator" },
      });
      const member = await db.principal.create({
        data: { issuer: `knowledge-profile-test-${suffix}`, subject: "member" },
      });
      await db.knowledgeProfileOperatorEvent.create({
        data: {
          principalId: operator.id,
          action: "grant",
          authorizedBy: "test.approver",
          changeReference: `TEST-${suffix}`,
        },
      });
      const service = new KnowledgeProfilesService(db as never);
      const concurrentProfileId = `profile-concurrent-${suffix}`;
      const concurrent = await Promise.allSettled([
        service.create(operator.id, {
          kind: "embedding",
          spec: embeddingSpec(concurrentProfileId),
        }),
        service.create(operator.id, {
          kind: "embedding",
          spec: {
            ...embeddingSpec(concurrentProfileId),
            model: {
              ...embeddingSpec(concurrentProfileId).model,
              revision: "commit-different",
            },
          },
        }),
      ]);
      expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(concurrent.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect((concurrent.find((result) => result.status === "rejected") as PromiseRejectedResult).reason)
        .toMatchObject({ status: 409 });

      const candidate = await service.create(operator.id, {
        kind: "embedding",
        spec: embeddingSpec(profileId),
      });
      await service.promote(operator.id, "embedding", profileId, {
        expectedStatus: "candidate",
        targetStatus: "poc",
      });

      await expect(db.embeddingProfile.update({
        where: { id: profileId },
        data: { status: "adopted" },
      })).rejects.toBeDefined();
      await expect(service.get(member.id, "embedding", profileId))
        .rejects.toMatchObject({ status: 403 });

      const adopted = await service.promote(operator.id, "embedding", profileId, {
        expectedStatus: "poc",
        targetStatus: "adopted",
      });
      expect(adopted).toMatchObject({
        profile: { id: candidate.id, status: "adopted" },
        adoptionReceipt: {
          profileId,
          profileSpecSha256: candidate.specSha256,
          actorPrincipalId: operator.id,
          scope: "global",
        },
      });

      await expect(db.knowledgeProfileAdoptionReceipt.update({
        where: { id: adopted.adoptionReceipt!.id },
        data: { actorPrincipalId: member.id },
      })).rejects.toBeDefined();
      await expect(db.knowledgeProfileAdoptionReceipt.delete({
        where: { id: adopted.adoptionReceipt!.id },
      })).rejects.toBeDefined();

      await expect(service.retire(operator.id, "embedding", profileId, {
        expectedStatus: "adopted",
      })).resolves.toMatchObject({ id: profileId, status: "retired" });
      await expect(service.listAdoptionReceipts(
        operator.id,
        "embedding",
        profileId,
      )).resolves.toMatchObject({
        items: [{ id: adopted.adoptionReceipt!.id, profileId }],
        nextCursor: null,
      });
    } finally {
      await db.$disconnect();
    }
  }, 20_000);
});

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
