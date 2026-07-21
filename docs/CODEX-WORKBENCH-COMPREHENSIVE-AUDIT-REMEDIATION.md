# Codex Workbench 全面审查、整改与生产验收规范

> **用途**：交给 Codex 逐项修复、补测、留证并申请重新验收。
> **仓库**：`/Users/liyannong/ai-product-workbench`
> **审查性质**：只读审查结论与后续施工规范；本文的创建不代表修改产品代码、配置或环境。
> **当前发布判定**：**REJECT（阶段 12 未通过）**
> **文档日期**：2026-07-22（整改复核）
> **禁止操作**：未经用户明确确认，不得 commit、push、deploy、发布、外发真实数据或执行不可逆数据清理。

---

## 1. 执行摘要

当前仓库记录显示本地阶段 0–11 和服务器 hard-cut 曾执行过大量实现与验证，但这不等于生产验收完成。当前正式结论为：

1. **阶段 12 仍为 REJECT**。真实 provider 的短链路 smoke 已在授权验证服务器通过，但 Production security acceptance、provider 长时序、可复现 clean candidate、不可变镜像与完整 hard-cut 证据均未闭环。
2. 当前实现仍位于 HEAD `70c002238dd0909b9ddeeed4f23c5d6b512417b1` 之上的 dirty/untracked working tree。在冻结干净、可复现、不可变候选之前，当前 PASS 只能作为本地整改证据，不能作为生产验收事实。
3. 2026-07-20 复核已在 dirty tree 上取得 OpenAPI、Web、浏览器、架构、部署合同、隔离 PostgreSQL、root `npm run typecheck` 和 root `npm run test` 的本地 PASS；D-009/D-020 最新修改已完成定向单测、PostgreSQL 故障注入、类型检查和生产构建。所有本地结果均未绑定 clean commit、签名 tag、不可变镜像或目标生产环境。
4. Run/SSE、Canvas Agent、Prototype Patch、授权、对象存储、Preview、部署、CI 和 hard-cut 证据链中的多数缺陷已有代码整改；D-009 durable finalization、D-020 ready-object 全消费链、取证留存/GC fencing 与 D-035 Run 级工具可见性/委派边界已完成代码整改和本地验证。授权验证服务器上的真实 provider、Gateway secret-channel、Worker queue 和公网 HTTPS 短链路 smoke 已通过；阿里云私有 OSS、8 个独立 RAM 身份、60/60 IAM 矩阵与公网 multipart 13/13 也已在 dirty-tree validation 上通过。真实 Edge/WireGuard、provider 长时序、同一签名不可变候选上的存储/镜像验证和生产验收仍未执行。
5. 2026-07-21 公网浏览器复核发现并修复登录壳层的 CSP console error：全局 CSS 曾通过 Google Fonts 外部 `@import` 请求样式，违反生产 `style-src`。已移除该外部依赖、补充静态合同测试，并在 validation Web 镜像重建后复核 `aionbench.com/login` 无 console error；该修复仍未绑定 clean candidate。
6. Preview sandbox、ArtifactVersion publication/immutability、Run sequence/identity 基本不变量等专项没有发现确认绕过。修复不得削弱这些已建立的边界。

必须严格区分以下状态：

- `implemented`：代码存在；
- `validated locally`：在本地替身或单机环境运行过；
- `validated on server/staging`：在指定服务器拓扑运行过；
- `cutover performed`：执行过切换动作；
- `production accepted`：同一个不可变候选通过所有生产硬门禁并获得独立批准。

除最后一种外，均不得写成“总体通过”“remediation complete”或“生产已验收”。

---

## 2. 不可破坏的架构边界

Codex 的任何修复都必须保留：

- `workbench.run.v1` 的严格 sequence continuity、run/request/project/thread identity、SSE replay 和 durable event semantics；
- immutable Artifact、ArtifactVersion、Release、Share、Export 及其 transaction/constraint 边界；
- SHA-256 canonical checksum、revision/ETag/CAS、idempotency key 和 source-event dedup；
- Canvas Agent 只能通过受控 command gateway 修改客户端状态；Agent 不得直接写数据库；
- Prototype Patch 使用稳定 typed node ID，不能退化为对主应用 DOM 执行任意 CSS selector patch；
- Preview 必须维持独立 origin、credentialless iframe、无 `allow-same-origin`、`no-referrer`、capability URL 验证、Penpal RPC、timeout 和 generation protection；
- tenant isolation、authorization、prompt-injection 防护、request-scoped secret、网络边界和日志脱敏；
- 外部 publication/export 仍需显式用户确认；
- immutable Artifact checkpoint 仍是恢复与发布的 source of truth；
- 不得复制或暴露 Google Stitch 私有 RPC ID、cookies、tokens、OAuth 凭证或私有 Session 协议。

不得通过放宽权限、跳过负向测试、替换真实 provider 为 fake provider、修改 baseline、删除失败证据、把 NOT RUN 写成 PASS，或保留兼容性后门来“通过”验收。

---

## 3. 基线冻结与证据规则

### 3.1 R0 必须记录的候选基线

在修复任何后续缺陷前，建立单一 release candidate manifest，至少记录：

- commit SHA、branch、签名 tag；
- `git status --porcelain=v1 --untracked-files=all`；
- tracked、untracked、ignored 文件清单；
- lockfile、生成合同、迁移、CI、部署文件、hard-cut deletion 清单的 SHA-256；
- Web、API、migrator、runtime、file/import/export worker、Preview、Quartz、Figma（若适用）镜像 digest；
- DeerFlow source commit、image digest、overlay/config digest；
- 数据库迁移集合、PostgreSQL/pgvector 版本；
- 目标环境 ID、deploy ID、配置 revision；
- 审计开始/结束 UTC 时间、执行者和验证人；
- 纳入和排除范围。

所有运行关键源代码、迁移、生成合同、lockfile、CI、部署脚本和 hard-cut 删除必须进入版本控制。不得让关键资产只存在于 untracked、gitignored、`output/`、`/opt`、可变 URL 或单台机器状态中。

### 3.2 证据等级

- **E1**：审计者在目标环境独立采集的原始、不可变证据；
- **E2**：绑定同一候选的可重复 CI/自动化产物；
- **E3**：实施状态文档、人工声明、截图或服务器回执；
- **E4**：simulator、fake provider、本地替身或合同级测试。

生产硬门禁只接受 E1/E2。E3/E4 可支持线索或合同结论，但不能替代真实外发、双 origin、运行时生效、真实 identity/storage/scanner/provider 或灾难恢复验证。

### 3.3 状态词

**发现状态**：

- `CONFIRMED`：机制与触发条件已确认；
- `PLAUSIBLE`：机制合理但目标环境触发或产品政策仍待证；
- `REFUTED`：候选与当前冻结基线事实不符。

**执行状态**：

- `PASS`：预期阈值满足且证据有效；
- `FAIL`：控制实际不满足；
- `NOT RUN`：尚未执行；
- `BLOCKED`：前置依赖未满足；
- `INCONCLUSIVE`：已尝试但证据不足，无法得出差异或通过结论；
- `N/A`：必须记录范围依据、批准人和到期日。

生产硬门禁中的 `FAIL`、`NOT RUN`、`BLOCKED`、`INCONCLUSIVE` 均阻断发布。Waiver 只能改变发布决策，不能把验证事实改写为 PASS。

---

## 4. Confirmed defects

下面条目已按根因去重。每条完成时，Codex 必须补充：Owner、验证人、实际 commit、测试证据 URI、SHA-256、完成日期和残余风险。

### D-001 — Canvas capability 请求缺少生产 nginx 精确路由

- **状态/严重度**：REMEDIATED IN CODE / CRITICAL / release-blocking；目标 nginx/Edge E1 仍 NOT RUN
- **位置**：`deploy/workbench-nginx.conf`
- **触发**：DeerFlow/Runtime 以 server-to-server bearer capability 调用 Canvas tool execution endpoint。
- **影响**：请求落入 Next BFF 浏览器代理边界；Authorization 不能按 Canvas capability contract 到达 API，真实 Canvas Agent execution 失败或走错授权模型。
- **修复**：production nginx 已为 Canvas tool execution/visual 建立 exact path 与 method route，直接到 Workbench API；删除外部转入的 authorization/forwarded headers 后只重建该 server capability 所需 header，普通浏览器 API 继续走 BFF/session 边界。
- **测试**：Edge/auth proxy/origin 22/22 PASS，静态合同覆盖 exact POST、错误 method/path、通用 bearer 不透传、Web/Preview 边界和源站鉴权；Canvas capability 的缺失/过期/错 scope/replay/跨项目由 API/Canvas tests fail closed。
- **退出条件**：仓库路由合同已满足；仍须目标 nginx/Edge E1 trace 证明实际配置命中精确 route 且所有负向请求 fail closed。

### D-002 — Canvas 撤权与 command issuance/list 存在竞态

- **状态/严重度**：REMEDIATED IN CODE / CRITICAL / release-blocking；冻结候选 E2 仍待 R0
- **位置**：`apps/workbench-api/src/modules/canvas-agent/canvas-agent.service.ts`
- **触发**：授权检查后、命令创建或命令列表查询前发生成员撤权、session revoke 或 scope 变化。
- **影响**：已撤权主体仍可能签发或读到命令；授权时点与数据库效果不原子。
- **修复**：issuance 在同一事务重锁 membership、principal/project、session、grant、Run 和 Board 后以受影响行数提交；list 使用同一 live authorization snapshot 与数据库锁。grant/session revoke 与 command reserve/issue/list 使用一致锁顺序，撤权 linearization point 后不可再创建或读取命令。
- **测试**：Canvas API unit 2 files / 45 PASS；真实 PostgreSQL concurrency 12/12 PASS，覆盖 revoke→reserve、reserve→revoke→issue、revoke→list、角色/成员/session/grant 失效和 ACK 双向竞态。
- **退出条件**：本地确定性并发退出条件已满足；冻结候选仍须重新采集 E2。

### D-003 — Canvas ACK result 未绑定已同步客户端状态

- **状态/严重度**：REMEDIATED IN CODE / HIGH / release-blocking；冻结候选 E2 仍待 R0
- **位置**：`apps/workbench-api/src/modules/canvas-agent/canvas-agent.service.ts`，`resultFromAck(...)` 及 ACK 路径
- **触发**：客户端提交 schema 合法、revision 数值匹配但内容与最近 synchronized Canvas state 不一致的 ACK result。
- **影响**：服务端把未由已知 Canvas 状态证明的结果标记为 succeeded；模型和审计账本可接收伪造或陈旧结果。
- **修复**：ACK 在同一事务锁 membership/session/grant/command/invocation，绑定 command、tool call、session、Board/Canvas revision、预期 state digest；服务端重新投影 canonical Canvas state，并从同步后 selection/viewport/screen/result invariant 核验 mutation 结果和摘要。
- **测试**：Canvas API 45 PASS 与 PostgreSQL 12/12 PASS，覆盖同 revision 不同 state、sync/ACK 锁竞争、错 selection/viewport/screen、replay/cross-command 和伪造 result。
- **退出条件**：本地只有最新同步状态及原 command scope 可 ACK；冻结候选 E2 仍待 R0。

### D-004 — Canvas session、grant 与 invocation 到期后不能可靠收敛

- **状态/严重度**：REMEDIATED IN CODE / HIGH / release-blocking；目标收敛 SLO E1 仍 NOT RUN
- **位置**：`apps/workbench-api/src/modules/canvas-agent/canvas-agent-expiry-reconciler.ts`；相关 DB lifecycle
- **触发**：pending invocation 在 session/grant/lease 自然过期，且没有后续请求触发清理。
- **影响**：调用永久 pending；等待方、模型状态和审计状态不一致；可能保留已失效命令。
- **修复**：API 启动即运行并按固定周期执行 durable reconciler；使用数据库时钟、`FOR UPDATE SKIP LOCKED` 与条件更新原子收敛 session、command、invocation lease 和短期 visual。重复/多副本执行幂等，late ACK fail closed，storage 删除失败保留 durable retry work。
- **测试**：API 45 PASS、PostgreSQL 12/12 PASS，覆盖时钟边界、重叠 reconciler、late ACK、revoke/ACK 双向竞态、visual storage outage/retry 与唯一 terminal 状态。
- **退出条件**：本地 durable 收敛机制已满足；目标负载下在配置 SLO 内收敛仍须 E1。

### D-005 — Canvas grant replay 未绑定完整 snapshot

- **状态/严重度**：REMEDIATED IN CODE / HIGH / release-blocking；冻结候选 E2 仍待 R0
- **位置**：`packages/workbench-canvas-tools/src/index.ts`；`apps/workbench-worker/src/runtime/canvas-tool-grant.service.ts`；`apps/workbench-api/src/modules/canvas-agent/canvas-agent.service.ts`
- **触发**：复用 session/grant 时 stable IDs 和 declaration 相同，但 board/canvas revision、viewport、selected/visible IDs 或 snapshot 内容已变化。
- **影响**：旧 grant 可被用于不同 Canvas state，突破按快照授权和最小权限假设。
- **修复**：签名 grant payload 现在包含 canonical snapshot digest、Board/Canvas revision、viewport/selected/visible IDs 的 canonical digest、profile 和 tool declaration digest。Worker 首次签发与 replay 都重建并核验完整 payload hash；API 在工具调用和 visual read 前逐字段与当前 session 对照，任一状态漂移立即 401。
- **测试**：Canvas capability 11/11、API Canvas service 36/36、Worker Canvas grant 24/24、Canvas PostgreSQL concurrency 12/12 和 Worker grant PostgreSQL 2/2 PASS；新增真实 DB 用例证明浏览器同步到新 Canvas revision 后旧 token 被拒绝且不创建 invocation。Canvas tools/API/Worker typecheck PASS。
- **退出条件**：本地旧 grant 对任何已同步的不同 canonical snapshot 均不可用；冻结候选 E2 仍待 R0。

### D-006 — Quick Edit 接受向前漂移的 Board revision

- **状态/严重度**：REMEDIATED IN CODE / HIGH / release-blocking；冻结候选 E2 仍待 R0
- **位置**：`apps/workbench-worker/src/runs/run-processor.ts`
- **触发**：实际 `board.revision` 大于授权/publication 的 `boardRevision`。
- **影响**：基于旧快照批准的 quick edit 可应用到新 Board，覆盖并发修改或错位节点。
- **修复**：首次 quick-edit publication 强制当前 `board.revision === authorized boardRevision`，随后以同 revision CAS 更新；不存在隐式 merge 或只拒绝 backward revision 的分支。
- **测试**：RunProcessor PostgreSQL 13/13 PASS，显式覆盖 revision 小于、等于、大于、并发 Board advance、retry 与相同 source event replay。
- **退出条件**：本地仅 exact revision 可执行；冻结候选 E2 仍待 R0。

### D-007 — Running Run 没有 durable worker execution claim

- **状态/严重度**：REMEDIATED IN CODE / CRITICAL / release-blocking；真实进程故障 E2/E1 仍 NOT RUN
- **位置**：`apps/workbench-worker/src/runs/run-processor.ts` 及 Run/Attempt DB lifecycle
- **触发**：worker 在 Run 标为 running 后崩溃、网络分区或队列重复投递。
- **影响**：Run 可永久 running，或多个 worker 同时执行同一外部副作用。
- **修复**：Run/RuntimeAttempt 双行保存 owner、epoch、heartbeat、expiresAt；claim 与 takeover 使用数据库时间和 fencing，所有 effect/checkpoint/publication 重新验证 epoch。heartbeat 失败主动 abort，独立 reconciler 只回收 expired/unowned execution，重复 queue delivery 不能越过有效 claim。
- **测试**：Worker 聚焦 4 files / 176 PASS、RunProcessor PostgreSQL 13/13、RuntimeAttempt PostgreSQL 7/7，覆盖双 claim、heartbeat/takeover、旧 epoch fencing、重复 delivery 与多处事务 crash rollback。
- **退出条件**：机制上只允许一个有效 epoch；仍缺冻结候选上的真实进程 kill、heartbeat 网络分区及批准恢复 SLO E2/E1。

### D-008 — 外部 DeerFlow Run 提交存在 ambiguous-accept 重复创建窗口

- **状态/严重度**：REMEDIATED IN CODE / CRITICAL / release-blocking；真实 immutable provider E1/E2 仍 NOT RUN
- **位置**：`apps/workbench-worker/src/runtime/deerflow-runtime.adapter.ts`
- **触发**：外部 POST 已被 provider 接受，但响应在 `attachExternalRun` 持久化前丢失；本地 retry 再次 POST。
- **影响**：一个 Workbench Run 创建多个外部 Run，重复推理、计费和副作用。
- **修复**：提交前先持久化稳定 provider idempotency key 与 `submitting` intent；adapter POST 携带稳定键，断连/5xx/timeout 后先按 metadata lookup reconcile。`submitting/submission_unknown` retry 禁止再次 POST；无法证明 acceptance 时进入 durable UNKNOWN 并释放 claim，后续只 lookup/人工对账。
- **测试**：Worker 176 PASS、RuntimeAttempt PostgreSQL 7/7，覆盖接受后断连、UNKNOWN recovery、crash-before-attach、lookup 暂不可见、并发 retry 和不重复 POST。
- **退出条件**：本地保守 UNKNOWN 协议已满足；固定 DeerFlow/provider 是否真实支持相同 idempotency/lookup 语义及各网络故障点仍须 E1/E2。

### D-009 — 外部 SSE effect 与 checkpoint 分离会重复事件

- **状态/严重度**：REMEDIATED IN CODE / HIGH / release-blocking；冻结候选与真实 provider 证据仍 NOT RUN
- **位置**：`apps/workbench-worker/src/runtime/deerflow-runtime.adapter.ts`
- **触发**：RunEvent/effect 持久化成功后、external cursor/checkpoint 更新前崩溃。
- **影响**：重连 replay 同一 external part，生成重复内部事件或副作用。
- **修复**：external event identity、internal event append 和 cursor checkpoint 已进入同一事务/幂等 inbox；外部 finalization 使用保留事件类型，在同一事务提交可见文本、领域 effects、activity terminalization 和 inbox processed 状态。恢复 join 从数据库锁定行读取并传递 `last_external_event_id`，provider 重连携带 `Last-Event-ID`；提交响应丢失时 exact replay 返回已提交结果，不重复内部事件或副作用。
- **测试**：Worker 全量 13 files / 218 PASS；`run-processor.postgres.spec.ts` 13/13 PASS，覆盖 finalization commit-response loss 后重放；`runtime-attempt.postgres.spec.ts` 7/7 PASS，覆盖 inbox、cursor、claim fencing 和提交恢复。首次在受限执行环境运行 PostgreSQL 文件时 13/13 因本机 TCP 被沙箱阻断而失败，随后在同一隔离数据库的获准本机连接中完整重跑通过；该失败未计为 PASS。
- **退出条件**：本地 crash/replay 机制已满足；仍须由冻结候选在真实 immutable DeerFlow/provider 上采集 E1/E2，证明所有实际 provider 事件形态和断线点均保持同一结果。

### D-010 — assistant text overlap 去重会丢合法重复文本

- **状态/严重度**：REMEDIATED IN CODE / HIGH；冻结候选 E2 仍待 R0
- **位置**：`apps/workbench-worker/src/runtime/runtime-assistant-text.ts`；`apps/workbench-worker/src/runtime/deerflow-runtime.adapter.ts`
- **触发**：模型合法连续输出重复短语，文本内容与此前 suffix/prefix 重叠。
- **影响**：最终 assistant 文本被静默截断或改变语义。
- **修复**：`messages/messages-tuple` 明确建模为独立 delta 并原样保留重复内容，`values` 明确建模为 cumulative 且只接受严格 prefix progression；外部 event ID、sequence、payload hash 和 durable text checkpoint 负责 replay，不再以文本 overlap 猜测重复。
- **测试**：Worker 聚焦 3 files / 67 PASS，覆盖 `ha`+`ha`、重复代码块、cumulative conflict、持久 checkpoint、截断 replay fail-closed 和断线恢复。
- **退出条件**：本地合法重复内容与 replay 边界已满足；冻结候选仍须对固定 DeerFlow stream-mode fixture 重跑 E2。

### D-011 — Run SSE backpressure 在客户端关闭后可能永久挂起

- **状态/严重度**：REMEDIATED IN CODE / HIGH / release-blocking；目标代理断连 E1 仍 NOT RUN
- **位置**：`apps/workbench-api/src/modules/runs/runs.controller.ts`
- **触发**：`response.write()` 返回 false，服务端仅等待 `drain`；暂停读取的客户端随后断开。
- **影响**：`drain` 可能永不触发，handler/订阅/资源泄漏。真实 Node 复现已观察到 request/response close 而 Promise 未 resolve。
- **修复**：`writeSseChunk` 在 backpressure 时同时等待 `drain`、response close/error、socket close/error 和 AbortSignal；单一 settle 路径移除全部 listener，连接关闭后 handler 退出并释放订阅。
- **测试**：API 聚焦 5 files / 55 PASS；真实本机 Node HTTP 用 8 MiB SSE 事件触发 backpressure，客户端 pause 后 destroy，2 秒内 handler 退出；response/socket close/error、abort 与正常 drain 均验证 listener 清零。首次受限执行因禁止本机 listen 失败，获准环境重跑通过，前者不计 PASS。
- **退出条件**：本地真实 socket 所有断开路径已满足；仍须在目标 Edge/Origin 代理 timeout/RST 下采集 E1。

### D-012 — Run SSE 使用错误 lifecycle 信号判断 disconnect

- **状态/严重度**：REMEDIATED IN CODE / HIGH；目标代理 E1 仍 NOT RUN
- **位置**：`apps/workbench-api/src/modules/runs/runs.controller.ts`
- **触发**：request body 已完成或 request `close` 语义与 response/socket 生命周期不同。
- **影响**：可能过早停止或未检测真实客户端断开。
- **修复**：SSE 只以 request `aborted`、response close/error 和 socket close/error 形成单一 AbortSignal；明确忽略表示入站请求完成的 request `close` 与 socket half-close，并在终态统一 cleanup。
- **测试**：同一 API 55/55 聚焦矩阵覆盖正常 drain、request close、half-close、request aborted、response/socket close/error 和真实客户端断连。
- **退出条件**：本地 outbound lifecycle 已满足；目标 Caddy/WireGuard keep-alive 与断连仍待 E1。

### D-013 — 冲突 SSE cursors 使用 `Math.max` 会跳过历史

- **状态/严重度**：REMEDIATED IN CODE / HIGH / release-blocking；冻结候选 E2 仍待 R0
- **位置**：`apps/workbench-api/src/modules/runs/runs.controller.ts`
- **触发**：query `afterSequence=0` 与 `Last-Event-ID=100` 同时存在，而客户端本地 reducer 期待 sequence 1。
- **影响**：服务端从 101 开始，客户端永久 sequence gap。
- **修复**：只提供一个 cursor 时使用该值；query 与 `Last-Event-ID` 同时存在时必须完全相等，否则稳定返回 400。负数、小数、指数、带符号/空白/前导零和超出 safe integer 均在查询前拒绝。
- **测试**：API 55/55 聚焦矩阵覆盖 header-only、query-only、相同、冲突和全部非法边界；PostgreSQL HTTP E2E 继续覆盖 replay 起点。
- **退出条件**：本地单一 cursor 协商已满足；冻结候选仍须重新采集 E2。

### D-014 — 非空 Canvas snapshot 的 Run retry 被数据库 trigger 拒绝

- **状态/严重度**：REMEDIATED IN CODE / HIGH / release-blocking；冻结候选 E2 仍待 R0
- **位置**：`apps/workbench-api/src/modules/runs/runs.service.ts`；`packages/workbench-db/prisma/schema.prisma` 或对应 migration trigger
- **触发**：失败 Run 的 request 含非 null `canvasSnapshot`，retry service 将其归一为 null，而 DB 要求 retry request 与 source request 相等。
- **影响**：PostgreSQL 抛 `RUN_RETRY_SOURCE_INVALID`，合法 retry 失败。
- **修复**：retry 重新解析并完整重放 source Run 的 immutable canonical request，包括非空 Canvas snapshot；source snapshots 从原 Run 复制，应用 request/hash 与数据库 retry trigger 使用同一事实，不再把 snapshot 清空。
- **测试**：API unit 聚焦 55/55；`run-retry.postgres.spec.ts` 与 preference 联合 3/3 PASS，覆盖非空 snapshot 合法 retry、篡改 request/retry lineage 被 `RUN_RETRY_SOURCE_INVALID` 拒绝。
- **退出条件**：本地应用与 DB invariant 已一致；冻结候选 E2 仍待 R0。

### D-015 — Prototype Patch exact replay 在 lifecycle 变化后不幂等

- **状态/严重度**：REMEDIATED IN CODE / HIGH / release-blocking；冻结候选 E2 仍待 R0
- **位置**：`apps/workbench-worker/src/runs/prototype-patch.service.ts`
- **触发**：patch 已提交但 ACK 丢失；随后 Run/Attempt/ArtifactVersion 进入 terminal/ready；同 `(runtimeAttemptId, sourceEventId)` 重放。
- **影响**：本应返回已有 receipt，却先因 lifecycle validation 失败，provider 不能安全重试。
- **修复顺序**：已固定为 parse → request SHA-256 → exact receipt 查询 → run/hash 校验 → replay 返回；只有 receipt 不存在时才以 transaction advisory lock 串行相同 identity、二次查 receipt，然后验证 running/staging 生命周期并首次提交。
- **测试**：Worker 聚焦 67/67；`prototype-patch.postgres.spec.ts` 9/9 PASS，覆盖 terminal 后 exact replay、同 key 不同 hash、跨 Run、并发首次 delivery、伪造 application/checkpoint receipt 和数据库 trigger。
- **退出条件**：本地 exact replay 与冲突 fail-closed 已满足；冻结候选 E2 仍待 R0。

### D-016 — Private ArtifactVersion preference 的缓存身份边界不完整

- **状态/严重度**：REMEDIATED IN CODE / HIGH；浏览器真实身份切换 E1 仍 NOT RUN
- **位置**：`apps/workbench-api/src/modules/artifacts/artifact-version-preferences.controller.ts`；`apps/web/lib/workbench/query/keys.ts`
- **触发**：不同 principal 对同一 ArtifactVersion 拥有相同 preference revision；浏览器 session/principal 切换时 query cache 保留。
- **影响**：仅基于 revision 的 ETag 和不含 principal 的 query key 可混淆私有状态，出现错误 304 或跨身份缓存显示。
- **修复**：服务端强 ETag 绑定 principal、artifact、version、screen 和 revision；错误 principal/resource scope 的 `If-Match` 在 service 前返回 412。客户端 query key 与 toggle target 均包含当前 `user.id` principal namespace，私有响应使用 `private, no-cache/no-store`。
- **测试**：API 聚焦 55/55、Web 聚焦 6 files / 32 PASS、PostgreSQL retry/preference 3/3 PASS，覆盖同 revision 不同 principal 的不同 ETag、跨 principal/resource If-Match 拒绝、query key 隔离和 304 identity。
- **退出条件**：代码与本地缓存合同已满足；同浏览器 A→logout→B、BFCache 和真实 session 轮换仍待目标环境 E1。

### D-017 — stale preference GET 可覆盖成功 mutation

