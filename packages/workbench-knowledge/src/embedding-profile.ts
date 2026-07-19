import { canonicalJson, sha256 } from "./checksum.js";
import type { JsonValue } from "./types.js";

export type EmbeddingProtocol = "tei.embed.v1" | "openai.embeddings.v1";
export type EmbeddingPooling = "cls" | "last_token";

interface EmbeddingProfileV1Base {
  readonly schema: "workbench.embedding-profile.v1";
  readonly id: string;
  readonly model: {
    readonly id: string;
    readonly revision: string;
    readonly artifactSha256: string;
  };
  readonly tokenizer: {
    readonly id: string;
    readonly revision: string;
    readonly artifactSha256: string;
    readonly modelMaximumTokens: number;
    readonly chunkMaximumTokens: number;
    readonly overflow: "reject";
  };
  readonly input: {
    readonly queryPrefix: string;
    readonly documentPrefix: string;
    readonly normalization: "utf8-nfc-lf-v1";
  };
  readonly output: {
    readonly dimension: number;
    readonly dtype: "float32";
    readonly pooling: EmbeddingPooling;
    readonly normalization: "l2";
    readonly distance: "cosine";
  };
  readonly batch: {
    readonly maximumInputs: number;
    readonly maximumTokens: number;
  };
  readonly conformanceProbeSha256: string;
}

export type EmbeddingProfileV1 = EmbeddingProfileV1Base & (
  | {
    readonly protocol: "tei.embed.v1";
    readonly engine: {
      readonly id: string;
      readonly version: string;
      readonly imageDigest: string;
    };
  }
  | {
    readonly protocol: "openai.embeddings.v1";
    readonly engine: {
      readonly id: string;
      readonly version: string;
      readonly imageDigest?: string;
    };
  }
);

export interface CanonicalEmbeddingProfileV1 {
  readonly spec: EmbeddingProfileV1;
  readonly canonicalJson: string;
  readonly specSha256: string;
  readonly dimension: number;
}

export class EmbeddingProfileContractError extends TypeError {
  readonly code = "EMBEDDING_PROFILE_INVALID";

  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "EmbeddingProfileContractError";
  }
}

const mutableRevisionAliases = new Set(["default", "head", "latest", "main", "master"]);

export function parseEmbeddingProfileV1(input: unknown): CanonicalEmbeddingProfileV1 {
  const root = strictObject(input, "$", [
    "schema",
    "id",
    "protocol",
    "engine",
    "model",
    "tokenizer",
    "input",
    "output",
    "batch",
    "conformanceProbeSha256",
  ]);
  literal(root.schema, "workbench.embedding-profile.v1", "$.schema");

  const protocol = oneOf(root.protocol, ["tei.embed.v1", "openai.embeddings.v1"] as const, "$.protocol");
  const engine = strictObject(
    root.engine,
    "$.engine",
    ["id", "version", "imageDigest"],
    protocol === "tei.embed.v1" ? [] : ["imageDigest"],
  );
  const model = strictObject(root.model, "$.model", ["id", "revision", "artifactSha256"]);
  const tokenizer = strictObject(root.tokenizer, "$.tokenizer", [
    "id",
    "revision",
    "artifactSha256",
    "modelMaximumTokens",
    "chunkMaximumTokens",
    "overflow",
  ]);
  const inputSpec = strictObject(root.input, "$.input", ["queryPrefix", "documentPrefix", "normalization"]);
  const output = strictObject(root.output, "$.output", [
    "dimension",
    "dtype",
    "pooling",
    "normalization",
    "distance",
  ]);
  const batch = strictObject(root.batch, "$.batch", ["maximumInputs", "maximumTokens"]);

  const modelMaximumTokens = positiveSafeInteger(tokenizer.modelMaximumTokens, "$.tokenizer.modelMaximumTokens", 1_000_000);
  const chunkMaximumTokens = positiveSafeInteger(tokenizer.chunkMaximumTokens, "$.tokenizer.chunkMaximumTokens", 1_000_000);
  if (chunkMaximumTokens > modelMaximumTokens) {
    fail("$.tokenizer.chunkMaximumTokens", "must not exceed tokenizer.modelMaximumTokens");
  }
  const maximumTokens = positiveSafeInteger(batch.maximumTokens, "$.batch.maximumTokens", 100_000_000);
  if (maximumTokens < chunkMaximumTokens) {
    fail("$.batch.maximumTokens", "must be at least tokenizer.chunkMaximumTokens");
  }

  const common: EmbeddingProfileV1Base = {
    schema: "workbench.embedding-profile.v1",
    id: profileId(root.id, "$.id"),
    model: {
      id: text(model.id, "$.model.id"),
      revision: immutableRevision(model.revision, "$.model.revision"),
      artifactSha256: digest(model.artifactSha256, "$.model.artifactSha256"),
    },
    tokenizer: {
      id: text(tokenizer.id, "$.tokenizer.id"),
      revision: immutableRevision(tokenizer.revision, "$.tokenizer.revision"),
      artifactSha256: digest(tokenizer.artifactSha256, "$.tokenizer.artifactSha256"),
      modelMaximumTokens,
      chunkMaximumTokens,
      overflow: literal(tokenizer.overflow, "reject", "$.tokenizer.overflow"),
    },
    input: {
      queryPrefix: prefix(inputSpec.queryPrefix, "$.input.queryPrefix"),
      documentPrefix: prefix(inputSpec.documentPrefix, "$.input.documentPrefix"),
      normalization: literal(inputSpec.normalization, "utf8-nfc-lf-v1", "$.input.normalization"),
    },
    output: {
      dimension: positiveSafeInteger(output.dimension, "$.output.dimension", 16_000),
      dtype: literal(output.dtype, "float32", "$.output.dtype"),
      pooling: oneOf(output.pooling, ["cls", "last_token"] as const, "$.output.pooling"),
      normalization: literal(output.normalization, "l2", "$.output.normalization"),
      distance: literal(output.distance, "cosine", "$.output.distance"),
    },
    batch: {
      maximumInputs: positiveSafeInteger(batch.maximumInputs, "$.batch.maximumInputs", 100_000),
      maximumTokens,
    },
    conformanceProbeSha256: digest(root.conformanceProbeSha256, "$.conformanceProbeSha256"),
  };
  const engineIdentity = {
    id: text(engine.id, "$.engine.id"),
    version: immutableRevision(engine.version, "$.engine.version"),
  };
  const spec: EmbeddingProfileV1 = protocol === "tei.embed.v1"
    ? {
      ...common,
      protocol,
      engine: {
        ...engineIdentity,
        imageDigest: imageDigest(engine.imageDigest, "$.engine.imageDigest"),
      },
    }
    : {
      ...common,
      protocol,
      engine: {
        ...engineIdentity,
        ...(engine.imageDigest === undefined
          ? {}
          : { imageDigest: imageDigest(engine.imageDigest, "$.engine.imageDigest") }),
      },
    };
  const serialized = canonicalJson(spec as unknown as JsonValue);
  return deepFreeze({
    spec,
    canonicalJson: serialized,
    specSha256: sha256(serialized),
    dimension: spec.output.dimension,
  });
}

