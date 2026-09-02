# 产品工作台绿地重建与全量接入实施方案

更新日期：2026-07-28

## 结论

本项目不把新前端接入旧 `Conversation/Message/AI SDK` 后台，而是使用独立的产品后台。旧应用代码与依赖已经从当前主树删除；生产硬切仍必须按受保护流程完成外部资源删除与回执，且全程不转发、不双写、不迁移旧业务数据。

目标前端由持久 `(workbench)` layout、`WorkbenchRuntimeProvider` 和 `WorkbenchScene` 统一拥有页面运行时；Next Home/Project page 只拥有 URL。领域功能通过公开入口和 `domain/application/api-adapter` 边界接入，禁止恢复旧 Chat、AI SDK、SWR、聚合 Service 或按项目 ID 重挂载页面。完成状态、测试数量和生产阻断不在架构文档中固化，统一以两份现行整改规格和实际门禁输出为准。

唯一从旧环境继承的业务资产是：

- `knowledge-vault`
- 由 `knowledge-vault` Markdown 经路径校验、allowlist、SHA-256 和引用闭包明确引用的 `storage` 文件

不得按目录整体导入 `storage`。大体积原始来源按仓库治理保留在本地 `storage/`，并在 `knowledge-vault/` 建立包含路径、大小和 SHA-256 的结构化索引；未进入明确引用闭包的原件不进入发布候选。无来源价值的派生文件、缓存、测试输出和临时文件必须删除。旧数据库中的知识文档行、chunk、embedding、向量索引、检索缓存和旧 `KnowledgeRelease` 均不迁移；新系统只从允许保留的源资产重建知识投影。

禁止未经明确授权向外部知识库同步项目对话、源文件或生成知识。

## 旧系统处置最终决定

用户已确认：新系统通过生产验收并切流后，旧系统彻底删除，不作为兼容对象、回退系统、灾难恢复系统或历史查询系统继续存在。开发期看到旧目录，只代表新系统尚未通过全部删除门禁，不代表目标架构需要双栈。

硬切后的最终状态必须同时满足：

- 仓库中删除旧 chat UI、旧 `Conversation/Message` 业务模块、旧 API controller/provider、Vercel AI SDK、旧 SWR 数据层、旧认证胶水及只服务旧链路的依赖和测试。
- 新生产发布物只包含 Web/BFF、Workbench API、Runtime Worker、File/Knowledge Worker、Export Worker、Preview 与 Quartz；入口、反向代理、Compose、镜像、环境变量和监控中不存在旧服务。
- 新生产数据库只执行 `packages/workbench-db` 的新基线与后续迁移，不创建、读取或保留旧业务表、旧 ID 映射、兼容视图、同步触发器和回填任务。
- 旧数据库、旧上传/解析/生成目录、旧 DeerFlow thread binding、旧模型配置、旧部署镜像和旧运行日志按删除清单物理销毁，不保留旧业务数据快照，也不提供切回旧版的开关。
- 唯一允许从旧环境进入新环境的既有业务资产，是本地 `knowledge-vault` 及其 Markdown 明确引用的 `storage` 文件；它们通过 allowlist、SHA-256 和引用闭包迁移，不携带原始对话或旧生成记录。

因此，后续设计评审不得以“兼容旧版”“以后可能切回”“先复用旧接口”作为新增复杂度的理由。除隔离、删除清单和最终残留审计外，旧系统不形成设计输入、接口依赖、兼容测试矩阵或单独开发工作包，也不再继续演进。

## 不可妥协项

1. 产品工作台新前端的布局、DOM 层级、计算样式、交互路径、动效和动画保持不变。品牌迁移允许选择器与技术标识成对原子改名，但不得改变任何样式值、Motion 参数或可见行为。
2. 不保留旧 API、旧表、旧 ID、旧聊天协议或兼容层。
3. 生产环境不得包含 mock、定时器假生成、假分享或假导出结果。
4. 每个概念只有一个事实源；所有持久修改具备并发和幂等语义。
5. 外部模型、DeerFlow、外部设计工具和编辑器的 ID 不得成为领域 ID。
6. 用户可见名称唯一为“产品工作台”；运行时代码只使用 `workbench` 技术标识。第三方产品名只能出现在明确的外部能力说明中。

## 目标拓扑

```text
Browser
  opaque HttpOnly session cookie
       |
Next Web + same-origin BFF
  Better Auth database session
  REST/OpenAPI 3.1 + streamed fetch proxy
       |
Workbench API (Nest modular monolith)
  Identity / Workspace / Project / Thread
  Run / SubmissionIntent / Artifact / Design Preset/System / Board / File / Knowledge
  Share / Export
       |
Runtime Worker          File/Knowledge Worker       Export Worker
  DeerFlow adapter       parse / scan / index         render / build / package
  model network          bounded file decoders        no outbound network
       |                       |                            |
PostgreSQL 16 + pgvector + durable PostgreSQL queue
S3-compatible object storage
isolated artifact-preview origin
```

大文件由 Browser 使用 File API 签发的 multipart URL 直传对象存储，不经过 BFF/API 复制字节；完成后由 Worker 从可信对象内容复核 SHA-256。BFF 只处理 OIDC session、CSRF、Bearer 注入和同源 REST/SSE 代理，不放业务规则；SSE 代理必须关闭 buffering/compression，配置长连接超时并原样透传 event id。浏览器只持有不透明 session id，provider token 由应用/KMS envelope encryption 后存于服务端技术表，不能依赖 Better Auth 默认 token 列明文存储。

