# AI Product Workbench / DeerFlow 全量系统审计报告

审计日期：2026-07-05
审计方式：本地真实启动 + 线上部署验证 + API/DB/依赖/构建/单测/未用扫描 + Playwright 真实浏览器交互验证
审计范围：Web、Nest API、PostgreSQL/Prisma、DeerFlow Gateway、DeerFlow runtime 状态、聊天主链路、PRD/原型/QA/导出/分享、后台管理台、生产部署链路、测试数据和历史噪音。
外部同步：未同步到飞书/Lark 或任何外部知识库。

## 1. 最终结论

本轮已完成本地和线上两层验证，并把发现的问题按产品链路修复到生产。当前结论：

- 本地 Web/API/DeerFlow Gateway 均已启动，`http://localhost:3000`、`http://localhost:4000/api/system/health`、`http://127.0.0.1:8001/health` 可访问。
- 线上已部署到 `https://aionbench.com`，当前生产代码为 `3d60fa1 fix: complete auth navigation`。
- 线上 API health 正常，DeerFlow 为启用状态，生产模型为 `datatoken-gpt-5-5`。
- 登录、分享登录回跳、聊天页、分享 PRD、分享原型 iframe、导出 Word/HTML/Canvas 已通过真实浏览器和真实 HTTP 验证。
- Word/HTML/Canvas 导出返回真实文件，不再返回 Nest 序列化后的 Buffer JSON。
- 用户 HTML 已形成 sanitizer + CSP sandbox + iframe sandbox 三层防护；线上验证 `script_tags=0`、`onclick_attrs=0`。
- 主仓 `npm audit --omit=optional` 为 0 vulnerabilities；typecheck、API 测试、生产 build、knip 未用扫描均通过。
- 线上 smoke 用户、会话、PRD、原型、QA、分享链接已清理到 0；本地 Playwright 临时目录已删除。

边界说明：线上没有重新发起一次长耗时 DeerFlow 生成任务；本轮线上验证重点放在生产部署、认证、持久化产物、导出、分享和安全渲染闭环。DeerFlow 生成链路在本地 API health 和历史 smoke 中验证过，生产侧已验证 runtime 启用和模型配置可见。

## 2. 本地服务状态

| 服务 | 地址 | 验证结果 |
|---|---|---|
| Web | `http://localhost:3000` | Next dev server 在线，`/login` 返回 200 |
| API | `http://localhost:4000/api/system/health` | `ok=true`，phase=`deerflow-first-runtime` |
| DeerFlow Gateway | `http://127.0.0.1:8001/health` | `{"status":"healthy","service":"deer-flow-gateway"}` |

本地端口状态：

| 端口 | 进程 | 说明 |
|---:|---|---|
| 3000 | `node` | Web dev server |
| 4000 | `node -r ts-node/register src/main.ts` | Nest API |
| 8001 | `uvicorn app.gateway.app` | DeerFlow Gateway |

## 3. 线上部署状态

| 项目 | 结果 |
|---|---|
| 生产分支 | `prod` |
| 已部署 commit | `3d60fa1 fix: complete auth navigation` |
| Web | `https://aionbench.com/login` 可访问 |
| API | `https://aionbench.com/api/system/health` 返回 `ok=true` |
| Knowledge | `https://aionbench.com/knowledge` 可访问 |
| CSP | 生产 Web CSP 不再包含 localhost/127.0.0.1 |

生产 health 关键返回：

```json
{
  "ok": true,
  "phase": "deerflow-first-runtime",
  "deerflow": {
    "enabled": true,
    "modelId": "deerflow/datatoken-gpt-5-5",
    "modelName": "datatoken-gpt-5-5",
    "provider": "deerflow"
  }
}
```

## 4. 本轮关键修复

