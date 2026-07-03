# AI Product Workbench 优化目标计划

日期：2026-07-03  
依据：[Claude 全量审计整理报告](./claude-audit-complete-2026-07-02.md)  
目标周期：4 周完成主链路稳定与目标闭环最小可用，后续 4-8 周完成结构治理与扩展能力。

## 1. 总目标

把当前系统从“主干能跑、闭环不完整、状态同步脆弱”优化为：

- 对话生成 PRD/原型的主链路稳定、可恢复、可观测。
- 定稿 PRD/原型能进入知识库，并能每天自动同步更新。
- 分享、下载、评论、developer 角色和技术设计文档能力有清晰落地路径。
- 前后端代码去掉模板残留，减少串台和假功能。
- 生产部署与安全底线可控。

## 2. 北极星指标

| 指标 | 当前问题 | 目标值 |
|---|---|---|
| 生成链路成功可追踪 | 500 无日志、SSE 半死卡 running | 所有非预期错误有日志；stale running run 可自动收敛 |
| 消息一致性 | 双源真相、轮询覆盖、长会话截断 | 刷新后永远能看到最新消息；运行中不被旧轮询覆盖 |
| 知识闭环 | 定稿抽取空实现、无每日任务 | 定稿后产生候选；每日任务可同步 DB/vault/Quartz |
| 安全底线 | 默认口令/IP 暴露、HTML 端点缺 sandbox | 生产口令重置；HTML 用户内容有 CSP sandbox |
| 产品闭环 | 分享/下载前端无入口，评论/开发者能力缺失 | 分享/下载可用；评论和技术设计进入明确迭代 |

## 3. 分阶段目标

### 阶段 0：安全与稳定止血（第 0-2 天）

**目标**：先消除会直接造成生产事故、安全事故、用户必现 bug 的问题。

| 编号 | 目标 | 工作项 | 验收标准 |
|---|---|---|---|
| G0-1 | 生产默认凭据风险清零 | 重置生产 admin/zhangsan；README 移除真实 IP/默认口令；seed 默认口令改随机或显式 opt-in | 生产账号不能用默认口令登录；仓库 grep 不再出现生产 IP + 默认口令组合 |
| G0-2 | 修复长会话消息截断 | `listByConversation` 改取最新 100 条并按时间正序返回，或实现 cursor 分页 | 构造 101+ 消息会话，刷新能看到最新消息 |
| G0-3 | 修复已发现 IDOR 邻接缺口 | 保留 runId stop 归属校验、streamId 碰撞校验与测试 | API 全量测试通过；错误用户无法 stop 他人 run |
| G0-4 | 500 错误可观测 | `HttpExceptionFilter` 记录非 HttpException stack、path、method、userId/traceId（有则带） | 人为抛 TypeError，日志可定位文件/请求 |
| G0-5 | DeerFlow 半死连接可收敛 | SSE `readSse` 增加 idle timeout；run 超时后 fail/cancel | 模拟只发响应头不发事件，run 不再永久 running |
| G0-6 | 用户 HTML 内容纵深防御 | prototype/share HTML 响应加 CSP sandbox；visual-context HTML 改 attachment/text/plain；preview 失败不回退未净化 HTML | 浏览器直开 HTML 端点不带 API 同源权限；preview 失败显示错误占位 |

**执行状态（2026-07-03）**：

| 编号 | 状态 | 已完成内容 | 剩余动作 |
|---|---|---|---|
| G0-1 | 代码侧完成 | README/部署默认值/Quartz 配置移除生产地址；seed 开发口令改为临时随机值且不再输出固定默认口令；审计/交接文档脱敏 | 需要在真实生产库人工重置 admin/zhangsan 口令 |
| G0-2 | 已完成 | `listByConversation` 改为取最新 100 条后正序返回；补消息服务测试 | 后续阶段可做 cursor 分页 |
| G0-3 | 已完成 | 保留 runId stop 归属校验、streamId 碰撞校验；补回归测试 | 无 |
| G0-4 | 已完成 | 非 HttpException 记录 method/path/stack；`headersSent` 时避免二次写响应 | 后续可接 traceId/userId 到日志上下文 |
| G0-5 | 已完成 | DeerFlow SSE `reader.read()` 增加 `DEERFLOW_IDLE_TIMEOUT_MS`，默认 120s；补 idle 测试 | 后续补孤儿 running run 清扫 |
| G0-6 | 已完成 | prototype/share HTML 响应加 CSP sandbox；visual-context 非安全类型强制 attachment；前端 preview 失败不再回退未净化 HTML | 后续可按业务需要白名单化资源域名 |

**阶段退出标准**：

- `npm --workspace @ai-product-workbench/api run typecheck`
- `npm --workspace @ai-product-workbench/api run test`
- 安全 grep 检查通过：无生产 IP/默认口令组合。
- 手工或自动验证长会话最新消息、DeerFlow idle timeout、HTML sandbox。

