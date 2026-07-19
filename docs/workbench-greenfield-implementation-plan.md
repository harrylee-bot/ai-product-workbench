# 产品工作台绿地重建与全量接入实施方案

更新日期：2026-07-16

## 结论

本项目不再把新前端接入旧 `Conversation/Message/AI SDK` 后台，而是建设独立的新产品后台。开发期新旧应用只作为隔离施工区并存，不转发、不双写、不迁移旧业务数据；新链路验收完成后硬切并删除旧后台。

截至 2026-07-16，绿地合同、数据库、API、三个独立 Worker、BFF、Board、Artifact/Release、隔离 Preview、导出、Prototype v1 和受限 Knowledge retrieval 主链已经形成；它已不是“把一套新皮肤接到旧接口”的工作。前端入口已经收口为持久 `(workbench)` layout -> `WorkbenchRuntimeProvider` -> `WorkbenchScene`：Next Home 与 Project page 只承担 URL，组件本身返回 `null`；唯一负责 Home/Project 页面切换的 `AnimatePresence mode="sync"` 位于持久 Scene 内。Project 通过 fulfilled-module cache 动态拆包，P1 -> P2 始终使用 `key="project"`，不会按项目 ID 重挂载；真实 NavigationGuard 已证明 Project root、header 与 React Flow DOM identity 在切换后保持不变，任何 `key={projectId}` 写法都被禁止。项目 URL 已固定为 `/projects/[projectId]`，登录/注册也已使用独立 `components/auth` 与 Better Auth。项目邀请已与 Workspace membership 隔离，Run SSE 会持续复核授权，取消竞态使用数据库 CAS，PRD 编辑使用稳定 Section/Block ID，Viewer Preview 已与 Release/Export 解耦。Design preset 已改为服务端权威、版本化 catalog，并在 Run 中保存不可变 snapshot/hash；SubmissionIntent 已把 prompt、typed Run options、既有附件和有序上传槽位持久化，支持刷新后续传、重选、幂等提交和整单取消。领域与数据底座已有 16 个 feature 进入强制分层，聚合 `WorkbenchService` 与 `transport.service` 已物理删除，每个数据 feature 直接拥有 typed API adapter。当前 dependency-cruiser 快照为 432 modules / 1,403 dependencies / 0 violations，前端 route ownership、动态拆包和跨项目会话隔离均已有静态与浏览器门禁，不再列作待拆结构债务。生产硬切仍受真实 OIDC/KMS、S3/ClamAV、DeerFlow、已评测并 adopted 的 embedding/reranker、双 HTTPS origin、真实 OTLP collector、Docker 镜像、Figma Desktop 和全服务网络验收约束。

按 2026-07-16 当前落盘状态重新核算，项目邀请隔离、连续 SSE 授权、Run 取消竞态、PRD 稳定投影、Viewer Preview、页面级上传控制、SubmissionIntent 完整提交恢复、权威 Design preset catalog、Knowledge Profile 治理、正式 Figma importer、ExportJob 恢复、硬切 manifest v2、OpenTelemetry 仓库接线、持久 Scene route ownership、Project 动态拆包、跨项目状态隔离，以及前端聚合 Service 的彻底移除均已完成，不再作为剩余工时重复计费。Web 全量 **144 files / 616 tests**、OpenAPI **79 paths / 97 operations**、根 `npm test`、typecheck、生产 build、bundle、品牌、浏览器上传部署、安全响应头和统一 `e2e:web` 门禁均已通过。从当前快照到“在真实生产外部依赖上完成验收并硬切”的 bottom-up 剩余量统一为 **26-48 人日**。这个数字不含旧接口兼容、旧对话迁移、双写或旧版维护；真实账号、模型、证书、S3/IAM 和部署审批的等待时间不计入人日，但会延长日历周期。

唯一从旧环境继承的业务资产是：

- `knowledge-vault`
- 由 `knowledge-vault` Markdown 经路径校验、allowlist、SHA-256 和引用闭包明确引用的 `storage` 文件

不得按目录整体保留 `storage`：未被 Markdown 明确引用的文件，即使位于 `storage/source-assets` 或 `storage/imports`，也必须删除。旧数据库中的知识文档行、chunk、embedding、向量索引、检索缓存和旧 `KnowledgeRelease` 均不迁移；新系统只从上述允许保留的源资产重建知识投影。

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
| UI primitive | shadcn/ui、Radix、cmdk、Sonner、Lucide | shadcn 可复制改造，其余作为依赖 |
| 无限画布 | React Flow | 直接依赖；只自研 Board/Artifact 映射和 CAS |
| 屏内元素选择与变换 | react-selecto + react-moveable | 先做 React 19/缩放/触控/IR round-trip PoC；只自研 PrototypeDocument command 和布局语义；因上游更新偏慢必须保留退出验证 |
| 图层/列表排序 | Atlassian Pragmatic Drag and Drop | 按需直接依赖；不自研拖拽传感器和键盘排序；dnd-kit 只作备选 |
| PRD 编辑 | Tiptap Core | 直接依赖；只自研 PRD schema、版本和引用 |
| 代码与 Diff | CodeMirror 6 + merge | 直接依赖 |
| 设计系统导入与投影 | Style Dictionary、Color.js、fontkit、unified + remark | `workbench.design-system.v1` 是唯一事实源；开源库只负责 token 投影、颜色运算、字体元数据和 Markdown AST，不接管领域 schema、版本、权限或导入回执 |
| 表格 | TanStack Table；表格式 Artifact 保留 React Data Grid | 直接依赖并隔离 beta API |
| 流式 Markdown | Streamdown、Shiki、Mermaid | 直接依赖 |
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

