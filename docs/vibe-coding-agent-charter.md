# Vibe Coding Agent 职责定稿

当前运行时的完整执行顺序、状态流转、事件和调试方式见 `docs/vibe-coding-execution-chain.md`。本文只定义 agent 职责边界。

## 总原则

Vibe Coding 的主链路只保留一套新版 agent。所有产物围绕 `ProductDesignState` 这个唯一事实源流转：先理解用户输入，再查知识，再分析需求完整度，再规划正式需求执行方案，再生成产品状态，之后由 PRD、原型结构、HTML、QA、知识沉淀各自负责自己的边界。

任何 agent 都不能越权替下游生成产物，也不能把 AI 推断伪装成用户确认。正式需求先生成 `ProductBuildPlan`，再落到 `ProductDesignState`；局部修改先生成 `PatchPlan`，再进入 State 版本化流程。

## 系统级需求与 Agent 契约

本文定义 agent 在系统中的职责边界。完整系统需求、后端需求、前端需求和事件契约以 `docs/vibe-coding-execution-chain.md` 为准。

### 产品系统需求

Vibe Coding 作为完整系统必须满足以下需求：

- 用户输入自然语言后，系统能生成可审阅 PRD、可交互 HTML 原型、QA 报告和知识候选。
- 所有正式产物都能追溯到 `ProductDesignState`，不能让 PRD、原型、HTML、Patch 各自分叉。
- 系统必须显式区分 Phase A、Phase B、Patch 候选、Patch 应用、导出、普通问答。
- 系统目标执行方式应是 DAG，而不是线性 agent 串联：`Intent -> Knowledge/Context/Requirement -> Planner/Validator/Safety -> State/Artifacts`。
- 每个 run 必须有明确终态：等待确认、完成、失败、下载、问答回复或澄清。
- 模型 fallback、QA 风险、强规则冲突、未确认假设必须可见，不能伪装成完全正常结果。
- 用户确认是硬边界。未确认的 assumption 不能沉淀成正式知识，也不能被下游当作用户事实。

目标前半链路：

```text
Intent
  ├── Knowledge (async)
  ├── Context fetch (async)
  └── Requirement
        ├── Planner
        ├── Validator
        └── Safety check
```

这条链路里的 `Validator` 和 `Safety check` 是生成前 gate，不是生成后 QA。QA 仍然只负责产物生成后的质量检查。

### 后端执行需求

后端负责把 agent 输出变成可靠的系统状态，但 agent 自身不能直接越权改库。

- `AiOrchestratorService` 是主链路编排入口，负责 agent 顺序、分支、确认门、step log、stream event 和 run 终态。
- `PatchService` 是局部修改编排入口，负责 Patch 候选、Patch 确认、State version 校验、产物重算和失败回滚。
- `ProductDesignStateService` 是 State 写入与版本化边界。agent 只能输出 draft 或 plan，不能直接写 State 表。
- `Context fetch` 应作为独立编排职责，读取 State、recentMessages、PRD、Prototype、selectedRegion、attachments，不应隐含在某个模型 agent 里。
- `Validator` 应作为 State mutation 前的结构校验职责，检查需求、计划、Patch、sourcePaths、版本条件是否完整一致。
- `Safety check` 应作为生成与写入前的安全校验职责，检查提示注入、真实接口调用、密钥泄漏、隐私、越权和 strong rule 冲突。
- `RequirementDocumentService`、`PrototypeArtifactService`、`QaService` 等服务负责保存正式产物，agent 只负责生成结构化草稿或检查结果。
- 每个 agent step 都必须写 `agent_step_logs`，关键事件必须写 `vibe_stream_event_logs`。
- 每个模型调用必须经过 Model Gateway，记录 taskType、agentName、provider、耗时、错误码和 token usage。
- 后端必须把 fallback 作为一等事件处理：写入 step output，发送 `fallback_used`，必要时影响 QA 或确认门提示。
- 后端必须为 run 和 step 提供时间边界、失败终态和并发保护，不能依赖前端超时来结束用户等待。

### 前端展示需求

前端负责把后端事件解释成用户可理解的阶段状态，但不能自行推断或伪造 agent 结果。

- 前端应以 stream event 和 `GET /runs/:runId` 为事实来源，不能根据本地 loading 状态判断链路是否完成。
- 前端执行路径必须阶段感知：Phase A 不应把原型、QA、知识抽取显示成“卡住”；Patch 候选和 Patch 应用必须区分。
- 前端必须展示确认门：`review_prd`、`review_prototype`、`confirm_patch` 分别对应不同按钮和说明。
- 前端必须展示 fallback、QA issue、Patch 风险、澄清问题和失败原因。
- 前端发起局部修改时，必须携带准确 `selectedRegion`，包括目标类型、目标 id、组件/段落/区块 id 和必要上下文。
- 前端收到 `prd_updated`、`prototype_updated`、`qa_completed`、`patch_completed` 后必须刷新对应预览，避免展示旧产物。

