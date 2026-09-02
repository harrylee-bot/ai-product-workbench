# Codex 执行规格：Runtime Provider-State、900 秒事件与 Knowledge 可见性整改

更新时间：2026-07-23  
仓库：产品工作台当前仓库  
不可变事故基线：`e7deb65d8b6e03f8a9e73787afeaaca7a70750e6`  
目标：形成一个新的、可重建、可测试、可部署的修复候选；本文只规定施工，不修改基线代码。

> **唯一 Runtime 执行入口。** Codex 只按本文分 wave 施工，不得另建平行的 projection、backfill、Knowledge scope 或 gate 合同。功能、PRD 体验、动效、浏览器和生产镜像整改只以 `docs/CODEX-WORKBENCH-FUNCTIONAL-VISUAL-REMEDIATION-SPEC-20260727.md` 为执行入口。
>
> **当前状态。** 本文交付时只有设计与既有审计证据；Wave A–H、PostgreSQL 大规模回归、900 秒根因、同候选部署和 G0–G12 均尚未由本文执行，初始状态一律为 `NOT RUN` 或 `BLOCKED`，不得把本文存在本身当作整改完成证据。

## 0. Codex 的执行合同

Codex 必须按本文顺序实施，并把每个事实绑定到实际 diff、测试输出或脱敏生产证据。不得猜测尚未存在的类型、函数、表、脚本参数、镜像标签或环境变量；若实际仓库与本文的“可能文件”不一致，先用搜索找到真实调用点，在施工记录中写明替代路径和依据，再修改。

以下用户约束必须逐字保留并作为每个 wave 的停止条件：

- “Baseline e7deb65d must remain immutable.”
- “Never include credentials or user content.”
- “Document must tell Codex exactly what to inspect/change/test/evidence, but must not fabricate code details.”
- “Inspect actual middleware/config/tool/prompts/tests.”
- “Preserve request-scoped secrets and fail-closed behavior.”
- “do not solve only by raising timeout”

本文中以“建议”标出的新名称不是既有代码事实；Codex 只能在核验实际 schema、命名约定和调用方后采用，并必须在 PR 中记录最终名称映射。

硬约束：

1. 不得 checkout 后改写、amend、force-push 或重新标记 `e7deb65d`；从该 SHA 创建新分支和新提交。先记录 `git rev-parse HEAD`、`git status --short --branch` 和 `git diff --stat e7deb65d`。
2. 只有本文与功能视觉整改规格属于当前整改控制面；不得向候选重新加入历史交接、并行草稿或阶段报告，除非 Release owner 明确批准新的现行合同。
3. 不得把“提高 Prisma timeout”作为修复。事务预算可以保留为防护，但 provider-state 的稳态读写不能按 Run 回放全部 JSON 事件。
4. 不得在源码、fixture、日志、trace、metric label、receipt 或本文后续记录中放入凭据、capability token、数据库 URL、用户 prompt、用户文件内容、provider message 正文或真实事件 payload。负载测试使用生成的非用户合成数据。
5. PostgreSQL 集成测试是强制门禁；SQLite、mock Prisma、纯 unit 测试不能替代。
6. 三个 P2028 中的 provider-state P2028 与独立的 `runtime.execute` 超过 900 秒必须拆成两个 finding、两个根因、两个修复/验证轨道。不得用 provider-state 修复自动关闭 900 秒轨道。
7. 当前生产是混合版本（Worker=`e7deb65d`，多数服务=`4bf8c155`，DeerFlow 为 `0bcd6d6c` 派生）。后续不得在混合版本上签发 PASS；Workbench 全部服务、migrator、Worker、Web/API/Preview/Import/Export/File Worker、Knowledge、DeerFlow 必须来自同一新候选的不可变 digest inventory。
8. 当前 hard-cut enforce 在零 verified receipts 下失败是正确行为。不得伪造 receipt、把技术 smoke 升格为批准，或绕过 G0/G12。
9. `.claude/launch.json` 中 `gemini-canvas-replica` 指向仓库外个人绝对路径，且 `api` workspace 名与当前仓库命名可能不一致。它是已知 stale 配置；新候选必须修正或删除无效 entry，并加入合同测试，但不得把本地 preview 成功当生产证据。

## 1. 已确认事故事实与施工前核验

Codex 先在只读模式确认并把文件/行号写入施工记录：

