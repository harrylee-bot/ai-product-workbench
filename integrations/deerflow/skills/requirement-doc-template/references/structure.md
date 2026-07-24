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

`端内渠道` is a generic delivery-channel label. Preserve it literally; never expand it, `客户端`, `消费者端`, or `前端` into an affirmative APP or mini-program loading, publication, operation, or enabled-surface claim. Preserve explicit disabled or excluded APP/mini-program facts verbatim. Candidate-authored prose and `channel:inApp` are not source evidence; every Runtime `targetSurface` value, including `app` and `web`, is not source evidence and cannot activate safety row 12. Only an affirmative APP or mini-program fact from the user or an authorized source can activate that row; without one, row 12 is `不涉及` with no remarks.

## 2 业务需求

Use concise business language. The first paragraph may be:

`总体目标：<用一句话概括本需求闭环。>`

Recommended subsections:

### 2.1页面链接

Use bullets for:
- page entry
- physical page URL/route when provided; otherwise a generic reviewable logical entry such as `所属产品 > 模块 > 页面`; never turn that example into a concrete navigation hierarchy or claim that an invented hierarchy is irrelevant to acceptance
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

Use the 21-row safety baseline table from the template. The authoring model
cannot infer a safety row from its sequence number, so use the
following canonical rows exactly as written; never reorder, paraphrase, merge,
or shift a remark to another sequence.

| 序号 | 需求安全基线内容 | 范围 |
| --- | --- | --- |
| 1 | 是否有新开发功能接口或现有功能接口逻辑变动 | 信息系统（包含前端、后端、管理后台） |
| 2 | 业务功能是否面向公众用户 | 信息系统（包含前端、后端、管理后台） |
| 3 | 是否涉及新开通公网暴露面 | 信息系统（包含前端、后端、管理后台） |
| 4 | 管理后台涉及个人信息的内容要求脱敏展示，原则上不做非脱敏个人信息的导出功能。 | 管理后台 |
| 5 | 管理后台所有操作页面要有水印功能，水印至少包括姓名、手机号、操作时间等信息 | 管理后台 |
| 6 | 管理后台涉及查询的页面，不允许没有查询条件查询所有数据，必须输入查询条件后才可以查询数据； | 管理后台 |
| 7 | 管理后台应接入4A统一管理，实现一点注销的功能，不允许有独立的账号体系；按4A要求实现日志留存，并实现风险预警功能； | 管理后台 |
| 8 | 如未接入4A系统统一管理，应满足通行字的18项安全要求；要求细则找安全中心要； | 管理后台 |
| 9 | 涉及后台配置内容的需要实现“敏感词过滤”能力； | 管理后台 |
| 10 | 所有在前台展示的内容如为后台配置显示，均需要执行“先审后发”，1、具备“先审后发”能力，2、同步发布数据；3、内部发布上线和下线都需要经过“先审后发”。 | 前台展示 |
| 11 | 是否涉及展示《隐私政策》：新业务场景《隐私政策》或已有《隐私政策》的变更需要进行法务及安全审核；《隐私政策》应为独立的文档，四次点击应能访问到独立的菜单；用户未同意《隐私政策》前，不得获取用户任何信息； | 前端页面 |
| 12 | 如涉及加载到APP或小程序，APP、小程序业务应实现双清单功能，“用户信息收集清单”应动态准实时展现采集的个人信息具体内容；“第三方信息共享清单”应涵盖业务所有涉及到的第三方公司及内容； | 前端展示 底层接口获取数据 |
| 13 | 前台页面涉及采集身份证号码、身份证照片、生物识别和银行卡信息时，应再次获取用户的主动授权同意。 | 前端页面 |
| 14 | 是否涉及免密登录。免密登录的不能为无感知免密登录，需经过用户同意《数字生活隐私政策》后才可以进行免密登录。 | 前端页面 |
| 15 | 是否涉及跳转第三方页面或应用。如涉及，应进行弹窗提示，文案应包含：即将跳转的业务名称、第三方公司名称、传的用户信息用户操作目的及第三方的《隐私政策》相关内容，可参考线上已有弹窗。 | 前端页面 |
| 16 | 如涉及与第三方公司接口对接进行数据交互，应先查看对应的《数据使用审批单》无误后，才可以正式上线； | 前台、后台 |
| 17 | API接口安全管理：如为新增API接口，需完成台账填报； | 信息系统（包含前端、后端、管理后台） |
| 18 | 涉及用户敏感信息或跨系统的API是否采用加密传输，具备接口鉴权、访问控制等措施； | 信息系统（包含前端、后端、管理后台） |
| 19 | 是否涉及用户信息或重要数据存储，是否进行加密存储； | 信息系统（包含前端、后端、管理后台） |
| 20 | 是否涉及数据采集，是否建立数据采集规范，明确数采集方式、渠道、数据格式、采集流程等； | 信息系统（包含前端、后端、管理后台） |
| 21 | 是否对采集到的数据进行完整性和一致性校验； | 信息系统（包含前端、后端、管理后台） |

When producing typed PRD rows:

- Return sequences 1 through 21 exactly once and in this order. The renderer supplies the canonical baseline content and scope from the sequence.
- Set `applicability` only from explicit requirement facts outside this table.
- For `不涉及`, set `remarks` to `null`; do not invent or paraphrase an explanation.
- For `是` or `否`, make `remarks` describe evidence or remediation for that same canonical row only.

Adjust `是否涉及` conservatively:
- construction, development, implementation, modification, or upgrade of a function, page, control, flow, state behavior, or business capability: row 1 `是`
- row 1 never uses `否`; when it is `是`, its remarks must name the concrete changed function, page, interface, or logic
- row 1 may be `不涉及` only when the requirement body explicitly states there is no function, page, interface, or logic change; reusing or not adding a default, setting, field, status, or category only narrows scope and is not global no-change evidence
- public/user-facing page: row 2 `是`
- admin configured content shown on front-end and subject to review: row 10 `是`
- new API: row 17 `是`
- cross-system calls or sensitive API controls: row 18 `是`
- validation of submitted data or status consistency: row 21 `是`
- keep privacy, app mini-program checklist, ID/bank/biometric collection, third-party jump, and data storage rows as `不涉及` unless explicitly present.
- Preserve `端内渠道`, `客户端`, `消费者端`, and `前端` literally; never expand them into an affirmative APP or mini-program loading, publication, operation, or enabled-surface claim. Preserve explicit excluded or disabled APP/mini-program facts verbatim. Candidate-authored prose and `channel:inApp` are not source evidence; every Runtime `targetSurface` value, including `app` and `web`, is not source evidence and cannot activate row 12. Only an affirmative APP or mini-program fact from the user or an authorized source can do so; without one, row 12 is `不涉及` with no remarks.
- The `是否涉及` value must be exactly one of `是`, `否`, or `不涉及`, with no punctuation or explanatory text in that cell.
- Derive values from requirement facts outside the safety table. The wording of a safety row must never trigger its own `是` value.