### Agent 输出契约

所有 agent 输出都要满足以下契约：

- 输出必须是结构化 JSON 或明确的结构化草稿，字段应能被后端 schema 校验。
- 输出必须保留 `sourcePaths`、`knowledgeRefs`、`assumptions`、`pendingQuestions` 或等价溯源字段。
- 输出里的 AI 推断必须标记为 assumption，不能写成用户已确认事实。
- 输出不得包含 provider key、用户 token、真实接口调用、数据库 SQL 或生产部署指令，除非该 agent 明确负责相关能力；当前 Vibe Coding agent 均不负责生产代码落地。
- 输出不得命令前端或后端绕过确认门、绕过 State、绕过 QA、绕过知识审核。
- 如果使用 fallback，输出必须仍满足最小 schema，并通过 fallback metadata 说明降级方式和可信度。

### Intake DAG 契约

目标 Intake DAG 的核心中间产物是 `RequirementPackage`。它不是一个展示产物，而是 Planner、Validator、Safety check 的共同输入。

`RequirementPackage` 至少包含：

```text
intent
flowType
userFacts
knowledgeFacts
contextSnapshotRefs
selectedRegionContext
missingRequiredInfo
conflicts
assumptions
constraints
requiredArtifacts
sourcePaths
traceRefs
```

约束：

- Planner、Validator、Safety check 不应各自重新拼上下文；它们都应消费同一个 `RequirementPackage`。
- `RequirementPackage` 中的用户事实、知识事实、AI assumption 必须分开标记。
- `Context fetch` 只负责读，不负责判断；`Requirement merge` 才负责把上下文、知识和用户事实合并成包。
- `RequirementPackage` 必须带 trace refs，方便从产物反查到 run、step、knowledge item、state version、selected region。

Planner 输出：

```text
PlanCandidate = ProductBuildPlan | PatchPlan
```

Validator 输出：

```text
ValidationResult
  status: pass | warn | block
  missingFields
  conflicts
  invalidOperations
  requiredClarifications
  canAutoContinue
  userMessage
```

Safety check 输出：

```text
SafetyCheckResult
  status: pass | warn | block
  riskTypes
  blockedReasons
  safeAlternative
  userMessage
```

Intake Gate 输出：

```text
GateDecision
  action: continue | degraded_continue | ask_clarification | blocked | failed
  reasons
  visibleMessage
  canGenerateArtifacts
  canApplyPatch
  fallbackUsed
```

只有 `GateDecision.action` 为 `continue` 或 `degraded_continue` 时，后端才能进入 `ProductDesignState` mutation、PRD generation、Prototype generation 或 Patch apply。

### 前后端与 Agent 边界

| 事项 | Agent 负责 | 后端负责 | 前端负责 |
|---|---|---|---|
| 理解意图 | 输出 `IntentResult` | 根据 intent 分支 | 展示当前任务类型 |
| 查知识 | 输出 `KnowledgeContext` | 读取知识库和附件摘要 | 不直接改知识 |
| 获取上下文 | 不应由某个模型 agent 独占 | 并行读取 State、recentMessages、PRD、Prototype、选区、附件 | 按需提供 selectedRegion 和当前预览目标 |
| 判断是否澄清 | 输出 `RequirementAnalysis.shouldAskUser` | 生成澄清消息和 run 终态 | 展示澄清问题 |
| 规划正式需求 | 输出 `ProductBuildPlan` | 校验并传给 Product Designer | 不展示为最终 PRD |
| 结构校验 | Validator 输出通过、警告或阻断原因 | 阻断不完整/不一致/不可执行计划 | 展示需要补充或修正的原因 |
| 安全校验 | Safety check 输出风险等级和阻断原因 | 阻断注入、密钥、隐私、越权、真实接口风险 | 展示安全阻断或降级提示 |
| 生成 State | 输出 `ProductDesignDraft` | 创建/版本化 `ProductDesignState` | 根据状态刷新预览 |
| 写 PRD | 输出 PRD draft | 保存 document/sections | 展示和支持确认 |
| 生成原型 | 输出 PrototypeSpec/HTML draft | 保存 prototype artifact | 展示 HTML 和选区 |
| 局部修改 | 输出 `PatchPlan` | 创建候选、确认后应用、失败回滚 | 展示候选和确认按钮 |
| QA | 输出检查结果 | 保存 QA 报告和 gate | 展示 issue 与 gate |
| 知识沉淀 | 输出候选 | 保存待审核候选 | 展示或隐藏审核提示 |

