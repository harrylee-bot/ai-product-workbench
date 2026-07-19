# Codex Workbench 全面审查、整改与生产验收规范

> **用途**：交给 Codex 逐项修复、补测、留证并申请重新验收。
> **仓库**：`/Users/liyannong/ai-product-workbench`
> **审查性质**：只读审查结论与后续施工规范；本文的创建不代表修改产品代码、配置或环境。
> **当前发布判定**：**REJECT（阶段 12 未通过）**
> **文档日期**：2026-07-18
> **禁止操作**：未经用户明确确认，不得 commit、push、deploy、发布、外发真实数据或执行不可逆数据清理。

---

## 1. 执行摘要

当前仓库记录显示本地阶段 0–11 和服务器 hard-cut 曾执行过大量实现与验证，但这不等于生产验收完成。当前正式结论为：

1. **阶段 12 仍为 REJECT**。Production security acceptance、真实 provider 长时序、可复现 clean candidate、不可变镜像与完整 hard-cut 证据均未闭环。
2. 当前绿色实现大量依赖 dirty/untracked working tree；已观察到唯一提交基线仍是 legacy HEAD `162c4f42`。在冻结干净、可复现、不可变候选之前，既有 PASS 只能作为审查线索，不能作为生产验收事实。
3. 根测试套件曾完整通过，但 root `typecheck` 在当前工作区失败；`openapi:breaking` 因外部 Go module 网络超时没有产生 breaking-diff 结论。这两项不得表述为 PASS。
4. 代码审查确认了 Run/SSE、Canvas Agent、Prototype Patch、授权、对象存储、Preview、部署、CI 和 hard-cut 证据链中的多项 release-blocking 缺陷。
5. Preview sandbox、ArtifactVersion publication/immutability、Run sequence/identity 基本不变量等专项没有发现确认绕过。修复不得削弱这些已建立的边界。

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

- **状态/严重度**：CONFIRMED / CRITICAL / release-blocking
- **位置**：`deploy/workbench-nginx.conf`
- **触发**：DeerFlow/Runtime 以 server-to-server bearer capability 调用 Canvas tool execution endpoint。
- **影响**：请求落入 Next BFF 浏览器代理边界；Authorization 不能按 Canvas capability contract 到达 API，真实 Canvas Agent execution 失败或走错授权模型。
- **修复**：为 Canvas capability endpoint 建立 exact path/method route，直接代理到 Workbench API；只转发该协议所需 header，禁止泛化 bearer passthrough；browser routes 继续走 BFF/session 边界。
- **测试**：正向 capability、缺失/过期/错 scope/replay token、浏览器 bearer 注入、错误 method/path、跨项目调用；同时证明普通浏览器路由不能使用 server capability。
- **退出条件**：目标环境 E1 请求 trace 显示精确 route 命中 API，所有负向用例 fail closed。

### D-002 — Canvas 撤权与 command issuance/list 存在竞态

- **状态/严重度**：CONFIRMED / CRITICAL / release-blocking
- **位置**：`apps/workbench-api/src/modules/canvas-agent/canvas-agent.service.ts`
- **触发**：授权检查后、命令创建或命令列表查询前发生成员撤权、session revoke 或 scope 变化。
- **影响**：已撤权主体仍可能签发或读到命令；授权时点与数据库效果不原子。
- **修复**：将 live authorization/session/grant 条件与 command insert/select 放入同一数据库事务或单条条件语句；使用受影响行数/锁验证；revoke 必须使后续 issuance/list 立即不可见。
- **测试**：两个并发连接交错执行 authorize→revoke→insert/list；跨租户、角色降级、session revoke、grant expiry。
- **退出条件**：确定性并发测试证明 revoke linearization point 后没有新命令或泄漏。

### D-003 — Canvas ACK result 未绑定已同步客户端状态

- **状态/严重度**：CONFIRMED / HIGH / release-blocking
- **位置**：`apps/workbench-api/src/modules/canvas-agent/canvas-agent.service.ts`，`resultFromAck(...)` 及 ACK 路径
- **触发**：客户端提交 schema 合法、revision 数值匹配但内容与最近 synchronized Canvas state 不一致的 ACK result。
- **影响**：服务端把未由已知 Canvas 状态证明的结果标记为 succeeded；模型和审计账本可接收伪造或陈旧结果。
- **修复**：ACK 必须绑定 command ID、tool call、agent session、board revision、canvas state revision、完整 state/snapshot digest 和预期 result invariant；对 mutation 工具应从同步后的 canonical state 推导或核验结果。
- **测试**：相同 revision 不同 state、错 selection/viewport/screen ID、replayed ACK、跨 command ACK、伪造 result hash。
- **退出条件**：只有与最新同步状态及原 command scope 一致的 ACK 能成功。

### D-004 — Canvas session、grant 与 invocation 到期后不能可靠收敛

