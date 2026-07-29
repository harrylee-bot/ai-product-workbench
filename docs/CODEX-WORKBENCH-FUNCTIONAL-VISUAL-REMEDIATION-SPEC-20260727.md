# Codex 执行规格：Workbench 功能、PRD 体验、动效与发布门禁整改

更新时间：2026-07-27
仓库：产品工作台当前仓库
不可变事故基线：`e7deb65d8b6e03f8a9e73787afeaaca7a70750e6`
本轮审计候选：`c8d4c38735189560b4f52e813b3a0e0b322f4238`
当前结论：`REJECT / REMEDIATION REQUIRED`
用途：交给 Codex 分 wave 修复、补测、留证并生成新的 clean candidate；本文不是整改完成回执。

> **执行入口边界。** 本文是本轮已确认的功能、PRD UI、动效、浏览器、CI 和生产镜像缺口的唯一执行入口。Runtime Provider State、独立 900 秒 `runtime.execute` 事件以及 Knowledge request-scoped 可见性，继续以 `docs/CODEX-RUNTIME-DATABASE-REMEDIATION-SPEC-20260723.md` 为唯一权威规格。Codex 必须引用并执行该规格，不得在本文工作中复制、替换或合并出第三套 projection、backfill、timeout 或 Knowledge 方案。
>
> **当前状态。** 本文创建时，Wave A–H、新候选、真实栈浏览器验证、Linux CI OOM 修复、PR 生产镜像构建和最终 G0–G12 均未执行，初始状态一律为 `NOT RUN`、`BLOCKED` 或已记录的 `FAIL`。不得把文档存在、单元测试通过、fixture browser smoke 或本机 typecheck 通过写成整改完成。
>
> **2026-07-27 环境更正。** 原 2 GiB 服务器限制已经失效，当前服务器基线为 16 GiB。后续实现、并发、Node heap 和验收不得再为 2 GiB 环境降级或缩减范围；F-007 仅保留为历史故障记录，关闭条件改为在 16 GiB Linux/Node/npm 环境完整、可重复执行全部 typecheck 与后续门禁。

---

## 0. Codex 执行合同

Codex 必须按本文顺序施工。每个 wave 开始前先搜索并检查真实调用方、类型、路由、queue、测试和配置；本文给出的文件是审计锚点，不是允许凭空创建 API、状态字段或脚本参数的授权。若实际仓库与锚点不一致，应记录替代路径、调用关系和理由，再修改。

### 0.1 基线与候选

1. `e7deb65d8b6e03f8a9e73787afeaaca7a70750e6` 必须保持不可变；不得 amend、force-push、重写 tag 或把工作树内容伪装成该 SHA。
2. 从批准的 clean base 创建新候选。施工前记录：
   - `git rev-parse HEAD`；
   - `git status --short --branch`；
   - `git diff --stat e7deb65d`；
   - tracked、untracked、ignored 的运行关键资产清单；
   - 当前 dirty 文件的逐项纳入/排除决定。
3. 本文创建时已观察到下列 dirty/untracked 状态，不得静默纳入候选：
   - `apps/web/app/globals.css`；
   - `apps/web/components/workbench/workbench-project-chrome.spec.tsx`；
   - `apps/web/components/workbench/workbench-project-chrome.tsx`；
   - `apps/web/lib/workbench/motion-contract.spec.ts`；
   - 四份未跟踪 Runtime/交接文档。
4. 每个改动必须可追溯到本文 finding、实际测试失败或经批准的新发现；不得夹带无关格式化、重构、生成物或历史 dirty 文件。
5. 本审计没有授权 Codex commit、push、deploy、发布、清库或操作外部服务。若后续另有授权，仍须由独立发布流程执行。

### 0.2 不可破坏的产品与安全边界

任何修复都必须保留：

- `workbench.run.v1` 的 run/request/project/thread identity、严格 sequence continuity、durable event、SSE replay 和 reconnect 语义；
- Artifact、ArtifactVersion、Release、Share、Export 的不可变与事务边界；
- canonical SHA-256 checksum、revision、ETag/CAS、idempotency key、source-event dedup 和 publication confirmation；
- Canvas Agent 只能通过受控 command gateway 改变客户端状态；Agent 不得直接写数据库；
- Prototype Patch 必须使用 typed stable node ID，不得退化为针对主应用 DOM 的任意 selector patch；
- Preview 独立 origin、credentialless iframe、无 `allow-same-origin`、`no-referrer`、capability validation、Penpal RPC、timeout 和 generation protection；
- Knowledge 与其他工具的 request-scoped capability、最小可见性、secret-channel 和 fail-closed 行为；
- tenant isolation、authorization、prompt-injection 防护、受控 egress、对象校验和日志脱敏；
- 外部发布、导出或写操作的显式用户确认。