- **状态/严重度**：REMEDIATED IN CODE / MEDIUM；冻结候选浏览器回归仍待 R0
- **位置**：`apps/web/lib/workbench/features/artifacts/application/index.ts`
- **触发**：mutation 前已有慢 GET；mutation 成功写入 cache 后，旧 GET 晚到。
- **影响**：UI 回退到旧 preference/revision，下一次 CAS 可能冲突。
- **修复**：mutation `onMutate` 先精确取消该 principal/target query；GET 与 mutation success 都使用 revision-aware merge，旧 revision 不能覆盖新值。每个完整 target key 使用单写队列，CAS 失败后必须 authoritative refresh/rebase；refresh 不可用时阻断后续写。
- **测试**：Web 32/32 聚焦矩阵覆盖 deferred GET、慢响应跨 target 隔离、连续 toggles、CAS failure refresh/rebase、refresh outage、mutation success/error 与 revision merge。
- **退出条件**：本地确定性竞态已满足；冻结候选浏览器 smoke 仍须重跑。

### D-018 — Conditional GET/304 客户端 contract 不完整

- **状态/严重度**：REMEDIATED IN CODE / MEDIUM；冻结候选浏览器回归仍待 R0
- **位置**：`apps/web/lib/workbench/features/artifacts/api-adapter/index.ts`；`apps/web/lib/workbench/features/artifacts/application/index.ts`
- **触发**：服务端返回 304 无 body，而客户端路径按普通 JSON success 处理，或没有可靠复用对应 cached representation。
- **影响**：解析失败、状态丢失或 cache/revision 不一致。
- **修复**：API adapter 显式区分 `modified/not-modified`；304 不解析 body，只有 target identity、scoped ETag 与 cached representation 完全匹配才复用。冷 cache 或响应 ETag 改变时执行一次无条件 GET；无条件请求仍返回 304 则作为合同错误 fail closed。
- **测试**：Web 32/32 聚焦矩阵覆盖 200→304、冷 cache 304、错误 ETag fallback、无 scope/错误 revision ETag 和 target identity；API controller 同时验证 scoped ETag。
- **退出条件**：本地 304 合同已满足；冻结候选经真实 BFF/浏览器的回归仍待 R0。

### D-019 — Production public registration 未默认 fail closed

- **状态/严重度**：REMEDIATED IN CODE / CRITICAL / release-blocking；目标生产身份 E1 仍 NOT RUN
- **位置**：`apps/web/lib/auth/workbench-auth.server.ts`
- **触发**：生产环境 `WORKBENCH_PUBLIC_REGISTRATION_ENABLED` 未设置或为 false。
- **影响**：Better Auth signup 仍可能开放，与部署文档和预期闭源注册策略不一致。
- **修复**：production unset 默认 false；只接受精确字符串 `true/false`，其他值阻断启动。Better Auth `disableSignUp` 使用同一服务端 policy，注册页面和登录页入口由同一构建变量关闭，CI/Compose/image inventory/preflight 绑定同一值；账号密码登录始终保留，企业 SSO 仍是独立可选入口。
- **测试**：Web 32/32 聚焦矩阵覆盖 unset/false/invalid/true、开发默认和登录页入口；本机隔离 PostgreSQL 上 Better Auth direct `/api/auth/sign-up/email` 对 production unset/false 均 400，2/2 PASS，且没有创建用户行。
- **退出条件**：本地服务端直接 endpoint 已 fail closed；目标生产 Better Auth、邀请/账号创建流程与配置 revision 仍须 E1。

### D-020 — Ready object 下载不重新验证实际 bytes SHA-256

- **状态/严重度**：REMEDIATED IN CODE / CRITICAL / release-blocking；真实 OSS/IAM dirty-tree validation PASS，冻结候选 E1/E2 仍 NOT RUN
- **位置**：`packages/workbench-content-security/src/ready-object.ts`；`packages/workbench-content-security/src/ready-object-prisma.ts`；API、Runtime Worker、File Worker、Preview 与 Export Worker 的 ready-object adapters
- **触发**：object store 中对象 bytes 被替换为相同 size/content-type 的内容，metadata 仍保留原 checksum。
- **影响**：损坏或恶意对象以原 immutable checksum/ETag 返回，破坏 Artifact integrity 和审计链。
- **修复**：所有 ready-object 消费者统一先把完整对象安全暂存并计算实际 SHA-256、byte size 和 media type，再向下游暴露 branded verified body；range 只在全对象验证后截取。任何不匹配先在独立数据库事务提交 append-only incident，并原子隔离 Blob/FileAsset/CanvasVisual，持久化失败时同样 fail closed。磁盘 spool 使用匿名 inode 和并发 byte budget；Blob/Canvas GC 保留 advisory lock、owner-row fence、取证 retention release 与重新校验。
- **测试**：共享 content-security 3 files / 7 PASS；API 65 files / 467 PASS、Worker 13 files / 218 PASS、File Worker 13 files / 106 PASS、Preview 7 files / 20 PASS、Export Worker 6 files / 40 PASS（skipped 不计）；D-020 + Canvas PostgreSQL 14/14 PASS。File/Knowledge Worker PostgreSQL 全流程从空 schema 验证 GC 锁、扫描、Docling checkpoint/ambiguous submit、发布恢复、Knowledge 恢复与损坏检测；本轮首先暴露高保真 storage fixture 未实现新 `readReadyObject` 端口，修复为复用共享验证器后从头重跑 PASS。六个受影响 workspace 的 typecheck 和 production build 均 PASS。
- **退出条件**：本地所有已知 byte-level mismatch 均无法到达 provider/parser/browser/export 消费者，durable incident 在拒绝前提交；阿里云私有 OSS 上的角色隔离、create-only 写入和公网 multipart 已通过未绑定候选验证，仍须在同一冻结镜像上完成同 size 篡改、截断、metadata spoof、range 与 GC 竞态 E1/E2。

### D-021 — Preview HEAD/304 请求仍物化近 50 MiB body

- **状态/严重度**：REMEDIATED IN CODE / HIGH / release-blocking；目标容量 E1 仍 NOT RUN
- **位置**：`apps/workbench-preview/src/main.ts`
- **触发**：HEAD 或匹配 `If-None-Match` 请求大 HTML Artifact。
- **影响**：在决定不发送 body 前仍下载、拼接、解码和注入 bridge；并发请求可耗尽 256 MiB container。
- **修复**：Preview 先验证 capability、数据库授权和 ready Blob manifest，并据此计算 representation ETag；匹配 conditional GET 与 HEAD 在调用 storage/render 前返回。GET 才进入共享 full-object checksum verifier、匿名磁盘 spool、streaming bridge injection 与有界并发。
- **测试**：`preview-request.spec.ts` 3/3 PASS，以 50 MiB identity 证明 HEAD 和匹配 304 的 render/object read 为零，changed GET 才 render；Preview 全量 20 PASS 与 D-020 checksum/spool 测试同时通过。
- **退出条件**：本地 HEAD/304 常量 body-memory 且不读对象已满足；目标容器的并发峰值/RSS 与 50 MiB GET 容量仍待 E1。

### D-022 — Clean-host deploy 未启动 DeerFlow production runtime

- **状态/严重度**：REMEDIATED IN CODE / CRITICAL / release-blocking；真实 clean-host G10/G11 仍 NOT RUN
- **位置**：`deploy/server-deploy.sh` 及部署编排文件
- **触发**：在干净主机按正式部署脚本部署。
- **影响**：Workbench 服务启动但真实 Runtime 不存在，Run 无法完整执行；现有服务器状态不可由仓库重建。
- **修复**：`server-deploy.sh` 已统一编排签名 Workbench 与独立 DeerFlow Compose：先校验候选镜像/secret attestation、合并固定 runtime 配置、启动并等待 DeerFlow healthy，再启动 consumers；包含 queue reconciliation、显式 provider egress、stop、clean-host partial rollback 和带上一签名候选的显式 rollback。
- **测试**：DeerFlow/deployment 合同 72/72 PASS，覆盖镜像/source patch pin、secret channel、启动顺序、health、queue、clean-host rollback、目标清单、upload deployment 和 production preflight；新增 target-specific gateway refresh 合同覆盖 `api`、`web`、`knowledge`、`all` 与 `preview`，确认上游更新后使用 `--force-recreate` 刷新对应入口。授权验证服务器另已启动 dirty-tree validation 镜像并完成短链路 smoke，但没有按正式 clean-host 脚本部署签名生产候选。
- **退出条件**：仓库编排缺口已修；仍须在空主机用同一冻结候选和批准 secrets 实际部署、重启/升级/回滚并完成真实 Run E1。

### D-023 — Server-validation Caddy 主域名硬编码

- **状态/严重度**：REMEDIATED IN CODE / HIGH；目标双 HTTPS origin E1 仍 NOT RUN
- **位置**：`deploy/workbench-server-validation.Caddyfile`
- **触发**：`WORKBENCH_WEB_ORIGIN` 不是 `aionbench.com`。
- **影响**：TLS host、route/cookie/origin validation 与配置不一致，部署到其他域名失败或错误验收。
- **修复**：server-validation 与 production Caddy 都只使用已验证的 `WORKBENCH_WEB_HOSTNAME`、`WORKBENCH_PREVIEW_HOSTNAME`、WireGuard IP/port；preflight 从 public origins 生成并交叉校验 host，拒绝 HTTP、端口、同域 Preview、shared cookie domain 和 dormant/漂移 OIDC 配置。
- **测试**：部署合同 72/72 与独立 preflight 43/43 PASS，包含第二套部署域名、非法 origin、主/Preview 同域、issuer drift；静态断言禁止 Caddy 出现 `aionbench.com` 常量。授权验证服务器上的 `aionbench.com` 与独立 Preview hostname 已取得可验证 TLS 路由，公网正/负向短探测通过。
- **退出条件**：仓库配置已无产品域硬编码，服务器 validation 双 HTTPS 路由已通过；生产 Edge/WireGuard、cookie/CORS/CSP 完整负向和配置 revision E1 仍待执行。

### D-024 — README validation Compose profiles 不完整

- **状态/严重度**：REMEDIATED IN CODE / HIGH；fresh-host 文档执行 E1/E2 仍 NOT RUN
- **位置**：`README.md`；`deploy/workbench-compose.yml`
- **触发**：操作者按 README 启动 server-validation。
- **影响**：未启用 `local-object-storage`、`local-docling` 等必要 profile，文档步骤不能重建所宣称拓扑。
- **修复**：README 的 server-validation 命令同时启用 overlay、`local-object-storage` 和 `local-docling`，并明确它们只用于服务器验证、禁止作为 production acceptance；部署合同机器校验 README 与 Compose profile/dependency graph 一致，production preflight 反向拒绝这些 profile。
- **测试**：部署合同 72/72 与 preflight 43/43 PASS，包含 README profile presence、Compose dependencies 和 production rejection。
- **退出条件**：文档/配置合同已一致；仍须在 fresh host 原样执行命令并运行完整 health/smoke E1/E2。

### D-025 — Import Worker 缺失于 production image matrix

- **状态/严重度**：REMEDIATED IN CODE / HIGH / release-blocking；候选 G4 镜像仍 NOT RUN
- **位置**：`.github/workflows/workbench-ci.yml` 及 artifact inventory
- **触发**：生产构建/签名/发布镜像。
- **影响**：`workbench-import-worker` 没有与其他服务一致的 build、SBOM、签名和 digest 证据，Compose 与 CI inventory 不一致。
- **修复**：Import Worker 已进入 CI production image matrix、SPDX SBOM、signed SBOM/build provenance、Trivy blocking scan、Cosign、image record、候选 image manifest、Compose service 与 deployment digest verification；缺失或证据不完整会阻断 inventory。
- **测试**：部署/镜像合同 72/72 与独立 image/preflight 43/43 PASS，覆盖缺 Import Worker、缺 SBOM/attestation/provenance/signature/scan、跨候选 record 和部署 digest 漂移。
- **退出条件**：静态供应链合同已满足；同一冻结候选的十个真实签名镜像、registry digest 和部署实际 digest 尚未由 G4 生成验证。

### D-026 — CI hard-cut gate 未启用 enforce

- **状态/严重度**：REMEDIATED IN CODE / HIGH / release-blocking；生产验收仍 NOT RUN
- **位置**：`.github/workflows/workbench-ci.yml`；`.github/workflows/workbench-production-acceptance.yml`
- **触发**：hard-cut manifest 缺项或残留存在，但 CI 只做非强制检查。
- **影响**：流水线可在证据不完整时绿色通过。
- **修复**：候选 CI 不执行 G12，而是生成 CI-owned、候选绑定的 G0-G2 release-chain artifact，并以 GitHub OIDC + Cosign keyless bundle 签名。独立、受保护的 `workflow_dispatch` 固定 verifier commit，先验证 CI run/head SHA、Cosign identity、重算 G0-G2 chain，再从无凭证、内容寻址 HTTPS 下载 SHA-pinned v2 证据包和仓库外生产 trust policy；最后才在独立 evidence root 调用 `hard-cut manifest --enforce`。缺 receipt、残留、digest mismatch、未批准 productionAcceptance 均失败。
- **测试**：工作流合同确认候选 CI 没有 G12，验收工作流必须受保护、固定 verifier、验证 keyless bundle 并调用 `--enforce`；release-chain/证据包测试覆盖缺审批、跨候选、未来时间、自引用、伪造 authority、错误环境、v1 package/receipt 拒绝和完整 v2 PASS。
- **退出条件**：目标生产环境中使用同一 release-chain 的完整外部证据包，且 `hard-cut --enforce` 实际 PASS；当前仍等待真实 G5-G11、批准与部署执行。

### D-027 — Hard-cut receipts 只验证字符串，不验证证据真实性

- **状态/严重度**：REMEDIATED IN CODE / CRITICAL / release-blocking；生产证据仍 NOT RUN
- **位置**：`scripts/workbench-hard-cut-manifest.mjs`；`scripts/verify-workbench-hard-cut-acceptance.mjs`；`docs/workbench-hard-cut-deletion-manifest.json`
- **触发**：receipt 字段填入不存在路径、可变 URL或任意字符串。
- **影响**：manifest 仍可报告 ready；旧系统物理删除、残留扫描和生产批准可被伪造。
- **修复**：v2 receipt/package schema 验证不可变证据文件、candidate/deploy/environment/release-chain identity、SHA-256、执行时间、执行者、工具版本和结果阈值；Security/Data/Operations/Release 使用 trust policy 中四个独立 Ed25519 authority，policy 本身由外部 HTTPS URI + SHA-256 固定。校验器拒绝 v1 envelope，验证 G5-G11、独立批准、严格时间顺序、自引用和 candidate chain，并把文件物化到独立 evidence root 后再执行 enforce。
- **测试**：不存在路径、错误 hash、错误 commit/digest、过期或伪造签名、未受信 key、authority 复用、另一环境 receipt、残留非零，以及外部包缺审批、future timestamp、自引用、跨候选和 v1 downgrade 均有回归测试。
- **退出条件**：任意伪造/错绑定证据均使 preflight 或 `--enforce` 非零退出；当前生产真实回执尚未执行。

### D-028 — Baseline migration 依赖应用 migrator 安装数据库扩展

- **状态/严重度**：REMEDIATED IN CODE / HIGH / release-blocking；生产 least-privilege upgrade 仍 NOT RUN
- **位置**：`packages/workbench-db/prisma/migrations/20260712090000_initial_workbench/migration.sql` 及后续 extension migration
- **触发**：production migrator 使用 least-privilege role，无 `CREATE EXTENSION` 权限。
- **影响**：clean production migration 在 `vector`、`pg_trgm` 或 `pgcrypto` 安装处失败。
- **修复**：把基础设施管理员预置扩展与应用 schema migration 分离；preflight 验证扩展及版本；应用 migrator 不要求 superuser；记录 provider 支持矩阵。2026-07-20 服务器 validation 首次暴露 fresh migration 中 `CREATE SCHEMA IF NOT EXISTS "workbench"` 仍要求 migrator 拥有数据库级 `CREATE`，已补充 bootstrap grant；runtime 仍显式撤销 database/schema `CREATE`。
- **测试**：本地 PostgreSQL 16 database-role 合同与真实角色测试 6/6 PASS，覆盖 admin/migrator/runtime 分权、已有 schema ownership transfer、runtime 无 CREATE/UPDATE/DELETE/TRUNCATE、取证表最小权限；缺扩展时给可操作的 fail-closed 错误。2026-07-20 目标服务器 validation 在空 PostgreSQL 容器中完成 66/66 migrations、grant 和 Runtime queue reconcile；远端静态合同 5/5 PASS，权限探测为 migrator database CREATE=true、runtime database/schema CREATE=false，runtime 直接 `CREATE SCHEMA` 被拒绝。该证据未绑定 G1/G4 候选，仍不能升级为生产 E1/E2。
- **退出条件**：生产权限模型下 fresh migration 和升级 migration 均成功。

### D-029 — Root typecheck 在当前工作区不可复现通过

- **状态/严重度**：REMEDIATED IN CODE / HIGH / release-blocking；fresh-clone G2 仍 NOT RUN
- **位置**：`apps/web/tsconfig.json`；生成的 `apps/web/.next/**` types
- **触发**：执行 root `npm run typecheck`，`.next` types 仍引用已删除的 `app/admin/page.js`。
- **实际错误**：`TS2307 Cannot find module ...app/admin/page.js`。
- **影响**：当前状态的“Root typecheck PASS”声明不成立；生成缓存污染可掩盖 clean checkout 行为。
- **修复**：新增 `scripts/workbench-web-typegen.mjs`，类型检查前清理整个 `.next`、运行 `next typegen`、验证路由声明被 git 忽略且仓库状态不漂移；Web package 与 CI 均显式调用。2026-07-20 服务器 validation 镜像构建暴露 Docker build 内没有 `.git` 和 `scripts/workbench-web-typegen.mjs`，因此 Web Dockerfile 改为在容器内先执行 `npx next typegen`、再直接执行 `npx tsc -p tsconfig.json --noEmit`，避免把本地 git-state wrapper 用作镜像构建依赖。
- **测试**：`workbench-web-typegen.test.mjs` 2/2 PASS，覆盖无 `.next` 清理生成、陈旧路由替换、第二次运行零源状态 diff 和 Web typecheck 接线；本轮 root `npm run typecheck` 已在 dirty tree 重跑 PASS；服务器 validation 全服务镜像构建在 Dockerfile 修复后 PASS，并包含 Web `next typegen`、`tsc --noEmit`、`next build`。2026-07-21 unsigned synthetic clean checkout 的 root typecheck 也已 PASS，但正式 fresh clone 仍需在 G1 candidate 上重新采集。
- **退出条件**：同一冻结候选在 clean checkout 上 root typecheck 稳定 PASS。

### D-030 — OpenAPI breaking diff 未产生结论

- **状态/严重度**：REMEDIATED IN CODE / HIGH / release-blocking；冻结候选 E2 证据仍待 R0
- **位置**：`scripts/workbench-openapi-oasdiff.sh`；`package.json`
- **触发**：执行 `npm run openapi:breaking` 时，Go 从 `proxy.golang.org` 获取 `oasdiff@v1.23.0` 超时。
- **实际状态**：当前复核 `npm run openapi:breaking` PASS；resolver 5/5 与 compatible/breaking fixtures PASS。首次运行因默认用户 cache 不在可写沙箱而失败，改用受支持的 `WORKBENCH_TOOL_CACHE_DIR=/private/tmp/workbench-tools` 后完整重跑通过，首次失败不计 PASS。
- **影响**：无法证明当前 93-path OpenAPI 相对批准 baseline 无 breaking change。
- **修复**：oasdiff v1.23.0 按平台/架构固定下载摘要、缓存并原子安装；工具不可用或摘要不匹配时 fail closed。
- **测试**：当前规格无 breaking diff；compatible PASS、breaking rejected、下载/摘要错误均通过。
- **退出条件**：针对冻结 baseline 的真实 breaking diff 产生 E2 PASS 证据。

### D-031 — 每个 active Run 每秒查询取消状态

- **状态/严重度**：REMEDIATED IN CODE / MEDIUM；目标容量与取消 SLO 仍 NOT RUN
- **位置**：`apps/workbench-worker/src/runs/run-processor.ts`
- **触发**：大量并发长 Run。
- **影响**：数据库 QPS 随 active runs 线性增长，可能在高负载下放大延迟和取消抖动。
- **修复**：保留 durable cancellation queue/reconciler 作为主信号，增加单实例共享 poller；Runtime 并发限制为 1–64，取消查询按 1–1000 ID 分批，轮询间隔限制为 250ms–10s，并保留数据库事实校验和故障恢复。
- **测试**：Worker `config.spec.ts` + `run-processor.spec.ts` 86/86 PASS，覆盖配置上下限、共享 poller 不重叠、按 1～1000 IDs 批量查询和每个 active Run 的 abort；目标容量 DB QPS、批准并发数与取消延迟 SLO 仍需 E1/E2 演练。
- **退出条件**：满足取消 SLO 且数据库负载在批准容量阈值内。

### D-032 — Run cursor 缺少严格 runtime type validation

- **状态/严重度**：REMEDIATED IN CODE / MEDIUM；冻结候选回归证据仍待 R0
- **位置**：`apps/workbench-api/src/modules/runs/runs.service.ts`，`decodeRunCursor(...)`
- **触发**：base64 cursor JSON 中 `id` 为 number/object 等 truthy 非字符串值。
- **影响**：非法客户端输入进入 Prisma，预期 400 可能变成 500。
- **修复**：使用共享 `opaqueIdSchema`、严格 UTC datetime、字段白名单和 128 字符上限；所有 decode/validation 错误映射为稳定 400 problem detail。
- **测试**：`run-cursor.spec.ts` 3/3 PASS；malformed base64/JSON、numeric/object/null ID、129 字符 ID、非法日历日期、未知字段均在授权/Prisma 前返回 400。
- **退出条件**：所有不合法 cursor 均稳定返回 400，且不触达数据库。

### D-033 — Greenfield replacement 依赖大量 untracked/dirty 文件

- **状态/严重度**：CONFIRMED / BLOCKER / release-blocking
- **位置**：整个 working tree
- **触发**：从提交基线 fresh clone 或在另一主机重建。
- **影响**：实现、迁移、部署、生成合同或证据可能缺失；当前结果不可审阅、不可重建、不可恢复。
- **修复**：完成 R0 inventory；将所有运行关键文件纳入可审阅提交；明确排除 generated/cache/evidence secrets；生成签名 source manifest。2026-07-21 又修复了 Knowledge Vault 测试对 ignored `storage/` 原始资产的直接依赖：候选内提交 10 项路径/media type/byte size/SHA-256/symlink 元数据 fixture，显式 `KNOWLEDGE_STORAGE_ROOT` 仍走真实字节校验；同时按 clean lockfile 重新生成并纳入 3 个 brand PNG，消除生成产物漂移。
- **测试**：fresh clone 全流程；与原 working tree 的 runtime artifact inventory 比较；关键文件不得只存在于 untracked/ignored。临时 clean Git candidate（2079 source files，无 `storage/` 或根 `.env`）已完成 fresh `npm ci`、Knowledge 85/85、root `npm test` exit 0、root typecheck、production build，以及两轮 `workbench:prepare` + `brand:assets` 后零 source status diff；该 candidate 未形成真实 commit/tag/signature，不能关闭 D-033/G1。
- **退出条件**：clean `git status`，签名 immutable candidate 可独立重建。

### D-034 — API production image 缺失 Linux `sharp` optional native dependencies

- **状态/严重度**：REMEDIATED IN CODE / HIGH / release-blocking；冻结候选镜像仍待 G4
- **位置**：`apps/workbench-api/package.json`；`apps/workbench-api/Dockerfile`；`package-lock.json`
- **触发**：2026-07-20 目标服务器 validation 启动 `workbench-api:server-validation`。
- **实际错误**：容器内 `require("sharp")` 抛出 “Could not load the "sharp" module using the linux-x64 runtime”；镜像内缺少 `/app/node_modules/@img/sharp-linux-x64` 与 `/app/node_modules/@img/sharp-libvips-linux-x64`。
- **影响**：API 容器可构建但运行时崩溃，后续 API/Web/生产验收不可执行。
- **修复**：API workspace 显式声明 `@img/sharp-linux-x64` 与 `@img/sharp-libvips-linux-x64` optionalDependencies，并将对应包写入 lockfile；API Dockerfile 的 dependencies/prune 阶段保留 optional dependencies，确保 Linux production image 带上 native `sharp` 闭包。
- **测试**：目标服务器重建 `workbench-api:server-validation` PASS；容器内两个 `@img` 包存在且 `require("sharp")` 输出 `sharp ok`；`npm --workspace @workbench/workbench-api run typecheck` PASS。该证据仍是 dirty tree/server-validation，不替代 G4 signed immutable image。
- **退出条件**：同一冻结候选的 API 镜像在 registry immutable digest 上通过 `sharp` runtime probe、SBOM/签名/inventory 绑定和 API startup probe。

### D-035 — `requestedArtifactKinds` 未约束发布工具可见性与子代理委派

- **状态/严重度**：REMEDIATED IN CODE / CRITICAL / release-blocking；授权服务器 validation PASS，冻结候选 E1/E2 仍待 G1/G4
- **位置**：`apps/workbench-worker/src/runtime/deerflow-runtime.adapter.ts`；`integrations/deerflow/skills/workbench/SKILL.md`；DeerFlow `workbench_tool_scope_middleware.py` source patch；Gateway request-context patch；runtime/secret-channel smoke
- **触发**：非 Prototype Run 仍向模型暴露 Prototype generation stage、draft publish、patch publish 工具，或允许 lead agent 把 document/PRD/image/data 请求委派给无法提交 Workbench 最终结果的 `task` 子代理。
- **实际错误**：真实 Worker queue smoke 首先因模型调用不适用的阶段工具失败为 `RUNTIME_GENERATION_STAGE_TRANSITION_INVALID`；隐藏三项 Prototype 发布工具后，模型改为委派 `task`，随后因 lead agent 没有提交最终结果失败为 `RUNTIME_RESULT_SUBMISSION_MISSING`。
- **影响**：合法非 Prototype Run 在真实模型下失败；模型可见工具集合不满足按 Run 最小权限；子代理可能重新发现发布/Canvas 工具，或完成推理却不产生 durable Workbench result。
- **修复**：Worker 仅在内部 Gateway context 的 `context.workbench.requestedArtifactKinds` 注入可信请求种类，Gateway 对字段来源和类型 fail closed；middleware 按该集合同时裁剪模型可见工具并在执行前再次拒绝，子代理不能重新发现三项发布工具或 Canvas 工具。`task` 只在请求包含 `prototype` 或 `code` 时启用，document/PRD/image/data 由 lead agent 直接完成并提交。
- **测试**：Worker 13 files / 218 PASS（33 个环境门控 skip 不计）、DeerFlow tools 64/64、Knowledge smoke contracts 7/7、DeerFlow/deployment 72/72、Worker typecheck/build、source patch apply/check/Python compile 均 PASS；Linux 镜像内 middleware 15/15 与 Gateway context 5/5 PASS。最终 validation 镜像在真实 `https://datatoken.shop/v1` / `gpt-5.5` 上完成基础 Gateway、clean Worker queue 与 secret-channel smoke；能力 token 明文扫描为零。
- **退出条件**：dirty-tree validation 已证明 document Run 的可见工具、委派和结果提交边界；仍须在同一 clean signed candidate、registry immutable digest 上覆盖所有 requested kind 组合、Prototype/code 子代理、故障恢复和长时序 E1/E2。

### D-036 — 生产 CSP 阻断全局 CSS 的外部字体样式请求

