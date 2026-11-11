# Standard Requirement Document Structure

Use this reference after the skill triggers. The canonical visual example is `../assets/requirement-template.docx`, based on the user's H5 domain Word example.

## Document Style

- Chinese Word requirement document.
- A4 page, portrait orientation, top/bottom margins about 2.5 cm, left/right margins about 3.0 cm.
- Preserve template styles instead of inventing new typography: `Normal0` for the cover title, `Normal` for body text, `Heading 1`, `Heading 2`, `toc 1`, `toc 2`, and existing table formatting.
- 全文可编辑文字统一为黑色（`#000000`），包括封面、各级标题、正文、超链接、图注、页眉页脚及表格文字；用字号、加粗和间距区分层级。表格统一白底、黑色边框，不使用彩色表头、交替底色、文字高亮或残留主题色。原有截图、标识和参考图片保留原色，除非用户另有要求。
- 保持正文紧凑易读；检查字符网格、自动间距、空段落、固定行高和跨页设置，修正异常留白或截字，不复制参考文档的排版缺陷。
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

沿用 H5 示例的主章顺序与层级。业务章从 `2.2` 起按本次实际功能连续展开，不固定为“核心业务规则/功能说明、核心流程/状态/页面要求、验收标准”三个通用标题。

```text
1 引言
1.1 项目背景
1.2 文档范围
1.3 使用场景（必填）
2 业务需求
2.1 页面链接
2.2 <本次具体功能或业务规则一>
2.3 <本次具体功能或业务规则二，按需>
2.n <后续业务内容，按需>
3 业务降级方案（必填）
4 需求安全基线要求（必填）
```

- 功能数量由需求决定，单项需求可只到 `2.2`，多项需求依次增加。标题直接说明本次改动，复杂功能可再分三级标题；不要复用示例的“电子受理单”等业务名称。
- 相关流程、状态、页面规则、依赖条件和验收标准可直接放在对应功能节。内容较多或跨功能时，可在功能节之后另设“核心流程及页面要求”“验收标准”等小节，编号随实际顺序变化，不强占 `2.3`、`2.4`。
- 如本次涉及且有材料支持，可仿照 H5 示例增加“本需求涉及新增/修改的接口”小节，说明接口影响范围、用途和业务变化；地址、字段等仅使用有依据的信息，不为套模板虚构接口，不强制编写技术设计级契约。不涉及接口变化时直接省略该节。
- 目录根据最终正文生成并更新编号、标题和页码，不保留被删除的小节或模板示例标题。

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

Use `2.1 页面链接` followed by function-specific subsections starting at `2.2`:

### 2.1页面链接

Use bullets for:
- page entry
- physical page URL/route when provided; otherwise a generic reviewable logical entry such as `所属产品 > 模块 > 页面`; never turn that example into a concrete navigation hierarchy or claim that an invented hierarchy is irrelevant to acceptance
- target page or downstream system if any

Do not paste a link as a substitute for requirements. Always describe what the linked page/system must do.

### Core Functional Sections

按具体功能或业务规则命名，如“Banner 自适应优化”“免密登录手机号回显与提交校验”“活动客流指标排序”。在相应功能节中说明场景、操作和触发、数据与界面规则、异常结果、依赖及可验证的验收条件；不适用的内容无需机械增设空标题。

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

流程图和产品架构图均为按需内容，不再要求每份需求文档同时添加两张图。分别判断两类图的必要性，可不画、只画流程图、只画产品架构图，或两者都画；由编写者自行决定，无需为常规选图询问用户。用户明确要求添加/省略某类图，或本次交付规范明确要求时，遵循该要求。参考模板中出现过某张图，本身不等于本次必须保留。

判断需求大小时，看实际改动范围、参与角色、业务分支、状态变化、模块依赖和理解难度。页数、字数和需求条目数量只作辅助；多项互相独立的小改动，不自动构成需要总流程或总体架构的大需求。

| 图类型 | 适合添加的情况 | 通常可以省略的情况 |
| --- | --- | --- |
| 产品流程图 | 存在多步办理、跨角色交接、审批分支、状态流转、异步回调、失败重试等关系，图能帮助评审判断先后顺序或关键路径 | 文案、样式、单字段、局部筛选/排序等简单修改，或少量线性操作已能用步骤和规则表说清 |
| 产品架构图 | 涉及多模块/多端协作、共享业务能力、配置与展示关系或跨系统业务边界，图能帮助评审理解范围与依赖 | 单页面、单能力的局部调整，或若干独立修改没有需要说明的共同结构 |

- 复杂度优先于数量：单个多角色审批需求可能只需要流程图；多模块能力整理可能只需要产品架构图；局部表头排序或文案调整通常两者都不需要。
- 只有当图比现有文字或表格更清楚地表达业务关系时才添加。不要为凑齐图的种类，重复正文、堆砌“页面—规则—结果”等通用框架，或为小改动扩写不存在的系统结构。
- 图放在相关功能节，或按需增设后续的流程/产品结构小节，不固定占用 `2.3`。不画图时，在功能节用相称的步骤、条件/结果表、状态表或页面规则讲清业务。删除未使用的图标题、图注、占位和目录条目，不用空图或空章节代替说明。
- 判断依据留在编写过程；不必在正文新增选图决策章节。

添加图时：

- `产品流程图` 只覆盖本次相关的触发、操作、判断、流转和结果；仅在需求实际涉及权限、无数据、失败、重试等路径时展示，不机械补齐全部分支。复杂需求可按关键流程拆图，不必画一张包含所有条目的总图。
- `产品架构图` 表达角色、页面、产品模块、业务能力、配置、规则或业务数据之间的实际关系。保持产品视角，不虚构 API、技术组件或基础设施，不展示工具日志和资料检索过程。
- 在图旁用简短文字说明它对应的需求范围及关键关系，确保图、正文和验收口径一致。
- 图号按实际出现顺序连续编号，图注可用 `图N 产品流程图`、`图N 产品架构图`，多图时补充业务名称。流程图和架构图不再固定占用图1、图2；增删图后同步更新引用和目录。

### 验收标准

每项功能都应有可验证的验收条件，可直接写在功能节中；跨功能验收内容较多时再增加独立验收小节，其编号随业务章节实际顺序确定。无需强制保留名为 `2.4 验收标准` 的章节。

Use a table when it makes the criteria easier to review:
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