- **状态/严重度**：CONFIRMED / HIGH / release-blocking
- **位置**：`apps/workbench-api/src/modules/canvas-agent/canvas-agent.service.ts`；相关 DB lifecycle
- **触发**：pending invocation 在 session/grant/lease 自然过期，且没有后续请求触发清理。
- **影响**：调用永久 pending；等待方、模型状态和审计状态不一致；可能保留已失效命令。
- **修复**：建立 durable expiry/reconciliation job；使用数据库时间和条件更新把 pending invocation 原子转为 expired/failed；事件/响应必须幂等；revoke 触发主动收敛。
- **测试**：时钟边界、worker crash/restart、多 reconciler、late ACK、revoke 与 ACK 竞态。
- **退出条件**：所有过期记录在有界 SLO 内进入唯一 terminal 状态，late ACK fail closed。

### D-005 — Canvas grant replay 未绑定完整 snapshot

- **状态/严重度**：CONFIRMED / HIGH / release-blocking
- **位置**：`apps/workbench-worker/src/runtime/canvas-tool-grant.service.ts`，`assertExistingSession(...)`
- **触发**：复用 session/grant 时 stable IDs 和 declaration 相同，但 board/canvas revision、viewport、selected/visible IDs 或 snapshot 内容已变化。
- **影响**：旧 grant 可被用于不同 Canvas state，突破按快照授权和最小权限假设。
- **修复**：grant subject 必须包含 canonical snapshot digest，以及 boardRevision、canvasStateRevision、viewport、selected/visible IDs、tool declarations/profile；任一字段变化均重新签发或拒绝。
- **测试**：逐字段 mutation、顺序变化 canonicalization、同 revision 不同内容、跨 run/project replay。
- **退出条件**：旧 grant 对任何不同 canonical snapshot 均不可用。

### D-006 — Quick Edit 接受向前漂移的 Board revision

- **状态/严重度**：CONFIRMED / HIGH / release-blocking
- **位置**：`apps/workbench-worker/src/runs/run-processor.ts`
- **触发**：实际 `board.revision` 大于授权/publication 的 `boardRevision`。
- **影响**：基于旧快照批准的 quick edit 可应用到新 Board，覆盖并发修改或错位节点。
- **修复**：首次执行必须要求 exact equality，或使用明确三方 merge/precondition 协议；不得仅拒绝 backward revision。
- **测试**：revision 小于、等于、大于；并发修改；retry；相同 source event replay。
- **退出条件**：无显式 merge 语义时，仅 exact revision 可执行。

### D-007 — Running Run 没有 durable worker execution claim

- **状态/严重度**：CONFIRMED / CRITICAL / release-blocking
- **位置**：`apps/workbench-worker/src/runs/run-processor.ts` 及 Run/Attempt DB lifecycle
- **触发**：worker 在 Run 标为 running 后崩溃、网络分区或队列重复投递。
- **影响**：Run 可永久 running，或多个 worker 同时执行同一外部副作用。
- **修复**：增加数据库持久化 claim/lease：owner、epoch/fencing token、heartbeat、expiresAt；所有 checkpoint/effect 更新校验 epoch；reconciler 只回收过期 lease。
- **测试**：双 worker claim、进程 kill、heartbeat 丢失、旧 worker 恢复、队列重复投递。
- **退出条件**：任一时刻只有一个有效 epoch 能提交效果；崩溃后在 SLO 内安全恢复。

### D-008 — 外部 DeerFlow Run 提交存在 ambiguous-accept 重复创建窗口

- **状态/严重度**：CONFIRMED / CRITICAL / release-blocking
- **位置**：`apps/workbench-worker/src/runtime/deerflow-runtime.adapter.ts`
- **触发**：外部 POST 已被 provider 接受，但响应在 `attachExternalRun` 持久化前丢失；本地 retry 再次 POST。
- **影响**：一个 Workbench Run 创建多个外部 Run，重复推理、计费和副作用。
- **修复**：使用 provider 支持的 idempotency key/client request ID，并建立本地 durable submission intent；retry 先按稳定键 lookup/reconcile，不能盲目重发；若 provider 无查询/幂等能力，状态必须进入 `submission_unknown` 并人工/自动对账。
- **测试**：服务端接受后断连、5xx body 丢失、timeout、worker crash、并发 retry。
- **退出条件**：同一 internal attempt 在所有故障点最多对应一个 external run，或明确进入不可自动重试的 UNKNOWN 状态。

### D-009 — 外部 SSE effect 与 checkpoint 分离会重复事件

- **状态/严重度**：CONFIRMED / HIGH / release-blocking
- **位置**：`apps/workbench-worker/src/runtime/deerflow-runtime.adapter.ts`
- **触发**：RunEvent/effect 持久化成功后、external cursor/checkpoint 更新前崩溃。
- **影响**：重连 replay 同一 external part，生成重复内部事件或副作用。
- **修复**：external event identity、internal event append 和 cursor checkpoint 必须在同一事务/幂等 inbox 中提交；使用 provider event ID 或稳定 canonical part identity；禁止仅靠内存位置。
- **测试**：逐条 fault injection 于 append 前后、checkpoint 前后、事务 commit response 丢失。
- **退出条件**：任一 crash point 重放后内部事件集合完全相同且无重复副作用。

### D-010 — assistant text overlap 去重会丢合法重复文本

