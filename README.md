# AI Product Workbench

AI Product Workbench 是一个 Vibe Coding 产品工作台。当前后端进入 DeerFlow-first 改造期：不再维护自研 agent 编排、直接 Codex 调用、本地降级渲染、旧局部修改生成/应用链路或旧技能注入。

## 当前边界

```text
User / Project Context
  -> API thread creation and binding
  -> DeerFlow 2.0 runtime (planned first-class runtime)
  -> Stream events
  -> Final action validation
  -> ProductDesignState / PRD / Prototype / QA / Version persistence
```

后端只负责稳定协议和业务落库：鉴权、项目/会话/消息、知识库、文件解析、ProductDesignState、PRD、Prototype artifact、QA gate、版本、回滚、分享和 admin 可观测。

Codex 的位置后移到 DeerFlow graph 的 coding/prototype execution 节点；Nest 不再直接决定何时调用 Codex。

## 已保留能力

- 登录、JWT 鉴权、角色权限、用户管理和 admin 审计。
- 项目、会话、消息、文件上传和解析。
- Model Gateway：模型供应商、模型配置、任务映射、调用日志、API Key 加密存储。
- ProductDesignState：产品状态唯一事实源、版本、变更日志、用户确认、版本回滚。
- RequirementDocument：PRD sections / blocks / source paths / 版本 / 确认。
- PrototypeSpec / PrototypeArtifact：结构化原型规格、HTML artifact、桌面/移动预览。
- QAReport / RollbackRecord：一致性检查、QA gate、回滚记录。
- Knowledge：知识条目、分类、标签、候选审核、Obsidian/Quartz 知识库入口。
- RuntimeRunLog / VibeStream：为 DeerFlow 事件接入保留的运行日志和流式事件表。

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

## 部署

生产服务器当前为：

```text
8.130.160.177
```

部署脚本：

```bash
bash deploy/server-deploy.sh
```