## 职责矩阵

| 问题 | 负责 agent | 产物 | 边界 |
|---|---|---|---|
| 谁负责理解需求 | Intent Agent | `IntentResult` | 只判断用户意图、是否闲聊、是否需要选区和是否进入生成链路 |
| 谁负责查知识 | Knowledge Agent | `KnowledgeContext` | 只读正式知识库、附件摘要和 Vibe Coding skills，不直接写知识 |
| 谁负责取上下文 | Context Fetch | `RunContext` | 只读项目状态、历史消息、PRD、原型、选区和附件，不做业务判断 |
| 谁负责分析需求完整度 | Requirement Analyst Agent | `RequirementAnalysis` | 只拆已知事实、缺失项、冲突、AI 推断和澄清问题，不生成产品状态 |
| 谁负责规划正式需求 | Product Planner Agent | `ProductBuildPlan` | 只规划范围、页面、状态、agentSequence、QA 焦点和风险，不直接生成 State/PRD/HTML |
| 谁负责生成前校验 | Validator | `ValidationResult` | 只校验需求/计划/patch 的完整性、一致性和可执行性，不生成产物 |
| 谁负责安全检查 | Safety Check | `SafetyCheckResult` | 只校验注入、隐私、越权、真实接口、密钥和强规则冲突，不生成产物 |
| 谁负责生成产品状态 | Product Designer Agent | `ProductDesignDraft` | 按 ProductBuildPlan 生成唯一事实源草稿，必须标记 assumptions、knowledgeRefs、pendingQuestions |
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

### Context Fetch

负责读取运行上下文。它不是必须模型化的 agent，更适合作为确定性编排步骤：并行读取 `ProductDesignState`、最近消息、当前 PRD、当前 Prototype、QA 报告、选区上下文和附件摘要，输出 `RunContext`。

禁止：业务推断、改写上下文、生成需求、写 State、写 PRD、生成原型。

### Requirement Analyst Agent

负责分析需求完整度。它区分用户已确认事实、知识库事实、AI 推断、缺失关键项、可选缺失项和冲突，并决定是否需要澄清。

禁止：生成 ProductDesignState、写 PRD、画原型、修改知识库、替用户确认假设。

### Product Planner Agent

负责规划正式需求执行方案。它把用户需求、需求完整度、知识上下文和已有状态整理成 `ProductBuildPlan`，明确 inScope/outOfScope、页面计划、状态覆盖、下游 agentSequence、QA 焦点和风险。

禁止：直接生成 ProductDesignState、写 PRD、输出 PrototypeSpec 或 HTML、执行 Patch、替用户确认假设。

### Validator

负责生成前校验。它检查 `RequirementAnalysis`、`ProductBuildPlan`、`PatchPlan`、`RunContext` 与 knowledge rules 是否一致，判断是否可以进入 State mutation 或是否必须澄清、降级、阻断。

禁止：生成 ProductDesignState、改写 ProductBuildPlan、写 PRD、生成原型、自动修复强规则冲突。

### Safety Check

负责安全与边界校验。它检查提示注入、越权访问、隐私泄漏、密钥泄漏、真实接口调用、远程脚本、生产实现承诺、strong rule 冲突和不应进入原型的敏感内容。

禁止：生成业务方案、修改 State、写 PRD、写 HTML、把高风险内容静默降级成正常结果。

### Product Designer Agent

负责生成产品状态。它把 `ProductBuildPlan`、需求分析和知识上下文转为 `ProductDesignDraft`，覆盖页面、功能、后台配置、前端规则、业务规则、状态规则、异常场景、验收标准、assumptions、knowledgeRefs 和 pendingQuestions。

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

目标主链路不是线性串行，而是前半段 DAG + 后半段产物链：

```text
Intent
  ├── Knowledge (async)
  ├── Context fetch (async)
  └── Requirement
        ├── Planner
        ├── Validator
        └── Safety check
```

Planner、Validator、Safety check 通过后，才进入产物链：

```text
ProductDesignState
  -> PRD Writer Agent
  -> PRD Confirm Gate
  -> Prototype Designer Agent
  -> Prototype Code Agent
  -> QA Agent
  -> Knowledge Extractor Agent
```

局部修改目标链路：

```text
Selected Region + User Instruction
  -> Intent Agent
  -> Knowledge Agent + Context Fetch
  -> Requirement Analyst Agent
  -> Patch Agent
  -> Validator
  -> Safety Check
  -> ProductDesignState version
  -> PRD Writer Agent
  -> Prototype Designer Agent
  -> Prototype Code Agent
  -> QA Agent
  -> Knowledge Extractor Agent
```
