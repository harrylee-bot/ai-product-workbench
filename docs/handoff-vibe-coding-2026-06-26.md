# Vibe Coding 项目交接文档（2026-06-26）

## 1. 当前目标

这个项目是 `ai-product-workbench`，当前重点是让 Vibe Coding 产品链路保持“用户能发消息、能看到 runtime 执行过程、能测试生成链路”的状态，然后继续把外部 runtime adapter 接到产品协议上。

用户当前最关心的不是代码优雅，而是：

1. 平台能正常发消息。
2. runtime 链路不要黑盒，要能流式展示执行过程。
3. 先能在线上测试，再继续接入 Codex / DeerFlow runtime adapter。
4. 后续按文档里的真实 Vibe Coding 链路继续改造：
   `Intent -> Knowledge(async) / Context fetch(async) / Requirement -> Planner / Validator / Safety check`

## 2. 项目位置

本地项目路径：

`/Users/liyannong/ai-product-workbench`

线上服务器：

`8.130.160.177`

线上主要访问：

- Web: `http://8.130.160.177:3000/login`
- API health: `http://8.130.160.177:4000/api/system/health`
- Knowledge: `http://8.130.160.177:3001`

注意：不要把用户提供过的真实 API Key、服务器密码写进代码或提交到 GitHub。当前 `.env.example` 应保持占位符。

## 3. 线上当前状态

截至 2026-06-26 11:29 左右，本轮重构已经推送到 GitHub `main`：

- 后续补丁：API Docker 镜像安装 `@openai/codex`，`CODEX_CLI_VERSION` 可通过 `.env` / compose / deploy script 控制。
- `b0371c0 chore: pass runtime config through deploy`
- `d0c364c feat: switch vibe execution to external runtimes`

2026-06-26 11:34 更正并复测：线上服务器是 `8.130.160.177`，不是 `45.207.206.76`。本轮已把部署默认地址、前端知识库默认地址和 Quartz 配置改回 `8.130.160.177`。此前针对 `45.207.206.76` 的 SSH/HTTP 探测属于误测，不代表真实线上状态。

正确服务器当前探测结果：

- SSH：`root@8.130.160.177` 可连接。
- Web：`http://8.130.160.177:3000/login` 返回 200。
- API health：`http://8.130.160.177:4000/api/system/health` 返回 200，但模块列表仍包含旧的 `intent-agent`、`decision-engine`、`company-runtime` 等，说明线上仍是部署前旧版本。
- Knowledge：`http://8.130.160.177:3001/__health` 返回 `ok`。

本地验证通过：

- `npm run build`
- `npm run test`：28 个测试文件、114 个测试全部通过。

线上部署尚未完成，需要使用正确服务器 `8.130.160.177` 执行：

```bash
ssh root@8.130.160.177
cd /opt/ai-product-workbench
bash deploy/server-deploy.sh
```

脚本会拉取 `origin/main`。

截至 2026-06-26 09:10 左右，公网 API 可用：

- `/api/system/health` 正常返回。
- `/api/auth/login` 可登录。
- `/api/projects` 可创建项目。
- `/api/ai/vibe/handle-message` 可返回 `runId`。
- `/api/ai/vibe/runs/:runId/stream` 可输出 SSE 事件。

最近一次真实链路测试结果：

- `intent_detection` 成功。
- `knowledge_retrieval` 成功。
- `requirement_analysis` 成功。
- `product_design` 已创建状态版本。

说明：用户说“消息发不出去”的根因不是前端按钮本身，而是之前默认模型 `claude-opus-4-6` 在真实 agent 调用里返回：

```text
Service temporarily unavailable
```

导致第一步 `intent_detection` 失败，看起来像消息没发出去。

## 4. 当前可用模型配置

用户提供过两个方向：

1. Claude:
   - Name: `XXTF Claude`
   - Base URL: `https://xxtf.baby`
   - Model: `claude-opus-4-6`
   - 实测 `/v1/messages` 和 `/v1/chat/completions` 单次调用都能返回 `ok`
   - 但真实 Vibe agent 链路里失败，返回 `Service temporarily unavailable`

2. OpenAI-compatible:
   - Base URL: `https://xxtf.baby/v1`
   - 可用模型实测：
     - `gpt-5.5` 可用
     - `gpt-5.4` 可用
     - `gpt-5.4-mini` 可用
     - `gpt-5.2` disabled

当前线上数据库已通过管理 API 切到：

```text
Provider: XXTF OpenAI
Base URL: https://xxtf.baby/v1
Model: gpt-5.5
```

本地默认配置也已同步到：

- `.env.example`
- `deploy/docker-compose.yml`
- `deploy/server-deploy.sh`
- `apps/api/src/model-gateway/model-gateway-defaults.service.ts`

