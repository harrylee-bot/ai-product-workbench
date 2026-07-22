# 产品工作台

产品工作台是一套以 DeerFlow 为唯一生产 Runtime 的产品需求、知识、原型和交付工作台。新系统采用独立合同、数据库、API、Worker、预览与导出链路，不兼容、不转发、不双写旧业务接口和旧对话数据。

当前施工与验收以 [绿地实施方案](docs/workbench-greenfield-implementation-plan.md)、[前端保真基线](docs/workbench-visual-baseline.md)、[开源复用策略](docs/workbench-open-source-reuse-strategy.md) 和 [硬切删除清单](docs/workbench-hard-cut-deletion-manifest.json) 为准。新链路通过生产门禁并切流后，旧应用与旧业务表将被物理删除。

## 当前边界

```text
Browser
  -> Next same-origin BFF / Better Auth session
  -> Workbench API / PostgreSQL / pg-boss
  -> Runtime Worker -> DeerFlow
  -> File + Knowledge Worker -> object storage / KnowledgeRelease
  -> Import Worker -> pinned URL / GitHub / Figma snapshots
  -> Export Worker + isolated Preview origin
```

浏览器只持有不透明会话 Cookie。业务事实由新 Workbench 合同和数据库管理；Run 事件持久化并支持重放，Artifact、Release、Share 和 Export 均固定到不可变版本。

原始项目对话不迁移。唯一迁移范围是 `knowledge-vault/`，以及其 Markdown 明确引用且通过校验和闭包的 `storage/` 文件。

## 新系统能力

- Workspace、成员、项目、线程、耐久 Run、审批、取消和精确重试。
- Board、Artifact、不可变版本、设计系统、Release、公开分享、重混和导出。
- Uppy multipart 文件上传、内容校验、病毒扫描、提取和知识发布链路。
- URL、GitHub 与 Figma 外部来源先由独立 Import Worker 固定版本、扫描并写成本地 Import Source，Run 不直接抓实时来源。
- 独立预览源、HTML/React/Figma/MCP 导出和权限固定的 Blob 内容读取。
- 当前高保真前端的布局、交互、动效和动画保持不变，数据与命令通过模块化 feature 层接入。

## 本地启动

源码热更新时，先在根目录 `.env.local` 或 `.env` 配置 Workbench 数据库、对象存储、DeerFlow 和鉴权变量，并确保这些外部依赖已经运行，然后执行：

```bash
npm run dev
```

该命令只启动新 `workbench-api`、Runtime Worker 和 Web，不启动旧 API。浏览器业务请求固定通过 Web 同源 `/api/v1` BFF；`WORKBENCH_API_INTERNAL_URL` 只供 Next 服务端访问 Workbench API，不得配置 `NEXT_PUBLIC_API_BASE_URL`。

需要连同 PostgreSQL、对象存储、Docling、ClamAV、Preview 等完整基础设施一起启动时，使用绿地 Compose：

```bash
npm ci
npm run workbench:prepare
cp deploy/workbench.env.example deploy/workbench.env
# 填写 DeerFlow、对象存储、Import provider、Docling、ClamAV 与所有强密钥配置；仅启用企业 SSO 时填写 OIDC
docker compose --env-file deploy/workbench.env \
  -f deploy/workbench-compose.yml \
  --profile local-object-storage \
  --profile local-docling \
  up -d --build
```

本地环境仍使用与生产相同的 Better Auth database session、短期 JWT 和 DeerFlow 合同，不提供绕过登录或伪造 Runtime 的开发后门。产品账号使用用户名或邮箱加密码直接登录；`WORKBENCH_ENTERPRISE_SSO_ENABLED=false` 时不加载 OIDC provider，也不显示 SSO 入口。只有显式设为 `true` 并完整配置 issuer、client id 和 client secret 后，用户选择“企业 SSO 登录”才进入 OIDC 跳转。将 `WORKBENCH_WEB_ORIGIN` 配为 `http://localhost:4180`、`WORKBENCH_PREVIEW_ORIGIN` 配为 `http://localhost:4190`。

初始化 DeerFlow 自定义 Agent 和 skill 时，必须使用真实管理员的短期 access token：