- `apps/workbench-worker/src/runtime/runtime-attempt.service.ts` 的 `providerTextState()` 在 interactive transaction 内：锁定 Run/attempt、读取最多 `runtimeProviderTextReplayEventLimit + 1` 行 processed `runtime_external_events`（当前限制 10,000）、搬运完整 JSONB、解析并在应用层重放，然后才 `runDraft.findUnique()`。
- 该方法没有使用 `runtimeExecutionTransactionOptions`，因此使用 Prisma interactive transaction 默认 5 秒；实际生产 Run 有 7,686 个事件，事务在 18,727ms 后于 `runDraft.findUnique` 报 P2028。这里的报错位置是“事务已过期后的下一次查询”，不能被误判为单行 RunDraft 查询慢。
- `e7deb65d` 的 30 秒 options 只覆盖 `heartbeat()` 和 `processInboxEvent()`（含 finalization），不覆盖 `providerTextState()`。
- `runtime-assistant-text.ts` 当前从事件重建 raw/visible assistant text、redaction buffer、当前 attempt 的 processed event IDs 和 finalization；它还允许通过 cumulative/finalization anchor 限制回放，但依然先取整批 JSON。
- `run-processor.ts` 在 Runtime claim 后调用 `providerTextState()`，再把状态交给 `deerflow-runtime.adapter.ts`；adapter 用该状态恢复 assistant text、去重集合和 finalization。
- `processInboxEvent()` 当前在一个事务内完成：claim fence、事件 identity/idempotency、attempt sequence、inbox row、所有 Run effects、processed 状态、provider cursor。新设计必须保留这一原子性。
- `runtime_external_events` 的唯一键、sequence、pending→processed 单向状态、payload hash 和 scope/immutability trigger 是不可破坏的审计日志 invariant。
- `runtimeExecuteQueueOptions.expireInSeconds` 当前为 15 分钟；生产有一个独立 `runtime.execute` handler 超过 900 秒。必须从 pg-boss job lifecycle、abort signal、provider request/stream idle timeout、worker heartbeat/lease、reconciler、错误分类和最终 Run 状态完整追踪。
- `integrations/deerflow/runtime-tools/config.fragment.yaml` 全局注册 `workbench_knowledge_retrieve`。当前 `WorkbenchToolScopeMiddleware` 只 request-scope Canvas 和 Prototype 工具，没有 request-scope Knowledge。无 Knowledge Release 时 Worker 正确返回 `knowledgeTool=null`、不签发 secret，但模型仍能看到并调用该工具，得到 `WORKBENCH_KNOWLEDGE_CAPABILITY_MISSING`。目标是无授权时工具不可见且不可执行，而不是仅靠执行时缺 secret。

若任一事实与实际 SHA 不符，停止实现、记录 SHA/差异并要求重新定界；不得静默套用本规格。

## 2. 先做的代码与数据流清单

Codex 必须至少检查以下实际文件及其调用方：

### 数据库与迁移

- `packages/workbench-db/prisma/schema.prisma`
- `packages/workbench-db/prisma/migrations/20260719020000_runtime_execution_durability/migration.sql`
- `packages/workbench-db/prisma/migrations/` 中所有后续会替换 runtime trigger/constraint 的迁移
- `scripts/workbench-postgres-constraints.mjs`
- `.github/workflows/workbench-ci.yml`
- `deploy/workbench-migrate.sh`、`deploy/workbench-compose.yml`、生产 preflight 与数据库 least-privilege 合同

### Worker/runtime

- `apps/workbench-worker/src/runtime/runtime-attempt.service.ts`
- `apps/workbench-worker/src/runtime/runtime-assistant-text.ts`
- `apps/workbench-worker/src/runtime/runtime.port.ts`
- `apps/workbench-worker/src/runtime/deerflow-runtime.adapter.ts`
- `apps/workbench-worker/src/runs/run-processor.ts`
- `apps/workbench-worker/src/runs/run-event.store.ts`
- `apps/workbench-worker/src/main.ts`
- `apps/workbench-worker/src/runs/runtime-execution-reconciler.ts`
- `packages/workbench-contracts/src/queues.ts`
- `apps/workbench-worker/src/config.ts`

### 现有测试

- `apps/workbench-worker/test/runtime-attempt.service.spec.ts`
- `apps/workbench-worker/test/runtime-attempt.postgres.spec.ts`
- `apps/workbench-worker/test/runtime-assistant-text.spec.ts`
- `apps/workbench-worker/test/deerflow-runtime.spec.ts`
- `apps/workbench-worker/test/run-processor.spec.ts`
- `apps/workbench-worker/test/runtime-execution-reconciler*.spec.ts`
- queue/deployment contract tests in `scripts/`

### Knowledge/DeerFlow

- `apps/workbench-worker/src/runtime/knowledge-tool-grant.service.ts`
- `integrations/deerflow/runtime-tools/config.fragment.yaml`
- `integrations/deerflow/runtime-tools/deerflow_workbench_tools/knowledge_tool.py`
- `integrations/deerflow/source-patches/7a6c4a994a86583d2a3c056ee9d0f157d4f030c2/workbench_tool_scope_middleware.py`
- 同目录 `manifest.json` 与 `test_workbench_tool_scope_middleware.py`
- source-patch applier、DeerFlow Dockerfile、deployment assertion、secret-channel/Knowledge smoke

## 3. Provider-state v2 持久化设计