## 5. 重要隐患

SSH 使用正确服务器 `8.130.160.177` 已确认可连接。此前连接失败是因为误用了 `45.207.206.76`：

```text
Connection timed out during banner exchange
Connection to 45.207.206.76 port 22 timed out
```

因此当前线上模型切换是通过管理 API 修改数据库完成的，不是通过重启 API 容器完成的。

风险：

如果 API 容器未来重启，而容器环境变量里仍是旧的 `XXTF Claude / claude-opus-4-6`，`ModelGatewayDefaultsService` 可能会在启动时把数据库默认模型重新刷回 Claude。

SSH 恢复后第一件事：

1. 重启 API 容器时使用 `XXTF OpenAI / gpt-5.5`。
2. 检查容器环境变量。
3. 检查启动日志是否是：

```text
默认模型配置已就绪：XXTF OpenAI / gpt-5.5
```

## 6. 临时线上修复方式

如果 SSH 仍不可用，但 API 可访问，可以用管理 API 切模型。

默认账号来自 seed：

```text
admin / Admin123456
zhangsan / User123456
```

不要在文档里写真实模型 API Key。需要时让用户重新提供，或在管理后台手动填。

管理接口大致流程：

1. `POST /api/auth/login` 登录 admin。
2. `GET /api/admin/model-providers` 找当前默认 provider。
3. `PATCH /api/admin/model-providers/:providerId` 改 name/baseUrl/apiKey/isDefault。
4. `GET /api/admin/model-configs` 找当前任务使用的 config。
5. `PATCH /api/admin/model-configs/:modelConfigId` 改 modelName/displayName/providerId。
6. `GET /api/admin/model-task-profiles` 确认所有 task profile 的 modelName/providerName 都切过去。

当前线上曾使用的关键 ID：

```text
providerId: 3f3646b2-5afc-4d35-87b5-1534aaf04101
modelConfigId: 68c5542b-9082-45af-bbf2-69d57a79ec71
```

它们已被原地改成 `XXTF OpenAI / gpt-5.5`。

## 7. 已发现的构建阻塞

线上完整 `deploy/server-deploy.sh` 触发 Docker build 时，API TypeScript 编译失败。错误点包括：

```text
src/ai/product-design-state.service.ts
Type 'ProductDesignStateStatus' is not assignable to narrowed status union

src/ai/prototype.service.ts
'openPencilDocument' does not exist in PrototypeArtifact create input

src/knowledge/knowledge-embedding.service.ts
Property 'knowledgeEmbedding' does not exist on PrismaService
```

这几个问题导致“重新构建镜像部署”过不去。

之前为了先恢复线上可用，绕过了完整 build，直接用服务器已有镜像热起容器。后续必须修掉这些 TS 编译错误，否则无法稳定发布新代码。

## 8. 当前本地 Git/代码状态提醒

工作区不是干净状态。已知本地有修改：

- `.env.example`
- `deploy/docker-compose.yml`
- `deploy/server-deploy.sh`
- `apps/api/src/model-gateway/model-gateway-defaults.service.ts`
- `apps/api/src/common/http-exception.filter.ts`
- `apps/web/src/lib/api.ts`

其中前四个和模型默认值有关。后两个来自之前修复错误输出/前端 API 错误展示相关工作，需要新对话接手时先看 diff，不要直接丢。

不要使用 `git reset --hard` 或 `git checkout --` 清理，避免误删用户和前序修改。

## 9. 用户对 runtime 链路的最新产品要求

用户最新决策是：不再维护自研 agent 编排，只维护 Vibe Coding 产品协议、状态机和 runtime adapter。旧本地主链路已经从活跃路径删除，后续由 DeerFlow / Codex runtime 接管长任务、协作、文件生成和代码修改。

最新准则：不要自己写底层。底层执行、任务编排、工具调用、沙箱、多智能体协作和代码修改能力只使用 Codex CLI 或 DeerFlow；本项目只写 adapter、schema、状态机、确认门、权限审计和 artifact 落库。

2026-06-26 本轮继续清理后，Phase2/3/4/5 实验链路也已删除：`decision/evolution/company/self-generation/review-board/product-evolution` 不再进入构建或测试目标。PRD、PrototypeSpec、HTML、PatchPlan、QA 只保留 `ProductRuntimeService` + `local-protocol-renderers` 的确定性 fallback。

2026-06-26 继续清理：前端 `workspace-preview` 已从 `Phase2DecisionView` 收窄为 `RuntimePatchPreview`；状态/QA/反馈面板不再读取 Company/Self-generation/Evolution 字段；旧 `/agent-debug` 页面已删除；admin 日志入口改为 `/admin/logs/runtime-runs`，内部仍调用历史 `/admin/logs/agent-runs` API 以兼容数据库表名；runtime adapter 代码已从 `AgentRuntime*` 命名改为 `ExternalRuntime*` / `Runtime*`。

