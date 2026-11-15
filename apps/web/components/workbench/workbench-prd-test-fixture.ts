import { prdDocumentSchema, type PrdDocument } from "@workbench/workbench-contracts";
import { prdDocumentV3Example } from "@workbench/workbench-contracts/test-fixtures";

export function prdDocument(): PrdDocument {
  const document = structuredClone(prdDocumentV3Example);
  document.documentId = "prd-doc";
  document.citations = [{
    id: "citation-1", documentId: "source-doc", chunkId: "source-chunk",
    sourcePath: "knowledge-vault/source.md", title: "Source", quote: "Evidence",
    locator: { heading: "Context", startLine: 1, endLine: 2 },
  }];
  document.sections.introduction.background.blocks.unshift({
    id: "summary", type: "paragraph", content: [
      { type: "text", text: "Initial summary", marks: ["strong"] },
      { type: "link", text: " source", href: "/projects/source" },
      { type: "citation", citationId: "citation-1", label: "Evidence" },
      { type: "reference", targetType: "goal", targetId: "goal-main", label: "Goal" },
    ],
  });
  return prdDocumentSchema.parse(document);
}
