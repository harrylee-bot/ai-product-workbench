# AI Product Workbench / DeerFlow 全量系统审计报告

审计日期：2026-07-05
审计方式：本地真实启动、真实浏览器交互、API/DB/迁移/构建/单测/依赖/未用扫描、生产部署复验
审计范围：Web、Nest API、PostgreSQL/Prisma、DeerFlow Gateway、聊天主链路、PRD/原型/QA/导出/分享、后台管理台、Knowledge 站点、部署脚本、历史噪音和测试数据。
外部同步：未同步到飞书/Lark 或任何外部知识库。

## 1. 最终结论

本轮完成了本地和生产两层验证，并把发现的问题修复到线上。当前系统可以按 Conversation-first + DeerFlow Gateway-first 的路径运行：

- 本地 Web、API、DeerFlow Gateway 已启动：`http://localhost:3000`、`http://localhost:4000`、`http://127.0.0.1:8001`。
- 本地 LangGraph 2024 直连服务已停止，Workbench 现在默认走 DeerFlow Gateway `/api`。
- 本地真实浏览器完成注册、登录后首页、聊天流式回复、未登录分享登录回跳，控制台 0 warning/error。
- 本地测试数据已清理：测试用户、会话、消息、运行日志、流事件、DeerFlow 线程绑定全部反查为 0。
- 生产已部署到 `https://aionbench.com`，生产服务器 HEAD 为 `5e02584`。
- 生产 API health 正常，DeerFlow 启用，线上模型为 `datatoken-gpt-5-5`。
- 生产 `public/share` 旧误导路由已变为 404，新的 `authenticated-share` 未登录返回 401。
- 生产 `share_links.product_design_state_id` 残留列已删除，旧 `projects/products/product_design_*` 表、旧列、旧 enum 类型扫描均为空。
- 主 Web/API 依赖审计为 0 vulnerabilities，Knip 未发现可直接删除的未用文件、依赖、导出或类型。

本轮没有在生产重新发起长耗时 DeerFlow 生成任务，避免再次写入 smoke 数据和产生额外成本；DeerFlow 端到端生成通信已在本地真实 Web/API/Gateway 链路中验证。

## 2. 当前运行状态

| 层级 | 项目 | 当前结果 |
|---|---|---|
| 本地 Web | `http://localhost:3000` | Next dev server 在线 |
| 本地 API | `http://localhost:4000/api/system/health` | `ok=true`，phase=`deerflow-first-runtime` |
| 本地 DeerFlow Gateway | `127.0.0.1:8001` | 在线，Workbench 默认访问 `/api` |
| 本地 LangGraph direct | `2024` | 已停止，避免双 runtime 噪音 |
| 生产 Web | `https://aionbench.com/login` | 可访问，OAC header 已存在 |
| 生产 API | `https://aionbench.com/api/system/health` | `ok=true` |
| 生产 Knowledge | `https://aionbench.com/knowledge` | 200 |
| 生产容器 | API/Web/Postgres/Knowledge | 均 Up，Postgres healthy |

生产 health 关键结果：

```json
{
  "ok": true,
  "phase": "deerflow-first-runtime",
  "deerflow": {
    "enabled": true,
    "modelId": "deerflow/datatoken-gpt-5-5",
    "modelName": "datatoken-gpt-5-5",
    "runtimeName": "ai-product-workbench-lead",
    "provider": "deerflow"
  }
}
```

## 3. 质量门禁

| 验证项 | 命令或方式 | 结果 |
|---|---|---|
| Web lint | `npm --workspace @ai-product-workbench/web run lint` | 通过 |
| TypeScript | `npm run typecheck` | API + Web 通过 |
| API 单测 | `npm run test` | 33 个测试文件 passed、1 skipped；163 passed、1 skipped |
| 生产构建 | `npm run build` | API `tsc` + Next production build 通过 |
| 主依赖审计 | `npm_config_registry=https://registry.npmjs.org npm audit --omit=optional` | 0 vulnerabilities |
| 未用扫描 | `npx --yes knip --include files,dependencies,devDependencies,exports,types --workspace apps/web --workspace apps/api` | 无输出 |
| Prisma 当前库 | `prisma migrate status`、`prisma validate` | 38 条迁移，schema valid |
| 空库迁移重放 | 临时 PostgreSQL 数据库从零 `migrate deploy` | 38 条迁移全部成功 |
| 空库 legacy 扫描 | 表/列扫描 | `legacy_columns=[]`，`legacy_tables=[]` |
| Diff hygiene | `git diff --check` | 通过 |

## 4. 本地真实浏览器验证

证据目录：`docs/audit/full-system-2026-07-05/screenshots/`

| 文件 | 步骤 | 健康状态 |
|---|---|---|
| `27-final-local-login.png` | 打开 `/login` | 健康；邮箱、密码、登录、注册链接可识别 |
| `28-final-local-share-login-redirect.png` | 未登录访问 `/share/bad-token` | 健康；跳到 `/login?next=%2Fshare%2Fbad-token`，没有旧分享 401 噪音 |
| `29-final-local-home-authenticated.png` | UI 注册后进入首页 | 健康；`POST /api/auth/register` 201，首页输入区和模型状态可见 |
| `30-final-local-chat-deerflow.png` | 发送聊天消息 | 健康；`POST /api/chat/stream` 200，页面收到 “DeerFlow 通信正常。” |