- **状态/严重度**：CONFIRMED / HIGH
- **位置**：`apps/workbench-worker/src/runtime/deerflow-runtime.adapter.ts`，`assistantTextDelta` 归一化
- **触发**：模型合法连续输出重复短语，文本内容与此前 suffix/prefix 重叠。
- **影响**：最终 assistant 文本被静默截断或改变语义。
- **修复**：以 provider event/part ID、sequence 和 checkpoint 去重；若 provider 仅给 cumulative text，按明确 cumulative revision 计算 delta，不对独立 delta 做启发式文本 overlap。
- **测试**：`ha`+`ha`、重复代码行、重复 markdown、cumulative snapshot、断线 replay。
- **退出条件**：合法重复内容保留，真正 replay 仅处理一次。

### D-011 — Run SSE backpressure 在客户端关闭后可能永久挂起

- **状态/严重度**：CONFIRMED / HIGH / release-blocking
- **位置**：`apps/workbench-api/src/modules/runs/runs.controller.ts`
- **触发**：`response.write()` 返回 false，服务端仅等待 `drain`；暂停读取的客户端随后断开。
- **影响**：`drain` 可能永不触发，handler/订阅/资源泄漏。真实 Node 复现已观察到 request/response close 而 Promise 未 resolve。
- **修复**：等待 `drain`、response close/error、socket close/error 和 abort signal 的 race；统一 cleanup；任何终止只 settle 一次。
- **测试**：大事件触发 backpressure、客户端 pause 后 close、RST、代理 timeout、正常 drain。
- **退出条件**：所有断开路径在有界时间内退出并释放 listener/subscription。

### D-012 — Run SSE 使用错误 lifecycle 信号判断 disconnect

- **状态/严重度**：CONFIRMED / HIGH
- **位置**：`apps/workbench-api/src/modules/runs/runs.controller.ts`
- **触发**：request body 已完成或 request `close` 语义与 response/socket 生命周期不同。
- **影响**：可能过早停止或未检测真实客户端断开。
- **修复**：以 response/socket close、error 和 request aborted 为主；将连接生命周期封装成单一 AbortSignal。
- **测试**：正常 GET、keep-alive、代理关闭 response、request aborted、half-close。
- **退出条件**：disconnect 判定与真实 outbound stream 生命周期一致。

### D-013 — 冲突 SSE cursors 使用 `Math.max` 会跳过历史

- **状态/严重度**：CONFIRMED / HIGH / release-blocking
- **位置**：`apps/workbench-api/src/modules/runs/runs.controller.ts`
- **触发**：query `afterSequence=0` 与 `Last-Event-ID=100` 同时存在，而客户端本地 reducer 期待 sequence 1。
- **影响**：服务端从 101 开始，客户端永久 sequence gap。
- **修复**：定义唯一优先级或要求两者一致；冲突时返回 400/409，并让客户端显式重建 snapshot；禁止静默取最大值。
- **测试**：仅 header、仅 query、相同 cursor、冲突 cursor、非法/负数/超范围 cursor。
- **退出条件**：任何响应起点都与协商出的单一 cursor 完全一致。

### D-014 — 非空 Canvas snapshot 的 Run retry 被数据库 trigger 拒绝

- **状态/严重度**：CONFIRMED / HIGH / release-blocking
- **位置**：`apps/workbench-api/src/modules/runs/runs.service.ts`；`packages/workbench-db/prisma/schema.prisma` 或对应 migration trigger
- **触发**：失败 Run 的 request 含非 null `canvasSnapshot`，retry service 将其归一为 null，而 DB 要求 retry request 与 source request 相等。
- **影响**：PostgreSQL 抛 `RUN_RETRY_SOURCE_INVALID`，合法 retry 失败。
- **修复**：明确 retry contract：若必须重放原请求，则完整复制 canonical source request/snapshot digest；若快照必须刷新，则 DB/协议应显式建模新 submission，而不是伪装 retry。
- **测试**：null/非 null snapshot、source request canonicalization、跨 revision retry、DB integration。
- **退出条件**：合法 retry 与 DB invariant 一致，非法篡改仍被 trigger 拒绝。

### D-015 — Prototype Patch exact replay 在 lifecycle 变化后不幂等

- **状态/严重度**：CONFIRMED / HIGH / release-blocking
- **位置**：`apps/workbench-worker/src/runs/prototype-patch.service.ts`
- **触发**：patch 已提交但 ACK 丢失；随后 Run/Attempt/ArtifactVersion 进入 terminal/ready；同 `(runtimeAttemptId, sourceEventId)` 重放。
- **影响**：本应返回已有 receipt，却先因 lifecycle validation 失败，provider 不能安全重试。
- **修复顺序**：parse → 计算 request SHA-256 → 查询 exact receipt → 校验 run ID/hash → receipt 存在即返回 → 仅不存在时检查首次 delivery 的 running/staging 条件。
- **测试**：commit response 丢失、terminal 后 exact replay、同 key 不同 hash、跨 run key、并发首次 delivery。
- **退出条件**：exact replay 在任何后续生命周期均返回同一 receipt；冲突 replay fail closed。

### D-016 — Private ArtifactVersion preference 的缓存身份边界不完整

