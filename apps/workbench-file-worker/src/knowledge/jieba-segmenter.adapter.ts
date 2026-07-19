import {
  canonicalKnowledgeStopwords,
  knowledgeDefaultDictionaryChecksum,
  knowledgeSegmenterId,
  knowledgeSegmenterVersion,
  knowledgeStopwordsChecksum,
  type ChineseSegmenterPort,
} from "@workbench/workbench-knowledge";
import { cut_for_search } from "jieba-wasm";

export { knowledgeDefaultDictionaryChecksum, knowledgeSegmenterId, knowledgeSegmenterVersion };

export class JiebaSegmenterAdapter implements ChineseSegmenterPort {
  readonly stopwordsChecksum: string;
  private readonly stopwords: ReadonlySet<string>;

  constructor(stopwords: readonly string[] = []) {
    const normalized = canonicalKnowledgeStopwords(stopwords);
    this.stopwords = new Set(normalized);
    this.stopwordsChecksum = knowledgeStopwordsChecksum(normalized);
  }

  segment(text: string): readonly string[] {
    return cut_for_search(text.normalize("NFC"), false)
      .map((word) => word.trim().normalize("NFC"))
      .filter((word) => word.length > 0 && !this.stopwords.has(word) && /[\p{L}\p{N}]/u.test(word));
  }
}