### 3.1 新 projection 表

优先新增独立的一行/attempt 表，而不是继续把大状态塞进 `runtime_attempts`。建议 Prisma model 名 `RuntimeProviderState`、数据库表名 `runtime_provider_states`；若仓库命名规范要求不同，保持字段语义不变并记录映射。

必需字段：

| 字段 | 建议 PostgreSQL 类型 | 语义 |
|---|---|---|
| `runtime_attempt_id` | TEXT PK/FK | 唯一 attempt；级联策略必须与 runtime attempt 生命周期一致 |
| `run_id` | TEXT NOT NULL | 冗余 scope，用复合 FK 绑定 attempt/run，防跨 Run projection |
| `projection_version` | SMALLINT/INTEGER NOT NULL | 投影算法版本；本次为 v2 的明确常量，不得用应用版本字符串替代 |
| `last_applied_sequence` | INTEGER NOT NULL DEFAULT 0 | 已原子应用的最大 attempt event sequence |
| `last_external_event_id` | VARCHAR(1024) NULL | 与 last applied provider event 对应；finalization 是否推进 provider resume cursor 必须沿用现有语义，不得混同 |
| `raw_assistant_text` | TEXT NOT NULL DEFAULT '' | 恢复 cumulative/delta 所需原始 assistant text |
| `visible_assistant_text` | TEXT NOT NULL DEFAULT '' | 已 capability-redact、可持久显示文本 |
| `redaction_buffer` | TEXT NOT NULL DEFAULT '' | 跨 chunk redaction 状态；受现有 4096 上限约束 |
| `finalization_external_event_id` | VARCHAR(1024) NULL | 当前 attempt 已提交 finalization 的 identity |
| `finalization_payload_sha256` | CHAR(64) NULL | 绑定 append-only inbox 中的 finalization payload；不得复制任意用户 payload |
| `state_sha256` | CHAR(64) NOT NULL | 对 canonical projection envelope（version、attempt/run、sequence/cursor、text state、finalization identity/hash）计算完整性哈希 |
| `built_at` | TIMESTAMPTZ(6) NOT NULL | 首次建投影时间，使用数据库时钟 |
| `updated_at` | TIMESTAMPTZ(6) NOT NULL | 最后成功应用时间，使用数据库时钟 |

禁止把 `processedExternalEventIds[]` 存成无界数组或 JSON。当前 adapter 只需要判断 provider replay 是否已处理；改为持久层的 identity lookup/去重或一个有界、显式语义的 resume-window，不允许在启动时载入 7,686/10,001 IDs。推荐让 adapter 对每个重放事件仍调用现有 `processExternalEvent()`：数据库唯一键和 payload hash 决定 `{created:false}`，effects 不重放；若为减少调用而增加批量 identity API，其查询必须按当前 attempt + 明确 ID 批次、只返回 identity/hash/status，不取 payload，并保持 conflict 检查。

### 3.2 数据库 invariants

迁移必须用 Prisma schema 加显式 SQL constraints/triggers，至少保证：

1. `projection_version > 0`，`last_applied_sequence >= 0`。
2. sequence=0 时 event id/finalization 均为空且 text state 是合法初始投影；非零 sequence 必须不超过对应 attempt 的 `external_event_sequence`。
3. projection 的 `(runtime_attempt_id, run_id)` 必须引用同一 attempt；身份列不可修改。
4. sequence 单调递增；projection version 只能按批准的迁移路径升级，不可回退。
5. finalization identity/hash 必须成对为 NULL 或成对非 NULL；如非 NULL，必须能关联同 attempt 的 processed `runtime_external_events` finalization row，且 hash 相等。
6. `state_sha256` 格式合法；应用每次读后必须重算并 fail closed。数据库 trigger 是否重算哈希取决于现有 canonical JSON 能否在 SQL 与 TypeScript 完全一致；不能一致时不要伪造 SQL 哈希算法，改为 trigger 保护形状/单调性、应用负责哈希并由 PostgreSQL 测试验证。
7. raw/visible/redaction 长度沿用 `runtime-assistant-text.ts` 的现有上限。不要在数据库与应用定义不同的静默截断规则。
8. processed inbox row、projection、Run effects、RunDraft、attempt cursor 的更新必须同事务提交或同事务回滚。
9. append-only `runtime_external_events` 仍是审计真相源；projection 是可重建派生物，不得删除历史 payload 或放松现有 unique/hash/immutability invariants。
10. terminal attempt 的 projection 不得继续前进；finalization 后普通 provider event 仍须拒绝。

### 3.3 纯投影 reducer

在 `runtime-assistant-text.ts` 保留/抽取一个版本化纯函数：输入为“已验证 v2 state + 一个已验证 event identity/payload/hash”，输出为 next state 和该事件产生的 provider-text effect。它必须复用现有：

