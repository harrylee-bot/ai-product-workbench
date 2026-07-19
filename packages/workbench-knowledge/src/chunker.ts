import { canonicalSha256, sha256 } from "./checksum.js";
import type { TokenizerPort } from "./ports.js";
import type { JsonValue, KnowledgeBlock, KnowledgeChunk, ParsedKnowledgeDocument } from "./types.js";

export class TokenizerContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenizerContractError";
  }
}

export function chunkKnowledgeDocument(
  document: ParsedKnowledgeDocument,
  tokenizer: TokenizerPort,
  options: { readonly maximumTokens: number },
): readonly KnowledgeChunk[] {
  if (!Number.isSafeInteger(options.maximumTokens) || options.maximumTokens < 1) {
    throw new RangeError("maximumTokens must be a positive safe integer");
  }
  if (document.route === "excluded" || document.route === "quarantine") return [];

  const chunks: KnowledgeChunk[] = [];
  let pending: KnowledgeBlock[] = [];
  let pendingBody = "";
  let activeHeading: readonly string[] = [];

  const flush = (): void => {
    if (!pendingBody) {
      pending = [];
      return;
    }
    chunks.push(createChunk(document, chunks.length, activeHeading, pending, pendingBody, tokenizer));
    pending = [];
    pendingBody = "";
  };

  for (const block of document.blocks) {
    if (!sameHeadingPath(activeHeading, block.headingPath)) {
      flush();
      activeHeading = block.headingPath;
    }
    if (block.kind === "heading" || !block.retrievalText.trim()) continue;

    const blockText = block.retrievalText.trim().normalize("NFC");
    const candidateBody = pendingBody ? `${pendingBody}\n\n${blockText}` : blockText;
    const candidateContent = composeChunkContent(document.title, activeHeading, candidateBody);
    if (countTokens(tokenizer, candidateContent) <= options.maximumTokens) {
      pending.push(block);
      pendingBody = candidateBody;
      continue;
    }

    flush();
    const atomicContent = composeChunkContent(document.title, activeHeading, blockText);
    if (countTokens(tokenizer, atomicContent) <= options.maximumTokens) {
      pending = [block];
      pendingBody = blockText;
      continue;
    }

    const prefix = composeChunkContent(document.title, activeHeading, "");
    const prefixTokens = countTokens(tokenizer, `${prefix}\n\n`);
    const availableTokens = options.maximumTokens - prefixTokens;
    if (availableTokens < 1) {
      throw new TokenizerContractError("chunk metadata consumes the entire token budget");
    }
    const slices = tokenizer.split({ text: blockText, maximumTokens: availableTokens });
    if (slices.length === 0) throw new TokenizerContractError("tokenizer returned no slices for an oversized block");
    if (slices.map((slice) => slice.text).join("") !== blockText) {
      throw new TokenizerContractError("tokenizer slices must reconstruct the oversized block exactly");
    }

    for (const slice of slices) {
      const text = slice.text;
      if (!text.trim()) throw new TokenizerContractError("tokenizer returned an empty slice");
      if (slice.tokenCount !== undefined && slice.tokenCount !== countTokens(tokenizer, text)) {
        throw new TokenizerContractError("tokenizer slice tokenCount does not match tokenizer.count");
      }
      const content = composeChunkContent(document.title, activeHeading, text);
      const tokenCount = countTokens(tokenizer, content);
      if (tokenCount > options.maximumTokens) {
        throw new TokenizerContractError("tokenizer returned a slice that exceeds the requested budget");
      }
      chunks.push(createChunk(document, chunks.length, activeHeading, [block], text, tokenizer));
    }
  }

  flush();
  return chunks;
}

export function composeChunkContent(
  title: string,
  headingPath: readonly string[],
  body: string,
): string {
  const metadata = [
    `Title: ${title.trim().normalize("NFC")}`,
    headingPath.length > 0 ? `Section: ${headingPath.join(" > ")}` : undefined,
  ].filter((line): line is string => Boolean(line));
  return body ? `${metadata.join("\n")}\n\n${body}` : metadata.join("\n");
}

function createChunk(
  document: ParsedKnowledgeDocument,
  sequence: number,
  headingPath: readonly string[],
  blocks: readonly KnowledgeBlock[],
  body: string,
  tokenizer: TokenizerPort,
): KnowledgeChunk {
  const content = composeChunkContent(document.title, headingPath, body);
  const blockSequences = blocks.map((block) => block.sequence);
  const identity = {
    schema: "workbench.knowledge-chunk.v1",
    sourceLocator: document.sourceLocator,
    sourceChecksum: document.sourceChecksum,
    sequence,
    headingPath,
    blockSequences,
    content,
  } as const;
  return {
    id: `knowledge-chunk-v1:${canonicalSha256(identity as unknown as JsonValue)}`,
    checksum: sha256(content),
    sourceLocator: document.sourceLocator,
    sequence,
    headingPath: [...headingPath],
    blockSequences,
    content,
    tokenCount: countTokens(tokenizer, content),
  };
}

function countTokens(tokenizer: TokenizerPort, text: string): number {
  const count = tokenizer.count(text);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new TokenizerContractError("tokenizer count must be a non-negative safe integer");
  }
  return count;
}

function sameHeadingPath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