| 优先级 | 问题 | 修复结果 |
|---|---|---|
| P0 | 生产数据库已迁移记录与真实 schema 漂移，conversation-first 当前代码无法写入旧表结构 | 新增 `20260705044000_backfill_conversation_schema`，回填 conversation/current pointers 和 design state 关联 |
| P0 | 生产旧 `project_id` 等 legacy NOT NULL 约束阻断新 Conversation 写入 | 新增 `20260705045500_relax_legacy_project_columns`，放宽 legacy 字段 NOT NULL |
| P0 | Linux Docker 构建缺 `lightningcss` / Tailwind native optional 包 | 根 `optionalDependencies` 和 lockfile 固定 Linux native 包 |
| P0 | Knowledge Quartz YAML 有 tab，导致生产全量部署启动漂移 | 修复 YAML 和 knowledge entrypoint footer 注入 |
| P0 | `ModelTaskType` 生产 enum 缺 `conversation_planning/conversation_design` | 增加迁移补齐 enum 值 |
| P0 | 导出接口返回 Buffer 被 Nest JSON 序列化 | 导出 controller 改为 `response.send(buffer)` |
| P0 | 分享/原型 iframe 被 Web CSP 与 API `X-Frame-Options` 阻断 | Web `frame-src`、API `X-Frame-Options` 和 CORP 策略调整 |
| P1 | 登录成功后生产页面停在“加载中”，没有完成跳转 | 登录/注册成功后改为受控同源整页跳转，线上 Playwright 已验证 |
| P1 | PRD 当前对象依赖 state 快照，历史快照缺 status 时误判不可分享 | 改为以数据库正式 PRD/current 记录为准 |
| P1 | 原型导出/预览只返回片段，不是完整 HTML 文档 | 新增完整 document sanitizer，输出 `<!doctype html>` |
| P1 | 分享和聊天原型 iframe 仍允许 scripts | 改为严格 `sandbox=""`，配合 HTML sanitizer |
| P1 | 分享登录回跳参数不一致 | 分享页统一跳 `/login?next=/share/...`，登录页校验 `next` |
| P1 | Artifact 刷新只按 PRD 取数，prototype 会误请求 PRD 接口 | `useArtifact` 取数加入 artifact kind |
| P2 | 生产 Web CSP 暴露 localhost 噪音 | production CSP 仅保留生产 origin |
| P2 | 登录 `next` 缺少反斜杠/控制字符防护 | `safeNextPath` 增加反斜杠、控制字符、origin 校验 |
| P2 | API 测试存在不存在的 Prisma enum 假数据 | 测试数据收敛为真实 enum |

## 5. 浏览器验证证据

证据目录：`docs/audit/full-system-2026-07-05/screenshots/`

| 文件 | 场景 | 结论 |
|---|---|---|
| `01-login.jpg` | 本地登录页 | 表单和入口正常 |
| `02-home-desktop.jpg` | 本地桌面首页 | 登录后首页、模型状态和输入区正常 |
| `03-home-mobile.png` | 本地移动端首页 | 390px 宽度无横向溢出 |
| `04-admin-overview.jpg` 到 `10-admin-audit.jpg` | 本地后台管理台 | 总览、用户、对话、模型、知识库、运行日志、审计均可进入 |
| `11-chat-no-prd-artifact.jpg` | 普通聊天否定 PRD 生成 | 未误开 PRD artifact |
| `14-prd-positive-artifact.png` | 正向 PRD artifact | 文档可读 |
| `15-share-login-redirect.png` | 本地未登录访问分享 | 跳转登录并带 `next` |
| `16-share-prd-readonly.png` | 本地分享 PRD | 只读，不提供下载/编辑 |
| `17-share-prototype-iframe.png` | 本地分享原型 | iframe 渲染正常 |
| `18-share-prototype-mobile.png` | 本地移动端分享原型 | 小屏可查看 |
| `21-share-prototype-sandbox.png` | 本地严格 sandbox 后分享原型 | `sandbox=""` 下仍可静态渲染 |
| `22-chat-prototype-sandbox-download.png` | 本地聊天原型 artifact | iframe sandbox，下载动作可见 |
| `23-prod-chat-after-login.png` | 线上登录后聊天页 | 点击登录后跳到目标 chat 页面 |
| `24-prod-share-prototype.png` | 线上分享原型 | iframe 渲染正常，页面只读 |
| `25-prod-share-prd-readonly.png` | 线上分享 PRD | PRD 内容可读，不提供下载/编辑 |
| `26-prod-share-login-redirect.png` | 线上未登录访问分享 | 跳转 `/login?next=/share/...` |

## 6. 线上写入型 Smoke 结果