- assistant delta/cumulative 冲突判断；
- capability redaction 与跨 chunk buffer；
- finalization checkpoint/payload/hash验证；
- event-after-finalization、multiple-finalization、draft conflict；
- canonical state hash。

不要复制第二套 assistant text 解析规则。现有全历史 `rebuildRuntimeProviderTextState()` 可在 backfill/repair verifier 中保留，但不再位于正常 claim→execute 热路径。

### 3.4 热路径事务边界

重构 `processInboxEvent()`，在当前同一个 interactive transaction 中按以下顺序执行：

1. `assertClaimTx()` 锁定 Run/attempt 并验证 owner/epoch/lease/status。
2. 按 `(runtimeAttemptId, externalEventId)` 查 inbox；完全相同的 processed replay 立即返回，不运行 effects、不推进 sequence、不写 projection。identity/hash 不同继续抛 `RUNTIME_EXTERNAL_EVENT_IDENTITY_CONFLICT`。
3. 对新事件以 CAS/锁定方式分配下一 attempt sequence 并插入 pending inbox。
4. `SELECT ... FOR UPDATE` 当前 projection；若缺失，只允许通过受控初始化/已完成 backfill 创建，不能在不看历史的情况下把活跃旧 attempt 当空状态。
5. 验证 projection `last_applied_sequence` 与新事件序列连续。发现 gap、ahead、hash mismatch 或 version mismatch 时 fail closed，产生稳定的非敏感错误码，不猜测跳过。
6. 用纯 reducer 计算 next projection。
7. 执行 `RunProcessor.persistRuntimeEffectsTx()` 及其 RunEvent/RunDraft 写入。
8. CAS 更新 projection（where 包含 attempt、version、previous sequence、previous state hash）；更新 processed inbox；按现有规则更新 `lastExternalEventId`。
9. 任一 count 不为 1 均 rollback 并 fence/conflict；commit response 丢失后重放应由步骤 2 得到 `{created:false}`。

事务内禁止：查询该 Run 的全部历史 inbox、搬运无关 JSONB、网络请求、sleep、backfill、跨 attempt 扫描。30 秒 timeout 只是异常上界；7,686+ 稳态事件之后的单事件处理和 provider-state 读取必须保持常数级数据库工作。

### 3.5 `providerTextState()` 新语义

正常路径只做：

- claim fence/一致性读取；
- 读取当前 attempt 的一行 v2 projection；
- 读取 `run_drafts` 的必要列（若 projection visible text 已与 draft 原子维护，也仍验证二者一致）；
- 校验 version、state hash、attempt/run identity、sequence 不大于 attempt sequence、draft visible text 一致；
- 返回 adapter 所需的有界状态，不返回全量 event IDs。

该读可用一个短事务或单条带 scope 的查询；Codex 必须基于实际并发/fence要求选择并写测试。禁止为了“无事务”而丢失 claim fencing，也禁止通过延长到 30 秒掩盖全表回放。

### 3.6 Adapter 去重接口

修改 `runtime.port.ts`、`run-processor.ts` 和 `deerflow-runtime.adapter.ts` 的实际类型/调用点，使 adapter 不再构造全历史 `Set(processedExternalEventIds)`。选择并实现一种明确合同：

- 首选：每个带显式 provider ID 的事件都提交 observer；持久层以唯一键判定 replay，adapter 只有在 `{created:true}` 时更新内存状态/effects；需要调整 observer 返回值并测试。
- 可选：注入 `isExternalEventProcessed(id, identityHash)` 的按需/有界批量查询；必须防 TOCTOU，最终仍以 `processInboxEvent()` 的事务结果为准。

无论选择哪种，重复 ID+相同 identity 不产生重复 RunEvent/RunDraft/projection，重复 ID+不同 payload/type/run 必须 fail closed；DeerFlow `end/null` sentinel 继续不能进入 inbox或推进 cursor。

## 4. 历史 backfill、双读与上线迁移

### 4.1 Expand

新迁移只增加 projection 表、constraints/indexes/trigger，不删除旧列、不改写 event payload。迁移必须适用于：fresh DB、从 `e7deb65d` schema 升级、含 pending/processed/terminal 多 attempt 数据的升级。运行时角色只能读写必要 projection 表；DDL/backfill operator 使用 migrator 角色。

### 4.2 Backfill operator

增加一个仓库内、可测试、可恢复的 operator 脚本（放在 `scripts/`，名称按现有规范），不得把大回填塞进 schema migration 的单个长事务。

要求：

