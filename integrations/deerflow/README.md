# 产品工作台 DeerFlow 部署合同

产品工作台把 DeerFlow 作为唯一生产 Runtime。Workbench 管理 Project、Thread、Run、Artifact 和知识授权；DeerFlow 管理模型执行、工具与子 Agent。两侧只通过固定的 Gateway/LangGraph 合同连接。

## 生产形态

- Runtime assistant 固定为 DeerFlow 内置 `lead_agent`。
- 本目录的 `skills/workbench/` 与原样 vendored `skills/requirement-doc-template/` 必须随 DeerFlow 镜像或部署，以只读方式出现在各自的 `DEER_FLOW_SKILLS_PATH/public/` 子目录。
- `workbench` 与 `requirement-doc-template` 必须被 DeerFlow 识别为已启用的 `public` skill；不得安装到某个用户的 `skills/custom/` 后宣称全租户可用。
- 不使用 DeerFlow 的 legacy shared agent/skill fallback。Workbench 用户仍通过 `X-DeerFlow-Owner-User-Id` 获得独立的 Thread、上传和运行上下文。
- Runtime Worker 只持有与 DeerFlow `DEER_FLOW_INTERNAL_AUTH_TOKEN` 对应的服务令牌。该令牌不具备管理员权限。
- DeerFlow 部署必须注册本仓库 `runtime-tools/` 中 5 个核心受信工具：`workbench_artifact_draft_publish`、`workbench_generation_stage_update`、`workbench_prototype_patch_publish`、`workbench_knowledge_retrieve`、`workbench_runtime_result_submit`。Draft 和 Stage 对 PRD/Prototype Run 可见，Patch 仅对 Prototype Run 可见；它们把真实草稿、工作阶段与单屏 typed patch 保存为绑定 Run、RuntimeAttempt 与 `tool_call_id` 的 ToolMessage artifact。时间值只控制前端动画时长，不控制阶段触发。Patch 只允许稳定 Prototype ID 操作，不接受 selector/DOM mutation、共享 token/asset/variable 更改或模型自报的 scope/source ID。Result submit 工具使用随仓库生成的单文件 Zod bundle，在同一 Run 内返回精确 issue path，并把唯一成功结果保存为 ToolMessage artifact；Worker 只接受当前用户轮次的该 artifact 并再次执行相同合同。完整 Knowledge capability 只能由 DeerFlow request-scoped `runtime.context.secrets.WORKBENCH_KNOWLEDGE_CAPABILITY` 注入；不得放入 `configurable`，也不得写入 message/state、模型参数、checkpoint、trace、事件、日志或工具结果。模型可见 `<workbench_context>` 只包含 tokenless reference。Knowledge 工具的 `Idempotency-Key` 只由稳定 `tool_call_id` 加固定 v1 域前缀后取 SHA-256，必须跨 capability token 轮换保持不变，且不得包含 token、查询正文或原始 tool call id。未注册 Knowledge 工具或所用 DeerFlow commit 不具备 request-scoped secret 隔离与持久化脱敏时，带 Knowledge Release 的 Run 必须 fail closed。
- 同一 `workbench` group 还必须静态注册 8 个 Canvas 工具：`get_visible_screens`、`get_selected_screens`、`view_screen`、`select_screen`、`quick_edit`、`duplicate_screen`、`rename_screen`、`navigate_canvas`。静态注册和 Skill `allowed-tools` 只解决 DeerFlow 可发现性，不代表每个 Run 都获得全部权限；每轮可执行集合仍以签名、短期、request-scoped `canvasTool.declaredTools` descriptor 为准，Python client、Workbench API 和 Worker 因果校验都会拒绝未声明工具。
- 固定 DeerFlow commit `7a6c4a994a86583d2a3c056ee9d0f157d4f030c2` 通过候选镜像内的审计 source patch 安装 `WorkbenchToolScopeMiddleware`，并修复 Gateway 的 Workbench request-context 透传边界。Runtime Worker 只把 tokenless `{ declaredTools }` 写入 `configurable.workbench_canvas_tools`；DeerFlow graph factory 从该 Run 的 `RunnableConfig.configurable` 读取并冻结策略，middleware 在每次 `wrap_model_call` 只保留本 Run 声明的 Canvas schema，并在同步/异步 `wrap_tool_call` 对未声明 Canvas 工具返回固定错误而不执行 handler。descriptor 缺失、非对象、额外字段、未知/重复/乱序工具都按空集合处理，8 个 Canvas schema 全隐藏且执行全拒绝。Knowledge 只有在可信 `context.workbench.knowledgeEnabled=true` 与 request-scoped capability 同时存在时才可见、可执行；否则 schema 隐藏且伪造调用在同步/异步 ToolNode 路径均被阻断。`context`、checkpoint 或前一次 Run 的状态不能提升权限。Gateway 只接受被 `AuthMiddleware` 服务器标记为 `system_role=internal` 的请求传递 `context.workbench`，只筛选 `WORKBENCH_KNOWLEDGE_CAPABILITY` 与 `WORKBENCH_CANVAS_CAPABILITY` 到运行时 secret channel；普通 caller、`body.config`、Run kwargs 和 configurable 中的保留字段均 fail closed。其余 4 个核心 Workbench 工具及其他 DeerFlow 工具不受影响。Python client、Workbench API 和 Worker 因果校验继续作为纵深校验，不能由该模型侧过滤替代。
- `view_screen` 只有在 durable tool result 成功且包含当前 `visualCapabilityId` 后，才使用同一短期 bearer capability 从 descriptor 的 `visualEndpoint` 单独 GET 截图。Python client 禁止 redirect，单次超时 10 秒，只接受 WebP/JPEG/PNG 和最多 1 MiB，并核对长度、ETag、SHA-256 与不超过 grant 的视觉过期时间。截图使用固定 DeerFlow 依赖 `langchain-core 1.3.3` 的标准 `ImageContentBlock`：`{"type":"image","base64":"...","mime_type":"image/webp"}`；base64 只进入模型可见的 `ToolMessage.content`，不得写入 Canvas durable result、ACK 或 ToolMessage artifact。

