# Standard Requirement Document Structure

This is the production Runtime copy of the user's `requirement-doc-template` structure. It governs every newly created `workbench.prd.v2` document.

## Document Front Matter

The document begins with these three parts in order:

1. Cover titled `<工单名称>需求说明书`. The Artifact title, document title, and cover title must match.
2. `版 本 历 史` with `版本/状态`, `作者`, `参与者`, `起止日期`, and `备注`. The first row is a real `讨论稿` record with an author, review participants, date range, and change note.
3. `目 录` with this exact baseline outline:

```text
1 引言
1.1项目背景
1.2文档范围
1.3使用场景（必填）
2 业务需求
2.1页面链接
2.2 核心业务规则/功能说明
2.3 核心流程/状态/页面要求
2.4 验收标准
3. 业务降级方案（必填）
4. 需求安全基线要求（必填）
```

## 1 引言

### 1.1项目背景

Write one or two concise paragraphs that state the involved product/system/channel, current state, reason for change, changed module, target function, and business purpose. Do not duplicate later rules.

### 1.2文档范围

Use an explicit list covering affected pages, fields or states, permission or review flow, jump/copy/share behavior when relevant, acceptance, degradation, and safety baseline.

### 1.3使用场景（必填）

Describe the actor, entry, trigger, and intended result. Include exactly one channel table with these rows in order:

| 序号 | 活动投放的可选渠道 | 是否投放 |
| --- | --- | --- |
| 1 | 端内渠道 | requirement fact |
| 2 | WAP/H5端外渠道 | requirement fact |
| 3 | 小程序 | requirement fact |

Enable a channel only when the requirement facts explicitly include it. A listed option or excluded channel is not evidence that it is enabled.

## 2 业务需求

Start with `总体目标：<完整业务闭环>`.

### 2.1页面链接

State a physical route when supplied. Otherwise use a reviewable logical entry such as `所属产品 > 模块 > 页面`. Always explain what the page must do; a link is never a substitute for behavior.

### 2.2 核心业务规则/功能说明

Use concrete prose and business tables. For every changed capability, state the operation, trigger, data or state rule, permission, expected result, and exception behavior. Suitable table shapes include:

- `功能点 / 业务规则 / 页面要求`
- `字段或控件 / 规则 / 权限 / 默认值`
- `条件 / 处理结果`
- `操作 / 系统响应 / 关键要求`

Do not add a standalone API/interface section. Describe cross-system behavior as business trigger, state, result, and failure handling.

### 2.3 核心流程/状态/页面要求

Include both diagrams in this order:

1. `图1 产品流程图`: actor entry, trigger, validation, operation, result, failure, retry, permission, and empty-state branches that apply.
2. `图2 产品架构图`: page, capability, configuration, rule, state/record, exception governance, and acceptance/reporting relationships.

Use product language, not API names or tool/runtime internals. Each diagram needs nearby text that explains how it maps to the requirement.

### 2.4 验收标准

Use exactly the baseline columns `序号 / 验收项 / 验收标准`. Criteria must be independently testable and cover relevant visibility, input/data rules, permissions, submit/review/state flow, sorting, result, empty state, error state, and recovery.

## 3 业务降级方案（必填）

When degradation applies, write at least 100 Chinese characters covering dependency failure, downstream unavailability, permission failure, status-sync delay, and output/delivery failure when relevant. State what is retained, what the user sees, which action remains available, how duplicates are prevented, and how recovery is reconciled.

Only use the exact content `不涉及` when no meaningful fallback exists.

## 4 需求安全基线要求（必填）

Keep the standard introduction and all 21 canonical rows from the Runtime contract. `是否涉及` is exactly `是`, `否`, or `不涉及`; explanation belongs in `remarks`.

Derive every value from facts outside the safety table. Keep privacy, app/mini-program checklist, identity/bank/biometric collection, third-party jump, third-party exchange, and storage rows as `不涉及` without explicit evidence. Typical fact-based rows include public-facing page (2), reviewed admin content shown on front end (10), new API (17), sensitive/cross-system API controls (18), and submitted-data consistency validation (21).