禁止用以下方式制造绿色结果：

- 仅提高 timeout、Node heap 或 job timeout，而不修复根因；
- 把 fake provider、route interception、in-memory fixture 或源码正则测试写成真实栈/视觉 PASS；
- 删除负向测试、降低权限、放松 checksum/revision/CAS 或跳过 package；
- 将 `FAIL`、`NOT RUN`、`BLOCKED`、`INCONCLUSIVE` 或 skipped 写成 `PASS`；
- 记录 cookie、token、OAuth credential、capability、数据库 URL、用户 prompt、用户文件、provider message、事件 payload、响应 body 或完整环境变量；
- 复用旧候选、旧镜像、旧截图或历史服务器回执替代新候选证据。

---

## 1. 已确认 finding register

### F-001 — 混合 PRD/Prototype 请求在前端/API 接受后由 Worker 必然拒绝

- **状态/严重度**：`CONFIRMED / HIGH / release-blocking`
- **审计锚点**：
  - `apps/web/lib/workbench/run/artifact-intent.ts`：自然语言可推导 `['prd', 'prototype']`；
  - `packages/workbench-contracts/src/runs.ts`：检查实际 Run request schema 和 mixed-kind 约束；
  - Web controller/presenter、API start-run service、queue producer：必须由 Codex 搜索真实调用链；
  - `apps/workbench-worker/src/runtime/deerflow-runtime.adapter.ts`：provider I/O 前的 late guard，错误码 `RUNTIME_ARTIFACT_PRD_MIXED_REQUEST_INVALID`。
- **触发**：例如“生成一份 PRD 和原型”，以及中英文、词序变化、同义表达的 mixed intent。
- **实际结果**：请求被 Web/API 接受并可能进入 Run/queue，最终 Worker 拒绝；用户既得不到 PRD，也得不到 Prototype。
- **根因**：产品层对 mixed intent 的分类、请求合同和 Worker 可执行能力不一致；拒绝发生在过晚边界。

### F-002 — PRD document pending 状态退化为静态 `Loading document...`

- **状态/严重度**：`CONFIRMED / MEDIUM / parity-blocking`
- **审计锚点**：
  - `apps/web/components/workbench/workbench-artifact-fallback.tsx`；
  - `apps/web/components/workbench/workbench-board-nodes.tsx` 的 document fallback 使用点；
  - artifact content/version query、projection 和本地化 copy 的实际来源。
- **触发**：document node 已存在，但 generation/refinement ArtifactVersion 尚未解析或请求正在刷新。
- **实际结果**：画布只显示居中的静态加载文案；既有 skeleton、spinner、animated wash、请求/生成上下文或先前 document context 不存在。
- **影响**：用户无法区分仍在生成、正在刷新、无内容和失败；视觉与动效基线明显回退。

### F-003 — active PRD Agent panel 清空 prompt/activity 并缩成 bodyless 卡片

- **状态/严重度**：`CONFIRMED / MEDIUM / parity-blocking`
- **审计锚点**：
  - `apps/web/components/workbench/workbench-project-run-panels.tsx` 的 active PRD `bodyCopy`、`showPromptChip`、`prdBodyless` 与几何分支；
  - presenter/controller/reducer 的 queued、running、stage、message、terminal 投影。
- **触发**：PRD Run 处于 queued/running/generating，尤其 selected task 或 message 尚未出现时。
- **实际结果**：`bodyCopy = null`、prompt chip 被抑制，卡片进入约 `200px × 92px` 的 bodyless 路径；已提交请求和 activity/detail context 消失。
- **影响**：用户不知道系统正在处理什么，Agent panel 在最需要上下文时失去内容与正常几何。

### F-004 — Prototype Run 启动间隙错误挂载 PRD Aurora