- **状态/严重度**：REMEDIATED IN CODE / MEDIUM / G11 release-blocking；clean candidate E2 仍待 G1
- **位置**：`apps/web/app/globals.css`；`apps/web/lib/workbench/route-ownership.spec.ts`
- **触发**：`globals.css` 顶部的 Google Fonts `@import` 在生产 CSP `style-src 'self' 'unsafe-inline'` 下被浏览器拒绝；真实登录页初始加载产生 console error。
- **影响**：浏览器质量门禁的零 console error 不成立；页面还依赖外部 stylesheet 才能获得字体，增加直连 Origin 下的渲染不确定性。
- **修复**：删除外部 `@import url(...)`，保留本地 CSS/Tailwind 与系统字体回退；路由所有权合同新增外部 stylesheet/font import 负向断言。
- **测试**：Web 定向合同 10/10 PASS；远端 validation Web 镜像构建 PASS（image digest `sha256:4392142d5ec65320807d4590a82a75cd883afbac7d06ae300ffb1742b69ffdf8`），单服务 rollout healthy；公网 `https://aionbench.com/login` Playwright 初始加载无 console error，编译 CSS 外部字体扫描为空。原始复核日志 `/private/tmp/workbench-remediation-20260721-csp-direct-origin-recheck.log`，SHA-256 `6fbfe96f0cf61eaa55eac9ad1e77510d85f3731526afaac1f7e85ec99aa95fb0`；源码仍位于 dirty working tree，未形成签名 candidate。
- **Owner/验证人**：实现者 Codex；独立生产验证人尚未指定。
- **残余风险**：移除外部字体会使用系统回退字体；需在冻结候选的完整浏览器/viewport 矩阵复核视觉基线。不得因此放宽 CSP 或引入新的外部 font origin。
- **退出条件**：同一 clean signed candidate 的 E2 浏览器矩阵、视觉基线和 G11 质量控制均 PASS。

### D-037 — 生产镜像上传合同落后于 release-chain signing 依赖

- **状态/严重度**：REMEDIATED IN CODE / HIGH / release-blocking；候选 CI 仍待 clean signed run
- **位置**：`scripts/assert-workbench-upload-deployment.mjs`；`.github/workflows/workbench-ci.yml`
- **触发**：CI `production-images` job 已依赖 `release-chain-signing`，但上传部署合同仍只断言旧的三项 `needs`，导致 `npm run deployment:upload:check` 在当前工作流上错误失败。
- **影响**：生产镜像构建被不必要地阻断；更重要的是，合同漂移会让签名链依赖变化不能由同一静态门禁准确表达。
- **修复**：合同期望与工作流的四项依赖完全对齐：`release-chain`、`release-chain-signing`、`quality`、`deployment-config`；错误信息明确要求 verified release chain 与 signing gate。未削弱工作流依赖，也未放宽镜像签名/证据要求。
- **测试**：首次执行 `npm run deployment:upload:check` 按设计失败并定位到旧期望；修复后 `deployment:upload:check`、`deployment:images:check`、`deployment:auth-proxy:check`、`deployment:orchestration:check` 与完整 `npm test` 均通过。原始修复后合同日志见 V-033。
- **退出条件**：同一 clean candidate 的 CI run 实际完成 release-chain signing、image evidence、deployment config 和 downstream verifier，并重新绑定 G3/G4/G12 证据。

### D-038 — G0 审批范围遗漏新增 release-blocking findings

- **状态/严重度**：REMEDIATED IN CODE / HIGH / release-blocking；新冻结候选与真实 G0 批准仍待执行
- **位置**：`scripts/g0-scope-approval.mjs`；`docs/evidence/governance/g0-scope-approval.schema.json`；`docs/evidence/governance/g0-scope-approval.example.json`
- **触发**：正式候选准备 G0 payload 时，校验器仍将完整 finding 集合固定为 D-001～D-033 与 P-001～P-019，而审计规范已经新增 D-034～D-037。
- **影响**：真实 G0 记录无法把新增供应链、工具最小权限、浏览器 CSP 和 CI 依赖 finding 纳入责任与进度范围；若沿用旧合同，G0 PASS 会产生漏审的生产批准事实。
- **修复**：G0 的精确集合最初升级为 D-001～D-038 与 P-001～P-019；D-039～D-048 形成后继续同步升级到当前 D-001～D-048 与 P-001～P-019，共 67 项。JSON Schema、NOT RUN 示例、治理说明和 schedule fixture 同步更新。校验器继续拒绝缺项、多项、重复项与未分配 schedule，不放宽任何批准独立性或证据规则。
- **测试**：当前回归显式断言 D-034～D-048 和 67 项总数，并证明旧范围 fail closed；与 route-frame、Web startup 合同合并为 34/34 PASS，日志 SHA-256 为 `694939d29ef7272c7c5cb901e89455d37edfdd28c898c810a716242ea0ea42e6`。D-039 前一版曾完成 G0 定向 22/22、R0 96/96、release-chain 8/8 及固定 npm 11.18.0 的完整 root test，完整日志 `/private/tmp/workbench-d038-root-test.log` 的 SHA-256 为 `38d50fbe3611cc33c8f5d65bfe7409a0bd8c7227b0dabcc5f287d585b3f27c2d`；该旧数量只作历史记录。当前 67 项合同必须在下一候选重新执行。
- **退出条件**：新 clean signed candidate 上 G0 合同与 release-chain 测试 PASS，且真实独立 G0 批准记录包含全部 67 项并绑定同一 G1 manifest。

### D-039 — 锁文件遗漏 Linux Rolldown 原生可选依赖

- **状态/严重度**：REMEDIATED IN CODE / HIGH / release-blocking；后续 Linux CI 已证明 binding 可加载，候选复跑随后形成 D-047/D-048
- **位置**：`package.json`；`package-lock.json`；`scripts/prepare-node-image.test.mjs`
- **触发**：签名候选 `8710fa5b83827b18c404690629aa7bbaa953ea79` 的 GitHub PR run `29844055994` 在 Linux `npm test` 启动 Workbench Contracts Vitest 时失败；`rolldown@1.1.4` 声明了平台包，但 lockfile 只有开发机的 `@rolldown/binding-darwin-arm64` 节点，`npm ci` 无法安装 `@rolldown/binding-linux-x64-gnu`。
- **影响**：G3 Linux 测试无法启动；相同锁文件也未显式封存 Alpine 生产镜像所需的 musl binding，后续 G4 构建存在同类失败风险。若以本机 ARM 测试代替，会产生跨平台假绿。
- **修复**：根 `optionalDependencies` 精确固定 `@rolldown/binding-linux-x64-gnu@1.1.4` 与 `@rolldown/binding-linux-x64-musl@1.1.4`；使用空 checkout 和固定 npm 11.18.0 生成两份完整 lockfile 节点，保留 registry integrity、CPU、OS、libc 与 optional 元数据。没有删除 lockfile、放宽 `npm ci` 或把平台二进制改为普通依赖。
- **测试**：Node image 回归现在校验全部 Linux x64 原生 pin、根 manifest/lockfile 一致、完整节点、optional 标记与 SHA-512 integrity。GitHub run `29846325332` 已在 Linux 完成 `npm ci`，Contracts 及后续多个 Vitest workspace 正常启动，关闭原始 native binding 缺失；该 run 后续因 D-040 的单测试预算失败。仍须在新 clean commit 完成 root test、后续浏览器/构建矩阵，并在 Alpine G4 镜像实际加载相关工具链。
- **退出条件**：新 clean signed candidate 的 GitHub Linux G3 全绿，十镜像 G4 中使用 npm 11.18.0 的 Alpine build PASS，且 G0 真实批准范围包含 D-039。

### D-040 — Knowledge 仓库级确定性测试沿用默认五秒预算

- **状态/严重度**：REMEDIATED IN CODE / MEDIUM / release-blocking；后续 Linux CI 已越过原始测试预算，候选复跑随后形成 D-047/D-048
- **位置**：`packages/workbench-knowledge/test/knowledge.spec.ts`
- **触发**：签名 commit `482e7ec7243721a0bc29465479650bee72a5fa3e` 的 GitHub PR run `29846325332` 在 Linux runner 读取 661 份 Vault 文档、10 个受引用资产并执行正序/逆序两次完整 release 构建时耗时 8456ms，超过 Vitest 默认 5000ms。
- **影响**：测试的内容闭包、路由计数、不可变性与顺序无关断言都已执行，但 G3 在较慢的共享 Linux runner 上被不适合仓库级集成工作的默认单测预算阻断；若只依赖本机耗时，会继续产生跨平台假绿。
- **修复**：只为该仓库级集成测试声明 15000ms 的显式预算，保留 661/10 数量、两次完整构建、canonical manifest/chunk/projection 相等、checksum、issue、route、reference 与 frozen object 全部断言；不修改 Vitest 全局默认值，不减少输入或跳过确定性验证。
- **测试**：Knowledge suite 85/85、G0 合同 22/22、固定 npm 11.18.0 的完整 root test 与 typecheck 均 PASS；root test 日志 `/private/tmp/workbench-d040-root-test.log` 的 SHA-256 为 `c49a34b660a420a6617caa8f83881bed431056a39c6e7568105e074fa7847e86`，typecheck 日志 `/private/tmp/workbench-d040-typecheck.log` 的 SHA-256 为 `f88ab597a4513236d35ad1690021682910300790d8a882bec00e1559802ed3a1`。最终必须由新 clean commit 的 GitHub Linux run 证明该测试在预算内通过且剩余 G3 矩阵继续执行。
- **退出条件**：新 clean signed candidate 的 GitHub Linux G3 全绿，且 G0 真实批准范围包含 D-040。

### D-041 — Runtime 恢复队列允许同一 Run 重复排队

- **状态/严重度**：REMEDIATED IN CODE / HIGH / release-blocking；本地与 Linux PostgreSQL 工作流均已通过，候选复跑随后形成 D-047/D-048
- **位置**：`packages/workbench-contracts/src/queues.ts`；`apps/workbench-worker/src/runs/runtime-execution-reconciler.ts`；`apps/workbench-worker/test/runtime-execution-reconciler.postgres.spec.ts`；`scripts/workbench-postgres-http-e2e.mjs`
- **触发**：签名 commit `0917c4472eefbde49f6cd454ea5f5f14f0ca360b` 的 PR #4 run `29848133959` 已越过 D-039、D-040 的原始触发，但在真实 PostgreSQL API/Worker 工作流中，SSE fixture 留下无人持有的 `running` Run，恢复器每五秒为同一 `singletonKey` 再次发送任务；`runtime.execute` 的 `key_strict_fifo` policy 不会拒绝已排队的同 key job，多个 `created` job 在 claim 时触发 `job_common_i8` 唯一索引冲突，并把后续 targeted Generate 阻塞在队头。
- **影响**：一个失租或测试遗留 Run 可持续制造重复恢复任务，使同 key claim 失败并阻塞其他 Run；Worker 表面存活但合法生成一直停留在 `queued`，导致 G3 PostgreSQL 工作流超时。仅依赖稳定 `singletonKey` 不能证明恢复投递幂等。
- **修复**：`runtime.execute` policy 改为 PostgreSQL 唯一索引约束的 `exclusive`，同一 Run 在 queued/retry/active 状态只允许一个任务，已保留的 failed job 不阻断下一次恢复。恢复器在 Prisma 事务中二次确认 Run 仍为无人持有或失租的 `running` 状态，以 `FOR UPDATE SKIP LOCKED` 锁定该 Run，并通过 `fromPrisma(tx)` 在同一事务发送带 `singletonKey=runId`、`group.id=threadId` 的任务。SSE fixture 改为带有效 owner、heartbeat 和未来 lease 的 attempt 1 Run，并在场景结束后删除 synthetic Run。
- **测试**：Contracts queue 10/10、恢复器单元测试 4/4、Worker typecheck 与真实 PostgreSQL 并发回归 1/1 PASS；并发回归覆盖双 Reconciler、active 去重、failed 后仅一个新恢复任务及不同 Run 可同时 fetch。完整 PostgreSQL API/Worker HTTP/SSE 工作流随后 PASS，targeted Generate 只进入 Fake DeerFlow 一次，approval/cancel/retry 均完成，且无 `job_common_i8`、duplicate key 或 timeout。固定 npm 11.18.0 的最终 root test、typecheck、G0 22/22、lint 与架构检查也均 PASS；root test、typecheck 和 PostgreSQL E2E 日志 SHA-256 分别为 `16b0ecca9537595e1164e5ca21c1ff99182cc117d9e9cfb17d398322ae7eb4d8`、`195288fb66f7ea885d53e2d5a59cda4b95ebf4417ceebe645a73474db1e69bbe`、`3da2704e5e6874a7992a57b7b960e104f9fa3d8986760c0959953fd913ebd329`；这些仍是 dirty-tree E4 证据。签名 commits `a79a34c316958070ed8a822d56fda22f14db85c5`、`068792fa4ad079e605d2aeb340d59633631d28a7`、`abbef5db516a06c230db8791cb7e68d41de39903`、`369938a8444d6c137400c3cfd53b7b360b22a600` 与 `4fadacb4e117b53e3ed369079871875675c52daa` 的 Linux runs `29852008323`、`29855070481`、`29857428945`、`29860405435`、`29862838335` 随后均完整通过真实 PostgreSQL API/Worker、File Worker 与 DeerFlow 步骤，关闭 D-041 的原始 CI 触发；最新 run 最终被 D-046 阻断。
- **退出条件**：新 clean signed candidate 的 GitHub Linux G3 全绿，67 项 G0 真实批准范围包含 D-041，并由同一候选上的故障恢复矩阵证明失租、并发扫描和 failed 后重投不会重复执行或阻塞其他 Run。

### D-042 — 浏览器 smoke 启动仅预热登录路由

- **状态/严重度**：REMEDIATED IN CODE / MEDIUM / release-blocking；项目路由预热已由 Linux CI 证明，候选复跑随后形成 D-047/D-048
- **位置**：`scripts/e2e/run-workbench-web-smoke.mjs`；`scripts/e2e/workbench-web-startup.mjs`；`scripts/e2e/workbench-web-startup.test.mjs`
- **触发**：签名 commit `a79a34c316958070ed8a822d56fda22f14db85c5` 的 PR #4 run `29852008323` 已通过安装、生成、迁移、静态检查、server/worker、真实 PostgreSQL、File Worker、DeerFlow、Web tests、浏览器 runtime 安装与 export integration；托管 Next dev 只用 `/login` 判断 ready，第一个 smoke 随后导航 `/projects/project-run-preview` 时才触发 Turbopack 首次编译 `/projects/[projectId]`，编译占用约 27 秒并使 `page.goto(..., waitUntil: "domcontentloaded")` 撞上 Playwright 30 秒默认预算。
- **影响**：业务路由实际无功能错误时，Linux 冷缓存仍会随机阻断 G3 并跳过 production build 与 route bundle 验证；直接放宽所有浏览器导航超时还会掩盖真实页面加载回归。
- **修复**：托管 Next dev 在登录路由 ready 后，以明确的 `workbench.session_token` 测试 Cookie 请求动态项目路由，完整消费响应并要求 HTTP 200。该预热使用独立 90 秒启动预算，同时监听托管服务提前退出并中止请求；Playwright 页面导航仍保留原 30 秒预算，外部自管 origin 不被启动器改写。
- **测试**：启动合同 5/5 PASS，覆盖连接重试、动态路由与 Cookie、完整响应、响应体中断、鉴权重定向 fail closed、服务提前退出与请求中止。固定 npm 11.18.0 的完整 `npm run e2e:web` 一次 PASS，实际日志先出现 `/projects/[projectId]` 冷编译，再完成 Run Preview、Board、Chromium/Firefox/WebKit、设计系统、Export 与隔离 Preview；日志 SHA-256 为 `cfa743ac77868d86321044cd91319ae618697d9614e9e206a27b2611965ec847`。固定 npm 11.18.0 的 root test、typecheck、lint、架构检查和 release-chain 8/8 也均 PASS，日志 SHA-256 分别为 `7e62bba433a415b73f07b9c2ac78fa35fba520bcce6ff5ed007ab97413e3bbfa`、`8bf1811023151cac14947a9788f2125721bb0234a01f17fc91010dafd1108310`、`4e4ad8bbf5e26ed8a8859f8f782afaedac831829808d7be93652a92a97cb3b51`、`6e6f5f6400d5d0b2cf73fd064d1179c13310ccb177017897b97e72071b723b30`、`03df608a31a1a0635d905b7fc64cfb63687956c37cbe7914d294c71793d82de9`。签名 commit `068792fa4ad079e605d2aeb340d59633631d28a7` 的 Linux run `29855070481` 随后先完成项目路由预热并通过 Run Preview smoke，证明 D-042 的原始触发已关闭；下一首页场景形成 D-043。原始 CI 失败日志 `/private/tmp/workbench-ci-29852008323-failed.log` 的 SHA-256 为 `401694b30a0d956d86cd82a1627820341e93d4d0f46e88ff83921fce7af3592a`。
- **退出条件**：新 clean signed candidate 的 GitHub Linux G3 在默认 Playwright 导航预算内完成浏览器 smoke、production build 与 route bundle 验证，67 项 G0 真实批准范围包含 D-042。

### D-043 — 浏览器 smoke 未预热独立首页路由

- **状态/严重度**：REMEDIATED IN CODE / MEDIUM / release-blocking；双入口预热已由 Linux CI 证明，候选复跑随后形成 D-047/D-048
- **位置**：`scripts/e2e/run-workbench-web-smoke.mjs`；`scripts/e2e/workbench-web-startup.mjs`；`scripts/e2e/workbench-web-startup.test.mjs`
- **触发**：签名 commit `068792fa4ad079e605d2aeb340d59633631d28a7` 的 PR #4 run `29855070481` 已通过 D-042 的项目路由预热和首个 Run Preview smoke；第二个 approval/preferences smoke 首次导航 `/` 时才触发独立首页 bundle 冷编译，约 27 秒后 `page.goto(origin, waitUntil: "networkidle")` 撞上 Playwright 30 秒默认预算。该 run 此前的 release-chain、Compose/gateway/Quartz、迁移、静态检查、server/worker、真实 PostgreSQL、File Worker、DeerFlow、Web tests、浏览器 runtime 与 export integration 均 PASS。
- **影响**：只预热测试序列中的第一个业务入口会把同类冷编译失败推迟到下一个入口，仍会随机阻断 G3 并跳过 production build 与 route bundle；逐个放宽页面导航预算会把编译启动成本混入产品加载预算。
- **修复**：启动器使用固定受保护入口矩阵，依次预热动态项目路由和首页路由；每个入口都有独立 90 秒启动预算、明确测试会话 Cookie、完整响应消费、HTTP 200 要求与托管服务退出监控。浏览器导航继续保留 30 秒默认预算，外部自管 origin 仍不执行托管预热。
- **测试**：更新后的启动合同 5/5 PASS，直接断言项目与首页两个 URL 的顺序、Cookie、完整响应、首页鉴权重定向 fail closed、响应体中断与服务提前退出。固定 npm 11.18.0 的完整 `npm run e2e:web` 一次 PASS，并在任何 smoke 输出前记录 `protected routes ready: /projects/project-run-preview, /`；root test、typecheck、lint、架构检查与 release-chain 8/8 也均 PASS。六份日志 SHA-256 分别为 `15bcff674c72dc6a53ee4ed5218a26539e2fda2d7ef7b0af988984dd5e00d4d2`、`a99a26bb66e7a4788e366d9224be477e5c194548da09d5be6da4d3c0df6b26a8`、`7cd0fa084ff2b5d0a7e486cd92dcef1423ee5256e74bf9e6c32aa98ba6f7c726`、`4e4ad8bbf5e26ed8a8859f8f782afaedac831829808d7be93652a92a97cb3b51`、`bfdfd1db097638c53a6e7fa292342359bc535a6ac1bd16a13a19f8625b5abf95`、`1c797c81d4eec75456764d3342c31f9bda79ded921be1ae9f46247be958711c7`。签名 commit `abbef5db516a06c230db8791cb7e68d41de39903` 的 Linux run `29857428945` 随后先输出两个受保护入口均 ready，并在默认导航预算内通过 Run Preview 与首页 approval/preferences smoke，证明 D-043 原始触发关闭；该 run 后续在导航动画断言形成 D-044。原始 CI 失败日志 `/private/tmp/workbench-ci-29855070481-failed.log` 的 SHA-256 为 `6e18d733361b385aa89341a7356f85683827ad77db131f9a3c5f2607f22226b1`。
- **退出条件**：新 clean signed candidate 的 GitHub Linux G3 在两个入口均预热后完成全浏览器 smoke、production build 与 route bundle，67 项 G0 真实批准范围包含 D-043。

### D-044 — 导航 smoke 将同步挂载交接误判为可见透明度重叠

- **状态/严重度**：REMEDIATED IN CODE / MEDIUM / release-blocking；同步挂载原触发已由 Linux CI 证明关闭，候选复跑随后形成 D-047/D-048
- **位置**：`scripts/e2e/workbench-navigation-guard-smoke.mjs`；`scripts/e2e/workbench-route-frame-contract.mjs`；`scripts/e2e/workbench-route-frame-contract.test.mjs`
- **触发**：签名 commit `abbef5db516a06c230db8791cb7e68d41de39903` 的 PR #4 run `29857428945` 已完成双入口预热，并通过 release-chain、Compose/gateway/Quartz、迁移、静态检查、server/worker、真实 PostgreSQL、File Worker、DeerFlow、Web tests、浏览器 runtime、export integration、Run Preview、approval/preferences 与 Board smoke；随后 Chromium 的 Home-to-Project 动画被 `must use a live Framer overlap` 断言阻断。旧断言使用要求 `opacity > 0.001` 的 `routePresent` 同时判断空白帧和 AnimatePresence overlap；合法的 `mode="sync"` 交接可在 incoming root 首个采样仍为透明时同时挂载两个 root，而共享 runner 调度可能合并下一可见帧，因此 DOM ownership overlap 被错误等同于 visible-opacity overlap。
- **影响**：真实同步交接、独立出入场动画和非空页面均成立时，采样时序仍可产生 Linux 假失败并跳过 production build 与 route bundle；若直接删除 overlap/空白帧断言，又会漏掉 `mode="wait"` 串行切换或实际空白帧回归。
- **修复**：抽出独立 route-frame contract，以尺寸、display、visibility 与祖先可见性定义 `routeMounted`，要求 outgoing/incoming root 至少一个采样同时挂载来证明 `AnimatePresence mode="sync"`；仍用包含透明度阈值的 `routePresent` 拒绝任何视觉空白帧，并继续要求 source/target 独立透明度进程、target settle、child enter 与 Home translate 进程。可见重叠帧改为独立诊断字段，不作为同步 DOM ownership 的必要条件。
- **测试**：Node 合同 3/3 PASS，覆盖 incoming 首帧透明但同步挂载通过、无挂载重叠的串行交换失败、双 root 同时透明仍失败；与 63 项 G0 合同合并定向执行为 25/25 PASS。固定 npm 11.18.0 的完整 `npm run e2e:web` PASS，双入口预热后完成 Board、Chromium/Firefox/WebKit 导航、设计系统、Export 与隔离 Preview；三种浏览器所有路由方向均记录挂载重叠和实际可见重叠。完整 root test、typecheck、lint、506 模块/1671 依赖架构检查与 release-chain 8/8 也均 PASS。七份本地日志 SHA-256 分别为 `f7a56c8e8aa01d2c9a5c96303ee0aefa8e38bcef1d0304ccc595a3200994cb91`、`f62073830b25af8d3ea313b700dc849f03f3189cfe5dc364e6526ce55635691d`、`a1c4c71cc33fa45a4471111a10d2e180fb155c51621ee06bcc3e46a4e4b5ada5`、`7f49ffdd7cf713ec3511e9d9d6fef21a03ec338f74668a0c68ce908de7983b89`、`4e4ad8bbf5e26ed8a8859f8f782afaedac831829808d7be93652a92a97cb3b51`、`788f4d03d46a1ae78d62f28e4be8345c90e31b4e9a6be1139355c6c5f4bf9acf`、`a6432563e8357c2708120d81fad05f748e565456f24d7219bf7a32dc8e48b8e7`。Gitleaks 8.30.1 对最终 tracked/untracked 非忽略源码快照 2,099 个文件执行扫描，零命中，空 JSON 报告 SHA-256 为 `37517e5f3dc66819f61f5a7bb8ace1921282415f10551d2defa5c3eb0985b570`。签名 commit `369938a8444d6c137400c3cfd53b7b360b22a600` 的 Linux run `29860405435` 随后通过新的 mounted-overlap 断言并继续执行到 incoming opacity range，证明 D-044 原始触发关闭；该 run 在下一判据形成 D-045。原始 Linux CI 失败日志 `/private/tmp/workbench-ci-29857428945-failed.log` 的 SHA-256 为 `01171b3e431d16e1707f49fbc943b4d468005d14f05ca1134ced50d81d6f2513`。
- **退出条件**：新 clean signed commit 的 GitHub Linux G3 完成全浏览器 smoke、production build 与 route bundle，且 67 项 G0 真实批准范围包含 D-044。

### D-045 — 导航 smoke 的透明度范围排除透明挂载端点

- **状态/严重度**：REMEDIATED IN CODE / MEDIUM / release-blocking；透明端点原触发已由 Linux CI 证明关闭，候选复跑随后形成 D-047/D-048
- **位置**：`scripts/e2e/workbench-route-frame-contract.mjs`；`scripts/e2e/workbench-route-frame-contract.test.mjs`
- **触发**：签名 commit `369938a8444d6c137400c3cfd53b7b360b22a600` 的 PR #4 run `29860405435` 已通过 D-044 的同步挂载 overlap，并再次完成 release-chain、Compose/gateway/Quartz、迁移、静态检查、server/worker、真实 PostgreSQL、File Worker、DeerFlow、Web tests、浏览器 runtime、export integration、Run Preview、approval/preferences 与 Board smoke；随后 Chromium Home-to-Project 被 `incoming project opacity must animate during enter` 阻断。旧 range 只使用 `routePresent` 帧，主动排除了 opacity 0 的合法挂载起点；当共享 runner 合并中间可见帧时，计算只剩接近终态的样本，实际 `0 -> 1` 入场被错误判为变化不足 0.12。
- **影响**：页面无空白、同步挂载和入场端点均成立时，采样密度仍可使合法动画假失败；若直接删除 opacity range，又会让 incoming root 瞬间全显、从未执行入场动画的回归通过。
- **修复**：source、target 和 incoming child 的 opacity range 改用 `routeMounted` 样本，使透明挂载起点与透明退出终点进入端点计算；source/target 可见性、页面空白帧、同步挂载 overlap、target settle、Home transform 与 child enter 断言全部保留。新增负向合同证明 incoming route 即使与 outgoing 同时挂载，只要 opacity 始终为 1，仍会因 range 为 0 而失败。
- **测试**：Node 合同 4/4 PASS，覆盖可见中间帧被合并的同步入场、无挂载 overlap 的串行交换、双 root 同时透明的视觉空白，以及同步挂载但 incoming opacity 从未变化的直接跳变；与 64 项 G0 合同合并定向执行为 26/26 PASS。固定 npm 11.18.0 的完整 `npm run e2e:web` PASS，Chromium/Firefox/WebKit 每个路由方向的 source、target 与 child 均记录透明端点、挂载 overlap、实际可见 overlap 和最终 settle，Board、设计系统、Export 与隔离 Preview 也全部完成。完整 root test（含 R0 100/100）、typecheck、lint、506 模块/1671 依赖架构检查与 release-chain 8/8 均 PASS。七份本地日志 SHA-256 分别为 `3c9f4cc45e19955ff784d3ceef7460a3ff456000590e6b0c8e38e9152ef217a6`、`61b282831992c4c531cfb2012fa87c1be91e3748842cbfbb10d6ba2fc86f91fa`、`bbf430995a8aa07b111e0c7b2587139271231a5ee31b704ddc371e50af00086b`、`23c7866c3b0c0fe735ba012e35415a16c7be8f9dc754364cc11806836ab7d55c`、`4e4ad8bbf5e26ed8a8859f8f782afaedac831829808d7be93652a92a97cb3b51`、`2a43bedf148c5a1e3025a05325c7af0df09c95a6f5fcdfc013b858951e083b0b`、`e50153e7c1ea29345d56f29a578060e5c6ccef72ccad6151f2524625e0d040d5`。Gitleaks 8.30.1 对最终 tracked/untracked 非忽略源码快照 2,099 个文件执行扫描，零命中，空 JSON 报告 SHA-256 为 `37517e5f3dc66819f61f5a7bb8ace1921282415f10551d2defa5c3eb0985b570`；当前结果仍是 dirty-tree E4，不能升级为 G3 PASS。签名 commit `4fadacb4e117b53e3ed369079871875675c52daa` 的 Linux run `29862838335` 随后通过 mounted opacity 端点断言并继续执行到 Home translate 进程，证明 D-045 原始触发关闭；该 run 在下一判据形成 D-046。原始 Linux CI 失败日志 `/private/tmp/workbench-ci-29860405435-failed.log` 的 SHA-256 为 `a02feaef2c7caa4196580c86e74cca58c658ffbc4835252388e8b68b550b4168`。
- **退出条件**：新 clean signed commit 的 GitHub Linux G3 完成全浏览器 smoke、production build 与 route bundle，且 67 项 G0 真实批准范围包含 D-045。

