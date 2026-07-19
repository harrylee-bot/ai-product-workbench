import assert from "node:assert/strict";
import test from "node:test";

import { canonicalSha256 } from "@workbench/workbench-knowledge";

import {
  assertKnowledgeReleaseProfiles,
  buildKnowledgeReleaseSeed,
  createOrQueueKnowledgeRelease,
  readKnowledgeReleaseOptions,
} from "./workbench-knowledge-release-lib.mjs";

const embedding = {
  id: "embedding-r1",
  status: "adopted",
  dimension: 3,
  specSha256: "",
  spec: {
    schema: "workbench.embedding-profile.v1",
    id: "embedding-r1",
    protocol: "openai.embeddings.v1",
    engine: { id: "gateway", version: "1.0.0" },
    model: { id: "model", revision: "revision-1", artifactSha256: "a".repeat(64) },
    tokenizer: {
      id: "tokenizer",
      revision: "revision-1",
      artifactSha256: "b".repeat(64),
      modelMaximumTokens: 128,
      chunkMaximumTokens: 64,
      overflow: "reject",
    },
    input: { queryPrefix: "", documentPrefix: "", normalization: "utf8-nfc-lf-v1" },
    output: { dimension: 3, dtype: "float32", pooling: "cls", normalization: "l2", distance: "cosine" },
    batch: { maximumInputs: 2, maximumTokens: 128 },
    conformanceProbeSha256: "c".repeat(64),
  },
};

const retrieval = {
  id: "retrieval-r1",
  status: "adopted",
  specSha256: "",
  embeddingProfileId: embedding.id,
  embeddingProfileSpecSha256: "",
  embeddingDimension: embedding.dimension,
  spec: {
    schema: "workbench.retrieval-profile.v1",
    id: "retrieval-r1",
    embedding: { profileId: embedding.id, profileSpecSha256: "", dimension: 3 },
    segmenter: {
      implementationId: "jieba",
      version: "2.4.0",
      artifactSha256: "d".repeat(64),
      algorithm: "cut_for_search",
      hmm: false,
      dictionarySha256: "d".repeat(64),
      stopwordsSha256: "e".repeat(64),
      normalization: "utf8-nfc-lf-v1",
    },
    recall: {
      lexical: { algorithm: "plainto_tsquery-simple-ts_rank_cd-32-v1", limit: 4 },
      dense: { distance: "cosine", limit: 4 },
      fusion: { algorithm: "rrf", k: 60, tieBreak: "workbench-rrf-v1" },
    },
    reranker: {
      protocol: "tei.rerank.v1",
      engine: { id: "reranker", version: "1.0.0", imageDigest: `sha256:${"f".repeat(64)}` },
      model: { id: "reranker-model", revision: "revision-1", artifactSha256: "1".repeat(64) },
      tokenizer: {
        id: "reranker-tokenizer",
        revision: "revision-1",
        artifactSha256: "2".repeat(64),
        maximumInputTokens: 128,
        overflow: "reject",
      },
      candidateLimit: 8,
      finalResultLimit: 4,
      failurePolicy: "degrade_to_rrf",
      conformanceProbeSha256: "3".repeat(64),
    },
    routingPolicy: "workbench-knowledge-route-v1",
    citationSchema: "workbench.knowledge-citation.v1",
  },
};

// Keep the fixture subject to the same immutable identity checks as production rows.
embedding.specSha256 = canonicalSha256(embedding.spec);
retrieval.spec.embedding.profileSpecSha256 = embedding.specSha256;
retrieval.embeddingProfileSpecSha256 = embedding.specSha256;
retrieval.specSha256 = canonicalSha256(retrieval.spec);

test("parses immutable release options and rejects unknown flags", () => {
  assert.deepEqual(
    readKnowledgeReleaseOptions({
      WORKBENCH_KNOWLEDGE_RELEASE_KEY: "production",
      WORKBENCH_KNOWLEDGE_RELEASE_VERSION: "4",
      WORKBENCH_KNOWLEDGE_EMBEDDING_PROFILE_ID: "embedding-r1",
      WORKBENCH_KNOWLEDGE_RETRIEVAL_PROFILE_ID: "retrieval-r1",
    }),
    {
      key: "production",
      version: 4,
      workspaceId: null,
      embeddingProfileId: "embedding-r1",
      retrievalProfileId: "retrieval-r1",
    },
  );
  assert.throws(() => readKnowledgeReleaseOptions({}, ["--nope=x"]), /Unknown argument/);
  assert.throws(
    () => readKnowledgeReleaseOptions({}, [
      "--key=production",
      "--key=other",
      "--version=1",
      "--embedding-profile=embedding-r1",
      "--retrieval-profile=retrieval-r1",
    ]),
    /Duplicate argument: --key/,
  );
});

test("pins adopted profile identities into the building release seed", () => {
  const crypto = assertKnowledgeReleaseProfiles({ embedding, retrieval });
  const seed = buildKnowledgeReleaseSeed({
    key: "production",
    version: 4,
    workspaceId: null,
  }, crypto);
  assert.equal(seed.status, "building");
  assert.match(seed.manifestSha256, /^[0-9a-f]{64}$/u);
  assert.equal(seed.manifest.profile.embedding.dimension, 3);
  assert.equal(seed.manifest.profile.retrieval.id, "retrieval-r1");
});

