# Agent 工作流知识库问题交接文档

更新时间：2026-07-08

## 背景

本次调试目标是优化“输入一句需求后生成需求文档和原型”的 agent 工作流。用户明确要求：需求文档只按本机 `requirement-doc-template` skill 的规范输出，其他生成过程说明、接口章节、模型/联网补齐证据不要写进 PRD 正文。

测试题目：

```text
我想做一个签到领积分的活动，请根据知识库内容生成需求文档和原型
```

## 暴露出的知识库问题

### 1. PRD 标准结构与本机 skill 不一致

问题表现：

- 本机 `requirement-doc-template` 已要求去掉 `本需求涉及新增/修改的接口`。
- 但项目知识库里的 `PRD标准结构` 仍把 `2.4 本需求涉及新增/修改的接口` 当作固定章节。
- DeerFlow runtime skill 也保留了接口章节或接口能力口径，导致线上 agent 可能被旧知识误导。

已处理位置：

- `/Users/liyannong/.codex/skills/requirement-doc-template`
- `/Users/liyannong/ai-product-workbench/knowledge-vault/04-产品文档规范/PRD标准结构.md`
- `/Users/liyannong/ai-product-workbench/knowledge-vault/04-产品文档规范/README.md`
- `/Users/liyannong/ai-product-workbench/integrations/deerflow/skills/ai-product-workbench/SKILL.md`

当前要求：

- 固定章节为：封面、版 本 历 史、目 录、1 引言、2 业务需求、3 业务降级方案（必填）、4 需求安全基线要求（必填）。
- `2 业务需求` 下可有核心规则、流程/状态/页面要求、验收标准。
- 不新增 `本需求涉及新增/修改的接口` 等独立接口章节。

### 2. 多个规则源同时参与生成，容易互相污染

本次发现实际影响生成的规则源不止本机 skill：

- 本机 Codex skill：`~/.codex/skills/requirement-doc-template`
- 项目知识库：`knowledge-vault/04-产品文档规范/PRD标准结构.md`
- DeerFlow runtime skill：`integrations/deerflow/skills/ai-product-workbench/SKILL.md`
- API prompt contract：`apps/api/src/ai/deerflow-runtime.service.ts`
- 超时兜底 PRD：`apps/api/src/ai/aichat/aichat-stream.service.ts`
- 导出兜底逻辑：`apps/api/src/ai/export.service.ts`
- 格式化兜底逻辑：`apps/api/src/ai/requirement-document-format.ts`

交接建议：

- 后续改 PRD 模板规范时，不要只改其中一个文件。
- 至少同步检查本机 skill、`knowledge-vault`、DeerFlow skill、API prompt、fallback/export formatter。
- 改完后必须跑线上真实烟测，不能只看本地输出。

### 3. 补齐证据被写入 PRD 正文

问题表现：

- 早期评测门禁鼓励“PRD 包含知识库和补齐说明”“PRD 包含外部证据和补齐边界”。
- 超时兜底会把 `联网补齐证据`、公开 URL、外部补充状态写入 `4 需求安全基线要求` 正文。
- 这违背“按照需求文档技能规范输出，其他不要多写”。

已调整为：

- PRD 正文只放需求文档内容。
- 知识库、模型补齐、联网证据只保留在元数据或评测报告里：
  - `knowledgeRefs`
  - `validationNotes`
  - agent workflow eval/smoke summary
- 线上烟测新增检查：`线上 PRD 正文不写补齐证据章节`。

当前验证证据：

```text
线上 PRD 正文不写补齐证据章节: passed
evidence: no trace/evidence section in PRD body
```

### 4. 安全基线里仍有 API 行，不能误删

注意点：

- 21 行安全基线表来自模板标准，其中第 17/18 行包含 API/接口安全措辞。
- 用户要求删除的是独立章节 `本需求涉及新增/修改的接口`，不是删除安全基线模板行。
- 因此安全基线行应保留，只调整 `是否涉及` 为 `是 / 否 / 不涉及`。

后续不要把“PRD 正文无接口章节”误解成“安全基线不能出现 API 字样”。

### 5. 旧来源资产仍有接口演示语义

已知残留：

```text
knowledge-vault/07-来源资产索引/旧版整理/04-原型模式/前后端设计框架/前后端字段与接口口径.md
```

其中有类似“接口返回失败”的原型演示状态。该文件属于旧原型模式知识，不是 PRD 标准结构。当前未作为 PRD 固定章节依据使用。

