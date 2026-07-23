# Standard Requirement Document Structure

Use this reference after the skill triggers. The canonical visual example is `../assets/requirement-template.docx`, based on the user's H5 domain Word example.

## Document Style

- Chinese Word requirement document.
- A4 page, portrait orientation, top/bottom margins about 2.5 cm, left/right margins about 3.0 cm.
- Preserve template styles instead of inventing new typography: `Normal0` for the cover title, `Normal` for body text, `Heading 1`, `Heading 2`, `toc 1`, `toc 2`, and existing table formatting.
- Blue heading hierarchy, compact body copy, and simple business tables.
- Cover title format: `<工单名称>需求说明书`, matching the final file name and requirement work order name. Do not keep the template reminder line under the title.
- Include footer text with the document title when practical.
- Use real Word headings for main content. The TOC is manual in the template and must be kept aligned with the body headings.
- Use tables for structured rules, acceptance criteria, channels, and safety baseline.
- Use bullets for scope, page rules, sorting rules, exception rules, and degradation plans.

## Fixed Section Order

### Cover

Include:
- `<工单名称>需求说明书`
- No template reminder text.

### Version History

Heading text: `版 本 历 史`

Table columns:
- `版本/状态`
- `作者`
- `参与者`
- `起止日期`
- `备注`

Default first row:
- `讨论稿`
- author from user if known, otherwise the non-placeholder role `需求方`
- participants from context, otherwise `业务、研发、测试评审人`
- current or user-specified date
- concise change note

For final deliverables, do not leave `业务大大名字（必填）`.

### Manual TOC

Heading text: `目 录`. The H5 template contains a reminder next to this heading; delete that reminder in final documents.

Use this fixed outline. Additional business subsections may be added after `2.4`, but the listed entries may not be removed or renamed:

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

If the requirement needs more business sections, insert `2.5` and later sections before the degradation section and update the TOC.

## 1 引言

### 1.1项目背景

Write 1-2 paragraphs that clearly state:
- involved system/software/channel
- current state
- reason for change
- module(s) to be changed
- target function or business purpose

The background and later requirement description must be related but not duplicated.

### 1.2文档范围

Use bullets. Include:
- affected front-end/back-end/admin pages
- data fields or status changes
- approval/review flow if any
- jump/copy/share behavior if any
- acceptance criteria, degradation, and safety baseline

### 1.3使用场景（必填）

Add one short paragraph, then a channel table.

Default channel table columns:
- `序号`
- `活动投放的可选渠道`
- `是否投放`

Default rows:
- `端内渠道`
- `WAP/H5端外渠道`
- `小程序`

Set checkboxes according to the requirement. Use `☑是 □否` or `□是 ☑否`.

Keep exactly one channel table. A channel is selected only when the user input or structured requirement state explicitly enables it. Merely listing H5 or mini program as an option, or saying that it is excluded, must not select it.

## 2 业务需求

Use concise business language. The first paragraph may be:

`总体目标：<用一句话概括本需求闭环。>`

Recommended subsections:

### 2.1页面链接

Use bullets for:
- page entry
- physical page URL/route when provided; otherwise a reviewable logical entry such as `所属产品 > 模块 > 页面`
- target page or downstream system if any

Do not paste a link as a substitute for requirements. Always describe what the linked page/system must do.

### Core Functional Sections

Use a mix of prose, bullets, and tables. Common table patterns:

Feature/rule/page table:
- `功能点`
- `业务规则`
- `页面要求`

Field/permission/default table:
- `字段/控件`
- `规则`
- `权限`
- `默认值`

State/result table:
- `条件`
- `处理结果`

Operation/response/requirement table:
- `操作`
- `系统响应`
- `关键要求`

### Product Flow And Architecture Diagrams

Always add both diagrams for a full requirement document:

- `产品流程图`: cover triggers, validation, user/operator action, system result, failure, retry, no-permission, and empty states.
- `产品架构图`: cover page, capability, configuration, rule, state/record, exception governance, and acceptance/reporting relationships.

Use product language and do not expose API names, tool logs, knowledge references, or external-research evidence.

The product flow must include relevant paths such as:
- create/submit/review/publish process
- approval pass/fail branches
- copy/jump to another system
- state transition or permission gate
- email/file sending or callback process

Caption formats:

`图1 产品流程图`
`图2 产品架构图`

Add a short paragraph near the diagram explaining how it maps to this requirement.

### 验收标准

Use table:
- `序号`
- `验收项`
- `验收标准`

Each acceptance standard must be testable. Cover:
- page/tab visibility
- filtering or data rules
- permission control
- submit/review/state flow
- sorting
- copy/jump/submit result
- empty/error state

## 3 业务降级方案（必填）

Prefer concrete degradation bullets:
- list dependent service failure behavior
- downstream page/system unavailable behavior
- permission service failure behavior
- review callback/status sync delay behavior
- email/file generation or sending failure behavior

Only write `不涉及` when no meaningful degradation exists. When degradation applies, write at least 100 Chinese characters and remove all template wording.

## 4 需求安全基线要求（必填）

Keep the standard intro text:

```text
该部分内容为必填项，请按照如下表格中的内容先进行自查，并按照如下要求完善需求文档：
1、如选择“是”，代表本项自查内容已符合安全要求，需要提供截图违依据
2、如选择“否”，代表本项自查内容暂时不符合安全要求，请在需求文档中增加本部分内容安全改造需求，并发送网信安需求评审邮件，附上本需求文档用于安全评审；
3、如选择“不涉及”，代表本项目各项需求安全基线均不涉及，则无需召开网信安需求评审会。
建议：该表格请业务人员和开发人员共同参与自查并填写。
```

Use the 21-row safety baseline table from the template. Adjust `是否涉及` conservatively:
- public/user-facing page: row 2 `是`
- admin configured content shown on front-end and subject to review: row 10 `是`
- new API: row 17 `是`
- cross-system calls or sensitive API controls: row 18 `是`
- validation of submitted data or status consistency: row 21 `是`
- keep privacy, app mini-program checklist, ID/bank/biometric collection, third-party jump, and data storage rows as `不涉及` unless explicitly present.
- The `是否涉及` value must be exactly one of `是`, `否`, or `不涉及`, with no punctuation or explanatory text in that cell.
- Derive values from requirement facts outside the safety table. The wording of a safety row must never trigger its own `是` value.