`@langchain/langgraph-sdk` 只是 DeerFlow transport，不是第二套 Runtime。Vercel AI SDK、`UIMessage`、`useChat`、SWR 和 AI Gateway 不进入 `(workbench)` 产品路由的依赖图；它们目前仍存在于隔离旧代码和 Web package manifest 中，必须在硬切删除门清零后，才能宣称不再进入最终生产发布物。

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
- 当前 route registry 与已刷新 baseline 同为 79 个 resource path、97 个 HTTP operation；上一批准基线为 71/89。新增 Design preset catalog 与 5 个 thread-scoped SubmissionIntent operation，删除可绕过持久提交合同的 direct Run POST；Run preset 引用直接升级为 `presetId + version + checksum`，上传创建体增加可选严格 slot binding。旧 project-scoped current route、旧 preset 形状和 direct Run 创建路由均不保留。项目读取仍采用跨 Workspace 的 `GET /projects`，只返回当前 Principal 具有显式 ProjectMember 的项目；项目创建仍为 `POST /workspaces/{workspaceId}/projects`。这些破坏性变更已按绿地无兼容层决策完成审查，current OpenAPI、Web 类型、Nest route 双向覆盖和 baseline 已同步。
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

验收：当前 85 个 Markdown 及引用资产校验和闭包一致；检索固定题集不串层。

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
- 每个 feature 分离 `ui`、`application`、`domain`、`api-adapter`；产品工作台视觉叶组件只接收 props/ViewModel，禁止发请求、持有跨 feature 领域状态机或处理持久化。跨 feature 依赖只能经过公开入口，禁止 deep import、聚合 Service、service locator 或兼容 facade。当前 dependency-cruiser 对 432 modules / 1,403 dependencies 检查为 0 violations，并强制 16 个 feature 的公开入口和层次边界。
- 产品入口已经完全归属 `(workbench)` route group，旧 `(chat)` route 和只服务旧页面/admin 的 Chat、Nest auth、AI SDK、SWR 代码已在硬切前物理删除；登录/注册只依赖 `components/auth` 与 `lib/auth/workbench-auth*`。
- Project/Thread/Artifact 使用 TanStack Query。
- Run 使用同源 BFF `fetch` + eventsource-parser + 局部 reducer；Board 使用 Zustand/局部 store；导航使用 URL。
- 菜单、弹层、Switch、Tooltip 和命令面板复用现有 Radix/cmdk primitive，只保留产品工作台视觉叶组件。
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
- 删除动作必须输出可审计 manifest：仓库预切流基线 `docs/workbench-hard-cut-deletion-manifest.json` 已升级为 v2，覆盖数据库/备份、对象前缀与历史版本、容器/镜像/制品、卷、网络、密钥、日志/trace/metric 和删除回执。切流前运行 `npm run hard-cut:manifest` 时各生产删除项保持 `pending` 是正确状态；只有生产验收、切流和物理删除完成后，才运行 `node scripts/workbench-hard-cut-manifest.mjs --enforce` 并逐项写入删除前计数、删除结果和残留扫描回执。仅隐藏旧导航、NGINX 入口或停止容器不算完成。

## 当前施工状态