test("rejects a non-adopted profile before a release can be created", () => {
  assert.throws(
    () => assertKnowledgeReleaseProfiles({ embedding: { ...embedding, status: "candidate" }, retrieval }),
    /NOT_ADOPTED/,
  );
});

test("serializes the natural release identity and creates the row and job in one transaction", async () => {
  const harness = commandHarness();
  const result = await createOrQueueKnowledgeRelease(harness.command);

  assert.equal(result.created, true);
  assert.equal(result.queued, true);
  assert.equal(result.queueDisposition, "created");
  assert.equal(result.jobId, "job_1");
  assert.equal(result.release.id, "release_new");
  assert.equal(harness.committed(), true);
  assert.deepEqual(harness.transactionOptions(), { maxWait: 10_000, timeout: 30_000 });
  assert.equal(harness.events[0], "lock:production:4");
  assert.ok(harness.events.indexOf("create-release") < harness.events.indexOf("enqueue:release_new"));
});

test("treats an exclusive singleton collision as an already queued idempotent replay", async () => {
  const harness = commandHarness({ existing: releaseFixture("building"), jobId: null });
  const result = await createOrQueueKnowledgeRelease(harness.command);

  assert.equal(result.created, false);
  assert.equal(result.queued, true);
  assert.equal(result.queueDisposition, "already-queued");
  assert.equal(result.jobId, null);
  assert.equal(harness.events.includes("create-release"), false);
});

test("replays a published release without requiring its immutable profiles to remain adopted", async () => {
  const harness = commandHarness({ existing: releaseFixture("retired"), profilesUnavailable: true });
  const result = await createOrQueueKnowledgeRelease(harness.command);

  assert.equal(result.created, false);
  assert.equal(result.queued, false);
  assert.equal(result.queueDisposition, "not-required");
  assert.equal(harness.events.some((event) => event.startsWith("find-profile:")), false);
  assert.equal(harness.events.some((event) => event.startsWith("enqueue:")), false);
});

test("rejects identity conflicts and rolls back when the atomic enqueue fails", async () => {
  const conflict = commandHarness({
    existing: releaseFixture("building", { retrievalProfileId: "retrieval-other" }),
  });
  await assert.rejects(
    createOrQueueKnowledgeRelease(conflict.command),
    /KNOWLEDGE_RELEASE_IDENTITY_CONFLICT/,
  );
  assert.equal(conflict.committed(), false);
  assert.equal(conflict.events.some((event) => event.startsWith("find-profile:")), false);

  const enqueueFailure = commandHarness({ enqueueError: new Error("queue unavailable") });
  await assert.rejects(createOrQueueKnowledgeRelease(enqueueFailure.command), /queue unavailable/);
  assert.equal(enqueueFailure.committed(), false);
});

function commandHarness({
  existing = null,
  jobId = "job_1",
  profilesUnavailable = false,
  enqueueError = null,
} = {}) {
  const events = [];
  let transactionCommitted = false;
  let capturedTransactionOptions = null;
  const tx = {
    knowledgeRelease: {
      async findUnique() {
        events.push("find-release");
        return existing;
      },
      async create({ data }) {
        events.push("create-release");
        return { id: "release_new", ...data };
      },
    },
    embeddingProfile: {
      async findUnique() {
        events.push("find-profile:embedding");
        if (profilesUnavailable) throw new Error("profile lookup must not run");
        return embedding;
      },
    },
    retrievalProfile: {
      async findUnique() {
        events.push("find-profile:retrieval");
        if (profilesUnavailable) throw new Error("profile lookup must not run");
        return retrieval;
      },
    },
  };
  const options = {
    key: "production",
    version: 4,
    workspaceId: null,
    embeddingProfileId: embedding.id,
    retrievalProfileId: retrieval.id,
  };
  return {
    events,
    committed: () => transactionCommitted,
    transactionOptions: () => capturedTransactionOptions,
    command: {
      options,
      db: {
        async $transaction(callback, transactionOptions) {
          capturedTransactionOptions = transactionOptions;
          const result = await callback(tx);
          transactionCommitted = true;
          return result;
        },
      },
      async lockIdentity(_tx, identity) {
        events.push(`lock:${identity.key}:${identity.version}`);
      },
      async enqueue(_tx, job, singletonKey) {
        events.push(`enqueue:${singletonKey}`);
        assert.deepEqual(job, { releaseId: singletonKey });
        if (enqueueError) throw enqueueError;
        return jobId;
      },
    },
  };
}

function releaseFixture(status, overrides = {}) {
  return {
    id: "release_existing",
    key: "production",
    workspaceId: null,
    version: 4,
    status,
    embeddingProfileId: embedding.id,
    embeddingProfileSpecSha256: embedding.specSha256,
    embeddingDimension: embedding.dimension,
    retrievalProfileId: retrieval.id,
    retrievalProfileSpecSha256: retrieval.specSha256,
    ...overrides,
  };
}
