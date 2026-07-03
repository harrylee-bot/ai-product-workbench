# Vibe Coding / DeerFlow 改造交接

日期：2026-06-27  
仓库：`/Users/liyannong/ai-product-workbench`  
分支：`feat/vibe-coding-v1`  
审计基线：`origin/main` `7201e332a5c2d6b9bfd7e742c5c7924d8396b0ab`

## 当前状态

- 当前分支本地相对 `origin/feat/vibe-coding-v1` 领先 9 个提交。
- 线上已经部署到 `<redacted-production-host>`，Workbench Web / API / DeerFlow Gateway 均健康。
- 本地工作区仍有用户未提交改动，主要在 `knowledge-vault/` 和 `apps/api/src/knowledge/obsidian-vault.service.ts`。这些不属于本轮改造，不要 reset、revert 或覆盖。
- 本轮最后一个提交是 `519fe35 feat: show agent activity in chat`。

## 关键提交

- `5c49592 chore: remove legacy runtime adapters`
- `94a1edb chore: trim legacy health module label`
- `0fff585 chore: remove legacy patch runtime surface`
- `7413ff1 chore: purge legacy frontend runtime surface`
- `d6ea58b feat: add deerflow runtime bridge`
- `3728967 feat: sync deerflow gateway files`
- `ba64b4e feat: add deerflow workbench agent assets`
- `e879389 chore: support branch deerflow deploy`
- `7fe7cdc chore: clean deerflow runtime artifacts`
- `7e55984 chore: clarify deerflow lead agent`
- `cf52d4f fix: parse deerflow messages stream`
- `519fe35 feat: show agent activity in chat`

## 已完成改造

### 1. 历史 runtime 和旧链路清理

已删除或移除旧的 direct Codex / direct DeerFlow adapter、local renderer/fallback、patch runtime surface、旧前端 runtime surface。当前后端不再由 Nest 直接编排“自研生成链路”，而是保留 Workbench 的 thread / context / event / final action 边界。

已确认第一批旧模块清理完成：

- 删除未挂载的 `modules/state`
- 删除根级旧 `system`
- 删除根级旧 `auth` 实现，仅保留仍在用的 guard / roles / types
- 删除根级旧 `projects` controller/module/service
- 保留 `apps/api/src/projects/message.service.ts`，它仍被 AI/Vibe 链路依赖
- 删除前端旧 `workspace-shell.tsx`
- 删除 patch-builder、input-quality-gate、intent-classifier helper、旧 preview facade 等未接入代码

当前 `apps/api/src/app.module.ts` 挂载的是：

- `./modules/auth/auth.module`
- `./modules/conversation/conversation.module`
- `./modules/message/message.module`
- `./modules/project/project.module`
- `./modules/system/system.module`

### 2. DeerFlow 作为一等 runtime 接入

DeerFlow Gateway 已部署为独立 runtime：

- 服务器：`<redacted-production-host>`
- DeerFlow release：`/opt/deer-flow.release-20260626183352`
- 容器：`deer-flow-gateway`
- 端口：`2026:8001`
- 健康检查：`http://127.0.0.1:2026/health`

Workbench 注册的 DeerFlow 能力：

- Agent：`ai-product-workbench-lead`
- Skill：`ai-product-workbench`
- 模型：`datatoken-gpt-5-5`

API 侧关键环境变量：

- `DEERFLOW_ENABLED=true`
- `DEERFLOW_LANGGRAPH_URL=http://host.docker.internal:2026/api`
- `DEERFLOW_GATEWAY_URL=http://host.docker.internal:2026`
- `DEERFLOW_AGENT_NAME=ai-product-workbench-lead`
- `DEERFLOW_MODEL_NAME=datatoken-gpt-5-5`
- `DEERFLOW_STREAM_MODE=messages,values`

### 3. DeerFlow stream 解析修复

问题：DeerFlow 会把请求的 `messages-tuple` coercion 到实际 `messages` stream。旧后端只累计 `messages-tuple`，导致线上 fallback 成“DeerFlow 本轮已完成”。

修复点：

- `apps/api/src/ai/deerflow-runtime.service.ts`
- 同时解析 `messages` 和 `messages-tuple`
- 只累计 assistant / AI chunk，过滤 human / system / memory / `hide_from_ui`
- fallback 到 final state 中最后一条 assistant message
- 默认 stream mode 改为 `messages,values`
- 测试覆盖：`apps/api/test/deerflow-runtime.service.spec.ts`

