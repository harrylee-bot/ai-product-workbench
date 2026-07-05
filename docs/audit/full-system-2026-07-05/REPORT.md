# AI Product Workbench 全量系统审计报告

审计日期：2026-07-05
审计方式：本地真实启动 + API/DB/依赖/构建/单测/未用扫描 + 真实浏览器交互验证
审计范围：Web、Nest API、PostgreSQL/Prisma、DeerFlow Gateway、DeerFlow runtime、聊天主链路、后台管理台、分享入口、依赖安全、历史报告噪音、测试数据清理。
外部同步：未同步到飞书/Lark 或任何外部知识库。
线上部署：未执行。本轮只完成本地验证和本地提交准备。

## 1. 最终结论

本地系统已经跑通，关键业务路径和命令级验证均通过。当前不需要保留旧审查报告、旧测试数据或旧 UI 未用模块噪音。

- Web、API、DeerFlow Gateway 三个本地服务均在线。
- 登录、首页、模型显示、移动端首页、聊天发送、后台管理台标签页、分享入口和坏 token 状态均通过真实浏览器验证。
- 普通问答包含“不要生成 PRD”时，不再误触发 `streaming-prd-*` artifact 流，也不会打开右侧 PRD 画布。
- 正向 PRD 生成已通过真实浏览器 smoke：artifact 画布打开、PRD 文档加载成功，轮询接口无 429。
- 前端模型显示来自 `/api/system/health`，当前显示 `workbench-claude`，不再写死旧模型名。
- `npm audit --omit=optional` 为 0 漏洞。
- Web lint、全仓 typecheck、API 全量测试、production build、knip 未用扫描均通过。
- 本轮真实验证创建的一次性用户、会话、消息、运行日志、DeerFlow 绑定、登录审计日志和 `/tmp/ai-workbench-*` 临时文件均已清理。
- 旧报告噪音已删除；当前只保留本报告和本轮截图证据。

## 2. 本地服务状态

| 服务 | 地址 | 验证结果 |
|---|---|---|
| Web | `http://localhost:3000` | 可访问，未登录时按预期跳转 `/login?next=%2F` |
| API | `http://localhost:4000/api/system/health` | `ok=true`，phase 为 `deerflow-first-runtime` |
| DeerFlow Gateway | `http://127.0.0.1:8001/health` | `status=healthy` |

API health 关键返回：

```json
{
  "ok": true,
  "service": "ai-product-workbench-api",
  "phase": "deerflow-first-runtime",
  "deerflow": {
    "enabled": true,
    "modelId": "deerflow/workbench-claude",
    "modelName": "workbench-claude",
    "runtimeName": "ai-product-workbench-lead",
    "provider": "deerflow"
  }
}
```

## 3. 本轮修复项

| 优先级 | 问题 | 处理结果 |
|---|---|---|
| P1 | 普通聊天误触发 PRD 文档流 | 后端 document stream intent 改为真实生成意图触发，并识别“不要/别/不需要生成 PRD”等否定意图；前端 artifact 只在收到明确 artifact 控制事件后打开。 |
| P1 | 前端模型名硬编码 | 前端改为读取 API health 的 DeerFlow runtime model，当前显示 `workbench-claude`。 |
| P1 | 依赖安全漏洞 | 升级/覆盖 Next、PostCSS、Multer、Vite、esbuild；安全审计 0 漏洞。 |
| P2 | `GET /api/messages` 空 query 语义错误 | 缺少 `conversationId` 时返回明确 400。 |
| P2 | 登录/注册/后台密码框浏览器提示 | 补齐 `current-password` / `new-password` autocomplete。 |
| P2 | 移动端推荐操作按钮横向溢出 | `SuggestedActions` 改为移动端单列 grid，按钮允许换行，390px 视口无横向溢出。 |
| P2 | 长耗时 PRD 生成轮询打到 429 | `messages` 与 `runtime-status` 轮询间隔从 2 秒降到 4 秒；后端对这两个已鉴权读接口单独提高默认限流到 240/min。 |
| P2 | 正向 PRD 流暴露内部工具大段输出 | 成功工具默认折叠，只在错误或需确认时展开，避免 `read_file` 等内部执行内容污染用户主流程。 |
| P2 | Web UI 未用文件/导出噪音 | 删除未用 UI 文件，收窄 `command.tsx` 未用导出；knip 无输出。 |
| P2 | 历史报告和旧架构文档噪音 | 删除旧审查报告、旧 QA/参考文档、旧 KB/Project/Product 说明文档。 |
| P3 | 旧阶段命名 | Auth 类型从 `Phase1*` 收敛到 `AuthenticatedUser` / `AuthJwtPayload`。 |

## 4. 浏览器验证证据

证据目录：`docs/audit/full-system-2026-07-05/screenshots/`