### 阶段 1：生成主链路稳定化（第 1 周）

**目标**：让“对话 -> DeerFlow -> PRD/原型落库 -> 画布展示”从能跑变成可靠。

| 编号 | 目标 | 工作项 | 验收标准 |
|---|---|---|---|
| G1-1 | final action 落库原子化 | 将 PRD/原型 draft、document/artifact、project current pointer、version 写入纳入同一事务，或加失败补偿 | 注入中途失败不会留下 current 指针/状态半更新 |
| G1-2 | 回滚路径可信 | `rollbackForUser` 事务化；补写 RollbackRecord 或删除假接口 | 版本回滚后 state/project/changeLog/version/rollbackRecord 一致 |
| G1-3 | stream 入口幂等 | 为前端请求增加 clientRunId/requestId，防双击/重试重复落消息 | 同一请求重复提交不会创建两个 run 和两条 user message |
| G1-4 | runtime 事件治理 | 事件批量写或限频；增加过期清理策略；traceId 进入日志 | 长生成不会产生无界事件表增长；日志可按 traceId 串联 |
| G1-5 | 前端运行状态先止血 | 运行中减少 server messages 覆盖；新 run 取消旧 recovery token；停止三路同时写状态 | 弱网断线恢复不会吞掉用户新发消息 |

**执行状态（2026-07-03）**：

| 编号 | 状态 | 已完成内容 | 剩余动作 |
|---|---|---|---|
| G1-1 | 部分完成 | PRD/Prototype 产物保存内部事务化；ProductDesignState 回滚事务化并写 RollbackRecord | final action 跨 `createDraft/save/attach` 的整体事务或补偿恢复仍待做 |
| G1-2 | 部分完成 | ProductDesignState rollback 会同步项目状态、版本快照和 RollbackRecord | PRD/Prototype 独立版本回滚策略仍待细化 |

**阶段退出标准**：

- 增加覆盖事务失败、回滚一致性、重复提交的单元/集成测试。
- 使用模拟 DeerFlow 事件跑 PRD/原型生成，刷新后画布和消息一致。

### 阶段 2：目标闭环最小可用（第 2 周）

**目标**：补齐用户最能感知的产品闭环：分享、下载、定稿入库、每日同步。

| 编号 | 目标 | 工作项 | 验收标准 |
|---|---|---|---|
| G2-1 | 分享能力前端可用 | 画布工具栏新增分享按钮；ShareLink 创建/列表/吊销；公开分享页展示 PRD/原型 | 用户能创建、复制、撤销分享链接；公开页免登录可访问 |
| G2-2 | 下载能力前端可用 | PRD 下载 docx/markdown；原型下载 html；保留 canvas JSON | 画布中一键下载，文件名/内容正确 |
| G2-3 | 定稿进入知识库 | PRD 按 section、原型按页面/能力生成 KnowledgeCandidate；admin 审批后入 KnowledgeItem | 确认 PRD/原型后候选列表可见；审批后可被检索召回 |
| G2-4 | 每日自动更新 | 引入 schedule：vault sync、embedding 补齐、Quartz rebuild/导出 | 定时任务可手动触发和每日自动执行；失败有日志 |
| G2-5 | 明确知识 source of truth | 决策 DB-first 或 vault-first，并改数据流 | 文档、代码和部署只体现一种主源；另一方为导出/渲染物 |

**阶段退出标准**：

- 从“生成 PRD -> 确认 -> 候选 -> 审批 -> 检索再次命中”跑通一条端到端用例。
- 分享/下载在桌面和移动宽度下可用。

**执行状态（2026-07-03）**：

| 编号 | 状态 | 已完成内容 | 剩余动作 |
|---|---|---|---|
| G2-3 | 代码侧完成 | PRD 确认后抽取 section 候选；Prototype 确认后抽取整体原型和页面候选；沿用 admin 审核/approve/merge 管线 | 需要前端候选提醒与更精细去重/质量评分 |
| G2-4 | 部分完成 | 新增默认关闭的每日同步维护服务：`KNOWLEDGE_DAILY_SYNC_ENABLED=true` 后按 `KNOWLEDGE_DAILY_SYNC_INTERVAL_MS` 触发 vault sync 和 embedding sync | Quartz rebuild/导出仍需部署侧编排 |

### 阶段 3：前端同步链路重构与模板清理（第 3-4 周）

**目标**：把反复出串台 bug 的前端同步链路拆开，去掉模板遗留。

