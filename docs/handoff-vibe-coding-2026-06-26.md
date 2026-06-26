# Vibe Coding 项目交接文档（2026-06-26）

## 1. 项目定位

项目路径：

`/Users/liyannong/ai-product-workbench`

当前核心决策：

- 不再维护自研 agent 编排。
- 只维护 Vibe Coding 产品协议、状态机、runtime adapter、权限审计、artifact 落库和前端工作台。
- 底层执行、任务编排、工具调用、代码修改、多步骤协作交给 Codex CLI 或 DeerFlow。
- 本项目不复刻 Codex/DeerFlow 的执行循环。

当前主链路：

```text
User Input / Project Context
  -> Vibe protocol
  -> ProductDesignState state machine
  -> Runtime adapter (Codex CLI / DeerFlow)
  -> schema normalization / safety check
  -> PRD / Prototype / Patch / QA persistence
  -> stream events / admin logs / audit
```

## 2. 线上信息

生产服务器：

`8.130.160.177`

域名：

- Web: `https://aionbench.com/login`
- API health: `https://aionbench.com/api/system/health`
- Knowledge: `https://aionbench.com/knowledge`

服务器路径：

`/opt/ai-product-workbench`

Caddy 当前反代：

- `aionbench.com/login` -> web `127.0.0.1:3000`
- `aionbench.com/api/*` -> api `127.0.0.1:4000`
- `aionbench.com/knowledge/*` -> knowledge `127.0.0.1:3001`
- `www.aionbench.com` redirects to apex.

SSH 说明：

- 可用 `ssh root@8.130.160.177` 或本机 alias `ssh-8`。
- 不要用 raw `nc` 或未绑定网卡的 socket 探测 SSH，参见 `/Users/liyannong/AGENTS.md`。

默认测试账号：

```text
admin / Admin123456
zhangsan / User123456
```

不要把真实模型 API Key 写入代码或文档。

## 3. 当前 Git 状态

本地当前分支：

`feat/vibe-coding-v1`

当前关键提交：

```text
7041512 fix: use idle timeout for codex runtime
75c2e7d fix: make codex sandbox configurable
7383e7e fix: unblock workspace sends and default datatoken
04542d9 chore: serialize server deployments
73cd8ee chore: support domain public urls
```

远端状态：

- `origin/feat/vibe-coding-v1` -> `7041512`
- `origin/main` -> `c30306b`

说明：

- feature 分支和 main 都已经推送 GitHub。
- main 是线上部署同步分支，但本地主要工作分支仍是 `feat/vibe-coding-v1`。
- 当前本地工作区在本次交接时是干净的。

## 4. 当前线上部署状态

当前容器：

```text
ai-product-workbench-api        4000
ai-product-workbench-web        3000
ai-product-knowledge            3001
ai-product-workbench-postgres   internal
ai-product-openpencil           3002
datatoken-minio                 9000 / 9001
```

线上已验证：

```bash
curl -fsS https://aionbench.com/api/system/health
curl -fsS https://aionbench.com/login
curl -fsS https://aionbench.com/knowledge
```

API health `phase`：

`vibe-runtime-adapter`

关键 health modules 包含：

- `runtime-orchestrator`
- `runtime-adapters`
- `codex-runtime-adapter`
- `deerflow-runtime-adapter`
- `product-runtime-service`
- `codex-runtime-skills`
- `model-gateway`
- `ai-vibe-stream`

## 5. 部署方式

服务器可以跑部署脚本，但不要假设服务器一定能直接拉私有 GitHub。

本地同步到服务器：

```bash
rsync -az --delete \
  --exclude='.git' \
  --exclude='.env' \
  --exclude='node_modules' \
  --exclude='.next' \
  --exclude='dist' \
  --exclude='apps/api/storage' \
  /Users/liyannong/ai-product-workbench/ \
  root@8.130.160.177:/opt/ai-product-workbench/
```

服务器部署：

