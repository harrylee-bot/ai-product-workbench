import {
  canonicalSha256,
  parseEmbeddingProfileV1,
  parseRetrievalProfileV1,
} from "@workbench/workbench-knowledge";
import { knowledgeReleaseBuildJobSchema } from "@workbench/workbench-contracts";

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export function readKnowledgeReleaseOptions(
  env = process.env,
  argv = process.argv.slice(2),
) {
  const flags = parseFlags(argv);
  const key = required(flags.key ?? env.WORKBENCH_KNOWLEDGE_RELEASE_KEY, "key");
  const version = positiveInteger(
    flags.version ?? env.WORKBENCH_KNOWLEDGE_RELEASE_VERSION,
    "version",
  );
  const embeddingProfileId = required(
    flags.embeddingProfile ?? env.WORKBENCH_KNOWLEDGE_EMBEDDING_PROFILE_ID,
    "embedding profile id",
  );
  const retrievalProfileId = required(
    flags.retrievalProfile ?? env.WORKBENCH_KNOWLEDGE_RETRIEVAL_PROFILE_ID,
    "retrieval profile id",
  );
  const workspaceId = optional(flags.workspace ?? env.WORKBENCH_KNOWLEDGE_WORKSPACE_ID);
  return { key, version, workspaceId, embeddingProfileId, retrievalProfileId };
}

export function assertKnowledgeReleaseProfiles({ embedding, retrieval }) {
  if (!embedding || !retrieval) throw new Error("KNOWLEDGE_PROFILE_NOT_FOUND");
  if (embedding.status !== "adopted") {
    throw new Error(`KNOWLEDGE_EMBEDDING_PROFILE_NOT_ADOPTED:${embedding.id}`);
  }
  if (retrieval.status !== "adopted") {
    throw new Error(`KNOWLEDGE_RETRIEVAL_PROFILE_NOT_ADOPTED:${retrieval.id}`);
  }

  const canonicalEmbedding = parseEmbeddingProfileV1(embedding.spec);
  const canonicalRetrieval = parseRetrievalProfileV1(retrieval.spec);
  if (
    canonicalEmbedding.spec.id !== embedding.id
    || canonicalEmbedding.specSha256 !== embedding.specSha256
    || canonicalEmbedding.dimension !== embedding.dimension
  ) {
    throw new Error(`KNOWLEDGE_EMBEDDING_PROFILE_IDENTITY_MISMATCH:${embedding.id}`);
  }
  if (
    canonicalRetrieval.spec.id !== retrieval.id
    || canonicalRetrieval.specSha256 !== retrieval.specSha256
    || canonicalRetrieval.embeddingProfileId !== embedding.id
    || canonicalRetrieval.embeddingProfileSpecSha256 !== embedding.specSha256
    || canonicalRetrieval.embeddingDimension !== embedding.dimension
    || retrieval.embeddingProfileId !== embedding.id
    || retrieval.embeddingProfileSpecSha256 !== embedding.specSha256
    || retrieval.embeddingDimension !== embedding.dimension
  ) {
    throw new Error(`KNOWLEDGE_RETRIEVAL_PROFILE_IDENTITY_MISMATCH:${retrieval.id}`);
  }
  return { embedding: canonicalEmbedding, retrieval: canonicalRetrieval };
}

export function buildKnowledgeReleaseSeed(options, profiles) {
  const manifest = {
    schema: "workbench.knowledge-release-building.v1",
    releaseKey: options.key,
    releaseVersion: options.version,
    profile: {
      embedding: {
        id: profiles.embedding.spec.id,
        specSha256: profiles.embedding.specSha256,
        dimension: profiles.embedding.dimension,
      },
      retrieval: {
        id: profiles.retrieval.spec.id,
        specSha256: profiles.retrieval.specSha256,
      },
    },
  };
  return {
    key: options.key,
    workspaceId: options.workspaceId,
    version: options.version,
    status: "building",
    embeddingProfileId: profiles.embedding.spec.id,
    embeddingProfileSpecSha256: profiles.embedding.specSha256,
    embeddingDimension: profiles.embedding.dimension,
    retrievalProfileId: profiles.retrieval.spec.id,
    retrievalProfileSpecSha256: profiles.retrieval.specSha256,
    manifest,
    manifestSha256: canonicalSha256(manifest),
  };
}

