# Vibe Coding Runtime 职责边界

更新时间：2026-06-26

## 核心决策

Vibe Coding 不再维护自研通用 agent 编排。

旧本地主链路已从活跃路径删除，不再作为产品目标或实现目标维护。

第一原则：不要自己写底层执行、任务编排、工具调用、代码修改、沙箱和多智能体协作。底层能力只使用 Codex CLI 或 DeerFlow。

后续这类能力由 DeerFlow / Codex runtime 承担。我们只维护产品协议、状态机、确认门、schema 校验、权限审计、runtime adapter 和 artifact 落库。

## 我们负责

| 边界 | 说明 |
|---|---|
| ProductDesignState | 唯一事实源，所有 PRD/原型/QA 必须可追溯 |
| RequirementDocument | PRD artifact，必须走确认门 |
| PrototypeArtifact | HTML 原型 artifact，必须经过安全检查 |
| QAReport | 产物一致性、风险和确认建议 |
| PatchRecord | 局部修改候选和确认应用 |
| KnowledgeCandidate | 只生成待审核候选 |
| Runtime Adapter | 统一 Codex / DeerFlow 的输入、事件和输出 |
| SSE / Run Log | 用户可见执行过程和审计 |

## DeerFlow 负责

适合交给 DeerFlow：

```text
长任务拆解
多 sub-agent 协作
需求研究
附件/资料总结
业务规则探索
复杂 planning
skills / memory / sandbox
```

DeerFlow 输出必须被转换为我们的 schema，例如：

```text
ProductDesignStateDraft
RequirementDocumentDraft
PatchPlan
RiskSummary
ClarificationQuestions
```

## Codex 负责

适合交给 Codex：

```text
PrototypeSpec -> index.html
HTML / CSS / JS 修复
局部 patch
代码 review
运行命令和检查文件
后续真实前后端代码生成
```

Codex 输出必须作为文件、patch 或结构化 JSON 返回，不能直接修改业务 DB。

## 本地协议 fallback

这些本地实现只作为确定性协议 fallback，保证 runtime 未配置、不可用或测试环境下产品链路可回放。它们不再是自研 agent，也不承担通用编排：

```text
renderPrdFromState
renderPrototypeSpecFromState
renderHtmlFromPrototypeSpec
createPatchPlanFromInput
QaRuleCheckService
```

外部智能生成按以下顺序接入 runtime task：

1. HTML 原型生成器 -> Codex（runtime facade 已接入）
2. 普通需求 intake / PRD draft -> DeerFlow（runtime adapter 已接入）
3. PrototypeSpec 生成器 -> DeerFlow / Codex（runtime task 边界已接入）
4. PatchPlan 生成器 -> Codex / DeerFlow（runtime task 边界已接入）
5. QA 报告生成器 -> Codex / DeerFlow（runtime task 边界已接入）
6. 知识候选生成器 -> DeerFlow 或规则服务

## 禁止事项

- 不自研底层 agent executor、planner、tool runner、sandbox、代码修改器或多智能体调度器。
- 不再新增本地自研 agent 编排节点。
- 不再恢复旧 `Intent -> Knowledge -> Requirement -> Planner -> Designer` 链路。
- 不允许 runtime 直接写 `ProductDesignState`、PRD、Prototype、QA 或 Knowledge 正式表。
- 不允许 runtime 绕过 `review_prd`、`review_prototype`、`confirm_patch`。
- 不允许把 AI 假设伪装成用户确认事实。

## 新职责模型

```text
Vibe API
  -> RuntimeTask
  -> DeerFlow / Codex
  -> RuntimeResult
  -> Schema Validation
  -> Product Services
  -> DB / SSE / Confirmation Gate
```

这个文档取代旧 agent charter。旧自研 agent 职责不再作为项目目标维护。
