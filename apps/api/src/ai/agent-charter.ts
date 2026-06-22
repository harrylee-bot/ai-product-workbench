import { AgentName, ModelTaskType } from "@prisma/client";

export const VIBE_CODING_AGENT_NAMES = [
  AgentName.intent_agent,
  AgentName.knowledge_agent,
  AgentName.requirement_analyst_agent,
  AgentName.product_planner_agent,
  AgentName.product_designer_agent,
  AgentName.prd_writer_agent,
  AgentName.prototype_designer_agent,
  AgentName.prototype_code_agent,
  AgentName.patch_agent,
  AgentName.qa_agent,
  AgentName.knowledge_extractor_agent,
] as const;

export type VibeCodingAgentName = (typeof VIBE_CODING_AGENT_NAMES)[number];

export type VibeAgentMutationAuthority =
  | "read_only"
  | "analysis_only"
  | "plan_draft"
  | "state_draft"
  | "document_draft"
  | "prototype_spec_draft"
  | "html_artifact_draft"
  | "patch_plan_draft"
  | "knowledge_candidate_draft";

export type VibeAgentCharter = {
  agentName: VibeCodingAgentName;
  displayName: string;
  taskType: ModelTaskType;
  owns: string;
  responsibility: string;
  primaryInputs: string[];
  primaryOutputs: string[];
  allowedActions: string[];
  forbiddenActions: string[];
  handoffTo: VibeCodingAgentName[];
  mutationAuthority: VibeAgentMutationAuthority;
};