- **状态/严重度**：CONFIRMED / HIGH
- **位置**：`apps/workbench-api/src/modules/artifacts/artifact-version-preferences.controller.ts`；`apps/web/lib/workbench/query/keys.ts`
- **触发**：不同 principal 对同一 ArtifactVersion 拥有相同 preference revision；浏览器 session/principal 切换时 query cache 保留。
- **影响**：仅基于 revision 的 ETag 和不含 principal 的 query key 可混淆私有状态，出现错误 304 或跨身份缓存显示。
- **修复**：服务端 ETag 绑定 principal + resource + representation revision，或使用 private/no-store 且客户端严格按 principal 隔离；query key 必须包含稳定 principal/session cache namespace；登出/切换时清空私有 cache。
- **测试**：同浏览器 A→logout→B、相同 revision 不同值、304、back-forward cache。
- **退出条件**：任何 principal 都不能复用另一 principal 的 preference representation。

### D-017 — stale preference GET 可覆盖成功 mutation

- **状态/严重度**：CONFIRMED / MEDIUM
- **位置**：`apps/web/lib/workbench/features/artifacts/application/index.ts`
- **触发**：mutation 前已有慢 GET；mutation 成功写入 cache 后，旧 GET 晚到。
- **影响**：UI 回退到旧 preference/revision，下一次 CAS 可能冲突。
- **修复**：mutation 前 cancel/invalidate in-flight query；使用 revision-aware cache merge，只接受不低于当前 revision 的响应；mutation success 原子写 cache。
- **测试**：可控 deferred GET、连续 toggles、mutation success/failure、304。
- **退出条件**：旧响应永不覆盖更高 revision。

### D-018 — Conditional GET/304 客户端 contract 不完整

- **状态/严重度**：CONFIRMED / MEDIUM
- **位置**：`apps/web/lib/workbench/features/artifacts/application/index.ts` 及 BFF fetch wrapper
- **触发**：服务端返回 304 无 body，而客户端路径按普通 JSON success 处理，或没有可靠复用对应 cached representation。
- **影响**：解析失败、状态丢失或 cache/revision 不一致。
- **修复**：显式建模 conditional response；304 只能在存在同 ETag cached body 时复用；否则无条件重取；BFF 必须保留 ETag/If-None-Match/304 语义。
- **测试**：200→304、冷 cache 304、principal 切换、ETag 改变。
- **退出条件**：304 不解析 body且只能复用身份匹配的缓存实体。

### D-019 — Production public registration 未默认 fail closed

- **状态/严重度**：CONFIRMED / CRITICAL / release-blocking
- **位置**：`apps/web/lib/auth/workbench-auth.server.ts`
- **触发**：生产环境 `PUBLIC_REGISTRATION_ENABLED` 未设置或为 false。
- **影响**：Better Auth signup 仍可能开放，与部署文档和预期闭源注册策略不一致。
- **修复**：生产默认禁用 signup；只有精确显式 true 且通过部署 policy 才启用；同时封锁 UI、API 和直接 auth endpoint；已有 invite flow 不受破坏。
- **测试**：unset/false/invalid/true；直接 HTTP signup；invite-only；开发环境行为。
- **退出条件**：目标生产环境未显式启用时所有 public signup 路径 fail closed。

### D-020 — Ready object 下载不重新验证实际 bytes SHA-256

- **状态/严重度**：CONFIRMED / CRITICAL / release-blocking
- **位置**：`apps/workbench-api/src/platform/object-storage/read-ready-object.ts`
- **触发**：object store 中对象 bytes 被替换为相同 size/content-type 的内容，metadata 仍保留原 checksum。
- **影响**：损坏或恶意对象以原 immutable checksum/ETag 返回，破坏 Artifact integrity 和审计链。
- **修复**：读取时 streaming 计算 SHA-256，并与可信 DB manifest 比较；object-store metadata 不能作为唯一信任根；不匹配时 fail closed、审计并隔离。可用 provider checksum 作为加速，但必须证明端到端语义。
- **测试**：同 size 篡改、截断、metadata spoof、multipart、range/HEAD 行为。
- **退出条件**：任何 byte-level mismatch 都无法作为 ready object 返回。

### D-021 — Preview HEAD/304 请求仍物化近 50 MiB body

- **状态/严重度**：CONFIRMED / HIGH / release-blocking
- **位置**：`apps/workbench-preview/src/main.ts`
- **触发**：HEAD 或匹配 `If-None-Match` 请求大 HTML Artifact。
- **影响**：在决定不发送 body 前仍下载、拼接、解码和注入 bridge；并发请求可耗尽 256 MiB container。
- **修复**：先基于可信 manifest/metadata 完成 authorization、ETag 和 method 判断；HEAD/304 不读取 body；GET 使用 streaming 或有界处理，避免多份 Buffer/string；保留 checksum 验证策略。
- **测试**：50 MiB HEAD/304 的 object-store read count 为零；并发容量、GET checksum、错误 ETag。
- **退出条件**：HEAD/304 常量内存且不下载对象 body；GET 峰值内存有明确阈值。

### D-022 — Clean-host deploy 未启动 DeerFlow production runtime

