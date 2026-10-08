import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import http from "node:http";

// Deliberately synthetic providers for the isolated HTTP test. These identities
// and vectors must never be used by production bootstrap or deployment scripts.
export async function startControlledKnowledgeFixture() {
  const { canonicalSha256, parseEmbeddingProfileV1, parseRetrievalProfileV1 } = await import("@workbench/workbench-knowledge");
  const { JiebaQuerySegmenterAdapter } = await import("../apps/workbench-api/dist/modules/knowledge/jieba-query-segmenter.adapter.js");
  const segmenter = new JiebaQuerySegmenterAdapter();
  const embedding = parseEmbeddingProfileV1({
    schema: "workbench.embedding-profile.v1", id: "controlled-http-embedding", protocol: "tei.embed.v1",
    engine: { id: "huggingface/text-embeddings-inference", version: "1.8.3", imageDigest: `sha256:${"1".repeat(64)}` },
    model: { id: "controlled-http/model", revision: "controlled-r1", artifactSha256: "2".repeat(64) },
    tokenizer: { id: "controlled-http/tokenizer", revision: "controlled-r1", artifactSha256: "3".repeat(64), modelMaximumTokens: 512, chunkMaximumTokens: 256, overflow: "reject" },
    input: { queryPrefix: "", documentPrefix: "", normalization: "utf8-nfc-lf-v1" },
    output: { dimension: 3, dtype: "float32", pooling: "cls", normalization: "l2", distance: "cosine" },
    batch: { maximumInputs: 32, maximumTokens: 8192 }, conformanceProbeSha256: "4".repeat(64),
  });
  const retrieval = parseRetrievalProfileV1({
    schema: "workbench.retrieval-profile.v1", id: "controlled-http-retrieval",
    embedding: { profileId: embedding.spec.id, profileSpecSha256: embedding.specSha256, dimension: 3 },
    segmenter: { ...segmenter.identity, normalization: "utf8-nfc-lf-v1" },
    recall: { lexical: { algorithm: "plainto_tsquery-simple-ts_rank_cd-32-v1", limit: 40 }, dense: { distance: "cosine", limit: 40 }, fusion: { algorithm: "rrf", k: 60, tieBreak: "workbench-rrf-v1" } },
    reranker: {
      protocol: "tei.rerank.v1", engine: { id: "huggingface/text-embeddings-inference", version: "1.8.3", imageDigest: `sha256:${"7".repeat(64)}` },
      model: { id: "controlled-http/reranker", revision: "controlled-r1", artifactSha256: "8".repeat(64) },
      tokenizer: { id: "controlled-http/reranker-tokenizer", revision: "controlled-r1", artifactSha256: "9".repeat(64), maximumInputTokens: 512, overflow: "reject" },
      candidateLimit: 24, finalResultLimit: 10, failurePolicy: "degrade_to_rrf", conformanceProbeSha256: "a".repeat(64),
    },
    routingPolicy: "workbench-knowledge-route-v1", citationSchema: "workbench.knowledge-citation.v1",
  });
  const state = { embeddingQueries: 0, rerankQueries: 0, results: new Map(), releaseId: null, chunkIds: [] };
  const provider = async (kind) => {
    const server = http.createServer((request, response) => {
      void (async () => {
        let value;
        if (request.method === "GET" && request.url === "/info") {
          value = { model_id: kind === "embedding" ? embedding.spec.model.id : retrieval.spec.reranker.model.id,
            model_sha: "controlled-r1", version: "1.8.3", max_input_length: 512,
            max_batch_tokens: 8192, max_client_batch_size: 32, auto_truncate: false };
        } else {
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          assert.equal(request.method, "POST");
          if (kind === "embedding" && request.url === "/tokenize") {
            assert.deepEqual(body, { inputs: ["产品工作台"], add_special_tokens: true });
            value = [[{ id: 1 }, { id: 2 }]];
          } else if (kind === "embedding" && request.url === "/embed") {
            assert.deepEqual(body, { inputs: ["产品工作台"], dimensions: 3, normalize: true, truncate: false });
            state.embeddingQueries += 1;
            value = [[1, 0, 0]];
          } else if (kind === "reranker" && request.url === "/rerank") {
            assert.equal(body.query, "产品工作台");
            assert.equal(body.truncate, false);
            assert.equal(body.texts.length, 2);
            state.rerankQueries += 1;
            value = body.texts.map((_, index) => ({ index, score: 1 - index / 10 }));
          } else throw new Error("Unexpected controlled knowledge request");
        }
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
      })().catch(() => response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "controlled knowledge fixture rejected request" })));
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    return { server, origin: `http://127.0.0.1:${server.address().port}` };
  };
  const embeddingProvider = await provider("embedding");
  const rerankerProvider = await provider("reranker");
  return {
    state,
    environment: {
      WORKBENCH_KNOWLEDGE_TOOL_SECRET: Buffer.alloc(32, 53).toString("base64url"),
      WORKBENCH_KNOWLEDGE_TOOL_MAX_TTL_SECONDS: "3600",
      WORKBENCH_KNOWLEDGE_EMBEDDING_PROFILE_ID: embedding.spec.id,
      WORKBENCH_KNOWLEDGE_EMBEDDING_PROFILE_SPEC_SHA256: embedding.specSha256,
      WORKBENCH_TEI_URL: embeddingProvider.origin,
      WORKBENCH_TEI_IMAGE_DIGEST: embedding.spec.engine.imageDigest,
      WORKBENCH_KNOWLEDGE_RERANKER_URL: rerankerProvider.origin,
      WORKBENCH_KNOWLEDGE_RERANKER_IMAGE_DIGEST: retrieval.spec.reranker.engine.imageDigest,
      WORKBENCH_KNOWLEDGE_RERANKER_MODEL_ID: retrieval.spec.reranker.model.id,
      WORKBENCH_KNOWLEDGE_RERANKER_MODEL_REVISION: retrieval.spec.reranker.model.revision,
      WORKBENCH_KNOWLEDGE_RERANKER_TEI_VERSION: retrieval.spec.reranker.engine.version,
      WORKBENCH_KNOWLEDGE_RERANKER_MAX_INPUT_TOKENS: "512",
    },
    async seed(databaseUrl) {
      assert.match(new URL(databaseUrl).pathname, /(?:^|[_/-])test(?:$|[_-])/iu, "Controlled fixtures require a test database");
      const { PrismaClient, Prisma } = await import("@workbench/workbench-db");
      const db = new PrismaClient({ datasourceUrl: databaseUrl });
      try {
        await db.$transaction(async (tx) => {
          const [{ name }] = await tx.$queryRaw`SELECT current_database() AS name`;
          assert.match(name, /(?:^|[_-])test(?:$|[_-])/iu);
          assert.equal(await tx.knowledgeRelease.count(), 0, "HTTP suite must start with an empty knowledge database");
          const owner = await tx.principal.create({ data: { issuer: "controlled-http-fixture", subject: randomUUID() } });
          await tx.knowledgeProfileOperatorEvent.create({ data: { principalId: owner.id, action: "grant", authorizedBy: "controlled-http-test", changeReference: "controlled-http-fixture" } });
          await tx.embeddingProfile.create({ data: { id: embedding.spec.id, spec: embedding.spec, specSha256: embedding.specSha256, dimension: 3 } });
          for (const status of ["poc", "adopted"]) await tx.embeddingProfile.update({ where: { id: embedding.spec.id }, data: { status } });
          await tx.knowledgeProfileAdoptionReceipt.create({ data: { profileKind: "embedding", embeddingProfileId: embedding.spec.id, embeddingProfileSpecSha256: embedding.specSha256, actorPrincipalId: owner.id } });
          await tx.retrievalProfile.create({ data: { id: retrieval.spec.id, spec: retrieval.spec, specSha256: retrieval.specSha256, embeddingProfileId: embedding.spec.id, embeddingProfileSpecSha256: embedding.specSha256, embeddingDimension: 3 } });
          for (const status of ["poc", "adopted"]) await tx.retrievalProfile.update({ where: { id: retrieval.spec.id }, data: { status } });
          await tx.knowledgeProfileAdoptionReceipt.create({ data: { profileKind: "retrieval", retrievalProfileId: retrieval.spec.id, retrievalProfileSpecSha256: retrieval.specSha256, actorPrincipalId: owner.id } });
          const manifest = { schema: "workbench.knowledge-release.v1", releaseKey: "controlled-http-baseline", profile: {
            embedding: { id: embedding.spec.id, specSha256: embedding.specSha256 }, retrieval: { id: retrieval.spec.id, specSha256: retrieval.specSha256 },
            segmenter: { id: segmenter.identity.implementationId, version: segmenter.identity.version, dictionaryChecksum: segmenter.identity.dictionarySha256, stopwordsChecksum: segmenter.identity.stopwordsSha256 },
          } };
          const release = await tx.knowledgeRelease.create({ data: { key: "controlled-http-baseline", version: 1,
            embeddingProfileId: embedding.spec.id, embeddingProfileSpecSha256: embedding.specSha256, embeddingDimension: 3,
            retrievalProfileId: retrieval.spec.id, retrievalProfileSpecSha256: retrieval.specSha256, manifest, manifestSha256: canonicalSha256(manifest),
          } });
          state.releaseId = release.id;
          const contents = ["产品 工作台 必须基于知识库生成需求文档和原型。", "设计规范要求原型可以分享在线预览，需求文档可以在线预览和下载。"];
          for (const [index, content] of contents.entries()) {
            const document = await tx.knowledgeDocument.create({ data: { releaseId: release.id, sourceKind: "vault_markdown", sourcePath: `00-rules/controlled-http-${index}.md`, title: `受控知识测试${index + 1}`, checksum: digest(content), route: "production", metadata: { sourceLocator: `vault://controlled-http/${index}.md` } } });
            const chunk = await tx.knowledgeChunk.create({ data: { releaseId: release.id, documentId: document.id, sequence: 0, headingPath: ["受控测试规则"], content, tokenCount: segmenter.segment(content).length } });
            state.chunkIds.push(chunk.id);
            await tx.$executeRaw(Prisma.sql`UPDATE knowledge_chunks SET search_vector = to_tsvector('simple', ${segmenter.segment(content).join(" ")}) WHERE id = ${chunk.id}`);
          }
          const batch = await tx.knowledgeEmbeddingBatch.create({ data: { id: randomUUID(), releaseId: release.id, profileId: embedding.spec.id, profileSpecSha256: embedding.specSha256, dimension: 3, sequence: 0, chunkIds: state.chunkIds, inputCount: 2, inputSha256: canonicalSha256(contents) } });
          await tx.knowledgeEmbeddingBatch.update({ where: { id: batch.id }, data: { status: "running", attemptCount: 1, leaseToken: randomUUID(), queueJobId: randomUUID(), queueRetryCount: 0, startedAt: new Date() } });
          for (const [index, chunkId] of state.chunkIds.entries()) {
            const vector = index === 0 ? "[1,0,0]" : "[0.8,0.6,0]";
            await tx.$executeRaw(Prisma.sql`INSERT INTO knowledge_chunk_embeddings (chunk_id, release_id, profile_id, profile_spec_sha256, dimension, embedding, embedding_sha256) VALUES (${chunkId}, ${release.id}, ${embedding.spec.id}, ${embedding.specSha256}, 3, ${vector}::public.vector, ${digest(vector)})`);
          }
          await tx.knowledgeEmbeddingBatch.update({ where: { id: batch.id }, data: { status: "ready", leaseToken: null, tokenCount: 32, outputSha256: digest("controlled-http-vectors"), finishedAt: new Date() } });
          await tx.knowledgeRelease.update({ where: { id: release.id }, data: { status: "ready", chunksReadyAt: new Date(), readyAt: new Date() } });
        }, { timeout: 30000 });
      } finally { await db.$disconnect(); }
    },
    async retrieve(requestBody) {
      const runId = requestBody.metadata.workbench_run_id;
      const descriptor = JSON.parse(requestBody.context.secrets.WORKBENCH_KNOWLEDGE_CAPABILITY);
      assert.equal(descriptor.releaseId, state.releaseId);
      const endpoint = new URL(descriptor.endpoint);
      assert.equal(endpoint.hostname, "127.0.0.1");
      assert.equal(endpoint.pathname, "/api/v1/runtime/knowledge/retrieve");
      const response = await fetch(endpoint, { method: "POST", signal: AbortSignal.timeout(15000), headers: {
        authorization: `Bearer ${descriptor.token}`, "content-type": "application/json", "idempotency-key": `controlled-knowledge-${randomUUID()}`,
      }, body: JSON.stringify({ protocol: "workbench.knowledge-retrieval-request.v1", query: "产品工作台" }) });
      assert.equal(response.status, 200, `Controlled knowledge tool failed: HTTP ${response.status}`);
      const result = await response.json();
      assert.equal(result.evidence.release.id, state.releaseId);
      assert.deepEqual(result.evidence.candidateCounts, { lexical: 1, dense: 2, fused: 2 });
      assert.equal(result.evidence.degraded, false);
      assert.equal(result.evidence.routeScope, "production");
      assert.equal(result.evidence.reranker.status, "applied");
      assert.equal(result.items.length, 2);
      assert.ok(result.items.every((item) => state.chunkIds.includes(item.citation.chunkId)));
      state.results.set(runId, result);
      return result;
    },
    async close() {
      await Promise.all([embeddingProvider, rerankerProvider].map(({ server }) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); })));
    },
  };
}

function digest(value) { return createHash("sha256").update(value).digest("hex"); }
