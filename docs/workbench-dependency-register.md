# 产品工作台第三方依赖台账

更新日期：2026-09-23

本台账记录产品工作台生产主链的开源内核及已批准候选。状态必须按证据使用，不能把“已选名字”写成“已经验证”：

用户可见品牌统一为“产品工作台”，内部标识统一为 `workbench`；第三方供应商名称只出现在明确的外部技术决策记录中，不进入产品或运行时命名。

- `candidate`：完成桌面审计，仅允许进入 PoC，可能尚未安装。
- `poc`：已经有隔离代码或 fixture 证据，不得进入默认生产能力。
- `integrated`：已经进入真实代码路径并通过本地合同/集成测试，但仍缺真实外部服务、浏览器或部署门禁。
- `adopted`：生产实现与真实环境门禁均通过，允许作为唯一生产内核。

表内 npm 版本是 lockfile 当前解析版本。应用依赖由 `npm ci`、lockfile integrity 和受审依赖更新 PR 固定；高风险 PoC、私有协议转换器和协议 SDK 在 manifest 中也必须使用精确版本。独立服务必须固定镜像 digest 和上游 commit，只有 major/minor 名称不能进入 `adopted`。

上游项目 URL 与许可证据统一列在 `docs/workbench-open-source-reuse-strategy.md` 的“官方项目索引”，npm tarball integrity 以根 `package-lock.json` 为准；独立服务 digest 必须回填到对应行后才能升为 `adopted`。测试数量、模块数量和一次性 PASS 快照不在本台账固化；当前结果只以 CI 和实际门禁命令输出为准。

通用规则：浏览器和 Node 高危漏洞在 7 日内完成升级或隔离决定，直接处理不可信内容、身份、上传、解析、预览和导出的高危漏洞在 72 小时内完成决定。季度复核维护活跃度、许可证和商业条款；Cloud/Pro/Enterprise 能力不得进入内部合同。

