# 产品工作台开源复用与自研边界

更新日期：2026-07-16
状态：绿地接入方案的强制选型约束

## 结论

产品工作台不应手写通用 UI primitive、画布手势、富文本编辑器、上传器、SSE 解析器、OpenAPI 客户端、文档解析器、任务队列或可观测性底座。成熟能力优先采用许可证清晰、可自托管、可替换的开源项目。

默认决策顺序固定为：直接采用成熟开源依赖 > 在领域边界做薄适配 > 仅在没有合格项目时自研。任何“自己写更快”的判断都必须同时计算键盘与无障碍、异常恢复、跨浏览器、升级、安全和测试成本，不能只比较首个可演示版本的代码量。

但是“使用开源”不等于 fork 一套完整产品，也不等于把第三方源码无来源地复制进业务目录。长期最干净的边界是：

1. 视觉小组件可以复制并改造源码，例如 shadcn/ui。
2. React Flow、Tiptap、Uppy 等复杂引擎作为依赖使用，只在领域边界做薄适配。
3. Docling、ClamAV、Keycloak 等重型能力通过独立进程或标准协议接入。
4. Project、Run、Artifact、Board、KnowledgeRelease、`ArtifactKind.design_system` 和 `DesignSystemImport` 等产品领域规则由本项目自己掌控。
5. 不 fork Dify、Open WebUI、LibreChat 等整套产品作为底座。
6. Onlook、Bolt、Dyad 等完整应用只有被证明是独立、低耦合的模块才允许受控摘取；不得连同其 AI SDK、数据库、沙箱、会话或供应商模型一起搬入。

目标不是追求依赖数量，而是让通用能力的生产实现尽量由成熟开源内核承担。按当前功能面，UI 行为、画布、编辑器、上传、协议、解析、导出工具和可观测性约 70%-85% 的底层代码应来自开源；本项目集中维护剩余的领域合同、权限、版本、状态机和 adapter。这个比例按能力责任计算，不按仓库行数计算。

本方案不使用 Vercel AI SDK。浏览器数据面采用 OpenAPI REST、TanStack Query，以及同源 BFF session 下的 `fetch` 流和 `eventsource-parser`；OIDC access/refresh token 不暴露给浏览器。模型与 Agent 运行统一经 DeerFlow 的 `RuntimePort`，需要多供应商治理时才在 DeerFlow 后增加 LiteLLM Core。

## 五种采用方式

| 方式 | 适用对象 | 仓库做法 | 升级责任 |
|---|---|---|---|
| 源码归属 | shadcn/ui 小组件、极少量样式模板 | 复制到 `components/ui` 后按产品视觉修改，保留许可证 | 本项目维护 |
| 受控源码摘取 | 完整开源应用中没有独立发布包的纯算法、parser 或隔离组件 | 只摘取通过依赖审计的最小闭包，登记上游 URL、commit、许可证、修改说明和退出条件 | 本项目维护并定期与上游比对 |
| 包依赖 | React Flow、Tiptap、Uppy、TanStack Query 等 | 锁定版本，通过 feature adapter 使用，不改 `node_modules` | 跟随上游安全与版本升级 |
| 独立服务 | Docling、ClamAV、Keycloak、可选 Langfuse | 容器或外部服务，使用 HTTP/OIDC/OTLP 等稳定协议 | 独立部署与升级 |
| 仅借鉴 | Dify、Open WebUI、LibreChat 等完整应用 | 可研究交互和异常处理，不复制其领域模型或 fork 产品 | 不形成运行依赖 |

只在以下位置允许建立第三方适配层：外部类型会泄漏到领域模型、需要屏蔽付费版/云版差异、或未来确有替换可能。不得为了形式上的“解耦”给每个按钮和每个 npm 包再包一层。

“改改直接用”也必须区分规模。小型视觉 primitive 可以归入本仓库维护；复杂引擎必须保留上游依赖关系；完整应用不能整仓搬入，但允许摘取经过审计的独立模块。受控摘取必须同时满足：依赖闭包可列举、没有上游数据库/API/全局 store 类型、可以用内部合同单测、单独删除后不会破坏领域数据、许可证允许修改分发。除紧急安全修复外，不允许长期 `patch-package`、Git subtree 或把上游 example app 复制成生产代码。确需临时补丁时，必须记录上游 commit、许可证、补丁原因、退出版本和对应测试，并优先向上游提交修复。

Onlook 可作为代码编辑、DOM 定位和设计工具交互的源码样本，但它当前以代码和沙箱为事实源，并依赖 AI SDK、Supabase/tRPC、CodeSandbox/WebContainer 类能力，不能整体成为 Workbench 内核。只有 parser、DOM instrumentation 或纯 UI 组件经最小闭包审计后才进入“受控源码摘取”；能由已发布包解决的能力仍优先使用包依赖。

## 复用优先门禁

每个新功能进入实施前必须先完成一次轻量的 reuse check，并在任务或 ADR 中写清：候选项目、许可证、维护状态、免费/付费边界、内部数据映射、最小 PoC 和退出方案。只有下列情况才允许自研通用能力：

1. 没有候选项目通过许可证、安全、离线部署、React 19/Next 16 或性能门槛。
2. 候选项目的数据模型无法通过薄 adapter 隔离，采用后反而会成为新的数据库事实源。
3. 所需能力足够小且稳定，接入第三方的运行和升级成本经 PoC 证明更高。

常规源码复制只适用于 shadcn/ui 这类明确以源码归属方式分发的小型视觉 primitive；受控源码摘取是例外流程，必须满足上文的最小闭包和来源登记要求。编辑器、画布、上传、解析、队列和协议库不得 vendoring 到业务目录，也不得直接修改 `node_modules`。同一能力只保留一个生产内核；例如新 Workbench 服务端缓存只用 TanStack Query，上传一期只用 S3 multipart，不能并行堆两套方案。

## 准入门槛

任何新开源依赖进入生产主链路前都必须满足：

1. 许可证为批准清单内的 MIT、Apache-2.0、BSD、ISC 或 PostgreSQL License；MPL、GPL、AGPL 和 source-available 项目单独审查。
2. 关键功能无需购买 Cloud/Pro/Enterprise，也不要求把业务数据发送给项目方托管服务。
3. 最近版本、issue 和安全公告表明项目仍在维护；无人维护的转换器只能作为算法参考。
4. 浏览器库必须通过 React 19、Next 16、SSR/hydration、键盘、移动端和 bundle 体积 PoC。
5. Node 库必须通过 Node 22 + ESM/NodeNext 的实际 build/test；新 Workbench 不为 ESM-only 依赖长期钉旧版或到处增加 dynamic import 胶水。
6. 服务型项目必须有版本化协议、健康检查、超时、资源限制和数据导出路径。
7. 第三方数据结构不能成为数据库事实源；停用该依赖时，内部 Project、Artifact 和 Board 数据仍可完整读取。
8. 使用到传递依赖时必须改为直接依赖并锁定版本，不能依赖上游偶然带入。
9. CI 生成 SBOM、执行许可证 allowlist 和漏洞扫描；高危漏洞没有升级或隔离方案时阻断发布。
10. 复制源码时登记上游 URL、commit 和许可证并生成 `THIRD_PARTY_NOTICES`；复杂库不得以“方便改造”为由失去上游升级路径。

每个关键引擎先做一个窄 PoC：Tiptap 验证结构化 PRD round-trip，Uppy 验证 multipart 恢复与最终摘要复核，BFF + eventsource-parser 验证 HttpOnly session 续期和断线重放，Moveable/Selecto 验证缩放视口下的命中、吸附和完整 PrototypeDocument IR round-trip。PoC 通过后才进入 feature 实施。Puck、GrapesJS 和 Onlook 的事实源分别是受控 React component data、HTML/CSS component model 和 Next/Tailwind 代码，均不能无损承载当前含 absolute/flow、vector、state、action、binding 和 motion 的 IR，因此不进入当前主编辑器 PoC；只有未来产品范围切换到对应事实源时才重评。

### 依赖治理台账

通过 PoC 的生产依赖必须进入 `docs/workbench-dependency-register.md`。每条至少记录：能力 owner、直接依赖或独立服务名、固定版本/镜像 digest、上游 URL、许可证证据、免费与商业能力边界、内部 adapter、合同 fixture、CVE 修复 SLA、季度健康复核日期、退出阈值和唯一备选。lockfile 只证明安装结果，不能替代这份责任台账。

候选阶段可以比较多个项目；进入生产后同一能力只保留一个内核。首选 PoC 失败才启用备选，禁止把“首选或备选”长期实现成两套并行路径。React Data Grid beta、Moveable/Selecto 和固定 Figma Importer 必须保留固定 IR fixture 与上游合同测试；出现 React/浏览器不兼容、连续高危漏洞无修复、关键仓库长期失养或 adapter 开始复制上游状态机时，触发退出评审。

MPL、GPL、AGPL、source-available 以及运行时商业条款依赖必须有书面例外；`axe-core` 仅作为测试依赖使用也要登记 MPL-2.0 例外。受控源码摘取按实际文件逐项核验来源和许可证，不能只沿用上游仓库根许可证判断。

适配层也要受预算约束。adapter 只允许做类型转换、协议调用、错误归一化和内部 command/event 映射；不得重新实现上游已有的暂停/继续、重试、焦点、键盘、拖拽、撤销栈或流拆帧。单个 adapter 超过约 300 行，或出现第二套持久 checkpoint/状态机时，必须做一次“是否漏用了上游能力”的架构复审。300 行不是机械限制，安全校验和领域映射可以超过，但必须能逐段说明为什么不属于开源内核责任。

### 进入功能接线前的冻结门

下列事项会改变数据库、运行安全或导出事实源，必须先冻结，不能边接 UI 边决定：

