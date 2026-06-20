# AI产品工作台（内测）

当前实现范围覆盖模块 1-12：用户登录与权限、Vibe Coding 工作台页面、项目与会话系统、文件上传与多模态解析、Model Gateway 模型网关、AI Vibe Coding Engine 多 Agent 协作逻辑、ProductDesignState 产品工程状态、PRD 生成与文档预览、HTML 原型生成与预览、局部修改 Patch 系统、知识库与知识沉淀、管理后台与日志。

## 已实现能力

- 模块 1：登录、JWT 鉴权、角色权限、用户管理、前端权限路由。
- 模块 2：用户端工作台三栏布局、项目侧栏、需求对话、PRD/原型/QA 预览、底部吸附输入框、加号扩展菜单。
- 模块 3：Project / Conversation / Message 数据模型，项目创建、列表、搜索、打开、重命名、归档、软删除，默认会话与消息落库。
- 模块 4：FileAsset / FileParseResult / FileChunk 数据模型，项目文件上传、解析状态管理、txt/md/docx/pdf/image/zip/rp 一期解析、附件 chips、消息附件摘要落库。
- 模块 5：ModelProvider / ModelConfig / ModelTaskProfile / ModelCallLog 数据模型，OpenAI-compatible 模型网关、文本生成、JSON 生成、流式输出、超时重试、token usage、调用日志、admin 配置 API、API Key 加密存储与脱敏返回。
- 模块 6：AI Orchestrator 串行调度 Intent、Knowledge、Requirement Analyst、Product Designer、PRD Writer、Prototype Designer、Prototype Code、Patch、QA、Knowledge Extractor；所有 Agent 通过 Model Gateway 调用模型，未配置模型时使用结构化兜底输出；工作台通过 run stream 实时展示 Agent 时间线、PRD、HTML 原型和 QA 结果。
- 模块 7：ProductDesignState / ProductDesignVersion / ProductDesignChangeLog 数据模型，状态创建、查询、更新、PatchOperation、版本快照、回滚、AI 推断确认/否定、澄清问题回答；工作台右侧新增“状态”Tab 展示版本、规则数量、AI 推断和待确认问题。
- 模块 8：RequirementDocument / RequirementDocumentVersion 数据模型，PRD Writer 从 ProductDesignState 渲染 16 个结构化章节，保存 sections / blocks / sourcePaths / tags，支持当前 PRD 查询、详情、预览、确认、版本列表；工作台 PRD 预览展示来源路径、AI 推断、知识库、已确认和待确认标签，并支持段落级定位入口。
- 模块 9：PrototypeSpecRecord / PrototypeArtifact / PrototypeVersion 数据模型，Prototype Designer 从 ProductDesignState 生成 PrototypeSpec，Prototype Code 生成单文件 HTML，保存 artifact 与版本，支持当前原型、详情、text/html 预览、确认、版本列表；工作台原型 Tab 使用 sandbox iframe 预览，支持桌面/移动模式和基于 artifact/page/component 的局部修改选区。
- 模块 10：PatchRecord 数据模型，支持 PRD section / HTML 原型组件 selectedRegion、Patch Agent 影响范围分析、PatchPlan 记录、ProductDesignState PatchOperation 应用、Patch 后重新生成 PRD / PrototypeSpec / HTML、QA 校验、失败恢复、Patch 历史查询、取消和确认入口。
- 模块 11：KnowledgeItem / KnowledgeCategory / KnowledgeTag / KnowledgeVersion / KnowledgeCandidate / KnowledgeRetrievalLog 数据模型，支持管理员创建、编辑、启用/禁用知识，知识分类、标签、类型、版本、候选审核、通过/拒绝/合并；Knowledge Agent 使用 active 知识做关键词检索并写入 ProductDesignState.knowledgeRefs，Patch Agent 检测 strong_rule 冲突，PRD/原型确认后只生成 pending 知识候选，正式入库必须管理员审核。
- 模块 12：AdminLayout / AdminSidebar / AdminTopBar、Dashboard、项目管理、模型管理、知识管理、日志中心和系统审计；新增 AdminAuditLog / AdminAuditTargetType，管理员关键操作写入审计；后台支持用户、项目、模型、知识、Agent Run、模型调用、文件解析、Patch、QA 报告的搜索、筛选、分页与详情查看。

