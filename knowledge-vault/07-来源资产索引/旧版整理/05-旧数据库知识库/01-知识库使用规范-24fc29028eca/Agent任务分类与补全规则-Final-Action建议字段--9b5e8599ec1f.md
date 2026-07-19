---
title: "旧库来源｜Agent任务分类与补全规则 / Final Action建议字段｜9b5e8599ec1f"
description: "Final Action建议字段"
date: "2026-07-16"
status: "仅查来源"
tags:
  - "旧数据库知识库"
  - "来源条目"
  - "知识库使用规范"
  - "strong_rule"
  - "vault-sync"
  - "knowledge-vault"
  - "vault-tier:main"
  - "Agent执行规则"
  - "需求补全"
aliases:
  - "Agent任务分类与补全规则 / Final Action建议字段"
source: "storage/source-assets/legacy-knowledge-20260716/knowledge-items.ndjson"
legacyKnowledgeId: "vault_e35a871989e804ddc4780919a541876a"
legacyStatus: "active"
legacyCategoryId: "788058d7-afb1-44da-a2b4-47dbfafd1374"
retrievalScope: "source_lookup"
---

# Agent任务分类与补全规则 / Final Action建议字段

## 来源元数据

| 项目 | 内容 |
| --- | --- |
| 旧知识 ID | `vault_e35a871989e804ddc4780919a541876a` |
| 分类 | 知识库使用规范 |
| 类型 | `strong_rule` |
| 范围 | `global` |
| 优先级 | `high` |
| 旧状态 | `active` |
| 新检索状态 | 仅查来源 |
| 旧来源类型 | `file_extraction` |
| 创建时间 | 2026-06-30T02:36:45.077 |
| 更新时间 | 2026-07-10T06:40:38.69 |
| 历史版本 | 2 个；最新版本号 2 |

## 旧库摘要

Final Action建议字段

## 旧库当前内容

来源文件：00-知识库使用规范/Agent任务分类与补全规则.md
切片序号：6

## Final Action建议字段

DeerFlow final action 可以额外携带这些字段，后端会把它们保存在 raw 中，便于后续审计和 UI 展示：

```json
{
  "requirementMode": "historical_extension | new_capability | one_sentence_completion",
  "knowledgeRefsUsed": ["01-产品架构/产品能力地图", "02-业务域知识/活动发布与模板配置"],
  "assumptions": ["默认沿用平台活动发布流程", "后台需要配置页和预览审核页"],
  "consistencyStrategy": "历史增量沿用原导航和字段分组，只新增奖品核销状态"
}
```

