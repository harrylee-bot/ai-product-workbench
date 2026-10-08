# 产品工作台

版本：`1.0.0`。在线输入需求，结合本地知识库生成需求文档与原型，支持文档在线预览、Word/PDF 下载，以及原型分享预览。

当前功能缺口、代码审计、测试结果与待完成事项统一维护在 [1.0.0 审计](docs/audit/1.0.0.md)。

## 功能说明

1. **输入需求**：创建项目，在对话中描述业务目标、使用角色、流程和交付要求，可附加相关资料。
2. **使用知识库**：生成任务绑定已发布的知识版本，检索业务规则、文档规范和原型规范，并保留来源引用。
3. **生成文档与原型**：默认同时生成需求文档和原型，也可选择单一产物；在项目中查看版本、继续修改，跟踪生成状态，取消或重试任务。
4. **预览与下载文档**：在线阅读和编辑需求文档，草稿按账号、项目和产物保存在当前浏览器；预览、发布和导出先保存修改，再下载对应版本的 Word/PDF 文件。
5. **分享原型**：在项目中预览原型，为固定版本创建分享链接，供接收者在线访问；可管理和撤销分享。

知识源位于 `knowledge-vault/`，大文件原件位于 `storage/`，数据库保存已发布知识版本及项目引用。知识更新需要重新发布；已固定的运行版本保持可追溯。未经明确授权，不向外部知识库同步内容。

## 运行与配置

系统包括 Web、API、PostgreSQL、任务队列、DeerFlow、知识与文件处理、导出和独立预览服务。依赖与变量以 `package.json`、`deploy/workbench.env.example` 和 Compose 配置为准；凭据由受控环境注入。

```sh
npm ci
npm run workbench:prepare
npm run dev
```

开发命令需要已配置的基础设施。完整服务的 Compose 入口：

```sh
cp deploy/workbench.env.example deploy/workbench.env
# 先配置数据库、鉴权、对象存储、模型、预览、Docling 和 ClamAV
docker compose --env-file deploy/workbench.env \
  -f deploy/workbench-compose.yml \
  --profile local-object-storage \
  --profile local-docling \
  up -d --build
```

空数据库须先完成下面的首次知识初始化。Web 可在 API 启动后提供登录，API 的业务就绪检查仍要求有效知识发布和真实检索服务。主页面与预览使用独立访问来源。数据库迁移、事件与产物合同位于 `packages/workbench-db/`、`packages/workbench-contracts/`；机器验收合同位于 `schemas/`。

代码只维护 `main`。普通推送运行 CI 检查；发布镜像须在 `main` 手动运行「产品工作台 CI」并勾选 `release`（默认关闭）。发布继续校验同一提交的审批、固定镜像和签名证据。部署端的 Cosign 身份须指向 `workbench-ci.yml@refs/heads/main`，验收校验器引用须支持该合同。

## 产品工作台 DeerFlow 部署合同

DeerFlow 使用固定镜像和 `lead_agent`。镜像必须携带 `integrations/deerflow/skills/` 中的两个 public skill、受信工具与对应 source patch；工具、模板和返回结构由现有合同检查约束。请求级能力凭证只进入受控 secret channel，不能进入模型上下文、事件或日志。

```sh
npm run deerflow:config:merge -- \
  --base "$WORKBENCH_DEERFLOW_BASE_CONFIG_PATH" \
  --fragment integrations/deerflow/runtime-tools/config.fragment.yaml \
  --output "$DEER_FLOW_CONFIG_PATH"
npm run deerflow:deployment:check
```

部署入口是 `deploy/deerflow-runtime-compose.yml`，运行配置和镜像必须通过对应 preflight。真实生成与知识检索仍需在目标环境验收。

## 知识维护

首次部署先完成迁移、共享包及 API/File Worker 构建，配置真实 TEI、reranker、固定模型版本和本地 tokenizer 文件。由受控环境注入 `WORKBENCH_MIGRATOR_DATABASE_URL`、`BETTER_AUTH_URL`、`WORKBENCH_BOOTSTRAP_ACCOUNT_EMAIL`、`WORKBENCH_BOOTSTRAP_ACCOUNT_USERNAME`、`WORKBENCH_BOOTSTRAP_ACCOUNT_PASSWORD`、`WORKBENCH_KNOWLEDGE_PROFILE_OPERATOR_AUTHORIZED_BY` 和 `WORKBENCH_KNOWLEDGE_PROFILE_OPERATOR_CHANGE_REFERENCE`。凭据不写入仓库或命令参数。

```sh
node scripts/workbench-knowledge-bootstrap.mjs \
  --embedding-profile=/private/embedding-profile.json \
  --retrieval-profile=/private/retrieval-profile.json \
  --embedding-probe=/private/embedding-probe.json \
  --reranker-probe=/private/reranker-probe.json \
  --key=production --version=1
# 核对计划后，用相同参数增加 --execute 执行。
```

该入口依次建立专用账号与知识维护身份，运行真实模型一致性检查，采用配置并将知识发布入队。File Worker 完成构建、发布状态变为 `ready` 后才开放生成业务。普通账号可单独通过 `node scripts/workbench-bootstrap-account.mjs --execute` 创建，不会获得 operator 权限；重跑不会覆盖现有密码或开放公众注册。

后续维护使用下列命令。参数由运维环境提供，专用 migrator 连接不能替换为运行时数据库连接。

