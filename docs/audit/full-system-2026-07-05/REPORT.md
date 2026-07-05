# AI Product Workbench / DeerFlow 全量系统审计报告

审计日期：2026-07-05
审计方式：本地真实启动、真实浏览器交互、API/DB/迁移/构建/单测/依赖/未用扫描、Knowledge 镜像真实部署复验。
审计范围：Web、Nest API、PostgreSQL/Prisma、DeerFlow Gateway、聊天主链路、PRD/原型/QA/导出/分享、后台管理台、Knowledge 站点、部署脚本、历史噪音和测试数据。
外部同步：未同步到飞书/Lark 或任何外部知识库。

## 1. 最终结论

本轮不是只做静态代码审查，而是按产品架构和业务逻辑做了真实验证，并把验证中暴露的问题继续修到生产：

- 本地 Web/API/DeerFlow Gateway 均在线：`http://localhost:3000`、`http://localhost:4000`、`http://127.0.0.1:8001`。
- 本地 API health 为 `ok=true`，phase 为 `deerflow-first-runtime`，本地 runtime 为 `workbench-claude`。
- 桌面和移动端浏览器真实跑通登录、聊天流式回复、未登录分享登录回跳；console warning/error 为 0。
- 本轮浏览器测试数据已清理：用户、会话、消息、运行日志、知识项、分享链接、DeerFlow 绑定 dry-run 均为 0。
- Web/API 主依赖 `npm audit --omit=optional` 为 0 vulnerabilities。
- TypeScript、单测、生产 build、Web lint、Knip 未用扫描、Prisma validate/status、legacy schema 断言均通过。
- 已删除 DeerFlow-first 后不再写入的旧 `agent_step_logs` 运行步骤表、`AgentName`/`AgentStepStatus` 枚举、API step 查询和前端 `0 步` 展示噪音；当前运行日志只展示真实 `vibe_stream_event_logs` 流事件。
- Web CSP 已收紧：生产态不再允许 `unsafe-eval`，开发态保留 Next dev 必需权限并去重本地 API origin。
- 后台写操作已补真实 smoke：管理员登录、用户创建/禁用/启用/重置密码、模型供应商创建/更新/禁用/启用、模型配置创建/禁用均通过，并自动清理。
- 生产服务器当前 HEAD 为 `0c02341`，Knowledge 容器已重新部署并启动。
- Knowledge Quartz core 固定为 `v5.0.0` / `ab346fa66a895e12d63a308e70ce330ba795822a`，25 个社区插件写入 `quartz.lock.json` 并按 commit 恢复。
- Knowledge 生产本机 `http://127.0.0.1:3001/__health` 200，容器内 `.quartz-source-revision` 为 `ab346fa66a895e12d63a308e70ce330ba795822a`。
- 生产 Knowledge 日志已无 `direct eval`、`CustomOgImagesEmitterName`、`Couldn't parse Quartz configuration` 错误/噪音。

当前仍保留的真实风险：Quartz v5.0.0 自身 `npm ci` 仍报告 11 个上游依赖漏洞；它不属于主 Web/API 依赖树，已在报告第 10 节列为 Knowledge 供应链残留风险。

## 2. 当前运行状态

| 层级 | 项目 | 当前结果 |
|---|---|---|
| 本地 Web | `http://localhost:3000` | Next dev server 在线 |
| 本地 API | `http://localhost:4000/api/system/health` | `ok=true`，phase=`deerflow-first-runtime` |
| 本地 DeerFlow Gateway | `http://127.0.0.1:8001/health` | `{"status":"healthy","service":"deer-flow-gateway"}` |
| 本地 LangGraph direct | `2024` | 未作为默认入口，Workbench 默认走 DeerFlow Gateway `/api` |
| 生产 Web | `https://aionbench.com/login` | 可访问 |
| 生产 API | `https://aionbench.com/api/system/health` | `ok=true`，model=`datatoken-gpt-5-5` |
| 生产 Knowledge | `https://aionbench.com/knowledge/` | 公网 200；CDN 可能命中旧缓存 |
| 生产 Knowledge 本机 | `http://127.0.0.1:3001/__health` | 200，正文 `ok` |
| 生产 Knowledge 容器 | `ai-product-knowledge` | Up，映射 `3001->3000` |

