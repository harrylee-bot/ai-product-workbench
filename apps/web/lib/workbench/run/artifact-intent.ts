import type { StartRunRequest } from "@workbench/workbench-contracts";

export const WORKBENCH_MIXED_ARTIFACT_REQUEST_MESSAGE =
  "一次运行只能生成需求文档或原型。请先完成需求文档，再发起原型生成。";

const artifactOutputAction = "(?:生成|创建|编写|撰写|输出|产出|制作|整理|设计|做成|做|写|提供|准备|规划|给我|给出|需要|想要|要|create|write|build|produce|generate|design|make|draft|provide|prepare|plan|give\\s+me|would\\s+like|need|want|request)";
const prdArtifactTerm = "(?:产品需求规格(?:说明书)?|需求规格(?:说明书)?|产品需求(?:文档|说明书|说明)?|需求(?:文档|说明书|说明)|\\bprd\\b|\\bproduct\\s+requirements?\\s+documents?\\b|\\brequirements?\\s+documents?\\b|\\brequirements?\\b)";
const chineseArtifactContextSuffix = "(?!(?:的|之)?(?:验收(?:标准|条件)?|测试(?:标准|用例)?|流程|规范|指南|文案|内容|说明|需求|规则|约束|状态|数据|字段|信息|布局|设计|原型))";
const englishArtifactContextSuffix = "(?!['’]?s?\\s+(?:acceptance(?:\\s+(?:criteria|standards?))?|test(?:\\s+(?:criteria|cases?))?|user\\s+flows?|flows?|guidelines?|copy|content|requirements?|spec(?:ification)?s?|rules?|constraints?|states?|data|fields?|information|layout|design\\s+system))";
const prototypeCoreArtifactTerm = `(?:\\bui\\b${englishArtifactContextSuffix}|\\bprototypes?\\b${englishArtifactContextSuffix}|\\binterfaces?\\b${englishArtifactContextSuffix}|界面(?:设计|原型)?${chineseArtifactContextSuffix}|原型${chineseArtifactContextSuffix})`;
const prototypePageArtifactTerm = `(?:页面(?:设计|原型)?${chineseArtifactContextSuffix}|网页(?:设计|原型)?${chineseArtifactContextSuffix}|前端(?:页面|界面)${chineseArtifactContextSuffix}|\\b(?:(?:web|front[-\\s]?end)\\s+)?pages?\\b${englishArtifactContextSuffix}|\\b(?:app\\s+)?screens?\\b${englishArtifactContextSuffix}|\\bmockups?\\b${englishArtifactContextSuffix}|\\bwireframes?\\b${englishArtifactContextSuffix})`;
const prototypeArtifactTerm = `(?:${prototypeCoreArtifactTerm}|${prototypePageArtifactTerm})`;
const artifactOutputDeterminer = "(?:(?:一份|一个|一套|一版)|(?:a|an|the)\\b)?";
const artifactOutputModifier = "(?:(?:完整|详细|新|高保真|低保真)|(?:complete|detailed|new|interactive|high[-\\s]?fidelity|low[-\\s]?fidelity)\\b)?";
const artifactOutputPrefix = `${artifactOutputAction}\\s*${artifactOutputDeterminer}\\s*${artifactOutputModifier}\\s*(?:的)?\\s*`;
const explicitPrdOutputPattern = new RegExp(
  `${artifactOutputPrefix}${prdArtifactTerm}`,
  "iu",
);
const explicitPrototypeOutputPattern = new RegExp(
  `${artifactOutputPrefix}${prototypeArtifactTerm}`,
  "iu",
);
const artifactPairConnector = "(?:和|与|及|、|以及|并(?:且)?|同时|一并|随后|接着|再|然后|\\+|&|\\band\\b|\\bplus\\b|\\bthen\\b|\\btogether\\s+with\\b|\\balongside\\b|\\bas\\s+well\\s+as\\b|\\bfollowed\\s+by\\b)";
const pairedArtifacts = `(?:${prdArtifactTerm}[^。！？;\\n]{0,24}${artifactPairConnector}[^。！？;\\n]{0,24}${prototypeArtifactTerm}|${prototypeArtifactTerm}[^。！？;\\n]{0,24}${artifactPairConnector}[^。！？;\\n]{0,24}${prdArtifactTerm})`;
const pairedArtifactsPattern = new RegExp(pairedArtifacts, "iu");
const explicitPairedArtifactsPattern = new RegExp(
  `${artifactOutputPrefix}${pairedArtifacts}`,
  "iu",
);
const barePairedArtifactsPattern = new RegExp(
  `^\\s*(?:please\\s+)?${pairedArtifacts}\\s*(?:please)?[。.!！]?\\s*$`,
  "iu",
);
const prdArtifactPattern = new RegExp(prdArtifactTerm, "iu");
const prototypeArtifactPattern = new RegExp(prototypeArtifactTerm, "iu");
const prototypeCoreArtifactPattern = new RegExp(prototypeCoreArtifactTerm, "iu");
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
  const mentionsPrd = prdArtifactPattern.test(prompt);
  const mentionsPrototype = prototypeArtifactPattern.test(prompt);
  const explicitlyRequestsPrototype = explicitPrototypeOutputPattern.test(prompt);
  const explicitlyRequestsBoth = mentionsPrd
    && mentionsPrototype
    && (
      (
        pairedArtifactsPattern.test(prompt)
        && (
          explicitPairedArtifactsPattern.test(prompt)
          || (explicitPrdOutputPattern.test(prompt) && explicitPrototypeOutputPattern.test(prompt))
          || barePairedArtifactsPattern.test(prompt)
          || /先[^。！？;\n]{0,24}(?:再|然后)/u.test(prompt)
        )
      )
      || explicitlyRequestsBothAcrossClauses(prompt)
    );
  if (explicitlyRequestsBoth) return ["prd", "prototype"];
  const requestsPrototype = prototypeCoreArtifactPattern.test(prompt)
    || explicitlyRequestsPrototype
    || (mentionsPrototype && !mentionsPrd);
  return !requestsPrototype && (mentionsPrd || options.prdContext)
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
