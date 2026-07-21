# G5 PostgreSQL 备份与恢复演练

本 runbook 用于验证指定候选在明确批准的隔离或测试 PostgreSQL 环境中，能够完成备份、恢复、候选迁移前向修复、数据一致性校验，并满足批准的 RPO/RTO。它不会部署应用，也不会把一次本地测试自动升级为生产验收结论。

## 安全边界

- 只允许 `isolated` 或 `staging` 环境；不得指向生产、未知、共享或仍承载业务的数据库。
- 源库与恢复库必须是两个不同、名称明确包含隔离语义的数据库：源库名必须含 `ci`、`drill`、`isolated`、`sandbox`、`staging` 或 `test` 之一，恢复库名必须含 `drill`、`g5`、`restore` 或 `test` 之一。精确名称 `postgres`、`template0`、`template1`、`workbench`，以及下划线分词恰为 `live`、`main`、`primary`、`prod` 或 `production` 的名称都会被拒绝。
- 恢复库必须事先不存在。工具只创建并最终删除本次明确确认的恢复库，绝不重置或覆盖已有数据库。
- 源库 URL 与管理 URL 必须指向同一 PostgreSQL 主机和端口；源库 URL 的数据库名必须等于 `--source-database`，并且必须设置 `schema=workbench`。管理 URL 可以连接维护库，但不得连接 `--restore-database`。
- 默认是计划模式，不连接数据库、不执行 `pg_dump`、`pg_restore`、`psql` 或迁移，也不创建、修改或删除任何数据。
- 真正执行必须显式增加 `--execute`，并提供绑定候选、环境、源库和恢复库的精确确认串。
- 执行时 `--repo` 必须是 Git 顶层目录，仓库必须干净（包括未跟踪文件），当前 `HEAD` 必须等于 `--source-commit`；工具会验证 annotated tag 的签名，并要求该 tag peel 到同一提交。任何不一致都 fail closed。
- 数据库 URL、用户名、密码和其他凭证只能由受控 secret 注入提供。不要把它们写入命令参数、终端记录、runbook、receipt 或仓库文件。

不要把本工具作为生产恢复工具直接运行。生产事故恢复需要另行批准的事故流程、目标确认、变更窗口和数据 Owner 授权。

## 前置条件

1. 使用冻结、干净、可复现的候选 checkout；准备形如 `sha256:<64 位小写十六进制>` 的 candidate ID、40 或 64 位小写源 commit、签名 tag 和 environment ID。
2. Data Owner 已书面确认源库是隔离/测试目标、恢复库名获准用于 create/drop，并批准 RPO/RTO 阈值。
3. 本机可运行与目标 PostgreSQL 主版本兼容的 `pg_dump`、`pg_restore`、`psql`、Node.js 和 npm。
4. 源凭证能读取应用 schema、数据和 `_prisma_migrations`；管理凭证只能通过 secret 注入，并具备创建、连接、终止连接和删除本次恢复库所需的权限。
5. 源库在 manifest 采样和 dump 窗口内无写入；执行机与 PostgreSQL 时钟已通过批准的时间源同步。否则停止演练，不能把数据漂移或时钟漂移解释为恢复结果。
6. 证据输出位于仓库外的受控目录；目标 receipt 及其 `.sha256` sidecar 均不能预先存在。
7. `packages/workbench-db/prisma/migrations/` 的迁移数和 `--expected-migration-count` 已由候选审阅者确认。本候选示例为 `66`，候选变化后必须重新计算，不能机械沿用。

三个 secret-bearing 环境变量为：

| 变量 | 用途 |
| --- | --- |
| `WORKBENCH_G5_SOURCE_DATABASE_URL` | 只读备份和源库核验连接 |
| `WORKBENCH_G5_ADMIN_DATABASE_URL` | 创建、检查和删除恢复库的管理连接 |
| `WORKBENCH_G5_DRILL_CONFIRM` | 执行时使用的精确确认串；从计划结果逐字取得 |

不要在 `export` 命令、shell history 或终端输出中直接展开连接 URL。应由批准的 secret manager、临时凭证文件描述符或 CI masked secret 注入，并在演练结束后撤销短期凭证。

## 先生成计划

以下示例中的名称、哈希和 ID 都是占位值，必须替换为本次获批值。计划模式不需要数据库凭证；`--output` 的父目录必须已存在，且 receipt 与 `.sha256` 文件均不存在：

```sh
node scripts/workbench-postgres-recovery-drill.mjs \
  --repo . \
  --candidate-id sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  --source-commit 0000000000000000000000000000000000000000 \
  --signed-tag workbench-rc-20260720-01 \
  --environment-id recovery-lab-cn-hz-01 \
  --environment-kind isolated \
  --source-database workbench_g5_source_test \
  --restore-database workbench_g5_restore_test \
  --confirm-restore-database workbench_g5_restore_test \
  --expected-migration-count 66 \
  --max-rpo-seconds 60 \
  --max-rto-seconds 900 \
  --output /approved/evidence/g5-recovery-20260720-01/g5-recovery.json
```