function strictObject(
  value: unknown,
  path: string,
  keys: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, "must be an object");
  const record = value as Record<string, unknown>;
  const allowed = new Set(keys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, "is not allowed by embedding-profile.v1");
  }
  const optionalKeys = new Set(optional);
  for (const key of keys) {
    if (!optionalKeys.has(key) && !Object.hasOwn(record, key)) fail(`${path}.${key}`, "is required");
  }
  return record;
}

function text(value: unknown, path: string, maximum = 512): string {
  if (typeof value !== "string") fail(path, "must be a string");
  if (!value || value.length > maximum) fail(path, `must contain between 1 and ${maximum} characters`);
  if (value !== value.trim()) fail(path, "must not contain surrounding whitespace");
  if (value !== value.normalize("NFC")) fail(path, "must be NFC normalized");
  if (/[\u0000-\u001f\u007f]/u.test(value)) fail(path, "must not contain control characters");
  return value;
}

function prefix(value: unknown, path: string): string {
  if (typeof value !== "string") fail(path, "must be a string");
  if (value.length > 2_000) fail(path, "must not exceed 2000 characters");
  if (value !== value.normalize("NFC")) fail(path, "must be NFC normalized");
  if (/\u0000/u.test(value)) fail(path, "must not contain NUL");
  return value;
}

function profileId(value: unknown, path: string): string {
  const id = text(value, path, 128);
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(id)) {
    fail(path, "must be a lowercase stable identifier containing only letters, numbers, dot, underscore, or hyphen");
  }
  return id;
}

function immutableRevision(value: unknown, path: string): string {
  const revision = text(value, path, 256);
  if (mutableRevisionAliases.has(revision.toLocaleLowerCase("en-US"))) {
    fail(path, "must pin an immutable revision instead of a mutable alias");
  }
  return revision;
}

function digest(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    fail(path, "must be a lowercase SHA-256 digest");
  }
  return value;
}

function imageDigest(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    fail(path, "must be a sha256:<lowercase hex> image digest");
  }
  return value;
}

function positiveSafeInteger(value: unknown, path: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    fail(path, `must be a positive safe integer no greater than ${maximum}`);
  }
  return value as number;
}

function literal<const T extends string>(value: unknown, expected: T, path: string): T {
  if (value !== expected) fail(path, `must equal ${JSON.stringify(expected)}`);
  return expected;
}

function oneOf<const T extends readonly string[]>(value: unknown, choices: T, path: string): T[number] {
  if (typeof value !== "string" || !choices.includes(value)) {
    fail(path, `must be one of ${choices.map((choice) => JSON.stringify(choice)).join(", ")}`);
  }
  return value as T[number];
}

function fail(path: string, message: string): never {
  throw new EmbeddingProfileContractError(path, message);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