| 能力 | 内核与状态 | Owner | 许可证/费用边界 | 内部边界与合同证据 | 退出阈值与唯一备选 |
|---|---|---|---|---|---|
| Web runtime 与样式构建 | Next `16.2.12`、PostCSS `8.5.18`、next-themes `0.4.6`，`adopted` | Web platform | MIT；无许可费 | Next 只承载产品路由、同源 BFF 与构建；主题状态不得绕过 hydration 和现有视觉基线 | 安全修复按响应时限升级；主版本升级必须通过 SSR/hydration、BFF、构建和浏览器矩阵 |
| UI primitive | Radix `1.6.0`、Sonner `1.7.4`，`adopted` | Web platform | MIT；无许可费 | 仅行为内核，产品工作台保留 DOM、计算样式与 Motion 参数；键盘与焦点组件测试。`cmdk` 未安装，固定短命令列表不为搜索引擎增加依赖 | React 19/Next 16 阻断两个稳定版本周期后重评同类 headless primitive；只有出现可搜索命令目录时才评估 `cmdk` |
| 图标 | Lucide React `0.446.0`，`adopted` | Web platform | ISC；无许可费 | 只允许 named import，不复制 SVG 集 | 上游停止安全维护时切同类 ISC/MIT 图标包 |
| Preview 二维码 | `qrcode.react@4.2.0`，`integrated` | Web platform | ISC；无许可费、无外部服务 | 只编码服务端返回且经过独立 origin/expiry 校验的短期 Preview capability URL；不接 QR SaaS、不编码 Share URL、JWT 或持久 token；组件值与顶层打开链接由 Web 测试约束 | 上游失养或 React 主版本阻断时切单一 ISC/MIT 本地 QR encoder，内部仍只传短期 capability URL |
| 动效 | framer-motion `11.18.2`，`integrated` | Web platform | MIT；无许可费 | 所有产品工作台动效统一从 `framer-motion` 导入；保留现有 DOM、Motion props、时长和 easing。Home/Project 根用稳定 `onUpdate` 关闭 opacity WAAPI path，避免 11.18.2 收尾单帧回落 | 不引入第二个 Motion 入口；任何升级必须通过三浏览器逐帧非空和完整视觉/交互门禁 |
| Board 画布 | React Flow `12.11.2`，`integrated` | Canvas | MIT Core；免费路径保留官方 attribution，未采购 Pro，也不通过 CSS/配置隐藏 | `board/adapter.ts` 隔离 Node/Edge；Board CAS、viewport 和节点 fixture；不把 React Flow Node/Edge 持久化；完整触控/大图/部署门禁未完成 | 真实浏览器门禁通过后才升为 `adopted`；若未来要求隐藏 attribution，必须先采购 Pro/取得书面授权；禁止并存第二 Board 内核 |
| Canvas 视觉捕获 | `html-to-image@1.11.13`，`integrated` | Canvas/Web | MIT；无许可费、无外部服务 | 只克隆带精确 BoardNode/ArtifactVersion/Screen 身份的原型 viewport；Web 拒绝跨 origin/缺失资源并限制 2,048 px、1 MiB，计算原始字节 SHA-256；截图只进入 wire ACK，API 重新解码、重编码和复核，不进入 durable ACK | Chromium/Firefox/WebKit 的字体、图片、超限、取消和真实模型图像消费门禁通过后才升为 `adopted`；失败时只替换 DOM-to-canvas adapter，不改变 capability/ACK 合同 |
| 服务端状态 | TanStack Query `5.101.2`，`adopted` | Web platform | MIT；无许可费 | `workbenchQueryKeys`、generated OpenAPI client 与 feature hooks | 新 Workbench 禁止回退 SWR；重大不兼容才做独立替换 ADR |
| Board 临时状态 | Zustand `5.0.14`，`adopted` | Canvas | MIT；无许可费 | 只保存草稿、selection、viewport 和 save status；服务端 revision 是事实源 | 不 override React Flow 的传递 Zustand 4；内存/并发问题由 store fixture 判定 |
| 文件上传 | Uppy Core `5.2.0` + AWS S3 `5.1.0`，`integrated` | File | MIT；不使用 Transloadit 托管 | signed multipart、暂停/恢复/取消；摘要、ETag、UploadSession 已测。SubmissionIntent 以有序 slot 和 `intentId + position` 命令键补齐完整提交刷新恢复；真实目标 S3 服务 E2E 待完成 | 不叠加 tus；若上游失养，唯一备选须继续使用 S3 multipart 合同 |
| 浏览器摘要 | hash-wasm `4.12.0`，`adopted` | File | MIT；无许可费 | 独立 Worker，服务端仍复核对象字节 | WebCrypto streaming 能完整替代且性能通过时才删除 |
| REST 与 SSE | openapi-fetch `0.17.0`、eventsource-parser `3.1.0`，`adopted` | Web/API | MIT；无许可费 | generated current/baseline、cursor replay、sequence 去重、跳号和持续授权测试必须同步通过 | 不引入第二消息 SDK；只有 Runtime 协议整体变化才重评 AG-UI adapter |
| Agent Runtime transport | LangGraph SDK `1.9.25`，`integrated` | Runtime | MIT；无许可费 | pinned contract、externalRunId checkpoint、join/cancel/replay 的本地与 PostgreSQL 证据已完成；真实 DeerFlow 部署 E2E 待完成 | DeerFlow 合同升级先过 pinned fixture；不恢复手写 SSE transport |
| Agent Runtime 服务 | DeerFlow，`integrated`（生产版本未冻结） | Runtime | MIT Core；模型、搜索、sandbox 和算力另计 | `RuntimePort` 已隔离；trusted Knowledge tool 的真实协议仓库 smoke 已互证 ToolMessage、数据库 invocation ledger、citation 指纹和 capability 不泄漏。进入 `adopted` 前仍须登记 commit、镜像 digest、Gateway/LangGraph 合同、模型策略，并完成真实生产执行、外部 trace backend 和部署 E2E | 唯一 Runtime，不并行引入第二 Agent runtime；不满足部署门禁则停止硬切 |
| 持久任务 | pg-boss `12.26.0`，`adopted` | Platform | MIT；无许可费 | PostgreSQL 同事务提交、commit/rollback 与重放测试 | 只有吞吐/运维证据超过单库边界才评估独立队列 |
| 规范摘要 | canonicalize `2.1.0`，`adopted` | Contracts | Apache-2.0；无许可费 | `jcs-sha256-v1` fixture，Run/Artifact/approval 摘要统一 | 算法升级必须新版本标识，不原地改变历史摘要 |
| OpenAPI 生成与校验 | zod-to-openapi `7.3.4` + Redocly CLI `2.38.0` + oasdiff `v1.23.0`，`adopted` | Contracts/API | MIT/Apache-2.0；无许可费 | Zod/route registry 确定性生成 current/baseline OpenAPI 与 Web types；Design preset 与 thread-scoped SubmissionIntent 已完成破坏性审查和 baseline 刷新 | 不恢复旧 preset shape、project-current、旧 Workspace-scoped GET 或手写 YAML；后续合同变更必须同步 consistency/Redocly/route coverage/oasdiff 与 baseline |
| multipart 编码 | form-data `4.0.6`，`adopted` | Runtime | MIT；无许可费 | DeerFlow Gateway 上传边界、内容长度与私有 receipt 隔离 E2E | Node 标准 FormData 满足流、长度和取消合同后可替换 |
| 导出归档 | archiver `8.0.0`，`adopted` | Export | MIT；无许可费 | 固定路径/manifest/摘要，禁止用户控制归档路径 | 高危漏洞无修复或不支持 Node 22 时切经过审计的单一 ZIP writer |
| React 导出工具链 | Babel AST/generator + Prettier + esbuild，`integrated`；`html-to-jsx-transform@1.2.1` 为过渡叶片 | Export | MIT；无许可费 | 最终合同为 `PrototypeDocument -> RenderPlan -> React AST/runtime data`；现有 HTML-to-JSX 只转换本项目生成的静态 markup | RenderPlan 直出完成后删除中转；不得让 HTML 或第三方 AST 成为持久事实源 |
| Figma Importer | `create-figma-plugin@4.0.3` + `@figma/plugin-typings@1.130.0` + `fflate@0.8.3`，`integrated` | Export | MIT/官方 typings；无许可费 | 固定产品工作台 Importer 1.0.0 用官方 Plugin API 读取 `workbench.figma-export.v1`；归档/资产 SHA-256、导入计划、旋转原点、假 Figma API 和确定性分发包测试通过 | 真实 Figma Desktop 的字体、图片、大文件与官方 API 验收通过后才升为 `adopted`；失败时缩减明确支持范围，不自写 `.fig`、Kiwi 或剪贴板协议 |
| PRD 编辑 | Tiptap Core/StarterKit/Table/Link/UniqueID，`integrated` | Artifact | MIT Core；禁 Cloud/Pro 类型入库 | 结构化 PRD projection、引用保留、版本创建/CAS/幂等、保存/取消/Undo/Redo 和错误恢复测试已通过；不保存 Tiptap JSON | 完整 12 类 block、React 19/SSR、无障碍或大文档门禁失败时重新评估唯一内核；不继续扩建手写 ProseMirror |
| 屏内选择与变换 | `react-selecto@1.26.3` + `react-moveable@0.56.0`，已直接安装、`poc` | Prototype editor | MIT；无许可费、无托管服务；两包未声明 React peer-version 合同 | 隔离 adapter/model 覆盖 DOM id/当前 screen selection、逐帧 preview/手势结束 commit、group 原子 batch/单 revision、renderer 居中平移与 `0.5x`/`2x` zoom、move/resize `PrototypeDocument` round-trip；第三方事件/CSS 类型不进入 IR | 真实触控设备、吸附/参考线、滚动容器、移动端手柄与目标生产环境仍须验收，完成前不得升为 `adopted`；失败时唯一验证备选 interact.js，不双栈监听 DOM |
| Prototype 变换矩阵 | `@scena/matrix@1.1.1`，`integrated`（Web 直接依赖） | Prototype core | MIT；无许可费 | 只在 adapter/model 内承担父子矩阵组合、求逆、group pivot 和 world-to-local 投影；固定 sibling/不同旋转父级 fixture，持久合同仍是结构化 rotation/origin，第三方数组不越过领域边界 | 固定几何 fixture 不通过才评估单一 MIT 矩阵库；禁止自写第二套矩阵算法或把第三方数组类型写入 IR |
| 图层/列表排序 | Pragmatic Drag and Drop，`candidate`（未安装、版本未冻结） | Prototype editor | Apache-2.0；无许可费 | 待完成图层树/附件排序 fixture；父子关系和权限仍由内部 command 校验 | PoC 失败才评估 dnd-kit，不保留双传感器 |
| Board Undo/Redo | Zustand bounded snapshot journal，`integrated`；zundo 未安装 | Canvas | MIT；无许可费 | Frame/Draw/移动/删除等 command 与手势合并、CAS revision、Undo/Redo 保存和浏览器 smoke 已验证；当前历史上限 100，服务端 revision 仍是事实源 | 大文档内存基准未通过时，优先迁为 Immer patches + zundo；不同时维护两套历史，不保存第三方快照为服务端事实源 |
| 代码/Diff | CodeMirror 6 + `@codemirror/merge`，`candidate`（基础 CodeMirror 已有） | Artifact | MIT；无许可费 | 待完成确定性文本投影、语言配置和保存策略 | 只在 bundle/无障碍门槛失败时重选 headless editor |
| Draw | perfect-freehand `1.2.2`，`integrated` | Canvas/Export | MIT；无许可费 | `perfect-freehand@1` stroke 合同、压力点、固定 intrinsic viewBox、产品工作台绘制、持久化、Undo/Redo、刷新恢复与 HTML 导出已通过合同/浏览器测试 | 几何能力不足时只替换算法，不改变 Drawing schema；完整生产视觉门禁通过前不升为 `adopted` |
| Media 裁剪 | react-easy-crop `5.5.6`，`integrated` | Prototype editor | MIT；无许可费 | Uppy 上传、裁剪、blob-backed image Artifact、Board 原子插入、Undo/Redo 与组件测试已通过；生产触控与 Canvas CORS 仍进浏览器门禁 | React 19/触控失败才换唯一 crop 内核 |
| 颜色编辑 | react-colorful `5.7.0`，`integrated` | Artifact/Prototype editor | MIT；无许可费 | Design System 结构化表单与 Board Style 主链已消费，颜色值写入内部 design token/style schema；完整键盘和对比度门禁仍待完成 | 设计 token 范围超出能力时扩充薄 UI，不让库 schema 入库；Board Style 不另引第二颜色内核 |
| Design token 投影 | Style Dictionary，`candidate`（未安装、版本未冻结） | Artifact/Export | Apache-2.0；无许可费 | 待完成 `workbench.design-system.v1` 到 CSS/React/Figma/Runtime fixture；config/transform 名称不入库 | Node 22 ESM 或投影确定性不达标时只保留内部 IR 并采用一个审计后的确定性 exporter |
| 颜色解析与运算 | Color.js，`candidate`（未安装、版本未冻结） | Artifact | MIT；无许可费 | 进入 Design System 色域/混色/对比度主链前必须作为 workspace 直接依赖，并完成 CSS Color 与 canonical serialization fixture | 不达标时唯一评估 culori，不双栈计算同一 token |
| 字体元数据 | fontkit `2.0.4`，`candidate`（当前仅传递依赖） | File/Export | MIT；无许可费 | 待完成名称、variable axes、glyph coverage 与损坏字体 fixture | 采用前改为直接依赖；失败时唯一评估 opentype.js，不在 API 进程解析字体 |
| Markdown AST | unified `11.0.5` + remark-parse `11.0.0`/frontmatter `5.0.0`/gfm `4.0.1`，Knowledge `adopted`、设计系统 adapter 待接 | Knowledge/Artifact | MIT；无许可费 | Knowledge 已有 AST/wikilink fixture；design-system guidelines/usage 增加受支持节点 round-trip，mdast 不入库 | 不回退正则 parser；只有上游不再支持 Node 22 ESM 时统一迁移 AST 栈，不为设计系统另建第二 parser |
| 图层树 | Headless Tree，`candidate`（未安装、版本未冻结） | Prototype editor | MIT；无许可费 | 待完成内部 node id/层级投影、键盘重命名与虚拟化 fixture | PoC 失败唯一备选 react-arborist |
| Preview RPC | `penpal@7.0.6`，`integrated` | Preview | MIT；无许可费 | 已固定严格 v1 schema、capability channel、origin/source 校验、超时、销毁与 opaque sandbox Chromium UI smoke；该证据不覆盖真实 DB/S3/TLS | 生产独立 HTTPS hostname + 真实 capability E2E 通过后才升为 `adopted`；安全合同不满足时升级或重选一个 RPC 内核，不自建双协议 |
| 文档解析 | Docling Serve `1.26.0`，`integrated` | Knowledge/File | MIT Core；模型权重单独核验 | 异步 task/checkpoint、25 MiB 边界、FileExtraction 归一化和 traced fetch 已进入真实代码路径；生产镜像 digest、页数/超时/资源预算及无公网容器仍待验证 | 真实服务门禁通过后才升为 `adopted`；输出 schema/资源预算失败时按格式拆单一 parser，不让 Docling JSON 成为事实源 |
| Web 身份会话 | Better Auth `1.6.23` 产品账号 + database session；Keycloak/OIDC 为可选企业 SSO，`integrated` | Identity/Web | MIT/Apache-2.0；无许可费 | username/email 双登录、database session、同源 BFF、账户菜单/登出和 OIDC verified-email 边界已接；仍须补齐邮件验证/密码恢复、固定实际 IdP、KMS envelope encryption、Cookie/CSRF、登出和密钥轮换 E2E | 真实身份与 KMS 门禁通过后才升为 `adopted`；第三方 User/Organization 不成为领域事实源，不保留 Passport JWT 兼容链 |
| 中文切词 | `jieba-wasm@2.4.0`，`integrated` | Knowledge | MIT；无许可费 | 固定 `cut_for_search`、词典/停用词摘要和分块 fixture | 性能或词典质量不达标时唯一评估 `@node-rs/jieba` |
| 模型原生 tokenizer | `@huggingface/tokenizers@0.1.3`，`integrated` | Knowledge/File | Apache-2.0；无许可费 | File Worker 只读加载 pinned `tokenizer.json`/`tokenizer_config.json`，两文件 canonical artifact SHA-256 与 EmbeddingProfile 校验；chunk token ceiling 直接来自 profile | artifact 缺失、损坏或 pin 不一致时 fail closed；模型 revision 变化必须新建 profile/release，不原地修改历史 release |
| Embedding 服务 | Hugging Face TEI，`candidate` | Knowledge/ML platform | Apache-2.0；无许可费，算力另计 | 独立无公网服务；PoC 后固定 image digest、batch/token/timeout 和 conformance probe | TEI 无法满足固定模型/协议门禁时替换服务 adapter，不改变 EmbeddingProfile 或数据库合同 |
| Dense embedding | Qwen3-Embedding-0.6B 1024，`candidate`；BGE-M3 1024 基线 | Knowledge | Apache-2.0/MIT；无调用许可费 | 至少 100 条中文标注查询比较 FTS、dense、RRF；固定 model/tokenizer revision、artifact SHA、pooling、prompt、L2 与维度 | 未达到 Recall/nDCG/slice 门禁不采用；不得用可变模型别名覆盖历史 profile |
| Reranker | bge-reranker-v2-m3 + TEI `/rerank`，`candidate` | Knowledge | Apache-2.0；无调用许可费 | 独立 RetrievalProfile，top 24 -> 8-12；失败降级到 RRF 并记录 evidence | 不得写入 EmbeddingProfile；关键 slice 回退或 p95 超标即不上线 |
| MIME 识别 | `file-type@22.0.1`，`integrated` | File | MIT；无许可费 | 不信任扩展名/浏览器 MIME；真实格式 fixture 和失败封闭 | 覆盖不足才在隔离 Worker 单独评估 libmagic |
| ZIP 解包 | `yauzl@3.4.0`，`candidate` | File | MIT；无许可费 | 新 File Worker 尚未直接采用；PoC 必须验证 lazyEntries、zip-slip、条目数/展开大小/压缩比/嵌套深度和 abort | 只有产品明确支持 tar/7z 时才在隔离容器评估 libarchive，不维护双 ZIP parser |
| 图片解码与衍生物 | Sharp，`candidate` | File/Export | Apache-2.0；无许可费 | 只在隔离 Worker 处理不可信图片；待验证损坏图、像素炸弹、色彩空间、动画和资源上限 | 无法满足安全/格式门槛时按格式选择一个隔离 decoder，不进 API/Runtime Worker |
| 恶意文件扫描 | ClamAV + 自有 INSTREAM adapter，`integrated` | File/Security | GPL-2.0 service；adapter 自有 | INSTREAM/abort/严格响应已完成；readiness 已校验 clamd 返回的 VERSION、病毒库签名新鲜度和有效 StreamMaxLength，生产占位、不可用、签名过期或 stream limit 不匹配时 fail closed。真实生产 clamd/EICAR E2E 待完成 | 生产 clamd/EICAR 门禁通过后才升为 `adopted`；不采用停更的 Node clamd client 替换已受测薄协议 adapter |
| 对象存储 | AWS SDK v3 S3，`integrated` | File/Export | Apache-2.0；云资源另计 | S3 protocol adapter 已接；进入 `adopted` 前必须指定生产 provider、IAM、版本和真实 multipart/崩溃恢复 E2E | provider 可替换但 S3/Blob 内部合同不变；MinIO 只能是被明确选择的部署或测试夹具 |
| MCP 导出 | `@modelcontextprotocol/sdk@1.30.0` + `@hono/node-server@2.0.12`，`integrated` | Export | MIT；无许可费 | 只读冻结 Release resources/tools、Node HTTP host、隔离构建和归档测试 | SDK 或 HTTP host 合同变化先过固定客户端互操作 fixture |
| PDF 预览 | PDF.js，`candidate` | Web/File | Apache-2.0；无许可费 | 待完成授权 URL、分页、资源上限和浏览器测试；文本抽取不以 PDF.js 为事实源 | 浏览器/包体门槛失败时使用服务端生成的固定页图预览 |
| Design System 表单 | React Hook Form `7.81.0` + `@hookform/resolvers` `5.4.0`，`integrated` | Artifact/Web | MIT；无许可费 | 已承载 `workbench.design-system.v1` 结构化编辑、Zod 校验、catalog/create/import 与 Home/Project 接线；数据库与服务端合同仍是事实源 | React 19、动态字段性能或无障碍门槛失败时只替换表单 adapter，不改变领域文档 |
| 快捷键/虚拟化 | react-hotkeys-hook、TanStack Virtual，`candidate`（未安装、版本未冻结） | Web platform | MIT；无许可费 | 只按实测阈值引入；command 权限、列表游标和服务端状态仍自有 | 小范围原生实现更小时允许不引入，但必须通过 reuse check |
| 可访问性测试 | axe-core，`candidate` | Quality | MPL-2.0；仅测试依赖，需书面例外 | CI/Playwright 只保存规则结果，不进入运行包 | 许可证例外未批准前不安装；备选为人工 WCAG + Testing Library 规则集 |
| 可观测性 | OpenTelemetry API/SDK + OTLP HTTP/protobuf，`integrated`；结构化 Pino 日志仍待接 | Platform | Apache-2.0；collector/托管后端另计 | BFF/API HTTP server/client、pg-boss producer/consumer、DeerFlow/Docling/TEI 已传播 W3C context；队列只保存 traceparent/tracestate，禁 baggage/token，未配置 endpoint 时不联网 | 真实 collector 的父子链、重试、脱敏、断连和 SIGTERM flush 通过后升为 `adopted`；OTLP 是后端退出协议 |
| 模块边界门禁 | dependency-cruiser `18.1.0` + ESLint restricted imports，`adopted` | Architecture | MIT；无许可费；dependency-cruiser 18 要求 Node 22/24/26+ | direct import 与 transitive reachable 两层规则覆盖产品工作台、Share 和 `lib/workbench`；feature 强制 public entry 与 domain/application/api-adapter 边界。持久 Scene、URL-only pages、Project 动态边及禁止 `key={projectId}` 均有架构测试 | 任何新 Workbench 到旧 chat、AI SDK、SWR、旧错误模型或旧数据层的可达路径立即阻断 |

明确排除：Vercel AI SDK、Dify/Open WebUI/LibreChat/Onlook 整体 fork、tldraw 生产 SDK、BlockNote XL、WebContainers 生产运行时。动效只保留 `framer-motion` 单一入口；升级时必须执行完整视觉回归。
