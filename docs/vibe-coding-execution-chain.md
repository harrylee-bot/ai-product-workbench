# Vibe Coding Runtime 执行链路说明

更新时间：2026-06-26

## 当前决策

旧自研 agent 主编排已下线。项目不再维护自己的通用 agent 链路，也不再继续实现旧本地五段主链路。

架构准则：Vibe 不自己写底层执行器、任务编排器、工具调用器、沙箱、多智能体协作或代码修改能力。底层只接 Codex CLI 或 DeerFlow；Vibe 只做产品协议、状态机、确认门、权限审计、事件可观测和 runtime adapter。

旧主链路文件和对应测试已经删除。`AiOrchestratorService` 现在只保留产品系统边界：run 生命周期、消息落库、SSE 终态、导出 passthrough、项目状态更新。后续需求、规划、产物生成、长任务执行由 DeerFlow / Codex runtime 接管。

## 新目标

Vibe Coding 不做通用 agent 框架。它只维护产品协议和状态机：

```text
Project / Conversation / Message
ProductDesignState
RequirementDocument
PrototypeSpec / PrototypeArtifact
QAReport
KnowledgeCandidate
确认门
权限 / 审计 / SSE
Runtime Adapter
```

底层执行交给 runtime：

```text
DeerFlow Runtime
  - 长任务
  - 多 sub-agent 协作
  - skills
  - sandbox
  - research / requirement / planning

Codex Runtime
  - 文件生成
  - 代码修改
  - HTML 原型
  - patch / review / test
```

## 当前代码入口

- 后端入口：`apps/api/src/ai/vibe.service.ts`
- runtime-only 主边界：`apps/api/src/ai/ai-orchestrator.service.ts`
- runtime adapter 协议：`apps/api/src/ai/runtime/external-runtime.types.ts`
- Codex adapter：`apps/api/src/ai/runtime/codex-runtime.adapter.ts`
- DeerFlow adapter：`apps/api/src/ai/runtime/deerflow-runtime.adapter.ts`
- 业务状态服务：`apps/api/src/ai/product-design-state.service.ts`
- PRD 服务：`apps/api/src/ai/requirement-document.service.ts`
- 原型服务：`apps/api/src/ai/prototype.service.ts`
- QA 服务：`apps/api/src/ai/qa.service.ts`

## 当前行为

用户发消息后：

```text
VibeService.handleMessage()
  -> 创建 user message
  -> 创建 agent_run_logs
  -> 调用 AiOrchestratorService.run()
  -> 如果 VIBE_REQUIREMENT_RUNTIME=deerflow：
       DeerFlowRuntimeAdapter
       -> ProductDesignStateService.createDraft()
       -> RequirementDocumentService.saveGeneratedDocument()
       -> ProductDesignStateService.attachGeneratedArtifacts(status=doc_ready)
       -> review_prd
  -> 否则 runtime-only orchestrator 安全结束本轮
```

当前普通生成请求不会再进入旧本地 agent。默认 `local` 下仍安全结束，不改产品状态；显式切到 `deerflow` 后会通过 runtime adapter 生成产品状态和 PRD，并停在 PRD 确认门。

导出请求仍保留 passthrough：

```text
导出 Word / HTML
  -> ExportService
  -> export_ready
  -> run_completed
```

## Runtime Adapter 契约

所有外部 runtime 都必须通过统一协议接入：

```text
RuntimeTask
  id
  provider: local | codex | deerflow
  taskType
  runId
  projectId
  input
  outputSchema

RuntimeEvent
  runtime_task_started
  runtime_step_started
  runtime_message
  runtime_tool_called
  runtime_file_changed
  runtime_artifact_created
  runtime_warning
  runtime_task_completed
  runtime_task_failed

RuntimeResult
  provider
  taskId
  status
  output
  artifacts
  events
```

外部 runtime 不允许直接写业务数据库。它只能返回结构化结果、文件、patch、风险和 trace。真正落库必须经过：

```text
ProductDesignStateService
RequirementDocumentService
PrototypeService
QaService
KnowledgeCandidateService
```

## 保留的业务硬边界

这些边界不能交给 DeerFlow/Codex 绕过：

- `ProductDesignState` 是唯一事实源。
- PRD 生成后必须停在 `review_prd`。
- 原型生成后必须停在 `review_prototype` 或 `review_qa`。
- Patch 必须先成为候选，再由用户确认应用。
- 知识只能生成候选，不能直接写正式知识库。
- runtime 输出必须经过 schema 校验、安全检查和业务服务落库。

## 下一步迁移顺序

已完成：

- `CodexRuntimeAdapter` 已接入 `ProductRuntimeService.generatePrototypeHtml()`：
   `PrototypeSpec -> Codex workspace -> index.html -> PrototypeArtifact`。
- `DeerFlowRuntimeAdapter` 已接入普通需求 intake：
   `userInput + project context -> ProductDesignDraft / RequirementDocumentDraft -> review_prd`。
- `ProductRuntimeService` 已把 PrototypeSpec、PatchPlan、QA 接入外部 runtime task 边界：
   `VIBE_PROTOTYPE_SPEC_RUNTIME`、`VIBE_PATCH_PLAN_RUNTIME`、`VIBE_QA_RUNTIME` 可分别切到 `codex` 或 `deerflow`。
- `CodexRuntimeAdapter` 已支持结构化 JSON 任务：
   `generate_prototype`、`patch_prd`、`patch_prototype`、`qa_review` 通过 Codex CLI 生成 `runtime-output.json`。
- `DeerFlowRuntimeAdapter` 已支持通用 task gateway：
   除 requirement intake 外的 runtime task 会以 `vibe.runtime.task.v1` 交给 DeerFlow。
- 旧 Phase2/3/4/5 实验链路已删除：
   `decision/evolution/company/self-generation/review-board/product-evolution` 不再作为维护目标。
- PRD、PrototypeSpec、PatchPlan、QA 的本地实现已降级为 `local-protocol-renderers` 确定性 fallback，不再是 agent 编排。

继续迁移：

1. 配置真实 Codex CLI / DeerFlow gateway，做端到端 runtime 运行验证。
2. 前端把 runtime events 显示成自然语言执行过程。
3. 为 runtime 输出补更严格 schema 校验、错误恢复和回放审计。

## 环境变量

```text
VIBE_REQUIREMENT_RUNTIME=local
VIBE_PROTOTYPE_SPEC_RUNTIME=local
VIBE_PROTOTYPE_CODE_RUNTIME=local
VIBE_PATCH_PLAN_RUNTIME=local
VIBE_QA_RUNTIME=local
VIBE_RUNTIME_FALLBACK_TO_LOCAL=true
VIBE_RUNTIME_WORKSPACE_ROOT=.vibe-runtime-workspaces
VIBE_CODEX_COMMAND=codex
DEERFLOW_GATEWAY_URL=http://localhost:2026
DEERFLOW_GATEWAY_MODE=vibe
DEERFLOW_GATEWAY_PATH=/api/vibe/tasks
DEERFLOW_ASSISTANT_ID=agent
DEERFLOW_REQUEST_TIMEOUT_MS=180000
```

默认保持 `local`，只有显式切换后才调用 Codex/DeerFlow。