交接建议：

- 如果后续发现原型文案也过度接口化，再单独清理旧版原型知识。
- 不要把旧原型知识里的接口状态扩散回需求文档正文。

## 当前应遵守的 PRD 输出边界

PRD 正文应该包含：

- `版 本 历 史`
- `目 录`
- `1 引言`
- `1.1 项目背景`
- `1.2 文档范围`
- `1.3 使用场景（必填）`，含渠道表
- `2 业务需求`
- 页面链接、核心规则、流程/状态/页面要求、验收标准
- `3 业务降级方案（必填）`
- `4 需求安全基线要求（必填）`，含 21 行安全基线表

PRD 正文不应该包含：

- `本需求涉及新增/修改的接口`
- 独立接口/API 章节
- `知识库引用`
- `模型与联网补齐说明`
- `联网补齐证据`
- 外部资料 URL
- 工具调用日志、skill 文件内容、运行状态、调试信息

可以作为元数据保留：

- 知识库引用路径和标题
- 模型补齐说明
- 外部补充状态
- 外部资料 URL
- 隐私边界和不发送内部信息的说明

## 已上线修复提交

生产分支 `prod` 已包含以下关键提交：

```text
3fce147 fix: align prd template without interface section
b118a4a fix: remove interface section from deerflow prd rules
e5f9753 fix: keep enrichment traces out of prd body
```

当前线上 API 版本：

```text
e5f9753
```

## 2026-07-08 线上 Agent 调用复查

本轮复查重点不是给人看的 Quartz/Obsidian 文档，而是线上系统在生成 PRD/原型时，Agent 能否稳定检索、排序、注入、引用并被核心知识约束。

最新真实线上烟测：

```text
/Users/liyannong/ai-product-workbench/storage/agent-workflow-online-smoke/2026-07-08T09-40-02-146Z
```

当前线上结论：

- 线上流式生成完成，PRD 与原型均已落库。
- PRD 正文结构、原型核心页面、运行噪音隔离、PRD/原型规则一致性均通过。
- 但线上知识引用仍不合格：`knowledgeRefs=8, explainable=3`。
- 线上 Agent 调用缺少核心知识组：`文档规范:miss, 原型规范:miss, 活动业务:hit, 权益资损:hit`。

根因判断：

- 线上 Agent 当前能命中知识库，但排序靠前的是 `00/01` 类通用规范，业务域知识靠后，`PRD标准结构` 和 `原型生成总规则` 没有稳定进入本轮上下文。
- PRD 保存时主要保留了模型回声式标题，缺少真实检索结果里的 `knowledgeId`、`relatedPath`、`snippet`、`score`、`reason` 等可解释字段。
- 因此“知识库有内容”不等于“线上 Agent 可靠调用了正确知识”。必须用保存后的 PRD 元数据和核心知识组覆盖率验收。

本地已补强的方向：

- 运行时检索 query 会按需求模式扩展 `PRD标准结构`、`原型生成总规则`、活动配置、权益资损等关键词。
- 检索层对 PRD/原型/活动/积分资损类请求强制补齐核心知识组，并把每组代表知识前置。
- 线上生成保存 PRD/原型时，将真实检索上下文合并进 `knowledgeRefs`，避免只保存模型回声标题。
- 线上 smoke 新增两个硬门禁：`线上 PRD 知识引用可解释`、`线上 Agent 调用覆盖核心知识组`。

部署后必须复测：

```bash
npm run smoke:agent-workflow:online
```

通过标准：

- `线上 PRD 知识引用可解释: passed`
- `线上 Agent 调用覆盖核心知识组: passed`
- 保存后的 `prd.json` 里至少能看到文档规范、原型规范、活动业务、权益资损四组知识的标题、路径或摘要证据。

## 2026-07-08 16:06 线上烟测新增发现

最新线上烟测目录：

```text
/Users/liyannong/ai-product-workbench/storage/agent-workflow-online-smoke/2026-07-08T16-06-33-256Z
```

结论：

- 线上部署仍触发旧兜底事件：`模型未返回完整产物，已先生成可编辑初稿`。
- 该旧兜底会把 `知识库打底`、`公开资料补齐`、`补齐策略`、外部资料标题写入原型画面。
- 线上 PRD 元数据没有命中 `签到活动高保真HTML原型框架` / 原型资产框架组。
- 线上原型不是稳定完整高保真 HTML：缺活动平台字段密度，且存在过程文案噪音。