```bash
ssh root@8.130.160.177
cd /opt/ai-product-workbench
SKIP_GIT_PULL=1 PRUNE_DOCKER_BEFORE_BUILD=0 bash deploy/server-deploy.sh
```

部署脚本已加锁：

- lock file: `/tmp/ai-product-workbench-deploy.lock`
- 如果另一个对话/进程正在部署，会直接退出，避免互相撞。

历史协调线程：

`019ef380-a076-79e1-a537-c3d805828a0f`

若之后仍有并行对话在部署，先协调，避免同时重建容器。

## 6. 当前核心环境变量

线上 `.env` 当前方向：

```text
DEFAULT_MODEL_PROVIDER_NAME=datatoken
DEFAULT_MODEL_BASE_URL=https://datatoken.shop
DEFAULT_MODEL_NAME=gpt-5.5

MODEL_GATEWAY_KEEP_ONLY_DEFAULT_PROVIDER=true
MODEL_GATEWAY_HIDE_DISABLED_PROVIDERS=true

CODEX_CLI_VERSION=0.142.2
CODEX_MODEL_PROVIDER_ID=datatoken
CODEX_MODEL_PROVIDER_NAME=datatoken
CODEX_BASE_URL=https://datatoken.shop
CODEX_MODEL=gpt-5.5
CODEX_SUPPORTS_WEBSOCKETS=false

OPENAI_BASE_URL=https://datatoken.shop
OPENAI_MODEL=gpt-5.5

VIBE_REQUIREMENT_RUNTIME=codex
VIBE_PROTOTYPE_SPEC_RUNTIME=codex
VIBE_PROTOTYPE_CODE_RUNTIME=codex
VIBE_PATCH_PLAN_RUNTIME=codex
VIBE_QA_RUNTIME=codex
VIBE_RUNTIME_FALLBACK_TO_LOCAL=true
VIBE_RUNTIME_WORKSPACE_ROOT=/app/apps/api/storage/runtime-workspaces
VIBE_CODEX_COMMAND=codex
VIBE_CODEX_SANDBOX=danger-full-access
VIBE_CODEX_IDLE_TIMEOUT_MS=180000
VIBE_CODEX_IDLE_POLL_MS=1000
```

说明：

- API Key 在 `.env` 中，不要输出到文档或提交。
- DataToken 直连已验证，`/v1/chat/completions` 对 `gpt-5.5` 返回 200。
- Model Gateway 后台列表默认只显示 enabled provider/config。
- 数据库中历史 provider 仍保留，但全部 disabled；默认 enabled provider 是 `datatoken`。

## 7. 最近已完成的关键修复

### 7.1 输入框发送失败

现象：

- 用户在前端输入框发送消息失败。
- admin 登录后工作台默认选中了普通用户项目，发送时后端返回 403。

根因：

- 工作台项目列表对 admin 返回了所有用户项目。
- 但 send path 禁止 admin 直接修改非本人项目。

修复：

- `apps/api/src/modules/project/project.service.ts`
- `apps/api/src/projects/project.service.ts`

当前行为：

- `/api/projects` 始终只返回当前登录用户自己的项目。
- admin 全量查看仍走 `/api/admin/projects`。

验证：

- admin `/api/projects` 只返回 admin 自己的项目。
- 真实发送接口返回 201。

### 7.2 模型供应商收敛到 DataToken

修复：

- 默认 provider 改为 `datatoken`。
- `MODEL_GATEWAY_KEEP_ONLY_DEFAULT_PROVIDER=true` 时禁用其他 provider/config。
- 后台默认隐藏 disabled provider/config。

相关文件：

- `apps/api/src/model-gateway/model-gateway-defaults.service.ts`
- `apps/api/src/model-gateway/model-gateway-admin.service.ts`
- `.env.example`
- `deploy/server-deploy.sh`
- `deploy/docker-compose.yml`

线上验证：

```sql
select name, base_url, is_default, is_enabled
from model_providers
order by is_default desc, created_at desc;
```