- **状态/严重度**：`CONFIRMED / MEDIUM / motion-correctness`
- **审计锚点**：
  - `apps/web/components/workbench/workbench-project-chrome.tsx` 的 `ProjectStageMotionFX`；
  - `apps/web/components/workbench/workbench-project-screen-view.tsx` 调用链；
  - `apps/web/lib/workbench/run/reducer.ts` 的 `run.started` stage reset；
  - controller/presenter 对 `generationStage`、`isPrdRun` 和 `projectMode` 的投影；
  - `apps/web/components/workbench/workbench-project-chrome.spec.tsx`；
  - `apps/web/lib/workbench/motion-contract.spec.ts`。
- **可达触发状态**：
  - 旧 PRD artifact 仍使 `projectMode='document'`；
  - 新 Run 请求 `['prototype']`，因此 `isPrdRun=false`；
  - Run active；
  - `run.started` 将 `generationStage` 重置为 `null`，或当前 stage 为通用 `thinking`；
  - 第一条 Prototype-specific stage 尚未到达。
- **实际结果**：当前 dirty 条件将 `generationStage === null` 或 `thinking` 当作 PRD 推断，挂载 `data-canvas-generation-motion='prd'`。
- **根因**：动效种类由旧 artifact mode 和空/通用 stage 猜测，而不是由可信 Run kind 决定。

### F-005 — 当前 browser smoke 没有真实运行证据

- **状态/严重度**：`CONFIRMED / BLOCKER`
- **证据**：对 `http://localhost:3000/projects/project-1` 的浏览器启动得到 `net::ERR_CONNECTION_REFUSED`；当前 preview server 列表为空。
- **影响**：当前候选没有真实 DOM、console、network、frame、截图或关键用户流程证据；功能、样式和动效不能验收为 PASS。

### F-006 — 现有 Run browser smoke 是 in-memory fixture，不是实际后端链路

- **状态/严重度**：`CONFIRMED / HIGH / false-green risk`
- **审计锚点**：
  - `scripts/e2e/run-workbench-web-smoke.mjs`；
  - `scripts/e2e/workbench-run-preview-smoke.mjs`；
  - `.github/workflows/workbench-ci.yml` 的 browser smoke 调用。
- **机制**：managed smoke 会启动临时 Next server，但子脚本对 `/api/auth/**`、`/api/v1/**`、SSE、session/cookie 使用 synthetic/in-memory 路由处理。
- **影响**：它可证明浏览器组件与 fixture 合同，却不能证明 Better Auth、Web BFF、Workbench API、SSE、Worker、pg-boss、PostgreSQL、ArtifactVersion、Preview 或 refresh/reconnect 的真实集成。

### F-007 — 历史 PR CI typecheck OOM 导致后续门禁未执行

- **状态/严重度**：`SUPERSEDED ENVIRONMENT / HIGH / verification-required`
- **审计锚点**：`.github/workflows/workbench-ci.yml` 的 quality `npm run typecheck`；root `package.json` 的 monolithic typecheck chain 与各 workspace scripts。
- **证据边界**：旧 2 GiB 服务器上的 exit 134/OOM 不再是当前容量约束，也不得继续驱动拆包、降并发或跳过门禁；当前验收基线为 16 GiB Linux/Node/npm。
- **影响**：历史失败仍不能当作当前 PASS，但只需在 16 GiB 基线上证明完整 quality pipeline 可重复执行，且所有后续 package 和 gate 均有明确结果。

### F-008 — PR 不构建受影响的 production image 集合

- **状态/严重度**：`CONFIRMED / HIGH / supply-chain-blocking`
- **审计锚点**：`.github/workflows/workbench-ci.yml` 的 `production-images` job 只在 production push 条件运行；实际 Dockerfile、build context、image inventory 和 release-chain scripts。
- **影响**：Dockerfile、native dependency、copy context、entrypoint、target 或 image-only 编译错误可在 PR 绿色后才出现；candidate review 无法证明 changed image set 可构建。

### F-009 — Motion 测试主要验证源码 token/regex，不证明渲染行为或视觉等价

- **状态/严重度**：`CONFIRMED / MEDIUM / evidence-blocking`
- **审计锚点**：`apps/web/lib/workbench/motion-contract.spec.ts` 及当前 CSS/Framer Motion tests。
- **影响**：keyframe 名称、duration 字符串和 reduced-motion selector 存在，不代表正确元素在正确 Run state 挂载，也不证明布局、帧序列、颜色、opacity、transform 或视觉等价。