- **状态/严重度**：CONFIRMED / CRITICAL / release-blocking
- **位置**：`deploy/server-deploy.sh` 及部署编排文件
- **触发**：在干净主机按正式部署脚本部署。
- **影响**：Workbench 服务启动但真实 Runtime 不存在，Run 无法完整执行；现有服务器状态不可由仓库重建。
- **修复**：建立统一、版本固定、fail-closed 的 DeerFlow + Workbench orchestrator；启动顺序、health/readiness、queue reconciliation、secret channel、network、shutdown 和 rollback 明确化。
- **测试**：fresh host/VM 从零部署、重启、升级、回滚、runtime unavailable。
- **退出条件**：仅依赖冻结候选和批准 secrets 即可重建完整拓扑，并通过真实 Run smoke。

### D-023 — Server-validation Caddy 主域名硬编码

- **状态/严重度**：CONFIRMED / HIGH
- **位置**：`deploy/workbench-server-validation.Caddyfile`
- **触发**：`WORKBENCH_WEB_ORIGIN` 不是 `aionbench.com`。
- **影响**：TLS host、route/cookie/origin validation 与配置不一致，部署到其他域名失败或错误验收。
- **修复**：从单一 validated origin/hostname 配置生成 Caddy routes；启动前校验 scheme、host、Preview 独立 origin 和 cookie domain。
- **测试**：两个不同测试域名、非法 origin、主域与 Preview 域相同。
- **退出条件**：配置不存在硬编码产品域，所有 origin 从同一 manifest 推导。

### D-024 — README validation Compose profiles 不完整

- **状态/严重度**：CONFIRMED / HIGH
- **位置**：`README.md`；`deploy/workbench-compose.yml`
- **触发**：操作者按 README 启动 server-validation。
- **影响**：未启用 `local-object-storage`、`local-docling` 等必要 profile，文档步骤不能重建所宣称拓扑。
- **修复**：文档命令与 Compose dependency graph、profile matrix 和 preflight 保持机器校验一致；明确哪些 profile 仅验证环境可用、哪些禁止用于 production acceptance。
- **测试**：复制 README 命令在 fresh host 执行并运行 health/smoke。
- **退出条件**：文档化命令可重复建立其声明的完整环境。

### D-025 — Import Worker 缺失于 production image matrix

- **状态/严重度**：CONFIRMED / HIGH / release-blocking
- **位置**：`.github/workflows/workbench-ci.yml` 及 artifact inventory
- **触发**：生产构建/签名/发布镜像。
- **影响**：`workbench-import-worker` 没有与其他服务一致的 build、SBOM、签名和 digest 证据，Compose 与 CI inventory 不一致。
- **修复**：纳入 image matrix、SBOM、签名、漏洞扫描、provenance、digest manifest 和部署一致性检查。
- **测试**：CI matrix/inventory contract test；部署只能引用 manifest 中 digest。
- **退出条件**：所有运行服务都存在同一候选绑定的不可变 artifact。

### D-026 — CI hard-cut gate 未启用 enforce

- **状态/严重度**：CONFIRMED / HIGH / release-blocking
- **位置**：`.github/workflows/workbench-ci.yml`
- **触发**：hard-cut manifest 缺项或残留存在，但 CI 只做非强制检查。
- **影响**：流水线可在证据不完整时绿色通过。
- **修复**：发布候选 gate 必须运行 hard-cut manifest `--enforce`；缺 receipt、残留、digest mismatch、未批准 productionAcceptance 均失败。
- **测试**：删除/伪造每个关键 receipt；引入 legacy residual；确保 CI 红灯。
- **退出条件**：只有完整、可验证的 hard-cut manifest 能通过发布 gate。

### D-027 — Hard-cut receipts 只验证字符串，不验证证据真实性

- **状态/严重度**：CONFIRMED / CRITICAL / release-blocking
- **位置**：`scripts/workbench-hard-cut-manifest.mjs`；`docs/workbench-hard-cut-deletion-manifest.json`
- **触发**：receipt 字段填入不存在路径、可变 URL或任意字符串。
- **影响**：manifest 仍可报告 ready；旧系统物理删除、残留扫描和生产批准可被伪造。
- **修复**：定义 receipt schema；验证不可变 URI/文件存在、candidate/deploy/environment identity、SHA-256、签名、执行时间、执行者、工具版本和结果阈值；productionAcceptance 必须独立签署且绑定同一候选。
- **测试**：不存在路径、错误 hash、错误 commit/digest、过期签名、另一环境 receipt、残留非零。
- **退出条件**：任意伪造/错绑定证据均使 `--enforce` 非零退出。

### D-028 — Baseline migration 依赖应用 migrator 安装数据库扩展

- **状态/严重度**：CONFIRMED / HIGH / release-blocking
- **位置**：`packages/workbench-db/prisma/migrations/20260712090000_initial_workbench/migration.sql` 及后续 extension migration
- **触发**：production migrator 使用 least-privilege role，无 `CREATE EXTENSION` 权限。
- **影响**：clean production migration 在 `vector`、`pg_trgm` 或 `pgcrypto` 安装处失败。
- **修复**：把基础设施管理员预置扩展与应用 schema migration 分离；preflight 验证扩展及版本；应用 migrator 不要求 superuser；记录 provider 支持矩阵。
- **测试**：空 PostgreSQL 16 + pgvector，使用真实 least-privilege migrator role；缺扩展时给可操作的 fail-closed 错误。
- **退出条件**：生产权限模型下 fresh migration 和升级 migration 均成功。

