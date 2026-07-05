# AI Product Workbench / DeerFlow 全量系统审计报告

审计日期：2026-07-05
审计方式：本地真实启动 + API/DB/依赖/构建/单测/未用扫描 + Playwright 真实浏览器交互验证
审计范围：Web、Nest API、PostgreSQL/Prisma、DeerFlow Gateway、DeerFlow runtime、聊天主链路、PRD/原型/QA/导出/分享、后台管理台、测试数据和历史报告噪音。
外部同步：未同步到飞书/Lark 或任何外部知识库。
线上部署：未执行。本轮只完成本地审计、修复、验证和报告归档。

## 1. 最终结论

本地系统已完成一轮全量对抗审计和真实验证。结论是：核心本地链路可运行，关键回归已修复，导出/分享/原型 iframe 这类此前隐藏较深的产品链路已补齐真实验证；测试数据和临时浏览器输出已清理。

- Web、API、DeerFlow Gateway 均已本地启动并通过 health 验证。
- 登录、首页、移动端首页、聊天、PRD artifact、后台管理台、分享入口、分享登录回跳、分享 PRD 只读、分享原型 iframe、聊天原型 artifact 下载动作均通过真实浏览器验证。
- Word / HTML / Canvas 导出通过 API 级真实下载验证，不再返回 Nest 序列化后的 Buffer JSON。
- 分享链路不再卡在“state 快照缺状态字段导致 SHARE_PRD_NOT_CONFIRMED”的旧状态，改为以数据库正式 PRD 记录为当前来源。
- 原型预览/分享 iframe 已修复 Web CSP、API `X-Frame-Options`、用户 HTML CSP 的冲突。
- `npm audit --omit=optional` 为 0 漏洞。
- Web lint、全仓 typecheck、API 测试、生产 build、knip 未用扫描均通过。
- 本轮创建的 `codex_export_share_*` 临时用户、会话、PRD、原型、QA、分享链接和浏览器临时输出均已删除。

## 2. 本地服务状态

| 服务 | 地址 | 验证结果 |
|---|---|---|
| Web | `http://localhost:3000` | 本地 Next dev server 在线 |
| API | `http://localhost:4000/api/system/health` | `ok=true`，phase 为 `deerflow-first-runtime` |
| DeerFlow Gateway | `http://127.0.0.1:8001/health` | `status=healthy` |

当前 API health 关键返回：

```json
{
  "ok": true,
  "phase": "deerflow-first-runtime",
  "deerflow": {
    "enabled": true,
    "modelId": "deerflow/deerflow-runtime",
    "modelName": "deerflow-runtime",
    "runtimeName": "ai-product-workbench-lead",
    "provider": "deerflow"
  }
}
```

## 3. 本轮新增修复