1. 仅接受显式 migrator database environment contract；拒绝缺失、非 PostgreSQL、未知目标。输出中永不打印 URL。
2. 以 attempt 为 checkpoint 单元，以主键/确定顺序 keyset 分页，不用 OFFSET；每个 attempt 单独短事务。
3. 每次锁定一个 attempt，读取该 attempt/Run 所需的 processed events，按 `(attempt, sequence)` 重放，并读取必要 RunDraft。历史跨 attempt assistant text 语义必须以现有 `rebuildRuntimeProviderTextState()` 为准；如果当前 Run 的文本由多个 attempt 贡献，先离线构建各 attempt 的 terminal/starting state，不能把每个 attempt 都从空状态开始。
4. 每个 attempt upsert 必须幂等：已存在且 version/hash/sequence 相同则跳过；不同则报 conflict，不覆盖。
5. 记录脱敏 checkpoint：candidate SHA、operator version、projection version、attempt ID 的不可逆哈希或 opaque ID、event count、last sequence、state hash、duration、status；不记录文本或 payload。
6. 支持 `--dry-run`/verify-only、bounded batch、resume 和明确退出码；具体 CLI 形式由现有脚本风格决定，不得凭空添加未实现参数。
7. 遇到 pending event、sequence gap、payload hash mismatch、无有效 anchor、multiple finalization、draft conflict 时停止该 scope并使总体失败；不跳过坏数据。
8. 提供 coverage 查询：总 attempts、应有 projection、已建、version/hash 验证通过、缺失、冲突、lagging；active attempt 缺投影时 rollout 不得切换。

### 4.3 Shadow/verify 与 cutover

采用显式模式而非隐式 fallback，建议状态为 `legacy-read`、`shadow-verify`、`projection-required`；实际配置名由 Codex根据 `config.ts` 规范定义并加入 schema/preflight。

- `legacy-read` 只用于迁移前，不接受为最终候选。
- `shadow-verify`：新事件原子写 projection；抽样/受控地用历史 reducer校验结果，但历史 replay 必须在事务外、不可阻塞 handler、不得读取或记录用户内容。任何 mismatch 告警并阻止 cutover。
- `projection-required`：热路径只读 projection；缺失/version mismatch/hash mismatch立即 fail closed，不回退全历史 replay。

切换顺序：expand migration → backfill → coverage=100% → shadow verify 零 mismatch → 同候选 worker canary → `projection-required` → 全量 worker。不要先部署只会读取新表的 Worker。

### 4.4 Crash recovery

必须 fault-inject 并验证以下点：pending insert 前；pending insert 后；effects 后；projection CAS 后；processed/cursor 后；数据库 commit 成功但客户端响应丢失；worker kill 后 lease takeover；backfill attempt commit 前后。每一点都应得到“全部回滚”或“一次完整提交”，不得出现 projection 已前进但 RunDraft/RunEvent 未前进、反之亦然。

### 4.5 Rollback/forward repair

- Expand 阶段可回滚应用，不回滚/删除 projection 表。
- 一旦 `projection-required` 写入新版本 state，禁止把旧 Worker 当常规 rollback 部署，因为旧 Worker不会维护/理解相同投影合同。首选 forward repair 或部署同 schema/projection version 的前一候选。
- 紧急回退到 legacy read 前，必须暂停 runtime queue、确认 append writer 单一、验证历史事件仍完整、执行 projection-vs-replay verifier，再恢复；操作必须有 Data/Operations 批准。
- destructive migration（删除旧字段/兼容路径）另立候选且至少跨一个完整观察窗口，不属于本 work package。

## 5. PostgreSQL 强制测试矩阵

把 `apps/workbench-worker/test/runtime-attempt.postgres.spec.ts` 纳入一个不会因缺 env 静默 skip 的 CI job。可以保留本地 `describe.skip` 便利，但 CI wrapper 必须先断言数据库变量存在、目标是隔离测试数据库/schema，再执行文件并检查测试数量；skipped=FAIL。

至少新增：

1. **7,686 events incident reproduction**：合成 7,686 个 processed provider events（包含 delta、cumulative anchor、无文本事件和 finalization 的代表性分布），生成合法 hashes/effects/draft；旧 replay helper 可用于期望值，新 `providerTextState()` 只能读取一行 projection/必要 draft，结果完全相同。
2. **10,001+ boundary**：至少 10,001（建议 12,000）事件，不触发 replay-limit，稳态读取不取 event JSON；证明不是把 limit 调大。
3. **Query-shape assertion**：使用 PostgreSQL统计/Prisma instrumentation或受控 proxy证明热路径没有 `FROM runtime_external_events ... LIMIT 10001` 全历史查询；EXPLAIN evidence 只含 schema/query plan，不含 payload。
4. **Performance budget**：在 CI PostgreSQL 上记录 p50/p95/max 和查询数。门禁以稳定的结构性上界为主（常数查询数、无历史 payload scan）；时间阈值必须根据 CI baseline 定义并留合理余量，不能伪造绝对生产 SLO。7,686 和 10,001 两组都必须明显低于 5 秒且无 P2028。
5. **Atomic event**：新事件的 inbox、effects、RunDraft、projection、processed、cursor一次提交；每个 fault point 回滚。
6. **Replay**：commit response loss 后同 event 同 identity不重复；冲突 identity报错且状态不变。
7. **Concurrency**：两个 owner/epoch、heartbeat contention、lease expiry/takeover、同一/相邻 sequence并发；过期 owner不能推进 projection。
8. **Projection integrity**：state hash损坏、version未知、sequence gap/ahead、draft conflict、finalization hash冲突全部 fail closed。
9. **Backfill**：fresh、upgrade、resume、重复运行、部分完成、terminal attempt、多 attempt、pending event、坏 hash、kill/restart。
10. **Least privilege**：runtime role可按合同读写 projection但不能 DDL；migrator可以迁移/backfill；restore drill后 constraints、projection coverage和 hashes仍通过。
11. **Payload size**：合成接近允许上限但不含用户内容的 JSON/text，证明事务只处理当前事件，不因历史总 payload线性增长。
12. **No timeout-only regression**：测试应在移除/缩短测试专用 transaction timeout时仍因常数工作通过；不得以 `pg_sleep(6)` + 30 秒 success作为本事故的验收。