1. DeerFlow：登记唯一生产 commit、镜像 digest、Gateway/LangGraph 合同和真实部署 E2E；LangGraph SDK 已接入不等于 DeerFlow 服务已 `adopted`。
2. 身份：确定实际 OIDC provider、Better Auth session schema、KMS/envelope encryption、登出和密钥轮换；浏览器持 Bearer token 的临时路径不能进入硬切。
3. 知识：`EmbeddingProfile v1`、独立无 typmod chunk embedding 表、原生 tokenizer pin 和固定检索评测合同已经形成，临时 `vector(1536)`/`embeddingModel` 已删除；生产模型仍必须经真实评测后才能 adopted，不能由旧字段反向决定。
4. Prototype IR：rotation、transform origin、嵌套坐标和所有 exporter 已统一到同一 schema/command；后续 v1 无法表达时必须先升级合同，不能写 CSS 字符串旁路。
5. Preview：v1 只执行受控 IR renderer，独立 origin 不运行任意生成 React/JS；若未来开放任意代码执行，必须作为新的隔离执行项目单独评估。
6. Export：React 使用共享 RenderPlan 直出 AST/runtime data；Figma 使用内部 `FigmaExportDocument` + 固定官方 Plugin API importer。HTML-to-JSX 只能是可删除的静态叶片工具。
7. Object storage：硬切环境必须指定真实 S3 provider、版本/IAM/私网 endpoint，并在该 provider 上完成 multipart、崩溃恢复和内容校验；MinIO 只有被明确选择时才是部署目标，否则只是测试夹具。

## 当前前端审计

当前产品工作台前端是高保真实现，不是从零开始：

- 页面运行时已经收口为持久 `(workbench)` layout -> `WorkbenchRuntimeProvider` -> `WorkbenchScene`。Next Home/Project pages 只承担 URL 并返回 `null`；Scene 内唯一的页面级 `AnimatePresence mode="sync"` 拥有 Home/Project 过渡。Project 通过 fulfilled-module cache 动态拆包，P1 -> P2 固定 `key="project"` 并以 project-scoped session generation 隔离状态，Project root、header 和 React Flow DOM identity 保持；禁止 `key={projectId}`。16 个 feature 已进入强制分层，聚合 `WorkbenchService`、`features/service.ts` 与 `transport.service` 均不存在。准确结论是“前端按运行时、页面场景、feature 和 adapter 模块化”，不是完整一坨代码。
- `@xyflow/react` 已承担画布、选择、缩放、平移和节点缩放。
- Radix、cmdk、Sonner、Lucide、CodeMirror、ProseMirror、React Data Grid、Streamdown、Shiki、Mermaid 和 Motion 已在仓库中。
- 仍有至少 11 组菜单、弹层、outside-click、Escape 和焦点行为由工作台手写。
- Project/ProjectMember 搜索、权限、duplicate/archive、邀请、Thread/Run SSE、取消、审批、精确重试、Board CAS/autosave、Artifact renderer、不可变 Release、公开分享/撤销/重混、Export job/cancel/download 和 Prototype 图片/字体内容已接真实合同；autosave 导航屏障、完整 URL 恢复、错误隔离、viewer 只读选择以及 P1 -> P2 DOM identity 已通过仓库与浏览器门禁。Figma 已固定为 `workbench.figma-export.v1` + 产品工作台 Importer 1.0.0，真实 Figma Desktop 验收尚未完成。
- Uppy multipart、页面级上传 registry、逐文件 hash/upload/verify/extract 状态和 pause/resume/cancel/retry 已真实实现；SubmissionIntent 进一步持久化完整 typed request 与有序 upload slot，使用 `intentId + position` 的确定性 create/complete/extract 幂等键，支持刷新轮询、原文件重选、同一 Run 重放和整单取消。真实 S3/IAM 上的断网、浏览器崩溃、过期 session 与取消失败恢复仍是生产门禁；Frame、Draw、Media、Board Style、Special、Undo/Redo 与屏内元素 Moveable/Selecto command 已接真实 Board/Artifact 合同，Web 144 files / 616 tests 与统一 `e2e:web` 均通过，完整生产环境视觉矩阵仍须在真实外部依赖上复验。
- 旧页面仍依赖 AI SDK 与 SWR；它们不进入新 Workbench feature，并在新系统生产 E2E 通过后随旧页面一起物理删除，不保留运行时兼容。

因此后续继续保留现有视觉叶组件、CSS、DOM 和 Motion 参数，通用交互内核仍优先使用成熟 headless primitive。持久 Scene、Project 动态边、16 个 feature 和各自 command/query/UI owner 已形成，不得为了“进一步拆分”复制节点组件、重建页面 owner、恢复聚合 service 或按 `projectId` remount。任何依赖替换仍必须通过 `docs/workbench-visual-baseline.md` 的截图、手势和动效回归，不能借“换组件”改变页面。

此前四个 P0 接线阻断已经消除：

1. Board `artifact` 节点已按 Artifact kind/version 分派到现有 renderer。
2. ProjectRelease、ShareGrant、Remix、ExportJob、真实下载和取消已经形成 OpenAPI/API/Web/Worker 链路。
3. 私有与公开分享都可按权限读取钉住的 ArtifactVersion 图片/字体资产，强 ETag 与 Range 合同已统一。
4. `modelId + workflow + targetSurface + designStyle` 已分离；Run retry 只提交源 Run ID，由服务端从持久请求创建并记录 lineage。

下一批核心工作只剩真实模型、DeerFlow、S3/IAM、OIDC/KMS、ClamAV、OTLP、双 HTTPS、Docker、Figma Desktop 和全服务网络等生产外部门禁。持久 Scene route ownership、Project 动态拆包、跨项目状态隔离、Knowledge Profile 治理、上传页面生命周期、设计系统、Media、Board Style、Special、屏内元素编辑、公开 Blob 预览和多选导出已经完成，不能继续列为待办。后续修复仍禁止在同一个提交中同时改 DOM 层级、计算样式、Motion props 与行为内核。

## 前端选型矩阵

以下许可证和版本状态按 2026-07-12 的官方包信息核验。落地时锁定精确版本，并由 lockfile 和依赖更新 PR 管理。

