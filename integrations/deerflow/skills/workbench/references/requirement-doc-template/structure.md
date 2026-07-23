# Standard Requirement Document Structure

This is the production Runtime adaptation of the user's
`requirement-doc-template` structure. Its source fingerprints and required
semantic anchors are recorded in `source-profile.json`; Runtime adds typed IR
transport rules without weakening those source semantics. It governs every
newly created `workbench.prd.v2` document.

## Document Front Matter

The document begins with these three parts in order:

1. Cover titled `<工单名称>需求说明书`. The Artifact title, document title, and cover title must match.
2. `版 本 历 史` with `版本/状态`, `作者`, `参与者`, `起止日期`, and `备注`. The first row is a non-placeholder `讨论稿` record with an author, review participants, date range, and change note. Use an explicitly supplied author or participant name only when it exists in authorized context. Otherwise use the role fallback `需求方` for author and the separate participant roles `业务评审人`, `研发评审人`, and `测试评审人`; never invent a person's name. Use the current date or an explicitly supplied date.
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

Keep the standard introduction and all 21 canonical rows below. Runtime stores
each row as `sequence`, `applicability`, and `remarks`; the renderer restores the
canonical requirement and scope from `sequence`.

Apply these semantics independently to every row using facts outside the safety
table:

- `是`: the topic applies and the PRD already states the corresponding compliant requirement or control. `remarks` identifies that fact.
- `否`: the topic applies but is not yet compliant, and the PRD body contains a concrete remediation for the same topic. `remarks` identifies the gap and remediation.
- `不涉及`: no affirmative fact for the topic exists in the PRD. It is invalid when any body section says the topic applies.
- Safety-table wording is never evidence for itself. Keep privacy, APP/mini-program checklist, identity/bank/biometric collection, third-party jump, third-party exchange, and storage rows as `不涉及` without explicit requirement facts.

| 序号 | 自查要求 | 适用范围 |
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

## Typed IR Integrity

- For a v2 create, `documentId`, every assumption/citation/block ID, nested list item, table column and row ID, flow step, diagram, diagram node, and diagram edge ID is globally unique across the whole document.
- Every table row contains exactly one cell for every declared column and no cell references an unknown column.
- Every diagram edge references declared nodes in the same diagram and never points from a node to itself.
- Every requirement references declared goals and acceptance criteria. Every acceptance criterion references its owning requirements, and the requirement-to-criterion references are bidirectional.
- Every flow step references declared requirements. Inline citations, assumptions, sections, goals, requirements, acceptance criteria, and flow references resolve to declared targets.
- A revision retains `documentId`, advances the revision number, and preserves stable nested IDs for unchanged semantic entities.
