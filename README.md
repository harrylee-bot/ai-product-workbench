# AI Product Workbench Triple System Fusion

当前目标是 AI Product Operating System，由三大核心系统融合：

```text
User Input / Market Signal
  -> Constraint System
  -> Decision System
  -> Evolution System
  -> CEO Layer
  -> Product Department
  -> Engineering Department
  -> Design Department
  -> QA Department
  -> Growth Department
  -> Evolution Department
  -> Intent Agent
  -> Decision Engine
  -> Review Board
  -> Strategy Selector
  -> Patch Builder
  -> Patch Preview / Execution Result
  -> Evolution Engine
  -> SystemPolicy Version
  -> Self-Generation Engine
  -> System Preview
  -> SystemGraph Version
```

Triple System Fusion 要求所有 AI 行为同时经过 Constraint / Decision / Evolution。Constraint 将知识转成 must_follow / prefer / avoid / warn，Decision 在约束下生成多策略并按 weightedScore 选择，Evolution 记录结果并更新 SystemPolicy。公司运行时继续保留，但必须在三系统之后被编排。

## 已实现能力

- 模块 1：登录、JWT 鉴权、角色权限、用户管理、前端权限路由。
- 模块 2：用户端工作台三栏布局、项目侧栏、需求对话、PRD/原型/QA 预览、底部可视区吸附输入框、加号扩展菜单。
- 模块 3：Project / Conversation / Message 数据模型，项目创建、列表、搜索、打开、重命名、归档、软删除，默认会话与消息落库。
- 模块 4：FileAsset / FileParseResult / FileChunk 数据模型，项目文件上传、解析状态管理、txt/md/docx/pdf/image/zip/rp 一期解析、附件 chips、消息附件摘要落库。
- 模块 5：ModelProvider / ModelConfig / ModelTaskProfile / ModelCallLog 数据模型，OpenAI-compatible 模型网关、文本生成、JSON 生成、流式输出、超时重试、token usage、调用日志、admin 配置 API、API Key 加密存储与脱敏返回。
- 模块 6：AI Orchestrator 串行调度新版 Vibe Coding Agent 链路，职责定稿见 `docs/vibe-coding-agent-charter.md`：Intent 负责理解需求，Knowledge 负责查知识，Requirement Analyst 负责需求完整度，Product Planner 负责正式需求执行方案 ProductBuildPlan，Product Designer 负责唯一事实源 ProductDesignState，PRD Writer 负责 PRD，Prototype Designer 负责原型结构，Prototype Code 负责 HTML，Patch 负责局部修改规划，QA 只检查不能改，Knowledge Extractor 只沉淀知识候选；Intent Agent 将纯问候、寒暄和致谢识别为 `general_question`，不触发需求澄清、PRD 或原型生成链路；所有 Agent 通过 Model Gateway 调用模型，未配置模型时使用结构化兜底输出；工作台通过 run stream 实时展示 Agent 时间线、PRD、HTML 原型和 QA 结果。
- 架构约束：`ProductDesignState` 是 PRD、Prototype、Patch、QA 的唯一事实源；正式需求必须先生成 ProductBuildPlan 再进入 State，局部修改必须先进入 PatchPlan/State PatchOperation，再重新生成衍生产物；约束说明见 `docs/product-design-state-single-source.md`。
- 模块 7：ProductDesignState / ProductDesignVersion / ProductDesignChangeLog 数据模型，状态创建、查询、更新、PatchOperation、版本快照、回滚、AI 推断确认/否定、澄清问题回答；工作台右侧新增“状态”Tab 展示版本、规则数量、AI 推断和待确认问题。
- 模块 8：RequirementDocument / RequirementDocumentVersion 数据模型，PRD Writer 从 ProductDesignState 渲染 16 个结构化章节，保存 sections / blocks / sourcePaths / tags，支持当前 PRD 查询、详情、预览、确认、版本列表；工作台 PRD 预览展示来源路径、AI 推断、知识库、已确认和待确认标签，并支持段落级定位入口。
- 模块 9：PrototypeSpecRecord / PrototypeArtifact / PrototypeVersion 数据模型，Prototype Designer 从 ProductDesignState 生成 PrototypeSpec，Prototype Code 生成单文件 HTML，保存 artifact 与版本，支持当前原型、详情、text/html 预览、确认、版本列表；工作台原型 Tab 使用 sandbox iframe 预览，支持桌面/移动模式和基于 artifact/page/component 的局部修改选区。
- 模块 10：PatchRecord 数据模型，支持 PRD section / HTML 原型组件 selectedRegion、Patch Agent 影响范围分析、PatchPlan 记录、ProductDesignState PatchOperation 应用、Patch 后重新生成 PRD / PrototypeSpec / HTML、QA 校验、失败恢复、Patch 历史查询、取消和确认入口。
- 模块 11：KnowledgeItem / KnowledgeCategory / KnowledgeTag / KnowledgeVersion / KnowledgeCandidate / KnowledgeRetrievalLog 数据模型，支持管理员创建、编辑、启用/禁用知识，知识分类、标签、类型、版本、候选审核、通过/拒绝/合并；Knowledge Agent 使用 active 知识做关键词检索并写入 ProductDesignState.knowledgeRefs，Patch Agent 检测 strong_rule 冲突，PRD/原型确认后只生成 pending 知识候选，正式入库必须管理员审核。
- 模块 12：AdminLayout / AdminSidebar / AdminTopBar、Dashboard、项目管理、模型管理、知识管理、日志中心和系统审计；新增 AdminAuditLog / AdminAuditTargetType，管理员关键操作写入审计；后台支持用户、项目、模型、知识、Agent Run、模型调用、文件解析、Patch、QA 报告的搜索、筛选、分页与详情查看；模型供应商新增/编辑使用独立弹窗状态，空表单创建也能直接配置。
- 模块 13：QAReport / RollbackRecord 数据模型，支持 ProductDesignState / PRD / PrototypeSpec / HTML 原型 / strong_rule / assumption / pending question 的基础一致性 QA；首次生成、Patch 后、手动触发和回滚后都会保存 QAReport；QAReport 会派生 QAGateDecision，决定是否允许确认产物、沉淀知识、导出/发布，以及是否需要回到 Patch；PRD/原型确认入口会先经过 QA Gate；工作台 QA Tab 支持重新 QA，状态 Tab 支持版本时间线和回滚到历史 ProductDesignState，回滚后会创建新 State 版本并重新生成 PRD、HTML 原型与 QA；管理后台 QA 报告改为读取 `qa_reports` 独立模型。
- 二期 0A：PRD 编辑体验支持 section 级选区、AI 改写、扩写、精简和 Diff 入口；`POST /api/prd/edit`、`POST /api/prd/rewrite`、`POST /api/prd/diff` 只生成 `needs_confirmation` Patch 候选，不直接修改 PRD 或 ProductDesignState。
- 二期 0B：HTML 原型交互编辑体验支持组件优化、布局调整和 Flow 更新入口；`POST /api/prototype/edit`、`POST /api/prototype/restructure`、`POST /api/prototype/flow-update` 只生成结构化 Patch 候选，不直接修改 HTML 源。
- 二期 0C：AI Inline Assistant 统一 PRD / Prototype 的局部编辑弹窗，支持选区上下文、编辑指令和 Interaction Event 记录；`POST /api/ai/inline-edit` 只生成 Patch 候选，用户必须在修改历史中确认后才会执行。
- 二期 14：Interaction Capture System 新增 ProductInteractionEvent，工作台“反馈”Tab 可记录用户显式反馈、评论、选区反馈和 Patch 反馈；禁止埋点、点击流、漏斗和行为统计。
- 二期 15：Semantic Feedback Analyzer 将 ProductInteractionEvent 转为结构化 ProductInsight，分类为 ux / logic / flow / content，输出 severity、affectedArea、rootCause、suggestion 和 sourceEvents。
- 二期 16：Multi-Agent Review System 只读取 ProductDesignState + ProductInsight，生成 ProductReviewReport；包含 UX、Business、Risk、Clarity、Growth 五类独立输出、冲突检测和 consensusScore，不修改业务数据。
- 二期 17：Evolution Engine 只基于 ProductDesignState、ProductInsight 和 ProductReviewReport 生成 EvolutionPlan，包含 reason、priority、patchOperations、prdChanges、prototypeChanges 和 impactedAreas，不执行 Patch。
- 二期 18：Patch Execution Engine 只执行 EvolutionPlan，通过 PatchService 将 patchOperations 转为 ProductDesignState PatchPlan，执行后重新生成 PRD、Prototype、QA，记录 EvolutionPatchExecution Patch Log，并支持回滚入口。
- 二期 19：Product Memory System 新增 ProductMemory，Patch 执行后记录 EvolutionPlan、PatchResult、before/after ProductDesignState 快照、ProductInsight 与多 Agent 报告；提供记忆列表和时间线查询，工作台“反馈”Tab 展示产品记忆，不参与决策、不生成 Patch、不修改 ProductDesignState。
- 二期 20：Evolution Orchestrator 新增 OrchestrationRun，按 Module15 → Module19 顺序调度语义分析、多 Agent 评审、进化方案、Patch 执行和产品记忆保存；支持 manual/event/batch/patch 触发和最多 5 轮循环执行，工作台“反馈”Tab 可一键运行总调度并查看每个模块状态；调度器只记录状态和结果，不做产品决策、不直接修改 ProductDesignState、不直接生成 Patch。
- 三期 0A：PRD Editing Experience System 将 PRD 预览升级为可交互对象，支持段落双击原地编辑、文本选区 floating editor、rewrite / expand / simplify / restructure / diff AI 编辑动作；所有编辑通过 `POST /api/patch/draft` 或 PRD 编辑 API 生成 `needs_confirmation` Patch 候选，并持久化 ProductInteractionEvent，不直接修改 PRD 或 ProductDesignState。
- 三期 0B：Prototype Interaction System 将原型 Tab 升级为当前页面内的交互编辑器，支持 PrototypeState 读取、Component Tree、组件选择、框选编辑、SelectionEngine、FloatingToolbar、AI UI 建议、PatchDraft Panel 和 PatchPreviewModal；刷新页面后会通过 `POST /api/prototype/get` 水合 PrototypeSpec/PrototypeState，框选区域不会回退到第一个组件，PatchPreview 优先读取当前原型编辑生成的 PatchRecord；`POST /api/prototype/get` 返回由 PrototypeSpec/Artifact 派生的 PrototypeState，`POST /api/prototype/update`、`POST /api/prototype/edit`、`POST /api/prototype/restructure`、`POST /api/prototype/flow-update` 只生成 `needs_confirmation` Patch 候选，`POST /api/patch/preview` 只读 PatchPlan 预览，确认后才会通过 PatchService 修改 ProductDesignState 并重新生成 PRD/Prototype/QA。

