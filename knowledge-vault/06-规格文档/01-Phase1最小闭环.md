---
title: 01-Phase1 最小闭环
description: 用户到登录、项目、聊天、Orchestrator、Mock AI、PRD 与 Prototype 展示的最小可运行闭环。
date: 2026-06-22
status: 已维护
tags:
  - 规格文档/Phase1
  - 源规格
  - 最小闭环
aliases:
  - CODEX PHASE 1 TASK FILE
  - Phase 1 最小闭环
---

# 01-Phase1 最小闭环

Phase 1 的目标是构建 AI Product Workbench 的最小可运行闭环。

```text
用户
  → Login
  → Project
  → Chat
  → Orchestrator
  → Mock AI
  → PRD + Prototype
  → UI 展示
```

## 强制约束

禁止：

- 不允许引入 IR。
- 不允许引入 Compiler。
- 不允许引入 Decision Engine。
- 不允许复杂 Agent 系统。
- 所有 AI 必须 mock。
- 不允许 Patch System。
- 不允许 Review Board。
- 不允许 Evolution System。

必须：

- 必须使用 Orchestrator 统一入口。
- 所有数据必须入库。

## 项目结构

```text
apps/
  api/
  web/

packages/
  db/
```

## 后端任务

### Task 1 Auth Module

路径：`apps/api/src/modules/auth/`

功能：

- login
- me
- jwt auth
- role(user/admin)

API：

- `POST /auth/login`
- `GET /auth/me`

DB：

```text
User {
  id
  email
  password
  role
}
```

验收：

- 登录成功返回 JWT。
- `/me` 可访问。
- role 区分。

### Task 2 Project Module

路径：`apps/api/src/modules/project/`

功能：

- create project
- list projects
- get project

DB：

```text
Project {
  id
  userId
  title
}
```

验收：

- 用户可创建项目。
- 自动绑定 userId。

### Task 3 Conversation Module

路径：`apps/api/src/modules/conversation/`

功能：

- create conversation
- list by project

规则：

- 创建 project 自动生成 conversation。

DB：

```text
Conversation {
  id
  projectId
  title
}
```

### Task 4 Message Module

路径：`apps/api/src/modules/message/`

功能：

- save message
- trigger orchestrator
- return AI response

API：

- `POST /messages`

流程：

```text
user message
  → orchestrator
  → AI response
```

### Task 5 Orchestrator

路径：`apps/api/src/modules/ai/orchestrator/`

职责：

- 接收 message。
- 调用 mock agents。
- 生成 ProductDesignState。
- 返回 PRD + Prototype。

流程：

1. save user message
2. Intent Agent mock
3. Product Agent mock
4. PRD mock
5. Prototype mock
6. save assistant message

### Task 6 Intent Agent Mock

路径：`apps/api/src/modules/ai/agents/intent/`

输出：

```json
{
  "intent": "new_requirement"
}
```

### Task 7 Product Agent Mock

输出 ProductDesignState mock：

```json
{
  "title": "string",
  "businessGoal": "string",
  "pages": [],
  "rules": []
}
```

### Task 8 PRD Agent Mock

输出：

```json
{
  "sections": [
    {
      "title": "需求背景",
      "content": "mock content"
    }
  ]
}
```

### Task 9 Prototype Agent Mock

输出：

```json
{
  "html": "<html><body>mock</body></html>"
}
```

### Task 10 Product Design State

路径：`apps/api/src/modules/state/`

DB：

```text
ProductDesignState {
  id
  projectId
  title
  businessGoal
  pages(json)
  rules(json)
  version
}
```

规则：

- 每次 message 必须更新。

## 前端任务

### Task 11 Login Page

路径：`apps/web/app/login/page.tsx`

功能：

- email/password login
- jwt

### Task 12 Workspace Layout

路径：`apps/web/app/workspace/page.tsx`

固定结构：

```text
┌──────────────┬──────────────┬──────────────┐
│ Projects     │ Chat         │ Preview      │
└──────────────┴──────────────┴──────────────┘
```

### Task 13 Project List

组件：`components/project-list.tsx`

功能：

- list projects
- select project

### Task 14 Chat Panel

组件：`components/chat-panel.tsx`

功能：

- input message
- send → `/messages`

### Task 15 Preview Panel

组件：`components/preview-panel.tsx`

显示：

- PRD mock
- Prototype mock

## API Flow

```text
Frontend Chat
  ↓
POST /messages
  ↓
Orchestrator
  ↓
Mock Agents
  ↓
Return PRD + Prototype
  ↓
Render UI
```

## SSE 最小实现

`GET /ai/stream/:conversationId`

返回：

```json
{
  "type": "agent_step",
  "content": "intent_detected"
}
```

## Seed Data

- admin user 必须存在。
- 默认 project 必须存在。

## 验收标准

- 可以登录。
- 可以创建项目。
- 可以聊天。
- Orchestrator 被触发。
- 返回 PRD mock。
- 返回 Prototype mock。
- UI 三栏正常。
- 数据全部入库。

## 图谱连接

- 前置总体规格：[[06-规格文档/00-总体执行规格]]
- 下一阶段：[[06-规格文档/02-Phase2决策系统]]
- 结果预览：[[04-原型模式/AI结果中心预览模式]]
- 系统链路：[[00-系统说明/系统执行链路]]