| 优先级 | 问题 | 修复结果 |
|---|---|---|
| P0 | API dev runtime 使用 `tsx watch` 时 Nest 依赖注入元数据不稳定，导致服务构造参数可能为 `undefined` | API dev 改为 `node --watch -r ts-node/register src/main.ts`，补充 `ts-node` devDependency，本地启动稳定 |
| P0 | 分享创建依赖 `ConversationDesignState.prdDocument` 快照，快照缺 `status` 时误判 PRD 未确认 | `RequirementDocumentService.getCurrentForConversation` 改为先读数据库正式 PRD 指针/最新记录，再校验是否匹配当前 state |
| P0 | 导出接口用 `@Res({ passthrough: true })` 返回 Buffer，Nest 会序列化为 `{"type":"Buffer","data":...}` | 导出控制器统一 `response.send(artifact.buffer)`，Word/HTML/Canvas 均返回真实文件内容 |
| P0 | 分享原型 iframe 被 Web CSP `frame-src` 阻止 | Web CSP 将 API origin 加入 `frame-src`，与 `connect-src` 对齐 |
| P0 | 分享原型 iframe 被 API `X-Frame-Options: SAMEORIGIN` 阻止 | 对用户 HTML 预览/分享路径移除 `X-Frame-Options`，设置 `Cross-Origin-Resource-Policy: cross-origin` |
| P1 | 用户 HTML 预览安全策略散落在 controller 中 | 新增 `user-html-security.ts`，统一 `sandbox` CSP、`frame-ancestors` 和 preview path 判断 |
| P1 | 原型导出/预览只返回片段，下载 HTML 不是完整文档 | 新增 `sanitizePrototypeDocumentHtml`，预览/分享/导出返回完整 `<!doctype html>` 文档 |
| P1 | 原型 sanitizer 若只剩空内容不应被包装成可用页面 | 存储阶段继续使用片段净化，`<script>`-only 内容净化后为空并按坏原型处理 |
| P1 | Canvas 导出遇到缺失 `content` 或 `sourcePaths` 的历史 PRD section 会异常 | Canvas 文本压缩和段落拆分改为容错处理 |
| P1 | 分享页 401 使用 `/login?redirect=`，登录页实际不消费该参数 | 分享页改为 `/login?next=...`，登录页读取并校验 `next` 后回跳 |
| P1 | 分享页移动端标题/徽章可能挤压，原型 iframe 高度固定 | header 改为小屏纵向布局，标题可换行，iframe 使用响应式高度 |
| P1 | 聊天原型 artifact 没有下载入口，且 prototype toolbar 为空导致 actions 整组不可见 | toolbar 允许仅 actions 渲染，原型新增“下载 HTML”，PRD 新增“下载 Word” |
| P1 | artifact 刷新后只按 PRD 文档接口取内容，prototype id 会请求 `/prd-documents/:id` 404 | `useArtifact` 的 SWR key 和取数函数加入 artifact kind |
| P2 | 分享/原型只读注释仍写“免登录” | controller/service 注释改为“需登录、只读” |
| P2 | 回归测试仍验证旧快照优先逻辑 | PRD/Prototype 单测更新为数据库正式记录优先和 sanitizer 空内容契约 |

## 4. 浏览器验证证据

证据目录：`docs/audit/full-system-2026-07-05/screenshots/`

| 文件 | 场景 | 结论 |
|---|---|---|
| `01-login.jpg` | 登录页 | 邮箱、密码、提交入口正常 |
| `02-home-desktop.jpg` | 桌面首页 | 登录后首页可用，模型状态显示正常 |
| `03-home-mobile.png` | 390 x 844 移动端首页 | 无横向溢出，推荐动作可读可点 |
| `04-admin-overview.jpg` | 后台总览 | 系统健康和统计区域加载正常 |
| `05-admin-users.jpg` | 用户管理 | 用户表格可进入；截图里的临时账号已清理 |
| `06-admin-conversations.jpg` | 对话管理 | 页面可进入，列表/空态可控 |
| `07-admin-models-skills.jpg` | 模型与 Skill | 页面可进入，模型/Skill 区域加载正常 |
| `08-admin-knowledge.jpg` | 知识库 | 知识库管理页可进入 |
| `09-admin-runs.jpg` | 运行日志 | 运行日志页可进入 |
| `10-admin-audit.jpg` | 审计日志 | 审计日志页可进入 |
| `11-chat-no-prd-artifact.jpg` | 普通聊天否定 PRD 生成 | 未误开 PRD artifact |
| `12-share-index.jpg` | `/share` | 返回受控“无效的分享链接”状态 |
| `13-share-invalid-token.jpg` | `/share/bad-token` | 返回受控 404 加载失败状态 |
| `14-prd-positive-artifact.png` | 正向 PRD 生成 | PRD artifact 打开且文档可读 |
| `15-share-login-redirect.png` | 未登录访问分享链接 | 跳转 `/login?next=/share/...` |
| `16-share-prd-readonly.png` | 登录后查看分享 PRD | PRD 只读视图可读，操作状态清晰 |
| `17-share-prototype-iframe.png` | 桌面分享原型 | iframe 成功渲染原型 HTML |
| `18-share-prototype-mobile.png` | 移动端分享原型 | 小屏无明显重叠，原型可查看 |
| `20-chat-artifact-download-actions.png` | 聊天原型 artifact | iframe 正常，复制/下载动作按钮可见 |

## 5. 写入型 Smoke 结果