本地已补强：

- `aichat-stream`：用户同时要求 PRD + 原型时，缺任一产物直接失败提示重试，不再兜底生成初稿。
- `final-action-applier`：原型入库前必须是完整 standalone HTML，且不得含知识库/模型/联网/外部证据等生成过程文案。
- `prototype.service`：保存原型时使用完整 HTML 文档包装，保留 `<head>/<style>`。
- 检索与评测：`签到活动高保真HTML原型框架` / HTML/Axure/RP 原型资产框架成为硬门槛。

部署后必须复测：

```bash
npm run smoke:agent-workflow:online
```

通过标准新增：

- 不再出现 `model-final-action-fallback`、`可编辑初稿`、`模型生成超过时间盒`。
- `线上 Agent 调用覆盖核心知识组` 中 `原型资产框架:hit`。
- `线上原型包含核心页面文案` 中 `完整HTML:hit`、`活动平台字段密度:hit`。
- `线上原型不含运行噪音: passed`。

## 验证命令

本机 skill 校验：

```bash
python3 /Users/liyannong/.codex/skills/.system/skill-creator/scripts/quick_validate.py /Users/liyannong/.codex/skills/requirement-doc-template
```

关键单测与类型检查：

```bash
npm --workspace @workbench/api exec vitest run test/knowledge.service.spec.ts test/final-action-applier.service.spec.ts test/aichat-document-stream-router.spec.ts test/requirement-document.service.spec.ts test/deerflow-runtime.service.spec.ts
npm --workspace @workbench/api run typecheck
```

本地工作流评测：

```bash
npm run eval:agent-workflow
npm run eval:agent-workflow:generalization
```

线上真实烟测：

```bash
npm run smoke:agent-workflow:online
```

最近一次线上烟测产物：

```text
/Users/liyannong/ai-product-workbench/storage/agent-workflow-online-smoke/2026-07-08T09-40-02-146Z
```

关键通过证据：

```text
线上 PRD 内容结构合格: passed
evidence: 引言/背景:hit, 业务需求:hit, 降级方案:hit, 安全基线:hit, 无接口章节:hit

线上 PRD 元数据留存知识库和补齐证据: passed
evidence: knowledgeRefs=8, validationNotes=10, knowledge=hit, enrichment=hit, url=hit, status=hit, boundary=hit

线上 PRD 正文不写补齐证据章节: passed
evidence: no trace/evidence section in PRD body
```

## 2026-07-08 16:30 本地质量门禁补强

> 历史记录：本节描述的是当时针对签到样题做的单题补强，已被后文 `2026-07-10 Agent 工作流通用化重构` 替代。不得再把本节的签到、积分、banner、库存等词写入 formatter、QA、检索扩展或系统提示词。

最新本地评测目录：

```text
/Users/liyannong/ai-product-workbench/storage/agent-workflow-eval/2026-07-08T16-49-50-832Z
```

本轮只处理生成质量，不处理前端项目。新增本地硬门禁：

- PRD 必须符合固定章节结构，并包含 `产品流程图`、`产品架构图`。
- PRD 不允许出现独立章节 `本需求涉及新增/修改的接口`。
- PRD 正文不允许出现 `知识库打底`、`公开资料补齐`、`模型补齐`、`补齐策略`、外部资料标题等生成过程痕迹。
- PRD 正文不允许复制用户原话，不允许把 `知识库命中`、`生成前必须命中` 等系统生成质量检查写成业务验收项。
- PRD 和原型不允许用 `待确认` 填充核心业务内容；签到积分活动需要给出可评审默认值，真正不确定内容只能进入 assumptions/元数据。
- PRD 兜底内容不再使用 `符合评审确认范围` 等泛化话术，签到领积分场景会补出每日一次、自然日唯一键、积分奖励、连续奖励、每日库存额度、隐私协议、异常补偿、数据报表等可验收规则。
- 原型必须是完整 standalone HTML，必须同时覆盖运营后台和用户前台，并具备表单/按钮/表格等高保真控件密度。
- 签到领积分原型必须覆盖 banner/头图、海报、活动名称、活动时间、签到、积分/奖励、库存/额度、隐私协议、报表、补偿/异常等关键字段中的多数项。
- 签到领积分原型必须按知识库框架命中 8 个分组：后台基础设置、展示素材配置、任务与跳转、隐私协议、积分库存规则、前台完整状态、审核发布、报表治理。
- 原型不允许出现 `当前原型用于评审`、`业务覆盖`、`知识覆盖` 等说明型脚手架，相关区域必须替换成真实产品模块，例如审核流转、异常队列、报表筛选或前台状态。
- 如知识库命中原型资产/高保真 HTML/Axure/RP 框架，最终 PRD/PrototypeSpec 必须保留可解释知识引用。