本地浏览器请求和控制台结果：

- 注册后请求：`/api/auth/register` 201，`/api/conversations` 200。
- 聊天请求：`/api/chat/stream` 200，消息列表和 runtime-status 均 200。
- 未登录分享请求：只打 `/api/auth/session`，没有请求旧 `/api/public/share`。
- 控制台：关键流程 warning/error 均为 0。

本地测试数据清理结果：

| 查询 | 剩余数量 |
|---|---:|
| `users_by_email` | 0 |
| `conversations_by_title` | 0 |
| `messages_by_prompt` | 0 |
| `agent_run_logs_by_named_conversation` | 0 |
| `vibe_events_by_named_conversation` | 0 |
| `deerflow_bindings_by_named_conversation` | 0 |

DeerFlow Gateway 临时线程删除返回 200；`.playwright-cli`、`output/playwright` 和 `/tmp/ai-workbench-audit-email.txt` 均已删除。

## 5. 生产部署复验

| 验证项 | 结果 |
|---|---|
| 生产服务器 HEAD | `5e02584` |
| API 容器 | 已重建并启动 |
| API health | `ok=true`，DeerFlow enabled |
| `/api/auth/session` | 200，正文 `{"user":null}` |
| `/api/public/share/bad` | 404 |
| `/api/authenticated-share/bad` | 401 |
| `/login` headers | `Origin-Agent-Cluster: ?1`，生产 CSP 无 localhost |
| Knowledge | 200 |
| API 启动日志 | `AuthenticatedShareController {/api/authenticated-share}` 已映射，Nest started |

生产 DB 复验：

| 检查 | 结果 |
|---|---|
| 新迁移记录 | `20260705061000_drop_share_link_legacy_state_column` 已在 `_prisma_migrations` |
| `share_links.product_design_state_id` | 0 |
| legacy 列扫描 | 无 `project_id`、`source_product_id`、`%product_design%` 旧列 |
| legacy 表扫描 | 无 `projects`、`products`、`product_design_states`、`product_design_versions`、`product_design_change_logs` |
| legacy enum 扫描 | 无 `ProductDesignChangeType`、`ProductDesignStateStatus`、`ProjectStatus` |
| 生产 smoke users | 0 |
| 生产 smoke conversations | 0 |
| 生产 smoke share_links | 0 |

生产破坏性迁移前已备份：

```text
/opt/ai-product-workbench/backups/ai_product_workbench_20260705134258_before_legacy_drop.dump
```

## 6. 本轮修复清单

| 优先级 | 问题 | 修复 |
|---|---|---|
| P0 | 生产和本地 schema 有旧 project/product/product-design 物理结构噪音 | 增加 legacy drop 迁移，生产备份后执行并复验 |
| P0 | 生产 `share_links.product_design_state_id` 残留列未被第一条 legacy 迁移覆盖 | 新增 `20260705061000_drop_share_link_legacy_state_column` 幂等删除 |
| P1 | 未登录页面用 `/auth/me` 造成 401 控制台噪音 | 增加 `/api/auth/session` 静默会话接口，前端 AuthProvider 改用 session |
| P1 | 分享需要登录，但 API 路由名叫 `public/share`，与业务规则冲突 | 后端改为 `authenticated-share`，前端 fetch/iframe 同步更新 |
| P1 | 未登录访问分享页会先请求分享 API，造成无意义 401 | 分享客户端等待 auth session，未登录先跳 `/login?next=...` |
| P1 | DeerFlow 默认仍指向 `localhost:2024`，与当前 Gateway 架构不一致 | 默认改为 `http://localhost:8001/api`，生产改为 `host.docker.internal:8001/api` |
| P1 | Origin-Agent-Cluster warning | Web 增加 `Origin-Agent-Cluster: ?1` |
| P2 | 回放迁移时 legacy backfill 对已删除表不够宽容 | 回填迁移和 relax 迁移增加存在性保护 |

## 7. 产品架构和业务逻辑审计

当前产品主线是 Conversation-first：

1. Auth 建立用户和安全 cookie。
2. Conversation/Message 作为所有工作流的归属根。
3. Aichat Stream 接收用户意图、附件和上下文，写入运行日志。
4. DeerFlow Gateway 提供 LangGraph-compatible `/api`，Workbench 不再直连 2024。
5. DeerFlow final action 驱动 PRD、Prototype、QA、Knowledge 等正式记录。
6. ShareLink 只绑定 conversation、PRD、prototype 和 conversation design state，不再依赖旧 product design state。
7. 分享页是登录后只读分享，不是免登录公开链接。

关键业务规则审计结果：