| 能力 | 首选开源项目 | 许可证 | 当前状态 | 接入方式与边界 |
|---|---|---|---|---|
| UI primitive | shadcn/ui + Radix Primitives | MIT | 依赖已有，产品工作台待继续收口 | shadcn 可复制修改；Dialog、Popover、Dropdown、Tooltip、Tabs 等行为直接用 Radix，保留现有样式 |
| 图标 | Lucide React | ISC | 已有 | 直接依赖，不复制 SVG 集 |
| 命令菜单 | cmdk | MIT | 已有 | 用于命令检索和键盘导航，视觉层沿用产品工作台样式 |
| 通知 | Sonner | MIT | 已有 | 统一成功、失败和后台任务通知；业务错误码先映射再展示 |
| 动效 | Motion/现有 framer-motion | MIT | 已有 | 保真阶段不强制迁包；新 feature 只选一个入口，切流后再消除重复依赖 |
| 无限画布 | `@xyflow/react` | MIT | 已有 | 直接使用节点、边、viewport、selection、NodeResizer；项目只实现 Artifact 映射和 Board 持久化，不持久化原始 React Flow Node/Edge |
| Canvas 视觉捕获 | `html-to-image@1.11.13` | MIT | 已接 `view_screen` Web wire path | 只克隆精确 screen viewport；产品代码负责 capability 绑定、同源资源、尺寸/字节/SHA-256 和 fail-closed，API 重新解码并转 WebP，库输出不成为持久事实源 |
| 屏内元素选择与变换 | `react-selecto@1.26.3` + `react-moveable@0.56.0` | MIT | 固定版本已通过 adapter 接入生产 Artifact renderer；采用状态仍为 `poc` | Selecto 负责框选，Moveable 负责拖动、缩放与旋转，第三方事件先转为内部 snapshot/command，不能进入 Prototype IR。React 19 挂载和模型合同已通过，但真实触控、吸附、React Flow 嵌套、滚动与移动端仍未过 browser gate；失败时只评估 interact.js，不并行堆两套 |
| 图层/列表排序 | Atlassian Pragmatic Drag and Drop | Apache-2.0 | 按需引入；dnd-kit 作为备选 | 2.0.1 仍活跃且框架无关，只处理图层树、附件和列表重排；实际父子关系、顺序、权限和冲突仍由 PrototypeDocument/服务端校验。dnd-kit stable 路线最后发布较早，新 React API 仍为 0.x，不作为绿地首选 |
| PRD 富文本 | Tiptap Core + StarterKit + 官方 Table/Link 扩展 | MIT | 已接入（2026-07-14） | headless 使用并复刻现有视觉；`lib/workbench/prd-editor` 以 projection/adapter 映射 12 类 block、citation/reference、UniqueID，round-trip/undo 测试通过，持久化只写内部 PrdDocument，不写 Tiptap JSON；不用 Tiptap Cloud |
| 代码与 Diff | CodeMirror 6 + `@codemirror/merge` | MIT | 基础包已有；新 Artifact adapter/merge 待接 | 不手写编辑器、选择、撤销栈或 diff 对齐；项目只提供语言配置与保存策略 |
| 普通数据表 | TanStack Table | MIT | 按需引入 | 适合项目/版本/文件列表；视觉完全自定义 |
| 表格式产物 | React Data Grid | MIT | 已有 beta | 仅在真实表格式 Artifact 中使用并置于 adapter 后；不把 beta API 扩散到领域层 |
| 流式 Markdown | Streamdown + Shiki + Mermaid | Apache-2.0/MIT | 已有 | RunEvent envelope 可验证，但其中的模型 Markdown、链接、HTML 和 Mermaid 一律是不可信内容；执行协议/标签白名单、URL 校验与隔离渲染 |
| 文件上传 | `@uppy/core` + `@uppy/aws-s3` multipart | MIT | 非视觉底座、页面级 registry、逐文件状态与生命周期控制已接；真实目标 S3 浏览器恢复待生产验收 | 浏览器直传预签名地址；暂停、取消、分片重试、listParts 恢复由 Uppy 负责，所有权与最终状态由 File API 决定；不同时混用 tus |
| 上传崩溃恢复 | `@uppy/golden-retriever` | MIT | 仅限小文件可选 PoC，不进入大文件主链 | 官方 IndexedDB 默认单文件 10 MiB、总量 300 MiB，文档还提示常见可靠范围约 5 MiB；Service Worker 的大 Blob 只临时驻留且不能跨浏览器崩溃。因此它可改善小文件体验，但不能替代服务端 UploadSession、ETag、幂等和 digest proof |
| 上传摘要 | hash-wasm + Web Worker；可用 Comlink 简化 RPC | MIT/Apache-2.0 | 已接独立 digest Worker 和 fallback，已有恢复/取消回归测试 | 浏览器增量 SHA-256 用于早期身份和进度；创建上传会话前冻结 payload，服务端仍从可信对象字节复核；S3 multipart ETag 不能当内容 SHA-256 |
| PDF 预览 | PDF.js | Apache-2.0 | 按需引入 | 只负责浏览器渲染和分页；文件权限、版本、文本抽取和引用仍来自 File/Artifact API |
| 服务端状态 | TanStack Query | MIT | Project/Thread/Run/Artifact/File/Share/Export 底座与产品工作台 controller 已接；Project 搜索、成员、duplicate/archive、错误态、URL 恢复、保存屏障和跨项目 cache/mutation 隔离均通过门禁 | 新 feature 禁止再引入第二套 SWR cache；列表游标和权限失效必须由统一 query key 处理 |
| 画布临时状态 | Zustand | MIT | Board store 与产品工作台已接线 | 只保存选择、工具、viewport 草稿和未提交手势；持久事实源仍是服务端 Board revision |
| 画布撤销/重做 | Zustand bounded snapshot journal；Immer patches + zundo 为大文档退出候选 | MIT | 当前实现已接 Board/产品工作台并通过浏览器 smoke；zundo 未安装 | 只管理未提交 Board temporal state并服从服务端 Board revision；当前 100 条上限在大文档内存基准不通过时迁为 patches + zundo，不并行维护两套历史 |
| 表单 | React Hook Form + Zod resolver | MIT | 已接 Design System 结构化表单 | 用于设置和结构化编辑表单；API 最终仍由服务端 Zod/领域规则校验 |
| REST client | openapi-typescript + openapi-fetch | MIT | 已接入新 Workbench | 从 OpenAPI 3.1 生成类型并执行请求；不手写重复 DTO 和 URL 集合 |
| Run 流 | `fetch` + eventsource-parser | Web 标准/MIT | parser/reducer 与同源 BFF 已接入 | 浏览器同源 `fetch` 携带 HttpOnly session，BFF 向 API 附加 Bearer；parser 处理 SSE framing；本项目只实现 cursor 重连和 Run reducer |
| Web 身份会话 | Better Auth 产品账号 + database session；generic OAuth/Keycloak 为可选企业 SSO | MIT | username/email 双登录、database session、同源 BFF、账户菜单/登出已接；邮件验证/密码恢复与真实 IdP/KMS 待验收 | 浏览器只持有 HttpOnly/Secure/SameSite 的不透明 session id；access/refresh token 必须由应用/KMS envelope encryption 后存于服务端技术表，不依赖默认明文 token 列，也不写入 cookie/localStorage；BFF 只代理身份与传输，不承载业务规则，Better Auth 的 User/Organization 表也不成为 Principal/Workspace 事实源。Auth.js v5 仍为 beta，绿地不为其保留兼容层 |
| 长列表虚拟化 | TanStack Virtual | MIT | 按需引入 | ThreadEntry/Agent 日志达到实测阈值后启用，不提前增加布局复杂度 |
| 快捷键作用域 | react-hotkeys-hook | MIT | 按需引入 | 处理焦点范围、组合键和输入框排除；命令权限与可执行条件仍来自本项目 command registry |
| 图层树 | Headless Tree | MIT | 二期 PoC；react-arborist 仅作失败备选 | 复用键盘导航、展开、重命名和虚拟化；只把内部 node id/层级投影给组件，不保存其 tree model；首选 PoC 失败才切备选，不维护双内核 |
| 自由绘制几何 | perfect-freehand | MIT | 已接 Draw 合同、产品工作台和 HTML 导出 | 开源库负责 stroke 几何；项目只自研 Drawing schema、Board command、持久化和导出映射 |
| 媒体裁剪 | react-easy-crop | MIT | 已接 Media/Artifact 主链；生产触控与 Canvas CORS 待验收 | Media 工具使用；原文件和裁剪参数分离保存，不反复破坏原 Blob |
| 颜色选择 | react-colorful | MIT | 已接 Design System 与 Board Style 主链；完整键盘/对比度门禁待验收 | Design System 与 Style 工具共用一个颜色内核；颜色值写入内部 design token/style schema |
| React 代码预览 | Sandpack React | Apache-2.0 | 二期可选、维护风险需复核 | 仅在确需浏览器编译 React 时启用；默认托管 bundler 不进入生产，PoC 必须验证自托管、离线和退出方案；一期静态 HTML 不需要它 |
| Preview 通信 | `penpal@7.0.6` | MIT | 已采用 | 跨 origin iframe 的握手、超时和销毁复用成熟实现；项目固定 v1 schema、capability channel、origin/source、ArtifactVersion 和授权校验；生产独立 hostname E2E 不通过则停止硬切，不预建第二套 RPC |
| 富文本/HTML 清洗 | sanitize-html | MIT | 按输入边界使用 | 仅清洗导入的富文本和不可执行片段；可执行原型不靠 sanitizer 获得安全性，必须使用内部 IR、独立 preview origin、CSP 和 sandbox |
| HTML 可视化编辑 | GrapesJS Core | BSD-3-Clause | 条件候选，当前不排期 | 只适合未来明确要求把任意 HTML/CSS 纳入可视化编辑时；用自有 UI 驱动 core，不采用其 Backbone 数据模型作为事实源 |
| 结构化 React 编辑 | `@puckeditor/core` (Puck) | MIT | 条件候选，不进入当前主编辑器 | 适合未来产品明确收敛为受控 React component schema 的场景；当前 IR 的 vector/action/motion 等语义无法由 Puck Data 无损承担，且 UI override 仍标为 experimental。不能为了复用而降级产品合同 |
| 开源设计工具源码样本 | Onlook | Apache-2.0 | 受控摘取/参考，不作运行底座 | 可研究或摘取低耦合 parser、DOM instrumentation、selection overlay；禁止带入其 AI SDK、Supabase/tRPC、CodeSandbox/WebContainer、代码事实源和会话模型 |
| React page-editor 备选 | Craft.js | MIT | 不进入主 PoC | 比 Puck 更底层，仍需自建 UI、history/layers/fields，且发布活跃度较低；没有减少当前拼装面 |

BlockNote、tldraw 和 WebContainers 不作为上述首选的“更省事替代”。截至 2026-07-12，BlockNote Core 为 MPL-2.0，XL 能力为 GPL-3.0 或商业许可；tldraw 的 SDK 生产使用需要商业许可；WebContainers 的 npm 包标注 MIT 不代表其浏览器运行时可免费用于商业生产。它们即使技术能力合适，也没有比当前 Tiptap、React Flow 和隔离 Export Worker 方案形成更干净的许可与数据边界。

### Selecto/Moveable 隔离 PoC 证据

截至 2026-07-14，`apps/web` 已直接锁定 `react-selecto@1.26.3`、`react-moveable@0.56.0` 和 `@scena/matrix@1.1.1`。选择/手柄通过 `lib/workbench/prototype-editor` adapter 挂载到产品工作台生产 Artifact renderer；HTML/React/Figma/MCP exporter 消费同一个 `workbench.prototype.v1` rotation/origin 合同。固定测试覆盖 React 19 挂卸载、当前 screen 的 canonical selection、逐帧 preview/手势结束 commit、非零起始角与最终父局部绝对角、group 单 revision、跨不同旋转父级的 world-to-local 投影、`0.5x`/`2x` renderer 坐标转换及 `PrototypeDocument` round-trip。IR 只保存结构化 `style.rotation`/`style.transformOrigin` 和 literal layout patch，不保存 Moveable/CSS/matrix 私有状态。

这些测试不证明真实浏览器手势已经可投产。真实触控、吸附与参考线、React Flow 内外层 pan/zoom 仲裁、滚动容器、移动端缩放与手柄位置、键盘选择及大文档性能仍是强制 browser gate；全部通过前依赖状态保持 `poc`，不得标记为 `adopted`。两包均未声明 React peer-version 合同，现有 React 19 结果只是本仓库兼容性证据，不是上游保证。

### 当前工作台的具体替换

| 当前手写行为 | 应采用的现成能力 | 保留的自有部分 |
|---|---|---|
| 多组菜单的 open state、全局 Escape 和 outside-click | Radix DropdownMenu/Popover/Select | 现有触发器、尺寸、颜色、动效和菜单内容 |
| 分享、导出、预览弹层的焦点与背景隔离 | Radix Dialog/AlertDialog | 现有面板布局、业务步骤和动画 |
| 手写 `role="switch"` 与 ready toast 浮层 | Radix Switch + Sonner | 现有开关外观、Toast 内容和位置合同 |
| 命令面板搜索与键盘选择 | cmdk | 命令目录、权限和执行逻辑 |
| 附件 chip 与假选择 | Uppy | FileAsset、上传会话、解析状态和权限 |
| 画布拖拽、缩放、框选、节点 resize | React Flow | Board revision、ArtifactVersion 钉住和冲突处理 |
| 屏幕内部元素的框选、拖动、缩放、旋转和吸附 | react-selecto + react-moveable | 内部节点 ID、布局约束、变更 command、版本和导出语义 |
| 图层、附件和普通列表拖拽排序 | Pragmatic Drag and Drop | 权威父子关系、顺序、权限、键盘文案和服务端冲突处理 |
| PRD 内容编辑、撤销和选择 | Tiptap + 官方 Table/Link 扩展 | PRD schema、领域节点 adapter、版本、引用和发布规则 |
| PRD/代码版本 Diff | 内部 PRD 的确定性 Markdown 投影 + CodeMirror merge | ArtifactVersion 读取、投影规则、保存和权限；只有确需富文本语义 Diff 时再评估 prosemirror-changeset |
| 项目/文件/产物缓存与刷新 | TanStack Query | query key 规则、领域错误和乐观更新政策 |
| SSE 文本拆帧 | eventsource-parser，声明为直接依赖 | sequence 去重、跳号恢复、BFF session 续期和状态机 |
| 灵感卡片轮播 | 仅在要求触摸拖拽和完整无障碍时评估 Embla Carousel | 当前仅按钮翻页时保留简单状态更小，不为了“使用开源”强加依赖 |