一期规则：空工作台不会自动创建项目。用户需要先点击“新建项目”，再在项目中发送产品需求。

## 技术栈

- 前端：Next.js + React + TypeScript + Tailwind CSS
- 后端：NestJS + TypeScript
- 数据库：PostgreSQL
- ORM：Prisma
- 认证：JWT
- 密码哈希：bcrypt

## 本地启动

```bash
npm install
npm run db:generate
docker compose up -d postgres
npm run db:migrate
npm run db:seed
npm run dev
```

服务地址：

- 前端：http://localhost:3000
- 后端：http://localhost:4000/api

如果工作台提示 `not found`，优先检查 `4000` 端口是否被旧的 mock API 占用。真实后端应提供 `GET /api/system/health`，返回 `service: "ai-product-workbench-api"` 且包含 `projects` 模块。

本地 API 启动不再强制要求 PostgreSQL 已连接，但登录、项目、会话、文件等业务接口仍需要数据库可用。若登录页提示无法连接 API，请先确认 `npm run dev:api` 已启动；若提示数据库不可用，请启动 PostgreSQL 并执行迁移和种子。

模型网关环境变量：

- `MODEL_GATEWAY_ENCRYPTION_KEY`：可选，推荐生产配置。支持 32 字节 base64 或 64 位 hex；未配置时会从 `JWT_SECRET` 派生加密密钥。
- `JWT_SECRET`：生产必须配置稳定值，否则已加密的模型 API Key 可能无法解密。

模块 6/7/8/9/10/11/12 在没有配置 `ModelTaskProfile` 或模型供应商不可用时，会使用确定性结构化兜底结果，保证内测链路可演示；配置模型后，Agent 会优先通过 Model Gateway 生成 JSON 输出，并通过 ProductDesignStateService / RequirementDocumentService / PrototypeService / PatchService / KnowledgeCandidateService 保存状态、文档、原型、Patch 记录、知识候选、版本和变更日志。管理后台只读取这些业务数据和审计日志，不绕过 ProductDesignState 修改普通工作流。

## 服务器部署

当前服务器部署目标：

- Web：http://8.130.160.177:3000/login
- API：http://8.130.160.177:4000/api/system/health

服务器已有 Caddy 占用 `80/443`，因此默认部署只暴露 `3000/4000`，不改动现有 Caddy 站点。部署脚本使用原生 Docker 命令，不依赖 `docker compose` 插件。

首次部署：

```bash
ssh root@8.130.160.177
git clone git@github.com:harrylee-bot/ai-product-workbench.git /opt/ai-product-workbench
cd /opt/ai-product-workbench
APP_HOST=8.130.160.177 \
POSTGRES_PASSWORD=ai_workbench \
JWT_SECRET=replace-with-a-long-random-secret \
MODEL_GATEWAY_ENCRYPTION_KEY=replace-with-a-stable-32-byte-base64-or-64-hex-key \
bash deploy/server-deploy.sh
```

后续每次发布：

```bash
ssh root@8.130.160.177
cd /opt/ai-product-workbench
APP_HOST=8.130.160.177 \
POSTGRES_PASSWORD=ai_workbench \
JWT_SECRET=replace-with-a-long-random-secret \
MODEL_GATEWAY_ENCRYPTION_KEY=replace-with-a-stable-32-byte-base64-or-64-hex-key \
bash deploy/server-deploy.sh
```

如果服务器没有 GitHub 访问凭据，也可以从本机上传代码包到 `/opt/ai-product-workbench` 后执行：

```bash
SKIP_GIT_PULL=1 \
APP_HOST=8.130.160.177 \
POSTGRES_PASSWORD=ai_workbench \
JWT_SECRET=replace-with-a-long-random-secret \
MODEL_GATEWAY_ENCRYPTION_KEY=replace-with-a-stable-32-byte-base64-or-64-hex-key \
bash deploy/server-deploy.sh
```

如果服务器访问 Docker Hub 超时，可临时指定镜像源：

```bash
POSTGRES_IMAGE=docker.1panel.live/library/postgres:16-alpine \
NODE_IMAGE=docker.1panel.live/library/node:22-bookworm-slim \
SKIP_GIT_PULL=1 \
APP_HOST=8.130.160.177 \
POSTGRES_PASSWORD=ai_workbench \
JWT_SECRET=replace-with-a-long-random-secret \
MODEL_GATEWAY_ENCRYPTION_KEY=replace-with-a-stable-32-byte-base64-or-64-hex-key \
bash deploy/server-deploy.sh
```

