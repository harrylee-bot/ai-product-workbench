import type { ChineseSegmenterPort } from "./ports.js";
import type { KnowledgeChunk, RetrievalProjection } from "./types.js";

export function projectKnowledgeChunk(
  chunk: KnowledgeChunk,
  segmenter?: ChineseSegmenterPort,
): RetrievalProjection {
  if (!segmenter) {
    return {
      chunkId: chunk.id,
      content: chunk.content,
      lexemes: [],
      searchText: chunk.content,
    };
  }

  const lexemes = segmenter.segment(chunk.content)
    .map((value) => value.trim().normalize("NFC"))
    .filter(Boolean);
  return {
    chunkId: chunk.id,
    content: chunk.content,
    lexemes,
    searchText: lexemes.join(" "),
  };
}
