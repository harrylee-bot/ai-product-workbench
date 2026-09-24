# 产品工作台

产品工作台是一套以 DeerFlow 为生产 Runtime 的产品需求、知识、原型和交付系统。系统由 Web、Workbench API、PostgreSQL、pg-boss、Runtime Worker、File/Knowledge Worker、Import Worker、Export Worker、Preview 和 Quartz 知识库组成。

## 系统边界

```text
Browser
  -> Next same-origin BFF / Better Auth
  -> Workbench API / PostgreSQL / pg-boss
  -> Runtime Worker -> DeerFlow
  -> File + Knowledge Worker -> object storage / KnowledgeRelease
  -> Import Worker -> pinned URL / GitHub / Figma source
  -> Export Worker -> isolated Preview origin
```

浏览器只持有不透明会话 Cookie。业务对象、运行事件、文件、知识发布、产物、分享和导出均由版本化合同、数据库约束、授权和幂等命令管理。

## 产品能力

- Workspace、成员、Project、Thread、Run、Approval、取消和重试。
- Board、Artifact、ArtifactVersion、Design System、Release、Share、Remix 和导出。
- PRD 与 Prototype 生成、编辑、预览、发布和版本固定。
- Uppy multipart 上传、checksum、病毒扫描、文本提取和 KnowledgeRelease。
- URL、GitHub、Figma 固定来源导入。
- HTML、React、Figma、MCP、DOCX 等导出及独立 Preview。
- Runtime Provider State、事件重放、Knowledge capability 和安全观测。

## 本地运行

在根目录 `.env.local` 或 `.env` 配置数据库、对象存储、DeerFlow、鉴权、Preview 和文件处理服务：

```bash
npm ci
npm run workbench:prepare
npm run dev
```

完整基础设施使用 Compose：

```bash
cp deploy/workbench.env.example deploy/workbench.env
# 填写真实数据库、对象存储、DeerFlow、Import provider、Docling、ClamAV 和鉴权配置
docker compose --env-file deploy/workbench.env \
  -f deploy/workbench-compose.yml \
  --profile local-object-storage \
  --profile local-docling \
  up -d --build
```

本地入口：

- Workbench：`http://localhost:4180`
- Knowledge：`http://localhost:4180/knowledge/`
- Preview：`http://localhost:4190`

## DeerFlow 初始化

使用真实管理员的短期 access token 初始化自定义 Agent 和 skill：

```bash
DEERFLOW_ADMIN_ACCESS_TOKEN="<raw-admin-access-token>" \
npm run deerflow:bootstrap -- \
  --gateway-url http://localhost:8001 \
  --langgraph-url http://localhost:8001/api
```

访问令牌只通过受控环境变量提供，不写入仓库、日志或文档。Runtime 服务间调用使用 `DEERFLOW_INTERNAL_AUTH_TOKEN`，不作为管理员凭据。

## Knowledge

KnowledgeRelease 由受限运维身份创建，输入只来自 `knowledge-vault/` 与 Markdown 明确引用的 `storage/` 文件。发布前必须完成数据库迁移、EmbeddingProfile/RetrievalProfile readiness、tokenizer pin、TEI conformance 和队列配置检查。

```bash
WORKBENCH_MIGRATOR_DATABASE_URL="postgresql://workbench_migrator:<password>@localhost:5432/workbench?schema=workbench" \
npm run knowledge:profile-operator -- --action=grant
```

```bash
WORKBENCH_MIGRATOR_DATABASE_URL="postgresql://workbench_migrator:<password>@localhost:5432/workbench?schema=workbench" \
npm run knowledge:release -- --key=production --version=1
```

```bash
npm run audit:knowledge-vault
EMBEDDING_PROBE=/path/to/approved-embedding-probe.json
RERANKER_PROBE=/path/to/approved-reranker-probe.json
npm run knowledge:probe:hash -- "$EMBEDDING_PROBE" "$RERANKER_PROBE"
WORKBENCH_KNOWLEDGE_EMBEDDING_PROBE_PATH="$EMBEDDING_PROBE" \
WORKBENCH_KNOWLEDGE_RERANKER_PROBE_PATH="$RERANKER_PROBE" \
npm run knowledge:conformance
npm run knowledge:retrieval:eval -- \
  --dataset=packages/workbench-knowledge/test/fixtures/retrieval-evaluation-dataset.v1.json \
  --results=packages/workbench-knowledge/test/fixtures/retrieval-evaluation-results.v1.json \
  --output-dir=storage/evaluation/knowledge-smoke
```

知识资产只保留明确引用闭包；大文件放在 `storage/`，结构化索引放在 `knowledge-vault/`。仓库不会向外部知识库同步内容。

## 验证

```bash
npm run openapi:check
npm run openapi:breaking
npm run typecheck
npm run test
npm --workspace @workbench/web run test
npm run lint:workbench
npm run architecture:workbench
npm run deployment:images:check
```

生产构建使用显式配置：

```bash
WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL=https://uploads.example.invalid \
WORKBENCH_PREVIEW_ORIGIN=https://preview.example.invalid \
npm run build
```

## 文档入口

- [Runtime 与数据库合同](docs/runtime-database-contract.md)
- [Workbench 产品合同](docs/workbench-product-contract.md)
- [绿地架构与实现方案](docs/workbench-greenfield-implementation-plan.md)
- [Knowledge 检索架构](docs/workbench-knowledge-retrieval-architecture.md)
- [Export 与 Preview 架构](docs/workbench-export-preview-architecture.md)
- [前端视觉基线](docs/workbench-visual-baseline.md)
- [开源复用策略](docs/workbench-open-source-reuse-strategy.md)
- [生产部署与验收 runbook](docs/runbooks/)