## 默认账号

| 角色 | 用户名 | 邮箱 | 密码 |
|---|---|---|---|
| 管理员 | admin | admin@example.local | Admin123456 |
| 普通用户 | zhangsan | zhangsan@example.local | User123456 |

## 页面路由

- `/login`：登录页，未登录可访问。
- `/workspace`：AI 产品工作台，登录用户可访问。
- `/admin`：管理后台概览页，仅管理员可访问。
- `/admin/users`：用户管理页，仅管理员可访问。
- `/admin/projects`：项目管理只读页，仅管理员可访问。
- `/admin/model-providers`：模型供应商配置页，仅管理员可访问。
- `/admin/model-configs`：模型配置页，仅管理员可访问。
- `/admin/model-task-profiles`：任务模型映射页，仅管理员可访问。
- `/admin/knowledge/items`：知识条目管理页，仅管理员可访问。
- `/admin/knowledge/candidates`：知识候选审核页，仅管理员可访问。
- `/admin/logs/agent-runs`：Agent Run 日志页，仅管理员可访问。
- `/admin/logs/model-calls`：模型调用日志页，仅管理员可访问。
- `/admin/logs/file-parses`：文件解析日志页，仅管理员可访问。
- `/admin/logs/patches`：Patch 日志页，仅管理员可访问。
- `/admin/logs/qa-reports`：QA 报告页，仅管理员可访问。
- `/admin/audit-logs`：系统审计日志页，仅管理员可访问。
- `/403`：无权限页，登录用户可访问。

## 核心 API

认证与用户：

- `POST /api/auth/login`
- `GET /api/auth/me`
- `POST /api/auth/logout`
- `GET /api/admin/users`
- `POST /api/admin/users`
- `PATCH /api/admin/users/:id`
- `POST /api/admin/users/:id/disable`
- `POST /api/admin/users/:id/enable`
- `POST /api/admin/users/:id/reset-password`

项目、会话与消息：

- `POST /api/projects`
- `GET /api/projects`
- `GET /api/projects/:projectId`
- `PATCH /api/projects/:projectId`
- `POST /api/projects/:projectId/archive`
- `POST /api/projects/:projectId/restore`
- `DELETE /api/projects/:projectId`
- `GET /api/projects/:projectId/conversations`
- `POST /api/projects/:projectId/conversations`
- `POST /api/projects/:projectId/conversations/default`
- `PATCH /api/conversations/:conversationId`
- `DELETE /api/conversations/:conversationId`
- `GET /api/conversations/:conversationId/messages`
- `POST /api/ai/vibe/handle-message`
- `GET /api/ai/vibe/runs/:runId`
- `GET /api/ai/vibe/runs/:runId/stream`
- `GET /api/projects/:projectId/product-design-state`
- `POST /api/projects/:projectId/product-design-state`
- `PATCH /api/product-design-states/:stateId`
- `POST /api/product-design-states/:stateId/apply-patch`
- `POST /api/product-design-states/:stateId/versions`
- `GET /api/product-design-states/:stateId/versions`
- `POST /api/product-design-states/:stateId/rollback`
- `GET /api/product-design-states/:stateId/change-logs`
- `POST /api/product-design-states/:stateId/assumptions/:assumptionId/confirm`
- `POST /api/product-design-states/:stateId/assumptions/:assumptionId/reject`
- `POST /api/product-design-states/:stateId/questions/:questionId/answer`
- `POST /api/projects/:projectId/prd/generate`
- `GET /api/projects/:projectId/prd/current`
- `GET /api/prd-documents/:documentId`
- `GET /api/prd-documents/:documentId/preview`
- `POST /api/prd-documents/:documentId/confirm`
- `GET /api/prd-documents/:documentId/versions`
- `POST /api/projects/:projectId/prototype/generate`
- `GET /api/projects/:projectId/prototype/current`
- `GET /api/prototype-artifacts/:artifactId`
- `GET /api/prototype-artifacts/:artifactId/preview`
- `POST /api/prototype-artifacts/:artifactId/confirm`
- `GET /api/prototype-artifacts/:artifactId/versions`
- `POST /api/projects/:projectId/patches`
- `GET /api/projects/:projectId/patches`
- `GET /api/patches/:patchId`
- `POST /api/patches/:patchId/cancel`
- `POST /api/patches/:patchId/confirm`
- `POST /api/admin/knowledge/items`
- `GET /api/admin/knowledge/items`
- `GET /api/admin/knowledge/items/:knowledgeId`
- `PATCH /api/admin/knowledge/items/:knowledgeId`
- `POST /api/admin/knowledge/items/:knowledgeId/enable`
- `POST /api/admin/knowledge/items/:knowledgeId/disable`
- `POST /api/admin/knowledge/categories`
- `GET /api/admin/knowledge/categories`
- `GET /api/admin/knowledge/candidates`
- `POST /api/admin/knowledge/candidates/:candidateId/approve`
- `POST /api/admin/knowledge/candidates/:candidateId/reject`
- `POST /api/admin/knowledge/candidates/:candidateId/merge`
- `GET /api/admin/dashboard/stats`
- `GET /api/admin/projects`
- `GET /api/admin/projects/:projectId`
- `GET /api/admin/projects/:projectId/runs`
- `GET /api/admin/projects/:projectId/patches`
- `GET /api/admin/projects/:projectId/files`
- `GET /api/admin/projects/:projectId/qa-reports`
- `GET /api/admin/logs/agent-runs`
- `GET /api/admin/logs/agent-runs/:runId`
- `GET /api/admin/logs/model-calls`
- `GET /api/admin/logs/model-calls/:logId`
- `GET /api/admin/logs/file-parses`
- `GET /api/admin/logs/file-parses/:fileId`
- `GET /api/admin/logs/patches`
- `GET /api/admin/logs/patches/:patchId`
- `GET /api/admin/logs/qa-reports`
- `GET /api/admin/logs/qa-reports/:qaReportId`
- `GET /api/admin/audit-logs`