## 项目结构

```text
apps/
  api/
  web/

packages/
  db/
```

## 后端模块

- Auth: `POST /api/auth/login`, `GET /api/auth/me`
- Project: `POST /api/projects`, `GET /api/projects`, `GET /api/projects/:projectId`
- Conversation: 创建项目时自动创建默认会话
- Message: `POST /api/messages` 触发 Orchestrator
- Constraint System: `POST /api/constraint/build`, `GET /api/constraint/context`
- Decision System: `POST /api/decision/generate`, `POST /api/decision/select`
- Evolution System: `POST /api/evolution/trace`, `POST /api/evolution/apply`, `GET /api/evolution/policy`
- Decision Engine: 在 ConstraintContext 下生成不少于 3 个策略
- Review Board: Product Strategist、UX Expert、Tech Architect、Risk Controller、Growth Analyst
- Strategy Selector: 使用 weightedScore 公式选择最优策略
- Patch Builder: 将 Strategy 转为 PatchDraft
- Patch Preview 0D: `POST /api/patch/preview`
- Evolution Engine: 读取 DecisionTrace、生成 EvolutionSignal、更新 SystemPolicy
- Policy Store: `SystemPolicy` 版本化持久化，保留 previousPolicy 和 rollbackOfPolicyId
- Self-Generation Engine: 观察 trace 和执行结果，生成 SystemMutation
- System Preview: `POST /api/system/preview`
- Mutation Pipeline: `POST /api/system/mutation/propose`, `POST /api/system/mutation/apply`
- SystemGraph: `GET /api/system/graph?projectId=...`
- Company Runtime: `GET /api/company/dashboard?projectId=...`
- CEO Layer: `POST /api/company/ceo/decide`
- Product Department: `POST /api/company/product/create`
- Engineering Department: `POST /api/company/engineering/build`
- Design Department: `POST /api/company/design/generate`
- QA Department: `POST /api/company/qa/run`
- Growth Department: `POST /api/company/growth/optimize`
- Evolution Department: `POST /api/company/evolution/apply`
- SSE: `GET /api/ai/stream/:conversationId`