- [x] 完成旧系统与新前端只读审计。
- [x] 固化首批视觉截图、状态矩阵和源文件哈希。
- [x] 新建 `packages/workbench-contracts`。
- [x] 新建独立 `packages/workbench-db` 与首个基线迁移。
- [x] 新建 `apps/workbench-api`，包含 `/api/v1`、OIDC 边界、RFC 9457、健康检查。
- [x] 实现 Project 列表、创建、更新和 bootstrap 第一切片。
- [x] 完成 ProjectMember 显式角色与权限、`q + cursor` 和 owned/shared 搜索、私有 duplicate、CAS archive、active lifecycle fence、归档后 preview 失效；真实 PostgreSQL 覆盖撤权/撤销竞态、幂等竞争和不可变快照。
- [x] 完成 Project invitation 的 create/list/preview/accept/revoke 合同、项目 revision CAS、幂等创建、pending 唯一约束、HMAC key rotation 和登录后接受页；token 只持久化 SHA-256，邮箱只有在标准 OIDC `email_verified=true` 或 Better Auth 内部 JWT `emailVerified=true` 时可信，邀请凭据经 URL fragment 进入 sessionStorage 后立即从地址栏清除。真实 PostgreSQL 生命周期约束通过，邮件供应商未伪造，当前明确为人工复制链接交付。
- [x] 实现 Board CAS、ArtifactVersion 钉住校验和 Run 创建/查询/SSE/取消/审批/精确重试；当前空 schema 可从零应用全部 migration，完整 constraint suite 通过。HTTP/SSE/Worker E2E 覆盖成功、审批、取消、重试、附件、retry lineage、Knowledge capability 幂等重放与并发预算。
- [x] 新建 `apps/workbench-worker`，实现 pg-boss 消费、DeerFlow adapter、事件归一化和 ArtifactVersion 发布第一切片。
- [x] 完成 typed Run options、approval、附件快照和空 schema PostgreSQL HTTP/SSE E2E 第一切片。
- [x] 新建独立 `apps/workbench-file-worker`，完成 `file.verify`、可信 SHA/MIME、ClamAV INSTREAM、内容寻址 Blob、数据库 quarantine、有限重试与 stale reconciler；readiness 已校验 clamd `VERSION`、病毒库签名新鲜度和有效 stream limit，并在生产占位/失配时 fail closed。真实 PostgreSQL 已覆盖 clean、infected、重试耗尽和两类崩溃重放；真实 S3 provider 与生产 clamd/EICAR E2E 仍待外部基础设施验收。
- [x] Web 已接 TanStack Query、Run SSE reducer、Board controller/autosave、Artifact renderer、File/Uppy、Runtime model、Share/Remix/Export 和 Run actions；产品入口由持久 `(workbench)` layout、`WorkbenchRuntimeProvider` 与 `WorkbenchScene` 唯一拥有，Home/Project Next pages 只保留 URL。页面级 `AnimatePresence mode="sync"`、Project fulfilled-module cache 动态拆包和 project-scoped session generation 已完成；P1 -> P2 固定 `key="project"`，Project/header/React Flow DOM identity 保持，禁止按 `projectId` remount。登录/注册已脱离旧 chat auth，16 个 feature 已进入强制分层，聚合 `WorkbenchService`、`transport.service` 和旧 Projects 路径均已删除。
- [x] Uppy multipart 已接项目+文件指纹隔离的 IndexedDB checkpoint，恢复时重新校验文件摘要和服务端 `listParts`，不保存 File/blob、签名 URL 或 provider upload ID。SubmissionIntent 在上传前持久保存完整 typed request 与有序槽位，绑定上传使用 `intentId + position` 确定性 create/complete/extract 幂等键；刷新后可自动等待 verifying、重选未绑定/中断文件、重放同一 Run 或整单取消。这里已补齐“字节/session 可恢复但完整提交不可恢复”的旧缺口；真实目标 S3 的断网、浏览器崩溃、过期 session 和取消失败恢复仍是外部验收门。
- [x] 新 Contracts、Preview Token、API 和 Runtime Worker 已统一到 Node 22 ESM/NodeNext；File/Export Worker、Preview 与 Knowledge 包同样使用 ESM，旧应用不跟迁。
- [x] 以 Zod route registry 确定性生成 current/baseline 均为 79-path / 97-operation 的 OpenAPI 与 Web 类型；上一批准基线为 71/89。Design preset、SubmissionIntent 与唯一 Run 创建入口的直接合同改造不保留旧形状或 direct Run POST；生成物、Redocly、Nest route coverage、oasdiff 和 baseline 已同步。
- [x] Design preset 已由 UI 常量升级为服务端权威、版本化 catalog；Run 校验 `presetId/version/checksum` 并持久化 materialized snapshot/hash，Worker 不重新查询 catalog。未知 ID、错误版本、错误 checksum、snapshot/hash 漂移均 fail closed，真实 PostgreSQL HTTP E2E 通过。
- [x] SubmissionIntent 已完成 contract/API/PostgreSQL/Web 纵向链：每 Thread/Principal 活动唯一、槽位原子绑定、ready 门禁、并发双提交收敛到同一 Run、`submitting -> pending` 崩溃恢复、取消 CAS、创建人授权和前端刷新/重选/重试/取消。
- [x] Project invitation 不再隐式授予 Workspace membership；Run SSE 持续复核授权，Run cancel 使用 CAS 收口取消竞态；PRD 使用稳定 Section/Block ID 投影，Artifact retry/version pagination/pin retry、公开分享/Prototype 图片网络失败、Home 真实模板、Viewer Preview 独立链路均已补齐。
- [x] 将固定版本 oasdiff breaking-change、类型、测试、构建、lint 和 dependency-cruiser 检查并入产品工作台 CI。
- [x] 完成 Better Auth 产品账号、username/email 双登录、database session、可选企业 SSO、同源 BFF、账户菜单和 `signOut()`；浏览器业务请求只使用不透明 session cookie，明文 `idToken` 已由写入 hook 和数据库约束禁止持久化，定向组件/服务/PostgreSQL 测试已通过。
- [ ] 选定真实生产 OIDC provider 与唯一 KMS provider，完成登录/登出、Cookie 失效与密钥轮换浏览器 E2E，并以 KMS envelope encryption 替换 access/refresh token 当前基于应用 secret 的加密；供应商未确定前不预造多云抽象，`encryptOAuthTokens: true` 也不视为 KMS 验收。
- [x] Runtime Worker 已采用 pinned `@langchain/langgraph-sdk@1.9.25`，新增 RuntimeAttempt/externalRunId checkpoint、metadata recovery、`joinStream`/cancel reconciliation，并删除手写 LangGraph thread/run/SSE transport；HTTP/SSE PostgreSQL E2E 已覆盖发布、幂等、cursor 重放、多审批恢复、取消和私有附件传输。
- [x] Run 编辑目标已改为结构化 `artifactTargets`（Artifact、不可变版本、精确 `screenIds`）；API/Worker 会重验归属与 checksum，Runtime 以 `operation:create|revise` 显式声明发布语义，edit 必须一一覆盖目标且不得修改未选屏幕或共享 token/asset。
- [x] DeerFlow 最终结果统一为严格校验的 `workbench_runtime_result` fence；Worker 支持 state/final-assistant 读取并过滤分片 fence，协议 JSON 不进入用户可见流。生产仍必须把 `workbench` 作为只读 PUBLIC skill 随 DeerFlow 部署交付。
- [x] 完成 File Worker 基础设施重试/reconciler、25 MiB 上传上限、隔离 quarantine 和真实 PostgreSQL 崩溃重放集成测试。
- [ ] 在硬切选定的真实 S3 provider 上完成 multipart/崩溃恢复 E2E，并完成 clamd/EICAR E2E；MinIO 未被明确选为生产 provider 时只作测试夹具。
- [x] 完成 `knowledge-vault` 资产闭包：85 个 Markdown、5 个明确引用且校验通过的 `storage` 资产进入新链路，47,024 个未引用文件被排除；未删除本地原件，也未向外部知识库同步。
- [x] `EmbeddingProfile v1` 严格 canonical 合同、独立无 typmod chunk embedding 表、chunk/document/release 与 profile/dimension 复合约束已实现；临时 `KnowledgeChunk.embeddingModel`、`vector(1536)` 和无 profile HNSW 已删除，真实 PostgreSQL 混合维度、归属与不可变门禁通过。
- [x] `file.extract`、Docling、SafeVaultReader、KnowledgeRelease builder、release profile pin、可恢复 TEI embedding batch 和数据库完整性 finalizer 已实现；真实 PostgreSQL 已覆盖 batch 503 恢复与提交响应丢失重放。
- [x] 完成受限运维 KnowledgeRelease 创建/入队命令：`key + version` advisory transaction lock、adopted Embedding/RetrievalProfile pin、业务行与 pg-boss job 同事务、终态幂等重放、failed version 不可复活，以及 `exclusive + releaseId singletonKey` 队列配置断言。该命令不构成普通用户 API，也不代表生产凭据和真实模型已验收。
- [x] `RetrievalProfile v1` strict canonical 合同与 reranker 不可变身份已实现，覆盖 39 项聚焦测试；独立 `candidate -> poc -> adopted -> retired` 数据库状态机、不可变 spec、五列复合 FK、KnowledgeRelease/manifest/build/query/readiness pin 与 profile 驱动检索策略已完成。该项不代表真实生产模型已经评测或 adopted。
- [x] 完成受限 Knowledge retrieval 生产边界：lexical/dense 各取 40、RRF `k=60`、rerank 24、最终 10；真实 `jieba-wasm` query projection、TEI query embedding adapter、独立 reranker adapter、稳定 citation、`POST /runtime/knowledge/retrieve` capability tool、DeerFlow skill 调用协议、provider 脱敏与 reranker degraded evidence 均已实现。dense SQL 在隔离 schema 下显式使用 `OPERATOR(public.<=>)`。
- [x] Knowledge capability 已绑定 grant/Run/RuntimeAttempt/Principal/Project/Release 与固定 route scope；`wbkg1` grant 增加 `iat`，数据库持久化 budget、grant hash 和 invocation receipt，签发时先锁定 budget row，强制 `Idempotency-Key` 回放、成功/并发/窗口/重试/总启动预算，并在 provider 前后重新验证动态授权。scope 只接受使用数据库时钟判定的 `submitting | running` 当前 attempt，明确拒绝 `pending`、过期 attempt 和终态 Run。两条真实 PostgreSQL 连接已证明同一 RuntimeAttempt 并发签发只生成一个 grant。readiness 逐个校验 ready/active-pin-retired release 的 checkpoint、canonical manifest、embedding pin 和 Jieba identity，并对 embedding/reranker `/info` 做有界探测；Runtime Worker 在可服务 release 存在但 tool 未配置时 fail closed。
- [x] File Worker 已接入本地 Hugging Face 原生 tokenizer artifact，启动时校验 `tokenizer.json`/`tokenizer_config.json` 的 canonical SHA-256 与 EmbeddingProfile pin，切分上限直接来自 profile；不再保留独立 `o200k_base` 或 `WORKBENCH_KNOWLEDGE_MAX_CHUNK_TOKENS` 配置。
- [x] 仓库内 Blob GC 已完成：延迟 eligibility、事务行锁与二次引用校验、幂等对象删除、失败收据、有限重试和 crash reconciler 均通过真实 PostgreSQL 19 场景；BlobScan 明确为 non-owning 审计证据。
- [x] 已提供固定中文 retrieval evaluation dataset/results 合同与 CLI，计算 Recall@K、nDCG@K、nearest-rank p95 和 route leakage；smoke fixture 已通过，真实语料/模型结果仍不能伪造。
- [ ] 完成受限命令的生产凭据/真实执行、production adopted Embedding/RetrievalProfile、固定生产权重/revision/image digest/凭据、真实 provider conformance、DeerFlow 可访问的真实 tool URL、真实延迟/召回验收和生产 S3/IAM/ClamAV 演练。仓库不提供未经评测的默认 TEI 模型，当前 repository adapter/E2E 完成不等于真实模型与生产网络已经验收。
- [x] 新建隔离 Export Worker，完成 Release/ArtifactVersion/Asset pin、HTML/React/Figma/MCP job、真实 Blob 下载与服务端 Figma capability 门禁；Web 已完成 ExportJob 刷新恢复、轮询、CAS 取消和下载竞态保护，并以终态优先级保证较旧 `running` job 不遮挡较新 `succeeded` job；真实 Chromium smoke 覆盖恢复/取消/下载且无 console error。
- [x] 完成 `workbench.figma-export.v1` 和固定产品工作台 Importer 1.0.0；确定性 ZIP、资产 SHA-256、官方 Plugin API 导入计划、可编辑节点、rotation/transform origin 与假 Figma API 测试通过，私有 `.fig`/Kiwi/剪贴板 PoC 代码和依赖已删除。真实 Figma Desktop 字体、图片和大文件验收仍未完成。
- [x] 完成独立 Preview 容器、专用 gateway/token、opaque sandbox、Penpal v1 RPC、严格 origin 校验、CSP 和绿地 Compose 配置；现有 Chromium smoke 只证明 UI、sandbox、RPC 与 origin 校验，不证明真实数据库、S3、TLS 或生产网络链路。
- [ ] 在真实双 HTTPS origin、S3/IAM 和生产网络策略下完成 Preview 镜像构建与跨 origin 浏览器验收；本机无 Docker CLI，不能以配置检查替代此门禁。
- [x] 完成 Quartz v5 commit 锁定、构建期 Vault 静态生成、运行时只读 nginx、无 Vault mount/watcher，以及 `/knowledge/` 绿地网关代理。
- [ ] 完成 Quartz 镜像真实构建及 `/knowledge/` 桌面/移动浏览器验收。
- [x] 完成 `workbench` Compose 和部署脚本结构：只启动新 Web/API/Workers/Preview/Quartz，不加载根 `.env`，不执行 Git reset/pull，以容器健康状态验收。
- [ ] 完成绿地镜像真实构建、全服务健康、TLS 和生产依赖 smoke。
- [x] 启用 ESLint direct-import 与 dependency-cruiser transitive-reach 架构边界；`npm run lint:workbench` 与 `npm run architecture:workbench` 已通过并进入 CI，禁止新前端反向依赖旧 chat/AI SDK/SWR。
- [x] 完成真实 pgvector PostgreSQL 集成测试，覆盖混合维度、release/profile 归属、durable batch 状态机、向量完整性 finalizer 和崩溃重放；真实候选模型/TEI 的质量与性能评测仍是独立门禁。
- [x] 完成跨服务 OpenTelemetry 仓库底座：共享 `workbench-telemetry`、BFF/API HTTP server/client span、pg-boss producer/consumer context、DeerFlow/Docling/TEI client span、无 collector 不联网和优雅 flush；队列不传播 baggage/token。真实 OTLP collector 的链路、脱敏、断连与 SIGTERM 验收仍是生产门禁。
- [ ] 完成真实 DeerFlow 部署 E2E；RuntimeAttempt/checkpoint 的本地合同与 PostgreSQL E2E 已完成。
- [x] 完成 ProjectRelease、Artifact/Asset 只读、公开分享/撤销/重混、按 screen 预览、Board 节点多选导出和产品工作台主数据链路接入。
- [x] Board 已原生支持 Artifact/Frame/Drawing、稳定 sibling `order`、嵌套 reparent、子树复制/删除、Drawing `intrinsicSize`、压力笔迹、Undo/Redo、限额和 PUT idempotency receipt；桌面/移动浏览器 smoke 已覆盖保存、撤销、重做和刷新恢复。
- [x] Board 工具与隔离 Preview 的 Chromium UI/sandbox smoke 已迁入 `scripts/e2e/` 并进入 CI；覆盖桌面/移动视口、四次 Board CAS 保存、opaque sandbox、独立 origin、Preview RPC、刷新和多屏切换。该 smoke 使用受控浏览器夹具，不替代真实 API/DB/S3/TLS/独立 hostname 的生产 E2E。
- [x] Project NavigationGuard 已用真实 Chromium、Firefox、WebKit history back/forward 覆盖完整 committed URL：indexed pop 会先回到 committed Project 再等待 dirty Board save barrier，pending 画布经像素熵/标准差证明非空；自动保存与离开 flush 同时失败时恢复原 `pathname + search + hash + boardNode`、保留 Project DOM/节点选择和失败反馈，三次保存尝试复用同一 idempotency key 和完全相同的 Board 请求体。保存成功后 replay back 接受完整 Home query/hash，forward 返回真实 Next Project page owner 并恢复节点；P1 -> P2 同时等待规范 `/projects/p2` URL、history index 2 和准确的 P2 Next route tree。重复两轮 back/forward 后只有一个可见 route owner、唯一 Runtime stage，Next `display:none` Activity cache 数量有界且无 opacity-only 残留。测试未手工派发 `PopStateEvent`。
- [x] Prototype v1 的 rotation/transform origin 已贯通编辑器、嵌套 Group 矩阵、生产 renderer、HTML/React/MCP 和 Figma affine matrix，并通过真实 Chromium payload 验证。
- [x] Prototype v1 已冻结并执行统一语义校验：全局 ID/binding/action 唯一、form/input/radio/select 约束、局部 reset、显式 submit 合同、双击同一飞行窗口去重以及 Web 异步 generation guard 均已覆盖；Contracts、Prototype Web 与 Export 定向套件均通过。后续只需在生产外部环境继续执行共用 trace corpus，不再建设兼容协议。
- [x] 完成 `workbench.design-system.v1`、同 Workspace catalog/create/import receipt、Run `RuntimeDesignStyleSnapshot` 物化，以及 Home/Project 的 React Hook Form + react-colorful 接线；浏览器 smoke 已验证创建目标 Project、导入来源版本、重取目标 Project，并只用目标 ArtifactVersion 启动 Run。
- [x] 完成 Media/Style/Special、Prototype 屏内元素变换与公开 Blob Artifact 真实预览主链。
- [x] “添加屏幕截图”已使用 `getDisplayMedia` 获取单帧 PNG，经 4096px/1600 万像素边界处理后进入现有附件上传与 Run 链；成功/失败均停止媒体轨道，单元测试通过。
- [x] 收藏/喜欢/不喜欢已按 `principal + ArtifactVersion + screenId` 隔离，Prototype 强制校验真实 screen 归属，ETag CAS、刷新查询与界面按钮接线完成；合同/API/Web/真实 PostgreSQL 定向测试通过。
- [x] 通信偏好已实现 `GET/PUT /identity/preferences`、默认双 `false`、Principal 隔离、ETag CAS 和首页保存；反馈/论坛/隐私入口已做协议白名单与未配置禁用。
- [x] 通信偏好刷新保持与审批键盘操作已进入真实 Chromium E2E：覆盖权威 GET、强 ETag PUT、整页刷新后新 revision/UI 保持，以及 RadioGroup 键盘进入/切换、焦点 trap、Escape 阻塞、Enter/Space 结构化提交和最终 Run 恢复。
- [ ] 完成截图授权选择器到真实 S3/Run、screen 偏好刷新保持，并为反馈/论坛/隐私配置经授权的生产目的地。通信偏好不等于邮件投递与退订合规链。
- [x] Artifact 历史版本列表、预览、比较、Board pin/CAS 与错误恢复已接通；模型目录 loading/error/retry 状态和无持久 Artifact 时的请求相关 fallback 已覆盖测试。
- [x] 完成受限 Knowledge Profile operator grant/revoke、create/list/get/promote/retire、`candidate -> poc -> adopted` 晋升、不可变 AdoptionReceipt 和数据库 deferred constraint；这些仓库治理能力不等于真实生产模型已经 adopted。
- [ ] 完成真实 adopted embedding/reranker 模型与部署验收、真实外部基础设施上的 accessibility/视觉验收及其余生产可见闭环；前端 route ownership、Knowledge release producer、Profile 治理和 provider/tool adapter 不再列为未完成项。
- [x] PRD 编辑已接入 Tiptap Core/StarterKit/Table/Link/UniqueID；结构化 PRD projection、引用保留、版本创建/CAS/幂等、保存/取消/撤销重做和错误恢复测试已通过（2026-07-14）。