export async function createOrQueueKnowledgeRelease({
  db,
  options,
  lockIdentity,
  enqueue,
}) {
  return db.$transaction(async (tx) => {
    await lockIdentity(tx, options);
    const existing = await tx.knowledgeRelease.findUnique({
      where: { key_version: { key: options.key, version: options.version } },
    });

    if (existing) {
      assertRequestedReleaseIdentity(existing, options);
      if (existing.status === "failed") {
        throw new Error("KNOWLEDGE_RELEASE_FAILED_VERSION_IMMUTABLE");
      }
      if (existing.status === "ready" || existing.status === "retired") {
        return {
          release: existing,
          jobId: null,
          created: false,
          queued: false,
          queueDisposition: "not-required",
        };
      }
    }

    const [embedding, retrieval] = await Promise.all([
      tx.embeddingProfile.findUnique({ where: { id: options.embeddingProfileId } }),
      tx.retrievalProfile.findUnique({ where: { id: options.retrievalProfileId } }),
    ]);
    const profiles = assertKnowledgeReleaseProfiles({ embedding, retrieval });
    const seed = buildKnowledgeReleaseSeed(options, profiles);
    const release = existing ?? await tx.knowledgeRelease.create({ data: seed });
    if (existing) assertSameReleaseIdentity(existing, seed);

    const job = knowledgeReleaseBuildJobSchema.parse({ releaseId: release.id });
    const jobId = await enqueue(tx, job, release.id);
    return {
      release,
      jobId,
      created: !existing,
      queued: true,
      queueDisposition: jobId ? "created" : "already-queued",
    };
  }, { maxWait: 10_000, timeout: 30_000 });
}

function parseFlags(argv) {
  const flags = {};
  for (const argument of argv) {
    const match = /^(?:--)(key|version|workspace|embedding-profile|retrieval-profile)=(.+)$/u.exec(argument);
    if (!match) throw new Error(`Unknown argument: ${argument}`);
    const field = match[1] === "embedding-profile"
      ? "embeddingProfile"
      : match[1] === "retrieval-profile"
        ? "retrievalProfile"
        : match[1];
    if (Object.hasOwn(flags, field)) throw new Error(`Duplicate argument: --${match[1]}`);
    flags[field] = match[2];
  }
  return flags;
}

function assertRequestedReleaseIdentity(release, options) {
  if (
    release.workspaceId !== options.workspaceId
    || release.embeddingProfileId !== options.embeddingProfileId
    || release.retrievalProfileId !== options.retrievalProfileId
  ) {
    throw new Error("KNOWLEDGE_RELEASE_IDENTITY_CONFLICT");
  }
}

function assertSameReleaseIdentity(release, seed) {
  if (
    release.workspaceId !== seed.workspaceId
    || release.embeddingProfileId !== seed.embeddingProfileId
    || release.embeddingProfileSpecSha256 !== seed.embeddingProfileSpecSha256
    || release.embeddingDimension !== seed.embeddingDimension
    || release.retrievalProfileId !== seed.retrievalProfileId
    || release.retrievalProfileSpecSha256 !== seed.retrievalProfileSpecSha256
  ) {
    throw new Error("KNOWLEDGE_RELEASE_IDENTITY_CONFLICT");
  }
}

function required(value, label) {
  const normalized = optional(value);
  if (!normalized) throw new Error(`Missing Knowledge release ${label}`);
  if (!identifierPattern.test(normalized)) {
    throw new Error(`Invalid Knowledge release ${label}`);
  }
  return normalized;
}

function optional(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}

function positiveInteger(value, label) {
  const normalized = optional(value);
  if (!normalized || !/^\d+$/u.test(normalized)) throw new Error(`Invalid Knowledge release ${label}`);
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`Invalid Knowledge release ${label}`);
  return parsed;
}