审阅计划输出中的候选、环境、数据库名称、迁移数、阈值、输出路径和 `requiredConfirmation`。确认串格式为 `G5-RECOVERY-DRILL:<candidateId>:<environmentId>:<sourceDatabase>-><restoreDatabase>`，必须从计划输出逐字复制；任何字段不正确都应停止，不得靠放宽命名或跳过校验继续。

`--confirm-restore-database` 必须逐字等于 `--restore-database`；RPO/RTO 阈值必须大于 `0` 且不超过 `86400` 秒；输出必须是仓库外既有目录下的安全 `.json` 文件名。

## 执行演练

在另一个受控会话中注入三个环境变量，将计划输出的 `requiredConfirmation` 原样设置为 `WORKBENCH_G5_DRILL_CONFIRM`，然后对完全相同的参数增加 `--execute`：

```sh
node scripts/workbench-postgres-recovery-drill.mjs \
  --execute \
  --repo . \
  --candidate-id sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  --source-commit 0000000000000000000000000000000000000000 \
  --signed-tag workbench-rc-20260720-01 \
  --environment-id recovery-lab-cn-hz-01 \
  --environment-kind isolated \
  --source-database workbench_g5_source_test \
  --restore-database workbench_g5_restore_test \
  --confirm-restore-database workbench_g5_restore_test \
  --expected-migration-count 66 \
  --max-rpo-seconds 60 \
  --max-rto-seconds 900 \
  --output /approved/evidence/g5-recovery-20260720-01/g5-recovery.json
```

执行过程固定为：

1. 复核参数、URL 主机/端口/库名/schema、精确确认串、clean commit、签名 tag、迁移目录和恢复库不存在。
2. 从源库读取已成功且未回滚的 Prisma migration 清单，与候选名称、checksum、数量及集合摘要比较。
3. 使用数据库时钟捕获恢复点，并生成逐表行数及非明文内容指纹的数据 manifest。
4. 以 custom format、`--no-owner`、`--no-privileges`、serializable-deferrable snapshot 和 lock-wait timeout 创建临时 archive，记录 archive SHA-256、字节数和 `pg_restore --list` 的 SHA-256。
5. 在创建恢复库前重新计算 archive SHA-256 和字节数；任一变化都以 `ARCHIVE_CHECKSUM_MISMATCH` 失败，并且不得创建恢复库。通过后记录 `archive.verifiedBeforeRestore=true`，再以 `pg_restore --single-transaction --exit-on-error` 恢复。
6. 对恢复库执行候选的 `prisma migrate deploy`，验证候选迁移可作为前向修复安全执行。
7. 比较源库与恢复库的 migration manifest 和 data manifest，计算实际 RPO/RTO，并强制执行批准阈值。
8. 在 `finally` 中终止恢复库连接、删除恢复库和临时 archive；清理失败会把演练结果改为 FAIL。
9. 以 exclusive-create 方式写入规范化 receipt，并在旁边写入 `.sha256` sidecar；已有输出不会被覆盖。receipt 外层为 `schemaVersion`、`payload`、`payloadSha256`，sidecar 哈希的是完整 receipt 字节。

不要在步骤间手工修改源库、恢复库、archive 或 receipt。需要重跑时使用新的恢复库名和新的空输出路径；执行阶段若已生成失败 receipt，应保留其审计记录。

## PASS 与证据

只有以下条件全部成立，receipt 才能为 `PASS`：

- 候选、tag、环境和数据库绑定全部一致；
- 源库 migration manifest 与候选完全一致；
- archive 是非空普通文件，archive SHA-256 与非空 TOC SHA-256 已采集，恢复前二次 checksum 校验通过（`archive.verifiedBeforeRestore=true`），且恢复成功；
- 前向迁移执行成功，恢复后的 migration/data manifest 与源库一致；
- 实测 RPO 和 RTO 均不超过命令中批准的阈值；
- 恢复库和临时 archive 已成功清理；
- receipt 的 canonical payload seal 与 `.sha256` sidecar 可重新验证。

receipt 必须符合 `workbench.postgres-recovery-drill-receipt.v1`：外层 `schemaVersion`、`payload`、`payloadSha256`，其中 `payload` 记录候选/环境绑定（含 source commit、signed tag、tag object 和 tag payload 摘要）、数据库名称、工具版本、迁移数量与摘要、数据 manifest 摘要、archive 摘要与大小、`verifiedBeforeRestore` 标志、UTC 时间、RPO/RTO、前向修复、清理结果、最终状态及 `failure` 对象。它不得包含连接 URL、主机凭证、用户名、密码、SQL 明文数据或可能携带凭证的原始命令输出；命令 stdout/stderr 只保存摘要哈希。

