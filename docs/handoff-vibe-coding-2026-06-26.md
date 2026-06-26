# Vibe Coding 项目交接文档（2026-06-26）

## 1. 当前目标

项目路径：

`/Users/liyannong/ai-product-workbench`

当前决策：

- 不再维护自研 agent 编排。
- 只维护 Vibe Coding 产品协议、状态机、runtime adapter、权限审计和 artifact 落库。
- 底层执行、任务编排、工具调用、代码修改、多步骤协作交给 Codex CLI 或 DeerFlow。
- 本项目不复刻 Codex/DeerFlow 的执行循环。

当前主链路：

```text
User Input / Project Context
  -> Vibe protocol
  -> ProductDesignState state machine
  -> Runtime adapter (Codex CLI / DeerFlow)
  -> schema validation / safety check
  -> PRD / Prototype / Patch / QA persistence
  -> stream events / admin logs / audit
```

## 2. 线上信息

正确生产服务器：

`8.130.160.177`

访问地址：

- Web: `http://8.130.160.177:3000/login`
- API health: `http://8.130.160.177:4000/api/system/health`
- Knowledge: `http://8.130.160.177:3001`

服务器路径：

`/opt/ai-product-workbench`

服务器当前不能匿名拉取 GitHub 私有仓库。因此部署方式是本地 `rsync` 到服务器，保留服务器 `.env`、`runtime-skills`、`knowledge-vault`，再执行：

```bash
cd /opt/ai-product-workbench
SKIP_GIT_PULL=1 bash deploy/server-deploy.sh
```

## 3. 当前线上状态

截至 2026-06-26：

- GitHub `main` 已包含 runtime adapter 改造。
- 线上 API/Web/Knowledge/Postgres 均可启动。
- `codex --version` 在 API 容器内返回 `codex-cli 0.142.2`。
- API health `phase` 为 `vibe-runtime-adapter`。
- health modules 已切到 `runtime-orchestrator`、`runtime-adapters`、`codex-runtime-adapter`、`deerflow-runtime-adapter`、`product-runtime-service`、`codex-runtime-skills` 等。
- 登录已验证：
  - `admin / Admin123456`
  - `zhangsan / User123456`

已验证命令：

```bash
npm run typecheck
npm run test
npm run build
```

## 4. 最近一次线上故障

用户截图里登录页显示“服务器内部错误，请稍后重试”。

根因：

- 服务器根盘 100%。
- Postgres checkpoint 写入失败，进入 recovery。
- 日志出现 `No space left on device`。

处理：

- 清理停止容器和 dangling/旧镜像。
- Postgres 恢复 `pg_isready`。
- 登录接口恢复。
- `deploy/server-deploy.sh` 已加入部署前清理：
  - `docker container prune -f`
  - `docker image prune -f`

注意：不要清理 Docker volume，Postgres 数据在 volume 中。

## 5. 已完成的重构

### 删除旧实验链路

旧 Phase2/3/4/5 实验链路已经从活跃代码和 Prisma schema 中清掉。历史实验表通过 migration drop，不再进入生成客户端、构建或测试目标。

新增 migration：

`packages/db/prisma/migrations/20260626153000_drop_self_authored_orchestration/migration.sql`

### Runtime 命名收敛

- `AgentSkillRegistryService` -> `RuntimeSkillRegistryService`
- 运行日志服务为 `RuntimeRunLogService`
- Prisma client 模型为 `RuntimeRunLog` / `RuntimeStepLog`
- 物理表通过 `@@map` 映射到历史运行日志表，避免丢运行日志。
- admin 正式接口改为：
  - `/api/admin/logs/runtime-runs`
  - `/api/admin/logs/runtime-runs/:runId`

### Runtime adapter

Runtime 代码位置：

- `apps/api/src/ai/runtime/external-runtime.types.ts`
- `apps/api/src/ai/runtime/external-runtime.service.ts`
- `apps/api/src/ai/runtime/external-runtime-config.service.ts`
- `apps/api/src/ai/runtime/codex-runtime.adapter.ts`
- `apps/api/src/ai/runtime/deerflow-runtime.adapter.ts`
- `apps/api/src/ai/runtime/product-runtime.service.ts`
- `apps/api/src/ai/runtime/local-protocol-renderers.ts`

当前支持：

- Requirement intake 可通过 `VIBE_REQUIREMENT_RUNTIME=codex|deerflow` 切到外部 runtime。
- PrototypeSpec、Prototype HTML、PatchPlan、QA 可分别通过：
  - `VIBE_PROTOTYPE_SPEC_RUNTIME`
  - `VIBE_PROTOTYPE_CODE_RUNTIME`
  - `VIBE_PATCH_PLAN_RUNTIME`
  - `VIBE_QA_RUNTIME`
- fallback 由 `VIBE_RUNTIME_FALLBACK_TO_LOCAL` 控制。

## 6. 关键环境变量

```text
APP_HOST=8.130.160.177
WEB_ORIGIN=http://8.130.160.177:3000
NEXT_PUBLIC_API_BASE_URL=http://8.130.160.177:4000/api
NEXT_PUBLIC_KNOWLEDGE_APP_URL=http://8.130.160.177:3001

DEFAULT_MODEL_PROVIDER_NAME=XXTF OpenAI
DEFAULT_MODEL_BASE_URL=https://xxtf.baby/v1
DEFAULT_MODEL_NAME=gpt-5.5
CODEX_CLI_VERSION=0.142.2

VIBE_REQUIREMENT_RUNTIME=local
VIBE_PROTOTYPE_SPEC_RUNTIME=local
VIBE_PROTOTYPE_CODE_RUNTIME=local
VIBE_PATCH_PLAN_RUNTIME=local
VIBE_QA_RUNTIME=local
VIBE_RUNTIME_FALLBACK_TO_LOCAL=true
VIBE_RUNTIME_WORKSPACE_ROOT=/app/apps/api/storage/runtime-workspaces
VIBE_CODEX_COMMAND=codex

RUNTIME_SKILLS_ROOT=/app/runtime-skills/obsidian-skills/skills:/root/.codex/skills
```

## 7. 模型配置

当前默认模型方向：

```text
Provider: XXTF OpenAI
Base URL: https://xxtf.baby/v1
Model: gpt-5.5
```

不要把真实 API Key 写入代码或文档。

默认账号来自 seed：

```text
admin / Admin123456
zhangsan / User123456
```

## 8. Git 状态提醒

当前工作区可能仍有 `knowledge-vault/**` 的未提交本地内容。这部分视为用户/知识库工作区内容，除非用户明确要求，不要提交或清理。

不要使用：

```bash
git reset --hard
git checkout -- .
```

## 9. 后续建议

1. 保持 `main` 可部署，继续每次改完推 GitHub 和线上。
2. 配置真实 Codex / DeerFlow runtime 后，做端到端 requirement -> PRD -> Prototype -> QA 验证。
3. 前端继续增强 runtime events 的自然语言展示。
4. 对 runtime 输出增加更严格的 schema 校验、错误恢复和回放审计。
5. 如果切换到外部 runtime，先只开一个 task 类型，线上验证稳定后再扩大范围。