## 仓库验证快照

| 范围 | 结果 | 结论 |
|---|---:|---|
| 根回归 `npm test` | 通过 | Contracts、API、三个 Worker、Preview、Export、Knowledge、数据库合同和施工期隔离回归均通过；细分计数随实现变化，不在本方案固化旧快照 |
| Web | 144 files / 616 tests | 全部通过；含持久 Scene、动态 Project route cache、project-scoped session、跨项目 mutation/SubmissionIntent 隔离、DOM identity 与 Strict Mode/并发回归 |
| TypeScript 与 lint | `npm run typecheck`、`npm run lint:workbench` | 通过 |
| 架构 | 432 modules / 1,403 dependencies / 0 violations / 16 features | dependency-cruiser 与 restricted-import 门禁通过；禁止旧 Chat/AI SDK/SWR 反向可达、deep import、聚合 Service 和按 `projectId` remount |
| 全量生产构建 | `npm run build` | 通过；API、三个 Worker、Preview、Next 16、Figma Importer 与生成发布物均成功 |
| Web bundle | `npm run bundle:workbench:check` | 通过；Home 静态图不包含 Project UI/编辑器，Project 使用 fulfilled-module cache 动态边 |
| 品牌 | `npm run brand:check` | 通过；用户可见品牌统一为“产品工作台”，`workbench` 仅作内部标识，Google Stitch 只在外部技术说明中出现 |
| 浏览器上传部署 | `npm run deployment:upload:check` | 通过 |
| Web 安全响应头 | `npm run web:assert-security-headers` | 通过 |
| 统一浏览器门禁 `npm run e2e:web` | Run Preview、Approval/Preferences、Board、NavigationGuard、Design System Import、Export Recovery、Isolated Preview | 全部通过；NavigationGuard 另在 Chromium、Firefox、WebKit 验证 Home/Project 同屏过渡非空、拒绝 Back 不闪 Home、P1 -> P2 仍是同一 Project root/header/React Flow DOM |
| OpenAPI | current/baseline 79 paths / 97 operations；上一批准基线 71/89 | current 已反映 Design preset、thread-scoped SubmissionIntent 和唯一 Run 创建入口；旧 preset shape、project-current 路由与 direct Run POST 不保留，生成链、Web types、route coverage 与 baseline 已同步 |
| 外部生产门禁 | 未由仓库测试替代 | 真实 OIDC/KMS、S3/IAM/ClamAV、DeerFlow、embedding/reranker、双 HTTPS origin、OTLP collector、Docker 镜像、Figma Desktop 与全服务网络仍须在目标环境验收 |