首期不引入微服务、Kafka、Kubernetes、CRDT 或另一套通用 AI SDK。API 和三个 Worker 只共享纯合同/领域包，使用独立 image、进程、资源限制和部署健康检查；Chromium、Sharp、Docling 与代码构建依赖不能进入 Runtime Worker。

## 开源优先与自研边界

详细选型、许可证、免费边界和替换顺序见 `docs/workbench-open-source-reuse-strategy.md`。本节是必须遵守的架构摘要。

| 能力 | 采用 | 方式 |
|---|---|---|
| Node 模块格式 | Node 22 ESM + TypeScript NodeNext | 仅迁新 Workbench；不为 ESM-only 开源库维护 CommonJS 兼容胶水 |
| UI primitive | shadcn/ui、Radix、Sonner、Lucide；可搜索命令目录出现时再评估 cmdk | shadcn 可复制改造，其余按实际消费显式声明依赖；固定短命令列表不引入 cmdk |
| 无限画布 | React Flow | 直接依赖；只自研 Board/Artifact 映射和 CAS |
| 屏内元素选择与变换 | react-selecto + react-moveable | 先做 React 19/缩放/触控/IR round-trip PoC；只自研 PrototypeDocument command 和布局语义；因上游更新偏慢必须保留退出验证 |
| 图层/列表排序 | Atlassian Pragmatic Drag and Drop | 按需直接依赖；不自研拖拽传感器和键盘排序；dnd-kit 只作备选 |
| PRD 编辑 | Tiptap Core | 直接依赖；只自研 PRD schema、版本和引用 |
| 代码与 Diff | CodeMirror 6 + merge | 直接依赖 |
| 设计系统导入与投影 | Style Dictionary、Color.js、fontkit、unified + remark | `workbench.design-system.v1` 是唯一事实源；开源库只负责 token 投影、颜色运算、字体元数据和 Markdown AST，不接管领域 schema、版本、权限或导入回执 |
| 表格 | TanStack Table；表格式 Artifact 可条件评估 React Data Grid | 当前均未安装；出现真实表格需求时在消费 workspace 直接声明，并隔离第三方 API |
| 流式 Markdown | Streamdown、Shiki、Mermaid | 当前未安装；只有产品界面需要渲染不可信流式 Markdown 时才按隔离渲染合同接入 |
| 上传 | Uppy + signed multipart upload | headless 接入；暂停/继续/取消/listParts/retry 归 Uppy，只自研 FileAsset、服务端 UploadSession、幂等和可信摘要；Golden Retriever 只作小文件可选增强 |
| 服务端状态 | TanStack Query | 新 feature 的唯一 server cache |
| API client | openapi-typescript + openapi-fetch | 从生成的 OpenAPI 3.1 产生，不手写 DTO/URL |
| Run SSE | BFF streamed `fetch` + eventsource-parser | 不透明 session、Bearer 注入、cursor 重连和领域 reducer |
| 合同生成 | Zod + `@asteasolutions/zod-to-openapi` + Redocly/oasdiff | Zod/route registry 是唯一人工源；OpenAPI 是生成发布物和合并门禁 |
| 规范 JSON | canonicalize（RFC 8785/JCS） | 统一幂等与 Artifact 摘要输入；只自研 manifest 覆盖范围和算法版本 |
| OpenAPI 质量门 | Redocly CLI + oasdiff | 完整校验 3.1/`$ref` 并阻断未批准的破坏性变更 |
| 模块边界 | dependency-cruiser + ESLint restricted imports | CI 禁止新 Workbench 反向 import 旧 chat、AI SDK、SWR 和旧 API；第三方类型只进 adapter |
| 身份 | Better Auth 产品账号（username/password）+ database session；generic OAuth/Keycloak 仅作可选企业 SSO | 同源 BFF；浏览器不持有 access/refresh token；Better Auth 表不成为 Principal/Workspace 事实源 |
| 任务 | pg-boss | 与业务写入共用 PostgreSQL 事务 |
| Agent Runtime | DeerFlow 2.x + `@langchain/langgraph-sdk` | DeerFlow 是唯一生产 Runtime；官方 SDK 只承担 DeerFlow 的 LangGraph thread/run/stream/cancel transport，内部 RunEvent、commit fence 和结果归一化自研；LiteLLM 若未来采用，只能位于 DeerFlow 后方，Web/API 不得绕过 DeerFlow 调用模型 |
| 文档解析 | Docling Serve + file-type + yauzl + Sharp；libarchive 按需 | Docling 走独立容器；ZIP/Axure ZIP 用流式 yauzl，只有明确支持 tar/7z 时才启用隔离 libarchive；不扩建自写 parser/unzipper |
| 知识检索 | jieba-wasm + PostgreSQL FTS/pgvector + TEI | 一等 EmbeddingProfile，Qwen3-Embedding-0.6B 与 BGE-M3 过固定中文 benchmark 后二选一；reranker 独立。删除临时 `vector(1536)`，详见 `docs/workbench-knowledge-retrieval-architecture.md` |
| 文件直传 | Uppy `@uppy/aws-s3` + hash-wasm + AWS SDK v3 | multipart、断点恢复、浏览器增量摘要和 Worker 可信复核 |
| 预览与导出 | sandbox iframe、Playwright、docx、Babel AST、esbuild、archiver；Figma 使用固定产品工作台 Importer | 无外网 Export Worker + 独立 preview origin；React 从内部 RenderPlan 直出 AST/runtime data；ExportJob 产出版本化 `FigmaExportDocument`，固定 importer 通过官方 Plugin API 读取。`html-to-jsx-transform` 只可作为静态叶片，不成为语义或生产事实源 |
| 可观测性 | OpenTelemetry；模型追踪可接 Langfuse Core | 开放协议，产品不绑定观测厂商 |
| 日志与限流 | Pino/nestjs-pino、NGINX limit、Nest throttler | 结构化脱敏日志；边缘突发保护，业务配额仍在 PostgreSQL |
| 知识展示 | Quartz | 只读消费 immutable knowledge-vault；锁 commit/插件，不成为检索事实源 |
| 可视内容编辑 | 自有 PrototypeDocument renderer + Moveable/Selecto | 当前 IR 同时含 absolute/flow、vector、state、action、binding 和 motion；Puck/GrapesJS/Onlook 不能无损承载，因此只作条件候选或受控源码参考，不进入主编辑器事实源 |

