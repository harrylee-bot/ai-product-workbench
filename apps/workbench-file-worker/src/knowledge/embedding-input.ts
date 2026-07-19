import { createHash } from "node:crypto";
import {
  canonicalSha256,
  type CanonicalEmbeddingProfileV1,
  type JsonValue,
} from "@workbench/workbench-knowledge";
import type { KnowledgeEmbeddingInput } from "./embedding.port.js";

export function documentEmbeddingInput(
  profile: CanonicalEmbeddingProfileV1,
  content: string,
): string {
  return `${profile.spec.input.documentPrefix}${normalizeEmbeddingText(content)}`.normalize("NFC");
}

export function embeddingBatchInputSha256(
  profile: CanonicalEmbeddingProfileV1,
  inputs: readonly KnowledgeEmbeddingInput[],
): string {
  return canonicalSha256({
    schema: "workbench.knowledge-embedding-batch-input.v1",
    profileId: profile.spec.id,
    profileSpecSha256: profile.specSha256,
    inputs: inputs.map((input) => ({
      chunkId: input.chunkId,
      textSha256: createHash("sha256").update(input.text, "utf8").digest("hex"),
    })),
  } as unknown as JsonValue);
}

export function embeddingVectorSha256(vector: readonly number[]): string {
  const bytes = Buffer.allocUnsafe(vector.length * Float32Array.BYTES_PER_ELEMENT);
  vector.forEach((value, index) => bytes.writeFloatLE(Math.fround(value), index * Float32Array.BYTES_PER_ELEMENT));
  return createHash("sha256").update(bytes).digest("hex");
}

export function embeddingBatchOutputSha256(
  profile: CanonicalEmbeddingProfileV1,
  rows: readonly { chunkId: string; embeddingSha256: string; tokenCount: number }[],
): string {
  return canonicalSha256({
    schema: "workbench.knowledge-embedding-batch-output.v1",
    profileId: profile.spec.id,
    profileSpecSha256: profile.specSha256,
    rows,
  } as unknown as JsonValue);
}

export function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.map((value) => String(Math.fround(value))).join(",")}]`;
}

function normalizeEmbeddingText(value: string): string {
  return value.replace(/\r\n?/gu, "\n").normalize("NFC");
}