| 链路 | 验证方式 | 结果 |
|---|---|---|
| 认证 | Playwright 填写线上登录表单 | 201 后跳转 `/chat/cmr7azc8p0002nt30b94pu8xr` |
| Chat shell | Playwright 打开目标会话 | 历史消息、输入区、模型名 `datatoken-gpt-5-5` 可见 |
| Conversation state | `GET /api/conversations/:id/conversation-design-state` | `status=confirmed`，`version=1` |
| PRD current | `GET /api/conversations/:id/prd/current` | `status=confirmed` |
| Prototype current | `GET /api/conversations/:id/prototype/current` | `status=ready` |
| QA gate | `GET /api/conversations/:id/qa/gate` | `status=passed`，`allowExportOrPublish=true`，blocking issues 0 |
| Word 导出 | `GET /api/conversations/:id/export/word` | 200，`application/msword`，12498 bytes |
| HTML 导出 | `GET /api/conversations/:id/export/html` | 200，302 bytes，`doctype=1`，`script_tags=0`，`onclick_attrs=0` |
| Canvas 导出 | `GET /api/conversations/:id/export/canvas` | 200，4347 bytes，JSON `nodes/edges` 可解析 |
| 分享 PRD | Playwright `/share/:token` | 只读 PRD 可读 |
| 分享原型 | Playwright 切换“原型” | iframe `sandbox=""`，原型内容可见 |
| 分享原型 HTML | 带登录 Cookie `GET /api/public/share/:token/prototype` | 200，CSP 含 `sandbox`，无 `<script>` 和 `onclick=` |
| 未登录分享 | Playwright 新会话访问 `/share/:token` | 跳转 `/login?next=/share/...` |

## 7. 自动化验证结果

| 命令 | 结果 |
|---|---|
| `npm --workspace @ai-product-workbench/web run lint` | 通过 |
| `npm run typecheck` | 通过，API + Web TypeScript 均通过 |
| `npm run test` | 通过，33 个测试文件 passed、1 skipped；160 passed、1 skipped |
| `npm run build` | 通过，API `tsc` + Next production build 成功 |
| `npm_config_registry=https://registry.npmjs.org npm audit --omit=optional` | 通过，0 vulnerabilities |
| `npx --yes knip --include files,dependencies,devDependencies,exports,types --workspace apps/web --workspace apps/api` | 通过，无未用文件/依赖/导出输出 |
| `bash -n apps/knowledge/docker-entrypoint.sh deploy/server-deploy.sh deploy/api-entrypoint.sh` | 通过 |
| `ruby -e 'require "yaml"; YAML.load_file(...)'` | Knowledge YAML 可解析 |

## 8. 产品路径审计

| 步骤 | 产品路径 | 健康状态 | 证据 |
|---:|---|---|---|
| 1 | 未登录进入系统 | 健康；登录页可访问，未登录 `/auth/me` 401 是预期入口态噪音 | `01-login.jpg`、`26-prod-share-login-redirect.png` |
| 2 | 登录进入工作台 | 已修复；线上真实登录后可跳转目标 chat | `23-prod-chat-after-login.png` |
| 3 | 对话/消息历史 | 健康；历史消息、输入区、模型名可见 | `23-prod-chat-after-login.png` |
| 4 | PRD 当前文档 | 健康；数据库正式 PRD 为当前来源，不依赖旧 state 快照 | API smoke |
| 5 | Prototype 当前原型 | 健康；ready artifact 可读取，可预览 | API smoke、`24-prod-share-prototype.png` |
| 6 | QA gate | 健康；passed 后允许导出和分享 | API smoke |
| 7 | 导出 | 健康；Word/HTML/Canvas 均为真实文件 | API smoke |
| 8 | 分享登录回跳 | 健康；分享访问要求登录，回跳参数安全 | `26-prod-share-login-redirect.png` |
| 9 | 分享 PRD | 健康；只读、不下载、不编辑 | `25-prod-share-prd-readonly.png` |
| 10 | 分享原型 | 健康；iframe sandbox 严格，静态原型可读 | `24-prod-share-prototype.png` |
| 11 | 后台管理 | 本地健康；主要后台页均可进入 | `04` 到 `10` 截图 |
| 12 | 测试数据清理 | 健康；线上 smoke 用户/会话/分享为 0 | DB 计数 |