| 链路 | 验证方式 | 结果 |
|---|---|---|
| Word 导出 | `GET /api/conversations/:id/export/word` | 200，`application/msword`，正文为 HTML Word 文档，不是 Buffer JSON |
| HTML 导出 | `GET /api/conversations/:id/export/html` | 200，`text/html`，以 `<!doctype html>` 开头，包含原型标题和按钮，无 `<script>` |
| Canvas 导出 | `GET /api/conversations/:id/export/canvas` | 200，`application/json`，JSON 包含 `nodes` / `edges` |
| 分享创建 | `POST /api/share-links` | 200，scope=`both`，可解析 PRD 和 prototype |
| 分享解析 | `GET /api/public/share/:token` | 登录后 200，`allowDownload=false`，`allowEdit=false` |
| 分享原型 HTML | `GET /api/public/share/:token/prototype` | 200，`Content-Security-Policy` 含 `sandbox` / `frame-ancestors` |
| 分享登录回跳 | 浏览器访问 `/share/:token` | 未登录跳 login，登录后回原分享页 |
| 聊天 artifact 下载 | 浏览器点击“下载 HTML” | 下载得到 `prototype.html`，内容为完整安全 HTML |

## 6. 产品路径审计

| 步骤 | 产品路径 | 健康状态 | 输出证据 |
|---|---|---|---|
| 1 | 未登录访问 Web 和分享页 | 健康：登录页和分享登录回跳均可控 | `01-login.jpg`、`15-share-login-redirect.png` |
| 2 | 登录后进入工作台 | 健康：桌面首页、模型状态和输入区正常 | `02-home-desktop.jpg` |
| 3 | 移动端首页 | 健康：390px 宽度无横向溢出 | `03-home-mobile.png` |
| 4 | 普通聊天 | 健康：否定 PRD 生成时不误开 artifact | `11-chat-no-prd-artifact.jpg` |
| 5 | 正向 PRD 生成 | 健康：PRD artifact 可打开、内容可读；QA 质量状态由业务结果决定 | `14-prd-positive-artifact.png` |
| 6 | 导出 | 健康：Word/HTML/Canvas 均返回真实文件 | API smoke 输出 |
| 7 | 分享 PRD | 健康：需登录、只读、不可下载/编辑 | `16-share-prd-readonly.png` |
| 8 | 分享原型 | 健康：桌面和移动端 iframe 均可渲染 | `17-share-prototype-iframe.png`、`18-share-prototype-mobile.png` |
| 9 | 聊天原型 artifact | 健康：预览、复制、下载动作可见可用 | `20-chat-artifact-download-actions.png` |
| 10 | 后台管理台 | 健康：总览、用户、对话、模型、知识库、运行日志、审计均可进入 | `04` 到 `10` 截图 |
| 11 | 测试数据清理 | 健康：本轮临时业务数据清理到 0 | DB 清理输出 |

## 7. 自动化验证结果

| 命令 | 结果 |
|---|---|
| `npm --workspace @ai-product-workbench/web run lint` | 通过，无 warning 输出 |
| `npm run typecheck` | 通过，API + Web TypeScript 均通过 |
| `npm --workspace @ai-product-workbench/api run test` | 通过，32 个测试文件 passed、1 skipped；155 passed、1 skipped |
| `npm run build` | 通过，API `tsc` + Next 16.2.10 production build 成功 |
| `npm_config_registry=https://registry.npmjs.org npm audit --omit=optional` | 通过，0 vulnerabilities |
| `npx --yes knip --include files,dependencies,devDependencies,exports,types --workspace apps/web --workspace apps/api` | 通过，无未用文件/导出输出 |

## 8. 业务架构审计

当前系统主线是 Conversation-first + DeerFlow-first：

- Auth：用户、JWT cookie、登录注册、登录审计。
- Conversation/Message：对话、消息、历史列表、投票、评论。
- Aichat Stream：用户消息、附件、知识检索、DeerFlow runtime、运行日志和最终动作落库。
- DeerFlow Runtime：agent workflow、final action contract、artifact 拉取。
- RequirementDocument / Prototype / QA / Rollback / Share：PRD、原型、质量门禁、回滚、分享。
- Admin：用户、对话、运行日志、知识库、模型网关、DeerFlow Skill 管理。
- System health：向前端暴露真实 runtime 状态，前端不自行臆造模型名。