本次快照中的测试计数是对应命令当次运行结果；后续合同和实现继续变化时必须以最新 CI 输出为准，不得把历史计数当作当前证明。仓库级测试与 Chromium UI/sandbox smoke 不替代真实 OIDC/KMS、S3/ClamAV、DeerFlow、双 HTTPS origin、外部 OTLP trace backend、生产模型、Docker 镜像、Figma Desktop 和全服务网络验收。

## 当前剩余阻断与工作量

当前前端不是“完整一坨代码”。准确状态是：持久 `(workbench)` layout、`WorkbenchRuntimeProvider` 与 `WorkbenchScene` 组成唯一页面运行时，Home/Project Next pages 只拥有 URL；Home、Composer、Artifact、Canvas、Run、Preview、认证和 16 个 feature 均有明确模块边界。Project 使用 fulfilled-module cache 动态拆包，页面级 `AnimatePresence mode="sync"` 由 Scene 唯一拥有；P1 -> P2 固定 `key="project"` 并通过 session generation 同步换域，Project root、header 和 React Flow DOM 不重挂载。聚合 `features/service.ts` 与 `transport.service` 已删除，Projects 接口及其 bootstrap/Board cache、ETag/CAS 恢复语义已归入 Projects bounded context。432 modules / 1,403 dependencies 的架构检查为 0 violations，当前不再存在“拆主壳”或“补 route ownership”的内部工作包。