| 文件 | 场景 | 结论 |
|---|---|---|
| `01-login.jpg` | 登录页 | 邮箱、密码、提交入口正常，未见前端错误。 |
| `02-home-desktop.jpg` | 桌面首页 | 登录后首页可用，模型显示 `workbench-claude`。 |
| `03-home-mobile.png` | 390 x 844 移动端首页 | 标题、副标题、推荐动作、输入框均在视口内，无横向溢出。 |
| `04-admin-overview.jpg` | 后台总览 | 后台框架、统计卡片、系统健康区域加载正常。 |
| `05-admin-users.jpg` | 用户管理 | 用户表格、角色/状态信息加载正常。截图中的一次性审计账号已在验证后删除。 |
| `06-admin-conversations.jpg` | 对话管理 | 对话页可进入，空/数据状态无异常。 |
| `07-admin-models-skills.jpg` | 模型与 Skill | 模型与 Skill 页可进入，未见渲染错误。 |
| `08-admin-knowledge.jpg` | 知识库 | 知识库状态和管理区可进入。 |
| `09-admin-runs.jpg` | 运行日志 | 运行日志页可进入。 |
| `10-admin-audit.jpg` | 审计日志 | 审计日志页可进入。 |
| `11-chat-no-prd-artifact.jpg` | 普通聊天否定 PRD 生成 | DeerFlow 返回“系统当前在线，运行正常”；artifact 容器宽度为 0。 |
| `12-share-index.jpg` | `/share` | 返回受控“无效的分享链接”状态。 |
| `13-share-invalid-token.jpg` | `/share/bad-token` | 返回受控 404 加载失败状态，无前端异常。 |
| `14-prd-positive-artifact.png` | 正向 PRD 生成 | PRD artifact 画布打开，文档内容加载成功，内部工具结果默认折叠。 |

关键浏览器断言：

- 移动端 390px：`documentElement.scrollWidth=390`，`clientWidth=390`，推荐按钮 `overflowingButtons=[]`。
- 聊天回归：可见文本中无 404、无 `streaming-prd`、无 `/api/prd-documents`；`[data-testid="artifact"]` 宽度为 0。
- 后台标签页：总览、用户、对话、模型与 Skill、知识库、运行日志、审计均可点击进入，console error/warn 为 0。
- 分享边界页：无 `TypeError`、`ReferenceError`、`Unhandled`、`Cannot read properties` 或 500 文本。
- 正向 PRD：artifact 宽度约 691px，页面包含“需求说明书”；干净浏览器会话 35 秒内 console error 为 0，相关 API 请求均为 200。

## 5. 产品路径审计

| 步骤 | 用户路径 | 健康状态 |
|---|---|---|
| 1 | 未登录访问 Web | 正常跳转登录页，登录页信息架构清楚。 |
| 2 | 审计账号登录 | 成功进入工作台，身份和模型状态显示正常。 |
| 3 | 桌面首页 | 推荐动作、输入区、模型选择器可见，适合作为工作台首屏。 |
| 4 | 移动端首页 | 修复后推荐动作单列展示，无横向滑动负担。 |
| 5 | 普通聊天 | DeerFlow 能返回在线状态，普通问答不会误开 PRD artifact。 |
| 6 | 正向 PRD 生成 | 文档生成后右侧画布打开，PRD 文档可阅读；QA 状态显示“未通过”，属于当前生成质量结果而非前端崩溃。 |
| 7 | 后台总览 | 系统健康、统计信息和模块入口清楚。 |
| 8 | 后台子模块 | 用户、对话、模型与 Skill、知识库、运行日志、审计页均能进入。 |
| 9 | 分享入口 | 缺 token 和坏 token 都是可控错误态。 |
| 10 | 清理测试数据 | 数据库维度清理到 0 剩余，临时文件清理完成。 |

## 6. 自动化验证结果

| 命令 | 结果 |
|---|---|
| `npm --workspace @ai-product-workbench/web run lint` | 通过，无 warning 输出 |
| `npm run typecheck` | 通过，API + Web TypeScript 均通过 |
| `npm --workspace @ai-product-workbench/api run test` | 通过，32 个测试文件 passed、1 skipped；155 passed、1 skipped |
| `npm run build` | 通过，API `tsc` + Next 16.2.10 production build 成功 |
| `npm_config_registry=https://registry.npmjs.org npm audit --omit=optional` | 通过，0 vulnerabilities |
| `npx --yes knip --include files,dependencies,devDependencies,exports,types --workspace apps/web --workspace apps/api` | 通过，无未用文件/导出输出 |

## 7. 业务架构审计

当前系统主线已经收敛到 Conversation-first + DeerFlow-first：

