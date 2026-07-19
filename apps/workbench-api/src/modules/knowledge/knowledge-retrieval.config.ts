import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { decodeKnowledgeToolSecret } from "@workbench/workbench-knowledge";
import { integerValue, optionalString } from "../../platform/config/config-values.js";

const MEBIBYTE = 1024 * 1024;

export type TeiServiceConfig = {
  readonly origin: string;
  readonly apiKey?: string;
  readonly requestTimeoutMs: number;
  readonly maximumRequestBytes: number;
  readonly maximumResponseBytes: number;
};

export type KnowledgeEmbeddingProviderConfig = TeiServiceConfig & {
  readonly imageDigest: string;
  readonly profileId: string;
  readonly profileSpecSha256: string;
};

export type KnowledgeRerankerProviderConfig = TeiServiceConfig & {
  readonly imageDigest: string;
  readonly modelId: string;
  readonly modelRevision: string;
  readonly teiVersion: string;
  readonly maximumInputTokens: number;
};

export type KnowledgeProductionProviders = {
  readonly embedding: KnowledgeEmbeddingProviderConfig;
  readonly reranker: KnowledgeRerankerProviderConfig;
};

@Injectable()
export class KnowledgeRetrievalConfig {
  readonly grantSecret: Uint8Array | null;
  readonly grantMaximumTtlSeconds: number;
  readonly readinessTimeoutMs: number;
  readonly providers: KnowledgeProductionProviders | null;

  constructor(config: ConfigService) {
    const grantSecret = optionalString(config, "WORKBENCH_KNOWLEDGE_TOOL_SECRET");
    this.grantSecret = grantSecret ? decodeKnowledgeToolSecret(grantSecret) : null;
    this.grantMaximumTtlSeconds = integerValue(
      config,
      "WORKBENCH_KNOWLEDGE_TOOL_MAX_TTL_SECONDS",
      900,
      60,
      3_600,
    );
    this.readinessTimeoutMs = integerValue(
      config,
      "WORKBENCH_KNOWLEDGE_READINESS_TIMEOUT_MS",
      4_000,
      500,
      10_000,
    );
    const production = optionalString(config, "NODE_ENV") === "production";

    const embeddingNames = [
      "WORKBENCH_KNOWLEDGE_EMBEDDING_PROFILE_ID",
      "WORKBENCH_KNOWLEDGE_EMBEDDING_PROFILE_SPEC_SHA256",
      "WORKBENCH_TEI_URL",
      "WORKBENCH_TEI_IMAGE_DIGEST",
    ] as const;
    const rerankerNames = [
      "WORKBENCH_KNOWLEDGE_RERANKER_URL",
      "WORKBENCH_KNOWLEDGE_RERANKER_IMAGE_DIGEST",
      "WORKBENCH_KNOWLEDGE_RERANKER_MODEL_ID",
      "WORKBENCH_KNOWLEDGE_RERANKER_MODEL_REVISION",
      "WORKBENCH_KNOWLEDGE_RERANKER_TEI_VERSION",
      "WORKBENCH_KNOWLEDGE_RERANKER_MAX_INPUT_TOKENS",
    ] as const;
    const embeddingConfigured = configuredGroup(config, embeddingNames);
    const rerankerConfigured = configuredGroup(config, rerankerNames);
    if (embeddingConfigured !== rerankerConfigured) {
      throw new Error("Knowledge embedding and reranker providers must be configured together");
    }
    this.providers = embeddingConfigured ? {
      embedding: {
        origin: serviceOrigin(config, "WORKBENCH_TEI_URL", production),
        apiKey: optionalString(config, "WORKBENCH_TEI_API_KEY"),
        requestTimeoutMs: integerValue(config, "WORKBENCH_TEI_REQUEST_TIMEOUT_MS", 30_000, 500, 120_000),
        maximumRequestBytes: integerValue(config, "WORKBENCH_TEI_MAX_REQUEST_BYTES", MEBIBYTE, 4_096, 64 * MEBIBYTE),
        maximumResponseBytes: integerValue(config, "WORKBENCH_TEI_MAX_RESPONSE_BYTES", 32 * MEBIBYTE, 4_096, 256 * MEBIBYTE),
        imageDigest: imageDigest(config, "WORKBENCH_TEI_IMAGE_DIGEST"),
        profileId: required(config, "WORKBENCH_KNOWLEDGE_EMBEDDING_PROFILE_ID"),
        profileSpecSha256: sha256(config, "WORKBENCH_KNOWLEDGE_EMBEDDING_PROFILE_SPEC_SHA256"),
      },
      reranker: {
        origin: serviceOrigin(config, "WORKBENCH_KNOWLEDGE_RERANKER_URL", production),
        apiKey: optionalString(config, "WORKBENCH_KNOWLEDGE_RERANKER_API_KEY"),
        requestTimeoutMs: integerValue(config, "WORKBENCH_KNOWLEDGE_RERANKER_TIMEOUT_MS", 30_000, 500, 120_000),
        maximumRequestBytes: integerValue(config, "WORKBENCH_KNOWLEDGE_RERANKER_MAX_REQUEST_BYTES", 8 * MEBIBYTE, 4_096, 64 * MEBIBYTE),
        maximumResponseBytes: integerValue(config, "WORKBENCH_KNOWLEDGE_RERANKER_MAX_RESPONSE_BYTES", MEBIBYTE, 4_096, 64 * MEBIBYTE),
        imageDigest: imageDigest(config, "WORKBENCH_KNOWLEDGE_RERANKER_IMAGE_DIGEST"),
        modelId: required(config, "WORKBENCH_KNOWLEDGE_RERANKER_MODEL_ID"),
        modelRevision: required(config, "WORKBENCH_KNOWLEDGE_RERANKER_MODEL_REVISION"),
        teiVersion: required(config, "WORKBENCH_KNOWLEDGE_RERANKER_TEI_VERSION"),
        maximumInputTokens: requiredInteger(config, "WORKBENCH_KNOWLEDGE_RERANKER_MAX_INPUT_TOKENS", 128, 131_072),
      },
    } : null;
  }
}

function configuredGroup(config: ConfigService, names: readonly string[]): boolean {
  const present = names.filter((name) => optionalString(config, name) !== undefined);
  if (present.length === 0) return false;
  if (present.length !== names.length) {
    const missing = names.filter((name) => !present.includes(name));
    throw new Error(`Incomplete Knowledge provider configuration; missing ${missing.join(", ")}`);
  }
  return true;
}

function required(config: ConfigService, name: string): string {
  const value = optionalString(config, name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function requiredInteger(config: ConfigService, name: string, minimum: number, maximum: number): number {
  const value = Number(required(config, name));
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function serviceOrigin(config: ConfigService, name: string, production: boolean): string {
  const value = required(config, name);
  const url = new URL(value);
  if (
    !url.hostname
    || !["http:", "https:"].includes(url.protocol)
    || (production && url.protocol !== "https:")
    || url.username
    || url.password
    || url.search
    || url.hash
    || !["", "/"].includes(url.pathname)
  ) {
    throw new Error(`${name} must be a bare ${production ? "HTTPS" : "HTTP(S)"} origin without credentials`);
  }
  return url.origin;
}

function sha256(config: ConfigService, name: string): string {
  const value = required(config, name);
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${name} must be a lowercase SHA-256 digest`);
  return value;
}

function imageDigest(config: ConfigService, name: string): string {
  const value = required(config, name);
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) throw new Error(`${name} must be a pinned sha256 image digest`);
  return value;
}