除结构治理外，当前仍有以下上线阻断：

1. 选定真实 OIDC provider 与唯一 KMS provider，在目标域完成登录/登出、Cookie/CSRF、token envelope encryption、失效和密钥轮换 E2E。
2. 在硬切选定的 S3/IAM 与真实 clamd 上完成 multipart、断网/刷新/崩溃/过期 session/取消失败恢复、可信摘要、EICAR、Export Worker 和下载 E2E；仓库内 Uppy/SubmissionIntent/ClamAV readiness 已完成，不重复实现。
3. 固定生产 DeerFlow commit/image、只读 PUBLIC `workbench` skill、真实模型凭据与 Gateway/LangGraph 合同；用真实 embedding/reranker 权重、revision、TEI image 和中文评测集完成 adopted 决策、延迟/召回与零泄漏验收。
4. 在双 HTTPS 主站/Preview origin、真实 OTLP collector、Quartz 与 Docker 镜像环境完成跨服务网络、隔离、父子 trace、重试、脱敏、断连、优雅退出与故障恢复验收。
5. 在 Figma Desktop 验收产品工作台 Importer 1.0.0 的字体、图片、大文件和官方 Plugin API；若上线要求系统发信或外部反馈/论坛/隐私目的地，还须选择并授权相应供应商、域名和合规策略。
6. 生产验收后执行硬切 manifest v2，物理删除旧数据库、对象、镜像、卷、网络、密钥和可观测数据，保存删除回执并运行 `--enforce` 与残留扫描；不保留兼容、双写或旧版回退。