### D-029 — Root typecheck 在当前工作区不可复现通过

- **状态/严重度**：CONFIRMED / HIGH / release-blocking
- **位置**：`apps/web/tsconfig.json`；生成的 `apps/web/.next/**` types
- **触发**：执行 root `npm run typecheck`，`.next` types 仍引用已删除的 `app/admin/page.js`。
- **实际错误**：`TS2307 Cannot find module ...app/admin/page.js`。
- **影响**：当前状态的“Root typecheck PASS”声明不成立；生成缓存污染可掩盖 clean checkout 行为。
- **修复**：不要提交/依赖 stale `.next`；建立显式 route type generation 前置步骤和 clean cache CI；确认删除 admin route 后生成零残留。
- **测试**：fresh clone、无 `.next`、install→generate/build-required-types→typecheck；第二次运行零 diff。
- **退出条件**：同一冻结候选在 clean checkout 上 root typecheck 稳定 PASS。

### D-030 — OpenAPI breaking diff 未产生结论

- **状态/严重度**：CONFIRMED（验收缺口）/ HIGH / release-blocking
- **位置**：`scripts/workbench-openapi-oasdiff.sh`；`package.json`
- **触发**：执行 `npm run openapi:breaking` 时，Go 从 `proxy.golang.org` 获取 `oasdiff@v1.23.0` 超时。
- **实际状态**：**INCONCLUSIVE/BLOCKED，不是 PASS**。
- **影响**：无法证明当前 92-path OpenAPI 相对批准 baseline 无 breaking change。
- **修复**：把 oasdiff 固定为可校验的 CI tool artifact/container；缓存或内建依赖；明确 baseline digest；工具不可用时 gate fail closed。
- **测试**：真实 breaking fixture 必须失败，兼容 fixture 必须通过；离线/依赖不可用必须标 BLOCKED/FAIL。
- **退出条件**：针对冻结 baseline 的真实 breaking diff 产生 E2 PASS 证据。

### D-031 — 每个 active Run 每秒查询取消状态

- **状态/严重度**：CONFIRMED / MEDIUM
- **位置**：`apps/workbench-worker/src/runs/run-processor.ts`
- **触发**：大量并发长 Run。
- **影响**：数据库 QPS 随 active runs 线性增长，可能在高负载下放大延迟和取消抖动。
- **修复**：使用 durable cancellation signal/notification、队列事件或共享有界 poller；仍保留最终数据库事实校验和故障恢复。
- **测试**：容量测试记录 active run 数→DB QPS；通知丢失 fallback；取消延迟 SLO。
- **退出条件**：满足取消 SLO 且数据库负载在批准容量阈值内。

### D-032 — Run cursor 缺少严格 runtime type validation

- **状态/严重度**：CONFIRMED / MEDIUM
- **位置**：`apps/workbench-api/src/modules/runs/runs.service.ts`，`decodeRunCursor(...)`
- **触发**：base64 cursor JSON 中 `id` 为 number/object 等 truthy 非字符串值。
- **影响**：非法客户端输入进入 Prisma，预期 400 可能变成 500。
- **修复**：使用 Zod/显式 schema 校验版本、字段类型、长度、整数范围和未知字段策略；所有 decode/validation 错误映射为稳定 400 problem detail。
- **测试**：malformed base64/JSON、numeric/object/null ID、超长值、合法边界。
- **退出条件**：所有不合法 cursor 均稳定返回 400，且不触达数据库。

### D-033 — Greenfield replacement 依赖大量 untracked/dirty 文件

- **状态/严重度**：CONFIRMED / BLOCKER / release-blocking
- **位置**：整个 working tree
- **触发**：从提交基线 fresh clone 或在另一主机重建。
- **影响**：实现、迁移、部署、生成合同或证据可能缺失；当前结果不可审阅、不可重建、不可恢复。
- **修复**：完成 R0 inventory；将所有运行关键文件纳入可审阅提交；明确排除 generated/cache/evidence secrets；生成签名 source manifest。
- **测试**：fresh clone 全流程；与原 working tree 的 runtime artifact inventory 比较；关键文件不得只存在于 untracked/ignored。
- **退出条件**：clean `git status`，签名 immutable candidate 可独立重建。

---

## 5. 生产验收缺口与目标环境风险

以下事项不能仅凭本地代码判定。未完成前状态为 `NOT RUN`、`BLOCKED` 或 `INCONCLUSIVE`，均阻断阶段 12：

