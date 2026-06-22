---
title: 05-Phase5 AI 产品公司运行时
description: 将 V4 自生成系统升级为 V5 AI Product Company Runtime 自治产品公司系统。
date: 2026-06-22
status: 已维护
tags:
  - 规格文档/Phase5
  - AICompanyRuntime
  - CompanySystem
aliases:
  - PHASE 5 AI PRODUCT COMPANY RUNTIME
  - Phase 5 AI 产品公司系统
---

# 05-Phase5 AI 产品公司运行时

Phase 5 的目标是将系统从 V4 Self-Generation System 升级为 V5 AI Product Company Runtime，也就是自治产品公司系统。

```text
V4 Self-Generation System
  → V5 AI Product Company Runtime
  → 自治产品公司系统
```

## 强制约束

禁止：

- AI 直接创建产品而不经过公司结构。
- 跳过部门流程。
- 无 CEO 决策直接执行。
- 无评审生成产品。
- 无预算/资源分配。

必须：

- 所有行为必须通过公司组织结构。
- 所有产品必须由 CEO 批准。
- 所有资源必须分配。
- 所有 Agent 属于部门。

## V5 架构

```text
User Input / Market Signal
  ↓
CEO Layer
  ↓
Product Department
  ↓
Engineering Department
  ↓
Design Department
  ↓
QA Department
  ↓
Growth Department
  ↓
Evolution Department
  ↓
System Output
```

## Company

```ts
type Company = {
  id: string
  name: string
  budget: number
  strategy: string
  departments: Department[]
}
```

## Department

```ts
type Department = {
  id: string
  type:
    | "ceo"
    | "product"
    | "engineering"
    | "design"
    | "qa"
    | "growth"
    | "evolution"
  budgetAllocation: number
  agents: Agent[]
}
```

## Agent

```ts
type Agent = {
  id: string
  name: string
  role: string
  departmentId: string
  capabilities: string[]
}
```

## CEO Layer

路径：`apps/api/src/company/ceo/`

职责：

- 决定做什么产品。
- 分配预算。
- 启动或停止项目。
- 决定资源优先级。

输出：

```ts
type CEOPlan = {
  initiatives: ProductInitiative[]
  budgetAllocation: Record<string, number>
  priority: string[]
}
```

## Product Department

职责：

- 创建产品。
- 定义 PRD。
- 拆解功能模块。

输出：

```ts
type ProductInitiative = {
  id: string
  name: string
  goal: string
  features: string[]
}
```

## Engineering Department

职责：

- 构建系统模块。
- 实现 API。
- 实现 Orchestrator 扩展。

输出：

```ts
type EngineeringPlan = {
  modules: string[]
  apis: string[]
  systemChanges: SystemMutation[]
}
```

## Design Department

职责：

- UI 设计。
- UX 流程优化。
- Prototype 结构生成。

输出：

```ts
type DesignPlan = {
  layouts: string[]
  uxFlows: string[]
}
```

## QA Department

职责：

- 测试产品。
- 检查一致性。
- 发现系统问题。

输出：

```ts
type QAReport = {
  issues: string[]
  riskLevel: "low" | "medium" | "high"
  recommendations: string[]
}
```

## Growth Department

职责：

- 分析用户行为。
- 优化转化路径。
- 提供产品增长策略。

输出：

```ts
type GrowthPlan = {
  optimizations: string[]
  experiments: string[]
}
```

## Evolution Department

职责：

- 改造组织结构。
- 调整 Agent 分布。
- 优化部门协作。

输出：

```ts
type EvolutionPlan = {
  structuralChanges: SystemMutation[]
  agentChanges: AgentMutation[]
}
```

## 公司运行流程

### Step 1 CEO 决策

```text
Market Input
  → CEO Layer
  → Product Initiative
```

### Step 2 产品拆解

```text
Product Department
  → PRD + Features
```

### Step 3 工程实现

```text
Engineering Department
  → System Modules
```

### Step 4 设计

```text
Design Department
  → UI/UX + Prototype
```

### Step 5 QA

```text
QA Department
  → Issue detection
```

### Step 6 增长优化

```text
Growth Department
  → Optimization plan
```

### Step 7 系统进化

```text
Evolution Department
  → system mutation
```

## V5 核心能力

- 自动生成产品。
- 自动拆解功能。
- 自动分配资源。
- 自动优化系统。
- 自动进化组织结构。

## API 设计

- `POST /company/ceo/decide`
- `POST /company/product/create`
- `POST /company/engineering/build`
- `POST /company/design/generate`
- `POST /company/qa/run`
- `POST /company/growth/optimize`
- `POST /company/evolution/apply`

## 数据库新增

- Company
- Department
- Agent
- ProductInitiative
- EngineeringPlan
- DesignPlan
- QAReport
- GrowthPlan
- EvolutionPlan

## 系统约束

- 所有产品必须经过 CEO 审批。
- 所有资源必须分配。
- 所有 Agent 必须归属部门。
- 所有系统变更必须记录。

## UI 新增

Company Dashboard 显示：

- 公司结构图。
- 产品线。
- 部门运行状态。
- 资源分配。
- 系统进化记录。

## 验收标准

- AI 可以创建产品。
- AI 可以拆解功能。
- AI 可以分配资源。
- AI 可以生成多个部门计划。
- AI 可以输出完整产品生命周期。
- 系统可以持续运行。

## 最终演进链

```text
V2 → 决策系统
V3 → 自优化系统
V4 → 自生成系统
V5 → AI 产品公司系统
```

## 图谱连接

- 前置阶段：[[06-规格文档/04-Phase4自生成系统]]
- 三系统融合：[[06-规格文档/06-三系统融合终极架构]]
- 产品定义：[[01-产品知识/AI 产品工作台产品定义]]
- 系统总纲：[[00-系统说明/AI Product OS 总纲]]
