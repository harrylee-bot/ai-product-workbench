import {
  canonicalKnowledgeStopwords,
  knowledgeDefaultDictionaryChecksum,
  knowledgeSegmenterId,
  knowledgeSegmenterVersion,
  knowledgeStopwordsChecksum,
} from "@workbench/workbench-knowledge";
import { cut_for_search } from "jieba-wasm";
import type { KnowledgeQuerySegmenterPort } from "./knowledge-retrieval.types.js";

export class JiebaQuerySegmenterAdapter implements KnowledgeQuerySegmenterPort {
  readonly identity;
  private readonly stopwords: ReadonlySet<string>;

  constructor(stopwords: readonly string[] = []) {
    const normalized = canonicalKnowledgeStopwords(stopwords);
    this.stopwords = new Set(normalized);
    this.identity = Object.freeze({
      implementationId: knowledgeSegmenterId,
      version: knowledgeSegmenterVersion,
      artifactSha256: knowledgeDefaultDictionaryChecksum,
      algorithm: "cut_for_search" as const,
      hmm: false as const,
      dictionarySha256: knowledgeDefaultDictionaryChecksum,
      stopwordsSha256: knowledgeStopwordsChecksum(normalized),
    });
  }

  segment(text: string): readonly string[] {
    return cut_for_search(text.normalize("NFC"), false)
      .map((word) => word.trim().normalize("NFC"))
      .filter((word) => word.length > 0 && !this.stopwords.has(word) && /[\p{L}\p{N}]/u.test(word));
  }
}
