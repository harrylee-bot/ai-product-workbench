import {
  runtimeResultSchema,
  type RuntimeResult,
} from "@workbench/workbench-contracts";
import { prdDocumentV2Example } from "@workbench/workbench-contracts/test-fixtures";

export const runtimePrdResultFixture: RuntimeResult = runtimeResultSchema.parse({
  protocol: "workbench.runtime.result.v1",
  message: "需求说明书已生成。",
  artifacts: [{
    kind: "prd",
    schemaVersion: 2,
    title: prdDocumentV2Example.title,
    operation: { kind: "create" },
    citations: prdDocumentV2Example.citations,
    content: prdDocumentV2Example,
  }],
});