本轮验证结果：

```text
npm --workspace @workbench/api run typecheck: passed
npm --workspace @workbench/api exec vitest run test/aichat-document-stream-router.spec.ts test/export.service.spec.ts test/requirement-document.service.spec.ts test/knowledge.service.spec.ts test/final-action-applier.service.spec.ts test/deerflow-runtime.service.spec.ts test/prototype.service.spec.ts test/qa-rule-check.service.spec.ts: passed, 98 tests
npm run eval:agent-workflow: passed
```

本地 eval 关键证据：

```text
top hit: 签到活动高保真HTML原型框架, score=74
coverage: 活动发布与模板配置/奖品券与资损核销/PRD标准结构/原型生成总规则/原型资产/设计框架 all hit
prototypeRender: passed
rendered text: 活动配置/提交审核/立即签到/数据报表/补偿队列 all hit
prototype framework: 后台基础设置/展示素材配置/任务与跳转/隐私协议/积分库存规则/前台完整状态/审核发布/报表治理 all hit
consistency: 7/7 passed
```

仍需部署后复测：

- 当前生产 `https://aionbench.com/api` 上一次仍命中旧兜底 `模型未返回完整产物，已先生成可编辑初稿`。
- 本地代码已取消该类超时兜底初稿逻辑，但生产是否生效必须等部署后再跑 `npm run smoke:agent-workflow:online`。

## 2026-07-10 Agent 工作流通用化重构

上一阶段为提高签到样题质量，在 formatter、QA、检索扩展和 DeerFlow prompt 中加入了签到/积分/banner/库存等业务关键词。这能提高单题分数，但不能证明所有需求文档和原型都达到相同质量，且会污染门店预约、素材库、OAO、券核销等其他业务。

本轮已直接重构，不保留业务硬编码兼容分支：

- 检索：所有 PRD/原型请求固定召回文档规范、原型总规则、当前业务知识和当前业务最相关的 `prototype_asset_ref`；原型资产按需求词与标题/摘要重合度排序，不再默认签到资产。
- 生成前状态门禁：`ConversationDesignState` 必须包含目标用户、使用场景、页面、功能、后台配置、前台规则、业务规则、状态规则、异常场景和验收标准。
- PRD formatter：删除签到专用页面、规则、流程和验收分支，统一从当前设计状态生成页面表、规则表、流程说明、验收表、产品流程图和产品架构图。
- DeerFlow prompt：要求从当次召回知识中的 `必须/至少/不得/禁止` 提炼检查清单，所有业务都按同一流程执行；业务参数从当前需求和知识推断，不写死签到字段。
- QA：按设计状态和 `PrototypeSpec` 中具名页面、组件、状态计算覆盖率；多项分组至少覆盖 75%，单项必须命中。
- 知识框架 QA：动态解析原型知识 Markdown 表格中的 `分组/状态/页面` 与 `必须字段/控件/必须展示` 列，检查最终 HTML 是否逐组落实，不再维护业务关键词正则。
- 前后台门禁：所有完整原型必须同时体现后台配置/治理和用户前台操作/反馈，并包含表单、表格或操作控件、状态和异常表现。

新增多业务泛化评测：

```bash
npm run eval:agent-workflow:generalization
```

覆盖业务：

- 门店预约：门店配置、预约容量、预约提交、容量限制、时段已满。
- 素材库审核：素材管理、标签、上传、预览、先审后发、格式异常。
- 优惠券核销：券配置、库存、领取、限领、券包、核销和库存不足。

每个场景同时验证：固定 PRD 结构、流程图、架构图、设计状态字段覆盖、知识库页面框架动态覆盖、完整前后台 HTML、无跨业务词污染。

最新验证结果：

```text
typecheck: passed
9 test files / 106 tests: passed
3-domain generalization eval: passed
sign-in end-to-end eval: passed
```

最新签到回归目录：

```text
/Users/liyannong/ai-product-workbench/storage/agent-workflow-eval/2026-07-10T06-35-56-651Z
```

