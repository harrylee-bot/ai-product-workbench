# Vibe Coding Agent 职责定稿

## 总原则

Vibe Coding 的主链路只保留一套新版 agent。所有产物围绕 `ProductDesignState` 这个唯一事实源流转：先理解用户输入，再查知识，再分析需求完整度，再生成产品状态，之后由 PRD、原型结构、HTML、QA、知识沉淀各自负责自己的边界。

任何 agent 都不能越权替下游生成产物，也不能把 AI 推断伪装成用户确认。需要修改产品内容时，必须通过 `ProductDesignState` 或 `PatchPlan` 进入版本化流程。

## 职责矩阵

| 问题 | 负责 agent | 产物 | 边界 |
|---|---|---|---|
| 谁负责理解需求 | Intent Agent | `IntentResult` | 只判断用户意图、是否闲聊、是否需要选区和是否进入生成链路 |
| 谁负责查知识 | Knowledge Agent | `KnowledgeContext` | 只读正式知识库、附件摘要和 Vibe Coding skills，不直接写知识 |
| 谁负责分析需求完整度 | Requirement Analyst Agent | `RequirementAnalysis` | 只拆已知事实、缺失项、冲突、AI 推断和澄清问题，不生成产品状态 |
| 谁负责生成产品状态 | Product Designer Agent | `ProductDesignDraft` | 负责唯一事实源草稿，必须标记 assumptions、knowledgeRefs、pendingQuestions |
| 谁负责写 PRD | PRD Writer Agent | `RequirementDocumentDraft` | 只能从 ProductDesignState 渲染 PRD，不写接口、SQL、数据库、部署或代码实现 |
| 谁负责原型结构 | Prototype Designer Agent | `PrototypeSpec` | 只能设计页面、组件、状态、导航和交互结构，不输出 HTML |
| 谁负责 HTML | Prototype Code Agent | `PrototypeArtifactDraft` | 只能从 PrototypeSpec 生成单文件 HTML，不调用真实接口、不引入远程脚本 |
| 谁负责局部修改规划 | Patch Agent | `PatchPlan` | 只生成作用于 ProductDesignState 路径的操作计划，不直接改 PRD/HTML/State |
| 谁只能检查不能改 | QA Agent | `QAAgentOutput` | 只输出问题、风险、severity 和建议，禁止修改任何业务产物 |
| 谁能沉淀知识 | Knowledge Extractor Agent | `KnowledgeCandidateDraft[]` | 只能从用户确认后的稳定产物抽候选，不能直接写正式 KnowledgeItem |

## Agent 定义

### Intent Agent

负责理解用户这句话到底要做什么。它识别 `new_requirement`、`generate_prd`、`generate_prototype`、`patch_document`、`patch_prototype`、`knowledge_update`、`general_question` 等意图，并判断是否依赖选区。

禁止：生成产品状态、查写知识、生成 PRD、生成原型、执行 Patch。

### Knowledge Agent

负责查知识和加载可用技能。它读取正式知识库、附件摘要、已有产品状态和 Vibe Coding skills，并按任务类型输出 strong rules、default rules、reference cases、PRD writing rules、prototype rules、business concepts 等上下文。

禁止：编造强规则、直接修改 ProductDesignState、生成 PRD/HTML、把候选知识直接转正式知识。

### Requirement Analyst Agent

负责分析需求完整度。它区分用户已确认事实、知识库事实、AI 推断、缺失关键项、可选缺失项和冲突，并决定是否需要澄清。

禁止：生成 ProductDesignState、写 PRD、画原型、修改知识库、替用户确认假设。

### Product Designer Agent

负责生成产品状态。它把需求分析和知识上下文转为 `ProductDesignDraft`，覆盖页面、功能、后台配置、前端规则、业务规则、状态规则、异常场景、验收标准、assumptions、knowledgeRefs 和 pendingQuestions。

禁止：直接写 PRD 正文、直接生成 PrototypeSpec 或 HTML、跳过知识引用、把 AI 推断标成用户确认。

### PRD Writer Agent

负责写 PRD。它只能基于 `ProductDesignState` 渲染结构化 PRD，保留 sourcePaths、assumptions、knowledgeRefs、pendingQuestions。

禁止：新增 ProductDesignState 没有的业务规则；禁止写接口 URL、请求参数、数据库、SQL、代码、技术架构、部署或前后端实现细节。

### Prototype Designer Agent

负责原型结构。它只能基于 `ProductDesignState` 输出 `PrototypeSpec`，定义 page、component、state、navigation、interaction、styleGuide 和 sourcePaths。

禁止：直接输出 HTML、访问真实接口、新增 ProductDesignState 没有的核心业务规则、修改 PRD。

### Prototype Code Agent

负责 HTML。它只能基于 `PrototypeSpec` 输出 `PrototypeArtifactDraft`，产物必须是单文件完整 HTML，内联 CSS 和少量原生 JS，关键元素必须带 `data-page-id` 和 `data-component-id`。

禁止：调用真实接口、引入远程脚本、改写 PrototypeSpec、改写 ProductDesignState、承诺生产代码质量。

### Patch Agent

负责局部修改规划。它理解 PRD 或原型选区上的修改意图，输出 `PatchPlan`，包括 ProductDesignState path operations、影响范围、强规则冲突、风险和再生成计划。

禁止：直接改 PRD、直接改 HTML、绕过 ProductDesignState、自动覆盖 strong_rule、执行 Patch。

### QA Agent

负责只检查不能改。它校验 ProductDesignState、PRD、PrototypeSpec、HTML artifact、PatchPlan 和知识规则的一致性，只输出 `QAAgentOutput`。

禁止：修改 ProductDesignState、重写 PRD、重写 PrototypeSpec、重写 HTML、执行 Patch、沉淀知识。

### Knowledge Extractor Agent

负责沉淀知识候选。它只从用户确认后的稳定 ProductDesignState、PRD、PrototypeSpec 或 Patch 结果中抽取可复用知识候选，输出 `KnowledgeCandidateDraft[]`，进入管理员审核。

禁止：从未确认 assumption 抽知识、直接写正式 KnowledgeItem、抽取隐私、抽取一次性项目描述。

## 主链路

```text
User Message
  -> Intent Agent
  -> Knowledge Agent
  -> Requirement Analyst Agent
  -> Product Designer Agent
  -> PRD Writer Agent
  -> Prototype Designer Agent
  -> Prototype Code Agent
  -> QA Agent
  -> Knowledge Extractor Agent
```

局部修改链路：

```text
Selected Region + User Instruction
  -> Intent Agent
  -> Knowledge Agent
  -> Patch Agent
  -> ProductDesignState version
  -> PRD Writer Agent
  -> Prototype Designer Agent
  -> Prototype Code Agent
  -> QA Agent
  -> Knowledge Extractor Agent
```