| ID | 风险/控制 | 当前状态 | 升级为 CONFIRMED 的条件 | 降级/关闭条件 |
|---|---|---|---|---|
| P-001 | CDN edge CIDR 在真实入口生效 | NOT RUN | 非 CDN 来源可直达 origin，或 allowlist 与供应商当前 CIDR 不一致 | E1 正/负向探测及配置 revision 证明仅批准边缘可达 |
| P-002 | 回源鉴权可审计且 fail closed | NOT RUN | 缺/错/重放 secret 仍能回源，或日志无法关联 request | E1 测试覆盖轮换、重放、脱敏、审计关联 |
| P-003 | DeerFlow immutable image digest | FAIL/NOT RUN | 部署仍引用 tag/本地 mutable image | 签名 digest、SBOM、provenance、部署实际 digest 一致 |
| P-004 | 真实 OIDC/KMS | NOT RUN | 本地 Dex/静态 secret 被当作 production acceptance | 目标 IdP/KMS E1 正负向、轮换与审计通过 |
| P-005 | 真实 S3/IAM/ClamAV | NOT RUN | 共享过宽 identity、scanner bypass 或 quarantine 失败 | 独立 identities、EICAR、quarantine、checksum、恢复 E1 通过 |
| P-006 | 双 HTTPS Preview origin/cookie isolation | NOT RUN | 单 origin/HTTP 证据被当作生产 | 两个真实 HTTPS origin 上 cookie/CORS/CSP/sandbox 负向通过 |
| P-007 | OTLP collector、trace 与告警 | NOT RUN | 仅配置存在，无 collector/trace/alert 证据 | 目标 collector 收到端到端 trace，告警阈值与 runbook 验证 |
| P-008 | Docker/Quartz/崩溃恢复 | NOT RUN | 仅 unit/compose config 测试 | 目标拓扑 SIGTERM、kill、重启、重复投递、恢复 E1 通过 |
| P-009 | Figma Desktop | NOT RUN/N/A 待定 | 声称支持但未在目标 Desktop 版本验证 | 范围内 E1 测试，或带批准人/到期日的 N/A |
| P-010 | embedding/reranker | NOT RUN | 模型/资产只存在单机或未绑定 digest | 固定中文 benchmark、模型 digest、adoption trace 和阈值通过 |
| P-011 | 全服务网络策略/egress/SSRF | NOT RUN | 任一服务可越界访问 metadata/private network | 目标环境 denial matrix、DNS/rebinding/redirect 测试通过 |
| P-012 | 真实第三方 export/provider | NOT RUN | 只有 fake-provider/capability contract | 使用批准短期凭证完成成功、拒绝、429、5xx、timeout、cancel、audit |
| P-013 | `view_screen` 视觉图像输入 | FAIL | 工具只返回文本/DOM，模型没有可消费图像 | 图像 bytes/asset capability 经安全边界传入模型并有负向测试 |
| P-014 | 按 Run 动态裁剪模型可见工具 | FAIL | 固定 DeerFlow tool catalog 对所有 Run 可见 | runtime 依据 grant/profile 生成最小 catalog，越权工具不可声明/调用 |
| P-015 | Run/Import/Export 长时序 | NOT RUN | 仅 unit/simulator 或短 smoke | 真实 provider 环境覆盖取消、重试、限流、崩溃、恢复、幂等和并发 |
| P-016 | RunEvent DB append-only | PLAUSIBLE | 应用或运维 role 可直接 UPDATE/DELETE 历史事件 | DB privilege/trigger/审计证明 append-only，备份恢复保持完整性 |
| P-017 | cancel Idempotency-Key contract | PLAUSIBLE | API advertise/接收 header 但服务端丢弃导致不确定重放 | 实现 durable receipt，或从合同移除并定义幂等 cancel 语义 |
| P-018 | preference coordinator CAS recovery | PLAUSIBLE | 首次 CAS 失败后后续 toggle 沿用 stale revision | refresh/rebase 后队列继续，确定性并发测试通过 |
| P-019 | `source_id` DB 与应用约束一致 | PLAUSIBLE | 可绕过应用写入 DB 接受的歧义 source ID | 同一生成 schema/constraint，DB integration 负向通过 |

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

## 7. 已执行验证账本

本表记录本轮审查中可明确归类的结果。时间、工具版本、commit SHA 和原始输出 hash 应在 R0 后重新采集到不可变 ledger。

| Ledger ID | 验证 | 结果 | 证据等级 | 备注 |
|---|---|---|---|---|
| V-001 | `npm run test` | PASS（当前 dirty tree） | E2 候选 | 各 workspace 测试通过，但 API/worker 等包含 skipped tests；不等于生产 E2E |
| V-002 | `npm run typecheck` | FAIL | E2 | Web `.next` generated types 引用已删除 `app/admin/page.js` |
| V-003 | `npm run openapi:check` | PASS | E2 候选 | OpenAPI 与 Zod/route registry 一致，Redocly valid，92 paths |
| V-004 | runtime schema/validator checks | PASS | E2 候选 | DeerFlow Runtime result schema/validator current |
| V-005 | `npm run openapi:breaking` | INCONCLUSIVE/BLOCKED | E2 失败证据 | `proxy.golang.org` 获取 `oasdiff@v1.23.0` timeout；不得记 PASS |
| V-006 | Workbench dependency architecture | PASS | E2 候选 | 500 modules、1656 dependencies，无 violation |
| V-007 | DeerFlow tool architecture tests | PASS | E2 候选 | Python unittest 3/3 |
| V-008 | Web security header contract | PASS | E2 候选 | 仅静态/自动合同，不替代目标 CDN/TLS 验证 |
| V-009 | deployment network contract | PASS | E2 候选 | 不替代目标环境网络 probing |
| V-010 | auth proxy/server preflight tests | PASS | E2 候选 | 10/10；不证明真实 edge CIDR/origin auth 已部署 |
| V-011 | ArtifactVersion publication/immutability 专项 | PASS | E2/审查 | 仅限冻结代码机制；基线变化需重验 |
| V-012 | Preview isolation 专项 | PASS（代码边界） | E2/审查 | 双真实 HTTPS origin 仍 NOT RUN |
| V-013 | Run SSE backpressure close reproduction | FAIL | E2 | close 发生后无 drain，等待未 resolve |
| V-014 | production acceptance | NOT RUN/REJECT | — | 阶段 12 不通过 |

