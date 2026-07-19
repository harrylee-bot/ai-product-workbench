---
title: "旧库来源｜PRD标准结构 / 写作要求｜c3092f64afe5"
description: "写作要求"
date: "2026-07-16"
status: "仅查来源"
tags:
  - "旧数据库知识库"
  - "来源条目"
  - "产品文档规范"
  - "prd_writing_rule"
  - "vault-sync"
  - "knowledge-vault"
  - "vault-tier:main"
  - "PRD"
  - "需求文档"
  - "需求说明书"
  - "文档生成技能"
aliases:
  - "PRD标准结构 / 写作要求"
source: "storage/source-assets/legacy-knowledge-20260716/knowledge-items.ndjson"
legacyKnowledgeId: "vault_e4e2f16f30e373a7d56da459cd274e15"
legacyStatus: "active"
legacyCategoryId: "52020309-424b-465e-924a-c71f0780fc44"
retrievalScope: "source_lookup"
---

# PRD标准结构 / 写作要求

## 来源元数据

| 项目 | 内容 |
| --- | --- |
| 旧知识 ID | `vault_e4e2f16f30e373a7d56da459cd274e15` |
| 分类 | 产品文档规范 |
| 类型 | `prd_writing_rule` |
| 范围 | `global` |
| 优先级 | `high` |
| 旧状态 | `active` |
| 新检索状态 | 仅查来源 |
| 旧来源类型 | `file_extraction` |
| 创建时间 | 2026-06-30T06:09:45.978 |
| 更新时间 | 2026-07-10T17:26:21.067 |
| 历史版本 | 3 个；最新版本号 3 |

## 旧库摘要

写作要求

## 旧库当前内容

来源文件：04-产品文档规范/PRD标准结构.md
切片序号：15

## 写作要求

- 先写产品逻辑，再写页面和字段。
- 每个字段必须归属到对象。
- 每个状态必须说明触发条件和可执行动作。
- 每个报表指标必须说明口径。
- 每个高风险动作必须说明审核、日志和回滚。
- 正文禁止使用 `待确认`、`以实际为准`、`以实际上线地址为准` 等占位话术；未决信息进入 assumptions 或交付元数据。
- 不要只写「与旧逻辑相同」或「在原有基础上」，必须写明继承什么、变化什么、影响什么、如何兼容。
- 不要输出只有建议清单的文档；必须输出可评审、可验收、可转测试用例的完整需求说明。
- PRD 不输出“资损表”“资损风险评估表”“资损点检表”等开发填报表格；涉及资损时，只描述风险场景、产品约束、控制点和验收要求。