CI 需要运行：root prepare/typecheck、Worker unit、Worker PostgreSQL integration、migration fresh/upgrade、postgres constraints、DeerFlow Python tests、deployment contracts。Codex报告实际 package scripts；如果当前 Worker没有 `test:postgres` script，就新增明确 script并在 `.github/workflows/workbench-ci.yml` 调用，而不是声称已有。

## 6. 独立 900 秒 `runtime.execute` 事件工作包

创建独立 finding（不得与 P2028 合并），先采集脱敏时间线：job id hash、Run id hash、candidate/image digest、created/started/expired/completed/failed时间、retry count、pg-boss state、Worker claim/heartbeat/lease、provider submit/first-byte/last-event/stream idle、cancel signal、reconciler动作、最终 Run/attempt状态。不得采集请求或响应正文。

Codex 必须检查：

- `packages/workbench-contracts/src/queues.ts` 的 15 分钟 `expireInSeconds` 是否代表“开始前过期”还是“handler deadline”，用 pinned pg-boss 文档/源码和 PostgreSQL实验确认，不能凭名称猜。
- `apps/workbench-worker/src/main.ts` 的 `job.signal` 何时 abort，`RunProcessor.execute()`、DeerFlow SDK stream和 fetch是否完整传播。
- `deerflow-runtime.adapter.ts` 的 request timeout、stream idle reconnect、join/reconcile是否可能无限延长总 wall clock。
- application heartbeat与 pg-boss heartbeat、45 秒 lease、execution reconciler是否出现“双活”“job expired但Run仍running”或无 owner stranded状态。
- provider 已接受但外部 run identity未知、join cursor、cancel/retry分类和 finalization是否安全。

设计显式 liveness 状态机与三个独立预算：submission/connect、stream idle、maximum Run wall clock。值必须基于产品批准和真实长 Run数据，不要直接复用900秒。到期动作必须是：abort I/O → 尝试有界 provider cancel/reconcile → 原子记录明确、可重试性正确的状态 → 释放/fence lease → 由 reconciler收敛；不能仅让 pg-boss job消失而 Run 保持 running。

必测：899秒边界、超过900秒、持续有事件的长 Run、完全 idle、断连重连、provider 已成功而本地超时、abort不响应、worker SIGTERM/SIGKILL、重试/接管、cancel竞争。使用 fake clock/本地受控 provider完成大部分测试，并在同候选 staging做真实时间压缩/批准的长时序 smoke。验收证据单独列出 finding状态；没有根因和修复前保持 BLOCKED。

## 7. Knowledge request-scoped 可见性

在 DeerFlow source patch 中把 Knowledge 加入与 Canvas/Prototype 同等级的 request-scoped model visibility与ToolNode execution policy，但授权依据必须是 trusted runtime context中的无 token声明；secret继续只在 `context.secrets.WORKBENCH_KNOWLEDGE_CAPABILITY`。

建议 scope字段是严格对象（例如 `knowledgeEnabled: true` 或严格 `knowledge` descriptor）；最终名称需与 Gateway normalization/manifest一致。规则：

1. Worker `knowledgeTool === null` 时，不发送 Knowledge enabled声明、不发送 secret；模型 tool list中没有 `workbench_knowledge_retrieve`；伪造 tool call在 sync/async ToolNode path均被 middleware阻断，handler不执行。
2. 非 null descriptor时，Gateway仅允许 trusted internal caller注入 tokenless enabled scope与secret；模型可见 Knowledge tool，执行时tool从request-scoped secrets取 capability。
3. missing/malformed/extra-key scope fail closed；客户端 configurable/context伪造被剥离；跨并发 Run不串 scope。
4. capability仍不得进入 configurable、message/state/checkpoint/trace/event/log/tool result；现有 redaction不作为泄漏许可。
5. subagent策略必须显式决定 Knowledge是否可委派；缺批准时默认从subagent移除，不能因全局group被重新发现。
6. `CAPABILITY_MISSING` 只保留为纵深防御异常，不再是正常无 release Run的模型可见结果。

