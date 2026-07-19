import type { StartRunRequest } from "@workbench/workbench-contracts";

export function requestedArtifactKindsForPrompt(
  prompt: string,
  options: { prdContext?: boolean } = {},
): StartRunRequest["requestedArtifactKinds"] {
  const requestsPrototype = /\bui\b|界面|原型/iu.test(prompt);
  const requestsPrd = /需求文档|\bprd\b/iu.test(prompt);
  return !requestsPrototype && (requestsPrd || options.prdContext)
    ? ["prd"]
    : ["prototype"];
}