### 4. 前端展示契约调整

最终确认的产品方向：

- 右侧只展示产物：`PRD / Canvas / 原型`
- 中间对话区展示：
  - 用户 / 助手消息
  - `Agent 过程`
  - 轻量 `执行清单`
  - `工具调用与事件`
  - `产物变化`
- 不做顶部固定计划条
- 不把运行 / Diff / QA 做成右侧 tab

主要文件：

- `apps/web/src/components/chat-panel.tsx`
- `apps/web/src/app/workspace/phase1-workspace-client.tsx`

注意：这里展示的是可见执行摘要、节点目标、工具/事件记录，不展示模型隐藏推理原文。

## 线上部署状态

当前线上容器：

- `ai-product-workbench-web`：`deploy-web`，端口 `3000`
- `ai-product-workbench-api`：`ai-product-workbench-api:latest`，端口 `4000`
- `ai-product-knowledge`：端口 `3001`
- `deer-flow-gateway`：端口 `2026`
- `datatoken-minio`：端口 `9000`
- `ai-product-workbench-postgres`

健康检查结果：

- Web `/workspace`：HTTP 200
- API `/api/system/health`：`ok=true`，`phase=deerflow-first-runtime`
- DeerFlow `/health`：`status=healthy`

最近一次 web 部署方式：

```bash
rsync -av apps/web/src/components/chat-panel.tsx <redacted-production-host>:/opt/ai-product-workbench/apps/web/src/components/chat-panel.tsx
rsync -av apps/web/src/app/workspace/phase1-workspace-client.tsx <redacted-production-host>:/opt/ai-product-workbench/apps/web/src/app/workspace/phase1-workspace-client.tsx
ssh <redacted-production-host> 'cd /opt/ai-product-workbench && docker compose --env-file .env -f deploy/docker-compose.yml build web'
ssh <redacted-production-host> 'cd /opt/ai-product-workbench && docker rm -f ai-product-workbench-web && docker compose --env-file .env -f deploy/docker-compose.yml up -d --no-deps web'
```

注意：线上旧 `ai-product-workbench-web` 容器最初没有 compose label，直接 `compose up -d web` 会遇到 container name conflict。处理方式是只移除旧 web 容器，再用新 compose 创建同名 web 容器，不动 API / DB / DeerFlow。

## 验证记录

已通过：

```bash
npm run db:generate
npm run typecheck
npm --workspace @ai-product-workbench/api run test
npm --workspace @ai-product-workbench/api run build
npm --workspace @ai-product-workbench/web run build -- --webpack
```

API 全量测试当前结果：22 个测试文件、89 个测试通过。

说明：在当前本地受限沙箱里，默认 `next build` 使用 Turbopack 时会尝试创建进程并绑定本地端口，触发 `Operation not permitted (os error 1)`。同一代码用 `next build --webpack` 通过；线上 Docker build 使用默认路径已构建成功。

## 当前工作区注意事项

不要误处理这些本地脏改：

- `apps/api/src/knowledge/obsidian-vault.service.ts`
- `knowledge-vault/**`

它们不是本轮改造产生的，不要作为清理残留回滚。

GitHub push 状态：

- 本地分支 `feat/vibe-coding-v1` 领先 `origin/feat/vibe-coding-v1` 9 个提交。
- 之前尝试 push 时遇到 `Could not resolve host: github.com`。网络恢复后可执行：

```bash
git push -u origin feat/vibe-coding-v1
```

## 下一步建议

1. 做一次线上真实对话 smoke test，确认“你好”和产品需求类输入都能在对话区展示 Agent 过程，并且右侧只展示产物。
2. 继续 DeerFlow graph 改造：把 Codex 放到 DeerFlow coding/prototype execution 节点，而不是 Nest 直接决定调用。
3. 明确普通问答与生成任务的意图分流：普通“你好”应返回对话结果，不应走完整 PRD/原型生成流程。
4. 配置卫生单独整理：
   - `apps/web/package.json` 的 `next lint` 在 Next 16 下不可用
   - API 直接 import `express` 类型，但 `apps/api/package.json` 没显式声明 `express`
   - `@nestjs/testing` 目前没有测试 import
   - `.env.example`、README、部署脚本的默认 runtime / model / root path 仍需统一
5. 后续如果要提交知识库整理，单独开 commit，不要和 DeerFlow/runtime/frontend 展示改造混在一起。