当前旧 PRD 编辑器直接操作底层 ProseMirror，并自行维护 table schema 与 Markdown 序列化。新 PRD feature 已迁移至 Tiptap Core/StarterKit/Table/Link/UniqueID；旧编辑器仅供旧应用残留清理时参考，不再作为新 Workbench 事实源。`eventsource-parser` 和 Zustand 已是新 Workbench 的直接依赖；后续依赖也必须在实际消费它的 workspace 中显式声明，不能依赖传递引入。

### 仓库采用状态快照

截至 2026-07-15，新绿地底座已经直接声明并真实消费 React Flow 12.11.2、TanStack Query 5.101.2、openapi-fetch 0.17.0/openapi-typescript 7.13.0、eventsource-parser 3.1.0、Zustand 5.0.14、Uppy Core 5.2.0/AWS S3 5.1.0、hash-wasm 4.12.0、perfect-freehand 1.2.2、react-colorful 5.7.0、React Hook Form 7.81.0、pg-boss 12.26.0、canonicalize 2.1.0、`@langchain/langgraph-sdk` 1.9.25、`@langchain/core` 1.1.48、`uuid` 14.0.1、`form-data` 4.0.6、Playwright、archiver、MCP SDK、OpenTelemetry 和固定 Figma Importer 工具链。`react-selecto@1.26.3` 与 `react-moveable@0.56.0` 已通过内部 adapter 进入 Prototype 编辑主链。产品工作台通过 feature controller 消费 Project/Thread/Run/Board/Artifact/DesignSystem/Share/Export 状态，第三方类型没有进入领域合同。

Uppy Golden Retriever、Pragmatic Drag and Drop 和 CodeMirror merge 尚未接入新主链；Tiptap、react-easy-crop、Docling、Moveable/Selecto、perfect-freehand、react-colorful/React Hook Form、MCP SDK 与 OpenTelemetry SDK 已分别进入对应主链。Redocly 和固定版本 oasdiff 已进入 CI。`uppy-multipart.ts` 已使用 Uppy/hash-wasm 并拆出 digest Worker/lifecycle helper，页面级上传 registry 与可见控制也已完成；剩余上传工作只计入真实目标 S3/IAM 的生产恢复验收。OpenTelemetry 现在由直接依赖的 `packages/workbench-telemetry` 统一初始化，覆盖 BFF/API HTTP、pg-boss producer/consumer 与 DeerFlow/Docling/TEI 请求；仅在 lockfile 中传递出现的其他库仍不能算产品工作台已采用。

## 后端、知识与交付选型

| 能力 | 首选开源项目 | 许可证 | 采用方式 |
|---|---|---|---|
| Node 模块格式 | Node 22 ESM + TypeScript NodeNext | MIT/Apache-2.0 | 新 Workbench 的 API、Contracts 和 Worker 在 Foundation 统一迁移；旧应用不跟迁，不以 CommonJS 兼容为由长期锁死 ESM-only 开源库 |
| Schema 与运行时校验 | Zod | MIT | Contracts 中定义稳定 DTO、事件和 Artifact schema |
| 合同生成 | `@asteasolutions/zod-to-openapi` | MIT | Zod schema + route registry 是唯一人工维护源；OpenAPI 3.1 YAML 由 CI 确定性生成，禁止再手写同一字段两遍 |
| 规范 JSON 与摘要输入 | canonicalize（RFC 8785/JCS）+ Node crypto | Apache-2.0/Node 标准库 | 统一幂等请求、Artifact manifest 和运行时 option ID 的 canonical bytes；项目定义 `jcs-sha256-v1` 覆盖范围和算法标识，不再维护多套排序 JSON |
| 数据访问 | Prisma Client | Apache-2.0 | 只服务新 Workbench schema；复杂约束由 SQL migration 明确实现 |
| 持久任务 | pg-boss 12.26.0 | MIT | 使用 `fromPrisma(tx)` 让业务写入与任务提交同事务，不再自建 outbox；固定版本并做真实 commit/rollback 测试 |
| 中文混合检索 | `jieba-wasm@2.4.0` + PostgreSQL simple FTS + pgvector + TEI | MIT/PostgreSQL/Apache-2.0 | lexical 与 dense 用 RRF 合并，reranker 独立；EmbeddingProfile/KnowledgeRelease 是事实源，不让模型维度或 TEI 类型进入 chunk 合同；详见 `docs/workbench-knowledge-retrieval-architecture.md` |
| 中文全文替代 | PGroonga | PostgreSQL-style License | 仅在目标 PostgreSQL 环境允许扩展且压测收益明确时采用，不作为可移植默认值 |
| Markdown AST | unified、remark-parse、remark-frontmatter、remark-gfm、unist-util-visit | MIT | 知识分块与设计系统 guidelines/usage 导入共用 AST 管线；只把受支持节点映射到内部 schema，仅 Obsidian 特有语义写小插件，禁止用正则拼 Markdown parser，也不保存 mdast 为事实源 |
| 文档解析 | Docling Serve 1.26.0（内含固定 Docling 组件组合） | MIT | 独立 CPU/GPU 容器；异步 task API + checkpoint，固定镜像 digest、内部组件版本、模型权重许可/checksum 和输出 schema；本项目保留格式白名单、超时和资源限制 |
| OCR | PaddleOCR；轻量备选 Tesseract | Apache-2.0 | 只在扫描 PDF/图片确有 OCR 需求时由 File Worker/Docling adapter 调用；固定模型权重、语言包、checksum 和资源上限，normalized output 仍写内部 FileExtraction schema |
| MIME 识别 | file-type | MIT | 作为 Node 主实现，不相信扩展名或浏览器 Content-Type；只有 PoC 证明格式覆盖不足时才在隔离 Worker 增加 libmagic，不默认维护双内核 |
| ZIP/Axure ZIP 解包 | `yauzl@3.4.0` | MIT | `lazyEntries` 逐条流式读取并启用 entry size 校验；项目只定义条目数、单项/总展开大小、压缩比、路径深度、嵌套层数和超时预算，不自写 ZIP parser |
| 广义 Archive 解包 | libarchive 3.8.8/bsdtar | 主要 BSD-2-Clause | 只有产品明确支持 tar/7z 时才在非 root、无网络、配额受限的隔离容器启用；不作为当前 ZIP 默认路径 |
| 图片解码与衍生物 | Sharp | Apache-2.0 | 在隔离 Worker 中生成缩略图、尺寸和安全重编码；原 Blob、crop 参数和衍生物分别保存 |
| 字体元数据与字形覆盖 | fontkit | MIT | 仅在 File/Export Worker 解析字体名称、weight/style、variable axes 和 glyph coverage；Blob、许可证、权限、资产 pin 与 Runtime 可见性仍由内部 File/Artifact 合同决定，不保存 fontkit 对象 |
| 恶意文件扫描 | ClamAV + 最小受测 INSTREAM adapter | GPL-2.0/自有 adapter | ClamAV 作为独立服务；Node clamd client 普遍停更，`clamscan` 仍是无类型 CommonJS 且最后源码更新较早，不比当前薄协议 adapter 更干净。严格响应、VERSION、病毒库签名新鲜度、StreamMaxLength、abort、瞬时故障重试和 fail-closed readiness 已完成；真实生产 clamd/EICAR E2E 仍是外部门禁。这是“接入第三方成本更高”的允许自研例外 |
| 对象存储协议 | AWS SDK v3 S3 client | Apache-2.0 | 通过 S3 接口接云存储或自托管服务；生产不锁定某个厂商 SDK |
| 自托管身份 | Keycloak | Apache-2.0 | 仅在没有现成企业 OIDC 时部署；Workbench 只依赖标准 OIDC claims，避免额外承担 IAM 主题、HA、数据库和升级运维 |
| 授权策略 | 自有固定角色 PolicyService + PostgreSQL 约束；条件候选 Cerbos/OpenFGA | Apache-2.0 | 当前 Workspace/Project 角色数量固定，权限矩阵属于领域合同，集中实现比引入策略服务更小；只有出现用户可配置策略时引入 Cerbos，出现大规模关系图授权时再评估 OpenFGA，二者数据都不能替代 ProjectMember 事实源 |
| HTML 截图/PDF | Playwright + Chromium | Apache-2.0/各组件许可证 | 在隔离的 export worker 中渲染；不在 API 进程执行用户 HTML |
| DOCX | docx | MIT | 从结构化 PRD 生成，不通过脆弱的 HTML 字符串替换 |
| React AST 生成 | Babel AST/generator + Prettier | MIT | 长期路径为 `PrototypeDocument -> RenderPlan -> React AST`；state/action/binding/motion 必须从 IR/runtime data 生成，不能从 HTML 反推。`html-to-jsx-transform@1.2.1` 只允许作为已生成静态叶片的过渡转换器 |
| React/HTML 构建验收 | Babel generator + Prettier + esbuild | MIT | 使用无外网、只读预装 allowlist 依赖且禁用 lifecycle script 的隔离 Worker 真构建；作业执行时不下载任意 npm 包，“生成了字符串”不算导出成功 |
| 导出归档 | `archiver@7.0.1` | MIT | 作为 Export Worker 的直接依赖生成 ZIP；项目只定义固定目录、文件名、大小上限、manifest 与摘要，不手写 ZIP writer，也不接受用户控制的归档路径 |
| Figma 稳定导入 | `create-figma-plugin@4.0.3` + `@figma/plugin-typings@1.130.0` + `fflate@0.8.3` | MIT/官方 typings | 固定产品工作台 Importer 1.0.0 只调用官方 Plugin API 并读取版本化 `FigmaExportDocument`；导出数据与插件实现独立升级，不依赖非公开 `.fig`、Kiwi 或剪贴板编码 |
| Design token 投影 | Style Dictionary | Apache-2.0 | 从 `workbench.design-system.v1` 生成 CSS/React/Figma/Runtime 目标投影；内部 token schema、alias 约束、资产引用和版本仍是事实源，Style Dictionary config 与 transform 名称不得入库 |
| 颜色解析与运算 | Color.js | MIT | 复用 CSS Color 解析、色域转换、混色和对比度计算；内部 token 类型、语义命名、可访问性门槛和序列化格式由项目定义，不保存 Color.js 实例 |
| 可观测性 | OpenTelemetry | Apache-2.0 | trace、metric、log 使用开放协议；后端可接任意兼容存储 |
| 结构化应用日志 | Pino + nestjs-pino | MIT | request/trace/run id 自动关联并做字段级脱敏；OpenTelemetry 不替代可检索应用日志 |
| 边缘限流 | NGINX `limit_req` + `@nestjs/throttler` | BSD-2-Clause/MIT | 边缘承担突发保护，应用承担单实例兜底；跨实例业务额度仍以 PostgreSQL 中的 Workspace/Project 配额为事实源 |
| Agent Runtime | DeerFlow 2.x + `@langchain/langgraph-sdk` | MIT | DeerFlow 是唯一生产 Runtime；其 LangGraph-compatible 线程、Run、join/stream/cancel transport 优先使用官方 SDK。先锁定 DeerFlow 已使用的 legacy `runs.stream`，设置 `callerOptions.maxRetries=0`，并通过 `onRunCreated` 立即把 external run id 写入自有 RuntimeAttempt；重放 join 既有外部 Run，取消先立本地 commit fence 再调用 SDK cancel。v2 `threads.stream` 通过 pinned-contract PoC 后再升级 |
| DeerFlow 文件上传协议 | `form-data@4.0.6` | MIT | 当前 Runtime Worker 已用成熟 encoder 负责 multipart boundary、header 编码和 Content-Length；项目只保留对象流摘要复核、大小限制、超时和上传 handle 校验，不手拼 multipart 语法 |
| 模型追踪 | Langfuse Core | MIT，`ee/` 除外 | 可选自托管；核心链路只依赖 OpenTelemetry/内部 traceId，先评估 ClickHouse 等运维成本并做 PII 脱敏 |
| 多模型网关 | LiteLLM Core | MIT，`enterprise/` 除外 | 仅在 DeerFlow 需要统一额度、审计、路由和故障切换时增加；只能 DeerFlow 指向 LiteLLM，不再产生第二份 Workbench provider 配置 |
| 外部 Google Stitch 能力 | `@google/stitch-sdk`/Google Stitch MCP | Apache-2.0/托管服务条款 | 二期可选并置于 adapter 后；不成为 Project、Artifact 或运行时事实源 |
| OpenAPI 质量门 | Redocly CLI + oasdiff | MIT/Apache-2.0 | 作为合并阻塞门：Redocly 校验生成的 OpenAPI 3.1、`$ref` 和规则；oasdiff 阻断未批准的 breaking change；自有脚本只保留 Idempotency、ETag、SSE 等产品断言 |
| 模块边界门禁 | dependency-cruiser + ESLint restricted imports | MIT | CI 禁止 Workbench import 旧 chat、AI SDK、SWR 和旧 API；feature 只经 public index 依赖，第三方类型只能进入 adapter |
| 知识展示站 | Quartz | MIT | 独立、只读地消费 immutable `knowledge-vault` 并产出可重建静态站；锁定 commit 和插件清单，不成为 KnowledgeRelease 或检索事实源，不长期 fork 上游 |
| 单元/组件/浏览器测试 | Vitest + Testing Library/user-event + MSW + Playwright + axe-core | MIT/Apache-2.0/MPL-2.0 | 契约、组件键盘交互、E2E、视觉和无障碍回归；axe-core 只作测试依赖 |

