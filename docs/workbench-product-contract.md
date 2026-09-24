# Workbench 产品合同

本文件定义产品工作台当前的请求、交互、产物、浏览器和发布行为。它是 Web、API、Worker、Preview、Export 与 Runtime 实现的共同验收边界。

## 产品能力

Workbench 提供 Workspace、Project、Thread、Run、Approval、Board、Artifact、ArtifactVersion、Design System、Release、Share、Remix、Import、Knowledge 和 Export。所有跨模块操作都通过版本化合同、授权边界和幂等命令完成。

Run 支持 PRD、Prototype、Redesign、Ideate 和 Edit 等工作流。请求在入口处确定 workflow、artifact targets、source snapshots、design system snapshot、approval 和 runtime model；不允许把不兼容的 artifact kind 混入同一执行请求。

## Web 与浏览器

- 浏览器只持有不透明会话 Cookie，不直接持有内部 API、数据库、对象存储或 Runtime 凭据。
- Web 通过同源 BFF 访问 Workbench API；服务端请求使用内部 API 地址。
- Project 路由、Board、Artifact、Run panel、Approval、Share 和 Export 必须保持稳定的 route ownership、focus、reconnect、loading、empty、error 和 permission 状态。
- Navigation guard 在 Project 切换、浏览器 Back、刷新和 Run 进行中都必须保护未提交状态；离开前的 flush 使用原 idempotency key 和相同请求快照。
- Preview 使用独立 origin、credentialless iframe、严格 CSP、无主站 Cookie 和受限 Blob 读取。

## PRD 与 Prototype

PRD 结果使用版本化 document schema，包含标题、章节、渠道表、流程图、数据口径、安全基线、验收标准和 citation。文档生成中必须展示当前 prompt、阶段、activity、loading、失败、重试和完成状态。

Prototype 结果使用稳定 node id、screen、state、action、binding、asset、token 和 motion 图。Canvas Agent 只能通过 command gateway 改变客户端状态，不能直接写数据库或执行任意 DOM selector。

Document、Prototype、Design System 和导出结果必须绑定不可变 ArtifactVersion；修订、发布、分享和重混不能改变已发布版本的内容。

## 运行与导出

- Run panel 显示 queued、running、stage、activity、approval、cancel、retry、failure 和 terminal result。
- 动效类型由可信 Run kind 和明确 stage 决定，不能从旧 Artifact mode 或空 stage 推断。
- Export 先创建持久化 ExportJob，再由 Export Worker 生成 HTML、React、Figma、DOCX 或其他已启用格式。
- Preview 和下载只读取固定 artifact/release/blob pin；导出完成后提供 checksum、大小、媒体类型和可验证状态。
- 外部发布、分享公开、导出下载和写操作需要明确的用户确认与授权。

## 安全与数据

租户、Workspace、Project、Thread、Run、Artifact、File、KnowledgeRelease 和 ExportJob 必须在 API、Worker、数据库和 Preview 四层执行 scope 校验。上传内容经过大小、媒体类型、checksum、病毒扫描和提取状态校验；外部 URL、GitHub、Figma 和模型工具使用固定版本、受控 egress 和最小权限。

日志、指标、事件、receipt、测试夹具和错误响应不得包含密码、token、Cookie、数据库连接串、用户 prompt、用户文件内容、provider message 或完整事件 payload。

## 发布与验证

发布候选必须使用同一 source commit、不可变镜像 digest、生成合同、OpenAPI、数据库迁移、Knowledge vault 和部署配置。生产启动使用签名 manifest 和 `--no-build`，迁移与 queue policy 变更遵循对应 runbook。

验证至少包括：

```text
OpenAPI、类型检查、单元/集成测试、PostgreSQL 约束、Web smoke、lint、architecture、部署合同、Knowledge vault 审计、镜像清单和生产配置检查。
```

当前实现入口：

- `apps/web/`
- `apps/workbench-api/`
- `apps/workbench-worker/`
- `apps/workbench-preview/`
- `apps/workbench-export-worker/`
- `packages/workbench-contracts/`
- `docs/workbench-visual-baseline.md`
- `docs/workbench-export-preview-architecture.md`