shadcn 小组件可以复制修改；React Flow、Tiptap、Uppy 等复杂引擎必须以依赖方式使用，不复制源码。Docling、Keycloak 等重型能力通过标准协议隔离。完整应用中只有无上游数据库/API/store 依赖的最小模块允许登记 commit 和许可证后受控摘取；禁止 fork Dify、Open WebUI、LibreChat、Onlook、Bolt 或 Dyad 作为产品底座。

本项目只自研 Project/ProjectMember/ProjectRelease/Thread/Run/Artifact/Board/KnowledgeRelease、`ArtifactKind.design_system` 与 `DesignSystemImport` 领域规则、PrototypeDocument 与 command、DeerFlow adapter、事件状态机、权限与知识路由。通用菜单焦点、画布手势、元素框选/变换、编辑器、上传重试、SSE 拆帧、JSON canonicalization、OpenAPI 完整校验和文档解析不得重复实现。每个新功能开工前必须完成 `docs/workbench-open-source-reuse-strategy.md` 定义的 reuse check；无合格候选时才允许自研通用能力。

`@langchain/langgraph-sdk` 只是 DeerFlow transport，不是第二套 Runtime。Vercel AI SDK、`UIMessage`、`useChat`、SWR 和 AI Gateway 已从当前应用依赖图删除；架构门禁必须持续阻止它们重新进入 `(workbench)` 产品路由或最终生产发布物。

## AI Runtime 与第三方技术评估（历史决策记录）

本节中的“Google Stitch”仅指待选的外部供应商技术及其官方 SDK/MCP 名称，不是本产品品牌；任何用户可见产品名称仍统一为“产品工作台”，内部标识仍统一为 `workbench`。

- Vercel AI SDK 当前是 Apache-2.0，SDK 许可费为 0；本项目不采用它，不是因为收费，而是它的 provider runtime、`UIMessage` 和 `useChat` 会形成第二套消息、工具和模型合同。
- 不再用另一套通用 AI SDK 替换 Vercel AI SDK。浏览器只使用本项目的 OpenAPI、`fetch`、`eventsource-parser` 和 Run reducer；DeerFlow 是唯一 Agent/模型 Runtime，`@langchain/langgraph-sdk` 只负责 DeerFlow transport。只有出现统一配额、审计或多供应商故障切换的真实需求时，才允许把 LiteLLM 放在 DeerFlow 后方。
- 截至 2026-07-14，Google Stitch 的 `@google/stitch-sdk@0.3.5` 为 Apache-2.0，SDK 许可费为 0；直接 `StitchToolClient`/MCP 入口不依赖 Vercel AI SDK，只有可选的 `./ai` 适配入口面向 Vercel AI SDK。
- Google 官方 Gemini CLI 的 Google Stitch 扩展当前写明 Google Stitch MCP “free of charge”，但未公开固定数值配额、GA SLA 或永久免费承诺；生产接入必须处理 `RATE_LIMITED`、超时、熔断和降级。
- 第三方模型只可位于外层编排：经 DeerFlow 决定是否调用 Google Stitch 工具。Google Stitch 托管服务内部的 UI 生成模型由 Google 控制，不能替换为任意第三方模型。
- 因此 Google Stitch 不进入一期核心依赖，只能通过独立 adapter 作为二期设计工具；其外部 project/screen ID 不得成为本项目 Project、Artifact 或 Run 的领域 ID。

