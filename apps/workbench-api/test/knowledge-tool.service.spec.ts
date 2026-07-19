import { ConfigService } from "@nestjs/config";
import { createKnowledgeToolGrant } from "@workbench/workbench-knowledge";
import { KnowledgeRetrievalConfig } from "../src/modules/knowledge/knowledge-retrieval.config.js";
import { KnowledgeRetrievalError } from "../src/modules/knowledge/knowledge-retrieval.types.js";
import { KnowledgeToolService } from "../src/modules/knowledge/knowledge-tool.service.js";

describe("KnowledgeToolService", () => {
  it("returns a safe 503 before authorization data, ledger, or providers are accessed when providers are absent", async () => {
    const secret = Buffer.alloc(32, 31);
    const config = new KnowledgeRetrievalConfig(new ConfigService({
      WORKBENCH_KNOWLEDGE_TOOL_SECRET: secret.toString("base64url"),
    }));
    const access = { findProject: vi.fn() };
    const db = {};
    const ledger = ledgerMock();
    const service = new KnowledgeToolService(config, access as never, db as never, ledger as never);
    const token = signedGrant(secret);

    const failure = await service.retrieve(`Bearer ${token}`, invocationId, request).catch((error: unknown) => error) as {
      status: number;
      getResponse(): unknown;
    };

    expect(failure.status).toBe(503);
    expect(failure.getResponse()).toEqual({
      type: "about:blank",
      title: "Knowledge retrieval unavailable",
      status: 503,
      detail: "Production Knowledge retrieval providers are not configured",
      code: "KNOWLEDGE_RETRIEVAL_NOT_CONFIGURED",
    });
    expect(access.findProject).not.toHaveBeenCalled();
    expect(ledger.reserve).not.toHaveBeenCalled();
  });

  it("reserves before provider work and commits the validated citation response", async () => {
    const { ledger, provider, service, token } = configuredHarness();

    const response = await service.retrieve(`Bearer ${token}`, invocationId, request);

    expect(response).toMatchObject({ protocol: "workbench.knowledge-retrieval-result.v1", items: [] });
    expect(ledger.reserve).toHaveBeenCalledWith(expect.objectContaining({
      grantId: "grant_scope",
      runtimeAttemptId: "attempt_scope",
    }), invocationId, request.query);
    expect(provider).toHaveBeenCalledOnce();
    expect(ledger.commit).toHaveBeenCalledWith(
      expect.objectContaining({ grantId: "grant_scope" }),
      reservation,
      expect.objectContaining({ protocol: "workbench.knowledge-retrieval-result.v1" }),
    );
    expect(ledger.release).not.toHaveBeenCalled();
  });

  it("replays a committed receipt without entering the provider pipeline", async () => {
    const replay = toolResponse();
    const harness = configuredHarness({ reserve: { kind: "replay", response: replay } });

    await expect(harness.service.retrieve(`Bearer ${harness.token}`, invocationId, request)).resolves.toEqual(replay);
    expect(harness.provider).not.toHaveBeenCalled();
    expect(harness.ledger.commit).not.toHaveBeenCalled();
    expect(harness.ledger.release).not.toHaveBeenCalled();
  });

  it("releases a reservation when provider work fails and exposes only the safe problem", async () => {
    const harness = configuredHarness();
    harness.provider.mockRejectedValueOnce(new KnowledgeRetrievalError(
      "KNOWLEDGE_QUERY_EMBEDDING_FAILED",
      "Hybrid Knowledge retrieval is temporarily unavailable",
    ));

    const failure = await harness.service.retrieve(`Bearer ${harness.token}`, invocationId, request)
      .catch((error: unknown) => error) as { status: number; getResponse(): unknown };

    expect(failure.status).toBe(503);
    expect(failure.getResponse()).toMatchObject({ code: "KNOWLEDGE_QUERY_EMBEDDING_FAILED" });
    expect(harness.ledger.release).toHaveBeenCalledWith(reservation, "KNOWLEDGE_QUERY_EMBEDDING_FAILED");
    expect(harness.ledger.commit).not.toHaveBeenCalled();
  });

  it("does not return a provider result rejected by the atomic post-provider scope settlement", async () => {
    const harness = configuredHarness();
    harness.ledger.commit.mockRejectedValueOnce({ status: 404, code: "RESOURCE_NOT_FOUND" });

    await expect(harness.service.retrieve(`Bearer ${harness.token}`, invocationId, request))
      .rejects.toMatchObject({ status: 404 });
    expect(harness.provider).toHaveBeenCalledOnce();
    expect(harness.ledger.release).toHaveBeenCalledWith(reservation, "KNOWLEDGE_RETRIEVAL_FAILED");
  });
});