生产 API health 关键结果：

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
| Knowledge pin | `npm run knowledge:assert-pinned` | 通过；Quartz core + 25 个插件 commit 锁定 |
| TypeScript | `npm run typecheck` | API + Web 通过 |
| API 单测 | `npm run test` | 35 个测试文件 passed、1 skipped；169 passed、1 skipped |
| 生产 build | `npm run build` | API clean build + Next production build 通过 |
| Web lint | `npm --workspace @ai-product-workbench/web run lint` | 通过 |
| 未用扫描 | `npx --yes knip --include files,dependencies,devDependencies,exports,types --workspace apps/web --workspace apps/api` | 无输出 |
| 主依赖审计 | `npm_config_registry=https://registry.npmjs.org npm audit --omit=optional` | 0 vulnerabilities |
| Web 安全头 | `npm run web:assert-security-headers` | 通过；生产 CSP 无 `unsafe-eval`，开发 API origin 无重复 |
| Admin 写 smoke | `npm run smoke:admin-write` | 通过；用户/模型供应商/模型配置写操作真实 HTTP 验证，结束后无残留 |
| Prisma validate | `npx prisma validate --schema packages/db/prisma/schema.prisma` | schema valid |
| Prisma migrate status | `npx prisma migrate status --schema packages/db/prisma/schema.prisma` | 39 migrations，Database schema is up to date |
| Legacy schema | `npm run db:assert-no-legacy` | 无旧 project/product/product-design schema residue |
| Smoke 清理复核 | `npm run cleanup:smoke -- --dry-run --skip-gateway --json` | users/conversations/messages/runs/share/model/deerflow 均为 0 |
| Diff hygiene | `git diff --check` | 通过 |
| API 旧产物扫描 | `apps/api/dist` 精确扫描旧 `modules/auth`、`common/current-user`、project/product/product-design | 无输出 |

说明：Prisma CLI 提示有 `6.19.3 -> 7.8.0` major update，这是工具升级提示，不是本轮阻塞；需要单独评估 Prisma 7 迁移成本。

## 4. 本地真实浏览器验证

证据目录：`docs/audit/full-system-2026-07-05/screenshots/`

| 文件 | 步骤 | 健康状态 |
|---|---|---|
| `41-current-home-after-register.png` | 桌面注册后首页 | 健康；注册成功、输入框和 `workbench-claude` runtime 可见 |
| `42-current-chat-deerflow-reply.png` | 发送普通聊天 | 健康；`/api/chat/stream` 200，页面出现 DeerFlow 回复，未误开 artifact |
| `43-current-admin-runtime-events.png` | 后台运行日志 | 健康；运行日志显示真实 `2 流事件`，旧 `0 步` 噪音已消失 |
| `44-current-mobile-chat.png` | 移动端聊天页 | 健康；390x844 下 `scrollWidth=390`，无横向溢出 |
| `45-current-mobile-share-login-redirect.png` | 移动端未登录分享 | 健康；跳到 `/login?next=%2Fshare%2Fbad-token-current-fix` |

浏览器网络和控制台结果：

- 注册请求：`POST /api/auth/register` 201。
- 登录请求：`POST /api/auth/login` 201。
- 聊天请求：`POST /api/chat/stream` 200；messages/runtime-status/conversations 后续请求均 200。
- 未登录分享：仅请求 `/api/auth/session` 200，没有请求旧 `/api/public/share`。
- 桌面、后台和移动端 console：warning 0、error 0。
- 应用内浏览器 DOM 可读，但动态聊天区截图不稳定；最终视觉证据使用 Playwright CLI 截图，临时 `.playwright-cli` 已删除。

## 5. 本地测试数据清理

本轮真实浏览器复验创建了 2 个审计用户（普通用户和后台 UI 管理员）、1 个会话、2 条消息、1 条运行日志、1 个 DeerFlow 绑定。`smoke:admin-write` 会额外创建用户、模型供应商和模型配置，但脚本在 `finally` 中自清理，并由最终 dry-run 复核。

清理执行结果：

| 项目 | 清理前 | 清理后 |
|---|---:|---:|
| users | 2 | 0 |
| conversations | 1 | 0 |
| messages | 2 | 0 |
| agent_run_logs | 1 | 0 |
| file_assets | 0 | 0 |
| knowledge_items | 0 | 0 |
| share_links | 0 | 0 |
| model_providers | 0 | 0 |
| model_configs | 0 | 0 |
| deerflow_thread_bindings | 1 | 0 |

Gateway 线程删除：1 个线程返回 200。最终 `cleanup:smoke -- --dry-run --skip-gateway --json` 结果为 users/conversations/messages/runs/share/model/deerflow 全部 0。

## 6. 生产部署复验

