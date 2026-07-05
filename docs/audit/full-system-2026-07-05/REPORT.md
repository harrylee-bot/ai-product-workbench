# AI Product Workbench 全量系统审计报告

审计日期：2026-07-05
审计方式：本地真实启动 + API/DB/依赖/构建/单测/浏览器交互验证
审计范围：Web、Nest API、PostgreSQL/Prisma、DeerFlow Gateway、DeerFlow 运行时、聊天主链路、核心契约、未用模块、测试数据和历史报告噪音。
外部同步：未同步到飞书/Lark 或任何外部知识库。
线上部署：未执行。当前只完成本地验证。

## 1. 最终结论

本地系统主链路已经跑通，且本轮发现的 P1/P2 噪音已修复：

- Web、API、DeerFlow 三个本地服务均在线。
- 登录、首页、模型显示、聊天流式响应、DeerFlow 回答链路通过真实浏览器验证。
- 普通问答中出现“不要生成 PRD”时，不再误触发 `streaming-prd-*` 临时文档流，不再请求不存在的 `/api/prd-documents/streaming-prd-*`。
- 前端模型选择器显示真实运行时 `workbench-claude`，不再写死 `GPT-5.5`。
- `GET /api/messages` 缺少 `conversationId` 时返回明确 400，不再伪装成会话不存在。
- `npm audit --omit=optional` 为 0 漏洞。
- Web lint/typecheck、API 全量测试、整体 build、knip 未用扫描均通过。
- 本轮注册的一次性测试账号、会话、消息、运行日志、DeerFlow 绑定、登录审计日志、Playwright 临时文件均已清理。
- 旧 `Phase1*` auth 类型命名、旧视觉 QA 报告/截图、旧 KB/Project/Product 文档和部署默认 `gpt-5.5` 已清理。

当前不建议直接推线上，因为工作区仍有大量已存在的业务重构改动和删除项，需要按变更集拆分 review/commit。但从本地运行和验证结果看，当前代码已经满足“先本地跑起来、先本地测试”的门槛。

## 2. 本地服务状态

| 服务 | 地址 | 当前状态 |
|---|---|---|
| Web | `http://localhost:3000` | 运行中，PID 36458 |
| API | `http://localhost:4000/api/system/health` | 运行中，PID 6659 |
| DeerFlow Gateway | `http://127.0.0.1:8001/health` | 运行中，PID 69318 |

API 健康接口返回的关键运行时信息：

```json
{
  "ok": true,
  "service": "ai-product-workbench-api",
  "phase": "deerflow-first-runtime",
  "deerflow": {
    "enabled": true,
    "modelId": "deerflow/workbench-claude",
    "modelName": "workbench-claude",
    "modelDisplayName": "workbench-claude",
    "runtimeName": "ai-product-workbench-lead",
    "provider": "deerflow"
  }
}
```

## 3. 已修复问题

| 优先级 | 问题 | 修复结果 |
|---|---|---|
| P1 | 普通回答误触发 PRD 文档流 | 后端 `forceDocumentStream` 改为按真实文档生成意图判断；补充“不要/别/不需要生成 PRD”等否定意图识别；前端 `DataStreamHandler` 增加 artifact 流开启条件，普通 `data-textDelta` 不能单独打开右侧画布。 |
| P1 | 前端模型名硬编码 | API health 暴露 DeerFlow runtime model；前端从 `/api/system/health` 读取并显示 `workbench-claude`。 |
| P1 | 依赖安全漏洞 | Next 升到 `16.2.10`，PostCSS 固定 `8.5.16`，Multer 固定/覆盖 `2.2.0`，Vite 覆盖 `8.1.3`，esbuild 覆盖 `0.28.1`；audit 为 0。 |
| P2 | `GET /api/messages` 空 query 语义错误 | 缺少 `conversationId` 时返回 `400 {"message":"conversationId 不能为空"}`。 |
| P2 | 登录/注册/后台密码框浏览器提示 | 登录补 `current-password`，注册和后台创建/重置密码补 `new-password`。 |
| P2 | Web lint 和未用 UI 噪音 | 删除未用 UI 文件 `button-group.tsx`、`hover-card.tsx`、`scroll-area.tsx`、`skeleton.tsx`，收窄 `command.tsx` 未用导出；knip 和 lint 均清零。 |
| P2 | 历史审查报告噪音 | `docs/archive/2026-07-audit/` 已删除；保留当前报告作为本轮唯一审计结论。 |
| P2 | 旧架构/旧模型文档噪音 | 删除 `docs/handoff-vibe-coding-2026-06-27.md`、`docs/kb-integration-guide.md`、`docs/kb-redesign.md`、`docs/frontend-cleanup-codex.md`、`design-qa.md`、`docs/qa/`、`docs/reference/`；部署默认模型不再写死 `gpt-5.5`。 |
| P3 | Auth 类型旧阶段命名 | `Phase1User`/`Phase1JwtPayload` 统一改为 `AuthenticatedUser`/`AuthJwtPayload`。 |

## 4. 真实浏览器验证

使用 Playwright headed 浏览器完成：

1. 打开 `http://localhost:3000/login`。
2. 注册并登录一次性审计账号。
3. 登录后进入首页，模型按钮显示 `workbench-claude`。
4. 发送：`请用一句话说明当前系统是否在线，不要生成PRD。`
5. DeerFlow 返回：`系统当前在线，运行正常。`
6. 网络请求中没有 `/api/prd-documents/streaming-prd-*`。
7. DOM 中 `streamingPrdCount=0`，artifact 容器宽度为 0，右侧画布未打开。
8. Console 仅保留登录前 `/api/auth/me` 的预期 401；无密码 autocomplete warning，无 PRD 404。