`POST /api/ai/vibe/handle-message` 会立即保存用户消息并返回 `runId`，真实 AI 协作在后台执行。前端使用带 Authorization header 的 fetch stream 连接 `GET /api/ai/vibe/runs/:runId/stream`，按事件实时更新 Agent 时间线和右侧预览。

模块 6/7/8/9/10/11/12 流式事件落库遵守统一事件结构：

```json
{
  "eventType": "agent_started | agent_completed | state_updated | state_version_created | prd_generated | prototype_generated | patch_applied | qa_completed",
  "timestamp": "ISO-8601",
  "projectId": "project id",
  "payload": {}
}
```

模块 7/8/9/10/11/12 核心约束：

- ProductDesignState 是 PRD、PrototypeSpec、HTML 原型和 Patch 的唯一事实源。
- Patch Agent 只能生成作用于 ProductDesignState 的 PatchPlan；服务端会通过 ProductDesignStateService 应用 PatchOperation、递增版本并创建快照。
- PRD 与 PrototypeSpec 只能作为 ProductDesignState 的结构化渲染结果保存，不作为状态源。
- RequirementDocument 必须关联 ProductDesignState id/version，默认包含 16 个结构化章节，章节和 block 保留 sourcePaths 与标签，禁止包含接口、SQL、数据库、代码、部署等研发实现细节。
- PrototypeSpec 必须关联 ProductDesignState id/version；PrototypeArtifact 必须由 PrototypeSpec 渲染生成，单文件 HTML 入库前执行安全扫描，禁止远程脚本、eval、document.cookie、敏感 localStorage、window.parent、iframe 和真实网络请求。
- 原型预览接口返回 `text/html`，前端通过 `<iframe sandbox="allow-scripts">` 展示，不允许表单、弹窗或顶层导航权限。
- PatchRecord 保存 selectedRegion、PatchPlan、operations、before/after ProductDesignState 版本、受影响 PRD/Prototype 产物和执行状态；Patch Agent 只能输出 PatchPlan，PatchOperation 只能作用于 ProductDesignState，Patch 后必须重新生成 PRD/Prototype 并执行 QA，失败时恢复到 Patch 前的 State 与项目产物指针。
- 知识库只检索 `active` 知识；Knowledge Agent 将命中的 strong_rule、default_rule、reference_case、design_pattern、prd_writing_rule、prototype_rule、business_concept 提供给后续 Agent，Product Designer 采用后写入 ProductDesignState.knowledgeRefs。
- 上传文件和 AI 生成内容不会自动成为正式知识；PRD/原型确认后只生成 KnowledgeCandidate，必须管理员 approve 或 merge 后才会进入正式 KnowledgeItem。
- Patch Agent 在局部修改可能违反 strong_rule 时必须将 PatchPlan 标记为 `needsUserConfirmation` 并记录 high risk；即使用户确认继续修改，也不会自动改写知识库。
- QA Agent 只做一致性校验，不直接修改业务数据。
- 所有重要状态变更必须写入 ProductDesignChangeLog，并保留 before / after / reason / runId / messageId。
- 所有 Agent 调用模型必须经过 Model Gateway，并记录 AgentStepLog / ModelCallLog。
- 管理后台只做配置、查看、审核和排查，不直接修改用户项目内容；项目详情、Agent Run、模型调用、文件解析、Patch、QA 报告均为只读排查视图。
- AdminAuditLog 记录管理员关键操作，包含 adminUserId、action、targetType、targetId、detail、ip、userAgent、createdAt；detail 会脱敏 password、apiKey、token、secret、authorization 等敏感字段。
- QA 报告在模块 13 独立模型前，后台从符合事件白名单的 `qa_completed` 事件读取。

