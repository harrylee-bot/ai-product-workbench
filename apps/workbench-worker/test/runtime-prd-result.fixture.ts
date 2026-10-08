import {
  runtimeResultSchema,
  type RuntimeResult,
} from "@workbench/workbench-contracts";
import { prdDocumentV2Example } from "@workbench/workbench-contracts/test-fixtures";
import { sourceCitations } from "../../../packages/workbench-contracts/test/knowledge-citation.fixture.js";

export const knowledgeCitationFixture = {
  id: "citation-knowledge", documentId: "document-knowledge", chunkId: "chunk-knowledge", sourcePath: "00-rules/product.md",
  title: "Product requirements", quote: "Source facts", locator: { heading: "Requirements", startLine: null, endLine: null },
};
export const runtimePrdResultFixture: RuntimeResult = runtimeResultSchema.parse({
  protocol: "workbench.runtime.result.v1",
  message: "需求说明书已生成。",
  artifacts: [{
    kind: "prd",
    schemaVersion: 2,
    title: prdDocumentV2Example.title,
    operation: { kind: "create" },
    citations: sourceCitations,
    content: { ...prdDocumentV2Example, citations: sourceCitations },
  }],
});