## 本地启动

```bash
npm install
npm run db:generate
docker compose up -d postgres
npm run db:migrate
npm run db:seed
npm run dev
```

服务地址：

- Web: http://localhost:3000
- API: http://localhost:4000/api
- Quartz 知识库: http://localhost:3001

## 默认账号

| 角色 | 用户名 | 邮箱 | 密码 |
|---|---|---|---|
| 管理员 | admin | admin@example.local | Admin123456 |
| 普通用户 | zhangsan | zhangsan@example.local | User123456 |

`npm run db:seed` 会为普通用户创建默认项目和默认会话。

## 工作台

- `/login`: 邮箱或用户名 + 密码登录
- `/workspace`: 固定三栏布局
  - 左侧: Projects
  - 中间: Chat，唯一入口为 `AI优化`
  - 右侧: Constraint View + Decision View + Evolution View + Company Dashboard + System Dashboard
- `/admin/knowledge/vault`: Quartz 知识库入口、Markdown Vault 状态和同步到系统知识库

## Triple System 规则

- 所有 AI 必须同时经过 Constraint / Decision / Evolution
- 任何决策必须带 ConstraintContext
- 任何策略必须经过 Decision System 生成和选择
- 任何优化必须被 Evolution System 记录并更新 policy
- PatchPlan 必须携带 constraints、strategyId 和 operations
- 所有行为必须通过公司组织结构
- 所有产品 initiative 必须由 CEO 批准
- 所有部门必须获得预算分配
- 所有 Agent 必须归属部门
- 所有部门计划必须结构化 JSON 并入库
- 不跳过 Phase 2 Decision / Review / Patch Preview
- 不跳过 Decision Engine 或 Review Board
- AI 不直接修改系统结构
- 新增 Agent 必须先生成 SystemMutation
- 所有结构变化必须进入 System Preview
- Low risk 可在 preview 后自动 apply
- Medium risk 必须显式 confirm
- High risk 直接 blocked
- 每次决策都写入 DecisionTrace
- 每次 Evolution 都基于历史 trace 和最新 SystemPolicy
- SystemPolicy 只追加新版本，不覆盖旧版本
- SystemGraph 只追加新版本，不覆盖旧版本
- MutationLog 记录 apply 和 rollback
- Patch Preview 不直接修改 ProductDesignState