派生 DeerFlow 镜像在构建阶段完成两项安装：把 skill 嵌入 public skill 根，并把 trusted tool Python package 放进 DeerFlow harness 的 import path：

```text
<repository-root>/integrations/deerflow/skills/workbench/
  -> derived image: /app/skills/public/workbench/

<repository-root>/integrations/deerflow/skills/requirement-doc-template/
  -> derived image: /app/skills/public/requirement-doc-template/

<repository-root>/integrations/deerflow/runtime-tools/deerflow_workbench_tools/
  -> derived image: /app/backend/deerflow_workbench_tools/

<repository-root>/integrations/deerflow/source-patches/7a6c4a.../
  -> build-only verifier: /opt/workbench/deerflow/source-patch/
  -> patched module: /app/backend/packages/harness/deerflow/agents/middlewares/workbench_tool_scope_middleware.py
```

Source patch manifest 同时固定 canonical upstream repository、upstream commit、`lead_agent/agent.py`、Gateway `app/gateway/services.py` 和 subagent tool 的 upstream/patched SHA-256、新增 middleware、applier 和两组合同测试 SHA-256。Gateway patch 通过独立 `gatewaySources` 根目录应用，避免把上游 Gateway 文件混入 harness 路径；它只将能力凭证交给 ephemeral `ToolRuntime.context`，不把它写入 `configurable` 或 Run 持久化 kwargs。派生镜像构建时必须对真实 LangChain/LangGraph 依赖运行 middleware 与 Gateway context 单测并二次 `--check`；镜像 label 与生产 preflight 再绑定该 manifest SHA-256。任何上游源码漂移、build arg commit 漂移、补丁/测试文件漂移或镜像 label 缺失都会 fail closed。

把 `runtime-tools/config.fragment.yaml` 中的 `tool_groups`/`tools` 条目合并进 DeerFlow `config.yaml`。启动验收必须确认 `workbench` group 精确包含上述 5 个核心受信工具与 8 个 Canvas 工具，public Skill 的 `allowed-tools` 也精确放行这 13 个注册工具；不得用任意模块、任意工具前缀或“至少包含”替代精确白名单。同时验证未在当前 descriptor 声明的 Canvas 调用会 fail closed，且 Run API/trace/checkpoint 中不存在 `WORKBENCH_KNOWLEDGE_CAPABILITY`、`WORKBENCH_CANVAS_CAPABILITY`、`wbkg1.` 或 `wbct1.`。

不要把整个产品仓库挂进 DeerFlow。只交付该 skill、trusted tool package 和配置片段，并由 DeerFlow commit、镜像 digest 或发布清单固定版本。

### 仓库生产编排

生产只使用 `deploy/deerflow-runtime-compose.yml`。它直接引用固定 OCI digest，不依赖服务器上预先存在的 DeerFlow Git checkout，也不叠加上游 `docker-compose.yaml` 或匿名 gateway-only overlay。发布候选、固定镜像和批准的 secrets/config 足以在干净主机重建 Runtime。

编排固定以下边界：

