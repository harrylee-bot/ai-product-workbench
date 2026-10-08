import { Prisma } from "@workbench/workbench-db";
import { parseEmbeddingProfileV1, parseRetrievalProfileV1 } from "@workbench/workbench-knowledge";
import { ensureWorkbenchPasswordAccount } from "./workbench-bootstrap-account-lib.mjs";
import { applyKnowledgeProfileOperatorEvent, readKnowledgeProfileOperatorOptions } from "./workbench-knowledge-profile-operator-lib.mjs";

export function parseBootstrapProfiles(embeddingSpec, retrievalSpec) {
  const embedding = parseEmbeddingProfileV1(embeddingSpec);
  const retrieval = parseRetrievalProfileV1(retrievalSpec);
  if (embedding.spec.protocol !== "tei.embed.v1"
    || retrieval.embeddingProfileId !== embedding.spec.id
    || retrieval.embeddingProfileSpecSha256 !== embedding.specSha256
    || retrieval.embeddingDimension !== embedding.dimension) throw new Error("BOOTSTRAP_PROFILE_IDENTITY_MISMATCH");
  return { embedding, retrieval };
}

export async function prepareKnowledgeBootstrap(db, { account, issuer, authorizedBy, changeReference, profiles }) {
  const user = await ensureWorkbenchPasswordAccount(db, account);
  const principal = await db.principal.upsert({
    where: { issuer_subject: { issuer, subject: user.id } },
    create: { issuer, subject: user.id, displayName: account.name }, update: {},
  });
  if (principal.status !== "active") throw new Error("BOOTSTRAP_PRINCIPAL_DISABLED");
  const options = readKnowledgeProfileOperatorOptions({}, [
    "--action=grant", `--issuer=${issuer}`, `--subject=${user.id}`,
    `--authorized-by=${authorizedBy}`, `--change-reference=${changeReference}`,
  ]);
  await applyKnowledgeProfileOperatorEvent({ db, options, lockPrincipal: async (tx, principalId) => {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM principals WHERE id = ${principalId} FOR UPDATE`);
  } });
  await db.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended('workbench.bootstrap.profiles', 0))::TEXT`);
    await ensureCandidate(tx.embeddingProfile, {
      id: profiles.embedding.spec.id, spec: profiles.embedding.spec,
      specSha256: profiles.embedding.specSha256, dimension: profiles.embedding.dimension,
    });
    await ensureCandidate(tx.retrievalProfile, {
      id: profiles.retrieval.spec.id, spec: profiles.retrieval.spec, specSha256: profiles.retrieval.specSha256,
      embeddingProfileId: profiles.embedding.spec.id, embeddingProfileSpecSha256: profiles.embedding.specSha256,
      embeddingDimension: profiles.embedding.dimension,
    });
  });
  return { accountId: user.id, principalId: principal.id, accountCreated: user.created };
}

// Call only after runKnowledgeConformance returned ok; no ready release is
// synthesized here. Publication still uses the normal File Worker pipeline.
export async function adoptBootstrapProfiles(db, principalId, profiles) {
  await db.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended('workbench.bootstrap.profiles', 0))::TEXT`);
    await tx.$queryRaw(Prisma.sql`SELECT id FROM principals WHERE id = ${principalId} FOR UPDATE`);
    const actor = await tx.principal.findUnique({ where: { id: principalId } });
    if (actor?.status !== "active") throw new Error("BOOTSTRAP_PRINCIPAL_DISABLED");
    const operator = await tx.knowledgeProfileOperatorEvent.findFirst({ where: { principalId }, orderBy: { id: "desc" } });
    if (operator?.action !== "grant") throw new Error("BOOTSTRAP_OPERATOR_NOT_GRANTED");
    for (const [kind, profile] of [["embedding", profiles.embedding], ["retrieval", profiles.retrieval]]) {
      const model = kind === "embedding" ? tx.embeddingProfile : tx.retrievalProfile;
      let row = await model.findUniqueOrThrow({ where: { id: profile.spec.id } });
      if (row.specSha256 !== profile.specSha256 || row.status === "retired") throw new Error("BOOTSTRAP_PROFILE_IDENTITY_MISMATCH");
      if (row.status === "candidate") row = await model.update({ where: { id: row.id }, data: { status: "poc" } });
      if (row.status === "poc") {
        row = await model.update({ where: { id: row.id }, data: { status: "adopted" } });
        await tx.knowledgeProfileAdoptionReceipt.create({ data: {
          profileKind: kind, profileVersion: 1, actorPrincipalId: principalId, scope: "global",
          ...(kind === "embedding"
            ? { embeddingProfileId: row.id, embeddingProfileSpecSha256: row.specSha256 }
            : { retrievalProfileId: row.id, retrievalProfileSpecSha256: row.specSha256 }),
        } });
      }
      const receipt = await tx.knowledgeProfileAdoptionReceipt.findFirst({ where: {
        profileKind: kind, ...(kind === "embedding" ? { embeddingProfileId: row.id } : { retrievalProfileId: row.id }),
      } });
      if (!receipt) throw new Error("BOOTSTRAP_ADOPTION_RECEIPT_MISSING");
    }
  });
}

async function ensureCandidate(model, data) {
  const existing = await model.findUnique({ where: { id: data.id } });
  if (!existing) return model.create({ data });
  if (existing.specSha256 !== data.specSha256 || existing.status === "retired") throw new Error("BOOTSTRAP_PROFILE_IDENTITY_MISMATCH");
  return existing;
}
