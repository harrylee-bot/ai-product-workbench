# Workbench Runtime Provider State 运维

本 runbook 定义 Provider State、Runtime liveness、Knowledge 工具可见性和队列执行的运维步骤。

## 执行顺序

1. 应用数据库迁移并检查 schema、projection version、索引和约束。
2. 使用 migrator 按 attempt 执行有界 backfill，验证覆盖率、sequence、hash 和 finalization。
3. 以 verify-only 模式检查 projection 与 append-only event 的一致性。
4. 启动 canary Worker，确认 provider-state、liveness、queue lease 和 Knowledge visibility 指标正常。
5. 切换到 projection-required，继续观察 transaction timeout、projection lag、terminal drift 和 lease takeover。
6. 将同一 source commit、镜像 digest 和配置推广到全部 Worker。

执行命令：

```sh
node scripts/workbench-runtime-provider-state-rollout.mjs \
  --phase shadow \
  --candidate-sha "$WORKBENCH_SOURCE_COMMIT" \
  --environment-id "$WORKBENCH_ENVIRONMENT_ID" \
  --environment-kind staging \
  --observation /restricted/evidence/runtime-shadow.json \
  --receipts-dir /restricted/receipts/runtime-provider-state
```

证据文件只记录候选、镜像 digest、环境、稳定错误码、操作、计数和时间，不记录数据库 URL、token、prompt、provider text、payload、外部 ID、Run ID、attempt ID 或 principal ID。

## Provider State P2028

停止受影响的 Worker cohort，检查 projection lag、数据库负载、lease 和 transaction duration。不要只增加 timeout。修复 projection 或数据库瓶颈后，以 verify-only 模式重新检查，再恢复队列。

## Projection Invariant

缺失、版本不匹配、hash 不匹配、sequence gap、draft 冲突或 CAS 错误都必须 fail closed。保留事件和 projection 行，定位最后一个有效 sequence，通过 migrator 修复并重新执行完整校验。

## Projection Lag

确认 projection sequence 与 attempt event sequence，检查 lease owner、数据库连接池和 Worker heartbeat。持续 lag 阻止推广；修复后必须重新验证覆盖率和事件一致性。

## Backfill Conflict

发现 pending event、sequence gap、payload hash mismatch、draft conflict、无效 finalization 或未知 projection version 时停止当前 attempt，不跳过记录。修复数据或 projection 后从受控 checkpoint 继续。

## Wall Clock

提交、流式 idle 或 wall-clock timeout 时，确认 provider I/O 已 abort、queue job 已 terminalize、lease 已释放或 fencing、Run 已收敛。`runtime.execute` 的 900 秒边界由 queue、provider、heartbeat、abort signal 和 reconciler 共同执行。

## Terminal Run Drift

当 job 已 terminal 但 Run 仍 active 时，停止新提交，检查 execution reconciler、lease 和 Run 状态，在同一事务中收敛状态后再恢复。

## Lease Takeover

少量 takeover 表示恢复路径正常；连续增长表示 Worker 退出、heartbeat 延迟或数据库争用。检查 lease、heartbeat、SIGTERM/SIGKILL 和 fencing，确认过期 owner 不能继续写入。

## Knowledge Visibility

未授权 Run 不得看到或调用 Knowledge tool。发现 unauthorized execution attempt 时停止受影响 cohort，检查 request-scoped catalog、middleware、release pin 和 capability 签发边界。仅返回 missing capability 错误不满足可见性要求。

## 观测与回滚

告警覆盖 provider-state failure、projection lag、transaction timeout、liveness、execution timeout、terminal drift、lease takeover 和 Knowledge visibility。Schema、事件和 projection 不通过回退删除；优先停止队列、修复 projection、重新验证并发布新候选。
