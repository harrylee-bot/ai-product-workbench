import type { StartRunRequest } from "@workbench/workbench-contracts";

const artifactOutputAction = "(?:生成|创建|编写|撰写|输出|产出|制作|整理|写)";
const prdArtifactTerm = "(?:需求(?:文档|说明书|说明)|需求规格(?:说明书)?|\\bprd\\b)";
const prototypeArtifactTerm = "(?:\\bui\\b|界面|原型)";
const explicitPrdOutputPattern = new RegExp(
  `${artifactOutputAction}(?:一份|一个)?(?:完整|详细|新)?(?:的)?\\s*(?:产品)?\\s*${prdArtifactTerm}`,
  "iu",
);
const explicitPrototypeOutputPattern = new RegExp(
  `${artifactOutputAction}(?:一份|一个)?(?:完整|详细|新|高保真|低保真)?(?:的)?\\s*(?:页面|交互)?\\s*${prototypeArtifactTerm}`,
  "iu",
);
const pairedArtifactsPattern = new RegExp(
  `(?:${prdArtifactTerm}[^。！？;\\n]{0,16}(?:和|与|及|、|以及|并(?:且)?|再|然后)[^。！？;\\n]{0,16}${prototypeArtifactTerm}|${prototypeArtifactTerm}[^。！？;\\n]{0,16}(?:和|与|及|、|以及|并(?:且)?|再|然后)[^。！？;\\n]{0,16}${prdArtifactTerm})`,
  "iu",
);
const artifactOutputActionPattern = new RegExp(artifactOutputAction, "u");

export function requestedArtifactKindsForPrompt(
  prompt: string,
  options: { prdContext?: boolean } = {},
): StartRunRequest["requestedArtifactKinds"] {
  const requestsPrototype = /\bui\b|界面|原型/iu.test(prompt);
  const requestsPrd = /需求(?:文档|说明书|说明)|需求规格(?:说明书)?|\bprd\b/iu.test(prompt);
  const explicitlyRequestsBoth = requestsPrd
    && requestsPrototype
    && (
      (artifactOutputActionPattern.test(prompt) && pairedArtifactsPattern.test(prompt))
      || (explicitPrdOutputPattern.test(prompt) && explicitPrototypeOutputPattern.test(prompt))
    );
  if (explicitlyRequestsBoth) return ["prd", "prototype"];
  return !requestsPrototype && (requestsPrd || options.prdContext)
    ? ["prd"]
    : ["prototype"];
}
