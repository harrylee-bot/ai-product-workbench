---
title: 02-Phase2 决策系统
description: 将 V1 执行型 AI 系统升级为 V2 Decision + Review + Patch 决策系统。
date: 2026-06-22
status: 已维护
tags:
  - 规格文档/Phase2
  - DecisionSystem
  - ReviewBoard
  - PatchPreview
aliases:
  - PHASE 2 DECISION SYSTEM
  - Phase 2 决策系统
---

# 02-Phase2 决策系统

Phase 2 的目标是将系统从 V1 执行型 AI 系统升级为 V2 AI 决策系统。

```text
V1 执行型 AI 系统
  → V2 AI 决策系统
  → Decision + Review + Patch
```

## 强制约束

禁止：

- 直接生成 PRD/Prototype。
- 单一策略输出。
- 跳过 Review Board。
- 跳过 Decision Engine。
- 绕过 Patch Preview。
- AI 直接写数据库。

必须：

- 所有输入必须经过 Decision Engine。
- 所有策略必须大于等于 3 个。
- 所有策略必须经过 Review Board。
- 必须选择最优策略。
- Patch 必须进入 Preview，也就是 Module 0D。

## Phase 2 架构

```text
User Input
  ↓
Intent Agent
  ↓
Decision Engine
  ↓
Review Board
  ↓
Strategy Selector
  ↓
Patch Builder
  ↓
Patch Preview
  ↓
Execution Engine
```

## 后端模块结构

```text
apps/api/src/ai/
  decision-engine/
  review-board/
  strategy-selector/
  patch-builder/
```

## Decision Engine

文件：

- `decision-engine.service.ts`
- `decision.types.ts`
- `strategy.generator.ts`

职责：

- 将用户意图生成多个策略。
- 策略数量必须大于等于 3 个。

Strategy 结构：

```ts
type Strategy = {
  id: string
  name:
    | "conservative_fix"
    | "ux_improve"
    | "structure_rewrite"
    | "full_regenerate"
  description: string
  patchOperations: PatchOperation[]
  impact: "low" | "medium" | "high"
}
```

DecisionPlan：

```ts
type DecisionPlan = {
  strategies: Strategy[]
}
```

规则：

- 必须生成至少 3 个策略。
- 每个策略必须不同。
- 每个策略必须有独立 patchOperations。

## Review Board

文件：

- `review-board.service.ts`
- `review.types.ts`
- `agent.reviewer.ts`

固定评审 Agent：

- Product Strategist
- UX Expert
- Tech Architect
- Risk Controller
- Growth Analyst

AgentReview：

```ts
type AgentReview = {
  agentName: string
  scores: {
    usability: number
    feasibility: number
    risk: number
    businessValue: number
  }
  preferredStrategyId: string
  objections: string[]
}
```

ReviewBoardResult：

```ts
type ReviewBoardResult = {
  reviews: AgentReview[]
  finalDecision: {
    selectedStrategyId: string
    confidence: number
  }
}
```

规则：

- 每个 Agent 必须评分。
- 必须输出 preferredStrategyId。
- 必须存在冲突情况，也就是不同 Agent 偏好不同策略。

## Strategy Selector

文件：

- `strategy-selector.service.ts`

职责：

- 根据 Review Board 结果选择最终策略。

评分算法：

```text
weightedScore =
  usability * 0.25 +
  feasibility * 0.25 +
  businessValue * 0.3 -
  risk * 0.2
```

输出：

```ts
type StrategySelection = {
  selectedStrategyId: string
  reason: string
}
```

## Patch Builder

文件：

- `patch-builder.service.ts`

职责：

- 将 Strategy 转为 PatchDraft。

PatchDraft：

```ts
type PatchDraft = {
  id: string
  strategyId: string
  operations: PatchOperation[]
  targetDomains: ("prd" | "prototype" | "state")[]
}
```

PatchOperation：

```ts
type PatchOperation = {
  op: "add" | "update" | "delete" | "replace"
  path: string
  value?: any
}
```

规则：

- Patch 必须来自 Strategy。
- Patch 不能直接修改 State。
- Patch 必须进入 Preview。

## Orchestrator 升级

新流程：

1. Intent Agent
2. Decision Engine
3. Review Board
4. Strategy Selector
5. Patch Builder
6. Patch Preview

规则：

- Orchestrator 不能直接生成 PRD。
- Orchestrator 不能绕过 Decision Engine。

## 前端改造

删除：

- 改写按钮。
- 精简按钮。
- 重构按钮。
- Diff 按钮。

替换为：

- AI 优化，唯一入口。

UI 流程：

```text
用户输入
  ↓
AI 生成大于等于 3 个策略
  ↓
展示评审结果
  ↓
用户选择策略
  ↓
进入 Patch Preview
```

## Patch Preview API

`POST /patch/preview`

输入：

- PatchDraft

输出：

- PreviewSession

## 数据库新增

DecisionTrace：

```ts
type DecisionTrace = {
  id: string
  input: string
  strategies: string
  selectedStrategy: string
  reviewResult: string
}
```

## 验收标准

- 每个输入生成大于等于 3 个策略。
- Review Board 必须参与评分。
- 不同 Agent 评分不同。
- 自动选择最优策略。
- Patch 进入 Preview。
- 不允许直接写 State。
- 不允许跳过 Decision 流程。

## 图谱连接

- 前置阶段：[[06-规格文档/01-Phase1最小闭环]]
- 下一阶段：[[06-规格文档/03-Phase3进化系统]]
- 系统强约束：[[02-规则约束/系统级强约束]]
- 三系统融合：[[00-系统说明/三系统融合架构]]
- 执行路径：[[04-原型模式/执行路径流式展示模式]]