## 验收路径

1. 登录后进入 `/workspace`。
2. 创建或选择项目。
3. 在 Chat 中点击 `AI优化` 发送需求。
4. Constraint System 生成 ConstraintContext 并落库 ConstraintRule。
5. Decision System 在约束下生成多策略、评分、选择最优策略并落库 Strategy。
6. Evolution System 记录 DecisionTrace、EvolutionSignal，并写入新的 SystemPolicy。
7. Orchestrator 只做流程编排，整合三系统、公司运行时、Agent 输入和 Patch Preview。
8. Patch Preview 的 PatchPlan 携带 constraints 和 strategyId。
9. Self-Generation Engine 生成 SystemMutation 并进入 System Preview。
10. 右侧展示 Constraint View、Decision View、Evolution View 和后续 Company/System 面板。

## Quartz 知识库

- 内容源：`knowledge-vault`
- 线上前端：Quartz 5 静态知识库，默认发布到 `http://8.130.160.177:3001`
- 后台入口：`/admin/knowledge/vault`
- 系统融合：后台“同步到系统知识库”会把 Markdown 文件切片写入 KnowledgeItem，供后续约束系统、决策系统和 Agent 检索
- 部署方式：`deploy/server-deploy.sh` 会构建 `ai-product-knowledge` 镜像，挂载同一个 `ai-product-workbench-storage` 卷下的 `knowledge-vault`，并用 Quartz 生成可浏览站点