### D-046 — 导航 smoke 的 Home 位移范围排除透明挂载与中性端点

- **状态/严重度**：REMEDIATED IN CODE / MEDIUM / release-blocking；原始触发已由候选首轮 Linux G3 证明关闭，复跑随后形成 D-047/D-048
- **位置**：`scripts/e2e/workbench-route-frame-contract.mjs`；`scripts/e2e/workbench-route-frame-contract.test.mjs`
- **触发**：签名 commit `4fadacb4e117b53e3ed369079871875675c52daa` 的 PR #4 run `29862838335` 已通过 D-045 的 mounted opacity 端点，并再次完成 release-chain、Compose/gateway/Quartz、迁移、OpenAPI、typecheck、lint、架构检查、server/worker、真实 PostgreSQL、File Worker、DeerFlow、Web tests、浏览器 runtime、export integration、Run Preview、approval/preferences 与 Board smoke；随后 Chromium Home-to-Project 被 `must retain the Home root translate progression` 阻断。旧 transform 集合只保留 `routePresent` 帧并显式删除 `transform: none`；当共享 runner 合并短暂可见位移帧时，透明挂载期间的有效 transform 与中性端点都被排除，合法的 Home 出场进程只剩一个非中性值而被误判。
- **影响**：页面无空白、同步挂载、opacity 入场和真实 Home translate 均成立时，采样密度仍可让合法动画在 Linux 假失败并跳过 production build 与 route bundle；若直接删除 transform 断言，则 Home 只做透明度变化、完全丢失既定空间动效的回归会漏检。
- **修复**：Home transform 集合改用所有 `routeMounted` 帧，缺失或中性值统一保留为 `none`，使透明挂载期间的位移样本和 neutral endpoint 一起参与 progression 判定；断言失败时输出实际 transform 状态，便于区分采样合并与真实静态回归。mounted/visible overlap、空白帧、source/target/child opacity、target settle 与 child enter 断言全部保留。新增负向合同证明 opacity 正常变化但 Home transform 始终为 `none` 时仍会失败。
- **测试**：Node route-frame 与 65 项 G0 合同合并定向执行 27/27 PASS。固定 npm 11.18.0 的完整 `npm run e2e:web` PASS，Chromium、Firefox、WebKit 的 Home-to-Project、Project-to-Home 和 forward 均记录至少两个 Home transform 状态，且继续满足 opacity 端点、挂载 overlap、实际可见 overlap、最终 settle、Board、设计系统、Export 与隔离 Preview。完整 root test（含 R0 101/101）、typecheck、lint、506 模块/1671 依赖架构检查与 release-chain 8/8 均 PASS。七份本地日志 SHA-256 分别为 `330ac38e2698de4fbedfd3c5492fcdd123fc443121497c99b877cbaeff01d93b`、`6b12ceb80b2f5400a153c78f2a262bd34578187ed35809b74ac1c711f55d39dd`、`1e4ce35b54975f29a817854320b0d5aebd14d48120a95842d47f1e68b19b3b82`、`da58cced68eea053b6f4a8873c1608604c2a67e05e332fafa14bcd1fd3967cb5`、`4e4ad8bbf5e26ed8a8859f8f782afaedac831829808d7be93652a92a97cb3b51`、`83e69d045f57478cee780927e56ece6d494e8458492bf2ff898ffb4d58d8be66`、`b3df152d542230477a2c1548d37435c1066b1cb68e6e74698c85a61900aaff19`。Gitleaks 8.30.1 对 2,099 个 tracked/untracked 非忽略候选文件扫描零命中，空 JSON 报告 SHA-256 为 `37517e5f3dc66819f61f5a7bb8ace1921282415f10551d2defa5c3eb0985b570`；这些结果仍是 dirty-tree E4，不能升级为 G3 PASS。
- **退出条件**：新 clean signed commit 的 GitHub Linux G3 完成全浏览器 smoke、production build 与 route bundle，且 67 项 G0 真实批准范围包含 D-046。

### D-047 — 双入口冷编译预算不足以覆盖共享 Linux runner 抖动

- **状态/严重度**：REMEDIATED IN CODE / MEDIUM / release-blocking；固定 npm 本地矩阵 PASS，新候选 Linux CI 待执行
- **位置**：`scripts/e2e/workbench-web-startup.mjs`；`scripts/e2e/workbench-web-startup.test.mjs`
- **触发**：签名候选 `2665575f5a8b4f0dad6fd6bdf12bcb3f614d4c56` 的 PR #4 run `29866702430` attempt 1 已完整通过 G3；attempt 2 在相同 HEAD 再次通过 release-chain、Compose/gateway/Quartz、迁移、OpenAPI、typecheck、lint、架构、server/worker、真实 PostgreSQL、File Worker、DeerFlow、Web tests、browser runtime 与 export integration，随后首页冷编译从 `22:15:30Z` 持续到每入口 90 秒请求预算耗尽，在 `22:16:58Z` 以 `home route warmup` timeout 失败，production build 与 route bundle 被跳过。
- **影响**：共享 runner 的单次冷编译抖动可使完全相同的已通过候选假失败；若改为放宽所有 Playwright 导航预算，则会把真实产品加载退化混入基础设施预热阶段。
- **修复**：仅把托管 Next dev 的 startup/每个受保护入口 warmup 默认预算从 90 秒提升为 180 秒；项目与首页仍各自使用独立 deadline，完整消费响应并强制 HTTP 200。服务提前退出、请求失败、鉴权重定向仍立即 fail closed，实际浏览器导航继续使用 Playwright 原预算。
- **测试**：Web startup 合同新增 180000ms 精确断言，并继续覆盖连接重试、双入口顺序/Cookie/完整响应、非 200、响应体中断和服务退出中止；与 D-048 route-frame 及 67 项 G0 合同合并 34/34 PASS。固定 npm 11.18.0 的最终完整浏览器流程、root test、typecheck、lint、506 模块/1671 依赖架构和 release-chain 8/8 均 PASS，日志 SHA-256 分别为 `5c1f75d2b3f7fa78fa3d05f01f4f455d6f497319e9a7153aacefa28b2800f39e`、`f29b41e15109874f9fc3c14489f7aaaa1fc02c64f332606e8a72d43a5fe53d3a`、`bbaaf731257e3d7e6e5b3e2ae743859d22cfb7f4069ee69bbb25c915d2cf1645`、`4e4ad8bbf5e26ed8a8859f8f782afaedac831829808d7be93652a92a97cb3b51`、`2a43bedf148c5a1e3025a05325c7af0df09c95a6f5fcdfc013b858951e083b0b`、`cf42db223a41205184026d9b4b0f7e8c16ae5b7b2af19ab4654f23f40ada802d`。原始 attempt 2 失败日志 SHA-256 为 `de1b1d1026c34b5e1ec3ba4b6483bb5fc3961dde48a50f70492139e9be6bf1e8`。
- **退出条件**：新 clean signed candidate 的 GitHub Linux G3 完成双入口预热、全浏览器 smoke、production build 与 route bundle，且 67 项 G0 真实批准范围包含 D-047。

### D-048 — 导航 smoke 将 MutationObserver 中间态误判为已绘制空白帧

- **状态/严重度**：REMEDIATED IN CODE / MEDIUM / release-blocking；固定 npm 本地矩阵 PASS，新候选 Linux CI 待执行
- **位置**：`scripts/e2e/workbench-route-frame-contract.mjs`；`scripts/e2e/workbench-route-frame-contract.test.mjs`
- **触发**：同一候选 run `29866702430` attempt 3 再次通过浏览器 smoke 之前的全部 G3 步骤及 Chromium、Firefox 导航矩阵；WebKit Home-to-Project 随后记录一个 `source=mutation` 中间态，其中 Home opacity 为 `0.000755`、Project 为 `0`。它前一个 RAF 样本仍是 Home `1`，后一个样本已是 Project `0.990117`，中间没有 RAF paint candidate；旧合同仍把该 MutationObserver 回调当成用户可见空白帧而失败。
- **影响**：MutationObserver 在同一渲染任务的绘制前可观察到分步 style 写入；把所有 mutation 回调都当成屏幕帧会让真实页面没有绘制空白时产生 WebKit 假失败。若删除空白断言，则真实双透明 RAF 帧会漏检。
- **修复**：视觉空白只在 `requestAnimationFrame` paint candidates 上判定，并要求每次转场至少存在一个 RAF 样本；mutation 与 RAF 全样本仍共同用于 DOM mounted overlap、source/target/child opacity 进程、Home transform 和 settle 判定。结果新增 `paintCandidateFrames` 诊断计数，不放宽 `routePresent` 阈值。
- **测试**：route-frame 合同现为 6/6 PASS，新增“透明 mutation 夹在两个可见 RAF 之间应通过”，并继续证明真实 RAF 双透明、无 mounted overlap、incoming opacity 不变及 Home transform 静态均失败；与 startup/G0 合并定向日志 SHA-256 为 `694939d29ef7272c7c5cb901e89455d37edfdd28c898c810a716242ea0ea42e6`。最终固定 npm 浏览器矩阵中 Chromium、Firefox、WebKit 全部 PASS，WebKit Home-to-Project 记录 60 个 paint candidates；其余 Board、设计系统、Export、隔离 Preview 与像素检查均通过。原始 attempt 3 失败日志 SHA-256 为 `c9b9c45ae3d0cec075f82535d32b1b42e89eb75aa45a5634a5c846044747a43f`。
- **退出条件**：新 clean signed candidate 的 GitHub Linux G3 首轮及至少一次完整复跑均完成全浏览器 smoke、production build 与 route bundle，且 67 项 G0 真实批准范围包含 D-048。

---

## 5. 生产验收缺口与目标环境风险

以下事项不能仅凭本地代码判定。未完成前状态为 `NOT RUN`、`BLOCKED` 或 `INCONCLUSIVE`，均阻断阶段 12：

| ID | 风险/控制 | 当前状态 | 升级为 CONFIRMED 的条件 | 降级/关闭条件 |
|---|---|---|---|---|
| P-001 | WireGuard Edge 入口在真实环境生效 | NOT RUN | 公网可绕过 Edge 直达 origin，或 Web/Preview 未同时校验固定 peer 与独立密钥 | E1 正/负向探测及配置 revision 证明仅批准 WireGuard Edge 可达 |
| P-002 | 回源鉴权可审计且 fail closed | NOT RUN | 缺/错/重放 secret 仍能回源，或日志无法关联 request | E1 测试覆盖轮换、重放、脱敏、审计关联 |
| P-003 | DeerFlow immutable image digest | FAIL/NOT RUN | 部署仍引用 tag/本地 mutable image | 签名 digest、SBOM、provenance、部署实际 digest 一致 |
| P-004 | Better Auth 生产身份/KMS；企业 OIDC（仅启用 SSO 时） | NOT RUN | 本地账号、Dex 或静态 secret 被当作 production acceptance，或关闭 SSO 后仍保留可用 OIDC 配置 | Better Auth 密码登录、注册策略、session/JWT、撤销、密钥轮换与审计 E1 通过；只有 `WORKBENCH_ENTERPRISE_SSO_ENABLED=true` 时才要求目标 IdP/OIDC E1 |
| P-005 | 真实 S3/IAM/ClamAV | OSS/IAM VALIDATION PASS / FROZEN CANDIDATE NOT RUN | 共享过宽 identity、scanner bypass 或 quarantine 失败 | 阿里云 OSS 8 个独立 identities、60/60 IAM 与公网 multipart 13/13 已通过；仍需同一候选上的 EICAR、quarantine、checksum、恢复 E1 |
| P-006 | 双 HTTPS Preview origin/cookie isolation | NOT RUN | 单 origin/HTTP 证据被当作生产 | 两个真实 HTTPS origin 上 cookie/CORS/CSP/sandbox 负向通过 |
| P-007 | OTLP collector、trace 与告警 | NOT RUN | 仅配置存在，无 collector/trace/alert 证据 | 目标 collector 收到端到端 trace，告警阈值与 runbook 验证 |
| P-008 | Docker/Quartz/崩溃恢复 | NOT RUN | 仅 unit/compose config 测试 | 目标拓扑 SIGTERM、kill、重启、重复投递、恢复 E1 通过 |
| P-009 | Figma Desktop | NOT RUN/N/A 待定 | 声称支持但未在目标 Desktop 版本验证 | 范围内 E1 测试，或带批准人/到期日的 N/A |
| P-010 | embedding/reranker | NOT RUN | 模型/资产只存在单机或未绑定 digest | 固定中文 benchmark、模型 digest、adoption trace 和阈值通过 |
| P-011 | 全服务网络策略/egress/SSRF | NOT RUN | 任一服务可越界访问 metadata/private network | 目标环境 denial matrix、DNS/rebinding/redirect 测试通过 |
| P-012 | 真实第三方 export/provider | NOT RUN | 只有 fake-provider/capability contract | 使用批准短期凭证完成成功、拒绝、429、5xx、timeout、cancel、audit |
| P-013 | `view_screen` 视觉图像输入 | LOCAL PASS / PRODUCTION NOT RUN | 当前 fake/local 链路会错误接受、存储或返回图像，或真实模型仍收不到图像 | 当前代码已完成 command-bound capture、专用对象前缀、digest/ETag、短期 capability 和 DeerFlow `ImageContentBlock` 负向测试；仍需派生 DeerFlow 镜像和真实多模态 provider 的 E1/E2 验收 |
| P-014 | 按 Run 动态裁剪模型可见工具 | SERVER VALIDATION PASS / PRODUCTION CANDIDATE BLOCKED | 目标 DeerFlow 镜像未安装 scope middleware，模型仍可见/调用未声明工具，或子代理可重新发现受限工具 | source patch、Worker descriptor、Gateway context 与 middleware 已按 `declaredTools` 和 `requestedArtifactKinds` 双重 fail closed；真实 provider 的 document Run 与 secret-channel smoke 已在授权服务器通过，但仍需 clean signed candidate、registry immutable digest 和完整 requested-kind/子代理矩阵 E1/E2 |
| P-015 | Run/Import/Export 长时序 | NOT RUN | 仅 unit/simulator 或短 smoke | 真实 provider 环境覆盖取消、重试、限流、崩溃、恢复、幂等和并发 |
| P-016 | RunEvent DB append-only | LOCAL DB PASS / PRODUCTION ROLE TEST NOT RUN | 目标 runtime/operations role 仍可 UPDATE/DELETE/TRUNCATE 历史事件 | 本地 trigger 与 PostgreSQL 负向已通过；仍需 least-privilege 生产角色、备份恢复和审计 E1 验证 |
| P-017 | cancel Idempotency-Key contract | LOCAL PASS / PRODUCTION NOT RUN | 目标部署未使用 durable cancellation receipt，或并发重放结果不确定 | 当前 API/数据库/Worker receipt、竞态和幂等测试已通过；真实故障恢复仍待 E1 |
| P-018 | preference coordinator CAS recovery | LOCAL PASS | 首次 CAS 失败后后续 toggle 沿用 stale revision | refresh/rebase、单写队列、确定性并发测试及浏览器 smoke 已通过；候选变化后重验 |
| P-019 | `source_id` DB 与应用约束一致 | LOCAL POSTGRESQL PASS | 可绕过应用写入 DB 接受歧义 source ID | 应用 schema、数据库 CHECK、append-only migration 和 PostgreSQL 负向已通过；生产升级 migration 仍待 E1 |

真实凭证测试必须使用批准的短期凭证、隔离测试数据和脱敏日志。本文及证据索引不得保存 secrets、token 或可复用认证材料。

---

## 6. 已反驳候选及适用边界

以下候选不应作为当前缺陷重复修复，但冻结基线变化后必须重验：

- 缺少直接 `POST /threads/:threadId/runs`：当前 SubmissionIntent 是唯一公开入口；
- Preview editor 降为 viewer 后仍可使用短期 read-only capability：符合当前设计；
- ArtifactVersion publication/immutability：专项审查显示事务、并发、幂等、唯一约束和 terminal immutability 边界成立；
- Better Auth 与 Nest token mismatch：未确认；
- BFF 丢弃 ETag/304：该候选本身被反驳，但客户端 304 contract 仍需按 D-018 修复；
- DB preference CAS 未包含 principal：未确认；身份缓存问题在 D-016 的 ETag/query namespace；
- Preview sandbox `allow-same-origin` 绕过：当前 sandbox 未包含该 flag，未发现确认绕过；
- 旧 chat/AI SDK/SWR、聚合 Service、route ownership、projectId remount 等结构债务：当前架构门禁未发现确认残留；
- Share/Remix 权限与迁移候选：当前基线专项验证通过；
- P0–P2 视觉 mismatch：只在已测 viewport/browser/fixture/evidence 范围内未发现 actionable mismatch，不代表所有产品矩阵通过；
- 失败的 Stitch 抓包：只能证明失败路径，不能作为成功 Session/file_update/updateProject 协议样本。

---

## 7. 未绑定候选的本地验证摘要

本表只记录 dirty working tree 上的本地自动化结果，不是 7.1 定义的正式 ledger，也不属于 E2。只有在 G1 形成干净、签名、不可变候选后，使用同一候选重新采集 UTC 时间、工具版本、commit/tag、原始输出 URI 和 SHA-256，结果才可能升级为 E2。使用 fake provider、单机 PostgreSQL、浏览器本地替身或静态合同的结果继续归为 E4。