Contracts 已收口为 Zod/route registry 唯一人工源。当前 current 与已刷新 baseline 同为 79-path / 97-operation，上一批准基线为 71/89。Design preset catalog、thread-scoped SubmissionIntent、三元 preset 引用和可选上传 slot binding 已通过绿地破坏性变更审查；旧 preset shape、project-scoped current、Workspace-scoped Project GET 和合同双写均不保留。Generator consistency、Redocly、Nest route coverage、oasdiff、Web types 和 baseline 已同步；不得恢复手写 YAML 字段副本。

Docling 接入必须使用异步、可恢复的外部任务：Workbench 从已验证 Blob 读取并以内网 multipart 调用 `POST /v1/convert/file/async`，立即持久化 `task_id`，之后只轮询状态并读取结果；Worker 重放只能继续已有任务，不能再次提交同一个解析。禁用 `/source`、remote services、external plugins 和 custom model config，容器无公网出口；限制单来源、25 MiB、明确页数、5-10 分钟文档超时、CPU/内存/临时盘。`FileExtraction.parserVersion` 记录实际 Serve 镜像及内部 Docling 版本组合，不能用外部最新版本代替；输出至少保留 `docling_json` 和规范化 `markdown`，前者供页码/表格/布局 citation，后者供统一知识分块。

知识模块只依赖内部 `EmbeddingPort`，不依赖 Vercel AI SDK 或完整 LangChain provider 层。临时 `KnowledgeChunk.embedding vector(1536)` 与 `embeddingModel` 已删除，一等 EmbeddingProfile、独立无 typmod chunk embedding 表、维度/归属复合约束和 profile pin 已落盘。首选生产候选仍是 Qwen3-Embedding-0.6B 1024 + TEI，BGE-M3 是必测基线，bge-reranker-v2-m3 作为独立 reranker；最终 adopted 决策必须由至少 100 条中文标注查询、固定权重/revision/image digest 与真实延迟结果决定。第三方 OpenAI-compatible adapter 设置 `maxRetries: 0`，重试由 pg-boss 统一掌握，供应商类型不得越过 adapter。完整合同与门禁见 `docs/workbench-knowledge-retrieval-architecture.md`。

### 当前重复实现止损清单

| 当前实现 | 审计结论 | 下一步 |
|---|---|---|
| `apps/web/lib/workbench/files/uppy-multipart.ts` 1,296 行 | 已调用 Uppy/hash-wasm，digest Worker 与 lifecycle helper 已拆出，创建、恢复、取消、ETag、错误分片和状态映射竞态已修；SubmissionIntent binding 与确定性命令键已进入同一持久 checkpoint，但主 controller 仍混合 transport、session 和 extraction 编排 | 不再增加通用传输分支。继续把 Uppy transport adapter、File lifecycle 和持久 session 分开；普通上传的暂停/取消/listParts/retry 归 Uppy，Intent 绑定附件由整单取消维护槽位一致性，服务端 session/ETag/幂等保留。Golden Retriever 仅作小文件增强 |
| `apps/workbench-worker/src/runtime/deerflow-runtime.adapter.ts` | 已采用 `@langchain/langgraph-sdk@1.9.25` 负责 thread/run stream/list recovery/`joinStream`/cancel；RuntimeAttempt、externalRunId checkpoint、metadata recovery 和本地 commit fence 已完成，multipart 已改用 `form-data@4.0.6` | 继续保留 Workbench 自有事件归一化、附件可信摘要、Gateway handle、结果 schema 和提交资格；真实 pinned DeerFlow 部署 E2E 通过前不升级 SDK transport 合同 |
| 持久 Workbench 页面运行时 | `(workbench)` layout -> `WorkbenchRuntimeProvider` -> `WorkbenchScene` 已唯一拥有页面；Next pages 只保留 URL，Project 使用 fulfilled-module cache 动态边，P1 -> P2 固定 `key="project"` 并保持 Project/header/React Flow DOM identity | 维持单一页面级 `AnimatePresence mode="sync"`；禁止第二 route owner、`key={projectId}`、聚合 service 或把 Project UI 重新塞回 Home 静态模块图 |
| `packages/workbench-contracts` 生成链 | Zod/route registry -> current/baseline 79-path / 97-operation OpenAPI -> Web types 已完成；上一批准基线 71/89 | 保持生成物、Redocly、route coverage、oasdiff 和 baseline 同步；Design preset 与 SubmissionIntent 是批准的直接改造，不恢复旧 shape/route 或合同双写 |

“使用开源”不能只看 package.json。一个 1000 行 wrapper 如果重新实现了上游状态机，仍然是重复造轮子；相反，ProjectRelease、权限矩阵或 Run commit fence 即使代码很多，也属于必须由产品掌控的领域实现。

当前 Web 144 files / 616 tests 全部通过，Testing Library、user-event、MSW 与统一 Playwright `e2e:web` 已覆盖核心组件和浏览器链；NavigationGuard 还在 Chromium、Firefox、WebKit 验证了页面过渡非空和 P1 -> P2 DOM identity。仓库门禁不替代目标域、真实 API/DB/S3/Worker、触控设备、reduced-motion 和完整生产截图矩阵；Playwright golden 仍应按 `viewport/state` 版本化入库，任何基线更新都必须显式评审。

对象存储需特别注意许可证：MinIO 当前采用 AGPL-3.0，官方 GitHub 仓库也已归档，不应成为新项目默认生产发行物。默认优先使用已有 S3 兼容云存储；必须自托管时，可单独评估 Apache-2.0 的 SeaweedFS，且业务代码仍只依赖 S3 适配器。

上传协议一期只选择 S3 multipart。只有确认存在弱网超大文件断点续传需求、且对象存储不能满足时，才单独评估 MIT 许可的 tusd；不得同时维护两套上传会话和恢复语义。