### 2026-07-10 最终收口

本轮继续清除了“形式通用、流程仍是活动模板”的隐性过拟合：

- 产品流程图不再固定为配置、审核、发布、用户参与、权益发放，而是从当前页面、功能、业务规则、状态、异常和验收项动态组图。
- 产品架构图不再固定为活动配置平台，而是动态组织页面层、能力层、配置层、规则层、状态与记录层、异常治理层、验收追踪层。
- 页面链接不再写 `以实际上线地址为准`；无物理路由时使用可评审的逻辑产品入口。
- 业务降级方案从当前功能和异常场景生成，不再默认配置保存、发布审核等活动流程。
- `待确认`、`待补充业务目标`、`以评审为准`、`以实际上线地址为准` 等占位话术被纳入确定性 QA 拦截。

产物现在经过三道质量门：

1. 模型在同一轮完成内部修订，并返回非空的 `qualitySelfCheck` 明细。
2. 候选设计状态、PRD、PrototypeSpec、HTML 和当轮知识引用在数据库事务内做确定性预检；出现 blocking/major 问题时整笔回滚。
3. 落库后使用完整知识内容复检；QA failed 的产物不会作为成功结果交付。

线上烟测脚本也已通用化：业务通过条件来自实际 `ConversationDesignState`、`PrototypeSpec` 和知识类型，不再要求命中签到、积分、奖品或活动平台字段。自定义 `AGENT_WORKFLOW_ONLINE_TOPIC` 后可直接测试任意业务题目。

最终验证：

```text
API typecheck: passed
API test suite: 39 passed / 1 skipped, 231 tests passed / 1 skipped
3-domain generalization eval: 3/3 passed
online smoke evaluator self-test: passed
sign-in regression eval: passed
```

最新签到回归目录：

```text
/Users/liyannong/ai-product-workbench/storage/agent-workflow-eval/2026-07-10T07-18-42-238Z
```

生产验证失败时不得恢复低质量兜底稿，应按失败信息修正知识、状态或模型产物后重试。

## 2026-07-10 生产部署与全流程验证

本轮已只部署 Agent/API，未构建或重启前端。生产排障过程中确认并修复了以下问题：

- API 与 DeerFlow gateway 的内部鉴权 token 曾不一致，导致用户级线程和产物请求无法稳定关联；现已统一鉴权配置。
- 自定义 Agent 和 skill 原先只存在于个别用户目录；现改为共享目录同步，新注册用户也能加载 `workbench-lead`，且首轮显示 `has_memory=false`，不会继承其他用户或历史样题记忆。
- 流式生成取消总时长兜底，只保留 10 分钟无数据活动超时；模型持续返回时继续等待，彻底无响应时失败并提示重试。
- DeerFlow artifact 路由原先按默认用户解析文件，真实用户会出现 404；现按受信任 owner 解析，并保留 `write_file` 文本恢复路径，线上 artifact 请求返回 200。
- 候选产物未通过 blocking/major QA 时，在同一 DeerFlow 线程内按具体缺项最多修复两轮；事务在质量通过前不提交，不再生成“可编辑初稿”。
- 生产 QA 与独立烟测统一为“实体名称或语义证据”覆盖，不要求模型逐字复制设计状态标签；覆盖率仍维持每组至少 75%，知识框架、完整 HTML、前后台、控件和数据结构门禁不降低。
- PRD 格式化层稳定记录未确认项和敏感信息边界；外部检索隐私边界从运行上下文写入元数据，不进入 PRD 正文。

最终生产烟测使用全新用户和真实线上模型完成，生成阶段在生产机持久运行，完成后将同一份 HTML 拉回本机 Chrome 做渲染与像素检查。产物目录：

```text
/Users/liyannong/ai-product-workbench/storage/agent-workflow-online-smoke/2026-07-10T10-34-remote
```

最终证据：

```text
流式生成: completed, HTTP 200, 416515 bytes, 5m18s
PRD 固定结构/产品流程图/产品架构图/无独立接口章节: passed
PRD 动态设计状态覆盖: targetUsers 4/4, userScenarios 4/4, pages 4/4,
  features 6/6, backendConfigs 7/7, frontendRules 6/6,
  businessRules 6/6, stateRules 6/6, exceptionScenarios 6/6,
  acceptanceCriteria 6/6
知识引用与补齐边界: knowledgeRefs 10, explainable 10, boundary hit
原型完整 HTML/前后台/交互控件/数据结构: passed
原型动态设计状态覆盖: all groups full hit
PrototypeSpec: 38/42, above 75% gate
PRD 与原型一致性: 41/41
Chrome 渲染: 1440x1100, 278536 bytes, nonWhite 0.3884,
  luminance stddev 81.3193, color buckets 196, passed
运行噪音/生成过程文案: none
```