2026-06-26 继续接入：`ProductRuntimeService` 已把 PrototypeSpec、PatchPlan、QA 改成优先外部 runtime task；`VIBE_PROTOTYPE_SPEC_RUNTIME`、`VIBE_PATCH_PLAN_RUNTIME`、`VIBE_QA_RUNTIME` 可分别切到 `codex` 或 `deerflow`。Codex adapter 通过 Codex CLI 生成结构化 `runtime-output.json`；DeerFlow adapter 通过 `vibe.runtime.task.v1` 透传通用 runtime task。未配置或失败时仍按 `VIBE_RUNTIME_FALLBACK_TO_LOCAL` 决定是否走确定性协议 fallback。

用户不想继续黑盒改执行链路。前端需要像当前 Codex 聊天一样，用人能看懂的自然语言展示执行过程，不展示裸 JSON。

调试阶段用户希望看到完整流程输出、决策摘要、确认门、失败原因和 runtime task 的执行步骤。不能只转圈。

注意边界：不要展示模型私密 chain-of-thought 原文，但可以展示 runtime 的“执行思路、判断依据、输入输出摘要、风险、下一步动作”。

## 10. 已写过/需要继续维护的文档

重点文档：

- `docs/vibe-coding-execution-chain.md`
- `docs/vibe-coding-agent-charter.md`

这两个文档已经改为 runtime adapter 职责边界，旧自研主链路不再是维护目标。

新对话接手时建议先读：

1. `docs/vibe-coding-execution-chain.md`
2. `docs/vibe-coding-agent-charter.md`
3. `apps/api/src/ai/ai-orchestrator.service.ts`
4. `apps/api/src/ai/runtime/external-runtime.types.ts`
5. `apps/api/src/ai/runtime/external-runtime.service.ts`
6. `apps/web/src/app/workspace/phase1-workspace-client.tsx`
7. `apps/web/src/components/chat-panel.tsx`

## 11. 下一步建议顺序

第一优先级：保证用户能继续测试。

1. 让用户刷新页面，重新发一条消息。
2. 如果仍显示不能发，先看浏览器控制台 Network：
   - `POST /api/ai/vibe/handle-message`
   - `GET /api/ai/vibe/runs/:runId/stream`
3. 如果后端有 `run_failed`，优先看 SSE 的 `step_failed` 内容。
4. 如果模型又变回 Claude，说明容器重启把默认值刷回去了，需要修 SSH 后重启容器环境。

第二优先级：修构建。

1. 修 API TS 编译错误。
2. 本地或服务器跑 API build。
3. 重新构建镜像。
4. 让 `deploy/server-deploy.sh` 可以完整跑通。

第三优先级：继续 runtime adapter 改造。

1. 已完成：旧本地主链路删除；`PrototypeSpec -> HTML` 已接入 Codex runtime facade。
2. 已完成：DeerFlow gateway 已接到普通需求 intake，返回 `ProductDesignDraft`、`RequirementDocumentDraft`、风险和澄清问题；Vibe 负责落库并停在 `review_prd`。
3. 下一步：PatchPlan、QA、PRD JSON、PrototypeSpec 逐步改成 runtime task。
4. 每步都写入 `vibe.stream.payload.v1`，前端展示自然语言摘要。
5. 超时策略继续遵守用户要求：只要 runtime 还在输出文字，就不应因为固定总时长直接判超时；只有请求无输出/网络无响应才算超时。

## 12. 快速验证命令参考

公网 health：

```bash
curl -sS http://8.130.160.177:4000/api/system/health
```

登录普通用户：

```bash
curl -sS \
  -H 'Content-Type: application/json' \
  -d '{"account":"zhangsan","password":"User123456"}' \
  http://8.130.160.177:4000/api/auth/login
```

测试模型池：

```bash
curl -sS \
  -H "Authorization: Bearer <API_KEY>" \
  https://xxtf.baby/v1/models
```

测试 `gpt-5.5`：

```bash
curl -sS \
  -H "Authorization: Bearer <API_KEY>" \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-5.5","messages":[{"role":"user","content":"reply ok"}],"max_tokens":8}' \
  https://xxtf.baby/v1/chat/completions
```

## 13. 接手时一句话总结

最新方向：旧自研主链路和 Phase 实验链路已经下线，Vibe 只维护产品协议、状态机和 runtime adapter；下一位接手应配置真实 Codex CLI / DeerFlow gateway 做端到端运行验证，并把前端 runtime events 做成自然语言可观测输出。最近一次验证：`npm run build` 通过，`npm run test` 通过（28 个 test files / 114 个 tests）。
