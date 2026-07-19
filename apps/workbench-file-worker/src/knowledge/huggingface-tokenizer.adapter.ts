import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

import { Tokenizer } from "@huggingface/tokenizers";
import {
  canonicalSha256,
  sha256,
  type CanonicalEmbeddingProfileV1,
  type JsonValue,
  type TokenizerPort,
  type TokenSlice,
} from "@workbench/workbench-knowledge";

import { TerminalKnowledgeBuildError } from "./knowledge.errors.js";

const defaultMaximumArtifactBytes = 128 * 1024 * 1024;

export type HuggingFaceTokenizerArtifactIdentity = {
  readonly schema: "workbench.huggingface-tokenizer-artifact.v1";
  readonly tokenizerJsonSha256: string;
  readonly tokenizerConfigJsonSha256: string;
  readonly artifactSha256: string;
};

export class HuggingFaceTokenizerAdapter implements TokenizerPort {
  readonly artifactIdentity: HuggingFaceTokenizerArtifactIdentity;

  private constructor(
    private readonly tokenizer: Tokenizer,
    identity: HuggingFaceTokenizerArtifactIdentity,
  ) {
    this.artifactIdentity = Object.freeze(identity);
  }

  static async load(input: {
    readonly tokenizerJsonPath: string;
    readonly tokenizerConfigJsonPath: string;
    readonly maximumArtifactBytes?: number;
  }): Promise<HuggingFaceTokenizerAdapter> {
    const maximumArtifactBytes = input.maximumArtifactBytes ?? defaultMaximumArtifactBytes;
    assertMaximumArtifactBytes(maximumArtifactBytes);
    const [tokenizerJson, tokenizerConfigJson] = await Promise.all([
      readBoundedArtifact(input.tokenizerJsonPath, maximumArtifactBytes),
      readBoundedArtifact(input.tokenizerConfigJsonPath, maximumArtifactBytes),
    ]);
    return HuggingFaceTokenizerAdapter.fromArtifacts({ tokenizerJson, tokenizerConfigJson });
  }

  static fromArtifacts(input: {
    readonly tokenizerJson: Uint8Array;
    readonly tokenizerConfigJson: Uint8Array;
  }): HuggingFaceTokenizerAdapter {
    const identity = huggingFaceTokenizerArtifactIdentity(input);
    try {
      const tokenizerJson = parseJsonObject(input.tokenizerJson, "tokenizer.json");
      const tokenizerConfigJson = parseJsonObject(
        input.tokenizerConfigJson,
        "tokenizer_config.json",
      );
      return new HuggingFaceTokenizerAdapter(
        new Tokenizer(tokenizerJson, tokenizerConfigJson),
        identity,
      );
    } catch (cause) {
      if (cause instanceof TokenizerArtifactError) throw cause;
      throw new TokenizerArtifactError(
        "KNOWLEDGE_TOKENIZER_ARTIFACT_INVALID",
        "The pinned Hugging Face tokenizer artifact is invalid",
        { cause },
      );
    }
  }

  assertProfile(profile: CanonicalEmbeddingProfileV1): void {
    if (profile.spec.tokenizer.artifactSha256 !== this.artifactIdentity.artifactSha256) {
      throw new TerminalKnowledgeBuildError(
        "KNOWLEDGE_TOKENIZER_PROFILE_MISMATCH",
        "The local tokenizer artifact does not match the pinned embedding profile",
      );
    }
  }

  count(text: string): number {
    try {
      const count = this.tokenizer.encode(text.normalize("NFC"), {
        add_special_tokens: true,
      }).ids.length;
      if (!Number.isSafeInteger(count) || count < 0) throw new Error("TOKEN_COUNT_INVALID");
      return count;
    } catch (cause) {
      throw new TerminalKnowledgeBuildError(
        "KNOWLEDGE_TOKENIZER_ENCODE_FAILED",
        "The pinned tokenizer could not encode Knowledge content",
        { cause },
      );
    }
  }

  split(input: { readonly text: string; readonly maximumTokens: number }): readonly TokenSlice[] {
    if (!Number.isSafeInteger(input.maximumTokens) || input.maximumTokens < 1) {
      throw new RangeError("maximumTokens must be a positive safe integer");
    }
    if (!input.text) return [];

    const characters = Array.from(input.text);
    const slices: TokenSlice[] = [];
    let start = 0;
    while (start < characters.length) {
      let low = start + 1;
      let high = characters.length;
      let accepted = start;
      let acceptedCount = 0;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const candidate = characters.slice(start, middle).join("");
        const count = this.count(candidate);
        if (count <= input.maximumTokens) {
          accepted = middle;
          acceptedCount = count;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      if (accepted === start) {
        throw new TerminalKnowledgeBuildError(
          "KNOWLEDGE_TOKENIZER_CHARACTER_EXCEEDS_BUDGET",
          "A Knowledge character cannot fit inside the pinned token budget",
        );
      }
      slices.push({
        text: characters.slice(start, accepted).join(""),
        tokenCount: acceptedCount,
      });
      start = accepted;
    }
    return slices;
  }
}

export function huggingFaceTokenizerArtifactIdentity(input: {
  readonly tokenizerJson: Uint8Array;
  readonly tokenizerConfigJson: Uint8Array;
}): HuggingFaceTokenizerArtifactIdentity {
  const manifest = {
    schema: "workbench.huggingface-tokenizer-artifact.v1",
    tokenizerJsonSha256: sha256(input.tokenizerJson),
    tokenizerConfigJsonSha256: sha256(input.tokenizerConfigJson),
  } as const;
  return {
    ...manifest,
    artifactSha256: canonicalSha256(manifest as JsonValue),
  };
}

export class TokenizerArtifactError extends Error {
  constructor(
    readonly code: string,
    readonly safeDetail: string,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "TokenizerArtifactError";
  }
}

async function readBoundedArtifact(path: string, maximumBytes: number): Promise<Uint8Array> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 2 || metadata.size > maximumBytes) {
      throw new TokenizerArtifactError(
        "KNOWLEDGE_TOKENIZER_ARTIFACT_SIZE_INVALID",
        "The pinned tokenizer artifact is not a regular file, is empty, or exceeds its byte limit",
      );
    }
    const value = await handle.readFile();
    if (value.byteLength !== metadata.size) {
      throw new TokenizerArtifactError(
        "KNOWLEDGE_TOKENIZER_ARTIFACT_CHANGED",
        "The pinned tokenizer artifact changed while it was being read",
      );
    }
    return value;
  } catch (cause) {
    if (cause instanceof TokenizerArtifactError) throw cause;
    throw new TokenizerArtifactError(
      "KNOWLEDGE_TOKENIZER_ARTIFACT_UNAVAILABLE",
      "The pinned tokenizer artifact is unavailable or is a symbolic link",
      { cause },
    );
  } finally {
    await handle?.close();
  }
}

function parseJsonObject(value: Uint8Array, label: string): object {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value));
  } catch (cause) {
    throw new TokenizerArtifactError(
      "KNOWLEDGE_TOKENIZER_ARTIFACT_JSON_INVALID",
      `${label} is not valid UTF-8 JSON`,
      { cause },
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TokenizerArtifactError(
      "KNOWLEDGE_TOKENIZER_ARTIFACT_JSON_INVALID",
      `${label} must contain a JSON object`,
    );
  }
  return parsed;
}

function assertMaximumArtifactBytes(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 512 * 1024 * 1024) {
    throw new RangeError("maximumArtifactBytes must be a positive safe integer no greater than 512 MiB");
  }
}