---

## 2. Wave A — 冻结范围并用测试固定失败

目标：在修改行为前，把九个 finding 的输入、状态与错误结果变成候选绑定的可重复证据。

Codex 必须：

1. 记录 base/candidate SHA、dirty 状态和文件纳入决定；不得从当前 dirty tree 直接宣称 clean candidate。
2. 追踪完整链路并形成施工记录：
   - prompt → `requestArtifactKindsForPrompt`；
   - Composer/controller → Web/API start-run contract；
   - Run/queue creation → Worker adapter；
   - reducer → presenter/controller → `ProjectStageMotionFX`；
   - artifact query/projection → document fallback；
   - Run SSE stage/message → PRD Agent panel。
3. 添加或修正最小 failing tests，至少覆盖：
   - 中英文 mixed prompt、词序变化和普通单一 PRD/Prototype prompt；
   - start-run mixed request 的当前 late rejection 与副作用；
   - pending document 的实际 render tree；
   - PRD queued/running 无 message、有 message、stage transition；
   - 旧 PRD document + 新 Prototype `run.started` + `generationStage=null`；
   - 历史 Linux CI typecheck OOM 原始记录，以及当前 16 GiB 基线的完整 package inventory、峰值 RSS 与零 OOM 结果；
   - PR changed production image inventory；
   - fixture browser test 明确标记为 mocked。
4. 测试名称必须按仓库实际文件映射，不得仅创建文档中的虚构名称。建议语义：
   - `requestArtifactKindsForPrompt handles mixed intent explicitly`；
   - `start Run rejects unsupported mixed artifact kinds before queueing`；
   - `pending document preserves loading composition and context`；
   - `active PRD panel retains prompt and activity context`；
   - `prototype start after stale PRD does not render PRD wash`；
   - `PR changed production images are built`。

**Wave A 退出条件**：每个 finding 都有 deterministic test 或原始失败日志；测试不得在修复前错误绿色。初始连接拒绝、历史 OOM 和 fixture 限制必须保留为 FAIL/BLOCKED 证据。

---

## 3. Wave B — 收紧 mixed artifact request 合同

### 3.1 设计决定

Codex 必须先检查当前产品合同是否真实支持一次 Run 产出多个 artifact kind。只允许二选一：

1. **推荐：最早边界拒绝不支持的 mixed request。** 如果 Worker/结果合同只支持 PRD-only 或 Prototype flow，则在 Web/API 的首个权威验证边界以现有 ProblemDetails/error/status 形状拒绝，且不创建 Run、不入 queue、不启动 Worker、不调用 provider。
2. **只有实际端到端合同已支持时，才实现 multi-output。** 必须证明一个 Run 可以持久化两个完整 immutable ArtifactVersion、各自正确 checksum/revision、正确 SSE 和 retry/reconnect；不得仅删除 Worker guard 让后续逻辑碰运气。

不得保留“Web/API 接受、Worker 必然拒绝”的状态。前端 intent helper 可以返回显式 ambiguous/mixed 结果，但最终合同必须稳定、可本地化且与 API 一致。

### 3.2 必测矩阵

- 中文：“生成一份 PRD 和原型”“先做原型，再给 PRD”；
- 英文：“Create a PRD and a prototype”“Prototype plus product requirements document”；
- 单一 PRD、单一 Prototype、无明确 kind、同义词和大小写；
- 客户端直接绕过 intent helper 提交 mixed request；
- retry/idempotency key 重放；
- 授权失败和 mixed validation 的顺序不得泄露资源存在性。

若选择 pre-queue reject，测试必须同时断言：

- 稳定、已有风格的 4xx/ProblemDetails；
- queue publish count = 0；
- Run/RuntimeAttempt/ArtifactVersion 写入 count = 0；
- Worker/provider invocation count = 0；
- Run SSE event count = 0；
- 没有残留 loading/active Run UI；
- direct API 与浏览器提交得到一致语义。

Worker late guard可保留为纵深防御，但正常合法入口不得到达它。

**Wave B 退出条件**：任何 accepted request 都存在可执行的完整结果合同；任何 unsupported mixed request 在 queue/Run/provider 副作用前稳定拒绝。

