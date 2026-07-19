---
title: "旧库来源｜原型生成调用规则 / Prototype Designer Agent｜2d086df39aab"
description: "Prototype Designer Agent"
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
  - "原型模式/调用规则"
  - "原型规则"
  - "PrototypeSpec"
aliases:
  - "原型生成调用规则 / Prototype Designer Agent"
source: "storage/source-assets/legacy-knowledge-20260716/knowledge-items.ndjson"
legacyKnowledgeId: "vault_dfbb30ae5951a0a1f7a9c1cec1be5f31"
legacyStatus: "active"
legacyCategoryId: "1bd1c6db-acfb-4585-8fb5-c4304ee02c17"
retrievalScope: "source_lookup"
---

# 原型生成调用规则 / Prototype Designer Agent

## 来源元数据

| 项目 | 内容 |
| --- | --- |
| 旧知识 ID | `vault_dfbb30ae5951a0a1f7a9c1cec1be5f31` |
| 分类 | 来源资产索引 |
| 类型 | `design_pattern` |
| 范围 | `global` |
| 优先级 | `low` |
| 旧状态 | `active` |
| 新检索状态 | 仅查来源 |
| 旧来源类型 | `file_extraction` |
| 创建时间 | 2026-06-30T02:36:47.149 |
| 更新时间 | 2026-07-10T06:40:41.428 |
| 历史版本 | 2 个；最新版本号 2 |

## 旧库摘要

Prototype Designer Agent

## 旧库当前内容

来源文件：07-来源资产索引/旧版整理/04-原型模式/前后端设计框架/原型生成调用规则.md
切片序号：2

## Prototype Designer Agent

- 先识别需求属于前台页面、后台配置、报表、素材库、奖品券、OAO/号卡中的哪类。
- 至少选择一个设计框架作为结构来源。
- PrototypeSpec 的 pages 需要体现核心业务页面，不只生成一个泛化首页。
- 每个 page/component 必须保留 `sourcePaths`，对应 ProductDesignState 的页面、功能、规则、状态或验收项。
- 对后台配置类需求，PrototypeSpec 至少包含列表页和配置/详情页。
- 对前台活动类需求，PrototypeSpec 至少包含参与页、结果反馈和规则说明。