以下是从 2026-07-16 当前快照到“在真实生产外部依赖上完成验收并硬切”的 bottom-up 剩余估算，已经假定继续复用本文选定的开源组件，不包含兼容旧接口、迁移旧对话、双写或维护旧版：

| 剩余工作包 | 人日 | 主要范围 |
|---|---:|---|
| 身份与 BFF 生产验收 | 4-7 | 真实 OIDC/KMS、Cookie 失效/轮换、CSRF/SSE 生产验证；Better Auth、BFF 与服务端 ESM 不重复计入 |
| 知识库生产模型与 DeerFlow 验收 | 4-8 | production adopted profile、固定模型/镜像、真实 conformance、trusted tool 生产执行、中文质量/延迟/无泄漏结果；Profile 治理、adapter、tokenizer、runner 和检索内核不重复计入 |
| 对象存储、文件安全、导出与 Figma | 6-11 | 真实 S3/IAM 上传恢复、clamd/EICAR、Export Worker/下载、Figma Desktop 与生产浏览器视觉链 |
| 生产运行环境与跨服务验收 | 9-16 | 双 HTTPS Preview、DeerFlow 全链、外部 OTLP collector、Quartz、Docker 镜像、全服务网络与故障恢复 |
| 硬切、旧版物理删除与残留审计 | 3-6 | 使用已完成的 manifest v2 删除数据库/对象/镜像/卷/网络/密钥/日志并保存回执，执行生产残留扫描 |
| **合计** | **26-48** | 已完成的持久 Scene、route ownership、动态拆包、跨项目状态隔离、聚合 Service 删除及全部仓库门禁均不重复计入 |