Google Stitch SDK 开源不等于其托管生成服务具备生产 SLA。这里的“Google Stitch”仅是外部供应商及官方技术名，不是产品品牌；用户可见名称仍统一为“产品工作台”。该能力可以在不采用 Vercel AI SDK 的情况下通过直接 SDK/MCP adapter 使用；第三方模型可以在 DeerFlow 外层决定是否调用该工具，但其托管服务内部的 UI 生成模型仍由 Google 控制，不能替换为任意第三方模型。因此它只能是可熔断的二期设计能力，不能进入核心数据和运行合同。

DeerFlow 2.0 Core 本身为 MIT，无代码许可费；“免费”不包含模型 token、搜索、sandbox、向量/重排、算力和观测服务。Langfuse 与 LiteLLM 都按 open-core 对待：只允许可审计的 MIT Core 进入可选部署，`ee/` 或 `enterprise/` 能力必须单独采购和审查，不能让企业版数据结构进入 Workbench 合同。

截至 2026-07-12 的费用与模型边界：

- 当前核验的 Google Stitch `@google/stitch-sdk` 0.3.5 使用 Apache-2.0 许可证，SDK 本身没有许可费；根入口/MCP 不依赖 Vercel AI SDK，本项目不采用其可选 `./ai` 适配入口。
- Google 官方 Gemini CLI 的 Google Stitch 扩展当前写明 Google Stitch MCP “free of charge”，但没有公开固定数值配额、GA SLA 或永久免费承诺；生产仍要处理 429、超时和熔断。
- “支持第三方模型”只成立于外层 Agent：第三方模型可经 DeerFlow 决定是否调用 Google Stitch；Google Stitch 托管服务内部的 UI 生成模型不能替换为第三方模型。

### 不使用 Vercel AI SDK 后的最终裁决

| 候选 | 许可证/费用 | 是否采用 | 原因 |
|---|---|---|---|
| Vercel AI SDK | Apache-2.0，SDK 许可费 0 | 不采用 | 排除原因不是收费，而是 `UIMessage/useChat/provider runtime` 会成为第二套消息与模型合同 |
| OpenAPI + `fetch` + eventsource-parser + Run reducer | MIT/标准 API，许可费 0 | 采用 | 最小依赖，完全服从本项目 Run/Artifact 合同；第三方模型由 DeerFlow 管理 |
| AG-UI | MIT，许可费 0 | 暂不采用，保留互操作候选 | 模型无关且支持 SSE/WS，但当前会制造第二份事件语义；只有 DeerFlow 原生输出或确有跨 Runtime 需求时再接 adapter |
| assistant-ui | Core MIT，Cloud 可选收费 | 不采用主链 | 可接 custom runtime，但会接管 thread/message/composer 模型并破坏产品工作台视觉和现有领域边界 |
| CopilotKit | Core MIT，托管能力另计 | 不采用主链 | 完整 agent UI/runtime 层与 DeerFlow、Workbench UI 重叠 |
| TanStack AI | MIT，0.x | 不采用 | provider-agnostic 但同时承担模型调用和工具 runtime，会形成第二生产 Runtime，且稳定性不足以进入当前主链 |

结论不是“找另一个 AI SDK 替代 Vercel AI SDK”，而是删除这一层。浏览器只理解本项目的 RunEvent 和 Artifact；DeerFlow 负责 Agent 与模型；LiteLLM 只在确需统一供应商治理时作为 DeerFlow 下游网关。

## 当前可见功能的复用方案

“所有功能真实可用”不能只覆盖项目、生成和预览。当前界面已经展示 Frame、Draw、Media、Style、Special、Undo/Redo、复制/删除/重命名、公开分享/重混，以及 Figma、HTML/CSS、React、MCP 四类导出；最终验收必须逐项兑现。

表中“二期”“按需”或“条件采用”只表示实施顺序，不表示最终可以保留假按钮；凡当前界面已经可见的能力，都必须在最终硬切前完成真实实现或由产品明确从界面删除。

| 可见能力 | 复用的开源内核 | 仍需实现的产品能力 |
|---|---|---|
| 模型、Redesign/Ideate、App/Web 与 Style 选择 | Radix/cmdk + DeerFlow RuntimePort | `modelId` 只表示真实运行模型；Redesign/Ideate 必须是 typed workflow/intent，App/Web 是 target surface，Style/设计系统引用是独立 Run option，并进入幂等摘要与审计 |
| Home“以您的设计为基础” | OpenAPI + TanStack Query | 选择同 Workspace 可读的 ready `design_system` 版本；目标 Project 创建后调用 import command，以 receipt 的目标 ArtifactVersion 提交 Run，不能让 Run 跨 Project 引用来源版本 |
| Home“自定义设计”与 Project Style | Radix/cmdk + React Hook Form + Color.js/react-colorful | v1 是 `workbench.design-system.v1` 的结构化表单编辑器，不承诺另造一套 Figma；Project 菜单只展示 automatic、preset 和本 Project ready 版本，跨 Project 选择先 import |
| Board 上的屏幕放置/分组/缩放 | React Flow group/sub-flow、selection | ArtifactVersion 引用、Board revision、位置尺寸和权限 |
| 屏幕内部元素编辑 | react-selecto + react-moveable | PrototypeDocument 节点、布局约束、command、版本和跨格式导出 |
| Draw | perfect-freehand + Moveable/Selecto adapter | stroke schema、选择/变换、样式、持久化和导出 |
| Media | Uppy + react-easy-crop | Asset 目录、裁剪参数、衍生物、版权/权限和节点绑定 |
| Style | react-colorful + 自有 IR renderer | design token、选择范围、样式变更命令、跨导出一致性；一期不引入 Puck/GrapesJS |
| Undo/Redo | Zustand + Immer patches + zundo | 哪些操作可撤销、patch 合并、服务端 revision 冲突和 Artifact 发布边界 |
| 复制/删除/重命名 | Radix menu + React Flow selection | command、权限、引用完整性、幂等和审计 |
| 屏幕收藏、喜欢/不喜欢 | Radix ToggleGroup/Tooltip | Bookmark/Feedback command、幂等、权限、审计和聚合；不能保留空 `onClick` |
| “添加屏幕截图” | 浏览器 `getDisplayMedia`/ImageCapture + Uppy | 若语义是实时抓屏，先取得显式浏览器授权再上传；若只允许选文件，则改成准确文案，不能用同一假附件路径混淆 |
| Run 审批选择 | Radix Dialog + RadioGroup | approval option ID、权限、提交/拒绝 command 和终态；不手写第二套单选键盘行为 |
| Project Composer 刷新 | 现有 TanStack Query/controller | 刷新 suggestion/context 的真实 command、loading/error 和防重复；无需增加新组件库 |
| 项目预览覆盖层 | Radix Dialog + 独立 preview origin + Penpal | token、origin、schema、超时、销毁、多屏切换/刷新和焦点恢复；主站不得直接执行任意生成代码 |
| HTML/CSS 导出 | Playwright + Prettier + archiver | 从内部 IR 生成独立资源包、安全校验和下载任务 |
| React 导出 | Babel AST/generator + Prettier + esbuild；`html-to-jsx-transform` 仅用于静态叶片 | 从内部 RenderPlan 直接生成组件、props、路由、state/action/binding/motion runtime、资源引用和隔离构建；不能把 HTML 中转当语义事实源 |
| Figma 导出 | `create-figma-plugin` + `@figma/plugin-typings` + `fflate` | ExportJob 产出版本化 `FigmaExportDocument`，由固定产品工作台 Importer 通过官方 Plugin API 导入；不自写 `.fig`/Kiwi/剪贴板编码 |
| MCP 导出 | `@modelcontextprotocol/sdk@1.29.0` | Artifact resource/tool、授权、版本固定、审计和传输策略 |
| “与我共享” | OIDC/OpenAPI + TanStack Query | 已采用跨 Workspace `GET /projects`，按当前 Principal 的显式 ProjectMember 区分 owned/shared；邀请 create/list/preview/accept/revoke 与公开 token 分享保持独立语义 |
| 公开分享与重混 | OIDC/OpenAPI/preview sandbox | ShareGrant 已固定不可变 ProjectRelease/manifest；剩余是生产策略、限流和真实 preview/S3 链路验收 |
| Special/AI 操作 | DeerFlow RuntimePort | 工具目录、输入 schema、审批、权限、RunEvent 和产物提交 |
| Docs、帮助、反馈、Gift/公告入口 | Radix menu；反馈可接批准的 issue/helpdesk adapter | 每个可见入口必须有明确 URL、权限和真实动作；不能继续保留无 `onClick` 的按钮，也不能擅自把项目数据发送到外部服务 |

### 设计系统合同与开源边界

`ArtifactKind.design_system` 是一等 Artifact，不是 Project 配置 JSON。其不可变内容合同固定为 `workbench.design-system.v1`，至少覆盖 `documentId`、`title`、`tokens`、`assets`、`principles`、`guidelines`、`components` 及组件 variants、states、usage；项目自己校验 ID/token path 唯一、引用完整、alias 无环和 Asset pins。Style Dictionary、Color.js、fontkit、unified/remark 只在 adapter/worker 内承担投影或解析，任何第三方配置、实例、AST 或字体对象都不能进入数据库合同。

同 Workspace 复制使用挂载于 `/api/v1` 的 `POST /projects/{targetProjectId}/design-system-imports`，body 只接受 `{ sourceArtifactVersionId }`。command 必须验证 source read、target edit、ready kind/schema、Workspace 一致性和 `Idempotency-Key`；成功后在目标 Project 写入独立 ArtifactVersion，并返回不可变 `DesignSystemImport` receipt。Receipt 以强外键固定 target Project/Artifact/Version，以审计快照保存 source Project/Artifact/Version ID 与 checksum，并保存 `createdById`、`idempotencyKey`、`requestHash`、`createdAt`。来源随后更新、归档或删除均不得改变目标版本；跨 Workspace 未来只允许经不可变 Release/Share 授权，不扩大 v1 command。

Run 只 pin 目标 Project 的 ready ArtifactVersion。服务端从版本内容和资产 pins 确定性物化 `RuntimeDesignStyleSnapshot`，解析 alias、筛出 Runtime 所需 token/原则/guidelines/组件 usage/受权资产，并将其纳入请求摘要和审计；DeerFlow adapter 只消费该 snapshot，不查询来源 Project，也不把 Style Dictionary 或 Color.js 类型带进 RuntimePort。这一层是领域 materializer，不是第二个设计系统数据库。

