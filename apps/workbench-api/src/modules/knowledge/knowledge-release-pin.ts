import {
  canonicalSha256,
  knowledgeRetrievalPolicyFromProfile,
  parseEmbeddingProfileV1,
  parseRetrievalProfileV1,
  type CanonicalEmbeddingProfileV1,
  type CanonicalRetrievalProfileV1,
  type JsonValue,
} from "@workbench/workbench-knowledge";
import {
  KnowledgeRetrievalError,
  type KnowledgeReleasePin,
  type KnowledgeRetrievalDependencies,
} from "./knowledge-retrieval.types.js";

export type KnowledgeReleasePinValidationInput = Omit<
  KnowledgeReleasePin,
  "status" | "manifest" | "embeddingProfile"
> & {
  readonly status: string;
  readonly manifest: unknown;
  readonly embeddingProfile: Omit<KnowledgeReleasePin["embeddingProfile"], "status"> & {
    readonly status: string;
  };
};

export type KnowledgeReleaseResolvedPin = {
  readonly embeddingProfile: CanonicalEmbeddingProfileV1;
  readonly retrievalProfile: CanonicalRetrievalProfileV1;
  readonly policy: ReturnType<typeof knowledgeRetrievalPolicyFromProfile>;
};

export function assertKnowledgeReleasePin(
  release: KnowledgeReleasePinValidationInput,
  segmenterIdentity: KnowledgeRetrievalDependencies["segmenter"]["identity"],
): CanonicalEmbeddingProfileV1 {
  return assertKnowledgeReleasePins(release, segmenterIdentity).embeddingProfile;
}

export function assertKnowledgeReleasePins(
  release: KnowledgeReleasePinValidationInput,
  segmenterIdentity: KnowledgeRetrievalDependencies["segmenter"]["identity"],
): KnowledgeReleaseResolvedPin {
  if (release.status !== "ready" && release.status !== "retired") {
    throw integrityError("Knowledge release is not published");
  }
  if (release.embeddingProfile.status !== "adopted" && release.embeddingProfile.status !== "retired") {
    throw integrityError("Published release embedding profile is not adopted or retired");
  }
  if (release.retrievalProfile.status !== "adopted" && release.retrievalProfile.status !== "retired") {
    throw integrityError("Published release retrieval profile is not adopted or retired");
  }
  if (!release.chunksReadyAt || !release.readyAt) {
    throw integrityError("Published release checkpoints are missing");
  }
  if (canonicalSha256(release.manifest as JsonValue) !== release.manifestSha256) {
    throw integrityError("Published release manifest checksum is invalid");
  }

  let profile: CanonicalEmbeddingProfileV1;
  try {
    profile = parseEmbeddingProfileV1(release.embeddingProfile.spec);
  } catch (cause) {
    throw new KnowledgeRetrievalError(
      "KNOWLEDGE_RETRIEVAL_PROFILE_INVALID",
      "The pinned Knowledge embedding profile is invalid",
      { cause },
    );
  }
  let retrievalProfile: CanonicalRetrievalProfileV1;
  try {
    retrievalProfile = parseRetrievalProfileV1(release.retrievalProfile.spec);
  } catch (cause) {
    throw new KnowledgeRetrievalError(
      "KNOWLEDGE_RETRIEVAL_PROFILE_INVALID",
      "The pinned Knowledge retrieval profile is invalid",
      { cause },
    );
  }
  if (
    profile.spec.id !== release.embeddingProfileId
    || profile.specSha256 !== release.embeddingProfileSpecSha256
    || profile.dimension !== release.embeddingDimension
    || release.embeddingProfile.id !== release.embeddingProfileId
    || release.embeddingProfile.specSha256 !== release.embeddingProfileSpecSha256
    || release.embeddingProfile.dimension !== release.embeddingDimension
    || retrievalProfile.spec.id !== release.retrievalProfileId
    || retrievalProfile.specSha256 !== release.retrievalProfileSpecSha256
    || release.retrievalProfile.id !== release.retrievalProfileId
    || release.retrievalProfile.specSha256 !== release.retrievalProfileSpecSha256
    || retrievalProfile.embeddingProfileId !== release.embeddingProfileId
    || retrievalProfile.embeddingProfileSpecSha256 !== release.embeddingProfileSpecSha256
    || retrievalProfile.embeddingDimension !== release.embeddingDimension
    || release.retrievalProfile.embeddingProfileId !== release.embeddingProfileId
    || release.retrievalProfile.embeddingProfileSpecSha256 !== release.embeddingProfileSpecSha256
    || release.retrievalProfile.embeddingDimension !== release.embeddingDimension
  ) {
    throw integrityError("Published release embedding profile pin is inconsistent");
  }

  const manifestProfile = jsonObject(jsonObject(release.manifest, "manifest").profile, "manifest.profile");
  const manifestEmbedding = jsonObject(manifestProfile.embedding, "manifest.profile.embedding");
  if (
    manifestEmbedding.id !== profile.spec.id
    || manifestEmbedding.specSha256 !== profile.specSha256
  ) {
    throw integrityError("Release manifest embedding profile pin is inconsistent");
  }
  const manifestRetrieval = jsonObject(manifestProfile.retrieval, "manifest.profile.retrieval");
  if (
    manifestRetrieval.id !== retrievalProfile.spec.id
    || manifestRetrieval.specSha256 !== retrievalProfile.specSha256
  ) {
    throw integrityError("Release manifest retrieval profile pin is inconsistent");
  }
  const manifestSegmenter = jsonObject(manifestProfile.segmenter, "manifest.profile.segmenter");
  if (
    manifestSegmenter.id !== segmenterIdentity.implementationId
    || manifestSegmenter.version !== segmenterIdentity.version
    || manifestSegmenter.dictionaryChecksum !== segmenterIdentity.dictionarySha256
    || manifestSegmenter.stopwordsChecksum !== segmenterIdentity.stopwordsSha256
  ) {
    throw integrityError("Release manifest segmenter pin does not match the query segmenter");
  }
  if (
    retrievalProfile.spec.segmenter.implementationId !== segmenterIdentity.implementationId
    || retrievalProfile.spec.segmenter.version !== segmenterIdentity.version
    || retrievalProfile.spec.segmenter.artifactSha256 !== segmenterIdentity.artifactSha256
    || retrievalProfile.spec.segmenter.algorithm !== segmenterIdentity.algorithm
    || retrievalProfile.spec.segmenter.hmm !== segmenterIdentity.hmm
    || retrievalProfile.spec.segmenter.dictionarySha256 !== segmenterIdentity.dictionarySha256
    || retrievalProfile.spec.segmenter.stopwordsSha256 !== segmenterIdentity.stopwordsSha256
  ) {
    throw integrityError("Pinned retrieval profile does not match the query segmenter");
  }
  return {
    embeddingProfile: profile,
    retrievalProfile,
    policy: knowledgeRetrievalPolicyFromProfile(retrievalProfile),
  };
}

function jsonObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw integrityError(`${name} is missing or invalid`);
  }
  return value as Record<string, unknown>;
}

function integrityError(detail: string): KnowledgeRetrievalError {
  return new KnowledgeRetrievalError("KNOWLEDGE_RETRIEVAL_INTEGRITY_ERROR", detail);
}