```bash
DEERFLOW_ADMIN_ACCESS_TOKEN="<raw-admin-access-token>" \
npm run deerflow:bootstrap -- \
  --gateway-url http://localhost:8001 \
  --langgraph-url http://localhost:8001/api
```

Bootstrap 会让 Agent 写入、临时 thread、skill archive 上传、安装/冲突重装和启用全程使用同一个真实 admin 会话，并按当前 DeerFlow Gateway 合同发送 `access_token` Cookie 和双提交 CSRF。`DEERFLOW_INTERNAL_AUTH_TOKEN` 只用于 Workbench Runtime 的服务间调用，不是管理员凭据，也不会被 bootstrap 当作回退值；脚本也不会发送 owner header 冒充用户。

DeerFlow custom agent/skill 是 per-user。这个命令只做管理员自身作用域的校验安装，成功不代表产品工作台 Runtime 已就绪，也不创建共享 skill。生产 DeerFlow 镜像/部署必须内置只读 PUBLIC `workbench` skill，不依赖 legacy shared fallback；Runtime 默认 assistant 仍为 `lead_agent`。

PUBLIC skill 的源/目标目录、凭据边界和真实 smoke 门禁见 [DeerFlow 部署合同](integrations/deerflow/README.md)。

## 授权 Knowledge Profile 运维身份

Knowledge Profile 管理面默认没有 operator，Workspace owner/admin 不会自动获得全局模型治理权限。首个 operator 只能由持有专用、短期且可审计数据库凭据的生产引导命令授权；目标 OIDC Principal 必须已经登录过产品工作台并存在于新数据库中。每次 grant/revoke 都要求批准人和变更单号，写入只追加、不可修改或删除的审计事件；相同变更单重放是幂等的。

```bash
WORKBENCH_MIGRATOR_DATABASE_URL="postgresql://workbench_migrator:..." \
npm run knowledge:profile-operator -- \
  --action=grant \
  --issuer=https://identity.example.com/realms/workbench \
  --subject=REPLACE_WITH_OIDC_SUBJECT \
  --authorized-by=security.lead \
  --change-reference=CHG-2026-0715
```

撤权使用同一命令并改为 `--action=revoke` 和新的变更单号。授权后，operator 才能通过受认证 API 创建 canonical candidate Profile、逐级执行 `candidate -> poc -> adopted`、退役 Profile，以及只读查询不可变 AdoptionReceipt。采用转换与回执在一个数据库事务提交；回执固定记录 profile kind、合同版本、spec SHA-256、actor、时间和 `global` scope。

## 创建知识发布

KnowledgeRelease 只能由受限运维身份创建，不提供浏览器或普通 OIDC 用户入口。命令使用 `WORKBENCH_MIGRATOR_DATABASE_URL` 直接访问新 Workbench 数据库，不接受 API/Web/Worker 共用的 runtime URL。生产 migrator 凭据必须只在受控、短期且可审计的运维会话中提供；命令本身不向任何外部知识库同步内容。File/Knowledge Worker 随后只读取本仓库 `knowledge-vault/` 与 Markdown 明确引用的 `storage/` 闭包。

执行前必须完成数据库迁移，并确认：

- EmbeddingProfile 与 RetrievalProfile 都已通过固定中文评测并进入 `adopted`；
- RetrievalProfile 固定的 embedding identity 与 File/Knowledge Worker 的 `WORKBENCH_KNOWLEDGE_EMBEDDING_PROFILE_ID`、spec SHA-256 和 TEI 部署完全一致；
- File/Knowledge Worker 已挂载只读 Vault/storage，且 `knowledge.release.build` 队列配置通过启动断言。
- File Worker 已挂载与 adopted EmbeddingProfile 同一 revision 的 Hugging Face tokenizer artifact；`tokenizer.json` 与 `tokenizer_config.json` 必须可读，且其 canonical artifact SHA-256 必须等于 profile 的 `tokenizer.artifactSha256`。

使用显式参数创建并原子入队：

```bash
WORKBENCH_MIGRATOR_DATABASE_URL="postgresql://workbench_migrator:..." \
npm run knowledge:release -- \
  --key=production \
  --version=1 \
  --embedding-profile=REPLACE_WITH_ADOPTED_PROFILE_ID \
  --retrieval-profile=REPLACE_WITH_ADOPTED_RETRIEVAL_PROFILE_ID
```

