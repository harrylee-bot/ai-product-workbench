# Runtime 与数据库合同

本文件定义 Workbench Runtime、数据库状态、Knowledge 工具可见性和运行时观测的现行合同。实现、迁移、测试和部署必须共同满足这些约束。

## Runtime 状态

每个 Run 绑定一个 Project、Thread、RuntimeAttempt 和不可变请求快照。外部事件使用唯一 identity、连续 sequence、payload hash 和 attempt scope；事件状态只能按 `pending -> processed` 前进。事件、Run effects、RunDraft、Provider State、processed 标记和 cursor 必须在同一数据库事务中提交。

Provider State 是按 attempt 的持久化投影，至少包含：

- projection version；
- 已应用的 attempt sequence 和外部事件 cursor；
- raw assistant text、visible assistant text 和 redaction buffer；
- finalization identity、payload hash、state hash；
- 更新时间和租约所需的并发字段。

正常执行路径只读取当前 projection 和增量事件，不按 Run 全量重放 JSON 事件。Projection 缺失、版本不匹配、hash 不匹配或 sequence 出现间隙时，Runtime 必须 fail closed，并由受控 backfill 或 repair 流程处理。

## 事务与执行

- 事务内只处理当前事件、当前 attempt 和必要的 RunDraft；禁止网络请求、sleep、全历史 payload 扫描和跨 attempt 无界查询。
- Provider State 的读写使用显式事务预算；单纯延长 timeout 不能替代常数级状态访问。
- `runtime.execute` 的 900 秒边界由 queue lease、provider request/stream idle timeout、worker heartbeat、abort signal、reconciler 和最终 Run 状态共同约束。
- 取消、重试、供应商临时失败和进程退出必须产生明确的持久化终态，重复处理使用 idempotency key 和 CAS。
- Worker 重启或 lease takeover 后，处理器必须从持久状态继续，不重复发布事件、effect 或 artifact revision。

## Knowledge 工具

Knowledge capability 只在当前 Run、Workspace、Project、Release 和 Retrieval Profile 均通过授权及 readiness 校验时签发。没有有效 capability 时：

- 工具不出现在 Runtime 可见工具集合；
- 直接调用返回稳定的 capability 错误；
- 不生成 secret、endpoint 或可推断租户信息；
- 观测只记录脱敏的 reason code、scope 和状态。

检索必须使用授权 scope、固定 release/profile pin、lexical/dense route、确定性排序和 citation locator。模型 provider、Web、API 和数据库领域对象不直接依赖外部模型响应类型。

## 数据不变量

- append-only external event 的 identity、sequence、scope、payload hash 和 immutability trigger 不可绕过。
- Run、Attempt、Artifact、ArtifactVersion、Release、Share、Export 和 KnowledgeRelease 的归属由数据库外键和应用授权共同证明。
- Projection 是可重建派生状态，但不能删除或覆盖 append-only 事件。
- 已发布 release、profile、embedding batch、embedding 和导出结果不可原地修改。
- 所有请求、文件、来源快照、导出和 Runtime 结果都必须使用版本、checksum、ETag 或 idempotency contract 固定身份。

## 恢复与观测

恢复流程必须覆盖：

1. 事件写入前后；
2. effects、projection、processed 和 cursor 提交前后；
3. 数据库提交成功但响应丢失；
4. worker 退出、lease takeover、provider timeout 和 provider 过滤错误；
5. embedding batch 的 claim、publish、finalize 和重复重放。

每个故障点只能得到完整回滚或一次完整提交。告警至少覆盖 provider-state failure、projection lag、transaction timeout、liveness、execution timeout、queue lease、Knowledge visibility 和 release readiness，并链接到可执行 runbook。

## 交付边界

现行实现以以下内容为准：

- `apps/workbench-worker/src/runtime/`
- `apps/workbench-worker/src/runs/`
- `packages/workbench-db/prisma/schema.prisma`
- `packages/workbench-contracts/src/`
- `docs/runbooks/workbench-runtime-provider-state-rollout.md`
- `deploy/observability/workbench-runtime-alerts.yaml`

所有变更必须通过对应的 PostgreSQL、Runtime、部署合同和 OpenAPI 验证。