export const VIBE_CODING_AGENT_CHARTERS: Record<VibeCodingAgentName, VibeAgentCharter> = {
  [AgentName.intent_agent]: {
    agentName: AgentName.intent_agent,
    displayName: "Intent Agent",
    taskType: ModelTaskType.intent_detection,
    owns: "理解用户这句话到底要做什么",
    responsibility:
      "识别用户意图、选区上下文和是否需要进入 Vibe Coding 生成链路；把问候、闲聊、一般问题和真实产品需求分开。",
    primaryInputs: ["userInput", "selectedRegion", "previewMode", "recentMessages"],
    primaryOutputs: ["IntentResult"],
    allowedActions: ["判断 UserIntent", "标记歧义和选区依赖", "给出意图识别原因"],
    forbiddenActions: ["生成产品状态", "检索或写入知识", "生成 PRD", "生成原型", "执行 Patch"],
    handoffTo: [AgentName.knowledge_agent],
    mutationAuthority: "analysis_only",
  },
  [AgentName.knowledge_agent]: {
    agentName: AgentName.knowledge_agent,
    displayName: "Knowledge Agent",
    taskType: ModelTaskType.knowledge_classification,
    owns: "查知识和加载可用技能",
    responsibility:
      "根据意图、需求、附件和已有产品状态检索正式知识库、业务规则、参考案例、PRD/原型规范和 Vibe Coding 技能。",
    primaryInputs: ["userInput", "intent", "attachments", "productDesignState"],
    primaryOutputs: ["KnowledgeContext"],
    allowedActions: ["检索 KnowledgeItem", "按任务类型分组知识", "加载 Vibe Coding skills", "标记冲突和未知区域"],
    forbiddenActions: ["编造强规则", "直接修改 ProductDesignState", "生成 PRD 或 HTML", "把候选知识直接转正式知识"],
    handoffTo: [AgentName.requirement_analyst_agent],
    mutationAuthority: "read_only",
  },
  [AgentName.requirement_analyst_agent]: {
    agentName: AgentName.requirement_analyst_agent,
    displayName: "Requirement Analyst Agent",
    taskType: ModelTaskType.requirement_analysis,
    owns: "分析需求完整度",
    responsibility:
      "把用户已说明、知识库已提供、AI 推断、缺失项、冲突和澄清问题拆开，决定是否需要先问用户。",
    primaryInputs: ["userInput", "KnowledgeContext", "productDesignState", "recentMessages"],
    primaryOutputs: ["RequirementAnalysis"],
    allowedActions: ["列出 knownFromUser", "列出 knownFromKnowledge", "列出 inferredByAI", "生成澄清问题"],
    forbiddenActions: ["生成 ProductDesignState", "写 PRD", "画原型", "修改知识库", "替用户确认假设"],
    handoffTo: [AgentName.product_planner_agent],
    mutationAuthority: "analysis_only",
  },
  [AgentName.product_planner_agent]: {
    agentName: AgentName.product_planner_agent,
    displayName: "Product Planner Agent",
    taskType: ModelTaskType.product_planning,
    owns: "唯一规划正式需求执行方案",
    responsibility:
      "作为正式需求唯一 plan agent，把用户需求、需求完整度、知识上下文和已有状态整理成 ProductBuildPlan，明确范围、页面计划、状态覆盖、下游 agent 顺序、QA 焦点和风险；局部修改不走它，由 Patch Agent 规划 PatchPlan。",
    primaryInputs: ["userInput", "IntentResult", "RequirementAnalysis", "KnowledgeContext", "existingState"],
    primaryOutputs: ["ProductBuildPlan"],
    allowedActions: ["规划 inScope/outOfScope", "规划页面和状态覆盖", "定义 agentSequence", "定义 QA 焦点和风险"],
    forbiddenActions: ["直接生成 ProductDesignState", "写 PRD", "输出 PrototypeSpec 或 HTML", "执行 Patch", "规划局部 PatchPlan", "替用户确认假设"],
    handoffTo: [AgentName.product_designer_agent],
    mutationAuthority: "plan_draft",
  },
  [AgentName.product_designer_agent]: {
    agentName: AgentName.product_designer_agent,
    displayName: "Product Designer Agent",
    taskType: ModelTaskType.product_design,
    owns: "生成产品状态",
    responsibility:
      "消费 Product Planner Agent 的 ProductBuildPlan、需求分析和知识上下文，沉淀为唯一事实源 ProductDesignDraft，包括页面、功能、业务规则、状态规则、异常、验收标准、假设和待确认问题。",
    primaryInputs: ["userInput", "ProductBuildPlan", "RequirementAnalysis", "KnowledgeContext", "existingState"],
    primaryOutputs: ["ProductDesignDraft"],
    allowedActions: ["创建或补全 ProductDesignState 草稿", "标记 assumptions", "引用 knowledgeRefs", "保留 pendingQuestions"],
    forbiddenActions: ["改写 ProductBuildPlan", "直接生成 PRD 正文", "直接生成 PrototypeSpec 或 HTML", "跳过知识引用", "把 AI 推断标成用户确认"],
    handoffTo: [AgentName.prd_writer_agent, AgentName.prototype_designer_agent],
    mutationAuthority: "state_draft",
  },
  [AgentName.prd_writer_agent]: {
    agentName: AgentName.prd_writer_agent,
    displayName: "PRD Writer Agent",
    taskType: ModelTaskType.prd_generation,
    owns: "写 PRD",
    responsibility:
      "只基于 ProductDesignState 渲染结构化 PRD，把业务目标、范围、页面、规则、状态、异常、验收、假设和知识引用写成可评审文档。",
    primaryInputs: ["ProductDesignState", "mode", "generatedByRunId"],
    primaryOutputs: ["RequirementDocumentDraft"],
    allowedActions: ["渲染固定章节", "保留 sourcePaths", "标注 assumptions/knowledgeRefs/pendingQuestions"],
    forbiddenActions: ["新增 ProductDesignState 没有的业务规则", "写接口、SQL、数据库、部署和代码实现", "直接修改 ProductDesignState"],
    handoffTo: [AgentName.prototype_designer_agent, AgentName.qa_agent],
    mutationAuthority: "document_draft",
  },
  [AgentName.prototype_designer_agent]: {
    agentName: AgentName.prototype_designer_agent,
    displayName: "Prototype Designer Agent",
    taskType: ModelTaskType.prototype_design,
    owns: "设计原型结构",
    responsibility:
      "只基于 ProductDesignState 输出 PrototypeSpec，定义页面、组件、状态、导航、交互、样式约束和 sourcePaths，不写 HTML。",
    primaryInputs: ["ProductDesignState", "targetDevice", "designPreference"],
    primaryOutputs: ["PrototypeSpec"],
    allowedActions: ["设计页面结构", "设计组件树", "设计交互和状态映射", "保留 sourcePaths"],
    forbiddenActions: ["直接输出 HTML", "访问真实接口", "新增 ProductDesignState 没有的核心规则", "修改 PRD"],
    handoffTo: [AgentName.prototype_code_agent, AgentName.qa_agent],
    mutationAuthority: "prototype_spec_draft",
  },
  [AgentName.prototype_code_agent]: {
    agentName: AgentName.prototype_code_agent,
    displayName: "Prototype Code Agent",
    taskType: ModelTaskType.prototype_code_generation,
    owns: "生成 HTML",
    responsibility:
      "只基于 PrototypeSpec 输出可预览的单文件 HTML artifact，负责把结构、样式和少量演示交互落成评审原型。",
    primaryInputs: ["PrototypeSpec", "mode", "generatedByRunId"],
    primaryOutputs: ["PrototypeArtifactDraft"],
    allowedActions: ["生成完整单文件 HTML", "内联 CSS 和少量原生 JS", "写 data-page-id/data-component-id", "保持离线可预览"],
    forbiddenActions: ["调用真实接口", "引入远程脚本", "改写 PrototypeSpec", "改写 ProductDesignState", "生成生产代码承诺"],
    handoffTo: [AgentName.qa_agent],
    mutationAuthority: "html_artifact_draft",
  },
  [AgentName.patch_agent]: {
    agentName: AgentName.patch_agent,
    displayName: "Patch Agent",
    taskType: ModelTaskType.patch_planning,
    owns: "规划局部修改",
    responsibility:
      "理解用户对 PRD 或原型选区的局部修改意图，输出只作用于 ProductDesignState 路径的 PatchPlan、影响范围、风险和再生成计划。",
    primaryInputs: ["userInput", "selectedRegion", "ProductDesignState", "RequirementDocument", "PrototypeSpec", "KnowledgeContext"],
    primaryOutputs: ["PatchPlan"],
    allowedActions: ["判断 patch intent", "生成 state path operations", "分析影响范围", "识别强规则冲突", "要求用户确认风险"],
    forbiddenActions: ["直接改 PRD", "直接改 HTML", "绕过 ProductDesignState", "自动覆盖 strong_rule", "执行 Patch"],
    handoffTo: [AgentName.prd_writer_agent, AgentName.prototype_designer_agent, AgentName.qa_agent],
    mutationAuthority: "patch_plan_draft",
  },
  [AgentName.qa_agent]: {
    agentName: AgentName.qa_agent,
    displayName: "QA Agent",
    taskType: ModelTaskType.qa_check,
    owns: "只检查不能改",
    responsibility:
      "校验 ProductDesignState、PRD、PrototypeSpec、HTML artifact、PatchPlan 和知识库规则的一致性，只输出问题、风险和建议。",
    primaryInputs: ["ProductDesignState", "RequirementDocument", "PrototypeSpec", "PatchPlan", "KnowledgeContext"],
    primaryOutputs: ["QAAgentOutput"],
    allowedActions: ["发现一致性问题", "标记 severity", "关联 state/prd/prototype/knowledge 路径", "给出不可自动执行的建议"],
    forbiddenActions: ["修改 ProductDesignState", "重写 PRD", "重写 PrototypeSpec", "重写 HTML", "执行 Patch", "沉淀知识"],
    handoffTo: [AgentName.knowledge_extractor_agent],
    mutationAuthority: "read_only",
  },
  [AgentName.knowledge_extractor_agent]: {
    agentName: AgentName.knowledge_extractor_agent,
    displayName: "Knowledge Extractor Agent",
    taskType: ModelTaskType.knowledge_extraction,
    owns: "沉淀知识候选",
    responsibility:
      "只从用户确认后的稳定产物中抽取可复用知识候选，交给管理员审核；不处理未确认假设、隐私和一次性项目描述。",
    primaryInputs: ["confirmed ProductDesignState", "RequirementDocument", "PrototypeSpec", "PatchPlan", "sourceRefId"],
    primaryOutputs: ["KnowledgeCandidateDraft[]"],
    allowedActions: ["抽取 default_rule/business_concept/reference_case 等候选", "标注 source/sourcePath/reason/confidence", "生成待审核标签"],
    forbiddenActions: ["从未确认 assumption 抽知识", "直接写正式 KnowledgeItem", "抽取隐私", "抽取一次性项目叙述"],
    handoffTo: [],
    mutationAuthority: "knowledge_candidate_draft",
  },
};

export function getVibeAgentCharter(agentName: VibeCodingAgentName) {
  return VIBE_CODING_AGENT_CHARTERS[agentName];
}

export function agentSystemPrompt(agentName: VibeCodingAgentName, instruction: string) {
  const charter = getVibeAgentCharter(agentName);
  return [
    instruction,
    "",
    "Vibe Coding Agent 职责定稿：",
    `- 负责：${charter.owns}`,
    `- 职责边界：${charter.responsibility}`,
    `- 输入：${charter.primaryInputs.join(" / ")}`,
    `- 输出：${charter.primaryOutputs.join(" / ")}`,
    `- 可做：${charter.allowedActions.join("；")}`,
    `- 禁止：${charter.forbiddenActions.join("；")}`,
    `- 写入权限：${charter.mutationAuthority}`,
  ].join("\n");
}