```sh
WORKBENCH_MIGRATOR_DATABASE_URL="${WORKBENCH_MIGRATOR_DATABASE_URL:?由受控环境注入}" \
npm run knowledge:profile-operator -- \
  --action=grant \
  --issuer="$WORKBENCH_KNOWLEDGE_PROFILE_OPERATOR_ISSUER" \
  --subject="$WORKBENCH_KNOWLEDGE_PROFILE_OPERATOR_SUBJECT" \
  --authorized-by="$WORKBENCH_KNOWLEDGE_PROFILE_OPERATOR_AUTHORIZED_BY" \
  --change-reference="$WORKBENCH_KNOWLEDGE_PROFILE_OPERATOR_CHANGE_REFERENCE"
```

```sh
WORKBENCH_MIGRATOR_DATABASE_URL="${WORKBENCH_MIGRATOR_DATABASE_URL:?由受控环境注入}" \
npm run knowledge:release -- \
  --key="$WORKBENCH_KNOWLEDGE_RELEASE_KEY" \
  --version="$WORKBENCH_KNOWLEDGE_RELEASE_VERSION" \
  --embedding-profile="$WORKBENCH_KNOWLEDGE_EMBEDDING_PROFILE_ID" \
  --retrieval-profile="$WORKBENCH_KNOWLEDGE_RETRIEVAL_PROFILE_ID"
```

工作区发布增加 `--workspace=<workspace-id>`；不指定时创建全局发布。发布成功以任务完成且状态为 `ready` 为准，入队成功不代表知识已可用。

已有项目更新知识基线时，先运行 `node scripts/workbench-project-knowledge-refresh.mjs --project=<项目ID> --principal=<项目所有者ID> --baseline=<ready发布ID>` 预览差异，再用相同参数和输出中的 `--expected-plan-sha256=<摘要> --execute` 执行。新版本保留项目定稿知识和可复用向量；已执行 Run 的知识快照保持不变。此入口只接受相同的检索及向量模型配置，模型变更须重新构建知识。

## 执行控制项

生产验收以 `schemas/evidence/governance/production-acceptance-control-catalog.v1.json` 为控制目录。先由 `scripts/production-acceptance/plan.mjs` 生成绑定候选、配置、镜像和目录摘要的计划，执行各控制项并保存真实观测值与原始证据；每项通过受保护 runner 生成唯一 observation：

```sh
node scripts/production-acceptance/run-control.mjs \
  --control "$WORKBENCH_CONTROL_ID" \
  --plan "$WORKBENCH_ACCEPTANCE_PLAN" \
  --result "$WORKBENCH_CONTROL_RESULT" \
  --output "$WORKBENCH_OBSERVATION_OUTPUT"
```

随后使用 `collect.mjs` 重算阈值和证据摘要，按 `prepare-approval-payload.mjs` 与 `assemble-package.mjs` 完成现有签名和组包流程。缺失、失败或不完整的观测不能记为通过；候选、配置或目录变化后重新生成计划。生产凭据和外部验收包保存在受控仓库外。本次本地审计输出仅存于 `output/audit/1.0.0/`。

## 执行演练

数据库恢复工具只允许隔离或测试源库与全新恢复库。先运行 `node scripts/workbench-postgres-recovery-drill.mjs --help`，按当前候选填写 commit、签名 tag、实际迁移数量、批准的 RPO/RTO 和仓库外输出路径，默认生成计划。

审阅计划后，从受控环境注入 `WORKBENCH_G5_SOURCE_DATABASE_URL`、`WORKBENCH_G5_ADMIN_DATABASE_URL` 和计划中的精确 `WORKBENCH_G5_DRILL_CONFIRM`，保持同一参数并增加 `--execute`。工具依次核验候选、备份、复核摘要、恢复、执行迁移、比较数据、检查 RPO/RTO 并清理恢复库。清理失败、数据不一致或 receipt 缺失均不能视为通过；禁止将该演练工具用于生产恢复。

## Runtime 告警处置

Provider State 变更先迁移、受控回填并验证事件与 projection 一致，再观察小范围 Worker 后推广。实际命令参数见 `node scripts/workbench-runtime-provider-state-rollout.mjs --help`。以下锚点供运行告警直接引用。

### Provider State P2028

停止受影响 Worker，检查数据库负载、projection lag、lease 与事务耗时。修复后重新验证事件和 projection，再恢复消费。

### Projection Invariant

遇到缺失、版本或哈希不符、sequence gap、draft 冲突或 CAS 错误时停止处理，保留原始事件；通过 migrator 修复并完整校验。

### Projection Lag

比较 projection 和事件 sequence，检查 lease owner、连接池及 Worker heartbeat。持续延迟时暂停推广，恢复后重新验证覆盖率。

### Backfill Conflict

遇到 pending event、序列缺口、哈希或 finalization 冲突时停止该 attempt，修复后从受控 checkpoint 继续，不跳过记录。

### Wall Clock

超时后确认 provider I/O 已终止、任务与 Run 已收敛、lease 已释放或被隔离；检查取消、heartbeat 和 reconciler 是否正常。

### Terminal Run Drift

任务已结束但 Run 仍活跃时，停止新提交并检查 execution reconciler、lease 和状态事务，收敛后恢复。

### Lease Takeover

连续接管增长时检查 Worker 退出、heartbeat 延迟与数据库争用，确认过期 owner 已被阻止继续写入。

### Knowledge Visibility

未授权运行看到或执行知识工具时停止受影响 Worker，检查请求级工具目录、middleware、知识版本绑定和 capability 签发边界。

## 验证入口

```sh
npm run typecheck
npm run test
npm --workspace @workbench/web run test
npm run openapi:check
npm run lint:workbench
npm run architecture:workbench
```

功能验证与遗留问题只更新 [1.0.0 审计](docs/audit/1.0.0.md)。APITable 生产操作另须遵循 [必要操作手册](docs/runbooks/apitable-production-operations.md)。