将 receipt 和 sidecar 存入批准的不可变证据仓储，并以内容寻址或版本固定 URI 接入证据账本。只有绑定同一候选和目标环境、由批准执行者独立采集的证据，才可按治理流程评定为 E1；合同测试或本地临时 PostgreSQL 结果不能代替目标环境 G5 验收。

本演练验证的是一次 PostgreSQL logical dump/restore。它不证明 WAL 归档、PITR、跨区副本、异地保留期限或定时备份调度有效；这些能力若属于批准的生产恢复目标，必须另行执行并绑定证据。

## 失败、故障码与清理

任一错误都返回非零状态。演练阶段的稳定码位于 `receipt.payload.failure.code`，CLI 摘要中对应 `failureCode`；计划/执行前置失败可能只有脱敏 stderr（`[g5-recovery] CODE`）而没有 receipt。故障类别包括输入/确认失败、候选或环境绑定失败、源库安全检查失败、迁移不一致、archive 或 restore 失败、前向迁移失败、数据不一致、RPO/RTO 超限、证据封印失败和清理失败。

| 阶段 | 实际故障码示例 |
| --- | --- |
| 参数与执行确认 | `CANDIDATE_ID_INVALID`、`RESTORE_DATABASE_CONFIRMATION_INVALID`、`MIGRATION_COUNT_MISMATCH`、`EXECUTION_CONFIRMATION_INVALID`、`OUTPUT_ALREADY_EXISTS` |
| 仓库与 tag 绑定 | `REPOSITORY_NOT_TOP_LEVEL`、`SOURCE_COMMIT_MISMATCH`、`DIRTY_WORKTREE`、`ANNOTATED_TAG_REQUIRED`、`TAG_COMMIT_MISMATCH` |
| 数据库边界 | `SOURCE_DATABASE_URL_MISMATCH`、`SOURCE_SCHEMA_INVALID`、`DATABASE_SERVER_MISMATCH`、`ADMIN_DATABASE_INVALID`、`RESTORE_DATABASE_ALREADY_EXISTS` |
| 备份、恢复与验证 | `SOURCE_MIGRATIONS_MISMATCH`、`SOURCE_CHANGED_DURING_BACKUP`、`ARCHIVE_CHECKSUM_MISMATCH`、`COMMAND_FAILED`、`FORWARD_REPAIR_FAILED`、`RESTORED_MIGRATIONS_MISMATCH`、`RESTORED_DATA_MISMATCH`、`RPO_EXCEEDED`、`RTO_EXCEEDED` |
| 证据与清理 | `RECEIPT_SECRET_DETECTED`、`RECEIPT_DATABASE_URL_DETECTED`、`CLEANUP_FAILED`、`RECOVERY_DRILL_INTERNAL_ERROR` |

receipt 中出现 `COMMAND_FAILED` 时必须结合 `failure.details.commandId` 判断阶段，例如 `archive.create` 或 `archive.restore`；前置阶段的同名错误可能没有 receipt，不得自行推导或改写故障码。

处理原则：

- 参数、绑定、确认或安全检查失败：修正审批或输入后从计划模式重新开始，禁止跳过检查。
- migration/data/archive 不一致：保留失败证据，冻结候选并调查；不能提高阈值或重写 receipt 取得 PASS。
- `RPO_EXCEEDED` / `RTO_EXCEEDED`：记录观测值，修复备份策略或恢复性能后以新目标库重新演练。
- `FORWARD_REPAIR_FAILED`：停止候选发布，修复 migration 后冻结新候选并重做完整演练。
- `CLEANUP_FAILED`：即使数据验证通过也仍是 FAIL。由 Data Owner 使用管理连接核对目标名称、终止其连接并删除该恢复库，同时删除本次临时 archive；保留操作审计，不得删除源库。
- receipt 缺失：先确认恢复库和临时 archive 已清理，再调查工具中断。缺少 receipt 不能解释为 PASS。

任何人工清理都必须再次确认数据库实际报告的名称与批准恢复库完全一致。无法证明目标身份时停止操作并升级给 Data Owner。

## 可选 PostgreSQL 集成测试

默认合同测试不连接数据库：

```sh
node --test scripts/workbench-postgres-recovery-drill.test.mjs
```

真实 PostgreSQL 集成测试默认跳过。只有显式提供专用的 `WORKBENCH_G5_DRILL_TEST_ADMIN_URL` 时才运行：

```sh
node --test scripts/workbench-postgres-recovery-drill.postgres.test.mjs
```

该 URL 必须指向可创建临时数据库的本地或隔离测试实例，绝不能指向已有应用库。测试自行创建随机源库和恢复库、应用当前迁移、插入最小持久数据、执行真实 dump/restore/前向迁移与一致性校验，并在 `finally` 中删除两库和 archive。测试被 skip、清理失败或仅通过合同测试，都不能算作 G5 PASS。
