# 产品工作台架构与实现方案

产品工作台由 Web、Workbench API、PostgreSQL、Runtime Worker、File/Knowledge Worker、Import Worker、Export Worker、Preview 和 Quartz 组成。模块之间通过版本化合同、数据库约束、授权和幂等命令协作。

## 目标拓扑

```text
Browser
  opaque HttpOnly session cookie
       |
Next Web + same-origin BFF
  Better Auth database session
  REST/OpenAPI 3.1 + streamed fetch proxy
       |
Workbench API
  Identity / Workspace / Project / Thread
  Run / SubmissionIntent / Artifact / Board / File / Knowledge / Export
       |
Runtime Worker          File/Knowledge Worker       Export Worker
  DeerFlow adapter       parse / scan / index         render / build / package
       |                       |                            |
PostgreSQL 16 + pgvector + pg-boss
S3-compatible object storage
isolated Preview origin
```

浏览器只持有不透明 session。文件通过签发的 multipart URL 直传对象存储；File Worker 对对象内容执行 checksum 复核、病毒扫描、提取和发布。Preview 使用独立 origin、credentialless iframe、严格 CSP 和受限 Blob 读取。

## 模块职责

| 模块 | 职责 |
| --- | --- |
| Web/BFF | 页面、同源会话、OpenAPI 请求、SSE 代理和 feature 编排。 |
| Workbench API | 身份、Workspace、Project、Thread、Run、Artifact、Board、File、Knowledge、Share 和 Export。 |
| Runtime Worker | DeerFlow 调用、事件提交、Provider State、取消、重试和结果归一化。 |
| File/Knowledge Worker | 文件扫描、解析、分块、Embedding、检索发布和 Blob GC。 |
| Import Worker | 固定 URL、GitHub、Figma 来源，写入不可变 Import Source。 |
| Export Worker | HTML、React、Figma、MCP、DOCX 等导出任务。 |
| Preview | 独立来源渲染、资源读取、RPC 和安全隔离。 |
| Quartz | 发布 `knowledge-vault` 中的正式知识内容。 |

## 领域模型

核心对象为 Workspace、WorkspaceMember、Project、ProjectMember、Thread、Run、RuntimeAttempt、Board、Artifact、ArtifactVersion、DesignSystem、DesignSystemImport、FileAsset、KnowledgeRelease、Share、ProjectRelease、ExportJob 和 ImportSource。

对象之间使用强外键、scope 校验、版本、checksum、ETag、CAS 和 idempotency key 固定关系。ArtifactVersion、Release、Share、Export 和 KnowledgeRelease 使用不可变输入；发布、分享、重混和导出读取固定版本，不读取浮动的可变内容。

## Runtime

Runtime 以 DeerFlow 为唯一模型执行入口。Run 保存 typed workflow、artifact targets、source snapshots、design system snapshot、approval、model 和请求摘要。Worker 通过 `RuntimePort` 适配 DeerFlow，不把 provider 类型泄漏到领域层。

Runtime 事件使用唯一 identity、连续 sequence、payload hash 和 attempt scope。事件、Run effects、RunDraft、Provider State、processed 标记和 cursor 在同一事务提交。Provider State 按 attempt 持久化，正常路径读取投影和增量事件，取消与重试使用 CAS 和幂等键。

## Knowledge

知识发布输入为 `knowledge-vault/` 和 Markdown 明确引用的 `storage/` 文件。发布链路为：

```text
Markdown parse
  -> route / chunk / lexical projection
  -> EmbeddingProfile + RetrievalProfile
  -> KnowledgeRelease(building)
  -> resumable embedding batches
  -> integrity finalizer
  -> KnowledgeRelease(ready)
```

检索使用授权 scope、固定 release/profile pin、PostgreSQL lexical/dense candidate、确定性 RRF、独立 reranker 和 citation locator。Knowledge capability 只在当前 Run 获得授权时可见和可执行。

## Web 与 Prototype

Workbench 使用持久 `(workbench)` layout、`WorkbenchRuntimeProvider` 和 `WorkbenchScene` 管理页面运行时；Home 和 Project page 只负责 URL。领域功能通过 feature 的 `domain/application/api-adapter` 边界接入。

Canvas Agent 只能通过 command gateway 改变客户端状态。PrototypeDocument 使用稳定 node id、screen、state、action、binding、asset、token 和 motion 图。编辑、预览、HTML/React/Figma/MCP 导出共享同一份版本化语义。

PRD document 使用版本化 schema，包含章节、渠道表、流程图、数据口径、安全基线、验收标准和 citation。PRD、Prototype、Design System 和导出结果都绑定 ArtifactVersion。

## 文件与导出

文件链路使用 multipart upload、大小和媒体类型限制、checksum、ClamAV、Docling、提取状态和对象存储权限。Blob GC 只删除没有 byte-owning 引用且超过 grace period 的对象。

Export Worker 负责持久化 ExportJob、渲染、构建、打包、checksum 和下载授权。Preview 不访问主站 Cookie，不执行未验证的主站代码，不允许通过 URL 或 DOM selector 越权读取资源。

## 开源复用边界

- React Flow 负责画布基础能力。
- Radix、shadcn/ui、Lucide 和 Sonner 负责 UI primitive。
- Uppy 负责 multipart 传输状态。
- Tiptap 负责 PRD 编辑器。
- CodeMirror 负责代码和 Diff。
- `openapi-typescript` 与 `openapi-fetch` 负责 API client。
- `eventsource-parser` 负责 SSE framing。
- Docling 负责文档解析。
- PostgreSQL FTS、pgvector、jieba-wasm、TEI 和 reranker 负责 Knowledge 检索。

业务对象、权限、Run 状态机、事件提交、Artifact 版本、Knowledge scope、Preview capability 和导出合同由 Workbench 自己维护。

## 安全边界

租户、Workspace、Project、Thread、Run、File、KnowledgeRelease 和 ExportJob 在 API、Worker、数据库和 Preview 四层执行 scope 校验。日志、指标、receipt、测试夹具和错误响应不得包含凭据、Cookie、数据库连接串、用户 prompt、用户文件内容或 provider message。

生产部署使用签名的不可变镜像 manifest、固定 source commit、数据库迁移、OpenAPI、Knowledge vault 和环境配置。运行时密钥只通过受控环境或 secret store 注入。

## 验证入口

```bash
npm run openapi:check
npm run typecheck
npm run test
npm run audit:knowledge-vault
npm run lint:workbench
npm run architecture:workbench
npm run deployment:images:check
npm run build
```

详细合同见：

- `docs/runtime-database-contract.md`
- `docs/workbench-product-contract.md`
- `docs/workbench-knowledge-retrieval-architecture.md`
- `docs/workbench-export-preview-architecture.md`
- `docs/workbench-visual-baseline.md`
