import {
  prdDocumentV2Example,
  runtimeResultSchema,
  type RuntimeResult,
} from "@workbench/workbench-contracts";

export const runtimePrdResultStarter: RuntimeResult = runtimeResultSchema.parse(
  {
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
  },
);

export function runtimePrdResultGuidance(
  requestedArtifactKinds: readonly string[],
  workflow: "generate" | "redesign" | "ideate" | "edit" = "generate",
): string | null {
  if (!requestedArtifactKinds.includes("prd")) return null;
  if (workflow === "edit") {
    return [
      "<workbench_prd_result_contract>",
      "Revise the complete targeted PRD without changing its protocol or Artifact schemaVersion. Legacy workbench.prd.v1 targets remain v1; workbench.prd.v2 targets remain v2. Retain documentId, advance revision.number, preserve citations, and return the complete next document through workbench_runtime_result_submit.",
      "</workbench_prd_result_contract>",
    ].join("\n");
  }
  return [
    "<workbench_prd_result_contract>",
    "For every newly created PRD, use only schemaVersion 2 with protocol workbench.prd.v2. Follow the public workbench skill and read references/prd-runtime-result.example.json exactly once for the complete envelope, then replace every sample ID and all sample business content with facts from the current request and authorized sources.",
    "The title and cover title must be <workOrderName>需求说明书. Preserve the fixed cover, version history, manual table of contents, sections 1 through 4, exactly one typed channelTable, productFlow followed by productArchitecture, a concrete degradation plan, and all 21 safety rows in canonical order. Safety applicability is only 是, 否, or 不涉及 and must be derived from request facts outside the safety table.",
    "Do not use 待确认, 以实际为准, template reminders, sample links, or other placeholders. Put conservative unresolved facts in typed assumptions without placeholder wording. Keep every goal/requirement/criterion/flow reference bidirectional and keep Artifact citations exactly equal to content citations.",
    "Once the complete PRD candidate passes local reasoning checks, publish that complete renderable candidate with workbench_artifact_draft_publish so the document becomes visible, then submit the identical final candidate through workbench_runtime_result_submit. Do not emit Markdown or add wrapper fields.",
    "</workbench_prd_result_contract>",
  ].join("\n");
}
