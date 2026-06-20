# AI产品工作台（内测）

当前实现范围覆盖模块 1-4：用户登录与权限、Vibe Coding 工作台页面、项目与会话系统、文件上传与多模态解析。

## 已实现能力

- 模块 1：登录、JWT 鉴权、角色权限、用户管理、前端权限路由。
- 模块 2：用户端工作台三栏布局、项目侧栏、需求对话、PRD/原型/QA 预览、底部吸附输入框、加号扩展菜单。
- 模块 3：Project / Conversation / Message 数据模型，项目创建、列表、搜索、打开、重命名、归档、软删除，默认会话与消息落库。
- 模块 4：FileAsset / FileParseResult / FileChunk 数据模型，项目文件上传、解析状态管理、txt/md/docx/pdf/image/zip/rp 一期解析、附件 chips、消息附件摘要落库。
- 模块 6 预留：`POST /api/ai/vibe/handle-message` 已提供占位实现，会保存用户消息和 AI 回复，并更新项目活跃时间。

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

## 默认账号

| 角色 | 用户名 | 邮箱 | 密码 |
|---|---|---|---|
| 管理员 | admin | admin@example.local | Admin123456 |
| 普通用户 | zhangsan | zhangsan@example.local | User123456 |

## 页面路由

- `/login`：登录页，未登录可访问。
- `/workspace`：AI 产品工作台，登录用户可访问。
- `/admin`：重定向到 `/admin/users`。
- `/admin/users`：用户管理页，仅管理员可访问。
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

文件与附件：

- `POST /api/projects/:projectId/files`
- `GET /api/projects/:projectId/files`
- `GET /api/files/:fileId`
- `GET /api/files/:fileId/parse-result`
- `POST /api/files/:fileId/reparse`
- `DELETE /api/files/:fileId`

模块 4 一期支持 `txt`、`md`、`docx`、`pdf`、`png`、`jpg`、`jpeg`、`zip`、`rp`。单次最多上传 10 个文件，普通文件最大 50MB，图片最大 10MB。图片、扫描版 PDF 和 Axure 页面预览只生成视觉上下文，不在模块 4 中自研 OCR 或调用模型；`.rp` 只作为参考资料保存，不做逆向解析。Zip 解析会做路径穿越、条目数量和解压大小限制。

## 权限规则

- 普通用户只能访问自己的项目、会话和消息。
- 普通用户只能访问自己项目下的文件和解析结果。
- 管理员可以查看所有项目详情、会话、消息、文件和解析状态。
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