---

## 4. Wave C — 恢复 PRD document loading composition

Codex 必须检查并复用仓库已有 skeleton、spinner、stage wash、localized copy、request-derived context 和 reduced-motion token；不得另造与设计系统平行的组件或硬编码历史品牌文案。

实现要求：

1. pending document 不得只剩 `Loading document...`；必须有可识别 loading surface、结构 skeleton 与当前阶段/请求上下文。
2. 如果已有成功 document 正在 refresh/refine，应保留先前可用内容，叠加非阻塞刷新状态；不得无条件 blank screen。
3. 只有首次无内容 pending 才显示完整 fallback skeleton。
4. queued、generating、refreshing、terminal success、terminal error/cancel 必须视觉和语义可区分。
5. loading 文案进入 `aria-live` 或仓库现有 status pattern；不能造成重复朗读风暴。
6. reduced motion 下立即采用静态最终 loading composition，不进行无限位移；spinner/ellipsis 若保留，仍须可理解。
7. 任何 telemetry/DOM test artifact 不记录用户 prompt 或 document body。

必测：首次 pending、已有 document refresh、SSE stage 更新、查询失败、Run 失败/取消、版本 ready、reconnect、reduced motion、localized copy、窄屏/桌面布局。

**Wave C 退出条件**：pending 状态有 skeleton 和上下文；已有 document 不因刷新被清空；成功/错误/取消边界清晰；rendered tests 而非源码字符串证明结果。

---

## 5. Wave D — 恢复 active PRD Agent panel 上下文与正常几何

实现要求：

1. PRD Run 提交后，在 queued/running/generating 阶段保留 submitted prompt chip 或等价的脱敏用户可见请求摘要；不得因 generation active 清空。
2. panel 必须显示当前 activity/status context；无 provider message 时使用阶段/队列语义，而不是 bodyless。
3. 有 message 时显示现有合法 message projection；不得把 provider 原文写入日志或测试证据。
4. active generation 不得仅因 `isPrdRun` 进入固定约 `200×92` 的 `prdBodyless` 路径。
5. 保留既有 collapse/expand、focus、aria、failure、cancel、retry 和 terminal behavior。
6. Prototype Run、普通 Run 和已选旧 PRD 不得被 PRD-specific panel 修复污染。
7. 不得通过运行时 DOM mutation、CSS selector patch 或 arbitrary style injection 修复几何。

必测状态：初次 submit、queued、running/no message、running/message、每个 PRD stage、SSE reconnect、failure、cancel、retry、ready、选中旧 PRD、新 Prototype Run、mobile/tablet/desktop、reduced motion。

Rendered assertion 至少包含：prompt/context 非空、activity/status 存在、无错误 `data-prd-bodyless`、card bounds 在 viewport 内且保持正常可读尺寸、collapse 后行为不变。

**Wave D 退出条件**：active PRD panel 在所有非 terminal 阶段始终提供“正在处理什么”和“当前进度”两类信息，几何不再退化。

---

## 6. Wave E — 以可信 Run kind 驱动 Motion

### 6.1 修复原则

动效类型必须在状态源头分类，不能由旧 artifact mode、`generationStage === null` 或通用 `thinking` 猜测。

- PRD wash 需要可信 `isPrdRun`/requested kind，或明确 PRD-specific stage；
- Prototype wash 需要可信 Prototype Run kind/Prototype-specific stage；
- `null` 与通用 `thinking` 只能继承当前 Run 的可信 kind；当 `isPrdRun=false` 且 Prototype kind尚未投影时，宁可中性 pending，也不得挂载 PRD wash；
- 旧 PRD artifact 使画布仍为 document mode，不应改变新 Prototype Run 的动效身份；
- reducer reset、refresh/reconnect、late/out-of-order stage 和 terminal 必须保持 deterministic；
- 不得改动 `workbench.run.v1` stage sequence/identity 来迎合 UI。

Codex 应检查是否已有统一 run-kind discriminator；若有，复用它。若没有，只能在真实 controller/presenter state 中增加经过 contract 验证的派生值，不得用 DOM、文案或 CSS class 反推。

### 6.2 强制测试