以 2 名前端、2 名后端/平台和 1 名部分投入 QA/DevOps 计算，合理日历周期约 2-5 周；单人串行约 1.5-2.5 个月。外部账号、模型、证书、S3/IAM 或部署审批的等待时间不包含在人日内，但会延长日历周期。该区间不包含任意生成代码在线执行、Figma 级完整设计编辑器、实时多人协作或外部 Figma 双向同步。

## 规模预估（从零累计基线，不是当前剩余工时）

以下数字已经假定采用 `docs/workbench-open-source-reuse-strategy.md` 中的成熟组件，不能再次机械扣减组件开发量。

全部数字按纯绿地建设计算：旧接口兼容、旧数据迁移、双写、旧版回退和旧系统继续维护均为 0 人日；生产门禁后的不可逆删除与残留审计作为发布任务包含在区间内，不构成旧版演进范围。

下表是立项时“从空白到完整范围”的累计预算，不是 2026-07-14 起的剩余工时。当前已经完成的合同、数据库、API、Worker、Board、设计系统、分享/导出和 Prototype rotation 不能再次计入剩余量；剩余工作必须在功能冻结后按未完成门禁重新做 bottom-up 基线，仓库没有足够的工时历史支持直接用总预算减百分比得出精确数字。

与画布、上传、编辑器、协议和解析全部手写相比，当前开源方案去重后约节省 45-70 人日。LangGraph 官方 SDK、标准 multipart encoder、Uppy checkpoint/摘要恢复和固定 Figma Importer 已经进入当前实现，其收益已经反映在剩余估算中，不能再次机械扣减；它们也不会消除 ProjectRelease、权限、IR 映射、页面级上传控制、真实导出验证或生产 E2E。

设计系统这一子范围按上述开源边界估算为 7-10 人日：合同/schema/迁移与 import receipt 约 2-3，权限校验、幂等和资产复制约 2，Runtime materialization 约 1-2，Home/Project 接线与集成验收约 2-3。它已经包含在“当前可见功能全量兑现”的累计预算中，不能再叠加一次；不包含完整设计系统可视化编辑器、跨 Workspace 市场、外部 Figma 双向同步或字体采购。

以下总量假设 v1 只执行受控 IR preview，“自定义设计”为结构化表单编辑，React 从 IR/RenderPlan 生成可运行项目，Figma 通过已经落盘的官方 Plugin API importer 导入。任意生成代码在线执行或完整 Figma 式设计系统编辑器各自通常还会增加约 15-30+ 人日；真实 Figma Desktop 验收和 RenderPlan 直出 React 的剩余工作已进入当前工作包，不再把“重新开发 importer”作为风险储备重复计费。

| 范围 | 从零累计人日 | 说明 |
|---|---:|---|
| 生产级基础平台 | 100-140 | Project、Thread、Run、知识、文件、PRD、原型、版本、画布、HTML 分享导出和生产保障 |
| 当前可见功能全量兑现 | 165-250 | 再含 Frame/Draw/Media/Style/Special、完整 Undo/Redo、公开重混及真实 Figma/React/MCP 导出 |

用户确认的最终目标是“当前可见功能全量兑现”，因此 100-140 人日只能作为从零建设的中间里程碑，不能作为完整项目预算。原始全量范围按 4 名有经验工程师加 1 名部分投入的 QA/DevOps 约 12-18 周，单人约 9-13 个月；这些日历数字同样不是当前剩余周期。实时多人协作和当前界面之外的新产品能力另行估算。
