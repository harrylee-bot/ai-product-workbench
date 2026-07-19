import { ConfigService } from "@nestjs/config";
import { KnowledgeRetrievalConfig } from "../src/modules/knowledge/knowledge-retrieval.config.js";

const secret = Buffer.alloc(32, 13).toString("base64url");

describe("KnowledgeRetrievalConfig", () => {
  it("allows an unconfigured deployment to start but exposes no production providers", () => {
    const config = new KnowledgeRetrievalConfig(new ConfigService({}));
    expect(config.grantSecret).toBeNull();
    expect(config.providers).toBeNull();
    expect(config.readinessTimeoutMs).toBe(4_000);
  });

  it("rejects partial provider and partial grant configuration", () => {
    expect(() => new KnowledgeRetrievalConfig(new ConfigService({
      WORKBENCH_TEI_URL: "https://embedding.test",
    }))).toThrow(/Incomplete Knowledge provider configuration/);
    expect(() => new KnowledgeRetrievalConfig(new ConfigService({
      WORKBENCH_KNOWLEDGE_EMBEDDING_PROFILE_ID: "profile-r1",
      WORKBENCH_KNOWLEDGE_EMBEDDING_PROFILE_SPEC_SHA256: "a".repeat(64),
      WORKBENCH_TEI_URL: "https://embedding.test",
      WORKBENCH_TEI_IMAGE_DIGEST: `sha256:${"b".repeat(64)}`,
    }))).toThrow(/configured together/);
  });

  it("loads only explicit pinned embedding and reranker identities", () => {
    const config = new KnowledgeRetrievalConfig(new ConfigService(fullConfig()));
    expect(Buffer.from(config.grantSecret!)).toEqual(Buffer.from(secret, "base64url"));
    expect(config.providers).toMatchObject({
      embedding: {
        origin: "https://embedding.test",
        profileId: "profile-r1",
        profileSpecSha256: "a".repeat(64),
        imageDigest: `sha256:${"b".repeat(64)}`,
      },
      reranker: {
        origin: "https://reranker.test",
        modelId: "BAAI/bge-reranker-v2-m3",
        modelRevision: "commit-r1",
        teiVersion: "1.8.3",
        maximumInputTokens: 512,
      },
    });
  });

  it("bounds the independent Knowledge readiness timeout", () => {
    expect(new KnowledgeRetrievalConfig(new ConfigService({
      WORKBENCH_KNOWLEDGE_READINESS_TIMEOUT_MS: "750",
    })).readinessTimeoutMs).toBe(750);
    expect(() => new KnowledgeRetrievalConfig(new ConfigService({
      WORKBENCH_KNOWLEDGE_READINESS_TIMEOUT_MS: "499",
    }))).toThrow(/between 500 and 10000/);
    expect(() => new KnowledgeRetrievalConfig(new ConfigService({
      WORKBENCH_KNOWLEDGE_READINESS_TIMEOUT_MS: "10001",
    }))).toThrow(/between 500 and 10000/);
  });

  it("requires HTTPS provider origins in production while allowing HTTP for local development", () => {
    expect(() => new KnowledgeRetrievalConfig(new ConfigService({
      ...fullConfig(),
      NODE_ENV: "production",
      WORKBENCH_TEI_URL: "http://embedding.internal",
    }))).toThrow(/WORKBENCH_TEI_URL must be a bare HTTPS origin/);
    expect(() => new KnowledgeRetrievalConfig(new ConfigService({
      ...fullConfig(),
      NODE_ENV: "production",
      WORKBENCH_KNOWLEDGE_RERANKER_URL: "http://reranker.internal",
    }))).toThrow(/WORKBENCH_KNOWLEDGE_RERANKER_URL must be a bare HTTPS origin/);
    expect(new KnowledgeRetrievalConfig(new ConfigService({
      ...fullConfig(),
      WORKBENCH_TEI_URL: "http://embedding.internal",
      WORKBENCH_KNOWLEDGE_RERANKER_URL: "http://reranker.internal",
    })).providers).not.toBeNull();
  });
});

function fullConfig() {
  return {
    WORKBENCH_KNOWLEDGE_TOOL_SECRET: secret,
    WORKBENCH_KNOWLEDGE_EMBEDDING_PROFILE_ID: "profile-r1",
    WORKBENCH_KNOWLEDGE_EMBEDDING_PROFILE_SPEC_SHA256: "a".repeat(64),
    WORKBENCH_TEI_URL: "https://embedding.test",
    WORKBENCH_TEI_IMAGE_DIGEST: `sha256:${"b".repeat(64)}`,
    WORKBENCH_KNOWLEDGE_RERANKER_URL: "https://reranker.test",
    WORKBENCH_KNOWLEDGE_RERANKER_IMAGE_DIGEST: `sha256:${"c".repeat(64)}`,
    WORKBENCH_KNOWLEDGE_RERANKER_MODEL_ID: "BAAI/bge-reranker-v2-m3",
    WORKBENCH_KNOWLEDGE_RERANKER_MODEL_REVISION: "commit-r1",
    WORKBENCH_KNOWLEDGE_RERANKER_TEI_VERSION: "1.8.3",
    WORKBENCH_KNOWLEDGE_RERANKER_MAX_INPUT_TOKENS: "512",
  };
}