1. 旧 PRD document + Prototype Run started + `generationStage=null`：不出现 PRD wash。
2. 同状态 + `thinking`：按可信 Prototype kind 或中性状态，不出现 PRD wash。
3. 第一条 Prototype-specific stage：挂载 Prototype motion。
4. PRD Run + null/thinking/PRD-specific stage：挂载正确 PRD motion。
5. terminal/cancel/failure：wash 停止并清理。
6. stale/out-of-order stage：不错误切换 Run kind。
7. refresh/reconnect：同一 event sequence 得到相同 motion state。
8. reduced motion：元素语义仍存在，持续动画禁用或立即完成。

`motion-contract.spec.ts` 的 token/regex 测试可以作为补充，但不能单独关闭 F-004/F-009。必须增加组件 render/state test，并在真实 Chromium 中采集固定 viewport 下的 computed style 或 frame/pixel 证据。

建议固定矩阵：`375×812`、`768×1024`、`1440×900`，普通与 reduced-motion 各一次。证据记录 browser/version、viewport、color scheme、Run state、DOM selector 的语义属性、opacity/transform/animation-name/duration，以及截图或短视频 SHA-256；不得记录 prompt、token、cookie 或 response body。

**Wave E 退出条件**：错误触发 tuple 有 rendered regression test；Prototype 不再显示 PRD Aurora；PRD/Prototype/reduced-motion 的真实渲染证据绑定同一候选。

---

## 7. Wave F — 建立真实栈浏览器门禁

现有 managed fixture smoke 必须保留，但重命名或报告为 `mocked browser/component contract`。不得删除它，也不得继续把它写成 real backend E2E。

新增独立 real-stack lane，必须使用：

- 实际 Web origin 和 Better Auth/session；
- 实际 Web BFF/Workbench API；
- 实际 SSE endpoint 和 reconnect cursor；
- 实际 queue/Worker；
- 明确隔离的 PostgreSQL database/schema；
- 实际 Artifact/ArtifactVersion persistence；
- 相关场景需要的真实 Preview/Export boundary；
- 受控 provider 或批准 staging provider。若使用受控 provider，必须明确标记，不得称为真实第三方 provider 验收。

对被测主路径禁止 Playwright `route.fulfill`、synthetic cookie/session、in-memory `/api/v1/**` 或 synthetic SSE。允许拦截无关外部 analytics/font，但要记录并证明不影响路径。

### 7.1 必测真实用户流程

1. 登录并打开项目；
2. 单一 PRD 提交 → loading composition → active panel → PRD stages → ready ArtifactVersion；
3. mixed PRD/Prototype 提交 → 按 Wave B 合同在正确边界拒绝或完整成功；
4. 在已有 PRD 项目启动 Prototype → 验证 null/thinking 间隙无 PRD wash → Prototype stage/motion；
5. 页面 refresh/reconnect → SSE sequence 连续、状态恢复、artifact 持久；
6. Run failure/cancel/retry；
7. Preview 独立 origin 与 credentialless sandbox；
8. 外部 Export/Publish 仍要求显式确认。

### 7.2 证据与失败语义

- origin 不可达时立即 `FAIL/BLOCKED`，打印脱敏 origin class 和连接错误；不得静默切换 fixture。
- 记录 HTTP method、path class、status、SSE event name/sequence、DOM assertion、browser/version、viewport、UTC、candidate SHA。
- 截图/视频只包含合成测试内容；保存 SHA-256 和受控路径。
- 不记录 cookie、authorization header、URL secret、prompt、文件内容、response body、provider text 或任意 env dump。
- unknown request、console error、failed network request 必须逐项归因；不得仅断言 count=0 后丢失失败日志。

**Wave F 退出条件**：同一候选在真实栈完成上述流程；fixture lane 与 real-stack lane 在 CI/report 中名称和证据等级明确分开；`ERR_CONNECTION_REFUSED` 不再存在。

---

## 8. Wave G — 修复 CI OOM 与 PR production-image gap

### 8.1 Typecheck

Codex 在当前 16 GiB Linux/Node/npm 基线上运行完整 typecheck，记录每个 workspace、峰值 RSS、exit code、已完成与未执行 package。无需复现旧 2 GiB 服务器的 OOM，也不得为旧容量限制降低并发、拆减测试或缩小门禁范围；非 Linux 本机 PASS 仍不能单独关闭该 finding。

