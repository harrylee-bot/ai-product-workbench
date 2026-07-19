import { createHash } from "node:crypto";

export const knowledgeSegmenterId = "jieba-wasm/cut_for_search/hmm=false";
export const knowledgeSegmenterVersion = "2.4.0";
/** SHA-256 of jieba-wasm@2.4.0 pkg/nodejs/jieba_rs_wasm_bg.wasm. */
export const knowledgeDefaultDictionaryChecksum = "06593dfa9234d927385aa98a0be294366a5d52f2148113ba0aa782b550728146";

export function canonicalKnowledgeStopwords(words: readonly string[]): readonly string[] {
  return [...new Set(words.map((word) => word.trim().normalize("NFC")).filter(Boolean))]
    .sort(compareCodePoints);
}

export function knowledgeStopwordsChecksum(words: readonly string[]): string {
  return createHash("sha256")
    .update(canonicalKnowledgeStopwords(words).join("\n"), "utf8")
    .digest("hex");
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