多格式导出要求一个项目自有、框架无关的 `PrototypeDocument`/`PrototypeManifest` 作为唯一事实源。React Flow、GrapesJS、Puck、HTML、React 和 Figma 都只是这个内部 IR 的编辑或渲染 adapter，任何一个第三方项目的数据结构都不得直接成为数据库长期合同。否则很快会退化为 HTML 转 React、React 转 Figma、Figma 再回写 HTML 的多套不可逆转换链。

React Flow 与 Moveable/Selecto 同时存在时必须先冻结交互所有权：Board 坐标、选择和快捷键由 React Flow 管理，进入 Prototype 编辑态后由 renderer 将坐标转换给 Moveable/Selecto，并暂停冲突的 Board 手势；`Frame` 也必须明确区分 Board 分组与 Prototype 内部容器。这个仲裁层属于产品 adapter，不能靠两个开源引擎同时监听 DOM 事件碰运气。

项目级分享、重混和导出已经统一消费不可变 `ProjectRelease` manifest，固定 Board revision、ArtifactVersion、Blob/Asset 与 schema 版本；ShareGrant 与 ExportJob 不再从浮动 Project 当前状态拼装输入。后续开源导出库或 Preview RPC 只能消费该合同，不能重新引入可漂移的旁路。

Figma 生产路径已经固定为 `Prototype IR -> workbench.figma-export.v1 -> 产品工作台 Importer 1.0.0 -> 官方 Plugin API`。导出包记录 schema 和兼容 importer 版本，插件构建独立、确定性分发，不为每次导出制造一套源码。Blob/font loader、中文字体、多屏、flex/grid、absolute、渐变、阴影、SVG、表单和大画布进入固定验收集。仓库不保留 HTML-to-Figma、私有 `.fig`/Kiwi 或剪贴板转换旁路；能力不足时收窄明确支持范围，不增加第二事实源。

React 导出也不能从 HTML 反推产品语义。长期路径是 `PrototypeDocument -> framework-neutral RenderPlan -> React AST/runtime data`，HTML 与 React adapter 共用同一 RenderPlan；Babel generator、Prettier 和 esbuild 负责源码、格式与真构建。现有 `html-to-jsx-transform@1.2.1` 可以继续承担已生成静态叶片的属性/style/SVG 转换，但 state、action、binding、motion、组件边界和资源引用必须直接来自 IR，不能从 HTML 或事件字符串猜测。任意上传 HTML 不进入这条转换链。

## 建议代码边界

```text
packages/
  workbench-contracts/       Zod route registry、RunEvent、公开 DTO、OpenAPI generator
  prototype-ir/              框架无关的 PrototypeDocument 与校验

apps/web/app/(workbench)/
  layout.tsx                 持久 provider 与 Runtime 唯一挂载点
  page.tsx                   Home URL-only page，返回 null
  projects/[projectId]/page.tsx  Project URL-only page，返回 null

apps/web/components/workbench/
  workbench-runtime.tsx      路由提交、持久展示状态与 controller 组合
  workbench-scene.tsx        Home/Project 唯一场景 owner
  workbench-route-transition.tsx  页面级 AnimatePresence mode="sync"
  workbench-project-route-loader.ts  fulfilled-module cache 动态边
  workbench-home-route.tsx
  workbench-project-route.tsx    固定 key="project"，禁止按 projectId remount

apps/web/lib/workbench/features/
  */domain/                  内部领域合同
  */application/             command/query 与状态协调
  */api-adapter/             generated OpenAPI client 边界
  */index.ts                 feature 唯一公开入口

apps/workbench-runtime-worker/src/adapters/
  deerflow/langgraph-client.ts  官方 SDK 的薄配置与 pinned-contract tests
  deerflow/gateway-upload.ts    标准 multipart encoder + 可信对象摘要
  deerflow/event-mapper.ts      DeerFlow event -> Workbench RuntimeEvent

apps/workbench-file-worker/src/adapters/
  docling/
  object-storage/

apps/workbench-export-worker/src/adapters/
  export-html/
  export-react/
  export-figma/
```

Runtime、文件解析和导出使用独立 image/process：Runtime Worker 只访问 DeerFlow/模型，File Worker 承担高内存解析与图片处理，Export Worker 默认禁用外网并使用只读预装工具链。这样 Chromium、Sharp、Python/Docling 和代码构建不会污染 Agent 故障域。适配层只把第三方类型转换为内部合同，不承担业务编排；权限、事务、版本、幂等和状态机仍放在对应领域服务，避免形成一个无边界的 `utils` 或 `vendors` 大目录。

## 必须自研的部分

| 自研能力 | 原因 |
|---|---|
| Project/Thread/Run/Artifact/Board/KnowledgeRelease 领域模型 | 这是产品语义和长期数据合同，通用开源应用的对象模型并不匹配 |
| Run 状态机、幂等、取消 fencing、审批和事件序列 | 直接决定恢复、并发和产物提交正确性，不能交给 UI SDK 隐式管理 |
| RuntimeAttempt、externalRunId checkpoint 与重放策略 | LangGraph SDK 提供 transport，但哪个外部 Run 对应哪个本地 attempt、何时 join/cancel/commit 是本项目持久语义 |
| Run option schema 与 workflow/model 分离 | Redesign/Ideate、App/Web、Style 和设计系统引用是产品语义，不能塞进第三方模型 ID 或任意 JSON |
| DeerFlow RuntimePort 与事件归一化 | 要屏蔽供应商 packet、隐藏推理并固定内部协议 |
| ArtifactManifest、ArtifactVersion、验证与发布 | 决定产物可追溯、可回滚、可分享和可导出 |
| `workbench.design-system.v1`、DesignSystemImport 与 RuntimeDesignStyleSnapshot | 设计系统的内部 IR、同 Workspace 权限/复制/回执、资产 pin 和 Run 快照属于产品合同；开源库只能解析或投影 |
| Board 到 ArtifactVersion 的映射与 CAS | React Flow 只负责交互，不负责业务版本和并发 |
| Board/Prototype 嵌套坐标、选择与快捷键仲裁 | React Flow 和 Moveable/Selecto 各自只负责一个交互域，跨域语义必须由产品定义 |
| KnowledgeRelease、Vault 路由、引用与 citation | 这是本仓库知识结构的特定规则，通用 RAG 框架无法替代 |
| 文件所有权、状态机、隔离、引用计数和 GC | Uppy/Docling 只解决上传和提取，不解决业务生命周期 |
| ProjectMember、ProjectRelease、权限、审计、分享与导出策略 | 需要固定成员语义和不可变版本输入，并与 Workspace、Project、ArtifactVersion 一致 |
| 产品工作台视觉 ViewModel 和 Run reducer | 负责把真实状态映射到既有布局和动画，不能改变视觉合同 |

自研的是“产品规则和适配”，不是底层编辑器或基础协议。

Artifact checksum、幂等请求 hash 和审批 option ID 的“覆盖哪些字段、何时计算、使用哪个算法版本”属于产品合同；JSON 字节规范化本身不属于。当前幂等、Artifact checksum、approval option ID 和 DeerFlow fallback interrupt ID 已统一使用 canonicalize 2.1.0 的 RFC 8785/JCS 实现，非 JSON 值才显式使用字符串 fallback，并已有对象键序等价测试。之后 CI 禁止重新引入排序 JSON；迁移 NodeNext/ESM 后再单独评估升级，不为追新改变既有摘要算法版本。

数据库不得保存 React Flow Node/Edge、Tiptap/ProseMirror JSON、GrapesJS component model 或 Puck data 作为不可替换的长期事实源。它们都必须经过 adapter 映射到带 `schemaVersion` 的内部 Board、PrdDocument 和 PrototypeDocument；升级编辑器时只迁 adapter，不迁整个业务数据库。

## 明确不采用

1. 不 fork Dify、Open WebUI、LibreChat、Onlook、Bolt.diy、Open Lovable 或 Dyad。它们会带入各自的会话、模型、数据库、沙箱、插件、权限和升级模型，最终形成第二套产品内核；Onlook 等 Apache/MIT 项目仍可按本文规则受控摘取独立模块。
2. 不使用 Vercel AI SDK、`UIMessage`、`useChat` 或 AI Gateway 作为新 Workbench 合同。
3. 不引入 CopilotKit、assistant-ui 或 AG-UI 作为另一套消息/运行协议；可以借鉴交互，但当前产品工作台视觉和 `workbench.run.v1` 已经是本项目合同。
4. 不使用 native `EventSource` 作为 Run 主协议，因为 Run 创建需要 POST body，且 cursor、状态码、session 续期和跳号恢复需要 `fetch` 级控制；由 eventsource-parser 处理 SSE framing。
5. 不同时使用 SWR 与 TanStack Query 管理同一批新领域资源。
6. 不在一期引入 CRDT、实时多人协作、通用工作流引擎或独立向量数据库。
7. 不把 Puck 当成任意 HTML 编辑器，也不为满足界面文案伪造 Figma/React/MCP 导出成功。
8. 不复制 React Flow、Tiptap、Uppy、CodeMirror 等引擎源码；复制会丢失上游安全修复和升级路径。
9. 不再引入 tldraw、Excalidraw 或其他完整画布产品作为第二套 Board/Prototype 事实源；算法可以研究，数据模型和产品外壳不进入主链。
10. 不用自有 YAML 断言冒充完整 OpenAPI 校验，也不再手写 JSON canonicalization、结构 Diff 或组件焦点测试底座。
11. 不以 Git subtree、vendor 目录、复制 example app 或无退出日期的 `patch-package` 维护大型第三方引擎；需要长期修改时应提交上游或重新做选型。
12. 不采用 BlockNote XL、tldraw SDK 或 WebContainers 作为当前主链；它们分别带来 copyleft/商业许可、生产许可和商业运行时授权边界，且没有消除本项目的领域 adapter 工作。