Workspace 级发布再增加 `--workspace=<workspace-id>`；不传表示全局发布。也可以通过 `.env.example` 中同名 `WORKBENCH_KNOWLEDGE_RELEASE_*` 变量提供参数。`key + version` 是全库自然幂等键：相同身份并发执行会串行化；已有 building 版本只补充或复用 singleton job，ready/retired 版本只返回现状；身份冲突会拒绝。failed 版本不可复活，修正原因后必须增加 version。

输出中的 `queueDisposition` 为 `created`、`already-queued` 或 `not-required`。队列采用 `exclusive + releaseId singletonKey`，同一 release 同时最多一个 queued/active job。pg-boss 不会覆盖已存在队列的配置；若启动报告 `KNOWLEDGE_RELEASE_QUEUE_CONFIGURATION_MISMATCH`，必须先停止生产者与消费者，确认该队列没有 queued/active job，再通过受控运维流程重建，不能带任务直接删除。

模型 tokenizer 不是运行时下载项。Compose 部署通过 `WORKBENCH_KNOWLEDGE_TOKENIZER_HOST_DIR` 将包含两份 JSON 的目录以只读方式挂载到 `/models/embedding-tokenizer`；File Worker 的内部路径固定为 `/models/embedding-tokenizer/tokenizer.json` 和 `/models/embedding-tokenizer/tokenizer_config.json`，单文件大小上限由 `WORKBENCH_KNOWLEDGE_TOKENIZER_MAX_FILE_BYTES` 控制。缺失、超限、非法 JSON 或 artifact pin 不一致都会让 Worker fail closed。

生产模型切换后，先更新 profile、tokenizer artifact 和 conformance probe，再创建新的 release version；不允许原地修改既有 profile 或复用旧版本。

模型服务上线前运行受控 conformance probe：

```bash
npm run knowledge:probe:hash -- ./ops/embedding-probe.json ./ops/reranker-probe.json
WORKBENCH_KNOWLEDGE_EMBEDDING_PROBE_PATH=./ops/embedding-probe.json \
WORKBENCH_KNOWLEDGE_RERANKER_PROBE_PATH=./ops/reranker-probe.json \
npm run knowledge:conformance
```

该命令会先校验数据库中的 profile/spec pin 和镜像 digest，再调用固定 TEI `/info`、`/tokenize`、`/embed` 与 `/rerank`，输出结构化 pass/fail 报告；没有真实 adopted profile、probe 文件或生产网络时不得把失败改成通过。

中文检索质量评测使用固定数据集/结果合同，输出 Recall、nDCG、p95 和 route leakage 报告：

```bash
npm run knowledge:retrieval:eval -- \
  --dataset=packages/workbench-knowledge/test/fixtures/retrieval-evaluation-dataset.v1.json \
  --results=packages/workbench-knowledge/test/fixtures/retrieval-evaluation-results.v1.json \
  --output-dir=storage/evaluation/knowledge-smoke
```

仓库 smoke fixture 只验证评测器和零泄漏门禁可执行；生产必须用固定中文标注集和真实 provider 结果重新生成，不能把 fixture 指标当成模型采用结论。

## Blob 垃圾回收

File Worker 负责保守的延迟 Blob GC。Reconciler 只为没有 byte-owning 持久引用的 Blob 写入 `gcEligibleAt`，等待 `WORKBENCH_BLOB_GC_GRACE_MS` 后再入队。Worker 在事务内锁定 Blob 并重新校验 FileAsset、FileExtraction 输入/输出、RunAttachment、ArtifactVersion/Asset、ArtifactCreationReceipt、KnowledgeDocument 和 ExportJob 引用；任一记录仍存在时均不会删除，包括已经软删除的 FileAsset。BlobScan 是保留的 non-owning 审计证据，不要求对象字节永久存在。

最终删除先把 Blob 数据库状态置为 `deleted`，再幂等删除对象；成功后写入 `storageDeletedAt`。对象存储失败由 `blob.gc` 的固定重试预算处理，进程在数据库提交和对象删除之间崩溃时，reconciler 会根据缺失的 `storageDeletedAt` 恢复任务。达到尝试上限后保留失败代码和 Blob 行，必须排查对象存储/IAM 后通过受控运维恢复，不能跳过数据库引用门禁手工批量删除。

服务入口：

