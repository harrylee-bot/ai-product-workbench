---
title: 三系统 Agent 协作规范
description: Agent 在 Constraint、Decision、Evolution 三系统下的协作方式和输出规范。
date: 2026-06-22
status: 已维护
tags:
  - Agent知识/协作
  - ConstraintSystem
  - DecisionSystem
  - EvolutionSystem
aliases:
  - Agent 协作规范
  - 多 Agent 协作规范
---

# 三系统 Agent 协作规范

所有 Agent 都必须作为 Orchestrator 编排下的执行角色，不能直接决定系统策略，也不能直接写数据库。

## 输入结构

```json
{
  "userInput": "用户输入",
  "constraintContext": {
    "mustFollow": [],
    "prefer": [],
    "avoid": [],
    "warn": []
  },
  "decisionContext": {
    "strategies": [],
    "selectedStrategyId": "",
    "reasoning": []
  },
  "knowledgeRefs": [],
  "traceId": ""
}
```

## 输出结构

```json
{
  "agentName": "需求分析 Agent",
  "status": "success | partial | failed",
  "summary": "中文摘要",
  "result": {},
  "knowledgeRefs": [],
  "warnings": [],
  "nextActions": []
}
```

## Agent 角色

| Agent | 职责 | 必读知识 |
| --- | --- | --- |
| Intent Agent | 判断输入类型和业务域 | [[01-产品知识/需求输入分类法]] |
| Product Agent | 生成产品设计状态摘要 | [[01-产品知识/AI 产品工作台产品定义]] |
| Constraint Agent | 构建约束上下文 | [[02-规则约束/系统级强约束]] |
| Decision Agent | 生成和评分策略 | [[00-系统说明/三系统融合架构]] |
| Prototype Agent | 生成界面结构和 HTML | [[04-原型模式/AI结果中心预览模式]] |
| QA Agent | 校验风险、验收和回滚 | [[02-规则约束/需求文档沉淀/营销活动与资损约束]] |

## 展示要求

Agent 执行状态必须进入 [[04-原型模式/执行路径流式展示模式|执行路径流式展示模式]]。

- 摘要默认展示。
- 详细输入输出默认收起。
- 错误信息要用户可读。
- knowledgeRefs 必须可回溯到知识库。

## 禁止行为

- 不允许 Agent 绕过 [[00-系统说明/三系统融合架构|三系统融合架构]]。
- 不允许 Agent 直接写数据库。
- 不允许 Agent 直接修改 Patch 或系统结构。
- 不允许 Agent 输出英文系统文案。
- 不允许 Agent 输出不可追踪结论。

