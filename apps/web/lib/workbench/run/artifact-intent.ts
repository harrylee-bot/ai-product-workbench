import type { StartRunRequest } from "@workbench/workbench-contracts";

export const WORKBENCH_MIXED_ARTIFACT_REQUEST_MESSAGE =
  "一次运行只能生成需求文档或原型。请先完成需求文档，再发起原型生成。";

const artifactOutputAction = "(?:生成|创建|编写|撰写|输出|产出|制作|整理|写|create|write|build|produce)";
const prdArtifactTerm = "(?:需求(?:文档|说明书|说明)|需求规格(?:说明书)?|\\bprd\\b|product\\s+requirements?\\s+document)";
const prototypeArtifactTerm = "(?:\\bui\\b|\\bprototype\\b|界面|原型)";
const explicitPrdOutputPattern = new RegExp(
  `${artifactOutputAction}(?:一份|一个)?(?:完整|详细|新)?(?:的)?\\s*(?:产品)?\\s*${prdArtifactTerm}`,
  "iu",
);
const explicitPrototypeOutputPattern = new RegExp(
  `${artifactOutputAction}(?:一份|一个)?(?:完整|详细|新|高保真|低保真)?(?:的)?\\s*(?:页面|交互)?\\s*${prototypeArtifactTerm}`,
  "iu",
);
const pairedArtifactsPattern = new RegExp(
  `(?:${prdArtifactTerm}[^。！？;\\n]{0,24}(?:和|与|及|、|以及|并(?:且)?|再|然后|and|plus|then)[^。！？;\\n]{0,24}${prototypeArtifactTerm}|${prototypeArtifactTerm}[^。！？;\\n]{0,24}(?:和|与|及|、|以及|并(?:且)?|再|然后|and|plus|then)[^。！？;\\n]{0,24}${prdArtifactTerm})`,
  "iu",
);
const artifactOutputActionPattern = new RegExp(artifactOutputAction, "iu");
const artifactClauseBoundaryPattern = /[。！？.!?；;\r\n]+/u;

function explicitlyRequestsBothAcrossClauses(prompt: string): boolean {
  let sawExplicitPrdClause = false;
  let sawExplicitPrototypeClause = false;

  for (const clause of prompt.split(artifactClauseBoundaryPattern)) {
    const explicitlyRequestsPrd = explicitPrdOutputPattern.test(clause);
    const explicitlyRequestsPrototype = explicitPrototypeOutputPattern.test(clause);
    if (
      (explicitlyRequestsPrd && sawExplicitPrototypeClause)
      || (explicitlyRequestsPrototype && sawExplicitPrdClause)
    ) {
      return true;
    }
    sawExplicitPrdClause ||= explicitlyRequestsPrd;
    sawExplicitPrototypeClause ||= explicitlyRequestsPrototype;
  }

  return false;
}

export function requestedArtifactKindsForPrompt(
  prompt: string,
  options: { prdContext?: boolean } = {},
): StartRunRequest["requestedArtifactKinds"] {
  const requestsPrototype = /\bui\b|\bprototype\b|界面|原型/iu.test(prompt);
  const requestsPrd = /需求(?:文档|说明书|说明)|需求规格(?:说明书)?|\bprd\b|product\s+requirements?\s+document/iu.test(prompt);
  const explicitlyRequestsBoth = requestsPrd
    && requestsPrototype
    && (
      (
        pairedArtifactsPattern.test(prompt)
        && (
          artifactOutputActionPattern.test(prompt)
          || (explicitPrdOutputPattern.test(prompt) && explicitPrototypeOutputPattern.test(prompt))
          || /(?:\bplus\b|先[^。！？;\n]{0,24}(?:再|然后))/iu.test(prompt)
        )
      )
      || explicitlyRequestsBothAcrossClauses(prompt)
    );
  if (explicitlyRequestsBoth) return ["prd", "prototype"];
  return !requestsPrototype && (requestsPrd || options.prdContext)
    ? ["prd"]
    : ["prototype"];
}

export function assertRunnableArtifactRequest(
  requestedArtifactKinds: readonly StartRunRequest["requestedArtifactKinds"][number][],
): void {
  const requestsPrd = requestedArtifactKinds.includes("prd");
  const requestsPrototypeWork = requestedArtifactKinds.some(
    (kind) => kind === "prototype" || kind === "code",
  );
  if (requestsPrd && requestsPrototypeWork) {
    throw new Error(WORKBENCH_MIXED_ARTIFACT_REQUEST_MESSAGE);
  }
}
