# Workbench 功能恢复交接

更新时间：2026-08-13 17:37（Asia/Shanghai）

本文记录 2026-08-13 生产功能修复的最终状态、验收证据和仍待验证的功能。安全问题和完整历史排障过程不在本文范围内。

## 1. 当前结论

PRD 生成、持久化、画布渲染和“预览项目”主链路已经恢复，并已在生产环境完成真实用户流程验收。

- 生产项目：`https://aionbench.com/projects/cmsqwdfir0zdfp90718sqmvit`
- 页面模型：`Gemini 3.6`（`gemini-3.6-flash`）
- 成功 Run：`cmsr8gg1h10w0p9078xomp0go`
- DeerFlow external Run：`ae40eadd-76e4-471b-b2df-9a167b66653f`
- ready ArtifactVersion：`cmsr8ny7l00fejt07fn9wpt8w`
- PRD BoardNode：`cmsr8ob4z11bkp907ro7uzbxq`
- 生成文档：`电商订单状态通知设置需求说明书`

原交接中记录的 `RUNTIME_PROVIDER_TEMPORARILY_UNAVAILABLE` 连续失败不再是当前阻塞点。DeerFlow fallback 回退修复已部署，生产请求能够生成新的 external Run 并成功完成。

## 2. 生产验收证据

### 2.1 生成和画布

1. Run `cmsr8gg1h10w0p9078xomp0go` 成功结束。
2. 数据库产生 ready PRD ArtifactVersion `cmsr8ny7l00fejt07fn9wpt8w`。
3. 数据库产生对应 PRD BoardNode `cmsr8ob4z11bkp907ro7uzbxq`。
4. 项目画布显示完整的 `电商订单状态通知设置需求说明书`，Agent 状态显示“运行已完成”。

### 2.2 项目预览

2026-08-13 17:35（Asia/Shanghai）通过已有登录会话完成生产页面验收：

- “预览项目”按钮可用并可正常打开预览。
- 预览头部显示“文档预览”。
- 预览中显示正确的 PRD 标题和完整正文，包含目录、业务规则、流程图、架构图、验收标准、降级方案和安全基线。
- 页面不存在空白或“加载中”状态。
- PRD 使用文档渲染器展示，不创建 Prototype iframe。
- PRD 预览不显示设备切换和二维码控件。

至此，原交接“完成标准”中的五项条件均已满足。

## 3. 本次前端修复

根因是生产 Web 镜像只把已就绪 Prototype 作为预览目标，因此只有 PRD 的项目会禁用“预览项目”。修复后的行为如下：

- 已持久化且 `phase=complete` 的 `documentCanvas` 节点会成为 PRD 预览目标。
- PRD 通过 `WorkbenchArtifactContent` 渲染。
- Prototype 继续使用隔离 iframe 预览，原有设备和二维码功能不变。
- PRD 预览隐藏仅适用于交互原型的设备和二维码控件。

涉及文件：

- `apps/web/components/workbench/workbench-project-preview-overlay.tsx`
- `apps/web/components/workbench/workbench-project-route.tsx`
- `apps/web/components/workbench/workbench-project-preview-overlay.spec.tsx`
- `apps/web/components/workbench/workbench-run-preview.spec.tsx`

验证结果：

- 主工作区：67 项相关测试通过，Web TypeScript 检查通过，ESLint 通过。
- 基于生产提交 `5ccf3993` 的隔离工作树：81 项测试通过，ESLint 通过。
- Docker 干净构建中的 OpenAPI 校验、完整 TypeScript 检查和 Next.js 生产构建全部通过。

## 4. 当前生产基线

- 生产主机：`45.207.206.119`
- Workbench 目录：`/opt/workbench`
- Web 镜像：`workbench-candidate-prd-preview-v7-web:functional-v1`
- Web 镜像摘要：`sha256:aecc91cb9a2ec1e94af29ce3fa4a504bc2b41adac9c730aa7b07e5a6517ebfb2`
- Web 容器：`47b128f3aa950af142658fd207afd36f1c21fdbfa4abf01c30622a1f22335746`
- Worker 镜像摘要：`sha256:bdb7d05050ddf9d462cd4ccec3b88fd77182e6a4f85d0dc0535bc9d73d500549`
- DeerFlow 镜像摘要：`sha256:1e4ccf5fcf826e2ce65311c1048ce5581c2f9bf8d63b6838b78ea8e9c361be3b`

Web 使用 `docker compose up -d --no-deps workbench-web` 单独替换。部署后 Web 为 `healthy`，重启数为 0；API、Worker、DeerFlow、Postgres、Preview、Preview Gateway 以及全部 APITable 容器 ID 均未变化。

不要回退 Worker 的“临时不可用时创建全新 Attempt 和 external Run”修复，也不要回退 DeerFlow fallback 修复。APITable 不在本次功能修复范围内，不要操作。

## 5. 仍待处理或验收

以下事项不影响本次 PRD 主链路恢复结论，但不能据此声明已经可用：

- 运行状态冲突：活动 Run 存在时，旧 Run 的失败状态不应继续作为当前状态展示。成功 Run 页面当前显示正常，但该失败后重试场景尚未完成专项复验或修复。
- PRD 生成成功后的导出和共享完整流程。
- 由已生成 PRD 继续生成 UI/Prototype 的流程。
- Prototype 独立生成、预览和交互。

后续应按上述顺序逐项使用生产隔离项目验收，并分别保留 Run、ArtifactVersion、BoardNode 和用户可见结果证据。