本机命令执行器会在约 10 分钟强制终止前台命令，曾因此中断一轮正在生成的 DeerFlow 请求。该现象不是线上 Agent 超时。后续长链路烟测应在生产机使用独立容器完成生成，再用 `AGENT_WORKFLOW_ONLINE_REPLAY_DIR` 在本机重放快照并执行 Chrome 检查，避免重复调用模型。

## 后续维护建议

1. 将 `requirement-doc-template` 视为 PRD 输出规范源头，项目知识库和 DeerFlow skill 只能对齐它，不能另起一套结构。
2. 增加或修改 PRD 章节时，先更新本机 skill，再同步更新项目知识库、DeerFlow skill、API prompt 和兜底逻辑。
3. 评测脚本不要把“过程可追溯”当成“PRD 正文必须展示”。过程证据应放元数据、评测报告、运行状态，不进需求文档正文。
4. 每次改模板规范后，必须执行线上真实烟测，并检查保存后的 `prd.json`，不能只看流式回复。
5. 对“接口/API”类内容保持区分：独立接口章节禁用；安全基线 21 行模板中的 API 安全项保留。
6. 禁止为单一评测题在 formatter、QA 或检索查询里新增业务关键词；业务专属字段只能进入 `knowledge-vault`、设计状态和测试场景数据。
7. 每次调整生成质量必须同时跑单题回归和 `eval:agent-workflow:generalization`，至少验证三个不同业务域。

## 2026-07-11 最终生产验收（输出质量口径）

生产地址：`https://aionbench.com`

最终部署版本：`01d9c6174c80`

线上健康检查确认：

```text
service: ai-product-workbench-api
phase: deerflow-first-runtime
build.commitSha: 01d9c6174c80
deerflow.enabled: true
deerflow.runtimeName: workbench-lead
deerflow.modelId: datatoken/datatoken-gpt-5-5
```

最终完整线上烟测证据：

```text
/private/tmp/ai-product-workbench-agent-prod-20260710/storage/agent-workflow-online-smoke/2026-07-11T00-13-29-101Z
```

用户最终确认不以移动端展示样式作为阻断项，只验收 Agent 输出质量。按此口径，29 项检查中排除唯一的 `390px` 页面横向溢出展示项，其余 28/28 全部通过：

```text
流式生成: completed, HTTP 200, 508265 bytes, 6m19s
PRD 固定结构、产品流程图、产品架构图、降级方案: passed
PRD 动态覆盖: targetUsers 4/4, userScenarios 4/4, pages 5/5,
  features 8/8, backendConfigs 7/7, frontendRules 6/6,
  businessRules 6/6, stateRules 6/6, exceptionScenarios 7/7,
  acceptanceCriteria 6/6
渠道表: 唯一 1 张，3 个渠道行完整，正文语义一致
安全基线: 唯一 1 张，连续 21 行，敏感项与正文证据双向一致
知识引用: 10 条，10/10 可解释，核心知识组全部命中
原型内容覆盖: pages 5/5, features 8/8, backendConfigs 7/7,
  frontendRules 6/6, businessRules 6/6, stateRules 6/6,
  exceptionScenarios 7/7
PRD 与原型一致性: 45/45
关键按钮真实点击: 8/8 均产生可见状态变化
持久化消息与流式输出: 无内部工具或推理噪音
跨用户隔离: conversation/PRD/prototype/artifact/PRD document 5/5
  owner 访问 200，验证用户访问 403
主账号与验证账号清理: passed；DeerFlow thread 1/1 清理成功
```

本地最终回归：

```text
API focused tests: 71/71 passed
API typecheck: passed
API full suite: 269 passed / 1 skipped
3-domain generalization eval: 3/3 passed
git diff check: passed
```

结论：当前生产 Agent 已按“输出质量优先”口径完成验收，可正式使用。移动端 `390px` 页面级横向溢出仅记录为展示优化项，不影响 PRD、原型内容、交互能力、数据隔离、安全或清理结论。