const invocationId = `knowledge:${"a".repeat(64)}`;
const request = {
  protocol: "workbench.knowledge-retrieval-request.v1" as const,
  query: "产品工作台",
};
const reservation = {
  id: "receipt_scope",
  runtimeAttemptId: "attempt_scope",
  invocationId,
  querySha256: "b".repeat(64),
  leaseToken: "lease_token_scope_123456789",
};

function configuredHarness(options: { reserve?: unknown } = {}) {
  const secret = Buffer.alloc(32, 23);
  const config = new KnowledgeRetrievalConfig(new ConfigService(fullConfig(secret)));
  const access = { findProject: vi.fn() };
  const db = {};
  const ledger = ledgerMock(options.reserve);
  const service = new KnowledgeToolService(config, access as never, db as never, ledger as never);
  const provider = vi.fn().mockResolvedValue(retrievalResult());
  Object.defineProperty(service, "retrieval", { value: { retrieve: provider } });
  return { ledger, provider, service, token: signedGrant(secret) };
}

function ledgerMock(reserve: unknown = { kind: "reserved", reservation }) {
  return {
    reserve: vi.fn().mockResolvedValue(reserve),
    commit: vi.fn(async (_grant, _reservation, response) => response),
    release: vi.fn(async () => undefined),
  };
}

function signedGrant(secret: Uint8Array) {
  const issuedAt = new Date(Math.floor(Date.now() / 1_000) * 1_000);
  return createKnowledgeToolGrant({
    grantId: "grant_scope",
    runId: "run_scope",
    runtimeAttemptId: "attempt_scope",
    principalId: "principal_scope",
    projectId: "project_scope",
    releaseId: "release_scope",
    mode: "hybrid",
    routeScope: "production",
    issuedAt,
    expiresAt: new Date(issuedAt.getTime() + 5 * 60_000),
  }, secret, { now: issuedAt });
}

function fullConfig(secret: Uint8Array) {
  return {
    WORKBENCH_KNOWLEDGE_TOOL_SECRET: Buffer.from(secret).toString("base64url"),
    WORKBENCH_KNOWLEDGE_EMBEDDING_PROFILE_ID: "profile-r1",
    WORKBENCH_KNOWLEDGE_EMBEDDING_PROFILE_SPEC_SHA256: "a".repeat(64),
    WORKBENCH_TEI_URL: "https://embedding.test",
    WORKBENCH_TEI_IMAGE_DIGEST: `sha256:${"b".repeat(64)}`,
    WORKBENCH_KNOWLEDGE_RERANKER_URL: "https://reranker.test",
    WORKBENCH_KNOWLEDGE_RERANKER_IMAGE_DIGEST: `sha256:${"c".repeat(64)}`,
    WORKBENCH_KNOWLEDGE_RERANKER_MODEL_ID: "reranker-r1",
    WORKBENCH_KNOWLEDGE_RERANKER_MODEL_REVISION: "commit-r1",
    WORKBENCH_KNOWLEDGE_RERANKER_TEI_VERSION: "1.8.3",
    WORKBENCH_KNOWLEDGE_RERANKER_MAX_INPUT_TOKENS: "512",
  };
}

function toolResponse() {
  return {
    protocol: "workbench.knowledge-retrieval-result.v1" as const,
    evidence: retrievalResult().evidence,
    items: [],
  };
}

function retrievalResult() {
  return {
    evidence: {
      schema: "workbench.knowledge-retrieval-evidence.v1",
      mode: "hybrid",
      routeScope: "production",
      release: { id: "release_scope", key: "vault", version: 1 },
      embeddingProfile: { id: "profile-r1", specSha256: "a".repeat(64), dimension: 3 },
      retrievalProfile: { id: "retrieval-r1", specSha256: "b".repeat(64) },
      candidateCounts: { lexical: 0, dense: 0, fused: 0 },
      fusion: { algorithm: "rrf", k: 60 },
      reranker: { status: "not_needed" },
      degraded: false,
    },
    items: [],
  };
}