修复可采用 workspace matrix、分批 job 或受控每进程 heap，但必须满足：

1. `workbench:prepare`、OpenAPI/schema/validator checks 和所有 workspace typecheck 都实际执行；
2. 每个 package 有独立清晰结果，任何一个失败使 aggregate FAIL；
3. 无 exit 134、OOM 或因前一进程残留造成的内存累积；
4. 不得通过删除 package、跳过生成检查、`continue-on-error` 或仅提高 job timeout 过关；
5. 如果设置 `NODE_OPTIONS=--max-old-space-size=...`，值必须适配 16 GiB runner 并有峰值证据，不能把 OOM 推迟到宿主 kill；
6. clean checkout 连续运行至少两次，生成后 source status 零漂移。

### 8.2 PR 生产镜像

新增 PR-eligible changed-image gate：

- 由实际 Dockerfile、build context、shared package、lockfile、base image、entrypoint 和 deploy inventory 计算受影响 image set；
- 所有受影响 production target 在 PR 上真实 build，执行必要 runtime/startup probe；
- PR lane 可 `--load` 或使用临时本地 registry，但不得 push production registry、签名为发布候选或部署；
- image 必须携带准确 source commit label；
- 合同测试必须证明 production-only guard 不会把 changed image set 全部排除；
- production push lane 继续负责 immutable digest、SBOM、扫描、provenance、Cosign 和 inventory，不得因 PR build 而削弱。

覆盖 Web、API、Runtime Worker、File/Import/Export Worker、Preview、migrator、Knowledge/DeerFlow 等实际 production inventory；最终清单以仓库真实 image manifest 为准，不得从本文猜测。

**Wave G 退出条件**：16 GiB Linux 基线上所有 typecheck package PASS 且无 OOM；PR 对所有 changed production images build/probe PASS；未执行或 skipped 一律阻断。

---

## 9. Wave H — 汇合 Runtime 权威规格并生成可验收候选

1. 完成本文 Wave A–G 后，再按 `docs/CODEX-RUNTIME-DATABASE-REMEDIATION-SPEC-20260723.md` 执行其 Provider State、900 秒、Knowledge 和 PostgreSQL waves；不得把本文的功能 PASS 自动升级为 Runtime PASS。
2. 从 clean base 生成一个新 candidate SHA。root prepare/typecheck/test、Web/API/Worker tests、隔离 PostgreSQL、migration fresh/upgrade、browser fixture、real-stack browser、motion visual matrix、PR image build 和 production supply-chain jobs全部绑定该 SHA。
3. fresh clone 在固定 Node/npm/Python/DeerFlow 版本下可重建；二次生成零 source diff；无运行关键 untracked/ignored asset。
4. 所有服务、migrator 和 DeerFlow 必须来自同一 candidate immutable digest inventory；不得混用 `e7deb65d`、`4bf8c155`、本轮 `c8d4c387` 或旧 DeerFlow 镜像。
5. rollback 以 forward repair 或 schema/projection-compatible previous candidate 为主；不得部署不理解新 schema/projection 的旧 Worker。
6. 本审计不执行 commit/push/deploy。生产动作必须由独立授权和受保护 release workflow 完成。

---

## 10. 强制测试与证据矩阵

| Gate | 最低证据 | 不可替代项 |
|---|---|---|
| Request contract | intent unit + Web/API integration + queue/Worker zero-side-effect | 只测 Worker late guard |
| PRD loading | component render + browser DOM/screenshot + reduced motion | 源码文案/regex |
| PRD panel | 全状态 render + bounds + a11y + browser flow | snapshot 只有 class 名 |
| Motion | state-machine unit + rendered component + Chromium computed/frame evidence | CSS token/regex |
| Real Run | Better Auth + API + SSE + Worker + isolated PostgreSQL + ArtifactVersion | `route.fulfill` fixture |
| Typecheck | 等价 Linux 内存下所有 workspace 实际执行 | 本机高内存 PASS |
| Images | PR changed production image build/probe | production-push-only job |
| Runtime DB | 权威 Runtime 规格中的 PostgreSQL 7,686/12,000、migration、fault tests | mock Prisma/SQLite |
| Release | clean candidate + immutable image inventory + G0–G12 | dirty tree 或历史服务器回执 |