| 验证项 | 结果 |
|---|---|
| 服务器 HEAD | `0c02341` |
| Knowledge 容器 | `ai-product-knowledge` Up |
| Quartz revision | `ab346fa66a895e12d63a308e70ce330ba795822a` |
| Knowledge 本机 health | `http://127.0.0.1:3001/__health` 200，正文 `ok` |
| Knowledge 本机 index | `http://127.0.0.1:3001/` 200 |
| Knowledge 日志 | 80 个 Markdown 文件解析成功；输出 114 个文件；无 direct eval/CustomOgImages/parse 错误 |
| 生产 API health | `ok=true`，DeerFlow enabled |
| Git 工作区 | 仅 `?? backups/` 为生产备份目录，未纳入 Git |

部署中真实暴露并修复的问题：

1. 固定 Quartz `v5.0.0` 后，旧 Dockerfile 继续调用 `npx quartz plugin install plugin-name...`，v5 CLI 报 `Unknown arguments`，Knowledge 构建失败。
2. 修复为复制 `quartz.lock.json` 并调用无参 `npx quartz plugin install`，25 个插件从 lockfile commit 恢复。
3. 尝试删除 disabled 的 `og-image` 后，生产启动报 `No matching export ... CustomOgImagesEmitterName`。结论：`og-image` 虽 disabled，但 Quartz core 静态依赖其导出，不能删除。
4. 删除真正产生日志噪音的 `note-properties` 后，生产日志不再出现 `direct eval` warning。

## 7. 本轮修复清单

| 优先级 | 问题 | 修复 |
|---|---|---|
| P1 | Knowledge Quartz core 已固定，但社区插件仍无 lockfile，部署不可复现 | 新增 `apps/knowledge/quartz.lock.json`，25 个插件锁到具体 commit |
| P1 | Dockerfile 调用错误的参数式插件安装，固定 `v5.0.0` 后构建失败 | 改为复制 lockfile 后运行无参 `npx quartz plugin install` |
| P1 | Dockerfile 把 `knowledge-vault` 放在 npm/plugin 层之前，内容变化会打穿昂贵依赖层 | 调整 COPY 顺序，插件层只依赖 config/lockfile |
| P2 | `note-properties` 插件触发生产 `direct eval` warning | 删除该插件配置和 lockfile 条目 |
| P2 | 误判 disabled `og-image` 为可删插件会破坏 Quartz core 静态 import | 恢复 `og-image` disabled 配置和 lockfile 条目，并在报告注明不可删原因 |
| P2 | smoke 清理脚本漏掉 `audit-current-*` 测试账号 | 增加 username/email/login_audit_logs 清理规则 |
| P2 | DeerFlow-first 后旧 `agent_step_logs` 永远为空，但 admin 仍展示 `0 步` | 新增迁移删除旧表和枚举，API/UI 改为只展示真实流事件 |
| P2 | Web 生产 CSP 仍允许 `unsafe-eval` | 抽出可测安全头构造函数，生产去掉 `unsafe-eval`，新增断言 |
| P2 | Admin 写路径缺少真实验证 | 新增 `smoke:admin-write`，覆盖用户和模型配置写操作并自动清理 |

既有修复仍有效：

- 旧 `public/share` 误导路由已移除，旧 route 返回 404。
- 分享页未登录先跳登录并保留 `next`，避免无意义 401。
- `/api/auth/logout` 幂等 200，避免过期会话登出 401 噪音。
- API auth 统一到 `apps/api/src/auth`，旧 `apps/api/src/modules/auth` 和重复 decorator 已删除。
- API build 先清 `dist`，旧编译产物不会残留。
- 旧 project/product/product-design 表、列、enum 已从当前库和生产库清理。

## 8. 产品架构和业务逻辑审计

当前产品主线是 Conversation-first + DeerFlow Gateway-first：

1. Auth 建立用户和安全 cookie。
2. Conversation/Message 是所有生成工作流的归属根。
3. Aichat Stream 接收用户意图、附件和上下文，写入运行日志。
4. DeerFlow Gateway 提供 LangGraph-compatible `/api`，Workbench 默认不直连 2024。
5. DeerFlow final action 驱动 PRD、Prototype、QA、Knowledge 等正式记录。
6. ShareLink 绑定 conversation、PRD、prototype 和 conversation design state，不依赖旧 product design state。
7. 分享页是登录后只读分享，不是免登录公开链接。

关键业务规则审计结果：