- 镜像内的上游 skills 保持不可变；本仓库的 `workbench` 与 canonical `requirement-doc-template` 在派生镜像构建时嵌入各自的 `/app/skills/public/` 子目录。受控 public 根只包含这两个 skill，避免继承旧 custom skill 或服务器手工副本。
- `runtime-tools/deerflow_workbench_tools` 在派生镜像构建时嵌入 `/app/backend/deerflow_workbench_tools`。当前包没有独立 `pyproject.toml`，而 DeerFlow 启动时已把 `/app/backend` 放入 Python import path，因此生产形态不执行临时 `pip install`，也不挂载主机源码。
- `deploy/deerflow-extensions.production.json` 只显式启用 public `workbench` 与 canonical `requirement-doc-template`，不继承旧 custom skill、旧 MCP server 或管理员 bootstrap 状态。
- Gateway 同时加入受控 provider egress 与 Workbench internal network，内部别名固定为 `deerflow`；2026 只发布到宿主 `127.0.0.1` 供运维探测。
- `DEER_FLOW_AUTH_DISABLED=0` 且环境固定为 production；Runtime 服务令牌只从 `WORKBENCH_DEERFLOW_INTERNAL_AUTH_TOKEN` 注入。

DeerFlow 只读取一个 `config.yaml`，Compose 本身不会合并 `tool_groups`/`tools` 数组。发布前必须用结构化合并器生成独立 effective config；禁止用 `sed`、字符串拼接或直接改上游 config：

```bash
npm run deerflow:config:merge -- \
  --base "$WORKBENCH_DEERFLOW_BASE_CONFIG_PATH" \
  --fragment integrations/deerflow/runtime-tools/config.fragment.yaml \
  --output "$DEER_FLOW_CONFIG_PATH"
```

合并器按 `name` 合并：完全相同的既有条目可幂等重放，同名异值、重复名、未知 group、额外 fragment 顶层字段都会失败；输出原子替换且权限固定为 `0600`。部署前再执行只读检查：

```bash
npm run deerflow:deployment:check
WORKBENCH_APP_DIR=/opt/workbench \
WORKBENCH_ENV_FILE=/opt/workbench/deploy/workbench.env \
/opt/workbench/deploy/deerflow-production-preflight.sh
```

Preflight 要求：provider env 与 base config 来自批准的只读 secret/config 目录；`DEER_FLOW_HOME` 是独立目录；effective config 未漂移且为 `0600`；本机 RepoDigest、Cosign 签名和候选镜像证据都与固定 image digest 一致；独立 Compose 渲染成功；共享网络仍是 internal。通过后只允许用该已验收镜像 `up --no-build --force-recreate deerflow`，禁止在生产服务器临时构建另一个未签收 digest。

### Request-scoped secret 门禁

仅安装工具不代表 Knowledge 链路可用。派生镜像中的 Gateway patch 必须只对通过内部令牌认证并被服务器标记为 `system_role=internal` 的请求接受 `WORKBENCH_KNOWLEDGE_CAPABILITY`，只把它交给本次 `ToolRuntime.context.secrets`，并确保 RunnableConfig 的 `configurable`、Run `kwargs`、checkpoint、event stream、日志和 trace 均不含 secret。`context.workbench` 与能力凭证不能从普通 caller 的 `body.config` 或伪造 owner header 提升权限；能力必须与合法 `runId`/`runtimeAttemptId` scope 同时存在，缺失或 malformed scope 时 fail closed。不得把 capability 改放 `configurable` 或持久化 config 来绕过门禁。

本仓库不通过 sitecustomize、启动 monkey patch 或复制上游模块实现该能力；能力只存在于固定 commit 的显式 Gateway source patch。对应 CI/发布流程必须为精确 commit/image 生成 `workbench.deerflow-request-scoped-secrets-attestation.v1`；格式见 `deploy/deerflow-secret-channel-attestation.example.json`。六项检查未全通过、凭证缺失、commit/image 不一致时，`deerflow-production-preflight.sh` 一律 fail closed。

第一次硬切必须使用新的空 `DEER_FLOW_HOME`。旧 home 中的 user/thread、Agent memory、SQLite/WAL/SHM 和 custom history 不迁移、不备份到新系统；新实例通过完整 smoke 后删除旧 release/home，而不是选择性复制文件。

## 管理员验证安装

`npm run deerflow:bootstrap` 使用真实 DeerFlow admin 会话，在该管理员自己的 per-user 空间测试 Agent/skill 写入、上传、安装和启用流程。它只接受 `DEERFLOW_ADMIN_ACCESS_TOKEN`，不会回退到内部服务令牌，也不会发送 owner header。

Bootstrap 成功不是生产就绪证明，因为 custom Agent 和 custom skill 都按 DeerFlow 用户隔离。生产发布仍必须执行上面的 PUBLIC skill 交付。

## 验收

构建 Workbench Runtime adapter 后，使用部署实例的内部服务令牌运行：