- Auth：用户、JWT cookie、登录注册、登录审计。
- Conversation/Message：对话、消息、历史列表和投票/评论。
- Aichat Stream：用户消息、附件、知识检索、DeerFlow runtime、运行日志和最终动作落库。
- DeerFlow Runtime：agent workflow、final action contract、artifact 拉取。
- RequirementDocument / Prototype / QA / Rollback / Share：PRD、原型、质量门禁、回滚和分享链路。
- Admin：用户、对话、运行日志、知识库、模型网关、DeerFlow Skill 管理。
- System health：向前端暴露真实运行时模型，避免前端自行臆造模型名。

关键业务规则：

- “生成/编写/起草 PRD”属于文档生成意图。
- “这份需求文档有哪些风险？”、“不要生成 PRD，只回答状态”属于普通问答或分析意图。
- 前端只有收到明确 artifact 控制事件后才打开右侧画布，普通 `data-textDelta` 不再单独触发画布。
- 长耗时生成期间，状态/消息读接口不应被普通业务限流打断；当前使用低频轮询 + 后端读接口专用配额。
- 工具执行细节保留在折叠面板中，用户默认看到业务结果和简洁状态，不直接暴露内部 runtime skill 内容。

## 8. 未用模块和噪音清理

已删除或确认清理：

- 旧审查报告：`docs/archive/2026-07-audit/`。
- 旧 QA/参考文档：`design-qa.md`、`docs/qa/`、`docs/reference/`。
- 旧 KB/Project/Product 说明文档：`docs/handoff-vibe-coding-2026-06-27.md`、`docs/kb-integration-guide.md`、`docs/kb-redesign.md`、`docs/frontend-cleanup-codex.md`。
- Web 未用 UI 文件：`button-group.tsx`、`hover-card.tsx`、`scroll-area.tsx`、`skeleton.tsx`。
- `command.tsx` 未用导出：`CommandEmpty`、`CommandShortcut`、`CommandSeparator`。
- 部署默认模型不再写死旧模型名。
- `.playwright-cli` 和 `/tmp/ai-workbench-*` 临时文件已删除。

当前扫描结果：

- `knip` 无未用文件/依赖/导出输出。
- `docs` 内报告类文件只剩本轮报告和截图证据。
- 历史 Prisma migration 中的旧命名不建议重写，属于数据库历史链路，不作为本轮噪音删除对象。

## 9. 数据清理结果

本轮真实验证创建的一次性用户已清理。清理后计数：

| 数据类型 | 剩余数量 |
|---|---:|
| users | 0 |
| loginAuditLogs | 0 |
| conversations | 0 |
| messages | 0 |
| runtimeRuns | 0 |
| deerFlowBindings | 0 |
| designStates | 0 |
| requirementDocuments | 0 |
| requirementDocumentVersions | 0 |
| qaReports | 0 |
| shareLinks | 0 |

清理对象：

- 测试会话：`d9c11066-0e67-45c4-8065-f2ff8fde904c`
- 测试运行：`2e8818a1-7631-4fe1-9f72-61c31271c6f6`
- PRD smoke 会话：`7b25027a-e029-4f9c-a901-e5227079a623`
- PRD smoke 运行：`beeb6925-88f4-4d6c-9a89-1deaec2c6cbb`

## 10. 剩余风险与优化建议

1. 线上部署尚未执行。部署前仍需用生产等价环境变量复测 `/api/system/health`、登录、聊天 stream、后台 health、分享路由。
2. PRD 正向生成已浏览器验证，但原型生成、QA gate 修复、导出、分享创建仍建议作为上线前写入型 smoke 单独执行，并在完成后清理生成物。
3. 后台截图证据中的一次性审计账号是验证时状态，数据库中已删除；后续若要保存长期产品截图，建议使用专门的匿名演示账号或脱敏截图。
4. 继续保持“artifact 控制事件为唯一开画布入口”的约束，避免未来新增 stream event 时绕过该契约。
5. 对 DeerFlow runtime 可以补一个端到端 contract test：普通问答、否定文档生成、正向 PRD 生成分别断言 final action 和 artifact 控制事件。

## 11. 上线前建议顺序

1. 保持本地三服务启动：Web、API、DeerFlow Gateway。
2. 再跑一次本地验证：lint、typecheck、API test、build、audit、knip。
3. 跑写入型 smoke：PRD 生成、原型生成、QA gate、分享创建。
4. 清理 smoke 数据。
5. 再推送远端并部署。
6. 线上只读 smoke：health、login、chat stream、runtime status、messages、admin health。
7. 线上写入 smoke：PRD、prototype、QA、share，并记录回滚点。

## 12. 当前可访问地址

- Web：`http://localhost:3000`
- API Health：`http://localhost:4000/api/system/health`
- DeerFlow Health：`http://127.0.0.1:8001/health`