| 编号 | 目标 | 工作项 | 验收标准 |
|---|---|---|---|
| G3-1 | 单一消息真相源 | 引入 message seq/version；运行中以 stream 为准，终态按版本对账 | 重复文本、多标签页、编辑消息不再误覆盖 |
| G3-2 | 拆分 `use-active-chat` | 拆为 `useChatId`、`useChatRuntime`、`useChatMessages`、`useChatInputDraft` | 每个 hook 有清晰输入输出和单测 |
| G3-3 | 显式 run 状态机 | idle/submitted/streaming/recovering/terminal/error | UI 状态只由状态机派生，不再三路布尔推断 |
| G3-4 | 删除模板死重 | 删除 visibility、votes、credit-card、假模型选择器、code/image/sheet 画布、断链 `/api/*` 调用 | knip 不再报告这些入口；附件按钮要么接 Nest 要么隐藏 |
| G3-5 | API 类型与错误统一 | 建 shared types 或 OpenAPI；统一 fetch client 和 401 拦截 | 后端 DTO 字段变化能在前端编译期暴露；401 自动跳登录 |

**阶段退出标准**：

- 前端新增核心 hook 单测。
- 手工验证：切换会话、断线恢复、stop、刷新、重复消息、多标签页不串台。
- 删除模板依赖后 `npm --workspace @ai-product-workbench/web run typecheck` 通过。

### 阶段 4：协作与开发者能力（第 5-8 周）

**目标**：补齐用户提出的协作和开发角色目标。

| 编号 | 目标 | 工作项 | 验收标准 |
|---|---|---|---|
| G4-1 | developer 角色 | Prisma 增加 `developer`；admin 可分配；后端 `@Roles` 分流 | developer 用户可登录并看到开发入口 |
| G4-2 | 技术设计文档生成 | TechnicalDesignDocument 模型；DeerFlow final action；画布 tab；导出 | developer 可基于 confirmed PRD 一键生成技术设计文档 |
| G4-3 | 评论体系 | Comment 模型；PRD/Prototype 锚点评论；分享页只读或受控评论 | 用户可对文档/原型评论、解决、查看历史 |
| G4-4 | 知识检索升级 | pgvector + FTS；DeerFlow `kb_search` tool；召回置信度回传 | 生成中可按需二次检索；检索性能随知识量可控 |

## 4. 目标拆解为 OKR

### O1：让生成链路可靠

- KR1：所有 run 都有终态：`succeeded/failed/cancelled`，不存在超过阈值的永久 `running`。
- KR2：PRD/原型 final action 落库失败不会造成 current 指针和版本表不一致。
- KR3：长会话刷新能看到最新消息。
- KR4：非预期 500 均能在日志中定位 traceId/path/stack。

### O2：打通知识库闭环

- KR1：confirmed PRD/Prototype 产生候选知识。
- KR2：admin 审批后知识可被下一轮生成检索命中。
- KR3：每日任务完成 DB/vault/Quartz 同步，并记录成功/失败。
- KR4：知识 source of truth 明确，文档和代码不再描述双写漂移。

### O3：让前端状态可维护

- KR1：消息同步不依赖文本签名启发式。
- KR2：`use-active-chat.tsx` 拆分后单文件低于 300 行或职责单一。
- KR3：模板残留 UI 和断链 API 调用清零。
- KR4：核心消息/运行状态 hook 有单测覆盖。

### O4：补齐产品闭环

- KR1：用户可分享、撤销分享 PRD/原型。
- KR2：用户可下载 PRD/原型。
- KR3：developer 角色可生成技术设计文档。
- KR4：用户可评论 PRD/原型。

### O5：建立安全与部署底线

- KR1：仓库不再暴露生产 IP 与默认口令组合。
- KR2：用户生成 HTML 响应都有 CSP sandbox 或等价隔离。
- KR3：容器非 root 运行，生产端口不直暴露。
- KR4：模型网关敏感 header 不明文入库。

## 5. 执行顺序建议

推荐严格按以下顺序做，避免先做大重构却留下生产事故风险：

1. **安全止血**：默认口令、长会话消息、异常日志、DeerFlow idle timeout、HTML sandbox。
2. **主链路可靠性**：final action 事务、回滚一致、run 幂等。
3. **目标闭环最小集**：分享、下载、定稿入库、每日同步。
4. **前端状态重构**：消息单一真相、run 状态机、删除模板死重。
5. **产品扩展**：developer、技术设计文档、评论、检索升级。

## 6. 当前已完成项

- 已整理完整审计报告：[Claude 全量审计整理报告](./claude-audit-complete-2026-07-02.md)。
- 已修复 IDOR 邻接缺口：
  - runId stop 前做会话归属校验。
  - streamId 碰撞时拒绝跨会话返回。
- 已补对应 API 单测。
- 已验证：

```bash
npm --workspace @ai-product-workbench/api run typecheck
npm --workspace @ai-product-workbench/api run test
```

结果：API typecheck 通过；API 全量测试 `147 passed | 1 skipped`。

## 7. 后续工作建议

下一步建议直接进入 **阶段 0**，先做不会牵动大量架构但能显著降低风险的止血项：

1. 修长会话消息截断。
2. 给异常过滤器加日志。
3. 给 DeerFlow SSE 加 idle timeout。
4. 原型/分享 HTML 与 visual-context 响应加 sandbox/attachment 防护。
5. 清理 README/部署脚本中的生产 IP 与默认口令风险。