| Ledger ID | 验证 | 结果 | 证据等级 | 备注 |
|---|---|---|---|---|
| V-001 | `npm run test` | PASS | 未绑定本地自动化 | 2026-07-21 dirty tree 最终重跑 PASS（exit 0）；根脚本不包含 Web tests、浏览器矩阵、DeerFlow tools 或 PostgreSQL HTTP；skipped 不计 PASS，不得描述为“各 workspace 全量”。原始日志见下方索引 |
| V-002 | `npm run typecheck` | PASS | 未绑定本地自动化 | 2026-07-21 dirty tree 重跑 PASS（exit 0）；不替代 fresh-clone G2。原始日志见下方索引 |
| V-003 | `npm run openapi:check` | PASS | 未绑定本地自动化 | OpenAPI 与 Zod/route registry 一致，Redocly valid，93 paths |
| V-004 | runtime schema/validator checks | PASS | 未绑定本地自动化 | DeerFlow Runtime result schema/validator current |
| V-005 | `npm run openapi:breaking` + fixtures | PASS | 未绑定本地自动化 | pinned `oasdiff@v1.23.0`：当前差异无 breaking；5 个工具合同测试及 compatible/breaking fixtures 通过 |
| V-006 | Workbench dependency architecture | PASS | E4 | 506 modules、1671 dependencies，无 violation |
| V-007 | DeerFlow tools（含 architecture） | PASS | E4 | Python tools 合计 64/64；其中已包含 architecture 和 request-scope 负向测试，不重复计数 |
| V-008 | Web security header contract | PASS | E4 | 仅静态合同，不替代目标 Edge TLS/WireGuard 验证 |
| V-009 | deployment network/image/orchestration contract | PASS | E4 | 不替代目标环境网络 probing、实际镜像 digest 或运行拓扑 |
| V-010 | Edge/auth proxy/origin route preflight tests | PASS（22/22） | E4 | 不证明真实 WireGuard、源站防绕过或 Edge 鉴权已部署 |
| V-011 | ArtifactVersion publication/immutability 专项 | 最终 API 回归后更新 | 未绑定本地自动化 | 仅限当前代码机制；候选变化需重验 |
| V-012 | Preview isolation 专项 | PASS（本地浏览器边界） | E4 | 服务器 validation 的独立 HTTPS host/TLS 路由已短探测；生产 cookie/CORS/CSP/sandbox 负向矩阵仍 NOT RUN |
| V-013 | Run SSE backpressure/disconnect/cursor | PASS（本地） | E4 | close/abort race、listener cleanup、replay cursor 与冲突 400 已进入单测和 PostgreSQL HTTP E2E |
| V-014 | production acceptance | NOT RUN；总体 REJECT | 无 | 阶段 12 不通过 |
| V-015 | PostgreSQL API / Worker | API/Worker 本地回归 PASS；PostgreSQL 专项 PASS | E4 | 本机隔离 PostgreSQL 16.14、66 migrations；不是候选绑定证据 |
| V-016 | PostgreSQL constraints / HTTP / File Worker integration | PASS | E4 | 本机 PostgreSQL 16.14 UTF-8 cluster；constraints 328；HTTP 覆盖 Run/SSE/Canvas/Prototype/approval/cancel/retry；File Worker 覆盖 GC、扫描、解析、Knowledge 发布与恢复。初始 SQL_ASCII cluster 暴露中文 FTS 环境错误，未计为产品 PASS/FAIL |
| V-017 | Web unit/component tests | 182 files PASS、2 files SKIP；893 PASS、3 SKIP | E4 | 3 个 skip 为环境门控，不能计入 PASS |
| V-018 | Browser matrix / Export Worker browser integration | PASS（本地） | E4 | 综合 `npm run e2e:web` 与独立专项脚本均通过；Chromium/Firefox/WebKit、375x812/768x1024/1440x900、Preview/Export 均通过；直接运行专项但未启动 Web server 的 connection-refused 前置失败不计为产品 FAIL/PASS；与 V-010 不重复计数 |
| V-019 | G5 PostgreSQL recovery drill | PASS（18/18） | E4 | 以 `WORKBENCH_G5_DRILL_TEST_ADMIN_URL` 打开真实 PostgreSQL drill gate，在本机隔离 PostgreSQL 16.14 上完成真实 dump/restore/forward repair；先前未设置该变量的 run 只执行 plan/contract，不计为真实 G5 PASS；仍受 G1/G4 依赖阻断 |
| V-020 | R0/evidence contract suite | PASS（96/96） | E4 | 只证明 fail-closed 工具合同；当前 dirty tree 仍不能形成 G1 PASS |
| V-021 | `npm run build` | PASS（配置后） | E4 | 裸命令因缺少 `WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL` fail-closed；使用仓库示例非敏感 HTTPS Origin `https://uploads.workbench.example.com/workbench` 后生产 build 与 Figma importer package PASS；不替代候选镜像 build/digest |
| V-022 | 目标服务器 validation preflight + fresh migration | PASS（有限范围） | E3/E4 | 在 `45.207.206.119` 上安装 Docker/Caddy/Node 后，server-validation preflight PASS；首次 fresh migration 暴露 migrator 缺数据库级 `CREATE` 并失败，补充角色 provisioner 后空 PostgreSQL 容器 66/66 migrations、grant、Runtime queue reconcile PASS；runtime 负向 `CREATE SCHEMA` 被拒绝。V-023～V-027 后续补齐 DNS/TLS、validation images、runtime catalog 与 provider 短 smoke，但服务器仍未形成 clean signed candidate、registry immutable image、真实 S3/IAM 或生产 Edge/WireGuard，因此不关闭 G5/G10/G12 |
| V-023 | `aionbench.com` DNS 与公网 HTTPS validation | PASS（有限范围） | E3 | Workbench 项目域名为 `aionbench.com`；`datatoken.shop` 仅是线上 AI Provider URL，不属于项目 DNS/CDN。2026-07-20 阿里云权威 DNS 的 apex、`www`、`preview`、`uploads`、`identity` A 记录均指向授权验证服务器 `45.207.206.119`，最终公网快照中 TLS 校验成功且目标 IP 一致；apex 返回 307 登录跳转、uploads health 200、identity discovery 200、Preview 缺失路径与 validation secret path 均 404。未启用 CDN，未改动 `cpa.datatoken.shop`；该证据仍是 dirty-tree server validation，不是生产 Edge/WireGuard 或 G10 E1 |
| V-024 | 目标服务器 validation 镜像构建 | PASS（有限范围） | E3/E4 | 2026-07-20 在授权服务器构建全部 Workbench-owned 镜像、DeerFlow base/derived image 与后续 Worker/DeerFlow 修订。首次 Web 镜像因容器内误用 git-state typegen wrapper 失败，修复后全量构建 PASS；API 随后暴露并修复 Linux `sharp` optional native deps。最终运行 DeerFlow image ID 为 `sha256:964622c73905695b29f2a1dabfc79ab085d4f78b352583219a491516a2ccfb51`，Worker image ID 为 `sha256:42b45b17413d05a0384d1ba32081d104edd3ab92a9c52bc9f5e33c04c8bac5f5`，DeerFlow patch label 为 `17819f84ad6632b7ed35087275758113c1323429f8ed1f067f3003c9177cbf11`。这些是 dirty tree 和服务器本地 Docker image ID，不是 registry immutable digest，且无 SBOM/Cosign/provenance，因此不关闭 G4/G12 |
| V-025 | 目标服务器 validation stack readiness | PASS（有限范围） | E3 | 早期 limited stack 中 API live=200、ready=502 `RUNTIME_MODEL_CATALOG_UNAVAILABLE`，Web 因 health dependency 保持 Created；构建并接入真实 DeerFlow catalog 后已消除该阻塞。最终 15 个 Workbench 栈容器加 1 个独立 DeerFlow 容器（共 16 个）均 healthy，基础 Gateway runtime smoke 与公网路由快照通过。该栈来自同步 dirty tree、validation secrets 与本地 tag，不是 clean-host signed candidate；没有完成 Edge/WireGuard、OTLP、容量、恢复或完整浏览器产品矩阵，因此 G7/G10/G11 仍 BLOCKED |
| V-026 | 目标服务器 DeerFlow 递进验证 | PASS（有限范围） | E3/E4 | 初次派生镜像已通过 source/skill/tools import 与 patch tests，但 production preflight 正确停在无可验证 public key 的 image-manifest signature chain；该失败未被改写为 PASS。随后针对 validation 范围迭代 Gateway context、工具裁剪与委派策略，最终镜像内 middleware 15/15、Gateway context 5/5、基础真实 provider runtime smoke 均 PASS。已部署镜像健康且 patch label 与 source-patch manifest 一致，但仍无 clean candidate、签名 tag、SBOM/Cosign chain 或 registry immutable digest，故仅关闭此前“DeerFlow runtime/catalog 不存在”的 validation 阻塞，不关闭 G4/G7/G10 |
| V-027 | 真实 Provider、clean Worker queue 与 secret-channel smoke | PASS（有限范围） | E3 | validation 栈使用 `https://datatoken.shop/v1` 与 `gpt-5.5`。最终 clean queue Run `run_worker_smoke_bfe2af291bdb438596bb371913163ec8` / Attempt `cmrti7lhg01ogpi07kz2709k8` / external Run `f6608932-3772-42a0-b918-35a21023d686` 均 succeeded，document ArtifactVersion ready/current、output entry 与 Board node 均存在；58 events、790 persisted stream nodes，capability 明文零命中且 DeerFlow 日志确认 `subagent_enabled: False`。secret-channel smoke 的 Knowledge/Canvas 各调用一次，扫描 3,523 nodes 与容器日志均无 capability 明文，malformed scope fail closed、ordinary caller 401；临时 Caddy route/mock 已清理。真实 Knowledge Release 因服务器无 ready Release fixture 未运行，Provider 429/5xx/timeout/cancel/recovery/长时序也未覆盖，不得升级为 G7/G8/G9/G11 PASS |
| V-028 | 2026-07-21 direct-origin topology recheck | PASS（有限范围） | E3 | 当前公网 DNS 的 `aionbench.com`、`www`、`preview`、`uploads`、`identity` 均解析到 `45.207.206.119`；公网结果为 apex 307、uploads 200、identity 200、Preview 404、validation secret route 404，TLS verify=0。服务器 16 个容器（15 个 Workbench 栈 + 1 个 DeerFlow）全部 healthy，mock/活动 validation route 均 absent；DeerFlow/Worker image ID 与 patch label 仍匹配。数据库当前 `knowledge_releases=0`、`embedding_profiles=0`、`retrieval_profiles=0`，因此真实 Knowledge Release 继续 NOT RUN。该 recheck 只证明当前直连 validation 状态，不关闭 G4/G7/G9/G10 |
| V-029 | 2026-07-21 CSP/font 直连公网复核 | PASS（有限范围） | E3/E4 | 修复 `globals.css` 外部 Google Fonts import 后，Web 合同 10/10 PASS；validation Web 镜像重建/rollout healthy；`aionbench.com/login` 初始 Playwright smoke 无 console error，发布 CSS 扫描无 `fonts.googleapis.com`/外部 `@import`。同一复核确认 Provider 为 `https://datatoken.shop/v1`/`gpt-5.5`，真实 chat probe HTTP 200，invalid key/model/malformed request 分别返回 401/502/400；embedding probe 为 HTTP 503、OTLP endpoint 未配置、对象存储仍为 validation MinIO；这些未完成项继续阻断 G7/G9/G10。原始日志 `/private/tmp/workbench-remediation-20260721-csp-direct-origin-recheck.log`，SHA-256 `6fbfe96f0cf61eaa55eac9ad1e77510d85f3731526afaac1f7e85ec99aa95fb0` |
| V-030 | 2026-07-21 可逆 OTLP collector + direct-origin Worker trace smoke | PASS（有限范围） | E3 | 在 `45.207.206.119` 临时启动 pinned `otel/opentelemetry-collector-contrib:0.127.0` collector，应用 API/Runtime Worker 使用临时 OTLP/HTTP endpoint；公网 `login=200`、`healthz=200`，真实 `gpt-5.5` queue Run succeeded（document Artifact ready，41 events，603 persisted nodes）。collector 实际收到 `workbench-api` server/client spans、`workbench-runtime-worker` HTTP/consumer spans，并观察到一次错误 consumer span 后最终成功；结束时恢复 `OTEL_EXPORTER_OTLP_ENDPOINT=`、删除 collector，公网仍 200、unhealthy=0。该结果只证明 validation collector 接收与基本父子链路，不证明生产 collector、告警阈值、观察窗口或 G10 E1。原始日志 `/private/tmp/workbench-remediation-20260721-otel-direct-origin-validation.log`，SHA-256 `934efcca7b979311e65445198260d348d75daa9fbc3e37bbb4fa72a0269689fb` |
| V-031 | 2026-07-21 gateway upstream refresh deployment contract | PASS（E4） | E4 | `deploy/server-deploy.sh` 对 `api`、`web`、`knowledge`、`all` 更新后显式调用 `compose_up_force_recreate gateway`，`preview` 更新后显式刷新 `preview-gateway`；`bash -n` 与 orchestration contract test 均通过。该合同防止 Nginx 继续使用已删除上游容器的旧 IP，但不替代目标环境的真实切换、回滚或 502/恢复 E1。原始输出 `/private/tmp/workbench-remediation-20260721-gateway-refresh-contract.log`，SHA-256 `5b918bf3d2abacb2439627a44cd6bccc6a9db2c2bf86433e40fbf99ff2150af6` |
| V-032 | 2026-07-21 public direct-origin/provider recheck | PASS（有限范围） | E3 | `aionbench.com`、`www`、`preview`、`uploads`、`identity` 的 A 记录均为 `45.207.206.119`；`aionbench.com/login` 与 `/api/healthz` 返回 200，TLS 证书 CN 为 `aionbench.com`，`https://datatoken.shop/v1` 可达（200）。这只确认当前直连 DNS/TLS 与 Provider URL 的事实，不证明生产 Edge、真实 S3/IAM、签名候选或长时序验收。原始日志 `/private/tmp/workbench-remediation-20260721-public-topology-recheck.log`，SHA-256 `e85f3ff063ef1dd89be33f9a2018fc2f9c5ea56a8e40ef7d37740ab9f553219a` |
| V-033 | 2026-07-21 production CI dependency contract correction | PASS（E4） | E4 | `production-images` 的 `needs` 已与 signed release chain 对齐为 `release-chain`、`release-chain-signing`、`quality`、`deployment-config`；修复后 upload/image/auth/orchestration 合同通过。该结果只证明静态 CI 依赖合同，不证明实际 GitHub production run、镜像 registry digest 或 G4/G12。原始日志 `/private/tmp/workbench-remediation-20260721-ci-contract-correction.log`，SHA-256 `3e1361a155cddb3b495ff3d6b940405dbbd5ceab21a152d4dbdaf682f41f68e4` |
| V-034 | 2026-07-21 R0 candidate diagnostic + independent source secret scan | R0 FAIL；scan PASS | E4 | 修复后重新生成的 candidate preflight 仍为 99 findings：94 blocked entries（92 个运行关键 untracked、root `.env` ignored secret material、tracked `.log` artifact），迁移为 62/66，3 个 runbook 未跟踪，且无 signed annotated tag；因此 G1 仍 FAIL。按 tracked + untracked source 集合（2078 files、约 20.7 MB，排除 ignored `.env`、`storage/`、缓存/构建产物）运行官方 `gitleaks 8.30.1`，初始唯一命中为 `scripts/workbench-postgres-constraints.mjs:4708` 的固定 quarantine storage prefix 误报；改为参数化 SQL 后重扫零命中。文档更新后的脱敏摘要 `/private/tmp/workbench-remediation-20260721-source-secret-scan-after-doc.json`，SHA-256 `1737192d41b6d42ffd641929a2972dee967f9a1f01dff19bd168e66dd24ae7c6`；修复后完整 `npm test` exit 0 的日志 `/private/tmp/workbench-remediation-20260721-full-test-after-secret-fix.log`，SHA-256 `19cdc4dd107eb4842079e8397f94793e5be912c25f2c2d31bdf8298c2f2d8ae8`；该扫描/测试 PASS 不升级 R0/G1。 |
| V-035 | 2026-07-21 clean-source Knowledge asset closure and candidate regression | PASS（有限范围） | E4 | 临时 clean Git candidate tree `7c338c4612cbd80dfcbbbb76ae06cb888cae04c8` / synthetic checkout commit `5366b1546e432d6217cb123e1b7bf1d50492c564` 共 2079 个 source files，明确没有 `storage/` 或根 `.env`；fresh `npm ci` PASS，Knowledge 85/85，root `npm test` exit 0，root typecheck/build PASS，2 轮 prepare + brand 后 source status bytes=0。真实 `KNOWLEDGE_STORAGE_ROOT=$PWD/storage` 运行 Knowledge 85/85；显式不存在根目录按预期 ENOENT fail closed。该 checkout 未签名、未绑定真实 G1 candidate，G2 仍不能正式关闭。 |
| V-036 | 2026-07-21 reproducible brand outputs and storage-root evidence | PASS（有限范围） | E4 | clean lockfile 安装后重新生成 `icon.png`、`opengraph-image.png`、`twitter-image.png`，随后 candidate 两轮 `brand:assets` 均零 diff；新 SHA-256 分别为 `cbb6bc5fef28d10143c783d60db5a6f872316b3e4e860a2755ceedb01565591a`、`347384a6f686cfefb9637c66d85cdffcd38054b5d1d11998c90d37cf681f6f3f`、`347384a6f686cfefb9637c66d85cdffcd38054b5d1d11998c90d37cf681f6f3f`；source artifact 仍待签名 candidate。 |
| V-037 | 2026-07-21 R0 candidate diagnostic after asset-closure remediation | R0 FAIL | E4 | 最新 diagnostic candidate `sha256:107b27ea0eba54aee1c326d82faac6476c319a8894ac4afae57287e099509581` 仍因 dirty worktree、93 个 untracked critical files、root `.env`、tracked `.log`、62/66 migrations、缺 runbook scope 和无 verified signed tag 共 100 findings；brandAssets 与 Knowledge Vault closure 均为 complete。manifest/inventory/receipt 仅是本机 diagnostic，不关闭 G1。 |
| V-038 | 2026-07-21 main working tree final regression after asset closure | PASS（未绑定候选） | E4 | 主树 `npm test`、`npm run typecheck`、配置 upload Origin 的 `npm run build` 均 exit 0；两轮 `workbench:prepare` + `brand:assets` 前后完整 dirty status byte-identical。仍不替代 G1/G2/G4。 |
| V-039 | 2026-07-21 final independent source secret scan | PASS | E4 | alternate index source snapshot tree `72bf972cbc5b2f50be3b6dee867395e13b2a19b4`，2079 个实际 source files、15,902,547 bytes，排除 `.env`、`storage/` 和构建产物；Gitleaks 8.30.1 零 findings。该结果不构成签名候选或生产安全批准。 |
| V-040 | 2026-07-21 阿里云权威 DNS 与 Provider 示例配置复核 | PASS（有限范围） | E3/E4 | 阿里云 DNS 控制台确认 `aionbench.com` 的 `@`、`www`、`preview`、`uploads`、`identity` 和当前 Workbench `cpa` 记录均指向 `45.207.206.119`；公网 `aionbench.com/login=200`，`https://datatoken.shop/v1/`=200。`.env.example` 与 `deploy/workbench.env.example` 已统一声明 OpenAI-compatible base URL `https://datatoken.shop/v1` 和模型 `gpt-5.5`，root `npm test` exit 0。当前拓扑不使用 CDN；未被 Workbench 代码引用的历史 `video.aionbench.com` 记录仍在旧地址，按范围未改动。该复核不关闭 G1/G4/G8/G10。 |
| V-041 | 2026-07-21 Provider example 变更后的 typecheck/build 回归 | PASS（未绑定候选） | E4 | `npm run typecheck` exit 0；裸 `npm run build` 按设计因缺少 `WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL` fail closed；注入非敏感验证值 `https://uploads.aionbench.com/workbench` 后 production build exit 0，Web 静态页 14/14 生成，Figma importer zip 生成。日志见下方索引；不替代 G1/G2/G4。 |
| V-042 | 2026-07-21 服务器升级后 validation rollout 恢复 | PASS（有限范围） | E3/E4 | 上一轮 `/opt/workbench/deploy/server-validation-resume-rollout.log` 在 Docker build 中途被服务器升级中断，未计为 PASS；升级完成后重新同步排除 `.env`、`storage/`、缓存和本机生成物的源码，并以 validation overlay、`local-object-storage`/`local-docling` profiles、build 模式重跑 `server-deploy.sh`，exit 0。14 个 Workbench readiness 服务均 healthy，PostgreSQL 应用 schema 中 66/66 migrations 已完成，展开环境后的 WireGuard/Caddy preflight PASS；`aionbench.com/login`、`/api/healthz` 和 `https://datatoken.shop/v1/` 均返回 200，直连 IP 符合当前无 CDN 拓扑。旧 `workbench-runtime-deerflow-1` 仍是历史 `exit 143` 容器，当前 Gateway DeerFlow healthy，未擅自删除。新 rollout 与 post-preflight 日志见下方索引；仍是 dirty-tree validation，不关闭 G1/G4/G10/G12。 |
| V-043 | 2026-07-21 升级后真实 Provider Worker/DeerFlow smoke | PASS（有限范围） | E3 | 首次从宿主机运行 queue smoke 因 Docker 内部 `postgres` hostname 不可达而得到 P1001；按真实网络边界改在新 Worker 容器内重跑后，`gpt-5.5` queue Run succeeded，document ArtifactVersion `ready`、39 events、581 个持久化节点扫描无 capability 泄漏。直接 DeerFlow runtime smoke 同样 succeeded，document create、`lead_agent`、`gpt-5.5`、visible text 80 bytes。原始日志与 hash 见下方索引；没有重跑完整 secret-channel/Knowledge Release/故障矩阵，因此不升级 G7/G8/G9/G11。 |
| V-044 | 2026-07-21 post-upgrade R0 candidate diagnostic | R0 FAIL | E4 | 当前工作树重新生成 candidate `sha256:87e337bf59329bd306522488bd484aacf68f7c84d982028a12a4e217c3d84ea0`，仍有 100 findings：93 个展开后的 untracked critical files、根 `.env` secret material、tracked fixture `.log`、62/66 tracked migrations、runbooks scope 缺失和无 verified signed tag。manifest/inventory/receipt 仅为本机 diagnostic；未取得用户授权的 commit、可验证签名 tag 或独立 G0 批准，G1 保持 FAIL，G2-G12 保持 BLOCKED。 |
| V-045 | 2026-07-21 full synthetic G0-G2 release-chain rehearsal | PASS（仅工具链演练） | E4 | 在隔离临时仓库中把当前完整 source snapshot（2079 个 tracked source files，排除根 `.env`、缓存/生成物和未引用 `storage`）提交并用临时 synthetic GPG key 签署 tag；只物化知识库明确引用的 10 个 storage 文件（225,061,953 bytes），G1 candidate、fresh-clone G2（`npm ci`、两轮生成、OpenAPI/runtime/typecheck）和同一 G0/G1/G2 的 `verify-release-chain` 均 PASS。Candidate `sha256:4f7111eb30d4c43ffa8556a9f28accf19ae69c7dc76c26663beeee4d840ca99c`，chain `sha256:106910dd25a6ca6954952c72fd30722b6317ebf1fb32a4e19b53fccdab83b313`。较早只含 2072 个文件的 synthetic snapshot 被 G2 typecheck 正确拦截（缺两个 Worker storage adapter），未被改写为 PASS。该 G0、签名和 chain 仅为 E4 rehearsal，不是生产批准、真实 candidate 或 G1/G2 关闭依据。 |
| V-046 | 2026-07-21 服务器升级后目标环境门禁复核 | PASS（有限范围；含一个预期阻断） | E3 | 在 `45.207.206.119` 对升级后的 validation 栈重跑 database-role contract、DeerFlow deployment contract、Origin WireGuard preflight 和 Workbench server preflight，均 PASS；公网 `aionbench.com/login`、`/api/healthz` 与 `https://datatoken.shop/v1/` 均为 HTTP 200、TLS verify=0；应用迁移为 66，`knowledge_releases`/`embedding_profiles`/`retrieval_profiles` 仍为 0。公网 signup 负向探针返回 `400 EMAIL_PASSWORD_SIGN_UP_DISABLED`，`auth_users` 前后均为 0。正式 DeerFlow preflight 按预期以 `WORKBENCH_DEERFLOW_BASE_IMAGE_REF must be an immutable digest reference` 退出 1，保留为 validation 与生产候选之间的硬阻断；当前对象存储仍是 validation MinIO，不能升级为 G4/G6/G7/G8/G9/G10/G12 PASS。该记录只证明升级后 validation 状态，不是 clean candidate、真实 S3/IAM、生产 Edge 或独立批准。 |
| V-047 | 2026-07-21 升级后本地完整回归与 fresh PostgreSQL | PASS（未绑定候选） | E4 | 正确 Web Vitest 配置为 182 files passed、2 skipped，893 tests passed、3 skipped；隔离 PostgreSQL 16.14/pgvector 0.8.5 新库完成 66/66 migrations，API PostgreSQL 回归 83 files/519 tests PASS，Worker PostgreSQL 回归 19 files/251 tests PASS。主树 `npm test`、`npm run typecheck`、配置非敏感 upload Origin 后的 `npm run build`、lint、architecture、OpenAPI breaking、Knowledge Vault audit 和三浏览器/三视口 E2E 均 PASS；裸 build 因缺少 `WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL` 按设计 fail closed。两轮 `workbench:prepare` + `brand:assets` 前后状态 hash 保持一致，且当前候选与临时 fresh checkout 的 1419 个非忽略文件逐文件 SHA-256 一致。所有结果仍是 dirty-tree/E4 或本机隔离数据库证据，不替代同一签名候选上的 G1/G2/G3。 |
| V-048 | 2026-07-21 最新 R0 candidate diagnostic | R0 FAIL | E4 | 当前 diagnostic candidate 为 `sha256:758bb319129af81d50f3ea21fe19ade458b792973de261e8cb9a7fb745e138b4`，manifest SHA-256 为 `f829d291a8f55eb0b5f4a5f1886fcb6fbb0104cd6e3efa4e4f896bcc44134828`，inventory SHA-256 为 `2ac3ff6a69b7bcaa6a447d91af48e536ecf9f1ab54a07a795aafa9b70069c720`；finding count 为 100，G1=FAIL。原因仍包括 dirty working tree、93 个运行关键 untracked 文件、4 个 migration 未 tracked（62/66）、3 个 runbook 未 tracked、根 `.env` secret material、tracked `scripts/fixtures/evidence-ledger/valid/raw/g0.log`，以及没有可验证 signed annotated tag。该诊断没有读取或写入 secret 内容，也没有把临时 synthetic 签名 rehearsal 当作真实候选。 |
| V-049 | 2026-07-21 最新公网、服务器与数据库 live recheck | PASS（有限范围） | E3 | 直连拓扑复核确认 `aionbench.com`、`www`、`preview`、`uploads`、`identity` 均解析到 `45.207.206.119`，`datatoken.shop` 解析到 `45.207.206.63`；`aionbench.com/login`、`/api/healthz`、Provider `/v1/` 均 HTTP 200，Preview 探针 404，TLS verify=0。升级后服务器 Workbench/DeerFlow validation 服务 healthy，应用数据库仍为 66 migrations，扩展含 `pg_trgm 1.6`、`pgcrypto 1.3`、`vector 0.8.5`；`knowledge_releases`、`embedding_profiles`、`retrieval_profiles` 仍为空。该结果证明当前直连 validation 状态，不证明真实 S3/IAM/KMS、registry immutable digest/SBOM/Cosign、生产 Edge/WireGuard、Knowledge Release 或 G4/G7/G9/G10/G12。 |
| V-050 | 2026-07-21 R0 diagnostic snapshot preceding its evidence entry | R0 FAIL | E4 | 新快照 candidate 为 `sha256:cb90763763be784a0f1d841c12018da317f32e8ab86157a7645bf133c5d8dcae`，manifest SHA-256 为 `d4e60e3b7eb356d4c17c3f065694cf7b10a756c679b57b24ac1b8a7233dad562`，inventory SHA-256 为 `c415375fa38e6c51370639a8499ae08994762fa4019e2277503fd41163e02a27`，inventory entry count 为 138676；finding count 仍为 100，G1=FAIL，status SHA-256 仍为 `653e83d51321715d8703d5b06f438472c8e85e931cda0087d54791f5fd642ca5`。阻断集合未改变：dirty working tree、93 个运行关键 untracked 文件、62/66 tracked migrations、runbooks scope 缺失、根 `.env` secret material、tracked fixture `.log` 和无 verified signed tag。该诊断只作为当前 dirty-tree 的事实记录，不构成真实签名候选或生产批准。 |
| V-051 | 2026-07-21 阿里云私有 OSS、RAM 最小权限与公网上传切换 | PASS（有限范围） | E3/E4 | 新私有 Bucket `aionbench-workbench-prod` 使用 8 个按 API staging/ready、Canvas、Runtime ready、File pipeline、Import、Export、Preview 拆分的 RAM 身份；真实 IAM 允许/拒绝、multipart、create-only 与清理矩阵 60/60 PASS，公网 `https://aionbench.com` 到 `https://uploads.aionbench.com` 的登录、multipart、完成、下载、删除及 public signup fail-closed 共 13/13 PASS。应用通过固定目标 TLS passthrough egress 访问 OSS，旧 MinIO 服务已停止但容器和卷保留以便回滚；公网登录、健康检查和 OSS egress 正常。证据不含 AccessKey secret；bootstrap 高权限 AccessKey 和本轮临时凭据必须在收口后撤销/轮换。该验证来自 dirty tree 和可变服务器部署，不关闭 G4/G6/G8/G10。 |
| V-052 | 2026-07-21 OSS 改动后的隔离 PostgreSQL 全回归 | PASS（未绑定候选） | E4 | 本机 PostgreSQL 16.14 临时库完成 fresh 66 migrations、328 个数据库约束、API/Worker HTTP/SSE/Canvas/retry/cancel、File Worker/GC/提取/Knowledge 和 18/18 dump/restore/forward-repair；启用 PostgreSQL 条件套件的根测试退出 0，测试库随后删除且无残留。该结果证明新 OSS 配置和 conditional-create 代码没有破坏数据库边界，但不替代 G1/G4 candidate binding 或目标环境恢复 E1。 |
| V-053 | 2026-07-21 OSS 改动后的最终静态、构建与浏览器矩阵 | PASS（含一次保留的重试记录） | E4 | 根 typecheck、根测试、Web 893 PASS/3 环境门控 SKIP、lint、506 模块/1671 依赖架构检查、OpenAPI breaking 和使用正式上传域的 production build 均退出 0。首次完整 E2E 在 Chromium PASS 后因 Firefox Home→Project 入场动画采样未达到阈值退出 1；未修改源码或阈值，原样复跑后 Chromium/Firefox/WebKit、375x812/768x1024/1440x900、console/network/overflow/pixel、Export 与隔离 Preview 全部退出 0。失败和成功日志均保留；必须在签名候选与部署环境重跑，不能把本次重试升级为 G11。 |
| V-054 | 2026-07-21 当前源码与 Git 历史独立密钥扫描 | PASS（未绑定候选） | E4 | Gitleaks 8.30.1 扫描 2,092 个 tracked/untracked 非忽略源码文件和 415 个提交。当前源码零命中；历史初扫仅命中两个固定测试夹具，经人工核验为非凭据后，以精确 `commit:file:rule:line` 指纹写入 `.gitleaksignore`，没有关闭或放宽任何检测规则；复扫当前源码与完整历史均为零命中。被忽略的本机 `.env` 不属于候选且未被读入证据，仍必须在部署后清理/轮换其中已暴露的高权限凭据。 |
| V-055 | 2026-07-21 首个真实签名候选与 G0 scope drift 诊断 | G1/G2 工具 PASS；候选已淘汰 | E2/E4 | 签名 commit `a4bc293e70741ce1863e7b82e43e9141eaaf5e28` 与签名 tag `workbench-remediation-20260721-a4bc293e` 首次 G1 因 ignored root `.env` fail closed；工具未读取内容，文件迁移到仓库外 0600 配置目录后，新不可变 G1 manifest 与 inventory PASS，candidate ID `sha256:880418843788188591785ef4d89ee4e8283f82fbbb749b8b86ddc0b47932e69a`。固定 npm 11.18.0 的 fresh-clone G2 随后 PASS，完成两轮生成、OpenAPI/runtime/typecheck、零源码漂移和 checkout 清理。准备真实 G0 时发现校验器只覆盖 D-001～D-033，遗漏 D-034～D-037，形成 D-038；因此该候选主动淘汰，G1/G2 事实不进入 production release chain。第二次 G1 manifest/inventory SHA-256 分别为 `fde19d9bbdc3767913c00f43458d2a0dcb71e74e86171d5865dff2d602138c69`、`44cea7416abfd558302a6c8de645900f00074e6f48f9cccffdd1cf82bb7af3cc`，G2 receipt SHA-256 为 `55f883d0a6a9ac09290e1c74220c25ad91178418c2e309f1c37eef51f03b6670`；均只保留为淘汰候选诊断，不得复用于新候选。 |
| V-056 | 2026-07-21 第二个签名候选、真实 G0 待审批包与首轮 GitHub Linux CI | G1/G2 PASS、G0 NOT RUN、G3 FAIL；候选已淘汰 | E2/E4 | 签名 commit `8710fa5b83827b18c404690629aa7bbaa953ea79`、签名 tag `workbench-remediation-20260721-8710fa5b` 生成 clean G1 candidate `sha256:5a12d2ef8641ee8209735e5866256adb505b954095a3e74ff62b956bdc6add40`；manifest/inventory SHA-256 分别为 `8548ec1e19f9dd7d59e6d8783c22a1aa9fc4ed1113d49de3d1c891646a050110`、`f4eabb8e68698f567e035b98c40af7218d0ede55101f884ceb51f19c4ba444e4`。固定 Node 22/npm 11.18.0 的 fresh-clone G2 PASS，receipt SHA-256 `c52f9b6746b6914333fc0a4111bc3a97afa9be68f87c5646131edfc77bec0848`；57 项候选绑定 G0 待审批记录结构有效且明确 `NOT RUN`，release-chain 按设计停止在独立批准。分支/tag 推送后 PR #4 的 run `29844055994` 中 release-chain 合同与 Compose/gateway/Quartz job PASS，quality job 在 `npm test` 启动 Contracts Vitest 时因 lockfile 缺少 `@rolldown/binding-linux-x64-gnu@1.1.4` 失败，形成 D-039。故该候选及其 G0/G1/G2 哈希全部淘汰，不得复用于下一候选或生产链。 |
| V-057 | 2026-07-21 Linux 原生依赖修复验证与第二轮 G3 诊断 | D-039 原触发关闭；G3 FAIL；commit 未形成候选 | E2 | 签名 commit `482e7ec7243721a0bc29465479650bee72a5fa3e` 的 PR #4 run `29846325332` 中 release-chain 合同与 Compose/gateway/Quartz job PASS；quality job 在固定 Node 22/npm 11.18.0 的 Linux runner 完成 `npm ci`、生成、迁移、OpenAPI、typecheck、lint 和架构检查，Contracts 及后续多个 Vitest workspace 正常启动，证明 D-039 的 glibc Rolldown binding 缺失已关闭。随后 Knowledge 仓库级测试的 84 项先行断言 PASS，唯一完整 Vault 双构建用例耗时 8456ms 并撞上默认 5000ms timeout，形成 D-040；其后 PostgreSQL、Web、浏览器和 build 步骤按 CI fail-fast 跳过。该 commit 没有签名 candidate tag、G1/G2 或真实 G0 包，不得沿用上一淘汰候选产物。 |
| V-058 | 2026-07-21 Runtime 恢复队列与第三轮 G3 诊断 | D-039/D-040 原触发关闭；G3 FAIL；commit 未形成候选 | E2/E4 | 签名 commit `0917c4472eefbde49f6cd454ea5f5f14f0ca360b` 的 PR #4 run `29848133959` 中 release-chain 合同与 Compose/gateway/Quartz job PASS；quality job 在固定 Node 22/npm 11.18.0 的 Linux runner 完成安装、生成、迁移、OpenAPI、typecheck、lint、架构检查与 server/worker tests，证明 D-039/D-040 的原始失败均已越过。真实 PostgreSQL API/Worker 工作流随后因同一失租 Run 的重复 `created` 恢复任务触发 `job_common_i8`，targeted Generate 未进入 Fake DeerFlow 并超时，形成 D-041；其后 File Worker、DeerFlow、Web、浏览器和 build 步骤按 CI fail-fast 跳过。修复后本地真实 PostgreSQL 并发回归与完整 HTTP/SSE 工作流 PASS，但仍属 dirty-tree E4；该 commit 没有签名 candidate tag、G1/G2 或真实 G0 包，不得作为发布候选。 |
| V-059 | 2026-07-21 Runtime 修复后的第四轮 G3 与浏览器冷启动诊断 | D-039～D-041 原触发关闭；G3 FAIL；commit 未形成候选 | E2/E4 | 签名 commit `a79a34c316958070ed8a822d56fda22f14db85c5` 的 PR #4 run `29852008323` 中 release-chain 合同与 Compose/gateway/Quartz job PASS；quality job 在固定 Node 22/npm 11.18.0 的 Linux runner 完成安装、生成、迁移、OpenAPI、typecheck、lint、架构检查、server/worker、真实 PostgreSQL API/Worker、File Worker、DeerFlow、Web tests、浏览器 runtime 安装与 export integration，证明 D-039～D-041 的原始失败均已关闭。随后首个 Workbench smoke 在 Next dev 已 ready 后才冷编译 `/projects/[projectId]`，`page.goto` 30 秒预算先于冷编译导航完成而失败，形成 D-042；production build 与 route bundle 按 fail-fast 跳过。失败日志 SHA-256 为 `401694b30a0d956d86cd82a1627820341e93d4d0f46e88ff83921fce7af3592a`。该 commit 没有候选 tag、G1/G2 或真实 G0 包，不得作为发布候选。 |
| V-060 | 2026-07-21 项目路由预热后的第五轮 G3 与首页冷启动诊断 | D-039～D-042 原触发关闭；G3 FAIL；commit 未形成候选 | E2/E4 | 签名 commit `068792fa4ad079e605d2aeb340d59633631d28a7` 的 PR #4 run `29855070481` 中 release-chain 合同与 Compose/gateway/Quartz job PASS；quality job 再次完成安装、生成、迁移、静态检查、server/worker、真实 PostgreSQL、File Worker、DeerFlow、Web tests、浏览器 runtime 与 export integration。项目动态路由在独立 90 秒预算内完成冷编译，首个 Run Preview smoke 在默认 30 秒导航预算内 PASS，证明 D-042 原始触发关闭；随后第二个 smoke 首次导航 `/` 时冷编译独立首页 bundle并在 30 秒时超时，形成 D-043，production build 与 route bundle 按 fail-fast 跳过。失败日志 SHA-256 为 `6e18d733361b385aa89341a7356f85683827ad77db131f9a3c5f2607f22226b1`。该 commit 没有候选 tag、G1/G2 或真实 G0 包，不得作为发布候选。 |
| V-061 | 2026-07-21 双入口预热后的第六轮 G3 与导航采样诊断 | D-039～D-043 原触发关闭；G3 FAIL；commit 未形成候选 | E2/E4 | 签名 commit `abbef5db516a06c230db8791cb7e68d41de39903` 的 PR #4 run `29857428945` 中 release-chain 与 Compose/gateway/Quartz jobs PASS；quality job 完成安装、生成、迁移、OpenAPI、typecheck、lint、架构检查、server/worker、真实 PostgreSQL、File Worker、DeerFlow、Web tests、浏览器 runtime 与 export integration。浏览器启动明确输出 `/projects/project-run-preview, /` 均 ready，Run Preview、首页 approval/preferences 与 Board smoke PASS，证明 D-043 原始触发关闭；随后 Chromium Home-to-Project 因旧断言要求同时 `opacity > 0.001` 的可见重叠而失败，形成 D-044，production build 与 route bundle 按 fail-fast 跳过。失败日志 SHA-256 为 `01171b3e431d16e1707f49fbc943b4d468005d14f05ca1134ced50d81d6f2513`。该 commit 没有候选 tag、G1/G2 或真实 G0 包，不得作为发布候选。 |
| V-062 | 2026-07-21 同步挂载修复后的第七轮 G3 与透明端点诊断 | D-039～D-044 原触发关闭；G3 FAIL；commit 未形成候选 | E2/E4 | 签名 commit `369938a8444d6c137400c3cfd53b7b360b22a600` 的 PR #4 run `29860405435` 中 release-chain 与 Compose/gateway/Quartz jobs PASS；quality job 再次完成安装、生成、迁移、OpenAPI、typecheck、lint、架构检查、server/worker、真实 PostgreSQL、File Worker、DeerFlow、Web tests、浏览器 runtime 与 export integration。双入口、Run Preview、approval/preferences 与 Board smoke 均 PASS，Chromium Home-to-Project 也已通过 D-044 新增的 mounted overlap 断言；随后 opacity range 因排除透明挂载起点而把合法入场误判为变化不足，形成 D-045，production build 与 route bundle 按 fail-fast 跳过。失败日志 SHA-256 为 `a02feaef2c7caa4196580c86e74cca58c658ffbc4835252388e8b68b550b4168`。该 commit 没有候选 tag、G1/G2 或真实 G0 包，不得作为发布候选。 |
| V-063 | 2026-07-22 透明端点修复后的第八轮 G3 与 Home 位移采样诊断 | D-039～D-045 原触发关闭；G3 FAIL；commit 未形成候选 | E2/E4 | 签名 commit `4fadacb4e117b53e3ed369079871875675c52daa` 的 PR #4 run `29862838335` 中 release-chain 与 Compose/gateway/Quartz jobs PASS；quality job 再次完成安装、生成、迁移、OpenAPI、typecheck、lint、架构检查、server/worker、真实 PostgreSQL、File Worker、DeerFlow、Web tests、浏览器 runtime 与 export integration。双入口、Run Preview、approval/preferences 与 Board smoke 均 PASS，Chromium Home-to-Project 已通过 D-045 的 mounted opacity endpoint 断言；随后 transform progression 因只保留可见且非 `none` 的样本而把合法 Home 位移误判为静态，形成 D-046，production build 与 route bundle 按 fail-fast 跳过。失败日志 SHA-256 为 `13ce5db9d23e31e3c7bf7a287cece53dc876722f5284149beba9f6ed3ef64b6f`。该 commit 没有候选 tag、G1/G2 或真实 G0 包，不得作为发布候选。 |
| V-064 | 2026-07-22 首个完整 G3 候选及强制复跑诊断 | G1/G2 PASS；G3 attempt 1 PASS；attempt 2/3 分别形成 D-047/D-048；G0 NOT RUN；候选已淘汰 | E2/E3/E4 | 签名 commit `2665575f5a8b4f0dad6fd6bdf12bcb3f614d4c56`、tag `workbench-remediation-20260722-2665575f` 形成 candidate `sha256:a59dd78978eabd7b6721fe045cc693aa2226a6e750fead912dee1eb7a9aebbf1`；G1 manifest/inventory SHA-256 为 `d8c5d75f291e5e6614d017573cfbf4d1267c9a2752fcc44984ee7aa8ee21758e`、`0066bb8c6e4a426854904c262ea1201948c5c4d436b308cff2686f17ba5925f7`，G2 receipt 为 `b4e9e9d60a25d5a076d72ffbf21b630646b68013b5d6268f5438da74c54adfd4`。run `29866702430` attempt 1 完整通过 quality、全浏览器、production build、route bundle 与 Compose/gateway/Quartz，快照 SHA-256 `9f24143a0d996b1d0a5418c4a0f28491b29a15d376c5d14d5231a109e156653b`；强制复跑随后暴露 D-047/D-048，因此没有沿用该 PASS。候选绑定 G5 技术预检完成 fresh/真实旧版本升级、least privilege、backup/restore，RPO 2.708s、RTO 2.224s，receipt SHA-256 `8f3f8861b684ef48e818c9f2c2d4952b6dee19815e8be8ae8c0c802ec8c2ed04`；G4 技术构建在 8/10 Workbench 镜像和已完成镜像零 HIGH/CRITICAL 后主动停止，未伪造正式 OIDC/Cosign/provenance。 |
| V-065 | 2026-07-22 D-047/D-048 本地修复矩阵 | 本地 PASS；新 clean candidate/CI 待执行 | E4 | 固定 Node 22.22.0/npm 11.18.0 下，定向合同 34/34、完整浏览器矩阵、root test、typecheck、lint、506 模块/1671 依赖架构和 release-chain 8/8 均 PASS；对应 SHA-256 为 `694939d29ef7272c7c5cb901e89455d37edfdd28c898c810a716242ea0ea42e6`、`5c1f75d2b3f7fa78fa3d05f01f4f455d6f497319e9a7153aacefa28b2800f39e`、`f29b41e15109874f9fc3c14489f7aaaa1fc02c64f332606e8a72d43a5fe53d3a`、`bbaaf731257e3d7e6e5b3e2ae743859d22cfb7f4069ee69bbb25c915d2cf1645`、`4e4ad8bbf5e26ed8a8859f8f782afaedac831829808d7be93652a92a97cb3b51`、`2a43bedf148c5a1e3025a05325c7af0df09c95a6f5fcdfc013b858951e083b0b`、`cf42db223a41205184026d9b4b0f7e8c16ae5b7b2af19ab4654f23f40ada802d`。官方 Gitleaks 8.30.1 对最终 2,099 个 tracked/untracked 非忽略源码文件扫描零命中，空 JSON 报告 SHA-256 为 `37517e5f3dc66819f61f5a7bb8ace1921282415f10551d2defa5c3eb0985b570`。这些结果不升级为候选绑定 G3。 |