注意：本轮超大 working-tree review 的 conventions finder 和最终 gap sweep 曾因 prompt too long 未完成；因此本文是经过多角度、去重和验证的高覆盖审查，但不得宣称绝对无遗漏。

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
2. 将运行关键文件纳入可审阅候选；
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
3. D-016～D-021（private cache/auth/object integrity/Preview memory）；
4. D-025～D-030、D-032（CI、hard-cut validator、migration、typecheck、oasdiff、cursor）；
5. P-013、P-014（`view_screen` 图像输入、按 Run 工具最小权限）。

**必测**：unit、DB integration、fault injection、concurrency、negative authorization、OpenAPI generation/validation/breaking、type/lint/architecture、memory/capacity。
**退出条件**：全部 release-blocking confirmed defect 有修复 commit、回归测试和 E2 PASS；不能只改状态文档。

### R2 — 生产身份、存储、扫描、Runtime 与模型

完成目标 OIDC/KMS、S3/IAM/ClamAV、DeerFlow source commit + signed image digest、request-scoped secrets、embedding/reranker、真实 provider conformance。

**必测**：

- 空 PostgreSQL 16 + pgvector least-privilege migration；
- OIDC issuer/audience/expiry/revoke/role mapping；
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
- TLS/CDN/origin auth、OTLP trace/alert；
- SIGTERM、worker kill、数据库/queue/provider 中断与恢复；
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

| Gate | 控制目标 | 依赖 | 当前状态 | PASS 条件摘要 |
|---|---|---|---|---|
| G0 | 范围、生产目标、Owner、advertised/deferred capabilities | 无 | NOT RUN | 产品范围、环境、责任、N/A 有签署记录 |
| G1 | Immutable source candidate 与 clean provenance | G0 | FAIL | clean commit/tag/manifest，无关键 untracked/ignored 依赖 |
| G2 | Fresh-clone install/generation/reproducibility | G1 | NOT RUN | Node 22 clean clone 全流程及二次生成零 diff |
| G3 | 完整 CI、type、test、architecture、OpenAPI breaking | G2 | FAIL/INCONCLUSIVE | root typecheck PASS；breaking diff PASS；全部 blocking suite PASS |
| G4 | 全服务 artifacts、SBOM、签名、digest、inventory 一致 | G3 | FAIL | 包含 Import Worker、DeerFlow，CI/Compose/deploy inventory 一致 |
| G5 | Migration、约束、升级、backup/restore、RPO/RTO | G4 | NOT RUN | least-privilege fresh/upgrade migration 与 restore drill PASS |
| G6 | Auth、安全、checksum、CDN、KMS、IAM、ClamAV、SSRF、审计 | G4 | FAIL/NOT RUN | D-001～D-005、D-019、D-020 等关闭，目标环境负向 E1 PASS |
| G7 | DeerFlow/runtime/model/tool 最小权限 | G4 | FAIL | immutable digest、validator、secret、图像输入、按 Run tool catalog PASS |
| G8 | 真实存储、Import/Export/Preview/provider | G4 | NOT RUN | 成功及拒绝/timeout/429/5xx/retry/cancel/audit E1 PASS |
| G9 | Knowledge/retrieval/Quartz | G4 | NOT RUN | 固定 benchmark、model digest、citation、route isolation、delivery PASS |
| G10 | Production topology、双 origin、OTLP、恢复、容量/SLO | G4 | FAIL/NOT RUN | clean host、真实网络、trace/alert、kill/restart/capacity E1 PASS |
| G11 | 部署候选完整产品矩阵 | G5–G10 | BLOCKED | 账户、项目、Run、Canvas、Prototype、Import/Export/Preview、a11y 全 PASS |
| G12 | 独立生产批准与 hard-cut | G0–G11 | REJECT/BLOCKED | 全前置 PASS、enforce、零残留、删除/清理/回执/观察窗口完成 |

依赖顺序：G1→G2→G3→G4 严格串行；G5 必须先于不可逆数据动作；G6–G10 可在 G4 后并行；G11 依赖 G5–G10；G12 依赖 G0–G11。

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
- [ ] 真实 OIDC/KMS、S3/IAM/ClamAV、provider 和双 HTTPS origin 验收完成；
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