修改 manifest中的 source hashes、patch tests、Docker build contract和deployment assertions。测试至少覆盖 null release、valid release、malformed scope、untrusted caller forgery、sync/async model filtering、sync/async tool execution、两个并发相反scope、subagent、secret persistence负向和真实deployed catalog smoke。测试/证据只能说明“工具名可见/不可见、调用成功/被阻断”，不能打印capability或retrieved用户内容。

## 8. Telemetry、告警与脱敏

为 projection 和 liveness 增加低基数 telemetry：

- provider-state read/update/backfill duration histogram；
- rows/events applied count（单次热路径应为0/1）；
- projection lag（attempt sequence - projection sequence）；
- missing/version/hash/gap/draft-conflict/replay/conflict counters；
- transaction wait/duration/P2028 counter，按operation分类；
- runtime job queue age、handler wall clock、provider first-byte、stream idle、abort/cancel/reconcile outcome；
- Knowledge visible/blocked decision counter（不含query/release/token）。

允许 label：service、candidate短SHA、projection version、operation、outcome、稳定错误码、environment。禁止 label/attribute：Run/attempt/event原始ID、external ID、prompt、assistant text、payload、query、principal、project、capability、URL或凭据。高基数关联只在受控日志中使用不可逆hash并设保留期。

告警至少覆盖：任意生产P2028；projection lag>0持续；missing/hash/version/gap；backfill conflict；runtime job接近/超过批准wall-clock；job terminal但Run仍active；lease takeover激增；Knowledge无授权执行尝试。为每个告警写runbook动作、owner、回滚/forward-repair和证据路径。

## 9. 同一候选构建、部署和证据

完成代码后创建新candidate SHA；所有下游证据只绑定该 SHA，不能继承 `4bf8c155`、`e7deb65d` 或 `0bcd6d6c` 的 PASS。

必须更新/验证：

- migration inventory与production image inventory；
- Workbench所有服务和migrator镜像的source revision/digest；
- DeerFlow source-patch manifest、patched source hash和镜像digest；
- Compose/deploy/preflight/release-chain合同；
- `.claude/launch.json` stale entry及其本地合同；
- SBOM、漏洞扫描、签名/provenance；
- 目标环境实际container digest与candidate inventory逐项相等；
- expand/backfill/coverage/shadow/cutover/rollback drill receipts；
- provider-state 7,686+/10,001+ PostgreSQL结果；
- 独立900秒事件根因与验证；
- Knowledge null/non-null deployed catalog结果；
- hard-cut verified receipts和独立批准。

证据只记录候选、镜像digest、migration ID、测试名称、开始/结束UTC、result、计数/时延、工具版本、脱敏错误码和文件SHA-256。原始输出放不可变、访问受控位置并进入ledger；不得包含env dump、container `Config.Env`、数据库URL、payload或用户内容。

## 10. G0–G12 验收定义

任一 gate 的前置未通过时状态为 BLOCKED；测试未执行为 NOT RUN；skipped不是PASS。

### G0 范围与独立责任

Security、Data、Operations、Release四个独立责任人批准：事故范围含provider-state P2028、另一个900秒finding、Knowledge可见性、混合部署、stale launch配置；批准projection version、数据迁移/回滚、SLO和证据策略。记录绑定最终G1 candidate，实施者不能自签。

### G1 不可变候选

从 `e7deb65d` 派生的新clean commit/tag/manifest；列出全部source、migration、generated patch/validator、deployment config；无关键untracked/ignored依赖，且明确证明`e7deb65d`对象未改写。

### G2 Fresh-clone可重建

Node/npm/Python/DeerFlow pin明确；fresh clone安装、Prisma generate、runtime validator/source patch apply、二次生成零diff；`.claude/launch.json`不含不存在的仓库外路径且实际配置名有效。

### G3 CI与PostgreSQL门禁

root typecheck/test/architecture/OpenAPI及新增Worker PostgreSQL job全部PASS；7,686与10,001+ tests实际运行且零skip；fresh/upgrade migration、constraints、fault injection、Knowledge middleware tests PASS。保存脱敏输出hash。

### G4 同候选供应链

所有服务、migrator和DeerFlow由G1同一candidate构建；immutable registry digest、SBOM、扫描、签名/provenance与inventory一致；禁止混用`4bf8c155`/`e7deb65d`/旧DeerFlow镜像。

### G5 数据迁移与恢复

least-privilege fresh/upgrade迁移PASS；历史backfill 100% coverage、零conflict/lag/hash mismatch；幂等resume与故障恢复PASS；backup/restore后projection和append-only事件验证PASS；RPO/RTO由Data owner验收。无destructive cleanup。

### G6 安全与审计