结果：

- `datatoken | https://datatoken.shop | true | true`
- 其他历史 provider 均 `false | false`

### 7.3 Codex CLI sandbox 修复

现象：

- Codex runtime 之前会 fallback。
- 手工 smoke 发现 Docker 内 `--sandbox workspace-write` 触发：

```text
bwrap: No permissions to create a new namespace
```

修复：

- 新增 `VIBE_CODEX_SANDBOX`
- 线上设置为 `danger-full-access`
- 每次 Codex 任务仍运行在独立 workspace：

```text
/app/apps/api/storage/runtime-workspaces/<runId>_<taskType>_<taskId>
```

相关文件：

- `apps/api/src/ai/runtime/external-runtime-config.service.ts`
- `apps/api/src/ai/runtime/codex-runtime.adapter.ts`
- `.env.example`
- `deploy/server-deploy.sh`
- `deploy/docker-compose.yml`

手工 smoke 已通过：

```bash
docker exec ai-product-workbench-api sh -lc '
  wd=/tmp/codex-smoke-$(date +%s)
  mkdir -p "$wd"
  cd "$wd"
  codex exec --json --sandbox "$VIBE_CODEX_SANDBOX" --cd "$wd" --skip-git-repo-check --ephemeral \
    --model "$CODEX_MODEL" \
    --config "model_provider=\"$CODEX_MODEL_PROVIDER_ID\"" \
    --config "model_providers.$CODEX_MODEL_PROVIDER_ID.name=\"$CODEX_MODEL_PROVIDER_NAME\"" \
    --config "model_providers.$CODEX_MODEL_PROVIDER_ID.base_url=\"$CODEX_BASE_URL\"" \
    --config "model_providers.$CODEX_MODEL_PROVIDER_ID.wire_api=\"responses\"" \
    --config "model_providers.$CODEX_MODEL_PROVIDER_ID.env_key=\"CODEX_API_KEY\"" \
    --config "model_providers.$CODEX_MODEL_PROVIDER_ID.supports_websockets=false" \
    "Create a file named runtime-output.json in the current directory containing exactly {\"ok\":true}."
  cat "$wd/runtime-output.json"
'
```

结果：

```json
{"ok":true}
```

### 7.4 Codex runtime 改为空闲超时

用户明确要求：

> 主要还在产出就不应该结束，是接口没产出才需要超时结束。

当前实现：

- 不会因为 `runtime-output.json` 已经生成或稳定就提前结束。
- 只要 stdout、stderr 或预期产物文件仍有变化，就继续等。
- 连续 `VIBE_CODEX_IDLE_TIMEOUT_MS=180000` 毫秒没有任何新产出，才触发空闲超时。
- 如果空闲超时时预期产物已可解析，则结束子进程并继续落库。
- 如果空闲超时时没有可用产物，则抛错，外层按 `VIBE_RUNTIME_FALLBACK_TO_LOCAL` 决定是否 fallback。

相关文件：

- `apps/api/src/ai/runtime/codex-runtime.adapter.ts`
- `apps/api/src/ai/runtime/external-runtime-config.service.ts`
- `apps/api/test/codex-runtime.adapter.spec.ts`

测试覆盖：

- 文件已生成但 stdout 仍持续产出时，不会 kill Codex。
- stdout/stderr/目标产物都无变化时，才 SIGTERM。

线上真实回归：

```text
runId: 0cd47c2d-a4a4-4f48-8f55-d766fbbbfbed
status: succeeded
duration_ms: 181842
output_summary: 已补充线上空闲超时回归验收标准：只读测试备注字段必须仅展示，不能编辑。
events:
  message_delta: 38
  prd_updated: 1
  run_completed: 1
  state_updated: 1
  step_started: 1
fallback_used: 0
```

## 8. 已验证命令

本地验证均已通过：

```bash
npm run typecheck
npm run test
npm run build
```

最近结果：