注意：本轮超大 working-tree review 的 conventions finder 和最终 gap sweep 曾因 prompt too long 未完成；因此本文是经过多角度、去重和验证的高覆盖审查，但不得宣称绝对无遗漏。

本轮补充本地日志（dirty tree/E4，均位于本机 `/private/tmp`，不是不可变外部 ledger）：

| 对象 | 原始日志 | SHA-256 |
|---|---|---|
| Web unit/component tests | `/private/tmp/workbench-remediation-20260720-cont/web-test.log` | `32c4b05497b6f3456f1e6d72b097bb3556417889714d5203378671ba89e77f91` |
| Root `npm test` 复核（最终含 upload wrapper） | `/private/tmp/workbench-remediation-20260721-full-test-final.log` | `bb8100d1bf1ea45af358b7e1524b7dfca17748b5cba5add1f20dd2ce45051915` |
| Root `npm test` 复核（secret-scan remediation 后） | `/private/tmp/workbench-remediation-20260721-full-test-after-secret-fix.log` | `19cdc4dd107eb4842079e8397f94793e5be912c25f2c2d31bdf8298c2f2d8ae8` |
| Root `npm run typecheck` 复核 | `/private/tmp/workbench-remediation-20260721-typecheck.log` | `8b48e6a64a926d01902ec335028305b3aa59c49b28e43b71a3a2c183b463aeac` |
| Root `npm run typecheck` 复核（secret-scan remediation 后） | `/private/tmp/workbench-remediation-20260721-typecheck-after-secret-fix.log` | `a856acc54839aca65d5b65b23c6bc0e9e7629ea1baa64be8edec7819427625ae` |
| Workbench lint | `/private/tmp/workbench-remediation-20260720-cont/lint-workbench.log` | `4e4ad8bbf5e26ed8a8859f8f782afaedac831829808d7be93652a92a97cb3b51` |
| Workbench architecture | `/private/tmp/workbench-remediation-20260720-cont/architecture-workbench.log` | `1a6ccd5457006b1a76b1a36e17fbabc67f0ccd128295a036cd0a15e3528f0561` |
| DeerFlow tools | `/private/tmp/workbench-remediation-20260720-cont/deerflow-tools-test.log` | `84d3dec23b4311f838db046fc9f5f0d88d31a3ebf36a23c00815dc508c7fc529` |
| File Worker PostgreSQL integration UTF-8 | `/private/tmp/workbench-remediation-20260720-cont/file-worker-postgres-integration-utf8.log` | `005efaf706500c85f304407f9dfb9213524c6c813350f55fcfba132c980b5188` |
| PostgreSQL constraints UTF-8 | `/private/tmp/workbench-remediation-20260720-cont/postgres-constraints-utf8.log` | `00931f186983be1ebf32b8f3ab2563598ee5e12912af386b97bdb2ebbe06a7b6` |
| PostgreSQL HTTP client UTF-8 | `/private/tmp/workbench-remediation-20260720-cont/postgres-http-client-utf8.log` | `c7f30f625771376586833c2a37812c4a7d59c4a44dbe9581b99071f811055735` |
| PostgreSQL HTTP E2E UTF-8 | `/private/tmp/workbench-remediation-20260720-cont/postgres-http-utf8.log` | `48058f9523ad2f9e5a7d56ec77f4f6c930f7c5eab0d795bd07be3513503145bb` |
| G5 real PostgreSQL recovery drill | `/private/tmp/workbench-remediation-20260720-cont/g5-postgres-recovery-test-real.log` | `a42924dbe41753bad45e4b7f5750ffd44413cf15d04308c6341690ac558dc14a` |
| Browser matrix aggregate | `/private/tmp/workbench-remediation-20260720-cont/e2e-web.log` | `0accd2e125fc33342785824673a5886ce0fe91cafc510822c2f11c0766b0d044` |
| Browser run-preview standalone | `/private/tmp/workbench-remediation-20260720-cont/e2e-web-run-preview-served.log` | `f24e6bd4b97b097ee0087486e1fad558050fedd799055308217104468af132e3` |
| Browser approval/preferences standalone | `/private/tmp/workbench-remediation-20260720-cont/e2e-web-approval-preferences-served.log` | `bbd3c8e8f448652287851a4b4a8e9d1034d964d87a3f1c8bb2e42e4141dc0435` |
| Browser board standalone | `/private/tmp/workbench-remediation-20260720-cont/e2e-web-board-served.log` | `02256e871f1cf996cfa976cc91f115c770c319b789852d8e36f027a1865b4b2a` |
| Navigation guard Chromium | `/private/tmp/workbench-remediation-20260720-cont/e2e-web-navigation-guard-chromium-served.log` | `945ba62ea943cf71dcea878bd22ca16d0fe6d9dd71952fed06a24bac251d545e` |
| Navigation guard Firefox | `/private/tmp/workbench-remediation-20260720-cont/e2e-web-navigation-guard-firefox-served.log` | `1f55d4684fc84ae61c9d20a97f6a4d5e52ca912db6082b8509acfdd99b94cce6` |
| Navigation guard WebKit | `/private/tmp/workbench-remediation-20260720-cont/e2e-web-navigation-guard-webkit-served.log` | `62a914de209da4fa777197aa277bcf1ba4bf7fbeff33990e490ecd07e7f4dced` |
| Browser design-system standalone | `/private/tmp/workbench-remediation-20260720-cont/e2e-web-design-system-served.log` | `f4cf91dbfddb85222ff776438e07b410caafcc3f397fdefcd4221ca96bef1e16` |
| Browser exports standalone | `/private/tmp/workbench-remediation-20260720-cont/e2e-web-exports-served.log` | `a8ce5e618e01890aba4139ffc583ee606f2b51212551d45b32bded75b0833160` |
| Browser isolated preview standalone | `/private/tmp/workbench-remediation-20260720-cont/e2e-web-preview-served.log` | `44e8cbc51e67c26766d5ecd41290faebbd00f81e2c6ffb58ece42df9e3e33e9b` |
| Production build, missing upload Origin fail-closed | `/private/tmp/workbench-remediation-20260720-cont/build-final.log` | `c6c68eaca8b8268fb3a4c98a25208c7efa08e6cabf203a83e1b36d6866207918` |
| Production build with example upload Origin | `/private/tmp/workbench-remediation-20260720-cont/build-final-with-upload-origin.log` | `3014401682e25a802a0bb06b7e6bb79f6a88c1ceb5f7b891125c6353c50dd7a7` |
| Production build with example upload Origin (secret-scan remediation 后) | `/private/tmp/workbench-remediation-20260721-build-after-secret-fix.log` | `66e27aabcea7cef68d4083a64ebc8396601ff641c6dd5ccf7fb958556d345ad9` |
| Final Worker regression | `/private/tmp/workbench-remediation-20260720-final-worker-test.log` | `d730576720833c242e1dc53b306e3a73620ddac18b52f4be76fb950c110c3a07` |
| Final DeerFlow tools | `/private/tmp/workbench-remediation-20260720-final-deerflow-tools.log` | `4b68f7314f13cf356dbf0a87cc7f03b18db97a36d2ec03c84989d32d5aa18585` |
| Final DeerFlow deployment suite | `/private/tmp/workbench-remediation-20260720-final-deerflow-deployment.log` | `e721fcdec15bc702d9ef6f66ec5d1f773814131fe2495a2f5958151c66d6b14b` |
| Final Knowledge smoke contracts | `/private/tmp/workbench-remediation-20260720-final-knowledge-contract.log` | `e35225c176a6c968e1d713b05adc71ac04919ca32b468a41fe6405c9087be58c` |
| Final Worker typecheck | `/private/tmp/workbench-remediation-20260720-final-worker-typecheck.log` | `9513530654a138951e602dc6fbb7a790c9fe5814b54ac2af6ae43c27beaed14e` |
| Final Worker build | `/private/tmp/workbench-remediation-20260720-final-worker-build.log` | `40785a18918606a06eb3b934db7c340e7fa642b430c53d058cc6f293d109c086` |
| Final DeerFlow deployment check | `/private/tmp/workbench-remediation-20260720-final-deerflow-deployment-check.log` | `3252d9de0e6d29a9a5a7467c535c6785dfa1f83f546c48b7536312af7cbe81de` |
| R0 candidate manifest diagnostic (after secret-scan remediation) | `/private/tmp/workbench-r0-preflight-20260721-after-secret-fix/candidate.json` | `2cf90c6a2f76b8e2347e349e99063fa751ea28616b2562a3c9ee6a1ef916b44a` |
| R0 candidate inventory diagnostic (after secret-scan remediation) | `/private/tmp/workbench-r0-preflight-20260721-after-secret-fix/inventory.ndjson` | `15c3de972c99783ac09dd5627c4921e60060913a28d17f7ac63d742a8f89190f` |
| R0 candidate receipt diagnostic (after secret-scan remediation) | `/private/tmp/workbench-r0-preflight-20260721-after-secret-fix/receipt.log` | `f2f9b6fc5e423a1c33edece64bdd1f59e082326502d4f5533fd2b1eef2027632` |
| Independent source secret scan (文档更新后脱敏摘要) | `/private/tmp/workbench-remediation-20260721-source-secret-scan-after-doc.json` | `1737192d41b6d42ffd641929a2972dee967f9a1f01dff19bd168e66dd24ae7c6` |
| Clean source candidate root `npm test` | `/private/tmp/workbench-remediation-20260721-clean-candidate-jYv0Zd/npm-test.log` | `6940d49bc22ebbda2a624809849fcbca686eef19a39755c4660e532fe0dc8121` |
| Clean source candidate root `npm run typecheck` | `/private/tmp/workbench-remediation-20260721-clean-candidate-jYv0Zd/typecheck.log` | `4f8ebebed5978a6451f47693ec704dc5368dba515f9ba2abc8ba65ca3cdcc541` |
| Clean source candidate production build | `/private/tmp/workbench-remediation-20260721-clean-candidate-jYv0Zd/build.log` | `ba16806930ec070924f56940b731b6799343c195723af4634faec7c8560cf0c4` |
| Clean candidate generation round 1/2 (`prepare` + `brand`) | `/private/tmp/workbench-remediation-20260721-clean-candidate-jYv0Zd/prepare-1.log`, `brand-1.log`, `prepare-2.log`, `brand-2.log` | `74460ec1a6ee3eb4b7b8b1b3c59427a2e5aa0de0f8e41e8ba9fa6000ec6567cb`, `8fc9a96a5266d1d5fdbda2163388696a8381788d78039a8ced27dc33adcc9535`, `371d5494beb56b3161bbb77a215fb28df2ec408d89f3f4d631bb7692f0100eeb`, `8fc9a96a5266d1d5fdbda2163388696a8381788d78039a8ced27dc33adcc9535` |
| Knowledge real storage-root verification | `/private/tmp/workbench-remediation-20260721-knowledge-storage-root-verify.log` | `06ba54587d05539b8335528edb2fde8e036d930bb2ea182cc077ef4108a4b3e6` |
| Knowledge missing storage-root negative verification | `/private/tmp/workbench-remediation-20260721-knowledge-storage-root-missing.log` | `1d492b9559bcb27fd46db408444c89482c27af5ab43e2423f0a981b867e7c265` |
| Brand asset regeneration after clean lockfile install | `/private/tmp/workbench-remediation-20260721-brand-regenerate.log` | `8fc9a96a5266d1d5fdbda2163388696a8381788d78039a8ced27dc33adcc9535` |
| Knowledge asset-closure metadata fixture | `/Users/liyannong/ai-product-workbench/packages/workbench-knowledge/test/fixtures/knowledge-storage-asset-closure.v1.json` | `3d86823b3321bd33b50f3150d736bfda4aef8e30902c560e3f3c378e1a9ac2cc` |
| Full synthetic G1 candidate manifest rehearsal | `/private/tmp/workbench-synthetic-full-20260721-v2/artifacts/candidate.json` | `4cd70d6f5ce2ff2db9129f6ec7439ceceb20d45fd0ad782d1179d3d9a76c2e49` |
| Full synthetic G1 inventory rehearsal | `/private/tmp/workbench-synthetic-full-20260721-v2/artifacts/inventory.ndjson` | `2c73855c4398c705c7dce880c9869ea957bde4777b078a909bb698a787d84f93` |
| Full synthetic G2 reproducibility receipt rehearsal | `/private/tmp/workbench-synthetic-full-20260721-v2/g2-receipt.json` | `27a459ead307b02ab6c92bc33fb43e290a224d3ed201b68f0e841556e3f7eaf4` |
| Full synthetic G0 approval rehearsal | `/private/tmp/workbench-synthetic-full-20260721-v2/chain/g0-approval.json` | `bcbc6c196a6118f60a52b219479b4c23fda3045c20be8564cdae055a9932fc19` |
| Full synthetic release-chain verification rehearsal | `/private/tmp/workbench-synthetic-full-20260721-v2/chain/release-chain.json` | `7791432015b312169c26201b2adeaf1a9fad83aa1d91357fc57808a1a461c817` |
| Negative synthetic G2 receipt（不完整 2072-file snapshot） | `/private/tmp/workbench-synthetic-release-nnGdR7/g2-receipt.json` | `b1325c3406626879133f066fbfd094b940c3bd399034123b7c3a3ef186b6e17d` |
| 2026-07-21 post-upgrade target-environment gate recheck（脱敏原始日志） | `/private/tmp/workbench-remediation-20260721-post-upgrade-gates-20260721.log` | `eda0f4658485968f19ec60894a5409e7e9484e8171fe703c094cd237e5af3d1e` |
| Latest R0 candidate diagnostic manifest | `/private/tmp/workbench-r0-preflight-20260721-asset-closure-v2/candidate.json` | `52b0621706b1b268153e97aac9d2063f5298d852ef54664468ecd18482967903` |
| Latest R0 candidate diagnostic inventory | `/private/tmp/workbench-r0-preflight-20260721-asset-closure-v2/inventory.ndjson` | `bb39d2a5be92ff2402c668ae0d84c1f0c574d0d02c8c712f649bec21b25bda94` |
| Latest R0 candidate diagnostic receipt | `/private/tmp/workbench-r0-preflight-20260721-asset-closure-v2/receipt.log` | `8aeb44c394ce19b0163f190e1a959c7fe8239c159079137093eb800c9888b48d` |
| Main tree final root `npm test` | `/private/tmp/workbench-remediation-20260721-main-after-asset-closure-test.log` | `c5ea030141d28a2201eee7608be33ee6cddf6edca13e63399ebba0129999f2a6` |
| Main tree final root `npm run typecheck` | `/private/tmp/workbench-remediation-20260721-main-after-asset-closure-typecheck.log` | `0213ea34bfb515728ff3ab1e77169dfbd29325d8d55799ca4327815ff585bbdb` |
| Main tree final production build | `/private/tmp/workbench-remediation-20260721-main-after-asset-closure-build.log` | `24633598c1a5a3865c8904a93154714f2e23b0e7997c045e7f93a276a91b8ebd` |
| Main tree generation/status recheck | `/private/tmp/workbench-remediation-20260721-main-after-asset-closure-prepare-1.log`, `brand-1.log`, `prepare-2.log`, `brand-2.log` | `88bb5bdc9b7b26270ea9020b520eab05ec34253dee91ab9a194e624a1a88fb3d`, `8fc9a96a5266d1d5fdbda2163388696a8381788d78039a8ced27dc33adcc9535`, `803d37bfead5910c6a3695035271b771972499e54c963046f5f70a094095cfb8`, `8fc9a96a5266d1d5fdbda2163388696a8381788d78039a8ced27dc33adcc9535` |
| Final source secret scan summary | `/private/tmp/workbench-remediation-20260721-source-secret-scan-final-asset-closure.json` | `e5a54514ad92d4eece062d3d8e4fac2cd0c5a7e16681ee768853566fae2aa666` |
| 2026-07-21 DNS/provider example contract recheck | `/private/tmp/workbench-remediation-20260721-domain-provider-contract.log` | `ab83c393e13bd2e669d3f3475bd6874c503dff960917ece0457c228ec811212c` |
| 2026-07-21 root test after provider example correction | `/private/tmp/workbench-remediation-20260721-provider-example-root-test.log` | `9114b42a98d0e98384179d8f60baf5338a7d40cb689370cf3b6c7e6825e1e7c6` |
| 2026-07-21 provider example typecheck | `/private/tmp/workbench-remediation-20260721-provider-example/typecheck.log` | `be24c74b52c6e0ca5a3134941621c69f145f0d1918b4502e261cced709379a5f` |
| 2026-07-21 provider example production build with upload Origin | `/private/tmp/workbench-remediation-20260721-provider-example/build-with-upload-origin.log` | `b152d5068ae03c85b0d35884bb16bbdd95923299c44a03777ca6817030faba40` |
| 2026-07-21 provider example bare build fail-closed diagnostic | `/private/tmp/workbench-remediation-20260721-provider-example/build.log` | `8a25f8b00f34d263717d70b3de668914f579ec4a00f7feccea241f5ec122f2eb` |
| Final Gitleaks raw report | `/private/tmp/workbench-secret-scan-20260721-final-asset-closure/gitleaks-report.json` | `37517e5f3dc66819f61f5a7bb8ace1921282415f10551d2defa5c3eb0985b570` |
| Alibaba Cloud OSS IAM 60/60 evidence | `/private/tmp/workbench-oss-iam-conditional-20260721T101204Z.json` | `52803ec1f44860b772b4aa0883d511e0ee994dbe24a0cba64df6fbd2cd22051a` |
| Public OSS multipart upload 13/13 evidence | `/private/tmp/workbench-oss-http-upload-20260721T104403Z.json` | `f9e8c4ea2d3f82ea157455c6a7e083b0f2dd78437804900da7f89127bc9a34f5` |
| OSS regression PostgreSQL fresh migrations + 328 constraints | `/private/tmp/workbench-remediation-20260721-oss-postgres-constraints.log` | `92484d511137bf8352767c217243bdb2b249454d610f512a9eb963c962d8da30` |
| OSS regression PostgreSQL API/Worker HTTP/SSE/Canvas | `/private/tmp/workbench-remediation-20260721-oss-postgres-http.log` | `663dbb3fbefeb596c14ffcb90ae2be550aae962cda5c2714f19aaad3631e5a7b` |
| OSS regression PostgreSQL File Worker/GC/Knowledge | `/private/tmp/workbench-remediation-20260721-oss-file-worker-postgres.log` | `6be9c2b0c823602793f74abac260523aea32f1e838736f8d3f8b7e020afffc53` |
| OSS regression PostgreSQL recovery drill 18/18 | `/private/tmp/workbench-remediation-20260721-oss-postgres-recovery.log` | `53210445348e082adbb8218b5a90a226acd81e08637911308de48666767c87b0` |
| OSS regression root test with PostgreSQL gates | `/private/tmp/workbench-remediation-20260721-oss-postgres-root-test.log` | `234a476c73dc993d87be6ea7deedf0d2a8d256930fe0392c6750e2726ff5a02f` |
| Final typecheck after OSS switch | `/private/tmp/workbench-remediation-20260721-oss-final-typecheck.log` | `6b1f1e709cf06cbca00708224e45a39ff06a81da0012ff5d7668d333f6bfee11` |
| Final root test after OSS switch | `/private/tmp/workbench-remediation-20260721-oss-final-root-test.log` | `e60b1afbc7a1a13c124134d7c2687c9bbf5adef320d2d1d36cbbe773482f051f` |
| Final Web tests after OSS switch | `/private/tmp/workbench-remediation-20260721-oss-final-web-test.log` | `1faf536f355c7404a0abfadc87b7f3b58591734d993728cd417184b1f71e54b4` |
| Final lint after OSS switch | `/private/tmp/workbench-remediation-20260721-oss-final-lint.log` | `4e4ad8bbf5e26ed8a8859f8f782afaedac831829808d7be93652a92a97cb3b51` |
| Final architecture checks after OSS switch | `/private/tmp/workbench-remediation-20260721-oss-final-architecture.log` | `3e82be17ecd0805daffda6c018504e09b89de5cf900a6ce8d1efe001c02d84d2` |
| Final OpenAPI breaking check after OSS switch | `/private/tmp/workbench-remediation-20260721-oss-final-openapi-breaking.log` | `e6299e97f4a8a9649fee790b72ce21f26b6de96fdd639bc1afed435428a52f34` |
| Final production build after OSS switch | `/private/tmp/workbench-remediation-20260721-oss-final-build.log` | `39433e75ce2e6fc95dfad7f0d8793a37768b16575ff26c6f46217fb23c848068` |
| Browser E2E first-run Firefox animation sampling failure | `/private/tmp/workbench-remediation-20260721-oss-e2e-web.log` | `29e9cc57c0d5351a441e44a6d61461bf2f62ed833097c950d01f197800bc6519` |
| Browser E2E unchanged full rerun PASS | `/private/tmp/workbench-remediation-20260721-oss-e2e-web-rerun.log` | `ee7a6a2860a9b27f83607faadfcad968d1c3822d7a1c5edfa1b4db562f50f336` |
| Final current-source and Git-history secret scan summary | `/private/tmp/workbench-source-secret-scan-20260721-oss-precommit.log` | `be8d9f299f30a0fad93450a18b2bce30562ad687d4afccaa59b9adbc1f4218ab` |
| D-041 60-item G0 contract | `/private/tmp/workbench-d041-g0-scope.log` | `4a948efdb96366299a36cece7a57b4b9b603c7cf6253b5bf8216e389613934fd` |
| D-041 final root `npm test` with npm 11.18.0 | `/private/tmp/workbench-d041-root-test-final.log` | `16b0ecca9537595e1164e5ca21c1ff99182cc117d9e9cfb17d398322ae7eb4d8` |
| D-041 root `npm run typecheck` with npm 11.18.0 | `/private/tmp/workbench-d041-typecheck.log` | `195288fb66f7ea885d53e2d5a59cda4b95ebf4417ceebe645a73474db1e69bbe` |
| D-041 PostgreSQL API/Worker HTTP/SSE workflow | `/private/tmp/workbench-d041-postgres-http.log` | `3da2704e5e6874a7992a57b7b960e104f9fa3d8986760c0959953fd913ebd329` |
| D-042 originating GitHub Linux CI failure | `/private/tmp/workbench-ci-29852008323-failed.log` | `401694b30a0d956d86cd82a1627820341e93d4d0f46e88ff83921fce7af3592a` |
| D-042 fixed-npm full browser E2E | `/private/tmp/workbench-d042-e2e-web.log` | `cfa743ac77868d86321044cd91319ae618697d9614e9e206a27b2611965ec847` |
| D-042 fixed-npm root `npm test` | `/private/tmp/workbench-d042-root-test.log` | `7e62bba433a415b73f07b9c2ac78fa35fba520bcce6ff5ed007ab97413e3bbfa` |
| D-042 fixed-npm root typecheck | `/private/tmp/workbench-d042-typecheck.log` | `8bf1811023151cac14947a9788f2125721bb0234a01f17fc91010dafd1108310` |
| D-042 lint | `/private/tmp/workbench-d042-lint.log` | `4e4ad8bbf5e26ed8a8859f8f782afaedac831829808d7be93652a92a97cb3b51` |
| D-042 architecture checks | `/private/tmp/workbench-d042-architecture.log` | `6e6f5f6400d5d0b2cf73fd064d1179c13310ccb177017897b97e72071b723b30` |
| D-042 release-chain tests | `/private/tmp/workbench-d042-release-chain.log` | `03df608a31a1a0635d905b7fc64cfb63687956c37cbe7914d294c71793d82de9` |
| D-043 originating GitHub Linux CI failure | `/private/tmp/workbench-ci-29855070481-failed.log` | `6e18d733361b385aa89341a7356f85683827ad77db131f9a3c5f2607f22226b1` |
| D-043 fixed-npm full browser E2E | `/private/tmp/workbench-d043-e2e-web.log` | `15bcff674c72dc6a53ee4ed5218a26539e2fda2d7ef7b0af988984dd5e00d4d2` |
| D-043 fixed-npm root `npm test` | `/private/tmp/workbench-d043-root-test.log` | `a99a26bb66e7a4788e366d9224be477e5c194548da09d5be6da4d3c0df6b26a8` |
| D-043 fixed-npm root typecheck | `/private/tmp/workbench-d043-typecheck.log` | `7cd0fa084ff2b5d0a7e486cd92dcef1423ee5256e74bf9e6c32aa98ba6f7c726` |
| D-043 lint | `/private/tmp/workbench-d043-lint.log` | `4e4ad8bbf5e26ed8a8859f8f782afaedac831829808d7be93652a92a97cb3b51` |
| D-043 architecture checks | `/private/tmp/workbench-d043-architecture.log` | `bfdfd1db097638c53a6e7fa292342359bc535a6ac1bd16a13a19f8625b5abf95` |
| D-043 release-chain tests | `/private/tmp/workbench-d043-release-chain.log` | `1c797c81d4eec75456764d3342c31f9bda79ded921be1ae9f46247be958711c7` |
| D-044 originating GitHub Linux CI failure | `/private/tmp/workbench-ci-29857428945-failed.log` | `01171b3e431d16e1707f49fbc943b4d468005d14f05ca1134ced50d81d6f2513` |
| D-044 targeted route-frame and 63-item G0 contracts | `/private/tmp/workbench-d044-targeted-contracts.log` | `f7a56c8e8aa01d2c9a5c96303ee0aefa8e38bcef1d0304ccc595a3200994cb91` |
| D-044 fixed-npm full browser E2E | `/private/tmp/workbench-d044-e2e-web.log` | `f62073830b25af8d3ea313b700dc849f03f3189cfe5dc364e6526ce55635691d` |
| D-044 fixed-npm root `npm test` | `/private/tmp/workbench-d044-root-test.log` | `a1c4c71cc33fa45a4471111a10d2e180fb155c51621ee06bcc3e46a4e4b5ada5` |
| D-044 fixed-npm root typecheck | `/private/tmp/workbench-d044-typecheck.log` | `7f49ffdd7cf713ec3511e9d9d6fef21a03ec338f74668a0c68ce908de7983b89` |
| D-044 lint | `/private/tmp/workbench-d044-lint.log` | `4e4ad8bbf5e26ed8a8859f8f782afaedac831829808d7be93652a92a97cb3b51` |
| D-044 architecture checks | `/private/tmp/workbench-d044-architecture.log` | `788f4d03d46a1ae78d62f28e4be8345c90e31b4e9a6be1139355c6c5f4bf9acf` |
| D-044 release-chain tests | `/private/tmp/workbench-d044-release-chain.log` | `a6432563e8357c2708120d81fad05f748e565456f24d7219bf7a32dc8e48b8e7` |
| D-044 final current-source Gitleaks empty report | `/private/tmp/workbench-d044-gitleaks-final-report.json` | `37517e5f3dc66819f61f5a7bb8ace1921282415f10551d2defa5c3eb0985b570` |
| D-045 originating GitHub Linux CI failure | `/private/tmp/workbench-ci-29860405435-failed.log` | `a02feaef2c7caa4196580c86e74cca58c658ffbc4835252388e8b68b550b4168` |
| D-045 targeted route-frame and 64-item G0 contracts | `/private/tmp/workbench-d045-targeted-contracts.log` | `3c9f4cc45e19955ff784d3ceef7460a3ff456000590e6b0c8e38e9152ef217a6` |
| D-045 fixed-npm full browser E2E | `/private/tmp/workbench-d045-e2e-web.log` | `61b282831992c4c531cfb2012fa87c1be91e3748842cbfbb10d6ba2fc86f91fa` |
| D-045 fixed-npm root `npm test` | `/private/tmp/workbench-d045-root-test.log` | `bbf430995a8aa07b111e0c7b2587139271231a5ee31b704ddc371e50af00086b` |
| D-045 fixed-npm root typecheck | `/private/tmp/workbench-d045-typecheck.log` | `23c7866c3b0c0fe735ba012e35415a16c7be8f9dc754364cc11806836ab7d55c` |
| D-045 lint | `/private/tmp/workbench-d045-lint.log` | `4e4ad8bbf5e26ed8a8859f8f782afaedac831829808d7be93652a92a97cb3b51` |
| D-045 architecture checks | `/private/tmp/workbench-d045-architecture.log` | `2a43bedf148c5a1e3025a05325c7af0df09c95a6f5fcdfc013b858951e083b0b` |
| D-045 release-chain tests | `/private/tmp/workbench-d045-release-chain.log` | `e50153e7c1ea29345d56f29a578060e5c6ccef72ccad6151f2524625e0d040d5` |
| D-045 final current-source Gitleaks empty report | `/private/tmp/workbench-d045-gitleaks-final-report.json` | `37517e5f3dc66819f61f5a7bb8ace1921282415f10551d2defa5c3eb0985b570` |
| D-046 originating GitHub Linux CI failure | `/private/tmp/workbench-ci-29862838335-failed.log` | `13ce5db9d23e31e3c7bf7a287cece53dc876722f5284149beba9f6ed3ef64b6f` |
| D-046 targeted route-frame and 65-item G0 contracts | `/private/tmp/workbench-d046-targeted-contracts.log` | `330ac38e2698de4fbedfd3c5492fcdd123fc443121497c99b877cbaeff01d93b` |
| D-046 fixed-npm full browser E2E | `/private/tmp/workbench-d046-e2e-web.log` | `6b12ceb80b2f5400a153c78f2a262bd34578187ed35809b74ac1c711f55d39dd` |
| D-046 fixed-npm root `npm test` | `/private/tmp/workbench-d046-root-test.log` | `1e4ce35b54975f29a817854320b0d5aebd14d48120a95842d47f1e68b19b3b82` |
| D-046 fixed-npm root typecheck | `/private/tmp/workbench-d046-typecheck.log` | `da58cced68eea053b6f4a8873c1608604c2a67e05e332fafa14bcd1fd3967cb5` |
| D-046 lint | `/private/tmp/workbench-d046-lint.log` | `4e4ad8bbf5e26ed8a8859f8f782afaedac831829808d7be93652a92a97cb3b51` |
| D-046 architecture checks | `/private/tmp/workbench-d046-architecture.log` | `83e69d045f57478cee780927e56ece6d494e8458492bf2ff898ffb4d58d8be66` |
| D-046 release-chain tests | `/private/tmp/workbench-d046-release-chain.log` | `b3df152d542230477a2c1548d37435c1066b1cb68e6e74698c85a61900aaff19` |
| D-046 final current-source Gitleaks empty report | `/private/tmp/workbench-d046-gitleaks-final-report.json` | `37517e5f3dc66819f61f5a7bb8ace1921282415f10551d2defa5c3eb0985b570` |
| D-047 originating candidate rerun failure | `/private/tmp/workbench-ci-29866702430-attempt2-failed.log` | `de1b1d1026c34b5e1ec3ba4b6483bb5fc3961dde48a50f70492139e9be6bf1e8` |
| D-048 originating candidate rerun failure | `/private/tmp/workbench-ci-29866702430-attempt3-failed.log` | `c9b9c45ae3d0cec075f82535d32b1b42e89eb75aa45a5634a5c846044747a43f` |
| D-047/D-048 targeted startup, route-frame, and 67-item G0 contracts | `/private/tmp/workbench-d048-targeted-contracts.log` | `694939d29ef7272c7c5cb901e89455d37edfdd28c898c810a716242ea0ea42e6` |
| D-047/D-048 fixed-npm full browser E2E | `/private/tmp/workbench-d048-e2e-web.log` | `5c1f75d2b3f7fa78fa3d05f01f4f455d6f497319e9a7153aacefa28b2800f39e` |
| D-047/D-048 fixed-npm root `npm test` | `/private/tmp/workbench-d048-root-test.log` | `f29b41e15109874f9fc3c14489f7aaaa1fc02c64f332606e8a72d43a5fe53d3a` |
| D-047/D-048 fixed-npm root typecheck | `/private/tmp/workbench-d048-typecheck.log` | `bbaaf731257e3d7e6e5b3e2ae743859d22cfb7f4069ee69bbb25c915d2cf1645` |
| D-047/D-048 lint | `/private/tmp/workbench-d048-lint.log` | `4e4ad8bbf5e26ed8a8859f8f782afaedac831829808d7be93652a92a97cb3b51` |
| D-047/D-048 architecture checks | `/private/tmp/workbench-d048-architecture.log` | `2a43bedf148c5a1e3025a05325c7af0df09c95a6f5fcdfc013b858951e083b0b` |
| D-047/D-048 release-chain tests | `/private/tmp/workbench-d048-release-chain.log` | `cf42db223a41205184026d9b4b0f7e8c16ae5b7b2af19ab4654f23f40ada802d` |
| D-047/D-048 final current-source Gitleaks empty report | `/private/tmp/workbench-d048-gitleaks-final-report.json` | `37517e5f3dc66819f61f5a7bb8ace1921282415f10551d2defa5c3eb0985b570` |

