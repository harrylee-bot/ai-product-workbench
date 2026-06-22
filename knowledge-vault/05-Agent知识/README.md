---
title: Agent 知识
description: Agent 职责、输入输出、协作流程、知识库调用和流式展示规范。
date: 2026-06-22
status: 已维护
tags:
  - Agent知识
  - 图谱/Agent层
aliases:
  - Agent 知识入口
---

# Agent 知识

Agent 知识用于约束系统内部角色。所有 Agent 都必须受 [[00-系统说明/三系统融合架构|三系统融合架构]] 管控，不能绕过约束、决策和进化记录。

## 核心条目

- [[05-Agent知识/需求分析Agent知识|需求分析 Agent 知识]]
- [[05-Agent知识/三系统Agent协作规范|三系统 Agent 协作规范]]
- [[05-Agent知识/知识库调用规范|知识库调用规范]]

## 基本原则

- Agent 不直接写数据库。
- Agent 不直接决定最终策略。
- Agent 输出必须是结构化 JSON。
- Agent 运行状态要能进入 [[04-原型模式/执行路径流式展示模式|执行路径流式展示模式]]。
- Agent 调用知识时必须保留 knowledgeRefs，方便追溯来源。