- Test Files: `29 passed`
- Tests: `120 passed`

部署脚本语法：

```bash
bash -n deploy/server-deploy.sh
```

## 9. Runtime 代码入口

核心 runtime 文件：

```text
apps/api/src/ai/runtime/external-runtime.types.ts
apps/api/src/ai/runtime/external-runtime.service.ts
apps/api/src/ai/runtime/external-runtime-config.service.ts
apps/api/src/ai/runtime/codex-runtime.adapter.ts
apps/api/src/ai/runtime/deerflow-runtime.adapter.ts
apps/api/src/ai/runtime/product-runtime.service.ts
apps/api/src/ai/runtime/local-protocol-renderers.ts
```

主 orchestrator：

```text
apps/api/src/ai/ai-orchestrator.service.ts
apps/api/src/ai/vibe.service.ts
apps/api/src/ai/vibe-stream.service.ts
```

当前支持 runtime task：

- `intake_requirement`
- `generate_prototype`
- `prototype_code_generation`
- `patch_prd`
- `patch_prototype`
- `qa_review`

DeerFlow adapter 目前是 gateway adapter，未接真实 DeerFlow 2.0 服务实例。

## 10. Knowledge Vault 说明

如果本地只剩 `knowledge-vault/**` 或看到相关目录变化：

- 这是知识库内容目录，不是自研 agent 编排代码。
- 线上 Knowledge 页面使用 Quartz/Knowledge 容器展示。
- 部署时 `apps/api/storage` 不参与 rsync，避免覆盖线上上传/运行时内容。
- 不要随手删除或重置 `knowledge-vault/**`，除非用户明确要求。

## 11. 重要注意事项

不要做：

```bash
git reset --hard
git checkout -- .
docker volume prune
docker system prune --volumes
```

原因：

- 可能清掉用户工作区变更。
- Postgres 数据在 Docker volume 里。

可以做：

```bash
docker container prune -f
docker image prune -f
```

部署脚本已经包含非 volume 清理。

## 12. 下一步建议

优先级从高到低：

1. 优化 Codex prompt 输入体积。最近一次 `runtime-input.json` 可到 299KB，Codex 单轮耗时约 180 秒，应压缩 recent context、knowledge refs 和历史 PRD 内容。
2. 增强前端 runtime progress 展示。当前 stream 有 `message_delta`，但 UI 可进一步展示 Codex 当前步骤、等待状态、空闲计时。
3. RuntimeStepLog 细化。目前主要靠 `vibe_stream_event_logs` 看过程，`agent_step_logs` 还不够丰富。
4. DeerFlow 2.0 真实服务接入。保持原则：只写 adapter，不在本项目复刻 DeerFlow 编排。
5. 为 Codex runtime 增加更严格 schema 校验和自动修复。当前 adapter 会 normalize，但可以增加 schema error -> Codex repair pass。
6. 对原型生成路径做真实浏览器 smoke。生成 HTML 后用 Playwright 检查非空、布局、基础交互和安全规则。
7. 清理旧 running run 记录。数据库里有一些 2026-06-23 到 2026-06-25 的历史 running 记录，可写安全 migration/job 标记为 failed/stale，避免 admin 日志误导。

## 13. 新对话启动提示词

可以在新对话中直接发：

```text
继续 Vibe Coding 项目。请先阅读 /Users/liyannong/ai-product-workbench/docs/handoff-vibe-coding-2026-06-26.md。

项目原则：
- 不维护自研 agent 编排。
- 只维护 Vibe Coding 产品协议、状态机和 runtime adapter。
- 底层执行使用 Codex CLI 或 DeerFlow。
- 每次重要修改后跑 typecheck/test/build，推 GitHub，并部署到 8.130.160.177。

当前优先任务：继续完善 Codex runtime 产出链路，优先优化 prompt/context 体积、前端进度展示、RuntimeStepLog，以及 DeerFlow 2.0 adapter 接入。
```