所有命令必须报告实际：exit code、PASS/FAIL/SKIP 数、duration、运行环境和候选 SHA。测试命令必须从实际 `package.json`、workflow 或新增经审查脚本中读取，不得在回执中声称不存在的 script。

---

## 11. G0–G12 关系与新增关闭条件

Runtime 权威规格第 10 节、`docs/runbooks/`、`docs/evidence/` 与硬切 manifest 共同定义 G0–G12 基线。本文增加以下必要条件，不替代原 gate：

- **G0**：范围必须加入 F-001～F-009，明确 owner、验证人和 dirty 文件处理决定。
- **G1**：新 clean candidate；本文、Runtime 权威规格、代码、测试和 image inventory 绑定同一 SHA。
- **G2**：fresh clone、所有生成检查和 typecheck 在受控内存中可重复，零 source drift。
- **G3**：mixed contract、PRD loading/panel、rendered motion、所有 workspace typecheck、隔离 PostgreSQL、零 skip。
- **G4**：PR changed-image build 已通过；发布镜像来自同一候选并完成 digest/SBOM/scan/sign/provenance。
- **G5–G10**：按 Runtime 权威规格完成 migration、projection、900 秒、Knowledge、拓扑、恢复和可观测性，不得由 UI 测试代替。
- **G11**：同一 deployed candidate 上的真实浏览器 PRD/mixed/Prototype-after-PRD/refresh/reconnect/Preview/Export 流程，以及三固定视口普通/reduced-motion 证据全部 PASS。
- **G12**：G0–G11 全部 PASS、verified receipts 非零、独立批准和 `hard-cut --enforce` 实际 PASS 后才可宣称 production accepted。

任一前置失败为 `BLOCKED`；未运行是 `NOT RUN`；证据不足是 `INCONCLUSIVE`；skipped 从不算 PASS。

---

## 12. Codex 每个 wave 的强制回报格式

1. base/candidate SHA、branch、clean/dirty 状态；
2. 实际检查和修改的文件及调用关系；
3. 本 wave 关闭的 finding 与未关闭理由；
4. 设计决定，尤其 mixed reject 与 multi-output 的选择依据；
5. 保留的 Run/SSE、ArtifactVersion、Preview、Knowledge、安全不变量；
6. 测试命令、环境、exit code、PASS/FAIL/SKIP、duration；
7. zero-side-effect 计数、SSE sequence、ArtifactVersion checksum/revision 结果；
8. 浏览器/version/viewport/reduced-motion、console/network/DOM/frame 结果；
9. typecheck workspace inventory、峰值 RSS、OOM/exit 134 状态；
10. changed production image inventory、build/probe 结果；
11. 脱敏原始证据路径和 SHA-256；未上传/未执行必须写 `NOT RUN`；
12. rollback/forward-repair、残余风险；
13. G0–G12 的 `PASS/FAIL/BLOCKED/NOT RUN/INCONCLUSIVE`，不得自行签署独立批准。

禁止在回报中包含用户内容、prompt、provider message、payload、cookie/token、database URL、secret URL、环境变量 dump 或任意生产身份标识。

---

## 13. 完成判定

### 代码完成

至少要求本文 Wave A–G 在同一 clean candidate 上通过，所有新增与受影响测试实际运行，且没有 OOM、connection refused、late-only mixed rejection、bodyless PRD panel、static-only document loading 或 Prototype→PRD motion misclassification。

### 可发布

要求本文 Wave H、Runtime 权威规格 Wave A–H、G0–G11 全部 PASS；真实栈浏览器、隔离 PostgreSQL、changed image build 和同候选 supply chain 证据完整。

### 生产整改完成

仅当 G12 独立批准、`hard-cut --enforce`、同候选部署和观察窗口全部完成后成立。以下任何组合都不算完成：

- 单元测试和 fixture browser smoke PASS；
- 本机 typecheck PASS 但 Linux CI OOM；
- CSS regex PASS 但没有 rendered/frame evidence；
- Web/API 接受 mixed request 而 Worker late reject；
- localhost 未启动或浏览器 connection refused；
- PR 未构建 production image；
- dirty tree 或混合 candidate 部署；
- Runtime Provider State、900 秒或 Knowledge 任一轨道仍 BLOCKED；
- G0–G11 任一 NOT RUN、BLOCKED、FAIL、INCONCLUSIVE 或 skipped。
