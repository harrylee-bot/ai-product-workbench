# AI Product Workbench

AI Product Workbench 是一个 Vibe Coding 产品工作台。当前架构不再维护自研 agent 编排；项目只维护产品协议、状态机、权限审计、artifact 落库和 runtime adapter。

底层任务执行、工具调用、代码修改、多步骤编排和运行时协作交给外部 runtime：

- Codex CLI
- DeerFlow

本仓库负责把用户输入、项目上下文、知识库规则和当前产品状态打包成稳定 handoff，再把 runtime 输出校验后写回 PRD、原型、Patch、QA 和版本记录。

## 当前链路

```text
User / Project Context
  -> Vibe Protocol
  -> ProductDesignState state machine
  -> Runtime Adapter (Codex CLI / DeerFlow)
  -> Schema validation
  -> PRD / Prototype / Patch / QA persistence
  -> Stream events / Admin logs / Audit
```

如果 runtime 未配置，系统只允许走确定性的 `local-protocol-renderers` fallback，用于开发、回放和最小可用测试。fallback 不是新的自研 agent 编排。

## 已实现能力

- 登录、JWT 鉴权、角色权限、用户管理和 admin 审计。
- 项目、会话、消息、文件上传和解析。
- Model Gateway：OpenAI-compatible 模型供应商、模型配置、任务映射、调用日志、API Key 加密存储。
- Vibe 工作台：聊天输入、run stream、PRD/原型/状态/Patch/QA 预览。
- ProductDesignState：产品状态唯一事实源、版本、变更日志、回滚。
- RequirementDocument：PRD sections / blocks / source paths / 版本 / 确认。
- PrototypeSpec / PrototypeArtifact：结构化原型规格、HTML artifact、桌面/移动预览。
- PatchRecord / PatchPreview：局部修改候选、确认后执行、失败恢复。
- QAReport / RollbackRecord：一致性检查、QA gate、回滚后重新生成。
- Knowledge：知识条目、分类、标签、候选审核、Obsidian/Quartz 知识库入口。
- Runtime adapter：
  - `CodexRuntimeAdapter`
  - `DeerFlowRuntimeAdapter`
  - `ProductRuntimeService`
  - `ExternalRuntimeService`
- Admin 日志：Runtime Run、模型调用、文件解析、Patch、QA 报告。

旧的 Decision / Evolution / Company / Self-generation / Review-board 实验链路已经从活跃代码和 Prisma schema 中删除。

## 项目结构

```text
apps/
  api/        NestJS API
  web/        Next.js Web
  knowledge/ Quartz knowledge app

packages/
  db/         Prisma schema and migrations

deploy/      server deployment scripts
docs/        architecture and handoff docs
```

## 关键环境变量

```text
VIBE_REQUIREMENT_RUNTIME=local
VIBE_PROTOTYPE_SPEC_RUNTIME=local
VIBE_PROTOTYPE_CODE_RUNTIME=local
VIBE_PATCH_PLAN_RUNTIME=local
VIBE_QA_RUNTIME=local
VIBE_RUNTIME_FALLBACK_TO_LOCAL=true
VIBE_RUNTIME_WORKSPACE_ROOT=/app/apps/api/storage/runtime-workspaces
VIBE_CODEX_COMMAND=codex

DEERFLOW_GATEWAY_URL=
DEERFLOW_GATEWAY_MODE=vibe
DEERFLOW_GATEWAY_PATH=/api/vibe/tasks
DEERFLOW_ASSISTANT_ID=agent
DEERFLOW_REQUEST_TIMEOUT_MS=180000
```

`local` 表示不调用外部 runtime。把对应变量切到 `codex` 或 `deerflow` 后，API 会通过 runtime adapter 发起任务。

## 本地启动

```bash
npm install
npm run db:generate
docker compose up -d postgres
npm run db:migrate
npm run db:seed
npm run dev
```

服务地址：

- Web: `http://localhost:3000`
- API: `http://localhost:4000/api`
- Knowledge: `http://localhost:3001`

默认账号：

| 角色 | 用户名 | 邮箱 | 密码 |
|---|---|---|---|
| 管理员 | admin | admin@example.local | Admin123456 |
| 普通用户 | zhangsan | zhangsan@example.local | User123456 |

## 验证

```bash
npm run typecheck
npm run test
npm run build
```

## 线上部署

生产服务器当前为：

```text
8.130.160.177
```

部署脚本：

```bash
bash deploy/server-deploy.sh
```

服务器无法匿名拉取 GitHub 私有仓库时，使用本地 `rsync` 同步当前代码到 `/opt/ai-product-workbench`，保留服务器 `.env`、`runtime-skills`、`knowledge-vault`，再执行：

```bash
SKIP_GIT_PULL=1 bash deploy/server-deploy.sh
```

线上入口：

- Web: `http://8.130.160.177:3000/login`
- API health: `http://8.130.160.177:4000/api/system/health`
- Knowledge: `http://8.130.160.177:3001`

## 设计原则

- 不新增本地自研 agent 编排节点。
- 不在产品代码里复刻 Codex/DeerFlow 的任务编排、工具调用和执行循环。
- ProductDesignState 是 PRD、Prototype、Patch、QA 的唯一事实源。
- runtime 输出必须经过 schema 校验、安全检查、权限校验和业务服务落库。
- 所有用户可见进度通过 stream events 展示自然语言摘要，不展示模型私密 chain-of-thought。