Dify 的修改版 Apache 条款、Open WebUI 的品牌/用户规模条款、tldraw 的生产许可条件还会额外引入许可风险；即使 LibreChat、Bolt、Excalidraw 等项目采用 MIT，也不改变其领域模型和上游分叉不适合作为本项目内核的判断。

## 费用边界

一期推荐的核心库均可免费自托管，不需要购买 Tiptap Cloud/Pro、Transloadit、Langfuse Cloud 或 LiteLLM Enterprise，也不依赖 tldraw、BlockNote XL 或 WebContainers 的商业许可。React Flow Core 可以免费使用，但免费路径必须展示 attribution；若产品明确要求隐藏，必须先采购 Pro 或取得书面授权，不能仅设置 `hideAttribution`。

实际必然发生或可能发生的费用只有：

- 模型供应商 token、向量和重排调用费。
- PostgreSQL、对象存储、带宽、备份和运行计算资源。
- 选择托管 OIDC、可观测性、文档转换或安全扫描服务时的云服务费。
- 可选 Google Stitch 托管能力未来若调整收费或配额产生的费用；它不在核心运行依赖中。

所有 Pro/Cloud/Enterprise 能力必须有独立采购决策，不能悄悄进入核心接口或数据格式。

## 对工作量的影响

开源复用主要节省的是通用引擎开发，不会消除领域建模、真实数据接入、异常恢复、安全和验收工作。

| 通用能力 | 从头开发 | 开源接入与定制 | 预计节省 |
|---|---:|---:|---:|
| UI primitive、焦点与键盘行为 | 12-18 人日 | 4-6 人日 | 8-12 人日 |
| 无限画布与节点交互 | 20-30 人日 | 5-8 人日 | 15-22 人日 |
| 屏内框选、变换、吸附和图层拖拽 | 12-20 人日 | 4-7 人日 | 8-13 人日 |
| 富文本、代码和 Diff | 18-28 人日 | 6-10 人日 | 12-18 人日 |
| 上传、重试和进度 | 10-15 人日 | 4-6 人日 | 6-9 人日 |
| REST/SSE/cache/OIDC 客户端 | 12-18 人日 | 5-8 人日 | 7-10 人日 |
| 文档解析、导出和测试底座 | 25-40 人日 | 12-18 人日 | 13-22 人日 |
| 设计系统 import、投影与 Home/Project 接线 | 12-18 人日 | 7-10 人日 | 5-8 人日 |

表中工作存在重叠，不能简单纵向相加；去重后，相比全手写方案约节省 45-70 人日。设计系统的 7-10 人日是完整范围中的子集，不是在总预算之外追加。也不能从总工期再次机械相减，因为绿地实施估算已经假定采用成熟开源组件。权威规划仍以 `docs/workbench-greenfield-implementation-plan.md` 为准：从零累计基线仍为生产级基础平台 100-140 人日、当前可见功能全量兑现 165-250 人日；按 2026-07-16 已落盘状态重新核算，仓库内部接入门禁已通过，真实生产外部依赖验收与硬切的剩余量统一为 **26-48 人日**。

`165-250` 人日成立的范围是：受控 IR 预览、结构化表单式设计系统编辑、从 IR/RenderPlan 生成可运行 React、以及官方 Figma importer。任意生成代码在线执行、Figma 级完整设计系统编辑器、实时多人协作和外部 Figma 双向同步不在该数字内；前两项若加入，通常分别增加约 15-30+ 和 15-30 人日。产品工作台 Importer 1.0.0 已经落盘，不能再把“重做 importer”计入剩余量；真实 Figma Desktop 和目标生产环境验收已包含在当前 26-48 人日中。

## 从当前状态继续的落地顺序

1. 保持已经通过门禁的持久 Scene、动态 Project edge、16 个 feature、视觉叶组件、CSS 和动效不变；禁止恢复第二 route owner、聚合 service 或 `key={projectId}`。
2. 在选定的真实 S3/IAM 与 clamd 上完成断网、刷新、浏览器崩溃、过期 session、取消失败、EICAR、Export Worker 和下载恢复。
3. 使用已完成的 Knowledge Profile 与 AdoptionReceipt 治理，以真实模型、TEI/reranker、生产 DeerFlow trusted tool 和固定中文评测集完成 adopted 决策。
4. 在选定生产环境完成 OIDC/KMS、真实 DeerFlow、外部 OTLP collector、双 HTTPS Preview origin、Figma Desktop、Docker 镜像和全服务网络 E2E。
5. 使用硬切 manifest v2 一次切流并物理删除旧系统，写入删除回执并运行 `--enforce`；不保留兼容、双写或旧版回退。

每一步都必须复用已经通过的契约、集成和浏览器门禁，再补目标生产环境证据；不能把已经完成的开源接线重复包装成新工作量，也不能把跨 feature 状态堆回持久 Scene 或任一聚合 controller。

## 官方项目索引

- React Flow: https://github.com/xyflow/xyflow
- html-to-image: https://github.com/bubkoo/html-to-image
- Moveable: https://github.com/daybrush/moveable
- Selecto: https://github.com/daybrush/selecto
- @scena/matrix: https://github.com/daybrush/matrix
- Pragmatic Drag and Drop: https://github.com/atlassian/pragmatic-drag-and-drop
- dnd-kit（备选）: https://github.com/clauderic/dnd-kit
- Embla Carousel: https://github.com/davidjerleke/embla-carousel
- Tiptap: https://github.com/ueberdosis/tiptap
- Uppy: https://github.com/transloadit/uppy
- Uppy Golden Retriever: https://uppy.io/docs/golden-retriever/
- Comlink: https://github.com/GoogleChromeLabs/comlink
- TanStack Query: https://github.com/TanStack/query
- openapi-typescript/openapi-fetch: https://github.com/openapi-ts/openapi-typescript
- eventsource-parser: https://github.com/rexxars/eventsource-parser
- Better Auth: https://github.com/better-auth/better-auth
- Auth.js（未采用，版本风险对照）: https://github.com/nextauthjs/next-auth
- openid-client: https://github.com/panva/openid-client
- Cerbos: https://github.com/cerbos/cerbos
- OpenFGA: https://github.com/openfga/openfga
- zod-to-openapi: https://github.com/asteasolutions/zod-to-openapi
- dependency-cruiser: https://github.com/sverweij/dependency-cruiser
- hash-wasm: https://github.com/Daninet/hash-wasm
- js-tiktoken: https://github.com/dqbd/tiktoken
- file-type: https://github.com/sindresorhus/file-type
- Headless Tree: https://github.com/lukasbach/headless-tree
- Penpal: https://github.com/Aaronius/penpal
- qrcode.react: https://github.com/zpao/qrcode.react
- canonicalize: https://github.com/erdtman/canonicalize
- Redocly CLI: https://github.com/Redocly/redocly-cli
- oasdiff: https://github.com/oasdiff/oasdiff
- Docling: https://github.com/docling-project/docling
- Docling Serve: https://github.com/docling-project/docling-serve
- yauzl: https://github.com/thejoshwolfe/yauzl
- libarchive: https://github.com/libarchive/libarchive
- jieba-wasm: https://github.com/fengkx/jieba-wasm
- Qwen3 Embedding: https://huggingface.co/Qwen/Qwen3-Embedding-0.6B
- BGE-M3: https://huggingface.co/BAAI/bge-m3
- BGE reranker v2 m3: https://huggingface.co/BAAI/bge-reranker-v2-m3
- Text Embeddings Inference: https://github.com/huggingface/text-embeddings-inference
- PaddleOCR: https://github.com/PaddlePaddle/PaddleOCR
- Tesseract: https://github.com/tesseract-ocr/tesseract
- PDF.js: https://github.com/mozilla/pdf.js
- Sharp: https://github.com/lovell/sharp
- ClamAV: https://github.com/Cisco-Talos/clamav
- pg-boss: https://github.com/timgit/pg-boss
- pgvector: https://github.com/pgvector/pgvector
- SeaweedFS: https://github.com/seaweedfs/seaweedfs
- MinIO（未采用）: https://github.com/minio/minio
- OpenTelemetry: https://github.com/open-telemetry
- Pino: https://github.com/pinojs/pino
- Style Dictionary: https://github.com/style-dictionary/style-dictionary
- Color.js: https://github.com/color-js/color.js
- fontkit: https://github.com/foliojs/fontkit
- unified: https://github.com/unifiedjs/unified
- remark: https://github.com/remarkjs/remark
- esbuild: https://github.com/evanw/esbuild
- Quartz: https://github.com/jackyzha0/quartz
- DeerFlow: https://github.com/bytedance/deer-flow
- LangGraph JS SDK: https://github.com/langchain-ai/langgraphjs
- form-data: https://github.com/form-data/form-data
- clamscan Node client: https://github.com/kylefarris/clamscan
- Langfuse: https://github.com/langfuse/langfuse
- LiteLLM: https://github.com/BerriAI/litellm
- AG-UI: https://github.com/ag-ui-protocol/ag-ui
- assistant-ui: https://github.com/assistant-ui/assistant-ui
- TanStack AI: https://github.com/TanStack/ai
- create-figma-plugin: https://github.com/yuanqing/create-figma-plugin
- Figma Plugin API: https://www.figma.com/plugin-docs/api/api-reference/
- GrapesJS: https://github.com/GrapesJS/grapesjs
- Puck: https://github.com/puckeditor/puck
- Craft.js: https://github.com/prevwong/craft.js
- Onlook: https://github.com/onlook-dev/onlook
- Sandpack: https://github.com/codesandbox/sandpack
- BlockNote license: https://github.com/TypeCellOS/BlockNote/blob/main/LICENSE
- tldraw license: https://github.com/tldraw/tldraw/blob/main/LICENSE.md
- WebContainers commercial usage: https://developer.stackblitz.com/platform/webcontainers/commercial-usage
- Google Stitch SDK: https://github.com/google-labs-code/stitch-sdk
- Gemini CLI 的 Google Stitch 扩展定价说明: https://github.com/gemini-cli-extensions/stitch#pricing