可访问性风险：当前截图能确认主要按钮、表单、只读状态和移动端 reflow 没有明显遮挡；但未做完整键盘顺序、读屏语义、对比度数值化和缩放 200% 测试，不能声明完整 WCAG 合规。

## 9. 业务架构审计

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
- 用户 HTML 必须经过 sanitizer + CSP sandbox 双层保护，并由 iframe `sandbox=""` 再隔离一次。
- 长耗时生成期间，状态/消息读接口不应被普通限流打断。

## 10. 未用模块和系统噪音

已清理或确认：

- 旧审查报告和旧架构文档噪音已在前序提交删除；当前只保留本轮报告与截图证据。
- Web 未用 UI 文件和旧未用导出已在前序提交删除；本轮 `knip` 无输出，未发现可直接删除的未用文件/依赖/导出。
- 根目录 `.playwright-cli` 与 `output/playwright` 临时输出已删除。
- `apps/web/next-env.d.ts` 被 Next dev 自动改成 `.next/dev` 的生成噪音已恢复，不纳入提交。
- 线上 `codex_prod_smoke_*` 测试用户、会话、消息、PRD、原型、QA、分享已删除。

仍建议后续处理的系统噪音：

| 噪音 | 当前处理 | 建议 |
|---|---|---|
| 生产 DB 仍保留 `projects`、`products`、`product_design_*` 等 legacy 表/列 | 为避免数据损坏，本轮只回填和放宽约束，未 drop | 完成备份和迁移验收后再做专门清表/删列迁移 |
| `public/share` 命名与“分享需登录”业务规则不一致 | 功能正确，但命名误导 | 后续改为 `shared-content` 或增加显式 `authenticated-share` 命名 |
| 未登录页加载 `/api/auth/me` 会在 console 产生 401 | 预期入口态，不影响功能 | 前端 auth provider 可静默处理 401，降低浏览器噪音 |
| 原型 iframe 有 Origin-Agent-Cluster warning | 不影响渲染和安全 | 后续统一同源页面和 HTML preview 的 OAC 头 |
| Knowledge/Quartz 构建链有 8 个 npm vulnerabilities 和插件 `eval` warning | 主 Web/API audit 为 0；Knowledge 是独立 Quartz 链 | 单独升级 Quartz/plugin 或替换 warning 插件 |

## 11. 数据清理结果

线上清理事务删除结果：

| 数据类型 | 删除数量 |
|---|---:|
| users | 1 |
| conversations | 1 |
| messages | 4 |
| conversation_design_states | 1 |
| requirement_documents | 1 |
| prototype_artifacts | 1 |
| prototype_spec_records | 1 |
| qa_reports | 1 |
| share_links | 1 |
| 其他关联表 | 0 |

清理后生产计数：

| 查询 | 剩余数量 |
|---|---:|
| `codex_prod_smoke_%` users | 0 |
| `Codex 线上冒烟%` conversations | 0 |
| `codex_%` share_links | 0 |

## 12. 剩余风险与优化建议

1. 生产仍有 legacy project/product 表结构，需要单独的“备份 -> 核对 -> 删除”迁移，不建议在本轮直接 drop。
2. 分享当前是“登录后只读分享”，不是免登录公开分享；如果产品目标改成外部免登录分享，需要重新设计 token 权限、速率限制、审计、撤销和 iframe cookie 策略。
3. 目前原型 sanitizer 禁止脚本，复杂交互原型会退化成静态 HTML；若要支持可执行交互，建议独立 sandbox 子域名 + postMessage contract。
4. 后台管理台本轮验证了可进入和加载，未逐项做管理动作写入测试；上线前重大权限变更应补 admin E2E。
5. Knowledge/Quartz 依赖链需要单独安全升级，不能用主 Web/API 的 0 漏洞结论覆盖。
6. GitHub `origin` 推送此前多次超时，服务器 `prod` remote 已成功；需要网络稳定时再补推 GitHub。

## 13. 当前可访问地址

- 本地 Web：`http://localhost:3000`
- 本地 API Health：`http://localhost:4000/api/system/health`
- 本地 DeerFlow Gateway：`http://127.0.0.1:8001/health`
- 线上 Web：`https://aionbench.com`
- 线上 API Health：`https://aionbench.com/api/system/health`
- 线上 Knowledge：`https://aionbench.com/knowledge`
