---
title: "旧库来源｜原型生成调用规则 / Prototype Code Agent｜3aad164b43c4"
description: "Prototype Code Agent"
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
  - "原型生成调用规则 / Prototype Code Agent"
source: "storage/source-assets/legacy-knowledge-20260716/knowledge-items.ndjson"
legacyKnowledgeId: "vault_96c8a1bfa06dff0a72b91e011da39aa3"
legacyStatus: "active"
legacyCategoryId: "1bd1c6db-acfb-4585-8fb5-c4304ee02c17"
retrievalScope: "source_lookup"
---

# 原型生成调用规则 / Prototype Code Agent

## 来源元数据

| 项目 | 内容 |
| --- | --- |
| 旧知识 ID | `vault_96c8a1bfa06dff0a72b91e011da39aa3` |
| 分类 | 来源资产索引 |
| 类型 | `design_pattern` |
| 范围 | `global` |
| 优先级 | `low` |
| 旧状态 | `active` |
| 新检索状态 | 仅查来源 |
| 旧来源类型 | `file_extraction` |
| 创建时间 | 2026-06-30T02:36:47.153 |
| 更新时间 | 2026-07-10T06:40:41.432 |
| 历史版本 | 2 个；最新版本号 2 |

## 旧库摘要

Prototype Code Agent

## 旧库当前内容

来源文件：07-来源资产索引/旧版整理/04-原型模式/前后端设计框架/原型生成调用规则.md
切片序号：3

## Prototype Code Agent

- 输出单文件 HTML，内联 CSS 和少量原生 JS，不访问真实接口，不引入远程脚本。
- 关键元素必须带 `data-page-id` 和 `data-component-id`。
- 必须演示核心状态切换：默认、加载、成功、失败、无权限或空态。
- 后台配置原型要体现筛选、表格、表单、预览、审核/发布操作。
- 前台活动原型要体现主行动、资格校验、结果反馈、规则说明。
- 同时输出 OpenPencil 文档，用于后续画布编辑。

