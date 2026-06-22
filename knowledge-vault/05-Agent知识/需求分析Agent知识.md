---
title: 需求分析Agent知识
date: 2026-06-22
status: 已整理
source: 需求文档导入
tags:
  - Agent知识/需求分析
  - Agent知识/约束
  - 导入/需求文档
---

# 需求分析 Agent 知识

## 角色定位

需求分析 Agent 负责把用户自然语言输入转成可决策、可评审、可执行的产品设计状态。它不直接写数据库，不直接生成最终 PRD/Prototype，不绕过 Constraint、Decision、Evolution 三系统。

## 输入

```json
{
  "userInput": "用户输入",
  "knowledgeRefs": ["需求文档知识库", "需求文档通用约束", "业务域索引"],
  "constraintContext": {},
  "decisionContext": {},
  "projectContext": {}
}
```

## 输出

```json
{
  "requirementType": "new_requirement | optimization | bugfix | report | ai_workflow | compliance",
  "businessDomain": "AI营销与智能生成 | 云溪活动平台 | 号卡与OAO流程 | 素材库与模板配置 | 奖品券与资损核销 | 数据统计与报表 | 安全测试与资损评审",
  "knownPatterns": [],
  "requiredConstraints": [],
  "missingQuestions": [],
  "riskHints": []
}
```

## 分类规则

- 出现 Dify、AI助手、案例库、长图、素材生成：归入 AI营销与智能生成。
- 出现 活动、发布、审核、省公司、云溪、极布：归入 云溪活动平台。
- 出现 号卡、OAO、商机单、预订单、入网、套餐：归入 号卡与OAO流程。
- 出现 素材库、模板、模版、banner、画布、预览：归入 素材库与模板配置。
- 出现 奖品、券、话费、流量包、抽奖、核销：归入 奖品券与资损核销。
- 出现 报表、导出、PVUV、渠道编码、统计：归入 数据统计与报表。
- 出现 资损、安全、测试用例、评审：归入 安全测试与资损评审，并提升风险权重。

## 缺失信息追问

- 目标用户是谁，业务目标是什么？
- 影响用户端、后台端、接口、数据还是三者都有？
- 是否涉及权益、奖品、资金、券、流量、号卡、个人信息？
- 是否需要省份/渠道/发展人/模板差异化配置？
- 是否需要预览、审核、发布、下线、回滚？
- 验收标准和数据统计口径是什么？