关键业务规则：

- “生成/编写/起草 PRD”属于文档生成意图。
- “不要生成 PRD，只回答状态”属于普通问答或分析意图。
- 前端只有收到明确 artifact 控制事件后才打开右侧画布。
- PRD/Prototype 当前对象必须来自数据库正式记录，并与当前 ConversationDesignState 匹配；state 内嵌快照只能作为历史上下文，不能作为分享/导出来源。
- 分享访问需登录，只读，不暴露下载/编辑能力。
- 用户 HTML 必须经过 sanitizer + CSP sandbox 双层保护。
- 长耗时生成期间，状态/消息读接口不应被普通限流打断。

## 9. 未用模块和系统噪音

已清理或确认：

- 旧审查报告和旧架构文档噪音已在前序提交删除；当前只保留本轮报告与截图证据。
- Web 未用 UI 文件和旧未用导出已在前序提交删除；本轮 `knip` 无输出。
- 本轮 Playwright 原始临时目录 `output/playwright/full-audit/.playwright-cli` 已删除。
- `/tmp/ai-workbench-*` 与 `codex_export_share_*` 临时文件已删除。
- `apps/web/next-env.d.ts` 的 dev 自动路径变更未纳入提交，避免生成文件噪音。
- 历史 Prisma migration 中的旧命名不建议重写，属于数据库迁移链路，不作为本轮删除对象。

## 10. 数据清理结果

本轮删除的临时数据：

| 数据类型 | 删除数量 |
|---|---:|
| `codex_export_share_*` users | 5 |
| conversations | 5 |
| messages | 1 |
| requirementDocuments | 5 |
| prototypeArtifacts | 5 |
| qaReports | 5 |
| shareLinks | 2 |
| runtimeRuns | 0 |

清理后验证：

| 数据类型 | 剩余数量 |
|---|---:|
| `codex_export_share_*` users | 0 |
| conversations | 0 |
| messages | 0 |
| requirementDocuments | 0 |
| prototypeArtifacts | 0 |
| qaReports | 0 |
| shareLinks | 0 |

保留数据：本地 seed 账号 `admin@example.local`、`zhangsan@example.local`。这两个不是本轮测试噪音。

## 11. 剩余风险与优化建议

1. 线上部署尚未执行。部署前需要确认生产等价环境变量，并复测 health、login、chat stream、PRD、prototype、QA、share。
2. 线上分享 iframe 需要重点复测 CSP：生产 Web origin 必须进入 API `frame-ancestors`，生产 API origin 必须进入 Web `frame-src`。
3. 分享页当前“禁止下载”是产品 UI/接口策略；owner 自己在聊天 artifact 内可以下载 Word/HTML。若未来需要区分“分享接收者下载”，建议增加明确权限字段和测试。
4. 当前原型 sanitizer 禁止 script，复杂交互原型会被降级为静态/表单控件展示。若业务需要可执行交互，应引入独立沙箱域名和更严格的 postMessage contract。
5. API dev runtime 从 `tsx` 切到 `ts-node/register` 是为保证 Nest metadata。后续若想回到 tsx，需要专门验证 decorator metadata 与 DI，而不是只看是否能启动。
6. 浏览器 console 中未登录分享访问会产生预期 401；本地跨源 iframe 还可能出现 origin-keyed agent cluster warning，当前不影响功能，但上线前建议用生产域名复测。

## 12. 上线前建议顺序

1. 保持本地三服务启动：Web、API、DeerFlow Gateway。
2. 本地复跑：lint、typecheck、API test、build、audit、knip。
3. 本地写入型 smoke：PRD、prototype、QA、Word/HTML/Canvas export、share create、share resolve、share iframe。
4. 清理 smoke 数据。
5. 推送远端并部署。
6. 线上只读 smoke：health、login、chat shell、admin health、share invalid token。
7. 线上写入 smoke：PRD、prototype、QA、share，并记录回滚点。

## 13. 当前可访问地址

- Web：`http://localhost:3000`
- API Health：`http://localhost:4000/api/system/health`
- DeerFlow Health：`http://127.0.0.1:8001/health`