| 业务规则 | 状态 |
|---|---|
| 普通聊天不应误开 PRD artifact | 本轮普通聊天只返回 DeerFlow 文本回复，未生成 artifact |
| 前端 runtime 展示来自 API health/runtime | 本地显示 `workbench-claude`，生产 health 显示 `datatoken-gpt-5-5` |
| 分享链接需登录 | 本地桌面/移动端未登录均先跳 `/login?next=...` |
| 旧 public share 不应复活 | API route boundary 测试覆盖；本地未登录分享未打旧接口 |
| 用户 HTML sandbox/sanitizer | 既有安全单测和线上 smoke 覆盖；本轮未新增可执行原型能力 |
| Knowledge 站点构建来源可追踪 | core revision 文件 + plugin lockfile 双重约束 |

## 9. 未用模块与系统噪音

已删除或确认无需保留：

- `note-properties` Quartz 插件：会触发 direct eval warning，已删除。
- `installedAt` lockfile 时间戳：不参与恢复，已从 `quartz.lock.json` 删除，避免无意义变动。
- 参数式 `npx quartz plugin install plugin...`：不符合 v5 lockfile 模式，已删除。
- 本轮 `.playwright-cli`、`output/playwright` 临时目录：已删除。
- 本轮测试用户、会话、消息、运行日志、DeerFlow 线程绑定：已清理为 0。
- 本轮测试模型供应商和模型配置：已纳入 `cleanup:smoke` 并清理为 0。
- 旧 `agent_step_logs`、`AgentName`、`AgentStepStatus`：当前运行态不再写入，已从 schema/API/UI 删除。
- 旧运行日志 `0 步` 展示：已改为真实流事件计数。
- Web CSP 开发态重复 `http://localhost:4000` source：已去重。
- API `dist` 中旧 `modules/auth`、旧 `common/current-user`、project/product/product-design 运行产物：精确扫描无输出。

不能删除但容易误判的项：

- `og-image` 插件：配置 disabled，但 Quartz core 的 `Head.tsx` 仍静态 import `CustomOgImagesEmitterName`，删除会导致 Knowledge 容器启动失败。
- 历史 Prisma migrations 中的 `project/product/product_design_state`：它们属于迁移历史链，不是当前 schema/runtime 噪音；当前库由 legacy guard 保证最终状态干净。
- 生产服务器 `backups/`：是迁移/部署备份目录，保持 untracked，不提交。

## 10. 残留风险和优化建议

| 类型 | 当前状态 | 建议 |
|---|---|---|
| Knowledge Quartz npm 依赖 | `npm ci` 仍报告 11 vulnerabilities；v5 分支 HEAD 仍有 8 个，不能靠简单换 HEAD 清零 | 单独做 Quartz 依赖升级/patch 方案；必要时 fork Quartz 或等待上游修复后再 pin 新 commit |
| Knowledge OS/镜像扫描 | 已修复应用层 lock，但未做 Trivy/Syft/Grype 级别镜像 SBOM | 增加镜像级 SBOM 和漏洞门禁，不用主应用 audit 代替镜像 audit |
| Docker buildx | 生产提示 buildx 未安装，compose fallback 可用但有 warning | 安装 buildx 或禁用 bake warning，减少部署日志噪音 |
| 服务器 OS 更新 | SSH MOTD 显示 58 个可更新包、4 个 ESM Apps security updates、1 个 zombie process | 单独排期系统维护窗口，避免和应用部署混在一起 |
| CDN 缓存 | 公网 Knowledge URL 命中 CDN 旧缓存，本机 3001 已是新内容 | 部署后增加 CDN purge 或 cache-busting 验证策略 |
| 后台管理写操作 | 用户管理、模型供应商、模型配置已由 `smoke:admin-write` 覆盖；运行日志 UI 已由浏览器验证 | 后续只剩知识候选 approve/merge 的 QA gate 通过态专项 E2E，不建议硬造绕过业务门禁的数据 |
| 完整无障碍 | 截图能验证布局和可识别控件，不能证明 WCAG | 补键盘顺序、读屏、对比度、200% 缩放测试 |

## 11. 可访问地址和证据

- 本地 Web：`http://localhost:3000`
- 本地 API Health：`http://localhost:4000/api/system/health`
- 本地 DeerFlow Gateway：`http://127.0.0.1:8001/health`
- 线上 Web：`https://aionbench.com`
- 线上 API Health：`https://aionbench.com/api/system/health`
- 线上 Knowledge：`https://aionbench.com/knowledge/`
- 生产 Knowledge 本机健康：`http://127.0.0.1:3001/__health` 返回 `ok`
- 有效截图证据：`41-current-home-after-register.png`、`42-current-chat-deerflow-reply.png`、`43-current-admin-runtime-events.png`、`44-current-mobile-chat.png`、`45-current-mobile-share-login-redirect.png`