| 业务规则 | 状态 |
|---|---|
| 普通聊天不应误开 PRD artifact | 已有截图和单测覆盖 |
| PRD/Prototype 当前对象以数据库正式记录为准 | 通过架构检查和既有 smoke 验证 |
| QA gate 通过后才允许导出和分享 | 既有线上 smoke 验证通过 |
| 分享链接需登录、只读、不暴露编辑/下载动作 | 本地和线上截图验证通过 |
| 用户 HTML 必须经过 sanitizer、CSP sandbox、iframe sandbox | 既有线上 smoke 和安全单测覆盖 |
| 前端模型名来自 API health/runtime 状态 | 本地、生产 health 均验证 |
| 后台管理台能加载关键视图 | 本轮保留 04 到 10 号截图证据 |

## 8. 未用模块与系统噪音

已清理或确认无需继续保留：

- 旧 project/product/product-design 表、列、enum 已从生产库删除。
- `share_links.product_design_state_id` 生产残留列已删除。
- `public/share` 误导 API 命名已移除，旧 route 返回 404。
- 未登录 auth 401 噪音已通过 `/auth/session` 消除。
- 本地 Playwright 临时目录和临时测试邮箱文件已删除。
- 本地和生产 smoke/test 数据均已清理到 0。
- 当前只保留本轮报告和截图证据；未发现额外历史审查报告文件。
- Knip 对 Web/API 无未用文件、依赖、devDependencies、exports、types 输出。

仍建议后续单独处理：

| 类型 | 当前状态 | 建议 |
|---|---|---|
| Knowledge/Quartz 依赖链 | 主 Web/API audit 为 0；Knowledge 是独立 Quartz 应用 | 单独升级 Quartz/plugin，不能用主应用审计结果覆盖 |
| 后台管理写操作 | 本轮验证页面加载，未逐项写入 admin 操作 | 补 admin E2E，覆盖用户禁用、模型切换、知识库审批等 |
| 分享产品定位 | 当前是登录后只读分享 | 若要外部免登录分享，需要重新设计 token 权限、审计、撤销和速率限制 |
| 可执行原型 | 当前 sanitizer 禁止脚本，偏静态安全 | 若支持 JS 原型，建议独立 sandbox 子域名 + postMessage contract |
| 完整无障碍 | 截图能看布局和可识别控件，不能证明 WCAG | 补键盘顺序、读屏、对比度、200% 缩放测试 |

## 9. 产品体验审计步骤

| 步骤 | 产品路径 | 健康状态 | 证据 |
|---:|---|---|---|
| 1 | 未登录进入登录页 | 健康 | `27-final-local-login.png` |
| 2 | 未登录访问分享 | 健康；先登录，保留 `next` | `28-final-local-share-login-redirect.png` |
| 3 | 注册后进入工作台 | 健康；首页可输入 | `29-final-local-home-authenticated.png` |
| 4 | 发送普通聊天 | 健康；stream 200，页面出现回复 | `30-final-local-chat-deerflow.png` |
| 5 | 后台管理台浏览 | 健康；主要视图可进入 | `04-admin-overview.jpg` 到 `10-admin-audit.jpg` |
| 6 | PRD artifact | 健康；正向 PRD 可读 | `14-prd-positive-artifact.png` |
| 7 | 分享 PRD | 健康；只读 | `16-share-prd-readonly.png`、`25-prod-share-prd-readonly.png` |
| 8 | 分享原型 | 健康；iframe 可渲染 | `17-share-prototype-iframe.png`、`24-prod-share-prototype.png` |
| 9 | 移动端分享/首页 | 未见明显横向溢出 | `03-home-mobile.png`、`18-share-prototype-mobile.png` |
| 10 | 生产登录后 chat | 健康；线上登录跳转已修复 | `23-prod-chat-after-login.png` |

截图限制：截图可证明可见状态、布局、关键控件和部分交互结果；不能单独证明权限矩阵、读屏体验、键盘路径或所有异常分支。

## 10. 风险和优化建议

1. 将 DeerFlow Gateway 作为唯一默认 runtime 继续固化，避免 2024 direct 和 Gateway 双入口再次漂移。
2. 给 `authenticated-share` 补端到端测试：未登录跳转、登录后可读、旧 `public/share` 404、prototype iframe sandbox。
3. 增加生产迁移前自动 legacy 扫描和迁移后断言，让残留列能在 CI/CD 中被提前发现。
4. 为本地 smoke 测试提供固定清理脚本，统一清理 Workbench DB 和 DeerFlow Gateway 线程。
5. 给后台管理写操作补最小 E2E，尤其是用户状态、模型配置、知识库候选项和运行日志详情。
6. Knowledge/Quartz 作为独立站点做单独安全升级和依赖审计。
7. 若后续允许公开分享或可执行 HTML 原型，应先做 threat model，再改权限和 sandbox 策略。

## 11. 可访问地址

- 本地 Web：`http://localhost:3000`
- 本地 API Health：`http://localhost:4000/api/system/health`
- 本地 DeerFlow Gateway：`http://127.0.0.1:8001/health`
- 线上 Web：`https://aionbench.com`
- 线上 API Health：`https://aionbench.com/api/system/health`
- 线上 Knowledge：`https://aionbench.com/knowledge`