官方核验来源：[Google Stitch SDK](https://github.com/google-labs-code/stitch-sdk)、[Gemini CLI 的 Google Stitch 扩展定价说明](https://github.com/gemini-cli-extensions/stitch#pricing)、[Vercel AI SDK](https://github.com/vercel/ai)。

## 七项冻结门

在继续大规模接产品工作台 UI 前，必须冻结以下会改变长期合同的事项：

1. DeerFlow 生产 commit、镜像 digest、Gateway/LangGraph 合同和真实部署 E2E。
2. 实际 OIDC provider、Better Auth database session、KMS envelope encryption、登出与密钥轮换。
3. `EmbeddingProfile v1` 与 `RetrievalProfile v1` canonical 合同、独立向量表、维度/归属约束、query embedding/reranker adapter、capability tool、数据库状态机、KnowledgeRelease/manifest pin、Run/ArtifactVersion 经不可变 release 的传递 pin 和 readiness identity 对齐均已形成。仍须用固定中文检索评测集选定真实 embedding/reranker model revision、权重摘要与生产 TEI image digest，未过门禁前不得建立 production adopted profile。
4. Prototype v1 已将 rotation/transform origin 定为必填结构化字段；编辑器与 HTML/React/Figma/MCP 必须保持同一父局部角度、border-box 原点和嵌套坐标语义，禁止 CSS 字符串旁路或旧字段默认值。
5. v1 Preview 只执行受控 IR renderer，不执行任意生成 React/JS；任意代码执行是单独安全项目。
6. React 的 `PrototypeDocument -> RenderPlan -> AST/runtime data` 与 Figma 的 `FigmaExportDocument -> official Plugin API importer`。
7. 硬切环境的真实 S3 provider、IAM、私网 endpoint 和 multipart/崩溃恢复 E2E；MinIO 未被明确选为生产部署时只作测试夹具。

## 领域事实源

| 概念 | 事实源与约束 |
|---|---|
| Workspace | 租户、成员和角色 |
| Project | 用户看到的项目与授权边界 |
| ProjectMember | 项目级成员、邀请和角色；与公开 token 分享分离 |
| Thread | 项目内独立上下文；首期每个 Thread 只能有一个活动 Run |
| ThreadEntry | 持久交互记录，`UNIQUE(thread_id, sequence)` |
| SubmissionIntent | 当前 Principal 在一个 Thread 中至多一个活动提交；持久保存 typed Run request、有序既有附件/上传槽位、槽位绑定、失败与 CAS revision，刷新恢复只重放同一 Run 幂等键 |
| Run | 一次不可变执行尝试，`UNIQUE(thread_id, idempotency_key)` |
| RuntimeAttempt | 一次本地到 DeerFlow 的外部执行绑定；固定 adapter、externalThreadId、externalRunId、attempt 和 checkpoint，Worker 重放只能 join 已创建的外部 Run |
| RunEvent | 先持久化后发布，`UNIQUE(run_id, sequence)` |
| RunDraft | 节流后的临时流式快照，不逐 token 落库 |
| ArtifactVersion | 不可变长期产物；回滚只切换 `currentVersionId` |
| `ArtifactKind.design_system` | 一等 Artifact；不可变版本内容固定为 `workbench.design-system.v1`，与 PRD、Prototype、Code 等产物共用版本、权限、校验、发布和资产 pin 语义 |
| DesignPreset | 服务端权威的版本化内置目录；客户端只提交 `presetId + version + checksum`，Run 固化 materialized snapshot 与独立 snapshot hash，不把 UI 常量当事实源 |
| DesignSystemImport | 同 Workspace 跨 Project 的不可变导入回执；目标 Project/Artifact/ArtifactVersion 使用强外键，来源 Project/Artifact/ArtifactVersion ID 与 checksum 只保存审计快照，不形成可漂移的跨项目引用 |
| Board | 只保存布局和钉住的 `artifactId + artifactVersionId` |
| ProjectRelease | 项目级不可变 manifest，固定 Board revision、ArtifactVersion、Asset 和 schema 版本，供分享、重混和项目级导出使用 |
| Blob | SHA-256 内容寻址的二进制事实源 |
| KnowledgeRelease | Vault 与引用资产形成的不可变知识发布包 |
| RetrievalProfile | `workbench.retrieval-profile.v1` canonical 合同固定 embedding、Jieba、RRF、reranker、routing 与 citation 身份；独立状态机和五列复合外键保证 RetrievalProfile、EmbeddingProfile、KnowledgeRelease 不漂移，Run/ArtifactVersion 经不可变 release 保留完整来源 |
| KnowledgeToolBudget | 每个 RuntimeAttempt 一份不可变策略与持久计数；默认最多 12 次成功、2 个并发、60 秒内 12 次启动、每个 invocation 3 次尝试、总计 36 次启动 |
| KnowledgeToolGrant | 持久保存 grant/Run/RuntimeAttempt/Principal/Project/Release scope、payload SHA-256、`issuedAt`/`expiresAt` 与撤销时间；原始 `wbkg1` token 只在 Worker 内生成和传递，不入库 |
| KnowledgeRetrievalInvocation | `UNIQUE(runtime_attempt_id, invocation_id)`；固定 query SHA-256、attempt、lease、终态响应及摘要，作为 `Idempotency-Key` 回放和调用配额的事实源 |

数据库投影、搜索向量和知识 chunk 均可从权威源重建。

## Run 协议

```http
POST /api/v1/threads/:threadId/submission-intents
GET  /api/v1/threads/:threadId/submission-intents/current
GET  /api/v1/submission-intents/:intentId
POST /api/v1/submission-intents/:intentId/submit
DELETE /api/v1/submission-intents/:intentId
GET  /api/v1/threads/:threadId/runs
GET  /api/v1/runs/:runId
GET  /api/v1/runs/:runId/events?afterSequence=N
POST /api/v1/runs/:runId/cancel
POST /api/v1/runs/:runId/retry
POST /api/v1/runs/:runId/approvals/:approvalId
```

- 新建 Run 的唯一公开入口是 SubmissionIntent；API 不暴露 direct `POST /threads/:threadId/runs`。Web 必须先创建 Intent，再按有序 slot 原子绑定上传，全部 File ready 后提交；刷新后对 `verifying` 自动轮询，对未绑定/`uploading` slot 要求按原始元数据重选，对 ready 或持久 `submitting` 只重放同一服务端 Run 幂等键。
- SubmissionIntent slot 使用独立 `submission-file:<opaque>` 指纹；multipart create/complete/extract 幂等键由 `intentId + position` 确定，不能复用包含 URL 编码文件名的浏览器 checkpoint fingerprint。Intent 绑定的单文件不允许脱离整单取消，以免留下不可换绑的中止槽位。
- 创建 Run 的事务同时写入用户 Entry、Run、首个 RunEvent 和 durable job。
- Runtime Worker 使用 LangGraph SDK 创建外部 Run 时，必须通过 `onRunCreated` 在继续消费流前持久化 RuntimeAttempt/externalRunId；初始非幂等 POST 自动重试关闭，Worker 重放只允许 join 既有 externalRunId，不能再次 POST 新 Run。
- Run 必须保存规范化 typed options：`modelId` 只表示 DeerFlow 可用的真实模型；Redesign/Ideate 是 workflow/intent，App/Web 是 target surface，Style/设计系统引用是独立字段；这些字段与附件、目标产物一起进入幂等摘要和审计，禁止塞进任意 JSON 或伪装成模型 ID。
- SSE `id` 等于事件 sequence，支持 `Last-Event-ID` 和 `afterSequence`。
- 交付语义为 at-least-once，客户端按 sequence 去重并检测跳号。
- 浏览器断线只关闭订阅，不取消 Run。
- 取消先撤销本地产物提交资格，再调用 LangGraph SDK cancel 外部 Run；外部取消失败进入可重试 reconciliation，迟到结果仍不得发布产物。
- 重试只接受源 Run ID 与 `Idempotency-Key`；服务端仅允许 `failed + retryable` 源，从其持久 `StartRunRequest` 创建新 Run，并以同线程外键和不可变 `retryOfRunId` 记录 lineage。前端不得重组 prompt、模型、附件或 options。
- 不保存或发送隐藏推理、供应商原始 packet 和大块 Artifact 正文。

## 设计系统导入与运行时物化

设计系统不是 Composer 的临时字符串，也不是另一个 Project 的动态引用。`ArtifactKind.design_system` 的版本内容使用 `workbench.design-system.v1`，至少包含 `documentId`、`title`、`tokens`、`assets`、`principles`、`guidelines`、`components`，其中组件继续包含 variants、states 和 usage。发布为 ready 版本前必须校验 ID 与 token path 唯一、所有引用可解析、token alias 无环，以及每个资产均钉住受权的 Asset/Blob 版本。

同 Workspace 复用只提供一个 command：挂载于 `/api/v1` 的 `POST /projects/{targetProjectId}/design-system-imports`，body 为 `{ sourceArtifactVersionId }`，并要求 `Idempotency-Key`。服务端必须同时验证来源 Project 的 read 权限、目标 Project 的 edit 权限、两者 Workspace 相同、来源 kind/schema/status 合法；成功后在目标 Project 创建独立 `design_system` ArtifactVersion 与不可变 `DesignSystemImport` receipt，不能建立随来源更新的 live link。Receipt 固定：

- `targetProjectId`、`targetArtifactId`、`targetArtifactVersionId` 强外键；
- `sourceProjectId`、`sourceArtifactId`、`sourceArtifactVersionId` 与 `sourceChecksum` 审计快照；
- `createdById`、`idempotencyKey`、`requestHash`、`createdAt`。

相同目标、幂等键与请求必须返回同一 receipt；幂等键复用于不同请求返回冲突。v1 不允许跨 Workspace 直接 import，未来跨 Workspace 分发只能基于明确授权的不可变 Release/Share 合同。

Run 只接受目标 Project 内 ready 的设计系统 ArtifactVersion。API 从该固定版本和资产 pins 确定性生成 `RuntimeDesignStyleSnapshot`，解析 alias 并物化 Runtime 所需的 token、原则、指南、组件用法和受权资产引用；快照随 Run 请求摘要和审计固定，由 DeerFlow adapter 消费，Runtime 不查询来源 Project、不读取 Style Dictionary 配置，也不持有第三方库类型。

内置 preset 同样不允许由 Web 常量定义。`GET /api/v1/design-presets` 返回权威 `presetId/version/checksum`、标签、色板、说明、directives 与 tokens；Run 只接受 catalog 中精确匹配的三元组，并持久化 canonical materialized snapshot 和 snapshot hash。Worker 只消费 Run snapshot，不在执行期重新查询 catalog，也不把 preset 伪装成 Design System Artifact。

## HTTP 契约

- REST 从 `/api/v1` 开始。Zod schema + route registry 是唯一人工维护合同，OpenAPI 3.1 由它确定性生成并作为对外发布合同；生成 YAML 禁止手改。
- Route registry、生成的 current OpenAPI、批准 baseline、Web 类型和 Nest route 双向覆盖必须保持同步。Design preset catalog 与 thread-scoped SubmissionIntent 已取代旧 preset 形状、project-scoped current route 和可绕过持久提交合同的 direct Run POST；Run preset 引用使用 `presetId + version + checksum`，上传创建体支持严格 slot binding。项目读取采用跨 Workspace 的 `GET /projects`，只返回当前 Principal 具有显式 ProjectMember 的项目；项目创建使用 `POST /workspaces/{workspaceId}/projects`。
- Redocly 校验、oasdiff breaking-change 检查、生成物无差异检查必须同时通过；自有脚本只保留幂等、ETag、SSE 等产品语义断言。
- Nest controller 从同一 registry 引用 method/path 常量；集成测试枚举实际注册路由并与 OpenAPI path set 双向比较，不能只保证 schema 字段一致。
- POST command 使用 `Idempotency-Key`。
- 修改使用 `ETag/If-Match`；版本过期返回 412，缺少前置条件返回 428。
- 领域冲突返回 409。
- 错误统一为 RFC 9457 `application/problem+json`，客户端只解析稳定 `code`。
- Web API 类型从契约生成，不手写一套重复 DTO。

## 知识发布

知识发布只读取允许保留的 `knowledge-vault` 与其 Markdown 明确引用的 `storage` 文件，不导入旧数据库知识行、chunk、embedding、向量索引、检索缓存或旧 `KnowledgeRelease`。

1. 校验 Vault frontmatter、链接、层级和资产引用。
2. 生成包含路径、SHA-256、路由和引用闭包的不可变 manifest。
3. Markdown 按 AST/标题结构分块；文件通过 worker 提取结构化文本。
4. `00-06` 进入生产检索，`07` 只用于来源查询，`99` 排除或隔离。
5. 中文文本使用固定版本的 `jieba-wasm` 分词写入 PostgreSQL simple FTS，并与 pgvector 混合召回；分词模式、默认词典、自定义词典和停用词摘要进入 KnowledgeRelease。
6. 每个 Run 固定 `KnowledgeRelease`，每个 ArtifactVersion 固化 citation。
7. Runtime 只通过 `POST /api/v1/runtime/knowledge/retrieve` 使用知识：短时 HMAC capability 固定 Run、RuntimeAttempt、Principal、Project、Release、`hybrid + production` scope；普通 OIDC 用户没有同义兼容入口。
8. 每个有 Knowledge pin 的 RuntimeAttempt 先持久化 budget 和 grant，再生成含 `iat/exp` 的短时 `wbkg1` token；每次 retrieve 必须携带稳定 `Idempotency-Key`，DeerFlow 可信工具客户端从 `tool_call_id` 生成域分离摘要，不能仅按 query 合并两个独立调用。API 以持久 invocation receipt 预留、限并发、限速、结算或回放，默认预算为 12 次成功、2 个并发、60 秒 12 次启动、单 invocation 3 次尝试、总计 36 次启动。
9. API 在 provider 调用前后都重新校验当前成员关系、Run/attempt 状态和 release pin；授权在 provider 返回前失效时丢弃结果，query embedding 失败返回脱敏 503，reranker 失败只按固定策略降级到 RRF，provider 原始正文、凭据和 capability token 不得进入响应、日志或最终 Artifact。
10. API readiness 对每个 ready release，以及仍被非终态 Run pin 的 retired release，复用 retrieve 的同一 manifest/profile/Jieba 校验器并探测固定 TEI identity；Runtime Worker 在这些 release 存在而 capability 未配置时必须 not ready。没有可服务 release 时允许空 provider 配置启动。

同一知识不得同时在 Vault 和数据库里独立编辑。

## 分阶段交付与验收门

### 1. Foundation

- 独立 contracts、数据库、API、Next BFF、Runtime Worker、File/Knowledge Worker、Export Worker 和 preview app。
- 新 Workbench server package 统一 Node 22 ESM/NodeNext；旧应用不跟迁。
- Zod route registry 确定性生成 OpenAPI 3.1；Nest controller 使用同一 method/path 常量，CI 比较实际路由集合与 OpenAPI，消除 route 漂移。
- RFC 9457、request/trace ID、Better Auth database session/OIDC、liveness/readiness。
- PostgreSQL 16 + pgvector、对象存储、durable queue 的开发部署。
- dependency-cruiser/ESLint CI 守卫禁止新应用 import 旧 chat、AI SDK、SWR 和旧 API。

验收：全新数据库可一键迁移；新 API 不依赖旧 Prisma client 或 AI SDK；OpenAPI 无手写副本；浏览器 storage/cookie 中不存在 access/refresh token；Runtime、File/Knowledge、Export 三个 Worker 的镜像、网络和资源权限互相隔离。

### 2. Core domain

- Workspace/Member/Project/Thread/ThreadEntry。
- 项目列表、创建、工作台 bootstrap、权限、游标分页、ETag。
- Board revision/CAS 和节点版本钉住。

验收：并发更新、越权和分页均由真实 PostgreSQL 集成测试证明。

### 3. Durable Run

- API 原子创建、Worker claim/lease、RunEvent 持久序列、SSE 重放。
- DeerFlow RuntimePort、LangGraph SDK transport、RuntimeAttempt/externalRunId checkpoint、join 重放、外部取消、审批、失败重试和 commit fence。

验收：断线、重连、初始 POST 响应丢失、重复命令、多 Worker 抢占、取消竞态和进程重启测试通过；任何本地 Run attempt 最多绑定一个 externalRunId，重放不创建第二个 DeerFlow Run。

### 4. Knowledge and files

- immutable KnowledgeRelease、FTS/pgvector、引用。
- 按 `docs/workbench-knowledge-retrieval-architecture.md` 实现 EmbeddingProfile、独立 chunk embedding 表、可恢复 TEI batch、Jieba FTS + dense RRF + 独立 reranker 和 citation-ready DeerFlow tool grant。
- Uppy signed multipart upload、浏览器增量 SHA-256、对象字节可信复核、MIME、扫描、yauzl 流式 ZIP 解包、Docling Serve/Sharp 解析、按需隔离 libarchive、衍生物和延迟 GC。
- Quartz 锁定 commit/插件，只读构建 immutable `knowledge-vault` 展示站；静态输出可删除重建，不参与检索事实源。

验收：`knowledge-vault` 发布层与其明确引用的 `storage` 资产形成路径、大小和 SHA-256 闭包；未引用资产不进入发布候选，检索固定题集不串层。

### 5. Artifact and delivery

- PRD structured JSON、PrototypeManifest、不可变版本、验证和发布。
- `ArtifactKind.design_system`、`workbench.design-system.v1` 校验、同 Workspace import command/receipt、资产 pin 与 `RuntimeDesignStyleSnapshot` 物化。
- PrototypeManifest 采用项目自有、框架无关的内部 IR；React Flow、GrapesJS/Puck、HTML、React 和 Figma 均只能作为 adapter。
- ProjectRelease 固定 Board/Artifact/Asset manifest；独立 preview origin、版本固定分享/重混、异步 DOCX/PDF/HTML/React/Figma 导出和 MCP Artifact resource 统一消费不可变版本；Export Worker 无外网、预装固定 allowlist 依赖并禁用 lifecycle script。

验收：版本回滚不修改历史，分享不漂移，预览不能访问主站 Cookie；四种可见导出目标均产生可打开、可构建或可导入的真实结果。

### 6. Frontend integration

- 当前页面架构是持久 `app/(workbench)/layout.tsx` -> `WorkbenchRuntimeProvider` -> `WorkbenchScene`。`app/(workbench)/page.tsx` 与 `app/(workbench)/projects/[projectId]/page.tsx` 只拥有 URL，均返回 `null`，不再各自挂载一套 Home/Project UI。`WorkbenchScene` 内唯一的页面级 `AnimatePresence mode="sync"` 同时拥有 Home/Project 过渡，避免 Next route tree 与动画树形成双 owner。
- Project route 经 fulfilled-module cache 按需加载；路由 commit 发生前先完成 module preload，避免 Suspense 空白帧。Home/Project route root 通过稳定 `onUpdate` 订阅仅关闭根 opacity 的 WAAPI accelerated path，规避 Framer 11.18.2 动画收尾时回落 initial 值的一帧空白；原 DOM、CSS、`initial/animate/exit`、duration、ease 和动画时序均未改变，Framer 升级必须重跑三浏览器逐帧门禁。Project 组件固定使用 `key="project"`，P1 -> P2 只切换 project-scoped session generation，并提交规范 `/projects/p2` URL，不重挂载 Project、header 或 React Flow；禁止 `key={projectId}` 及任何等价的按项目 ID remount。NavigationGuard 已在 Chromium、Firefox、WebKit 证明切换期间 Scene 非空、被拒绝的 Back 不闪 Home，且 Project root/header/React Flow DOM identity 保持。
- Board node types/renderers、四组 edit context、Run 面板、画布工具、项目 chrome、预览覆盖层、重命名对话框、ProjectScreen View，以及 Composer/Preview/Board intent controller 均有独立 owner。迁移没有修改 DOM、class、尺寸、事件顺序或 Motion 参数。`artifacts`、`board`、`canvas-media`、`design-presets`、`design-systems`、`exports`、`files`、`identity`、`projects`、`public-shares`、`releases`、`runtime-models`、`runs`、`shares`、`submission-intents`、`threads` 共 16 个 feature 已进入强制 `domain/application/api-adapter` 分层；聚合 `WorkbenchService`、旧顶层 Projects 路径和 `transport.service` 已删除，静态门禁禁止恢复。
- 每个 feature 分离 `ui`、`application`、`domain`、`api-adapter`；产品工作台视觉叶组件只接收 props/ViewModel，禁止发请求、持有跨 feature 领域状态机或处理持久化。跨 feature 依赖只能经过公开入口，禁止 deep import、聚合 Service、service locator 或兼容 facade。dependency-cruiser 必须持续强制 feature 公开入口和层次边界，实际模块数量与违规数以当前门禁输出为准。
- 产品入口已经完全归属 `(workbench)` route group，旧 `(chat)` route 和只服务旧页面/admin 的 Chat、Nest auth、AI SDK、SWR 代码已在硬切前物理删除；登录/注册只依赖 `components/auth` 与 `lib/auth/workbench-auth*`。
- Project/Thread/Artifact 使用 TanStack Query。
- Run 使用同源 BFF `fetch` + eventsource-parser + 局部 reducer；Board 使用 Zustand/局部 store；导航使用 URL。
- 菜单、弹层、Switch 和 Tooltip 复用现有 Radix primitive；固定短命令列表保留现有产品工作台菜单组件，只有出现可搜索命令目录时才评估 `cmdk`。
- 文件上传使用 `@uppy/core`/`@uppy/aws-s3`，暂停/取消/listParts/retry 不再在产品 wrapper 中重写；浏览器 hash 移入 Web Worker，服务端 UploadSession/ETag/幂等仍是恢复事实源；PRD 使用 Tiptap StarterKit、官方 Table/Link 和项目自有 12 类 block/citation/reference 扩展，Tiptap JSON 不入库；PRD/代码版本比较使用确定性文本投影与 CodeMirror merge；不继续扩建手写 ProseMirror、结构 Diff 和上传 transport。
- Board 上的 Screen/Frame 放置与分组使用 React Flow；屏幕内部元素框选、移动、缩放、旋转和吸附优先使用 react-selecto/react-moveable，并以同一 IR fixture 验证上游停更时的退出实现；接 rotation 手柄前先让 Prototype IR、renderer 与全部 exporter 可表达同一 rotation/transform origin。Draw 使用 perfect-freehand；Media 使用 Uppy/crop；Style 写入内部 design token；Undo/Redo 使用 temporal store 并服从 Board revision。Puck/GrapesJS/Onlook 不作为当前 PrototypeDocument 内核。
- 明确 React Flow 与 Moveable/Selecto 的坐标、选择、焦点、快捷键和手势所有权；`Frame` 在合同中区分 Board 分组与 Prototype 容器，进入内部编辑态时暂停冲突的 Board 手势。
- 复制、删除、重命名、预览刷新、屏幕收藏/赞踩、Composer 刷新、公开分享/撤销/重混、Figma/HTML/React/MCP 导出全部连接真实 command/job，不保留空处理；审批单选使用 Radix RadioGroup，不手写键盘状态机。
- “添加屏幕截图”若表示实时抓屏，使用浏览器 `getDisplayMedia`/ImageCapture 明确授权后交给 Uppy；若只允许上传文件，则改成准确文案。项目预览必须经独立 preview origin + token + Penpal，主站覆盖层只做焦点与多屏编排。
- Home 的“以您的设计为基础”必须在目标 Project 创建后调用 design-system import command，并用 receipt 的目标 ArtifactVersion 提交 Run；“自定义设计”用结构化表单创建/编辑目标 Project 自己的 `design_system` Artifact，不能伪装成 `automatic`，也不在 v1 另造完整 Figma 式编辑器。Project Style 菜单只列 automatic、preset 和当前 Project 内 ready 的设计系统版本；跨 Project 选择必须先 import，不直接引用来源版本。
- “与我共享”连接 ProjectMember/邀请查询；公开分享、重混和项目级导出统一固定到不可变 ProjectRelease，不从浮动 Project 当前状态临时拼装。
- Docs、帮助、反馈、Gift/公告等所有可见入口必须有明确 URL、权限和真实动作；接第三方 helpdesk/issue 服务前需单独授权，不能外发项目数据。
- 删除 setTimeout 假生成、mockAttachment、假分享和假导出。

验收：`docs/workbench-visual-baseline.md` 的完整状态矩阵和所有业务 E2E 通过；Playwright golden 按 viewport/state 版本化入库，覆盖桌面/移动、菜单/弹层、生成中/失败/恢复、画布编辑和 reduced-motion，CI 像素差异必须经显式批准。

### 7. Hard cut

- 生产前门禁是新 Web/API/Worker/preview、身份、知识、文件与导出生产 E2E 全部通过；门禁前旧目录只是隔离施工区，不是目标架构的一部分。
- 门禁通过后切换 Web/API/Worker/preview 入口，并永久禁止旧链路写入；不双写、不读旧业务表、不迁移旧对话，也不存在重新开启旧写入或回退旧后台的开关。
- 切流后立即验证新链路核心读写，然后执行不可逆删除；观察期只观察新系统，不能把旧系统作为故障回退方案。只有旧系统残留扫描为零后，才宣布硬切完成。
- 唯一保留并导入新系统的既有数据是本地 `knowledge-vault`，以及其 Markdown 经路径校验和 allowlist 明确引用的 `storage` 文件；不得按目录整体保留。
- 不导入或保留旧数据库中的知识文档行、chunk、embedding、向量索引、检索缓存或旧 `KnowledgeRelease`；所有知识投影由允许保留的源资产重新生成。
- 不制作旧业务数据库、旧对话或旧生成产物的上线回滚快照；切流后的故障只允许在新系统上修复，或回滚新系统代码/新 schema 迁移，不允许恢复旧版处理业务。
- 删除范围包括只服务旧链路的前后端源码与测试、API、schema/表/视图/队列、数据库实例及备份快照、对象存储非知识 allowlist 数据及历史版本、卷与上传/解析/生成目录、DeerFlow binding/配置、部署服务/容器/镜像/制品、环境变量/secrets，以及日志/trace/metric 及其归档。
- 删除动作必须输出可审计 manifest：仓库预切流基线 `docs/workbench-hard-cut-deletion-manifest.json` 已升级为 v3，覆盖数据库/备份、对象前缀与历史版本、容器/镜像/制品、卷、网络、密钥、日志/trace/metric 和删除回执。切流前运行 `npm run hard-cut:manifest` 时各生产删除项保持 `pending` 是正确状态；G12 只允许通过受保护的 `.github/workflows/workbench-production-acceptance.yml` 执行：从同一已验证 release chain 下载无凭证 HTTPS 外部证据包，验证 G5-G11、四方批准和候选绑定，再在临时 evidence root 运行 `node scripts/workbench-hard-cut-manifest.mjs --enforce --expected-candidate-id <G1-candidate-id> --expected-source-commit <G0-G2-source-commit> --expected-signed-tag <signed-tag>`。三个 expected 值不能从 manifest 自身回填。仅隐藏旧导航、NGINX 入口或停止容器不算完成。

## 当前执行与验收

本文件只保留稳定目标架构、阶段边界和硬切原则，不维护完成清单、历史测试计数或工时快照。当前整改范围与状态只以 `docs/CODEX-WORKBENCH-FUNCTIONAL-VISUAL-REMEDIATION-SPEC-20260727.md` 和 `docs/CODEX-RUNTIME-DATABASE-REMEDIATION-SPEC-20260723.md` 为准。

可执行验收合同位于 `docs/runbooks/`、`docs/evidence/`、`schemas/` 和 `docs/workbench-hard-cut-deletion-manifest.json`。任何 PASS 必须来自同一候选的实际命令与证据，不能由本架构文件中的描述推导。
