import type { StartRunRequest } from "@workbench/workbench-contracts";

export const WORKBENCH_MIXED_ARTIFACT_REQUEST_MESSAGE =
  "需求文档可与原型一起生成，其他产物类型请单独发起。";

export function assertRunnableArtifactRequest(
  requestedArtifactKinds: readonly StartRunRequest["requestedArtifactKinds"][number][],
): void {
  const requestsPrd = requestedArtifactKinds.includes("prd");
  const requestsPrototypeWork = requestedArtifactKinds.some(
    (kind) => kind !== "prd" && kind !== "prototype",
  );
  if (requestsPrd && requestsPrototypeWork) {
    throw new Error(WORKBENCH_MIXED_ARTIFACT_REQUEST_MESSAGE);
  }
}