本轮补充目标服务器 validation 日志（dirty tree/E3/E4，均位于本机 `/private/tmp`，包含服务器回执或服务器命令输出，不是不可变外部 ledger；日志不得含真实 root 密码或 OpenAI key）：

| 对象 | 原始日志 | SHA-256 |
|---|---|---|
| Server inventory | `/private/tmp/workbench-remediation-20260720-server/server-inventory.log` | `86017a2389afd0c1908c70cef7694265e6fcd5195c6180196cf9e77d6e9e34b5` |
| Runtime install | `/private/tmp/workbench-remediation-20260720-server/server-install-runtime.log` | `a454037c1861b7391cd2f8283bc1e4eeb0b9be3d7def06105fb243191df1bee1` |
| Node/Docker versions | `/private/tmp/workbench-remediation-20260720-server/server-node-docker-version.log` | `419d63ad6d3a0e76e62e8bf78e8519c6848f7a72f08b1525247a3f90cf9ea02c` |
| Strict worktree rsync | `/private/tmp/workbench-remediation-20260720-server/rsync-worktree-tight.log` | `016dd8e651f088120b2bdd40ff1ff8830cfe6cde58e958f801db561138a71417` |
| Server-validation preflight | `/private/tmp/workbench-remediation-20260720-server/server-validation-preflight.log` | `d7d4c98840c0ed8bcf005446c70530dc1e8b6a33b5c57ed2719e5ad701b01163` |
| Migrator image build before role fix | `/private/tmp/workbench-remediation-20260720-server/server-validation-migrate-build.log` | `4106c183eb7148548682be0be7e363d952a09b861a8a5748a3bc2a6ce2261efe` |
| Fresh migration failure before role fix | `/private/tmp/workbench-remediation-20260720-server/server-validation-migrate-run.log` | `f088fc1770bd2ebee9c852ca4afb2c416483809b4757946ef3b9b9cd6f307fd7` |
| Disposable validation reset after failure | `/private/tmp/workbench-remediation-20260720-server/server-validation-reset-after-migrate-failure.log` | `2d921eb9dd13b7c7be129202c979f043e67dac3db08e0847886b192447e5491e` |
| Migrator image rebuild after role fix | `/private/tmp/workbench-remediation-20260720-server/server-validation-migrate-build-after-role-fix.log` | `f4f1cb4188cebef04699715fc641da87316b260e82606d970d7a70687db0e4a1` |
| Fresh migration PASS after role fix | `/private/tmp/workbench-remediation-20260720-server/server-validation-migrate-run-after-role-fix.log` | `a597d110c8ad08111b67e26267365b3c515cd3bc45b67a9ce82241f970404b50` |
| Remote database role contract | `/private/tmp/workbench-remediation-20260720-server/server-validation-database-role-contract-test.log` | `1e0fc100ada7757d7f1da063afb11116ce0943dea2faf8f62f0c49edcc492d79` |
| Remote database role privilege probe | `/private/tmp/workbench-remediation-20260720-server/server-validation-database-role-privileges.log` | `fe30c35eafcb6ffb657cee56a894c3e2ed3aa5e0f553f1082c700dd88213e4c5` |
| Runtime CREATE SCHEMA negative probe | `/private/tmp/workbench-remediation-20260720-server/server-validation-runtime-create-schema-negative.log` | `c1e4184f65153a32e4e4796090075de3b550f7f332dc53b032622877ebadeee9` |
| DNS target mismatch before domain clarification | `/private/tmp/workbench-remediation-20260720-server/dns-datatoken-target.log` | `90b40797ab2d3151689831ddd409be7aba84fbab06e1128ea903b702625ee0a1` |
| Recursive DNS after `aionbench.com` change | `/private/tmp/workbench-remediation-20260720-server/dns-aionbench-after-change.log` | `1f05e4fbd3c267391739052f5efd1a8516c02b8fea704e754cc945df9414ede7` |
| Authoritative DNS after `aionbench.com` change | `/private/tmp/workbench-remediation-20260720-server/dns-aionbench-authoritative-after-change.log` | `9284ca0ef8dd45e600b0262818bf99761a455b22c659452599665d0915c103aa` |
| Server-validation preflight after `aionbench.com` env/Dex correction | `/private/tmp/workbench-remediation-20260720-server/server-validation-preflight-after-aionbench-dns.log` | `95b0303b9334d09d04f06a2c292bbf980bd4cdd76cb06544e93f89f0298e72f0` |
| Recursive DNS after TTL recheck | `/private/tmp/workbench-remediation-20260720-server/dns-aionbench-recursive-after-ttl.log` | `eb2286967599b1e8b2182225855379c99a3460edd49e9ce5de656c3253d5208c` |
| Server validation image build failure before Web Dockerfile fix | `/private/tmp/workbench-remediation-20260720-server/server-validation-workbench-images-build-after-aionbench-failed.log` | `e88931edbd5a081f162209e814c5e47212825d3ce8099ed96f7e373278615f8a` |
| Server validation image build PASS after Web Dockerfile fix | `/private/tmp/workbench-remediation-20260720-server/server-validation-workbench-images-build-after-web-dockerfile-fix.log` | `a73d7a7cd3441ceb6b5bc87228e555362a63f1ee92a860b04117142373ed68ff` |
| Server validation image inventory after Web Dockerfile fix | `/private/tmp/workbench-remediation-20260720-server/server-validation-image-inventory-after-web-dockerfile-fix.log` | `dc675a8030b96a7385ea959428ae8c66c4b38804a5889d14b854ce36518ec001` |
| API image rebuild before `sharp` lockfile fix | `/private/tmp/workbench-remediation-20260720-server/server-validation-api-image-build-after-sharp-fix.log` | `d6912ab65654566cb8c2da27ffdf59b17e52025dd478933ba175ee1ff49d9911` |
| API `sharp` runtime failure before lockfile fix | `/private/tmp/workbench-remediation-20260720-server/server-validation-api-image-sharp-after-fix.log` | `e572ec7f621fe478b78f5f290bef4521678db2b10251e05a69c9dd4b4efafeee` |
| API image rebuild after `sharp` lockfile fix | `/private/tmp/workbench-remediation-20260720-server/server-validation-api-image-build-after-sharp-lock-fix.log` | `d330504371e8d35f75606228afb06e9230596f4fb057ef4fc8693b2242039a3d` |
| API `sharp` runtime PASS after lockfile fix | `/private/tmp/workbench-remediation-20260720-server/server-validation-api-image-sharp-after-lock-fix.log` | `9726ea88d82f5e23bdcb45a8ad127bb93f07f244b9b3c68c670e2e9d619810f2` |
| DeerFlow image blocker | `/private/tmp/workbench-remediation-20260720-server/server-deerflow-image-blocker.log` | `c943d21b579c0fbef4ed94bb0cc99342183ad78d66c8a2c3b2c8fbee1bd3306d` |
| Dex config permission fix | `/private/tmp/workbench-remediation-20260720-server/server-validation-oidc-permission-fix.log` | `75c82facfbc8ae57bde49b7b1b5de010cd1525631a7becf8fca5462099db158b` |
| Partial validation stack before API `sharp` fix | `/private/tmp/workbench-remediation-20260720-server/server-validation-partial-stack-up.log` | `bbc32d500d5399999dcb05ad41616a459687933ef84ca7591c8fa0b941b14eea` |
| API startup failure details before `sharp` fix | `/private/tmp/workbench-remediation-20260720-server/server-validation-api-start-failure-details.log` | `cdb5d559f31853e1f60a1868aa90701683a46e50d03f9f02b9ff5dbb7c189264` |
| API live/ready retry after `sharp` lockfile fix | `/private/tmp/workbench-remediation-20260720-server/server-validation-api-live-ready-retry-after-sharp-lock-fix.log` | `0d0f7248d562ffc3494a42747632c23855c142948fd4b63bb556b3cae3be8893` |
| API ready direct probe after `sharp` lockfile fix | `/private/tmp/workbench-remediation-20260720-server/server-validation-api-ready-after-sharp-lock-fix.log` | `f45978e7dde51a8673eb1f70eeccecec306073a2faace41e798c6fb138f59ea1` |
| Web start blocked by API `/ready` healthcheck | `/private/tmp/workbench-remediation-20260720-server/server-validation-web-start-after-api-live.log` | `330c3e8ba0969c549f8212ac006173633688faf910de542fa9e7a7bdab6df06d` |
| Remote DeerFlow source inventory | `/private/tmp/workbench-remediation-20260720-server/server-validation-remote-workbench-deerflow-source-inventory.log` | `37f5a46542681341a7d81b529e5f3b9c4620be7ee98bbe0f12f045579779c871` |
| DeerFlow derived image build | `/private/tmp/workbench-remediation-20260720-server/server-validation-deerflow-derived-image-build.log` | `8f8fd43f76c70f375d24404a25ca4198650112fbd4775a60551ddd5737dd68b0` |
| DeerFlow derived image inspect/probe | `/private/tmp/workbench-remediation-20260720-server/server-validation-deerflow-derived-image-inspect-probe.log` | `c3986e20d18992510ca04077877ebeb4ec4992ca1755b411ddc934d42574939d` |
| Cosign install | `/private/tmp/workbench-remediation-20260720-server/server-validation-install-cosign.log` | `80f5232e208bffb33c3a30992d6fd394b2a2cf215cdd387da7ac514d1a2d2959` |
| YAML install for remote preflight | `/private/tmp/workbench-remediation-20260720-server/server-validation-install-yaml.log` | `422977967aef8448f00c399ab08ce10c1cbba5783e33dde8ba77ee5a84bfa306` |
| Remote secret attestation materialization | `/private/tmp/workbench-remediation-20260720-server/server-validation-attestation-create.log` | `263f83b7ea8a1bff5ad24bcfe3b910d73f971e1d4a620d83fbcb7d55a01c681d` |
| Cosign verify-blob on empty manifest bundle | `/private/tmp/workbench-remediation-20260720-server/server-validation-cosign-verify-blob.log` | `d2e35153424fd93ca3d0bffc977117c87e1fd8161acb4f41481e264e7f078873` |
| DeerFlow preflight after attestation | `/private/tmp/workbench-remediation-20260720-server/server-validation-deerflow-preflight-after-attestation.log` | `53359cb1e6f5f10ea2d3fc7dc053b7aa6d82c80ff2b68dbd25b265db1efa1ab8` |
| Stop partial validation services after evidence | `/private/tmp/workbench-remediation-20260720-server/server-validation-stop-after-evidence.log` | `1db4ce7a4510de20d32332e6ac3f130fd120caa85419d4a0a8227504bdc20271` |
| Stop limited validation stack after API/Web evidence | `/private/tmp/workbench-remediation-20260720-server/server-validation-stop-after-limited-stack-evidence.log` | `2eafe21a9ee8ce8b84dccdd8070f27ab7ac0443eec722ddcc2237e5fcbfbfe47` |
| Local database role contract after role fix | `/private/tmp/workbench-remediation-20260720-server/local-database-role-contract-test-after-role-fix.log` | `a019c7834c32937017d1c35e202530dc44f624fbb28cf4dacaddf7422f77be3a` |

本轮最终高信号日志保留在授权服务器 `/opt/workbench/deploy/`。以下 SHA-256 已从服务器文件重新计算；这些仍是可变服务器文件系统上的 E3/E4 validation evidence，不是绑定 clean candidate 的不可变 ledger：

