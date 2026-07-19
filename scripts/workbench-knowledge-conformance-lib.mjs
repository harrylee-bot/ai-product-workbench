import {
  embeddingConformanceInputs,
  evaluateEmbeddingConformance,
  evaluateRerankerConformance,
  parseEmbeddingConformanceProbeV1,
  parseEmbeddingProfileV1,
  parseRerankerConformanceProbeV1,
  parseRetrievalProfileV1,
} from "@workbench/workbench-knowledge";

export function prepareKnowledgeConformance(input) {
  const embeddingProfile = parseEmbeddingProfileV1(input.embeddingRow.spec);
  const retrievalProfile = parseRetrievalProfileV1(input.retrievalRow.spec);
  assertProfileRows(
    input.embeddingRow,
    input.retrievalRow,
    embeddingProfile,
    retrievalProfile,
    input.expected,
  );
  if (input.embeddingRow.status === "retired" || input.retrievalRow.status === "retired") {
    throw new Error("KNOWLEDGE_CONFORMANCE_PROFILE_RETIRED");
  }
  return Object.freeze({
    embeddingProfile,
    retrievalProfile,
    embeddingProbe: parseEmbeddingConformanceProbeV1(
      input.embeddingProbeJson,
      embeddingProfile,
    ),
    rerankerProbe: parseRerankerConformanceProbeV1(
      input.rerankerProbeJson,
      retrievalProfile,
    ),
    embeddingStatus: input.embeddingRow.status,
    retrievalStatus: input.retrievalRow.status,
  });
}

export async function runKnowledgeConformance(input) {
  const now = input.now ?? (() => performance.now());
  const {
    embeddingProfile,
    retrievalProfile,
    embeddingProbe,
    rerankerProbe,
  } = input.prepared;

  const startedEmbeddingAt = now();
  await input.embedding.assertProfile(embeddingProfile);
  const embeddingResult = await input.embedding.embedDocuments(
    embeddingProfile,
    embeddingConformanceInputs(embeddingProbe, embeddingProfile).map((text, index) => ({
      chunkId: embeddingProbe.inputs[index].id,
      text,
    })),
  );
  const embeddingLatencyMs = now() - startedEmbeddingAt;
  const embeddingReport = evaluateEmbeddingConformance(embeddingProbe, embeddingResult);

  const rerankerResults = [];
  const rerankerLatenciesMs = [];
  for (const probeCase of rerankerProbe.cases) {
    const startedAt = now();
    const scores = await input.reranker.rerank({
      query: probeCase.query,
      candidates: probeCase.candidates.map((candidate) => ({
        chunkId: candidate.id,
        content: candidate.text,
      })),
    });
    rerankerLatenciesMs.push(now() - startedAt);
    rerankerResults.push({
      caseId: probeCase.id,
      scores: scores.map((score) => ({
        candidateId: score.chunkId,
        score: score.score,
      })),
    });
  }
  const rerankerReport = evaluateRerankerConformance(rerankerProbe, rerankerResults);

  return Object.freeze({
    ok: embeddingReport.passed && rerankerReport.passed,
    profiles: {
      embedding: {
        id: embeddingProfile.spec.id,
        specSha256: embeddingProfile.specSha256,
        status: input.prepared.embeddingStatus,
      },
      retrieval: {
        id: retrievalProfile.spec.id,
        specSha256: retrievalProfile.specSha256,
        status: input.prepared.retrievalStatus,
      },
    },
    latencyMs: {
      embedding: roundMilliseconds(embeddingLatencyMs),
      rerankerCases: rerankerLatenciesMs.map(roundMilliseconds),
    },
    embedding: embeddingReport,
    reranker: rerankerReport,
  });
}

function assertProfileRows(embeddingRow, retrievalRow, embedding, retrieval, expected) {
  if (
    embeddingRow.id !== expected.embeddingProfileId
    || retrievalRow.id !== expected.retrievalProfileId
    || embeddingRow.id !== embedding.spec.id
    || embeddingRow.specSha256 !== embedding.specSha256
    || embeddingRow.dimension !== embedding.dimension
    || retrievalRow.id !== retrieval.spec.id
    || retrievalRow.specSha256 !== retrieval.specSha256
    || retrievalRow.embeddingProfileId !== embedding.spec.id
    || retrievalRow.embeddingProfileSpecSha256 !== embedding.specSha256
    || retrievalRow.embeddingDimension !== embedding.dimension
    || retrieval.embeddingProfileId !== embedding.spec.id
    || retrieval.embeddingProfileSpecSha256 !== embedding.specSha256
    || retrieval.embeddingDimension !== embedding.dimension
  ) throw new Error("KNOWLEDGE_CONFORMANCE_PROFILE_IDENTITY_MISMATCH");
  if (
    expected.embeddingImageDigest !== embedding.spec.engine.imageDigest
    || expected.rerankerImageDigest !== retrieval.spec.reranker.engine.imageDigest
  ) throw new Error("KNOWLEDGE_CONFORMANCE_IMAGE_DIGEST_MISMATCH");
}

function roundMilliseconds(value) {
  return Math.round(value * 100) / 100;
}