文件与附件：

- `POST /api/projects/:projectId/files`
- `GET /api/projects/:projectId/files`
- `GET /api/files/:fileId`
- `GET /api/files/:fileId/parse-result`
- `POST /api/files/:fileId/reparse`
- `DELETE /api/files/:fileId`

模块 4 一期支持 `txt`、`md`、`docx`、`pdf`、`png`、`jpg`、`jpeg`、`zip`、`rp`。单次最多上传 10 个文件，普通文件最大 50MB，图片最大 10MB。图片、扫描版 PDF 和 Axure 页面预览只生成视觉上下文，不在模块 4 中自研 OCR 或调用模型；`.rp` 只作为参考资料保存，不做逆向解析。Zip 解析会做路径穿越、条目数量和解压大小限制。

模型网关：

- `GET /api/admin/model-providers`
- `POST /api/admin/model-providers`
- `PATCH /api/admin/model-providers/:providerId`
- `POST /api/admin/model-providers/:providerId/enable`
- `POST /api/admin/model-providers/:providerId/disable`
- `GET /api/admin/model-configs`
- `POST /api/admin/model-configs`
- `PATCH /api/admin/model-configs/:modelConfigId`
- `GET /api/admin/model-task-profiles`
- `PUT /api/admin/model-task-profiles/:taskType`
- `GET /api/admin/model-call-logs`
- `GET /api/admin/logs/model-calls`
- `GET /api/admin/logs/model-calls/:logId`

模型网关一期支持 OpenAI-compatible `POST /v1/chat/completions`。所有后续 Agent 必须通过 `ModelGatewayService` 调用模型；API Key 入库前加密，接口只返回 `apiKeyMasked` 和 `hasApiKey`，ModelCallLog 只保存输入/输出摘要，不保存完整 prompt。模型配置支持 `supportsStreaming`、`supportsJsonMode`、`supportsMultimodal`、默认 temperature 和 token 上限。

## 权限规则

- 普通用户只能访问自己的项目、会话和消息。
- 普通用户只能访问自己项目下的文件和解析结果。
- 管理员可以查看所有项目详情、会话、消息、文件和解析状态。
- 管理员可以访问 `/admin` 概览、项目只读详情、日志中心和审计日志。
- 模型供应商、模型配置、任务模型配置和模型调用日志接口仅管理员可访问。
- 知识库管理、知识分类、知识候选审核接口仅管理员可访问。
- Dashboard、项目聚合、Agent Run 日志、文件解析日志、Patch 日志、QA 报告、AdminAuditLog 接口仅管理员可访问。
- 普通用户不能查看、配置或获取模型 API Key。
- 一期管理员不直接发送用户项目消息。
- 归档项目默认不出现在项目列表中，归档后不可继续发送消息。
- 删除项目为软删除，默认列表不展示。

## 视觉依据

前端页面按 Product Design 方向 2 实现：登录页与用户端工作台保持连续的浅灰背景、白色卡片、清晰边框、克制控件和高密度内部工具风格。

参考图保存在：

```text
docs/reference/option-2-login-workspace.png
```

实际实现中，`/login` 与 `/workspace` 是独立页面，不会把登录前后状态拼在同一个页面里。
