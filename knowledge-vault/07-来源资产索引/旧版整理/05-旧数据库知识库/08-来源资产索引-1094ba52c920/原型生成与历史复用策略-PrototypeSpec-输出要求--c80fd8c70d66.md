---
title: "旧库来源｜原型生成与历史复用策略 / PrototypeSpec 输出要求｜c80fd8c70d66"
description: "PrototypeSpec 输出要求"
date: "2026-07-16"
status: "仅查来源"
tags:
  - "旧数据库知识库"
  - "来源条目"
  - "来源资产索引"
  - "design_pattern"
  - "vault-sync"
  - "knowledge-vault"
  - "vault-tier:source"
  - "原型规则"
  - "PrototypeSpec"
  - "HTML 原型"
  - "OpenPencil"
aliases:
  - "原型生成与历史复用策略 / PrototypeSpec 输出要求"
source: "storage/source-assets/legacy-knowledge-20260716/knowledge-items.ndjson"
legacyKnowledgeId: "vault_87209df2be334dd3192c92c321267e93"
legacyStatus: "active"
legacyCategoryId: "1bd1c6db-acfb-4585-8fb5-c4304ee02c17"
retrievalScope: "source_lookup"
---

# 原型生成与历史复用策略 / PrototypeSpec 输出要求

## 来源元数据

| 项目 | 内容 |
| --- | --- |
| 旧知识 ID | `vault_87209df2be334dd3192c92c321267e93` |
| 分类 | 来源资产索引 |
| 类型 | `design_pattern` |
| 范围 | `global` |
| 优先级 | `low` |
| 旧状态 | `active` |
| 新检索状态 | 仅查来源 |
| 旧来源类型 | `file_extraction` |
| 创建时间 | 2026-06-30T02:36:45.995 |
| 更新时间 | 2026-07-10T06:40:40.105 |
| 历史版本 | 2 个；最新版本号 2 |

## 旧库摘要

PrototypeSpec 输出要求

## 旧库当前内容

来源文件：07-来源资产索引/旧版整理/00-AI使用总纲/原型生成与历史复用策略.md
切片序号：6

## PrototypeSpec 输出要求

生成 PrototypeSpec 时必须包含：

- `pages`：后台页、前台页、预览页、审核页、报表页是否覆盖。
- `components`：列表、筛选、表单、状态标签、审核流、预览区、数据表、弹窗。
- `fields`：字段名、默认值、校验、生效范围、展示位置和数据来源。
- `states`：正常、空态、加载、失败、无权限、审核驳回、发布失败。
- `interactions`：配置变更如何影响预览，提交如何触发校验，导出如何受权限控制。
- `dataContracts`：接口不写真实地址，但要写清输入、输出、错误码和前端展示口径。

