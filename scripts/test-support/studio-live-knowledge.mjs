import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

// Copies explicitly supplied published source chunks into a new local test database.
// Embeddings, reranking, retrieval and model inference remain real; production is read-only.
export async function startLiveKnowledgeFixture({ serviceRoot, publishedPath } = {}) {
  const privatePath = process.env.V2_INFERENCE_ENV_FILE;
  assert.ok(privatePath, "V2_INFERENCE_ENV_FILE is required");
  const env = Object.fromEntries((await readFile(privatePath, "utf8")).trim().split("\n").map((line) => {
    const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)];
  }));
  const metadata = JSON.parse(await readFile(env.V2_INFERENCE_METADATA_PATH, "utf8"));
  const knowledge = await import("@workbench/workbench-knowledge");
  const { canonicalSha256, parseEmbeddingProfileV1, parseRetrievalProfileV1, parseEmbeddingConformanceProbeV1,
    parseRerankerConformanceProbeV1, evaluateEmbeddingConformance, evaluateRerankerConformance } = knowledge;
  const { JiebaQuerySegmenterAdapter } = await import(pathToFileURL(path.join(serviceRoot, "apps/workbench-api/dist/modules/knowledge/jieba-query-segmenter.adapter.js")).href);
  const { documentEmbeddingInput, embeddingBatchInputSha256, embeddingBatchOutputSha256, embeddingVectorSha256, vectorLiteral } =
    await import(pathToFileURL(path.join(serviceRoot, "apps/workbench-file-worker/dist/knowledge/embedding-input.js")).href);
  const segmenter = new JiebaQuerySegmenterAdapter();
  const state = { realInference: true, embeddingQueries: 0, rerankQueries: 0, results: new Map(), releaseId: null, chunkIds: [] };
  async function request(kind, route, body) {
    const origin = kind === "embedding" ? env.V2_INFERENCE_EMBEDDING_URL : env.V2_INFERENCE_RERANKER_URL;
    assert.equal(new URL(origin).hostname, "127.0.0.1");
    const token = kind === "embedding" ? env.V2_INFERENCE_TOKEN : (env.V2_RERANKER_TOKEN ?? env.V2_INFERENCE_TOKEN);
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(origin + route, { method: body ? "POST" : "GET", signal: AbortSignal.timeout(35000),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (response.status !== 429 || attempt === 5) {
        assert.equal(response.status, 200, `Live ${kind} ${route} HTTP ${response.status}`);
        return response.json();
      }
      await response.body?.cancel();
      await delay(500 * 2 ** attempt);
    }
  }
  const embeddingMeta = metadata.embedding, rerankerMeta = metadata.reranker;
  const { parseTeiRuntimeInfo } = await import(pathToFileURL(path.join(serviceRoot, "apps/workbench-api/dist/modules/knowledge/tei-runtime-info.js")).href);
  for (const [kind, meta] of [["embedding", embeddingMeta], ["reranker", rerankerMeta]]) {
    const info = parseTeiRuntimeInfo(await request(kind, "/info"));
    assert.equal(info.model_id, meta.modelId); assert.equal(info.model_sha, meta.revision);
    assert.equal(info.version, meta.info.version);
    meta.info = { ...meta.info, auto_truncate: info.auto_truncate, max_concurrent_requests: info.max_concurrent_requests, max_batch_requests: info.max_batch_requests };
  }
  const embeddingId = "v2-live-bge-small-zh-7999e1d";
  const retrievalId = "v2-live-bge-reranker-2cfc18c";
  const probeInputs = [
    { id: "query", kind: "query", text: "产品工作台支持什么功能？" },
    { id: "relevant", kind: "document", text: "产品工作台可以生成需求文档和交互原型。" },
    { id: "unrelated", kind: "document", text: "大熊猫主要生活在中国四川的竹林里。" },
  ];
  const initialTokens = await request("embedding", "/tokenize", { inputs: probeInputs.map((x) => x.text), add_special_tokens: true });
  const initialVectors = await request("embedding", "/embed", { inputs: [probeInputs[0].text], normalize: true, truncate: false });
  const dimension = initialVectors[0].length;
  assert.ok(dimension > 3 && dimension <= 16000);
  const embeddingProbe = { schema: "workbench.embedding-conformance-probe.v1", profileId: embeddingId, dimension, normTolerance: 0.001,
    inputs: probeInputs.map((x, i) => ({ ...x, tokenCount: initialTokens[i].length })),
    cosineExpectations: [{ leftInputId: "query", rightInputId: "relevant", minimum: 0.4, maximum: 1 },
      { leftInputId: "query", rightInputId: "unrelated", minimum: -1, maximum: 0.65 }] };
  const embedding = parseEmbeddingProfileV1({ schema: "workbench.embedding-profile.v1", id: embeddingId, protocol: "tei.embed.v1",
    engine: { id: "huggingface/text-embeddings-inference", version: embeddingMeta.info.version, imageDigest: embeddingMeta.imageDigest },
    model: { id: embeddingMeta.modelId, revision: embeddingMeta.revision, artifactSha256: embeddingMeta.modelArtifactSha256 },
    tokenizer: { id: embeddingMeta.modelId, revision: embeddingMeta.revision, artifactSha256: embeddingMeta.tokenizerArtifactSha256,
      modelMaximumTokens: embeddingMeta.info.max_input_length, chunkMaximumTokens: 256, overflow: "reject" },
    input: { queryPrefix: "", documentPrefix: "", normalization: "utf8-nfc-lf-v1" },
    output: { dimension, dtype: "float32", pooling: "cls", normalization: "l2", distance: "cosine" },
    // The shared inference service has two concurrency permits; keep each test batch within that bound.
    batch: { maximumInputs: Math.min(2, embeddingMeta.info.max_client_batch_size, embeddingMeta.info.max_concurrent_requests), maximumTokens: embeddingMeta.info.max_batch_tokens },
    conformanceProbeSha256: canonicalSha256(embeddingProbe) });
  async function embedTexts(texts) {
    assert.ok(texts.length > 0);
    if (texts.length > embedding.spec.batch.maximumInputs) {
      const combined = { tokenCounts: [], vectors: [] };
      for (let at = 0; at < texts.length; at += embedding.spec.batch.maximumInputs) {
        const part = await embedTexts(texts.slice(at, at + embedding.spec.batch.maximumInputs));
        combined.tokenCounts.push(...part.tokenCounts); combined.vectors.push(...part.vectors);
      }
      return combined;
    }
    const tokenized = await request("embedding", "/tokenize", { inputs: texts, add_special_tokens: true });
    assert.equal(tokenized.length, texts.length);
    const tokenCounts = tokenized.map((tokens) => { assert.ok(Array.isArray(tokens)); assert.ok(tokens.every((t) => Number.isSafeInteger(t.id))); return tokens.length; });
    assert.ok(tokenCounts.every((n) => n > 0 && n <= embedding.spec.tokenizer.chunkMaximumTokens));
    assert.ok(tokenCounts.reduce((a, b) => a + b, 0) <= embedding.spec.batch.maximumTokens);
    const rawVectors = await request("embedding", "/embed", { inputs: texts, dimensions: dimension, normalize: true, truncate: false });
    assert.equal(rawVectors.length, texts.length);
    const vectors = rawVectors.map((vector) => { assert.equal(vector.length, dimension); assert.ok(vector.every(Number.isFinite));
      const normalized = vector.map(Math.fround); assert.ok(Math.abs(Math.hypot(...normalized) - 1) <= 0.001); return normalized; });
    state.embeddingQueries += 1;
    return { tokenCounts, vectors };
  }
  const embeddingReport = evaluateEmbeddingConformance(parseEmbeddingConformanceProbeV1(embeddingProbe, embedding), await embedTexts(probeInputs.map((x) => x.text)));
  assert.equal(embeddingReport.passed, true, "Real embedding conformance failed");
  const rerankerProbe = { schema: "workbench.reranker-conformance-probe.v1", retrievalProfileId: retrievalId, cases: [
    { id: "product-rules", query: "产品工作台支持什么功能？", candidates: [
      { id: "relevant", text: probeInputs[1].text, expectedRank: 1 },
      { id: "unrelated", text: probeInputs[2].text, expectedRank: 2 },
    ] },
  ] };
  const retrieval = parseRetrievalProfileV1({ schema: "workbench.retrieval-profile.v1", id: retrievalId,
    embedding: { profileId: embedding.spec.id, profileSpecSha256: embedding.specSha256, dimension },
    segmenter: { ...segmenter.identity, normalization: "utf8-nfc-lf-v1" },
    recall: { lexical: { algorithm: "plainto_tsquery-simple-ts_rank_cd-32-v1", limit: 40 }, dense: { distance: "cosine", limit: 40 }, fusion: { algorithm: "rrf", k: 60, tieBreak: "workbench-rrf-v1" } },
    reranker: { protocol: "tei.rerank.v1", engine: { id: "huggingface/text-embeddings-inference", version: rerankerMeta.info.version, imageDigest: rerankerMeta.imageDigest },
      model: { id: rerankerMeta.modelId, revision: rerankerMeta.revision, artifactSha256: rerankerMeta.modelArtifactSha256 },
      tokenizer: { id: rerankerMeta.modelId, revision: rerankerMeta.revision, artifactSha256: rerankerMeta.tokenizerArtifactSha256, maximumInputTokens: rerankerMeta.info.max_input_length, overflow: "reject" },
      candidateLimit: 20, finalResultLimit: 8, failurePolicy: "degrade_to_rrf", conformanceProbeSha256: canonicalSha256(rerankerProbe) },
    routingPolicy: "workbench-knowledge-route-v1", citationSchema: "workbench.knowledge-citation.v1" });
  const rerankerResults = [];
  for (const test of rerankerProbe.cases) {
    const scores = await request("reranker", "/rerank", { query: test.query, texts: test.candidates.map((x) => x.text), truncate: false, raw_scores: false, return_text: false });
    state.rerankQueries += 1;
    rerankerResults.push({ caseId: test.id, scores: scores.map((item) => ({ candidateId: test.candidates[item.index].id, score: item.score })) });
  }
  const rerankerReport = evaluateRerankerConformance(parseRerankerConformanceProbeV1(rerankerProbe, retrieval), rerankerResults);
  assert.equal(rerankerReport.passed, true, "Real reranker conformance failed");
  state.profiles = { embeddingId, embeddingSpecSha256: embedding.specSha256, retrievalId, retrievalSpecSha256: retrieval.specSha256, dimension };
  state.conformance = { embedding: embeddingReport.passed, reranker: rerankerReport.passed };
  const reports = { schema: "workbench.v2-live-knowledge-evidence.v1", metadata, embedding: embedding.spec, retrieval: retrieval.spec, embeddingProbe, embeddingReport, rerankerProbe, rerankerReport };
  if (process.env.V2_INFERENCE_REPORT_PATH) await writeFile(process.env.V2_INFERENCE_REPORT_PATH, JSON.stringify(reports, null, 2));
  const environment = {
    WORKBENCH_KNOWLEDGE_TOOL_SECRET: randomBytes(32).toString("base64url"), WORKBENCH_KNOWLEDGE_TOOL_MAX_TTL_SECONDS: "3600",
    WORKBENCH_KNOWLEDGE_EMBEDDING_PROFILE_ID: embedding.spec.id, WORKBENCH_KNOWLEDGE_EMBEDDING_PROFILE_SPEC_SHA256: embedding.specSha256,
    WORKBENCH_TEI_URL: env.V2_INFERENCE_EMBEDDING_URL, WORKBENCH_TEI_API_KEY: env.V2_INFERENCE_TOKEN, WORKBENCH_TEI_IMAGE_DIGEST: embedding.spec.engine.imageDigest,
    WORKBENCH_KNOWLEDGE_RERANKER_URL: env.V2_INFERENCE_RERANKER_URL, WORKBENCH_KNOWLEDGE_RERANKER_API_KEY: env.V2_RERANKER_TOKEN ?? env.V2_INFERENCE_TOKEN,
    WORKBENCH_KNOWLEDGE_RERANKER_IMAGE_DIGEST: retrieval.spec.reranker.engine.imageDigest,
    WORKBENCH_KNOWLEDGE_RERANKER_MODEL_ID: retrieval.spec.reranker.model.id, WORKBENCH_KNOWLEDGE_RERANKER_MODEL_REVISION: retrieval.spec.reranker.model.revision,
    WORKBENCH_KNOWLEDGE_RERANKER_TEI_VERSION: retrieval.spec.reranker.engine.version, WORKBENCH_KNOWLEDGE_RERANKER_MAX_INPUT_TOKENS: String(retrieval.spec.reranker.tokenizer.maximumInputTokens),
  };
  return { state, environment, reports,
    async seed(databaseUrl) {
      const dbUrl = new URL(databaseUrl);
      assert.equal(dbUrl.hostname, "127.0.0.1", "Live fixture accepts only local isolated DB");
      assert.match(dbUrl.pathname, /(?:^|[_/-])test(?:$|[_-])/iu);
      const published = JSON.parse(await readFile(publishedPath, "utf8"));
      assert.ok(published.release?.id && published.chunks?.length, "Published knowledge source required");
      const sources = published.chunks.flatMap((source) => {
        assert.ok(source.content && source.source_path && source.document_id && source.chunk_id);
        const characters = Array.from(source.content);
        return Array.from({ length: Math.ceil(characters.length / 200) }, (_, at) => ({
          ...source, content: characters.slice(at * 200, (at + 1) * 200).join(""), part: at,
        }));
      });
      const contents = sources.map(source => source.content);
      state.source = { kind: "published-knowledge-copy", release: published.release, sourceChunks: published.chunks.length, indexedChunks: contents.length };

      const texts = contents.map((content) => documentEmbeddingInput(embedding, content));
      const result = await embedTexts(texts);
      const { PrismaClient, Prisma } = await import("@workbench/workbench-db");
      const db = new PrismaClient({ datasourceUrl: databaseUrl });
      try {
        await db.$transaction(async (tx) => {
          const [{ name }] = await tx.$queryRaw`SELECT current_database() AS name`;
          assert.match(name, /(?:^|[_-])test(?:$|[_-])/iu);
          assert.equal(await tx.knowledgeRelease.count(), 0);
          const owner = await tx.principal.create({ data: { issuer: "isolated-live-inference", subject: randomUUID() } });
          await tx.knowledgeProfileOperatorEvent.create({ data: { principalId: owner.id, action: "grant", authorizedBy: "isolated-v2-test", changeReference: "real-inference-conformance" } });
          await tx.embeddingProfile.create({ data: { id: embedding.spec.id, spec: embedding.spec, specSha256: embedding.specSha256, dimension } });
          for (const status of ["poc", "adopted"]) await tx.embeddingProfile.update({ where: { id: embedding.spec.id }, data: { status } });
          await tx.knowledgeProfileAdoptionReceipt.create({ data: { profileKind: "embedding", embeddingProfileId: embedding.spec.id, embeddingProfileSpecSha256: embedding.specSha256, actorPrincipalId: owner.id } });
          await tx.retrievalProfile.create({ data: { id: retrieval.spec.id, spec: retrieval.spec, specSha256: retrieval.specSha256, embeddingProfileId: embedding.spec.id, embeddingProfileSpecSha256: embedding.specSha256, embeddingDimension: dimension } });
          for (const status of ["poc", "adopted"]) await tx.retrievalProfile.update({ where: { id: retrieval.spec.id }, data: { status } });
          await tx.knowledgeProfileAdoptionReceipt.create({ data: { profileKind: "retrieval", retrievalProfileId: retrieval.spec.id, retrievalProfileSpecSha256: retrieval.specSha256, actorPrincipalId: owner.id } });
          const manifest = { schema: "workbench.knowledge-release.v1", releaseKey: "isolated-v2-live-baseline", profile: {
            embedding: { id: embedding.spec.id, specSha256: embedding.specSha256 }, retrieval: { id: retrieval.spec.id, specSha256: retrieval.specSha256 },
            segmenter: { id: segmenter.identity.implementationId, version: segmenter.identity.version, dictionaryChecksum: segmenter.identity.dictionarySha256, stopwordsChecksum: segmenter.identity.stopwordsSha256 },
          } };
          const release = await tx.knowledgeRelease.create({ data: { key: "isolated-v2-live-baseline", version: 1,
            embeddingProfileId: embedding.spec.id, embeddingProfileSpecSha256: embedding.specSha256, embeddingDimension: dimension,
            retrievalProfileId: retrieval.spec.id, retrievalProfileSpecSha256: retrieval.specSha256, manifest, manifestSha256: canonicalSha256(manifest) } });
          state.releaseId = release.id;
          const documents = new Map();
          for (const [index, content] of contents.entries()) {
            const source = sources[index];
            let entry = documents.get(source.source_path);
            if (!entry) {
              const originalChunks = published.chunks.filter(item => item.source_path === source.source_path);
              const document = await tx.knowledgeDocument.create({ data: { releaseId: release.id, sourceKind: "vault_markdown", sourcePath: source.source_path,
                title: source.title, checksum: digest(originalChunks.map(item => item.content).join("\n")), route: "production",
                metadata: { sourceLocator: `vault://${source.source_path}`, copiedFromPublishedRelease: published.release, originalDocumentId: source.document_id, originalChunkIds: originalChunks.map(item => item.chunk_id) } } });
              entry = { id: document.id, sequence: 0 }; documents.set(source.source_path, entry);
            }
            const chunk = await tx.knowledgeChunk.create({ data: { releaseId: release.id, documentId: entry.id, sequence: entry.sequence++, headingPath: [source.title], content, tokenCount: result.tokenCounts[index] } });
            state.chunkIds.push(chunk.id);
            await tx.$executeRaw(Prisma.sql`UPDATE knowledge_chunks SET search_vector = to_tsvector('simple', ${segmenter.segment(content).join(" ")}) WHERE id = ${chunk.id}`);
          }
          const size = embedding.spec.batch.maximumInputs;
          for (let offset = 0; offset < state.chunkIds.length; offset += size) {
            const ids = state.chunkIds.slice(offset, offset + size);
            const inputs = ids.map((chunkId, index) => ({ chunkId, text: texts[offset + index] }));
            const batch = await tx.knowledgeEmbeddingBatch.create({ data: { id: randomUUID(), releaseId: release.id, profileId: embedding.spec.id, profileSpecSha256: embedding.specSha256,
              dimension, sequence: offset / size, chunkIds: ids, inputCount: inputs.length, inputSha256: embeddingBatchInputSha256(embedding, inputs) } });
            await tx.knowledgeEmbeddingBatch.update({ where: { id: batch.id }, data: { status: "running", attemptCount: 1, leaseToken: randomUUID(), queueJobId: randomUUID(), queueRetryCount: 0, startedAt: new Date() } });
            const rows = ids.map((chunkId, index) => ({ chunkId, tokenCount: result.tokenCounts[offset + index], embeddingSha256: embeddingVectorSha256(result.vectors[offset + index]) }));
            for (const [index, row] of rows.entries()) await tx.$executeRaw(Prisma.sql`INSERT INTO knowledge_chunk_embeddings (chunk_id, release_id, profile_id, profile_spec_sha256, dimension, embedding, embedding_sha256) VALUES (${row.chunkId}, ${release.id}, ${embedding.spec.id}, ${embedding.specSha256}, ${dimension}, ${vectorLiteral(result.vectors[offset + index])}::public.vector, ${row.embeddingSha256})`);
            await tx.knowledgeEmbeddingBatch.update({ where: { id: batch.id }, data: { status: "ready", leaseToken: null, tokenCount: rows.reduce((sum, row) => sum + row.tokenCount, 0), outputSha256: embeddingBatchOutputSha256(embedding, rows), finishedAt: new Date() } });
          }
          await tx.knowledgeRelease.update({ where: { id: release.id }, data: { status: "ready", chunksReadyAt: new Date(), readyAt: new Date() } });
        }, { timeout: 30000 });
      } finally { await db.$disconnect(); }
    },
    async close() { /* Parent owns and cleans up the relay lifecycle after browser acceptance. */ },
  };
}
function digest(value) { return createHash("sha256").update(value).digest("hex"); }