现有auth/IAM/SSRF/checksum/secret等门禁保持PASS；projection/telemetry/evidence不泄露内容或凭据；runtime/migrator权限最小化；Knowledge伪造scope、跨Run、secret persistence负向PASS；独立Security批准。

### G7 Runtime/DeerFlow最小能力

provider-state v2稳态常数工作、identity/finalization/cursor invariants、adapter replay、crash recovery全部PASS；无Knowledge release时工具既不可见又不可执行，有授权时仅request-scoped可见；DeerFlow patch hash/digest与candidate一致。

### G8 Provider与长时序

独立900秒finding有经证据验证的根因和修复；provider success、reject、429、5xx、connect timeout、idle、disconnect/rejoin、cancel、899/900+边界、worker kill/restart均收敛到正确Run/attempt/job状态；不得以延长queue/DB timeout单独过关。

### G9 Knowledge

null release不签发grant/secret、catalog无Knowledge；valid pinned release才显示并成功调用；并发scope隔离、citation/route/profile/benchmark及secret-channel负向PASS。证据无query或retrieved正文。

### G10 生产拓扑、可观测与恢复

同candidate镜像在目标拓扑部署；projection expand/backfill/shadow/cutover与rollback/forward-repair drill完成；无P2028、无projection lag/hash错误、无job/Run漂移；OTLP/alerts/runbooks、kill/restart/容量观察PASS。`formalG10`只能由独立Operations证据决定。

### G11 完整产品矩阵

在G5–G10同一部署candidate上完成账户、项目、普通Run、7,686+长Run、重试/恢复、Canvas/Prototype、Knowledge null/valid、Import/Export/Preview与a11y；确认provider-state变化没有重复/丢失文本、effects、draft或artifacts。

### G12 独立生产批准与hard-cut

G0–G11全部PASS；verified receipts非零且全部绑定同一candidate/image/migration/config/environment；`hard-cut manifest --enforce`实际PASS；零旧流量/混合镜像/residual；观察窗口内P2028=0、projection invariant error=0、900秒finding不复现；Security/Data/Operations/Release独立签署。此前不得宣称“remediation complete”或“production accepted”。

## 11. Codex 分 wave 执行顺序

每个wave单独审查；失败即停止，不跨wave掩盖。

1. **Wave A — 冻结与可复现事故**：记录基线；新增旧路径7,686 reproduction和900秒时间线采集测试，不改行为。
2. **Wave B — Expand schema**：Prisma model、SQL migration、constraints/triggers、least-privilege/fresh/upgrade tests。
3. **Wave C — Reducer与原子写**：版本化纯reducer；`processInboxEvent`原子更新projection；fault injection与concurrency。
4. **Wave D — Backfill/shadow**：operator、coverage、resume、verify、telemetry；真实脱敏数据库副本演练。
5. **Wave E — Read cutover/adapter**：去掉热路径历史JSON replay和全量ID Set；projection-required；7,686/10,001+结构/性能门禁。
6. **Wave F — Knowledge scope**：DeerFlow middleware、Gateway context、subagent、manifest/hash、null/valid catalog测试。
7. **Wave G — 900秒独立修复**：根因确认后才实现wall-clock/idle/cancel/reconcile状态机及完整测试。
8. **Wave H — Candidate/release**：stale launch修复、full CI、fresh clone、同candidate镜像、SBOM/签名、staging迁移/回滚、目标部署与G0–G12证据。

## 12. 每个 wave 的强制回报格式

Codex每个wave结束必须报告：

1. candidate/base SHA与clean/dirty状态；
2. 实际检查和修改的文件（绝对路径）及理由；
3. schema字段、约束、transaction boundary或状态机的实际实现摘要；
4. 保留的external event/fence/finalization/redaction invariants；
5. 测试命令、实际PASS/FAIL/SKIP数量和duration；PostgreSQL版本、事件数、查询数、p50/p95/max（不含连接信息）；
6. fault injection点与每点最终数据库状态；
7. migration/backfill coverage、lag/conflict/hash计数；
8. 900秒finding独立状态；
9. Knowledge null/valid可见性与执行结果；
10. 原始脱敏证据绝对路径、SHA-256和immutable URI（若尚未上传则明确NOT RUN）；
11. rollback/forward-repair步骤与剩余风险；
12. G0–G12逐项PASS/BLOCKED/NOT RUN，不得自行升级独立批准。

## 13. 完成判定

此work package的“代码完成”至少要求Wave A–G在同一clean candidate上通过；“可发布”要求G0–G11通过；“生产整改完成”只在G12独立enforce/批准和观察窗口完成后成立。仅有以下任一结果都不算完成：把transaction timeout从5秒改为30秒；7,686 mock测试；backfill脚本未在PostgreSQL跑；Knowledge只在缺secret时报错；900秒job未独立定因；混合candidate部署；零verified receipts的hard-cut失败被忽略。