- 产品工作台：`http://localhost:4180`
- 知识库：`http://localhost:4180/knowledge/`
- 隔离预览：`http://localhost:4190`

## 验证

```bash
npm run openapi:check
npm run openapi:breaking
npm run brand:check
npm run deployment:images:check
npm run hard-cut:manifest
npm run typecheck
npm run dev:workbench:test
npm run test
npm --workspace @workbench/web run test
npm run lint:workbench
npm run architecture:workbench
npm run build
```

## 部署

部署只使用绿地 Compose，不启动或回退旧 API：

```bash
cp deploy/workbench.env.example deploy/workbench.env
# 填写真实 PostgreSQL 16 + pgvector、S3、DeerFlow、ClamAV、Docling；server-validation overlay 还需启用并配置本地 Dex，
# 源站入口固定使用 Edge/Origin WireGuard 地址和独立 Edge 鉴权密钥。
WORKBENCH_ENV_FILE="$PWD/deploy/workbench.env" \
WORKBENCH_COMPOSE_OVERLAY="$PWD/deploy/workbench-server-validation-compose.yml" \
WORKBENCH_COMPOSE_PROFILES="local-object-storage local-docling" \
WORKBENCH_DEPLOY_IMAGE_MODE=build \
WORKBENCH_PREFLIGHT_SCRIPT="$PWD/deploy/workbench-server-preflight.sh" \
bash deploy/server-deploy.sh

# 只通过该脚本适配和 reload 带环境占位的 Caddy 配置；不要直接 systemctl reload。
sudo WORKBENCH_APP_DIR="$PWD" \
  WORKBENCH_ENV_FILE="$PWD/deploy/workbench.env" \
  WORKBENCH_CADDY_FILE="$PWD/deploy/workbench-server-validation.Caddyfile" \
  WORKBENCH_PREFLIGHT_SCRIPT="$PWD/deploy/workbench-server-preflight.sh" \
  sh deploy/workbench-caddy-reload.sh
```

上面的 overlay、`local-object-storage` 和 `local-docling` 仅用于服务器验证，不构成生产身份、托管 S3、模型服务或高可用验收。`WORKBENCH_DEPLOY_IMAGE_MODE=build` 只允许该验证 profile 使用源码构建；生产部署省略它，默认要求签名的候选镜像清单并以 `--no-build` 启动。预检会拒绝空值、占位值、非私网或重叠的 WireGuard 地址、弱 Edge 鉴权密钥、非 canonical 的 Better Auth IP 头、缺失的 Import Worker S3 身份，以及超过 ClamAV INSTREAM 上限的单 Blob 导入配置。Import Worker 只持有自己的 `pending/imports/*` 与内容寻址 `blobs/*` 写入身份，并且只有它接入受控外网以抓取固定版本的 URL、GitHub 和 Figma 来源。当前验证/直连拓扑不使用 CDN：公网 TLS 由 `aionbench.com` 所在的新 Origin Caddy 终止，`aionbench.com`、`www` 和 Preview 通过独立 hostname 直接解析到批准的验证服务器。`deploy/edge/` 描述的是尚未启用的可选 Edge/WireGuard 拓扑，不能作为当前 DNS 目标。脚本不会执行 Git reset/pull、不会清理 Docker 数据，也不会加载旧版根 `.env`。生产模型只能由 DeerFlow 提供；Web 和 Workbench API 不直接配置或调用模型供应商。

根目录 `.env` 仅供本地开发脚本读取，必须保持 ignored，不能复制到 `storage/`、证据目录或候选 manifest；生产部署只读取 `deploy/workbench.env` 或受控的外部环境文件。生成 release candidate 前应从 fresh/clean checkout 开始，这样本机 `.env` 不会进入 source inventory，也不需要删除或搬迁本地开发配置。

更新 `workbench-api`、`workbench-web`、`knowledge` 或 `all` 时必须使用上面的 `server-deploy.sh` 目标；脚本会在上游容器就绪后强制重建主 `gateway`，避免 Nginx 保留已删除容器的旧 IP。更新 `workbench-preview` 时同样会强制重建 `preview-gateway`。不要用裸 `docker compose up workbench-web`、`docker compose up workbench-api` 或只替换单个上游容器来完成线上切换。

