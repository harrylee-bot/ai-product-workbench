---
title: 03-Phase3 进化系统
description: 将 V2 决策系统升级为 V3 Evolution System 自优化系统。
date: 2026-06-22
status: 已维护
tags:
  - 规格文档/Phase3
  - EvolutionSystem
  - SystemPolicy
aliases:
  - PHASE 3 EVOLUTION ENGINE
  - Phase 3 进化系统
---

# 03-Phase3 进化系统

Phase 3 的目标是将系统从 V2 决策系统升级为 V3 Evolution System 自优化系统。

```text
V2 决策系统
  → V3 Evolution System
  → 自优化系统
```

## 强制约束

禁止：

- 改变 Phase 2 结构。
- 跳过 Decision / Review 流程。
- AI 直接修改策略逻辑。
- 无记录优化行为。

必须：

- 所有决策必须记录。
- 所有执行必须可追踪。
- 所有优化必须基于历史数据。
- 所有变化必须可回滚。

## Phase 3 架构

```text
User Input
  ↓
Decision Engine
  ↓
Review Board
  ↓
Strategy Selector
  ↓
Patch Builder
  ↓
Execution Engine
  ↓
Evolution Engine
  ↓
Policy Update System
```

## Evolution Engine 文件结构

```text
apps/api/src/ai/evolution-engine/
  evolution.engine.service.ts
  decision-trace.service.ts
  signal.generator.ts
  policy.updater.ts
```

## DecisionTrace

必须记录每一次完整 AI 决策链：

```ts
type DecisionTrace = {
  id: string
  input: string
  intent: string
  strategies: string
  selectedStrategyId: string
  reviewResult: string
  finalOutcome: "success" | "failure" | "partial"
  metrics: {
    qaPassed: boolean
    userFeedbackScore: number
    executionTime: number
  }
}
```

## EvolutionSignal

```ts
type EvolutionSignal = {
  strategyId: string
  signalType: "promote" | "demote" | "neutral"
  weightDelta: number
  reason: string
}
```

## SystemPolicy

```ts
type SystemPolicy = {
  strategyWeights: Record<string, number>
  agentWeights: {
    productStrategist: number
    uxExpert: number
    techArchitect: number
    riskController: number
    growthAnalyst: number
  }
  decisionBias: {
    riskAversion: number
    innovationBias: number
  }
}
```

## Evolution Engine 流程

### Step 1 记录决策

每次执行完成后必须写入 DecisionTrace。

### Step 2 结果分析

```text
if QA passed AND user satisfied:
  success

if QA failed:
  failure

else:
  partial
```

### Step 3 生成 Evolution Signal

- 成功策略：promote。
- 失败策略：demote。
- 高频失败：strong demote。

### Step 4 更新 SystemPolicy

更新内容：

- strategyWeights
- agentWeights
- decisionBias

### Step 5 写入 Policy Store

SystemPolicy 必须持久化。

## 权重更新算法

Strategy Weight Update：

```text
newWeight = oldWeight + (learningRate × signal.weightDelta)
```

Agent Weight Update：

```text
if agent contributes to success:
  weight += 0.01
else:
  weight -= 0.01
```

Risk Bias Adjustment：

- 如果系统 failure rate increases，则 increase riskAversion。
- 如果 innovation success increases，则 increase innovationBias。

## Evolution Engine Service

职责：

1. consume DecisionTrace
2. generate EvolutionSignal
3. update SystemPolicy
4. persist changes

伪代码：

```ts
class EvolutionEngine {
  async run(trace: DecisionTrace) {
    const signal = this.generateSignal(trace)
    await this.updatePolicy(signal)
    await this.save(signal)
  }
}
```

## Policy Store

SystemPolicy 表结构：

- strategyWeights(json)
- agentWeights(json)
- decisionBias(json)

## Orchestrator 升级

每次执行结束后必须调用：

```ts
EvolutionEngine.run(trace)
```

流程：

```text
User Input
  ↓
Decision
  ↓
Review
  ↓
Execution
  ↓
Evolution Engine
```

## UI 新增

新增面板：System Evolution Panel。

显示：

- 哪些策略被提升。
- 哪些策略被降级。
- Agent 权重变化。
- 系统学习趋势。

示例：

```text
Strategy A → +0.12
Strategy B → -0.08
UX Agent → +0.03

System is learning...
```

## 禁止事项

- 不允许手动修改权重。
- 不允许无 trace 优化。
- 不允许跳过 Decision 记录。
- 不允许 AI 自发改变策略结构。

## 验收标准

- 每次 Decision 必须生成 Trace。
- 每个 Trace 必须触发 Evolution。
- 策略权重必须变化。
- Agent 权重必须变化。
- 系统行为必须可观测。
- 所有变化必须可回溯。

## 图谱连接

- 前置阶段：[[06-规格文档/02-Phase2决策系统]]
- 下一阶段：[[06-规格文档/04-Phase4自生成系统]]
- 三系统融合：[[00-系统说明/三系统融合架构]]
- 执行链路：[[00-系统说明/系统执行链路]]