```bash
npm --workspace @workbench/workbench-contracts run build
npm --workspace @workbench/workbench-worker run build
DEERFLOW_INTERNAL_AUTH_TOKEN="<runtime-service-token>" \
npm run runtime:deerflow:smoke
```

Smoke 使用随机 Workbench principal，先验证：

1. `workbench` 对该新租户可见、分类为 `public` 且已启用。
2. DeerFlow 模型目录至少包含一个真实 `model.name`。
3. `lead_agent` 能创建 Thread/Run，通过 `workbench_runtime_result_submit` 成功提交并返回一个 document Artifact。
4. 结果使用 `workbench.runtime.result.v1` 和 `operation:create`。
5. submit 工具名、validated ToolMessage artifact 和候选 JSON 均不泄漏到用户可见 delta。

任何一项失败都必须阻止发布。模型出现在目录中但缺少真实 provider 凭据，也不算通过；必须完成一次真实生成。

### Knowledge trusted tool 生产验收

上面的基础 smoke 不携带 Knowledge Release，不能证明 trusted tool 可用。生产发布还必须执行独立的 Knowledge smoke；该命令不会在参数缺失、非生产环境或调用失败时退回基础 smoke。

先在真实 Workbench 数据库准备一次性验收夹具：

- 一个通过正常 Workbench API 创建的 `queued` Run，prompt 明确要求先调用 `workbench_knowledge_retrieve`，并包含验收 query，但不得包含预期 probe 或 citation；Run 必须 pin 到目标 `ready` KnowledgeRelease，且尚未产生 RuntimeAttempt 或 output entry。
- 准备和执行期间暂停该验收 Run 的队列消费，避免生产 Worker 抢占。RuntimeBinding 和 RuntimeAttempt 由 smoke 内的真实 `RunProcessor` 按正常路径创建，不能手工写业务表。
- Run 的 Principal 必须为 active ProjectMember；Project、Thread 必须 active；workspace-scoped release 必须属于同一 Workspace。
- 目标 release 中应有一个不会出现在 prompt 的高熵 probe，以及可唯一定位的 citation id 或 sourcePath 片段。

构建和纯逻辑门禁：

```bash
npm run runtime:deerflow:knowledge:smoke:test
```

生产执行需要 Worker 的正常生产变量，并额外显式传入以下验收范围。示例省略的 S3、Knowledge provider、DeerFlow 和数据库生产变量仍由 Worker 配置严格校验，不能使用假地址或假凭据：

```bash
NODE_ENV=production \
WORKBENCH_KNOWLEDGE_SMOKE_RUN_ID="<queued-run-id>" \
WORKBENCH_KNOWLEDGE_SMOKE_PRINCIPAL_ID="<active-principal-id>" \
WORKBENCH_KNOWLEDGE_SMOKE_PROJECT_ID="<active-project-id>" \
WORKBENCH_KNOWLEDGE_SMOKE_RELEASE_ID="<ready-release-id>" \
WORKBENCH_KNOWLEDGE_SMOKE_QUERY="<query present in the stored Run prompt>" \
WORKBENCH_KNOWLEDGE_SMOKE_EXPECTED_PROBE="<high-entropy text only present in the release>" \
WORKBENCH_KNOWLEDGE_SMOKE_EXPECTED_CITATION="<citation id or sourcePath fragment>" \
npm run runtime:deerflow:knowledge:smoke
```

该命令通过真实 `RunProcessor` 和 `PrismaKnowledgeToolGrantIssuer` 签发短期 capability，由 `lead_agent` 的 request-scoped `runtime.context.secrets` 调用已注册的 `workbench_knowledge_retrieve`。验收必须同时满足：

1. Workbench immutable invocation ledger 中存在 `succeeded` response，release id、probe 和 citation 都匹配。
2. DeerFlow ToolMessage 中存在同一次 trusted tool 调用，且与 ledger response 共享完全一致的 citation 指纹；只在 assistant 文本中伪造结果不能通过。
3. 最终 Workbench output 同时包含 probe 和 citation。
4. DeerFlow Run API（含 `kwargs`）、Thread context/config/values、当前 state、完整 checkpoint history，以及 Workbench Run/event/draft/output/grant surfaces 均不含 `wbkg1.` 或 `WORKBENCH_KNOWLEDGE_CAPABILITY`。checkpoint history 达到查询上限时按不完整处理并失败。

当前 DeerFlow/LangGraph Run API 不提供部署侧 trace backend 的读取端点。因此命令会把 `traceAudit.status` 明确输出为 `external_gate_required`，不会声称 trace 已验证。发布系统必须再按该 Run 的 Workbench `traceId`、external Run id 和执行时间窗查询实际 OTLP/Langfuse/LangSmith 后端，确认 span attributes、events、logs 和 archived payload 中没有 capability；这一步完成前，生产发布仍然阻断。
