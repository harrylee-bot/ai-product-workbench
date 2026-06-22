---
title: 04-Phase4 自生成系统
description: 将 V3 Evolution System 升级为 V4 Self-Generation System 自生成系统。
date: 2026-06-22
status: 已维护
tags:
  - 规格文档/Phase4
  - SelfGeneration
  - SystemGraph
  - MutationPipeline
aliases:
  - PHASE 4 SELF-GENERATION SYSTEM
  - Phase 4 自生成系统
---

# 04-Phase4 自生成系统

Phase 4 的目标是将系统从 V3 Evolution System 自优化升级为 V4 Self-Generation System 自生成系统。

```text
V3 Evolution System
  → V4 Self-Generation System
  → 自生成系统
```

## 强制约束

禁止：

- 直接修改系统结构。
- AI 直接新增 Agent 而不经过流程。
- 无审批的系统变更。
- 跳过 System Preview。

必须：

- 所有结构变更必须走 Mutation Pipeline。
- 所有新增 Agent 必须注册。
- 所有系统修改必须可预览。
- 所有变更必须写入 SystemGraph。

## Phase 4 架构

```text
User Input
  ↓
Decision Engine
  ↓
Review Board
  ↓
Execution Engine
  ↓
Evolution Engine
  ↓
Self-Generation Engine
  ↓
System Graph Update
  ↓
System Rebuild (partial)
```

## 文件结构

```text
apps/api/src/ai/self-generation/
  self-generation.engine.ts
  system.graph.service.ts
  mutation.engine.ts
  system.preview.service.ts
  agent.factory.ts
```

## SystemGraph

```ts
type SystemGraph = {
  nodes: SystemNode[]
  edges: SystemEdge[]
}
```

## SystemNode

```ts
type SystemNode = {
  id: string
  type:
    | "agent"
    | "orchestrator"
    | "tool"
    | "policy"
    | "compiler"
  name: string
  config: Record<string, any>
  status: "active" | "inactive" | "experimental"
}
```

## SystemEdge

```ts
type SystemEdge = {
  from: string
  to: string
  relation: "calls" | "depends_on" | "feeds"
}
```

## SystemMutation

```ts
type SystemMutation = {
  id: string
  type:
    | "add_agent"
    | "remove_agent"
    | "modify_agent"
    | "modify_pipeline"
    | "add_step"
    | "remove_step"
  target: string
  payload: any
  reason: string
  riskLevel: "low" | "medium" | "high"
}
```

## Self-Generation 流程

### Step 1 系统观察

输入来源：

- DecisionTrace
- QA 失败记录
- Patch 失败记录
- 用户反馈
- Performance Metrics

### Step 2 问题识别

生成：

```ts
type SystemInsight = {
  bottleneck: string
  weakness: string
  opportunity: string
}
```

### Step 3 生成系统变更提案

必须生成 SystemMutation[]。

示例：

- 新增 Agent。
- 修改 Pipeline。
- 调整 Orchestrator。
- 增加 Checker。

### Step 4 System Preview

所有变更必须进入预览。

```ts
type SystemChangeProposal = {
  mutations: SystemMutation[]
  impactAnalysis: string[]
  riskLevel: string
}
```

### Step 5 用户确认或低风险自动执行

规则：

- low risk：auto apply。
- medium：require confirm。
- high：blocked。

### Step 6 SystemGraph 更新

更新系统结构：

- add node
- remove node
- modify node
- reconnect edges

## Agent Factory

AI 可以创建新的 Agent。

DynamicAgent：

```ts
type DynamicAgent = {
  id: string
  name: string
  role: string
  prompt: string
  inputSchema: any
  outputSchema: any
}
```

示例：AI 生成 Flow Optimization Agent，并自动注册：

- systemGraph node
- orchestrator hook
- pipeline insert

## Mutation Engine

文件：

- `mutation.engine.ts`

职责：

- apply mutation
- validate mutation
- rollback support
- update graph

规则：

- mutation 必须经过 validation。
- mutation 必须可回滚。
- mutation 必须记录日志。

## System Preview

真正修改系统前必须展示：

- 新 Agent 结构。
- 新 pipeline。
- 影响范围。
- 风险。

示例：

```text
System Update Preview

新增：
- FlowAgent

影响：
- Orchestrator
- QA Pipeline

风险：Medium

[Apply] [Cancel]
```

## Orchestrator 升级

V3：

- Orchestrator = 固定流程执行器。

V4：

- Orchestrator = SystemGraph Executor。

执行：

```ts
type ExecutionPlan = {
  nodes: SystemNode[]
  edges: SystemEdge[]
}
```

## 自生成能力范围

AI 可以：

- 新增 Agent。
- 删除 Agent。
- 修改 Agent prompt。
- 改变 pipeline。
- 插入 checker。
- 修改决策流程。

禁止：

- 直接改数据库结构。
- 无 preview 修改系统。
- 修改核心安全模块。

## 系统安全机制

三层保护：

1. Mutation Validation：schema check、dependency check。
2. Risk Engine：low、medium、high。
3. Preview Gate：mandatory for medium/high。

## 数据库新增

- SystemGraph
- SystemNode
- SystemEdge
- SystemMutationLog
- SystemChangeProposal

## API 设计

- `POST /system/mutation/propose`
- `POST /system/mutation/apply`
- `GET /system/graph`
- `POST /system/preview`

## UI 新增

System Dashboard 显示：

- Agents
- Pipeline
- Graph
- Mutations
- Evolution history

## 验收标准

- AI 可以生成新 Agent。
- Agent 可以加入 SystemGraph。
- Pipeline 可以动态修改。
- 所有修改必须可预览。
- Mutation 必须可回滚。
- 系统结构可以演化。

## 图谱连接

- 前置阶段：[[06-规格文档/03-Phase3进化系统]]
- 下一阶段：[[06-规格文档/05-Phase5AI产品公司运行时]]
- 系统图谱：[[00-系统说明/AI Product OS 知识图谱]]
- 系统强约束：[[02-规则约束/系统级强约束]]