| 对象 | 服务器原始日志 | SHA-256 |
|---|---|---|
| Final DeerFlow build | `/opt/workbench/deploy/server-validation-deerflow-nonprototype-delegation-build.log` | `d9260e3a6d2d55cb7df87869553f5a03d3dc29b69c7ec9e01b73dbc432ae569e` |
| Final Runtime Worker build | `/opt/workbench/deploy/server-validation-runtime-worker-nonprototype-delegation-build.log` | `edd80fe4461ae6bb026f2c27770c169b1f60b1dd0b107f88b535a052f68b475c` |
| Final validation rollout | `/opt/workbench/deploy/server-validation-nonprototype-delegation-rollout.log` | `0b8d29644eb0409c4fd312a89a7a86a0f07b936f712dd09d6358d3b2c2afb479` |
| Base Gateway runtime smoke | `/opt/workbench/deploy/server-validation-runtime-smoke-after-delegation.log` | `71e0e097cabb2ef06b360b26aaa77728b2b1740e1ad75ac0e7a5aa22b4482272` |
| Clean Worker queue smoke | `/opt/workbench/deploy/server-validation-deployed-worker-runtime-smoke-clean.log` | `ca89f0744be8fc3625d3f5d7fa77077a19b51b4dcf055ef951af8cecfd1e62a7` |
| Clean Worker queue SQL crosscheck | `/opt/workbench/deploy/server-validation-deployed-worker-runtime-smoke-clean-crosscheck.log` | `11b2b94b286823d72074a95a5d1f51e572736ce11c9c262b4b5a62c49e254985` |
| Secret-channel valid-token smoke | `/opt/workbench/deploy/server-validation-secret-channel-valid-token-smoke.log` | `ca4ecc432e3aeda204b3d68324b3272c799df00921718fa656e351e7294c9613` |
| Final health and temporary-route cleanup crosscheck | `/opt/workbench/deploy/server-validation-final-health-cleanup-crosscheck.log` | `553e285353f6841b3242f44f7433bb3800c833cbcaedd8fdedde55e95c6d421c` |
| Negative: non-Prototype stage transition failure | `/opt/workbench/deploy/server-validation-deployed-worker-runtime-smoke.log` | `5f926ec6b3424d4f1188f8b26a948301b1a321aab96bc9a3373fd7b01c87232e` |
| Negative: delegated result submission missing | `/opt/workbench/deploy/server-validation-prototype-tool-scope-deployed-worker-runtime-smoke.log` | `8bb48239e4e8bc40cb41f06d83fa343791fa3ffef882639762a31ce2bf370ffc` |
| Negative: validation fixture missing Board | `/opt/workbench/deploy/server-validation-nonprototype-delegation-deployed-worker-runtime-smoke.log` | `b9e42fee0fe68438705c90632d60509e0ae2654b3ea7d69c1fd27841d9e7a996` |
| Stale validation fixture/job cleanup | `/opt/workbench/deploy/server-validation-stale-fixture-cleanup.log` | `9a1b179941eaac823dd39e07448579acc5342c8451850a65685383230931d88f` |
| 2026-07-21 direct-origin/public/server recheck | `/private/tmp/workbench-remediation-20260721-current-topology-recheck.log` | `59baee54e5244e784b6c5845d458695ccd8d3dfa325dd4951e469bf775cb107b` |
| 2026-07-21 CSP/font + direct-origin recheck | `/private/tmp/workbench-remediation-20260721-csp-direct-origin-recheck.log` | `6fbfe96f0cf61eaa55eac9ad1e77510d85f3731526afaac1f7e85ec99aa95fb0` |
| 2026-07-21 reversible OTLP collector + direct-origin Worker trace smoke | `/private/tmp/workbench-remediation-20260721-otel-direct-origin-validation.log` | `934efcca7b979311e65445198260d348d75daa9fbc3e37bbb4fa72a0269689fb` |
| 2026-07-21 public direct-origin/provider recheck | `/private/tmp/workbench-remediation-20260721-public-topology-recheck.log` | `e85f3ff063ef1dd89be33f9a2018fc2f9c5ea56a8e40ef7d37740ab9f553219a` |
| 2026-07-21 production CI dependency contract correction | `/private/tmp/workbench-remediation-20260721-ci-contract-correction.log` | `3e1361a155cddb3b495ff3d6b940405dbbd5ceab21a152d4dbdaf682f41f68e4` |
| 2026-07-21 server validation rollout interrupted by server upgrade | `/opt/workbench/deploy/server-validation-resume-rollout.log` | `4da24b3ab4e7600dd96b1a4f87df16105710b553c43ac156b07c92984b134dc7` |
| 2026-07-21 post-upgrade validation rollout | `/opt/workbench/deploy/server-validation-post-upgrade-rollout-20260721.log` | `d965661f9a423475eb29551eb1d59ae1a21b3f2e396075f21a362855771fb5f3` |
| 2026-07-21 post-upgrade validation preflight | `/opt/workbench/deploy/server-validation-post-upgrade-preflight-20260721.log` | `d9cc68b1050e1c113d8c1ae175f23545c0797a11823e92ae623b6e8ae11c96b7` |
| 2026-07-21 post-upgrade Worker queue smoke | `/opt/workbench/deploy/server-validation-post-upgrade-worker-smoke-20260721.log` | `52ead9fef7f9e138f05c80a4dc2e5085e547b69411e87839d6a45cbc677ecd4e` |
| 2026-07-21 post-upgrade direct DeerFlow runtime smoke | `/opt/workbench/deploy/server-validation-post-upgrade-runtime-smoke-20260721.log` | `d96ccbbed2b8ea87581c7e8c7e0b9b928b6b7c62d3dca5431f15f9b239e50eff` |
| 2026-07-21 post-upgrade local root test | `/private/tmp/workbench-remediation-20260721-post-upgrade-local-test.log` | `1081e1eebdebb2aa801c4dadca30b242d22b8fe1d183d8bdb472e9d382871a26` |
| 2026-07-21 post-upgrade local typecheck | `/private/tmp/workbench-remediation-20260721-post-upgrade-local-typecheck.log` | `7672a914a71e1cfd2335db1144d3455180564218676f5bff0c2b3d35899fafa5` |
| 2026-07-21 post-upgrade R0 candidate manifest diagnostic | `/private/tmp/workbench-r0-preflight-20260721-post-upgrade-local/candidate.json` | `fa995396150dc53d6eb08f6dde85e4c5cdf5ffcee5a0e23d5bfde7c45a714d50` |
| 2026-07-21 post-upgrade R0 candidate inventory diagnostic | `/private/tmp/workbench-r0-preflight-20260721-post-upgrade-local/inventory.ndjson` | `c028e1cf581c3f2a61b2afd950f7bcb393ea9cde5510158db236317b10c962d8` |
| 2026-07-21 post-upgrade R0 candidate receipt diagnostic | `/private/tmp/workbench-r0-preflight-20260721-post-upgrade-local/receipt.log` | `1735cbd19482b60a86050f96000fa2742fe777602b6d5d157c745b3ffa25fc4b` |
| 2026-07-21 post-upgrade v2 Web Vitest | `/private/tmp/workbench-remediation-20260721-post-upgrade-web-test.log` | `a26fe950af301da0bc2286cfb940b90c8d8848c2d0c7c5c5568687565aebb0a0` |
| 2026-07-21 post-upgrade v2 fresh PostgreSQL migrations | `/private/tmp/workbench-remediation-20260721-post-upgrade-fresh-migrations-v2.log` | `0c4777797b631764f73ea4c6bc5ea0d58603e17d95e1e7ab8c43e59e505e9017` |
| 2026-07-21 post-upgrade v2 API PostgreSQL regression | `/private/tmp/workbench-remediation-20260721-post-upgrade-api-postgres-test.log` | `578033c034e7ae4acba5227bfab8b0d31ae1bdb978dad99af73f01e03d3f0e09e` |
| 2026-07-21 post-upgrade v2 Worker PostgreSQL regression | `/private/tmp/workbench-remediation-20260721-post-upgrade-worker-postgres-test.log` | `153e113dfb9e67e1267f3a312b1d892745df79d371a22797bd4ef40cfcdeb2dd` |
| 2026-07-21 post-upgrade v2 root `npm test` | `/private/tmp/workbench-remediation-20260721-post-upgrade-root-test-v2.log` | `a19459749a1dfaea0cb205a24351feec0e16d636973617c21cf6a8e7a1211bc9` |
| 2026-07-21 post-upgrade v2 root `npm run typecheck` | `/private/tmp/workbench-remediation-20260721-post-upgrade-root-typecheck-v2.log` | `aa0c8b2d2f5b8ef887568da3d35121219cca3d0def925a1fbf1b84c338aa604c` |
| 2026-07-21 post-upgrade v2 configured production build | `/private/tmp/workbench-remediation-20260721-post-upgrade-root-build-configured-v2.log` | `1dea047f687a46670f3b9ebb31b855cc947d5242664e4163ec2637ad76a2e09` |
| 2026-07-21 post-upgrade v2 browser E2E matrix | `/private/tmp/workbench-remediation-20260721-post-upgrade-e2e-web.log` | `bd4113ca2c752158c8cacdf86620cce710de6d100f2e185fc5af102ff4b0c843` |
| 2026-07-21 post-upgrade v2 R0 contract suite | `/private/tmp/workbench-remediation-20260721-post-upgrade-r0-contract-test.log` | `c01d153bc0613786b38a7b27f6415827de4d87f664f76439f3f30bf7c74c550f` |
| 2026-07-21 post-upgrade v2 latest R0 manifest diagnostic | `/private/tmp/workbench-r0-post-upgrade-v2-20260721/candidate.json` | `f829d291a8f55eb0b5f4a5f1886fcb6fbb0104cd6e3efa4e4f896bcc44134828` |
| 2026-07-21 post-upgrade v2 latest R0 inventory diagnostic | `/private/tmp/workbench-r0-post-upgrade-v2-20260721/inventory.ndjson` | `2ac3ff6a69b7bcaa6a447d91af48e536ecf9f1ab54a07a795aafa9b70069c720` |
| 2026-07-21 post-upgrade v2 latest R0 receipt diagnostic | `/private/tmp/workbench-r0-post-upgrade-v2-20260721/receipt.log` | `1393bd994cfd66f0a907ef72e55e3b92509a844450683a972a27e9efcdfb2f30` |
| 2026-07-21 post-upgrade v3 R0 manifest diagnostic | `/private/tmp/workbench-r0-post-upgrade-v3-20260721/candidate.json` | `d4e60e3b7eb356d4c17c3f065694cf7b10a756c679b57b24ac1b8a7233dad562` |
| 2026-07-21 post-upgrade v3 R0 inventory diagnostic | `/private/tmp/workbench-r0-post-upgrade-v3-20260721/inventory.ndjson` | `c415375fa38e6c51370639a8499ae08994762fa4019e2277503fd41163e02a27` |
| 2026-07-21 post-upgrade v3 R0 receipt diagnostic | `/private/tmp/workbench-r0-post-upgrade-v3-20260721/receipt.log` | `b4d2e3be22f5e87213a63034bffc5f46e467b9f79b474d1ffcdd3a3f66847454` |
| 2026-07-21 post-upgrade v2 latest public live recheck | `/private/tmp/workbench-remediation-20260721-post-upgrade-live-public-v2.log` | `b9bd1bc30c0b7460ffe33b1d2e588ac14ffff316877943225a06305787f7c3be` |
| 2026-07-21 post-upgrade v2 latest remote health/image recheck | `/private/tmp/workbench-remediation-20260721-post-upgrade-live-remote-v2.log` | `2d27199517966ab32a4390b0ef1c178c3d067070a330bedcb807e75814b73428` |
| 2026-07-21 post-upgrade v2 latest remote database recheck | `/private/tmp/workbench-remediation-20260721-post-upgrade-live-db-v2.log` | `3ac774c6fcf97b744ffd40f57753979b7f584bcb6bce2bfc5959ec8e188b144f` |

负向记录必须按递进顺序解释：原 Run 暴露不适用阶段工具；裁剪后模型委派 `task` 但 lead agent 未提交结果；关闭非 Prototype 委派后 smoke fixture 缺 Board；补齐 Board 后又由旧 fixture 的 active job 阻塞 clean queue。最后一步只精确删除该验证 fixture/job，未删除业务数据。secret-channel 第一次重跑误用裸 hex token，预检按设计 fail closed；改用合法 `wbkg1.*` / `wbct1.*` 格式后才计 PASS。服务器宿主 Vitest 因缺 Linux `rolldown` optional binding 未启动；本地同套测试和 Linux image build PASS，该环境失败不计产品结果。上一轮 validation rollout 在服务器升级期间停在 Docker build 中途，保留为失败/风险证据并在 V-042 之后重新构建；宿主机直接运行 Worker smoke 因内部 Docker hostname 不可达得到 P1001，改在 Worker 容器内执行后才计 V-043 PASS。服务器无 ready Knowledge Release fixture，因此真实 Knowledge-release smoke 保持 NOT RUN。

### 7.1 Ledger 必填字段

后续每个验证对象必须记录：

`Gate ID`、控制目标、环境、前置条件、精确命令/步骤、预期可观察结果、数值/布尔阈值、实际状态、UTC 时间、执行者、commit/tag/deploy ID、image/config/migration digest、工具版本、原始证据 URI、SHA-256、重试记录、关联 finding/decision。

证据索引只引用 ledger 对象，不另建一套冲突状态。

---

## 8. Repair waves

### R0 — 冻结证据与可复现候选

**输入**：当前 dirty tree、实施状态文档、全部运行关键资产。
**动作**：

1. 盘点 tracked/untracked/ignored；
2. 显式关闭 D-033：将所有运行关键文件纳入可审阅候选，并证明没有只存在于 untracked/ignored 或单机目录的运行依赖；
3. 排除 caches、`.next`、dist、明文 secret 和不应提交的原始凭证证据；
4. 冻结 commit、签名 tag、artifact/image/config/migration manifest；
5. 建立不可变 ledger 和 evidence index；
6. 从 fresh clone 运行 Node 22 `npm ci`、prepare/generation，并要求第二次生成零 diff。

**退出条件**：clean status；fresh clone 可重建；所有关键资产有 digest；不存在仅在单机/untracked/ignored 的运行依赖。
**回滚触发**：发现 secrets、缺失资产或 fresh clone 与原环境不一致时，停止后续 gate。

### R1 — 修复代码、合同与工具链缺陷

优先顺序：

1. D-001、D-002～D-006（Canvas 路由、授权、ACK、lease、snapshot、revision）；
2. D-007～D-015（Run claim、external idempotency、SSE/checkpoint、cursor、retry、Prototype Patch）；
3. D-016～D-024（private cache/auth/object integrity/Preview memory、DeerFlow clean-host、双 origin、README 重建）；
4. D-025～D-030、D-032、D-034、D-035（CI、hard-cut validator、migration、typecheck、oasdiff、cursor、Linux image dependency、Run 级工具/委派边界）；
5. P-013、P-014（`view_screen` 图像输入、按 Run 工具最小权限）。

**必测**：unit、DB integration、fault injection、concurrency、negative authorization、OpenAPI generation/validation/breaking、type/lint/architecture、memory/capacity。
**退出条件**：全部 release-blocking confirmed defect 有修复 commit、回归测试和 E2 PASS；不能只改状态文档。

### R2 — 生产身份、存储、扫描、Runtime 与模型

完成 Better Auth 生产账号、session/JWT 与 KMS/secret-store 生命周期；企业 SSO 启用时再完成目标 OIDC；同时完成 S3/IAM/ClamAV、DeerFlow source commit + signed image digest、request-scoped secrets、embedding/reranker、真实 provider conformance。

**必测**：

- 空 PostgreSQL 16 + pgvector least-privilege migration；
- Better Auth 密码登录、public signup fail-closed、session/JWT expiry/revoke/role mapping、签名密钥轮换；企业 SSO 启用时再测 OIDC issuer/audience/callback/撤销；
- KMS key policy、轮换、不可导出；
- S3 independent identities、tenant prefix、multipart/checksum；
- EICAR、scanner unavailable、quarantine、oversize；
- DeerFlow preflight、SBOM、签名、digest、tool catalog；
- 固定中文 retrieval benchmark 和 citation/route isolation；
- provider 成功、拒绝、429、5xx、timeout、cancel、retry、审计。

**退出条件**：所有适用项 E1/E2 PASS，资产绑定同一 candidate。

### R3 — 目标环境 E2E 与韧性

在真实双 HTTPS origin、真实网络策略和批准 provider 凭证下执行：

- Run/SSE reconnect、approval、cancel、retry、sequence gap、duplicate delivery；
- Import/Export/Preview、multipart、checksum、恢复、第三方外发确认；
- Canvas state sync、grant、ACK、revoke、expiry、图像输入；
- Prototype Patch fault injection；
- cookie/CORS/CSP、prompt injection、tenant isolation、SSRF/egress；
- Edge TLS/WireGuard/origin auth、OTLP trace/alert；
- SIGTERM、worker kill、数据库/queue/provider 中断与恢复；
- D-031 容量验证：active Run 数、共享取消 poller DB QPS、批量大小、取消延迟和降级恢复 SLO；
- Chromium、Firefox、WebKit；375×812、768×1024、1440×900；
- accessibility、reduced motion、console errors、failed network requests；
- Figma Desktop（若 advertised）。

**退出条件**：完整产品与失败路径矩阵 E1 PASS；SLO/容量阈值获批；无 release-blocking UNKNOWN。

### R4 — Hard-cut 与发布收口

仅在 G0–G11 全 PASS 后执行：

1. `hard-cut manifest --enforce`；
2. 旧流量为零；
3. legacy code/config/asset/data residual 扫描；
4. 备份与 restore drill；
5. 旧系统物理删除和数据清理；
6. receipt schema/digest/signature 验证；
7. 独立 security、data、operations、release approval；
8. 写入绑定同一候选的 `cutoverReceipts.productionAcceptance`；
9. 完成观察窗口和回滚/forward-repair 判定。

**退出条件**：G12 PASS。任何候选内容变化都使受影响的下游证据失效并要求重验。

---

## 9. Acceptance gates G0–G12

| Gate | 控制目标 | 依赖 | Gate 状态 | 未绑定本地预检 | PASS 条件摘要 |
|---|---|---|---|---|---|
| G0 | 范围、生产目标、Owner、advertised/deferred capabilities | 无 | NOT RUN | 67 项 G0/schema 合同通过，但没有真实独立签署记录 | 产品范围、环境、责任、N/A 有签署记录 |
| G1 | Immutable source candidate 与 clean provenance | G0 | BLOCKED | `2665575f` 曾形成 clean signed G1 PASS，但因 D-047/D-048 淘汰；当前修复尚未封印新候选 | clean commit/tag/manifest，无关键 untracked/ignored 依赖 |
| G2 | Fresh-clone install/generation/reproducibility | G1 | BLOCKED | 淘汰候选 `2665575f` 的 Node 22/npm 11.18.0 fresh clone、两轮生成和 clean-clone 收口 PASS；不得复用于新候选 | Node 22 clean clone 全流程及二次生成零 diff |
| G3 | 完整 CI、type、test、architecture、OpenAPI breaking | G2 | BLOCKED | 淘汰候选 attempt 1 完整 PASS，但强制复跑形成 D-047/D-048；修复后固定工具链本地矩阵 PASS，新候选 CI 未运行 | root typecheck PASS；breaking diff PASS；全部 blocking suite PASS |
| G4 | 全服务 artifacts、SBOM、签名、digest、inventory 一致 | G3 | BLOCKED | 淘汰候选技术构建完成 8/10 且已扫镜像零 HIGH/CRITICAL 后主动停止；没有新候选 OIDC/Cosign/provenance 或完整十镜像 inventory | 包含 Import Worker、DeerFlow，CI/Compose/deploy inventory 一致 |
| G5 | Migration、约束、升级、backup/restore、RPO/RTO | G4 | BLOCKED | 淘汰候选已完成 66 migrations、真实旧版本升级、least privilege、backup/restore，RPO 2.708s/RTO 2.224s；源变化后不得升级为正式 G5 | least-privilege fresh/upgrade migration 与候选绑定 restore drill PASS |
| G6 | Auth、安全、checksum、Edge/WireGuard、KMS、IAM、ClamAV、SSRF、审计 | G4 | BLOCKED | 阿里云私有 OSS 的 8 身份与 60/60 IAM 已在 dirty-tree validation 通过；D-020 候选绑定、KMS、Edge/WireGuard、ClamAV 故障矩阵及目标环境整体仍未关闭 | D-001～D-005、D-019、D-020 等关闭，目标环境负向 E1 PASS |
| G7 | DeerFlow/runtime/model/tool 最小权限 | G4 | BLOCKED | tools 64/64；服务器 DeerFlow catalog、Gateway context、真实 provider 基础 smoke、按 Run 工具裁剪、非 Prototype 委派关闭及 secret-channel 均通过，D-035 的 validation 阻塞已消除；仍无 clean signed immutable candidate，Prototype/code 子代理、图像输入与完整故障矩阵未形成 E1/E2 | immutable digest、validator、secret、图像输入、按 Run tool catalog PASS |
| G8 | 真实存储、Import/Export/Preview/provider | G4 | BLOCKED | 真实 provider document 短 smoke、阿里云 OSS 60/60 IAM 与公网 multipart 13/13 已在 dirty-tree validation 通过；同一签名候选上的 Import/Export/Preview、对象损坏/恢复及 provider 拒绝/429/5xx/timeout/cancel/长时序未运行 | 成功及拒绝/timeout/429/5xx/retry/cancel/audit E1 PASS |
| G9 | Knowledge/retrieval/Quartz | G4 | BLOCKED | 本地 Knowledge 合同 7/7、集成及服务器 secret-channel Knowledge 调用通过；服务器无 ready Knowledge Release fixture，真实 release/adopted model/profile/benchmark 未运行 | 固定 benchmark、model digest、citation、route isolation、delivery PASS |
| G10 | Production topology、双 origin、OTLP、恢复、容量/SLO | G4 | BLOCKED | Edge/WireGuard 静态合同、本地浏览器矩阵和服务器 validation preflight 通过；`aionbench.com` DNS/TLS、公网路由、15 个 Workbench 栈容器加独立 DeerFlow（共 16 个）healthy 及基础真实 Run 已验证。该拓扑仍是 dirty-tree validation，未完成正式 clean-host deploy/rollback、Edge/WireGuard 防绕过、OTLP、容量或恢复演练 | clean host、真实网络、trace/alert、kill/restart/capacity E1 PASS |
| G11 | 部署候选完整产品矩阵 | G5–G10 | BLOCKED | 无可执行候选 | 账户、项目、Run、Canvas、Prototype、Import/Export/Preview、a11y 全 PASS |
| G12 | 独立生产批准与 hard-cut | G0–G11 | BLOCKED | v2 hard-cut/release-chain 合同通过；真实 G5-G11 与四方批准不存在 | 全前置 PASS、enforce、零残留、删除/清理/回执/观察窗口完成 |

依赖顺序：G1→G2→G3→G4 严格串行；G5 必须先于不可逆数据动作；G6–G10 可在 G4 后并行；G11 依赖 G5–G10；G12 依赖 G0–G11。

G0 的范围、能力分类、责任人与生产目标决定必须在候选冻结前获得批准；最终可校验的 G0 记录还必须绑定实际 G1 candidate。操作上由同一次 release-chain 封印 G0 记录与 G1 manifest，生成 G1 文件本身不代表 G1 已通过；只有校验器同时验证 G0 批准与 G1 clean provenance 后，G0/G1 才能作为链式前置进入 G2，禁止单独拿任一文件越级。

`REJECT` 是当前总体发布决定，不是 G12 的执行状态；G12 因前置依赖未满足保持 `BLOCKED`。

---

## 10. Codex 执行规则

每次只处理一个 repair wave，并在提交审查前输出：

1. 修复的 finding IDs；
2. 修改文件与原因；
3. 保留了哪些不可破坏 invariant；
4. 新增/修改的 unit、integration、fault-injection、E2E 测试；
5. 精确命令和实际 PASS/FAIL/NOT RUN；
6. 原始输出路径和 SHA-256；
7. 未完成项、残余风险和回滚方式；
8. 候选 commit/digest（若用户尚未授权 commit，则只报告 working-tree diff，不自行提交）。

禁止：

- 修改 `IMPLEMENTATION-STATUS.md` 来代替修复；
- 在测试失败时继续下一个 wave；
- 把 skipped test 计为覆盖；
- 对未知/历史数据库执行 integration test；
- 使用非隔离数据库/schema；
- 将 fake provider 结果升级为真实 provider PASS；
- 在文档或日志写入 cookie、token、OAuth credential、Preview secret、knowledge capability token；
- 未经用户确认执行外部 publication/export；
- 自动 commit、push、deploy 或删除生产数据。

---

## 11. Decision log 与 waiver

任何例外必须登记：

- Decision ID；
- 关联 finding/gate；
- 业务理由；
- 验证事实（不得改写）；
- 补偿控制；
- Owner；
- security/data/operations/release 批准人；
- 批准 UTC 时间；
- 到期日；
- 复审触发条件；
- 回滚/forward-repair 方法。

不得 waiver：source provenance、tenant isolation、secret exposure、对象 checksum integrity、不可逆数据恢复能力或最终独立 production approval。

---

## 12. 责任矩阵

每个 finding 和 gate 都必须填写：

| 角色 | 姓名/团队 | 职责 |
|---|---|---|
| Implementer | TBD | 实现与测试 |
| Security approver | TBD | 授权、secret、网络、供应链、安全负向验收 |
| Data owner | TBD | migration、backup、restore、清理与 RPO/RTO |
| Operations owner | TBD | 部署、监控、容量、恢复、回滚 |
| Evidence custodian | TBD | ledger、hash、不可变证据索引 |
| Release authority | TBD | 最终发布决定；不得与 implementer 自我批准混同 |

这些 `TBD` 不是可接受的完成状态：在独立责任人、验证人、目标日期、commit、evidence URI/hash、完成日期和残余风险被实际填写前，相关 finding/gate 不能关闭，也不能生成生产 PASS。

每项另填目标日期、升级路径和逾期处理。

---

## 13. 证据索引起点

以下文件是审查与施工入口，不得把它们的自报内容当作独立生产证据：

- `/Users/liyannong/ai-product-workbench/CODEX-STITCH-PARITY-IMPLEMENTATION.md`
- `/Users/liyannong/ai-product-workbench/docs/stitch-parity/IMPLEMENTATION-STATUS.md`
- `/Users/liyannong/ai-product-workbench/docs/workbench-greenfield-implementation-plan.md`
- `/Users/liyannong/ai-product-workbench/package.json`
- `/Users/liyannong/ai-product-workbench/.github/workflows/workbench-ci.yml`
- `/Users/liyannong/ai-product-workbench/deploy/workbench-compose.yml`
- `/Users/liyannong/ai-product-workbench/deploy/workbench-server-preflight.sh`
- `/Users/liyannong/ai-product-workbench/deploy/deerflow-production-preflight.sh`
- `/Users/liyannong/ai-product-workbench/deploy/workbench.env.example`
- `/Users/liyannong/ai-product-workbench/docs/workbench-hard-cut-deletion-manifest.json`
- `/Users/liyannong/ai-product-workbench/scripts/workbench-hard-cut-manifest.mjs`
- `/Users/liyannong/ai-product-workbench/scripts/verify-workbench-hard-cut-acceptance.mjs`
- `/Users/liyannong/ai-product-workbench/docs/runbooks/workbench-hard-cut-production-acceptance.md`
- `/Users/liyannong/ai-product-workbench/scripts/workbench-postgres-recovery-drill.mjs`
- `/Users/liyannong/ai-product-workbench/docs/runbooks/workbench-postgres-recovery-drill.md`
- `/Users/liyannong/ai-product-workbench/packages/workbench-db/prisma/schema.prisma`
- `/Users/liyannong/ai-product-workbench/packages/workbench-db/prisma/migrations/`

后续原始测试输出、浏览器证据、部署回执和目标环境日志必须通过不可变 URI + SHA-256 进入 ledger；不能依赖可变本机路径作为最终生产证据。

---

## 14. 最终验收清单

只有全部满足后，才允许把阶段 12 改为 PASS：

- [ ] G0–G11 所有适用硬门禁均为 PASS；
- [ ] 所有 PASS 均绑定同一 commit/tag、image digests、migration/config/environment revision；
- [ ] 所有生产硬门禁证据为 E1/E2；
- [ ] 无未关闭 release-blocking CONFIRMED defect；
- [ ] 无阻断级 PLAUSIBLE risk；
- [ ] 无 BLOCKED、NOT RUN 或 INCONCLUSIVE 硬门禁；
- [ ] root typecheck 在 fresh clone PASS；
- [ ] OpenAPI breaking diff 对冻结 baseline PASS；
- [ ] DeerFlow + Workbench 可在 clean host 从冻结 manifest 重建；
- [ ] Better Auth 生产身份/KMS、S3/IAM/ClamAV、provider 和双 HTTPS origin 验收完成；启用企业 SSO 时另含真实 OIDC；
- [ ] Run/Canvas/Prototype/Import/Export/Preview 长时序和故障恢复完成；
- [ ] SBOM、签名、digest 和部署实际 artifact 一致；
- [ ] backup/restore、RPO/RTO、forward repair 完成；
- [ ] `hard-cut manifest --enforce` PASS；
- [ ] 旧流量为零，legacy code/config/asset/data residual 为零；
- [ ] 旧系统物理删除和数据清理有真实、签名、哈希回执；
- [ ] 无过期 waiver；
- [ ] security、data、operations、release authority 独立批准；
- [ ] `cutoverReceipts.productionAcceptance` 非空且绑定同一候选；
- [ ] 生产观察窗口完成，SLO/告警无阻断事件。

**当前结论保持：阶段 12 = REJECT。**

任何 source、dependency、generated contract、migration、image 或 production config 变化都会形成新候选，并使受影响的下游证据失效。只有上述清单全部满足，才能宣称 `remediation complete` 或 `production accepted`。