完整部署和 `migrate` 目标会先优雅停止 `workbench-api` 及 Runtime/File/Import/Export Workers，确认所有 pg-boss 生产者与消费者都已停止，再独立运行 migrator。队列策略或其他配置需要变更但队列仍含 queued/deferred/active job 时，migrator 会失败且这些服务保持停止；先按运维窗口处理积压，禁止删除队列绕过。需要重建持久化 queue policy 的一次性 hard cut 必须由调用进程显式授权，不能把授权常驻在 `workbench.env`：

独立 `migrate` 即使成功也不会重新启动这些服务，因为迁移后的策略可能只与待切换候选兼容；完成检查后使用同一候选的 `DEPLOY_TARGET=all` 启动全栈。

```bash
WORKBENCH_ALLOW_RUNTIME_QUEUE_RECREATE=1 \
WORKBENCH_ENV_FILE=/etc/workbench/release/workbench.env \
DEPLOY_TARGET=all \
bash deploy/server-deploy.sh
```

生产候选必须先把 CI 生成的 `production-image-manifest.json`、对应的 `production-image-manifest.bundle.json` 和批准的环境文件放到服务器，再运行同一个编排器。服务器会先用配置的 GitHub Actions 精确 certificate identity 与 OIDC issuer 执行 `cosign verify-blob`；签名未通过时不会解析清单、拉取镜像或变更服务：

生产 GitHub Actions 环境还必须提供 `WORKBENCH_NODE_IMAGE`、`WORKBENCH_NGINX_IMAGE`、`WORKBENCH_POSTGRES_IMAGE` 和 `WORKBENCH_CI_POSTGRES_IMAGE`，且每个值都必须是带 `@sha256:<64hex>` 的不可变 OCI 引用。`WORKBENCH_DOCLING_IMAGE`、`WORKBENCH_CLAMAV_IMAGE`、`WORKBENCH_MINIO_IMAGE`、`WORKBENCH_MINIO_MC_IMAGE` 和 `WORKBENCH_DEX_IMAGE` 如果被配置，也必须使用同样的 digest；生产拓扑不允许启用 `local-object-storage` 或 `local-docling`，因此 MinIO、Dex 和 Docling 的 tag fallback 只属于本地/验证环境。Node/Nginx digest 会同时作为 Docker build args 写入镜像构建配置并纳入签名 evidence。

```bash
# `/etc/workbench/release/workbench.env` 固定下面两条路径及精确 signer identity/issuer：
# WORKBENCH_IMAGE_INVENTORY_PATH=/etc/workbench/release/production-image-manifest.json
# WORKBENCH_IMAGE_INVENTORY_BUNDLE_PATH=/etc/workbench/release/production-image-manifest.bundle.json
WORKBENCH_ENV_FILE=/etc/workbench/release/workbench.env \
bash deploy/server-deploy.sh
```

生产主机还必须预先安装 Docker Compose v2、Cosign，并已对候选镜像仓库完成只读登录；编排器不会在服务器构建或推送镜像。

编排器会校验 Web/API/所有 Worker/Quartz、Import Worker 以及派生 DeerFlow 的镜像、SBOM、漏洞报告、provenance 和签名都绑定同一 `WORKBENCH_SOURCE_COMMIT`，然后只用 `--no-build` 启动。候选切换失败时，clean host 会自动停止半启动拓扑；已有拓扑不会被未经批准的自动动作覆盖。回滚必须显式指向上一份签名环境与 Compose 文件，上一份环境还必须固定该候选自己的 manifest、bundle、精确 certificate identity 与 issuer：

```bash
WORKBENCH_ROLLBACK_ENV_FILE=/etc/workbench/releases/<previous>/workbench.env \
WORKBENCH_ROLLBACK_COMPOSE_FILE=/etc/workbench/releases/<previous>/workbench-compose.yml \
DEPLOY_TARGET=rollback \
bash deploy/server-deploy.sh
```

回滚会在拆除当前栈之前停止同一组队列参与者，并以一次性授权运行上一签名候选的 migrator 来恢复其 queue policy；旧策略恢复失败或队列未排空时保持 fail closed，不会继续启动旧服务。数据库迁移仍是前向兼容合同；发生不可逆迁移后不能假装通过镜像回滚，必须按备份/restore 与 forward-repair runbook 处理。