这一轮先复现了修复前问题：同一类普通问答会请求 `/api/prd-documents/streaming-prd-{runId}` 并产生 404。修复后同样路径复测通过。

## 5. 自动化验证结果

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 通过，API + Web TypeScript 均通过 |
| `npm --workspace @ai-product-workbench/web run lint` | 通过，无 warning 输出 |
| `npm --workspace @ai-product-workbench/api run test` | 通过，32 个测试文件通过、1 个跳过；155 passed、1 skipped |
| `npm run build` | 通过，API `tsc` + Next 16.2.10 build 成功 |
| `npm_config_registry=https://registry.npmjs.org npm audit --omit=optional` | 通过，0 vulnerabilities |
| `npm ls next postcss multer vitest vite esbuild --workspaces` | 通过，关键依赖版本和 overrides 生效 |
| `npx --yes knip --include files,dependencies,devDependencies,exports,types --workspace apps/web --workspace apps/api` | 通过，无未用文件/导出输出 |

## 6. 业务架构审计

当前代码已经从旧的 Project/Product 结构转向 Conversation-first + DeerFlow-first：

- Auth 负责用户、JWT cookie、登录注册。
- Conversation/Message 负责对话、消息和历史。
- Aichat Stream 负责把用户消息、附件、知识检索、DeerFlow runtime、最终动作落库串起来。
- DeerFlow Runtime 负责 agent workflow、final action contract、artifact 拉取。
- RequirementDocument、Prototype、QA、Rollback、Share 负责 PRD/原型/质量门禁/版本链路。
- Admin 负责用户、运行日志、知识库、模型网关、DeerFlow skill 管理。
- System health 现在暴露运行时模型，前端不再自行臆造模型。

关键业务判断修复：

- “生成/编写/起草 PRD”会进入文档生成路径。
- “这份需求文档有哪些风险？”、“不要生成 PRD，只回答状态”保持普通问答路径。
- 只有收到明确 artifact 控制事件后，前端才打开右侧 artifact 画布。

## 7. 未用模块和系统噪音

已删除或确认清理：

- 历史审查报告：`docs/archive/2026-07-audit/`。
- 旧 Project/Product 模块删除项当前仍在工作区：`apps/api/src/modules/project/*`、`apps/api/src/products/*`、`apps/api/src/projects/message.service.ts`。
- 旧 `product-design-state` API 文件删除项当前仍在工作区，并由新的 `conversation-design-state` 文件替代。
- Web 未用 UI 文件：`button-group.tsx`、`hover-card.tsx`、`scroll-area.tsx`、`skeleton.tsx`。
- `command.tsx` 未用导出：`CommandEmpty`、`CommandShortcut`、`CommandSeparator`。
- Playwright 临时目录 `.playwright-cli` 和 `/tmp/ai-workbench-*` 临时文件。

当前 knip 扫描无未用文件/导出输出。旧架构关键词扫描排除历史 migration 后，仅剩 `OpenAI-compatible` 这类模型网关协议名，属于当前业务能力。

## 8. 数据清理结果

本轮真实验证创建的一次性账号 `codex_audit_20260705100559` 已清理。清理后计数：

| 数据类型 | 剩余数量 |
|---|---:|
| users | 0 |
| loginAuditLogs | 0 |
| conversations | 0 |
| messages | 0 |
| runtimeRuns | 0 |
| deerFlowBindings | 0 |

已清理的测试会话：

- `6170765c-90b3-4fd4-86d4-0d54baf83463`

已清理的测试运行：

- `f8a2ac24-9510-45a0-bc7d-870fcbc721b0`

## 9. 剩余风险

1. 工作区非常大：`git status` 中还有大量业务重构、删除、未跟踪文件。虽然测试通过，但上线前必须分组 review，避免把无关变更一次性推送。
2. 历史 Prisma migration 中仍会保留旧命名，这是数据库历史，不建议强改；测试文件/类型命名可以后续继续语义收敛。
3. 本轮真实浏览器重点复测登录、模型显示、普通聊天、artifact 误触发回归；后台管理的每个子页面没有在修复后逐个手点复测，但 API 测试、typecheck、build 覆盖通过。
4. 当前服务是本地开发配置，未执行线上部署、线上环境变量核验、生产数据库迁移演练。
5. 已尝试调用本机 Claude Code 做只读复审，但会话数分钟无输出后已中止；本报告结论来自本地源码检查、测试、构建、浏览器和数据库验证。

## 10. 上线建议

上线前建议按以下顺序：

1. 先 review 当前大工作区，按“依赖安全”“聊天流契约”“前端 runtime model”“旧模块删除”“UI 噪音清理”拆 commit。
2. 保持本地三件套验证：`typecheck`、`api test`、`web lint`、`build`、`audit`、`knip`。
3. 部署前再用生产等价环境变量启动 API，验证 `/api/system/health` 中 DeerFlow model 与前端显示一致。
4. 线上部署后先跑只读 smoke：health、login、chat stream、runtime-status、messages、admin health。
5. 再开放写入型流程：PRD 生成、原型生成、QA gate、导出、分享。

## 11. 当前可访问地址

- Web：`http://localhost:3000`
- API Health：`http://localhost:4000/api/system/health`
- DeerFlow Health：`http://127.0.0.1:8001/health`
