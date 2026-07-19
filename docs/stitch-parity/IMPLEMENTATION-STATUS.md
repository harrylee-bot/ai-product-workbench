# 产品工作台产品等价改造实施状态

更新日期：2026-07-18
实施规格：`CODEX-STITCH-PARITY-IMPLEMENTATION.md`
当前阶段：阶段 0-11 本地实现与回归门禁、阶段 12 服务器硬切与上线验收已完成
下一阶段：补齐 production security preflight（CDN edge CIDR、回源鉴权、DeerFlow immutable image pin），并在配置真实 provider 凭证后验证真实 Run/Import/Export；不保留旧项目兼容层

## 阶段 12：服务器硬切与上线验收（已完成）

### 硬切结果

- 服务器 `8.130.160.177` 已切换到唯一新项目部署目录；旧部署目录已不存在。
- 旧项目容器、旧应用镜像和未使用的旧卷已清理；仅保留新项目运行所需的 PostgreSQL、MinIO、ClamAV、Dex、Docling、Knowledge、Gateway、Preview、Web、API、Runtime Worker、File Worker、Import Worker 和 Export Worker 运行边界。
- DeerFlow 保留，并重新绑定“产品工作台”的 public skill/runtime tools；没有恢复旧项目源代码或旧业务容器。
- 仓库中的旧 `apps/api`、`packages/db`、Chat/AI SDK/SWR 前端、旧认证/API client、旧 Compose 与只服务旧 Conversation 链路的脚本已物理删除；根构建、类型检查和测试只保留新 Workbench workspace。
- 硬切 manifest 的 18 个仓库/服务器条目均有删除回执且非强制校验为 `ready`；状态保持 `cutover-accepted`，完整 production security acceptance 完成前不伪造 `completed`。

### 迁移与数据清理

- 数据库迁移最终状态为 57 条记录：56 条已成功生效，1 条首次失败尝试已安全标记 `rolled_back`，对应迁移随后重跑成功；最新迁移包含 `20260718030000_import_sources`。
- 按新项目硬切要求清理历史业务数据：`projects`、`threads`、`thread_entries`、`runs`、`runtime_attempts`、`export_jobs`、`artifacts`、`artifact_versions`、`boards`、`board_nodes`、`file_assets`、`file_upload_sessions`、`import_sources`、`import_source_blobs`、`share_grants`、`blobs` 均为 0 行。
- 身份与工作区基础数据保留：`auth_users=1`、`auth_accounts=2`（`credential` 与 `workbench-oidc` 各 1）、`principals=1`、`workspaces=1`、`workspace_members=1`。
- 历史验收会话和验证令牌已清理：`auth_sessions=0`、`auth_verifications=0`；账号、JWKS、Principal 和 Workspace 不受影响。
- 不迁移原始对话；`knowledge-vault` 保留（服务器约 3.3 MiB，661 个 Markdown、665 个文件）。线上知识库表未删除，当前为空（`knowledge_documents`、`knowledge_chunks` 等均为 0 行）。
- 旧项目 blob 及对应对象存储对象已删除。

### 线上健康检查

- `https://aionbench.com/healthz` 返回 HTTP 200：`{"status":"ready"}`。
- `https://aionbench.com/knowledge/` 返回 HTTP 200，知识库页面可访问。
- 服务器本机 Gateway `4180`、Preview `4190`、MinIO `9100/minio/health/live`、Dex `5556/healthz` 均通过；上述新项目容器均处于 healthy。

### 登录验收

- 生产登录页可直接使用 Better Auth 账号密码登录：账号 `workbench-admin` 登录 `https://aionbench.com/` 成功并进入“产品工作台”首页。
- 错误账号密码保持在产品登录页，不强制跳转 Dex；只有点击“企业 SSO 登录”才跳转到 `identity.8.130.160.177.sslip.io`。
- Better Auth credential 与原 `workbench-oidc` account 并存，业务权限模型未改动；密码材料只保存在服务器受限文件，未写入代码、文档或回执。

### 发布边界

- 新项目部署、旧项目删除、迁移、数据清理、健康检查和登录验收已完成；这不是兼容层发布，旧项目可彻底删除。
- 完整 production security acceptance 尚未宣称通过：当前服务器仍是 `server-validation` topology，preflight 还缺 `WORKBENCH_CDN_EDGE_CIDRS`，并需完成 CDN allowlist、回源鉴权审计和 DeerFlow immutable image pin。
- AI Studio、Netlify、Lovable、Bolt 的真实第三方 provider 凭证/adapter 仍按 capability fail-closed；fake provider 合同测试不等于真实外发已上线。真实 Run/Import/Export 长时序需在发布门禁和 provider 配置完成后补验。

## 阶段 7：Import Source 矩阵（已完成）

### 交付结果

- 首页和项目 Composer 统一复用真实 Import Source Dialog；可选择本地文件、`DESIGN.md`、网站 URL、公开 GitHub 仓库和 Figma 文件。
- `FileAsset → ImportSource → ImportSourceBlob` 是唯一导入链路；Run 只引用 `sourceIds`，不再暴露 `attachmentIds` 或 `RunAttachment`。
- 外部来源在 Worker 中固定为可审计快照：URL 每跳做 DNS 固定和 SSRF 检查，GitHub ref 固定为 40 位 commit SHA，Figma 固定为 versionId。
- 所有外部内容先做大小/媒体类型校验和 ClamAV 扫描，再写入 canonical object；生产环境 Import Worker 和 healthcheck 均要求 ClamAV 就绪。
- 单个 Run 的 Source Blob 总量上限为 50 MiB，并在合同、API、Worker 与 PostgreSQL 约束层重复校验。
- Source 处理使用 lease、连续 attempt、terminal 不可变和原子重试入队；Source 删除不影响既有 Run snapshot 审计。

### 验证结果

| 检查 | 结果 |
|---|---|
| `npm --workspace @workbench/workbench-contracts run test` | 24 files / 173 passed |
| `npm --workspace @workbench/workbench-import-worker run test` | 5 files / 66 passed，2 个 PostgreSQL 门禁 skip |
| Import Worker PostgreSQL 集成 | 2/2 passed（隔离 `workbench_import_source_test` schema） |
| PostgreSQL constraints | PASS，覆盖 Source 复用、attempt 不变量、快照审计和 50 MiB 上限 |
| PostgreSQL HTTP E2E | PASS，覆盖上传物化、SSE、Worker、审批、取消、重试、Canvas、Prototype |
| Web Import Source | list/create/get/delete、pending 轮询、ready-only、首页真实项目复用均有单测和类型检查 |
| Web production build | `next build --webpack` PASS，15 routes |

### 安全和部署边界

- Import Worker 使用独立 S3 凭据、受控 egress 和 ClamAV 服务；Compose、Dockerfile、server deploy target 和 preflight 已接入。
- 当前机器没有 Docker CLI，因此本机未执行真实镜像构建或 `docker compose config`；服务器 candidate Compose config、镜像构建与部署验收已完成，最终硬切结果见阶段 12。
- 本阶段没有迁移旧原始对话；按要求只保留知识库数据。`stitch-evidence-bundle` 保持只读，不同步到知识库或第三方。

## 阶段 8：首页和工作台视觉对齐（已完成）

### 交付结果

- 首页顶栏和项目工作台顶栏统一为 `56px`；桌面布局断点统一为 `md`（视口宽度 `>=768px`），桌面项目面板固定为 `375px`。
- `<768px` 首页项目列表改为固定底部抽屉：`height: calc(100vh - 80px)`、顶部圆角 `16px`、打开/关闭分别为 `translateY(0)` / `translateY(100%)`，关闭时禁用 pointer events，过渡时长 `300ms`。
- 项目 Composer、画布工具条、utility bar 和选择上下文工具条在窄屏使用紧凑布局，并按面板状态避让；移动工具条在无面板时位于底部 `190px`，面板打开时移至顶部 `76px`，utility bar 位于顶部 `132px`；`768-1023px` tablet 视口将 utility bar 提升到 Composer 上方 `124px`。
- 通用 Radix Dialog、导出、分享、重命名、审批和版本类 Dialog 在小屏切换为全屏；Import Source Dialog 在 `md` 断点切换为双栏，窄屏保持可滚动单栏。
- 首页、Composer 和工作台复用真实 Import Source 状态，保留“产品工作台”运行时品牌，不引入旧产品名称。

### 修改范围

| 路径 | 职责 |
|---|---|
| `apps/web/components/workbench/workbench-home-screen.tsx` | 56px 顶栏、桌面/移动项目面板、底部抽屉和窄屏 Composer 布局。 |
| `apps/web/components/workbench/workbench-project-chrome.tsx`、`workbench-project-route.tsx` | 工作台顶栏、画布和 Run 状态的响应式接线。 |
| `apps/web/components/workbench/workbench-canvas-tools.tsx` | 移动工具条、utility bar、zoom/menu 和面板避让。 |
| `apps/web/components/workbench/workbench-import-sources-dialog.tsx`、各 Workbench Dialog | Import Source 双栏及小屏全屏行为。 |
| `apps/web/app/globals.css` | Workbench 响应式、surface/outline/selection 语义 token 和全局尺寸约束。 |

### 验证结果

| 检查 | 结果 |
|---|---|
| Home/Composer 响应式单测 | 18/18 PASS。 |
| Workbench Web typecheck | PASS。 |
| Board Chromium smoke | PASS；1501x855、390x844、320x720 下工具条、Composer、面板和 Dialog 边界均通过，unknown request/console error 为 0。 |

### 阶段 8 剩余风险

- 1501x855、390x844、320x720 是补充交互 smoke 视口；规格要求的 375x812、768x1024、1440x900 固定视觉矩阵已由阶段 11 补齐并通过。
- Docker CLI 不存在，无法在本机执行镜像构建或 Compose 解析；服务器 candidate Compose config、镜像构建和部署已完成，残余发布门禁见阶段 12。

## 阶段 9：Motion 对齐（已完成）

### 交付结果

- `workbench-motion.ts` 提供共享 `tactileTransition`（150ms）、`popoverTransition`（150ms）、`menuItemTransition`（200ms）、`spatialTransition`（500ms）及既有浮动工具 `400ms` overshoot（`0.96 -> 1.046 -> 1`）。
- CSS 保留并对齐 Evidence Bundle 的生成态时序：screen enter `500ms`、panel pulse `600ms`、ellipsis `900ms`、spinner `1s`、skeleton `2.5s`，移动抽屉 `300ms`；新增 shimmer、状态过渡和语义 surface/motion token。
- 动画由 Run 的真实 generation stage 驱动：`thinking`、`design-system`、`mapping-components`、`creating-flows`、`generating-ui`、`screen-streaming`、`summarizing`。没有按猜测或固定生成时长触发工作台阶段动画。
- 所有新增空间动效接入 `prefers-reduced-motion` 与用户 motion preference；reduced 模式立即进入最终状态，持续状态 spinner/ellipsis 保持可理解。

### 修改范围

| 路径 | 职责 |
|---|---|
| `apps/web/components/workbench/workbench-motion.ts` | JS motion token、浮动工具/抽屉/面板 transition。 |
| `apps/web/app/globals.css` | keyframes、generation-stage selector、semantic color/motion token 和 reduced-motion 覆盖。 |
| `apps/web/components/workbench/workbench-project-{chrome,run-panels,screen-view}.tsx` | 将 Run generation stage 投影到画布、Agent panel 和 screen 入场动效。 |
| `apps/web/lib/workbench/motion-contract.spec.ts`、Run reducer/presenter tests | 时序、stage selector 和 reduced-motion 合同。 |

### 验证结果

| 检查 | 结果 |
|---|---|
| Motion contract | 4/4 PASS；覆盖时长 token、关键 keyframe、stage selector 和 reduced-motion。 |
| 阶段 9 受影响 Web 测试 | PASS；Run reducer/presenter 与 motion contract 均通过。 |
| Workbench Web typecheck/lint | PASS。 |
| Board Chromium smoke | PASS；Run 状态、面板、生成 screen enter、移动布局无 console error/unknown request。 |

### 阶段 9 剩余风险

- 动画参数已有合同测试，阶段 11 固定三视口已检查完成态交互和面板边界；真实生产 Run 的长时序仍需部署后验证。
- 真实生产 Run 时长和第三方模型响应不是本地 smoke 的证明；UI 只依赖服务端 stage/sequence，不应把本地观测时长写入产品逻辑。

## 阶段 10：缩放、快捷键和多选操作（已完成）

### 交付结果

- Zoom 菜单主操作改为 `Zoom in`、`Zoom out`、`Zoom to 100%`、`Zoom to Fit`、`Zoom to Selection`，分别接入 `Mod +`、`Mod -`、`Shift+0`、`Shift+1`、`Shift+2`；常用百分比降为次级 `Common scale` 区域。
- 画布键盘操作覆盖 `Mod+A`、`Shift+F`、`Mod+Z`、`Shift+Mod+Z`/`Mod+Y`、Delete/Backspace、Escape、Arrow 和 Shift+Arrow；微移步长分别为 1px/10px。
- Board store 新增 `nudgeNodes`；选中 Frame 及其子节点时只移动根节点，微移与排列/复制/删除一样作为单个 undo transaction，并保持 revision/autosave 原子性。
- 多选操作保留 Align、Distribute、Duplicate、Delete、Export、Generate variants；选择上下文工具条和 viewport clamp 在桌面/移动端均保持可用。

### 修改范围

| 路径 | 职责 |
|---|---|
| `apps/web/lib/workbench/board/store.ts`、`store.spec.ts` | 根节点微移、Frame 子节点折叠和 undo transaction。 |
| `apps/web/components/workbench/workbench-project-route.tsx` | Zoom/keyboard command、权限和 active Run 写锁接线。 |
| `apps/web/components/workbench/workbench-canvas-tools.tsx` | 语义 Zoom 菜单、快捷键提示和响应式菜单布局。 |
| `apps/web/components/workbench/workbench-screen-context-toolbar.tsx`、arrange/action modules | 多选批量操作和 selection/viewport 边界。 |

### 验证结果

| 检查 | 结果 |
|---|---|
| Board store nudge tests | PASS；覆盖 1px/10px 和 Frame 根节点语义。 |
| Canvas tools 定向测试 | PASS；覆盖语义 Zoom 命令及菜单操作。 |
| 阶段 9/10 聚焦 Web 测试 | 5 个聚焦文件共 51/51 PASS。 |
| Board Chromium smoke | PASS；桌面、390x844、320x720 下缩放、快捷键、多选、Undo/Redo 和面板边界通过。 |

### 阶段 10 剩余风险

- 当前浏览器 smoke 已覆盖真实 pointer/keyboard，阶段 11 已在 375x812、768x1024、1440x900 重复验证缩放锚点、选择工具条和 Composer/面板避让。
- 高级对齐/分布仍沿用 Board domain 的一次性写入边界；未新增旧接口或兼容层。

## 阶段 11：视觉与状态机回归（已完成）

### 当前状态

- 规格固定视口 `375x812`（mobile）、`768x1024`（tablet）和 `1440x900`（desktop）已在真实 Chromium 中逐一通过。
- 固定 audit 在同一真实 Board/Composer fixture 中检查 Workbench stage、Canvas rail、utility bar、Composer、screen context toolbar、project menu、members Dialog、attachment menu、Import Source Dialog、Favourites 和 Design system panel 的 bounds、viewport clamp、面板避让和可交互状态。
- audit 在每个固定视口前重置并 reload Board viewport（`x=70,y=80,zoom=0.63`），确保窄屏截图包含真实画布节点；同时保留真实 pointer/keyboard、Escape、ARIA menu/Dialog、zoom/selection、Import Source、Favourites/Design system 和 Board save 路径；既有 Preview、Run reconnect、Prototype patch、Agent approval、Export confirmation smoke 继续作为跨模块证据。

### 已有证据

- 固定矩阵命令：`WORKBENCH_E2E_WEB_ORIGIN=http://127.0.0.1:33413 npm run e2e:web:board`；加入 Home drawer 后又在 `http://127.0.0.1:33414` 完整复跑。
- 结果：`ok=true`、`saveCount=6`、`finalRevision=18`，unknown request `0`、console error `0`；三视口所有 bounds 均在 viewport 内。
- tablet 关键避让：utility bar bounds 的 `y=862`，Composer bounds 的 `y=912`，两者无交叠；移动端附件菜单在窄屏左对齐，避免从 Composer 右侧越界。
- 375x812 Home drawer 关闭态 bounds 为 `{x:0,y:812,w:375,h:732}`，打开态为 `{x:0,y:80,w:375,h:732}`；使用 `0.3s` transform 过渡，关闭态 `pointer-events:none`。内容区 `clientHeight=591`、`overflow-y:auto`，真实滚动可用。
- 截图均位于 gitignored `output/playwright/`，以下尺寸、字节数和 SHA-256 是本轮本机冻结证据，不把生成物当作可追溯提交内容。

| 场景 | 尺寸 | 字节 | SHA-256 | 本地文件 |
|---|---:|---:|---|---|
| 阶段 11 mobile 固定完成态 | 375x812 | 152226 | `fb4153af9700c4c2a013e7b9ace22f3639311aa905d1471d50bac493639d167e` | `output/playwright/workbench-phase11-mobile-375x812.png` |
| 阶段 11 Home drawer 打开态 | 375x812 | 26917 | `db2a982bb596cea43a75464ff5ca66e0c722213b4f7d6c4b26aa615de24ab56e` | `output/playwright/workbench-phase11-home-drawer-mobile-375x812.png` |
| 阶段 11 tablet 固定完成态 | 768x1024 | 445014 | `53ba62efaef8f34b85441ce27adc4c05c0f0ca6a946eaadd4322b5b56b01462b` | `output/playwright/workbench-phase11-tablet-768x1024.png` |
| 阶段 11 desktop 固定完成态 | 1440x900 | 532864 | `6a300f0c5e2463c3bdb871e3ca630aa17d94b2d02e72dfa5b9f88f0a9252c362` | `output/playwright/workbench-phase11-desktop-1440x900.png` |

### 固定视口像素证据

| 视口 | entropy | max stdev | non-empty canvas pixels |
|---|---:|---:|---:|
| 375x812 | 4.8584 | 62.5758 | 55386 |
| 375x812 Home drawer | 1.8946 | 22.2172 | 9354 |
| 768x1024 | 5.1064 | 36.1454 | 80906 |
| 1440x900 | 4.5982 | 28.8894 | 89961 |

### 阶段 11 修改范围

| 路径 | 职责 |
|---|---|
| `scripts/e2e/workbench-board-tools-smoke.mjs` | 新增固定三视口 audit、Home drawer transform/scroll/pointer 状态、bounds/overlap、Dialog/menu 状态、PNG 尺寸和 sharp 像素非空检查。 |
| `apps/web/components/workbench/workbench-composer-menus.tsx` | 项目 Composer 附件菜单在 `max-sm` 左对齐，避免窄屏越界。 |
| `apps/web/app/globals.css` | utility bar 独立响应式定位；`768-1023px` 使用 `bottom: 124px` 避让 Composer，移动端保持 `top:132px`。 |

### 阶段 11/发布前全量门禁（当前工作区）

| 检查 | 结果 |
|---|---|
| Web tests | 178 files / 854 passed，1 skipped。 |
| Workbench contracts | 24 files / 173 passed。 |
| Import Worker | 66 passed，2 skipped。 |
| Runtime Worker | 167 passed，21 skipped。 |
| File Worker（授权模式） | 13 files / 105 passed。 |
| Content Security | 1/1 PASS。 |
| PostgreSQL constraints（隔离 `workbench_import_source_test`） | PASS；56 migrations，325/325 checks。 |
| PostgreSQL HTTP E2E（隔离 `workbench_import_source_test`） | PASS；覆盖 membership/invitation、SSE revocation、Run success/idempotency/replay、Prototype patch、Canvas Gateway、Generate Prototype source projection、approval resume、cancel 和 retry。 |
| Root typecheck | PASS；runtime validator bundle 先生成并通过一致性检查。 |
| Runtime validator bundle | 155863 B，SHA-256 `599e67e44ea665a1d3355cbc25aa21cb17c7c6774e9ea7f429def08e250788b6`。 |
| Production build | PASS；显式提供非敏感 S3 browser upload URL。 |
| Workbench lint | PASS；0 errors、0 warnings（已移除 `workbench-canvas-tools.tsx:444` 的未使用 `projectMode`）。 |
| OpenAPI / architecture / brand | PASS；OpenAPI 92 paths，Workbench architecture 0 violation，运行时品牌检查通过。 |
| `git diff --check` | PASS。 |

### 剩余风险与发布边界

1. 本机没有 Docker CLI；服务器 candidate 的 `docker compose config`、镜像构建和新项目部署已通过，首轮镜像构建暴露的 Canvas Tools Docker 依赖问题已修复。
2. 服务器硬切、旧项目删除、生产账号密码登录、Better Auth credential/JWT 接线和 SSO 可选跳转已验收；真实 Run/Import/Export 长时序仍需在真实 provider 凭证和 production security preflight 完成后补验。
3. AI Studio、Netlify、Lovable、Bolt 等真实第三方 provider 凭证/adapter 仍按 capability fail-closed，fake provider 的协议测试不等于生产外发已上线。
4. 当前工作区仍是 dirty worktree；部署和删除服务器项目已按授权完成，提交/推送仍需在文件归属审查后单独执行。

## 阶段 1：画布工具语义重构（已完成）

### 执行边界

- 本阶段只实现实施规格中的阶段 1；阶段 2 在本阶段结束后独立实施，没有混入阶段 1 的交付边界。
- `/Users/liyannong/stitch-evidence-bundle` 始终只读，没有复制到仓库、`knowledge-vault`、项目数据库知识库或任何外部知识库。
- 产品可见名称继续使用“产品工作台”；旧参考名称只保留在内部实施规格和证据说明中。
- 没有提交、推送、部署、发布或操作任何外部服务。

### 产品语义结果

| 能力 | 阶段 1 最终行为 |
|---|---|
| 主工具栏 | 固定为 `Select`、`Marquee`、`Direct edit`、`Pan`、`Media`、`Design system`、`Favourites` 七项，顺序受单测和 E2E 双重约束。 |
| More tools | 保留 `Frame / Create` 与 `Freehand`；没有为了对齐主栏而删除原有画板能力。 |
| Select | 普通选择、节点拖动和 `Shift` 多选；当前有效选择只由 React Flow 本地交互态决定。 |
| Marquee | 空白区域拖动执行真实框选；不会创建 Frame，也不会产生 Board 保存。 |
| Direct edit | 仅在恰好一个 persisted、complete、ready、inline Prototype screen 被选中时启用。 |
| Pan | 从空白或节点起点拖动都只改变 viewport；节点 position/parent 不变，并保留精确多选 ID 集合。 |
| Media | editor 且没有 active Run 时可用；viewer 和 active Run 均禁用。 |
| Design system | 替代旧 Style 产品语义；viewer 和 active Run 可只读查看，写控件被锁定但面板仍可关闭。 |
| Favourites | 项目级分页列表，支持 Prototype screen 和非 Prototype ArtifactVersion；空态固定为 `No favourites yet`，不显示额外快捷键教学文案。 |
| `Shift+F` | 复用 ArtifactVersion Preference ETag/CAS；快速连续触发严格串行，后一个请求使用前一个响应的新 revision。 |

旧 `WorkbenchCanvasToolId` / `WorkbenchRuntimeCanvasTool` 已移除。画布状态拆为：

```ts
type CanvasInteractionMode =
  | "select"
  | "marquee"
  | "direct-edit"
  | "pan"
  | "frame-create"
  | "freehand";

type CanvasPanel = "media" | "design-system" | "favourites" | null;
```

### Selection 与权限边界

- React Flow 使用 `selectionKeyCode={null}`、`multiSelectionKeyCode="Shift"`；只有 Marquee 开启 `selectionOnDrag`。
- persisted Board 投影会丢弃 `selected` 和节点级 `draggable`，避免覆盖全局 mode/permission 策略。
- Board viewport 或节点保存 ACK 重新投影时，通过仍存在的 node ID 合并本地 selection；已删除节点自然退出选择。
- 单选 URL 深链优先于已有本地选择；多选不会伪造一个单选 URL。
- `select` change 不进入 Board store；position、dimension、viewport 等持久变化仍走原有 revision/idempotency/autosave 边界。
- viewer 只允许 Select、Pan、Design system/Favourites 只读面板；active Run 同样锁定所有写工具和 Design system commit。

### 合同与 API

- 新增 `GET /projects/{projectId}/artifact-version-favorites`，继承 OIDC bearer 鉴权并要求 Project `read` 权限。
- 返回 principal/project 隔离的 keyset page；排序为 `updatedAt desc, artifactVersionId desc, screenId desc`，cursor 为作用域绑定的 opaque 值。
- 只返回 ready ArtifactVersion；blob-backed 版本必须指向 ready 且未删除的 blob。
- Prototype 收藏必须解析为合法 `PrototypeDocument` 并命中真实 screen；损坏内容或伪造 screen fail-closed。
- 响应使用 `Cache-Control: private, no-store`；列表上限为 100，默认 30。
- OpenAPI 从 79 paths / 97 operations 增至 80 / 98；validator 已增加路径、鉴权、参数、cursor、响应和 ProblemDetails 语义断言。
- Web 生成类型与 OpenAPI YAML 字节一致，SHA-256 均为 `957597afe47696586619765481676947bca21c821b962c5c111de7132579db73`。
- 没有数据库 schema 或迁移变化，继续复用现有 ArtifactVersion Preference 表与 CAS 模型。

### 修改范围

| 路径 | 职责 |
|---|---|
| `packages/workbench-contracts/src/{artifacts,http-routes,openapi-document}.ts` | Favourites 列表合同、路由和 OpenAPI 注册。 |
| `packages/workbench-contracts/openapi/workbench.v1.yaml`、`packages/workbench-contracts/scripts/validate-openapi.js`、相关合同测试 | 80/98 生成合同、语义门禁和回归测试。 |
| `apps/workbench-api/src/modules/artifacts/artifact-version-preferences.*`、`artifacts.module.ts` | 项目级收藏读取、权限、分页、内容验证与 HTTP 暴露。 |
| `apps/workbench-api/test/artifact-version-preferences*` | service/controller/PostgreSQL 权限与隔离测试。 |
| `apps/web/lib/workbench/canvas-tools/*` | interaction mode、panel、Direct edit、viewer/active Run 的纯领域状态机。 |
| `apps/web/components/workbench/workbench-{canvas-tools,project-route,project-screen-view,project-screen-controller,runtime-context,runtime}*` | React Flow 行为、工具栏、selection 投影和运行时接线。 |
| `apps/web/components/workbench/workbench-canvas-{design-system,favourites}-panel*` | Design system 与 Favourites 面板、只读/空态/分页交互。 |
| `apps/web/lib/workbench/features/artifacts/*`、`query/keys*`、`api/schema.d.ts` | 收藏 API adapter、infinite query、项目隔离缓存失效和生成类型。 |
| `scripts/e2e/workbench-board-tools-smoke.mjs` | 七项顺序、Marquee、Direct edit、Pan、More tools、Freehand、快速 CAS 与面板布局的真实浏览器门禁。 |
| `integrations/deerflow/runtime-tools/deerflow_workbench_tools/runtime_result_validator.bundle.mjs` | 合同导出变化后的确定性 validator bundle 再生成。 |

### 验证结果

| 检查 | 结果 |
|---|---|
| Canvas/面板聚焦测试 | 6 files、41/41 PASS。 |
| `npm --workspace @workbench/web run test` | 153 files passed、1 skipped；687 passed、1 skipped、688 total。 |
| `npm --workspace @workbench/workbench-api run test` | 54 files passed、11 skipped；348 passed、26 skipped。 |
| 收藏 API 定向测试 | 2 files、13/13 PASS。 |
| Contracts 全量 | 20 files、131/131 PASS。 |
| `npm run e2e:web:board` | 多次连续 PASS；最终 `saveCount=6`、`finalRevision=7`，快速 CAS `If-Match` 为 `"2"`、`"3"` 且最大并发为 1。 |
| `npm run typecheck` | 全 workspace PASS；同时确认 OpenAPI、runtime schema、runtime validator 与 Prisma 生成物一致。 |
| `npm run lint:workbench` | PASS，0 warning / 0 error。 |
| `npm run architecture:workbench` | 442 modules、1478 dependencies、0 violation；Agent runtime architecture 3/3。 |
| `npm run deerflow:tools:test` | 20/20 PASS。 |
| `npm run openapi:check` / `npm run openapi:breaking` | PASS；80 paths，新增接口为 additive change。 |
| `npm run brand:check` | PASS；运行时表面使用“产品工作台”/`workbench`。 |
| OpenAPI Web schema 再生成比较 | `cmp` PASS；两份 SHA-256 相同。 |
| `git diff --check` / 冲突标记扫描 | PASS。 |

### 浏览器与截图证据

Board E2E 在 Chromium 中验证 1501×855 和 390×844。Favourites、Design system 均等待 bounds、opacity、transform 连续稳定后再断言：完整位于 viewport 内，且不与右侧工具栏或底部 composer 重叠；Design system 同时要求加载完成且无错误态。

| 场景 | 尺寸 | 字节 | SHA-256 | 本地文件 |
|---|---:|---:|---|---|
| 工具栏与画布完成态 | 1501×855 | 492917 | `a30a7697f33153f8f1ce5e1819febf1dc7a8395225eacbdb85559266f7aa91f1` | `output/playwright/workbench-board-tools-desktop-1501x855.png` |
| 工具栏与画布完成态 | 390×844 | 175148 | `e6f2f4751afcd32fe6106054b9118b51a95d60a7f467b627c7fd06b9ee75edbe` | `output/playwright/workbench-board-tools-mobile-390x844.png` |
| Favourites 面板 | 1501×855 | 543568 | `baca90b930f03438d8f9c29be0d6cb5b31f6f2a5eb2f4d90b2b320d587d9dae7` | `output/playwright/workbench-board-favourites-panel-desktop-1501x855.png` |
| Favourites 面板 | 390×844 | 168010 | `40d338adb759bfdd724f25452940929b541fa1ceec61767c8fbe18d13a12d84d` | `output/playwright/workbench-board-favourites-panel-mobile-390x844.png` |
| Design system 面板 | 1501×855 | 545573 | `4e64c7d8a7f05ad196fcd14bdbd99d34f870a3291bd5622bbca5d08035dc7737` | `output/playwright/workbench-board-design-system-panel-desktop-1501x855.png` |
| Design system 面板 | 390×844 | 142071 | `94d711ab3065b86d005fd4787b8db982e912eacf74efbffeee6f675a7d523f6b` | `output/playwright/workbench-board-design-system-panel-mobile-390x844.png` |

这些截图位于 gitignored `output/`，只作为本机冻结的验收证据；字节级 SHA 不要求跨运行稳定。桌面工具栏同时与 Evidence Bundle 的 `reference-images/workspace-complete.png` 做了人工对照：七项主工具语义和分组一致，More tools 是本项目为保留 Frame/Create 与 Freehand 的明确扩展。

### SKIP、偏差与剩余 UNKNOWN

1. `artifact-version-preferences.postgres.spec.ts` 在当前 shell 中因没有 `WORKBENCH_TEST_DATABASE_URL` 跳过 2/2；没有擅自复用历史 QA 数据库。service/controller 隔离逻辑已由 13/13 定向测试和 API 全量覆盖，真实 PostgreSQL 仍需在隔离测试库或 CI 中执行。
2. 阶段 1 没有重跑根 `npm test`、统一跨浏览器 `npm run e2e:web` 或 production build；这些在阶段 0 已通过，本阶段按规格运行了受影响的 Contracts、API、Web、DeerFlow validator 和 Board E2E 全量门禁。
3. 390×844 是现有 Board smoke 的移动视口，不替代阶段 11 要求的 375×812、768×1024、1440×900 固定视觉矩阵；固定矩阵结果见顶部阶段 11 章节。
4. 当前交付仍依赖既有 dirty worktree；提交前必须按阶段审查文件所有权，不能把不相关改动混入阶段 1。

### 阶段 1 结束时边界（历史记录）

- 阶段 1 结束时阶段 2 尚未开始；本阶段没有加入 Generate / Modify / Preview / More 选择上下文工具条。
- 阶段 2 随后在不改变收藏 API、数据库 schema 或权限合同的前提下实施。

## 阶段 2：画板选择上下文工具条（已完成）

### 执行边界

- 本阶段只实现实施规格中的阶段 2，没有进入阶段 3 的 Live Mode Canvas Tool Gateway、Agent 画布读写工具或新的外部工具协议。
- `/Users/liyannong/stitch-evidence-bundle` 始终只读，没有复制到仓库、`knowledge-vault`、项目数据库知识库或任何外部知识库。
- 产品可见名称继续使用“产品工作台”；没有新增 Stitch 运行时文案。
- 没有修改 API/OpenAPI、数据库 schema、权限模型，也没有提交、推送、部署、发布或操作外部服务。
- active Run 按 Evidence Bundle 的状态语义隐藏选择上下文工具条；同时在 Board permission、键盘快捷键、拖拽/缩放、Undo/Redo、Pin、重命名/删除弹窗和异步编辑提交入口统一 fail-closed，避免旧 UI 或竞态写入 Board。

### 产品语义结果

| 能力 | 阶段 2 最终行为 |
|---|---|
| 单选工具条 | 对 ready generated screen 显示 `Generate`、`Modify`、`Preview`/`Generate prototype`、`More`，下方显示 screen 标题、逻辑尺寸和拖拽柄；工具条随 selection bounds 锚定，画布缩放不缩放控件。 |
| 多选工具条 | 显示 `Align`、`Distribute`、`Duplicate`、`Delete`、`Export`、`Generate variants` 与 `<n> selected`；排列使用绝对坐标计算并写回 Frame 相对坐标，一次 history、一次 editVersion、一次 autosave。 |
| Generate | 创建带 immutable screen reference 的 typed Composer intent；不覆盖当前 ArtifactVersion，不把非 edit target 偷塞进 Run 合同，也不把 target 拼接到 prompt。 |
| Modify | typed inline Prototype 优先进入现有 Direct edit；否则冻结 `edit` workflow、模型和 `artifactTargets`，选择变化不会静默漂成 Generate；模型/权限失效时显式清除 intent。 |
| Preview | 所选 screen 自身有 action 且是 ready inline Prototype 时打开 isolated Preview；没有 action 时显示 `Generate prototype` intent；兄弟 screen 的 action 不会污染当前判断。 |
| More | 保留 Rename、Duplicate、Favourite/Unfavourite、Like/Dislike、Version history、Copy link、Export、Delete，原有偏好和版本处理链未回退。 |
| Board selection | Duplicate 只返回 created IDs，Board domain 不再改写 selection；selection 由 UI controller 的 one-shot pending selection 维护，Undo/Redo 不会伪造或恢复过时 selection。 |
| 异步水合 | Rename/Delete/Duplicate/Export/Version history 等 Board-local 操作不再等待 Artifact 内容查询；Modify/Preview/Generate 仍按真实版本、screen、action 和合同状态 fail-closed。 |
| 偏好并发 | Favourite/Like/Dislike 队列按 `project/artifact/version/screen` immutable key 分片；不同 screen 不串写，同一 screen 严格使用前一响应的 revision。 |
| 键盘与移动端 | More/Align/Distribute 使用完整 menu focus pattern（ARIA trigger、roving focus、Arrow/Home/End/Escape、焦点恢复）；工具条和菜单有 viewport/safe-area clamp、上下翻转及纵向滚动。Rename 使用 Radix modal、字段 label、focus trap、Escape 和 opener focus restore。 |

### 修改范围

| 路径 | 职责 |
|---|---|
| `apps/web/components/workbench/workbench-screen-context-toolbar.tsx` | 单选/多选 surface、More/Align/Distribute menu、ARIA focus、viewport collision 和菜单翻转。 |
| `apps/web/components/workbench/workbench-project-route.tsx` | screen context 状态接线、typed Composer intent、active Run 写锁、Board 原子命令、偏好协调器和 Preview/Generate 分支。 |
| `apps/web/components/workbench/workbench-project-screen-view.tsx`、`workbench-board-nodes.tsx` | 工具条挂载、旧 SelectedActionPill 边界、screen title replacement 和 Pin/删除 UI 权限。 |
| `apps/web/components/workbench/workbench-project-screen-controller.ts`、`workbench-project-composer.tsx` | immutable screen context、workflow/model freeze、Composer target 显示和提交合同接线。 |
| `apps/web/components/workbench/workbench-rename-dialog.tsx` | accessible rename modal 与焦点生命周期。 |
| `apps/web/lib/workbench/features/screen-context.ts` | none/single/multiple 状态机、runtime action analysis、权限原因和 Board-local/runtime availability 分离。 |
| `apps/web/lib/workbench/features/workbench-canvas-permissions.ts` | active Run 下的统一 Board read-only permission。 |
| `apps/web/lib/workbench/board/{arrange,node-actions,store}.ts` 及测试 | 绝对坐标排列、selection 不入 duplicate domain、history/autosave 原子性。 |
| `apps/web/lib/workbench/features/artifacts/application/preference-toggle-coordinator.ts` | 按 immutable target 分片的偏好切换队列。 |
| `scripts/e2e/workbench-board-tools-smoke.mjs` | 单/多选工具条、缩放锚定、typed intent、Duplicate/Align/Distribute/Export/Delete、桌面/移动端 surface 与菜单边界。 |

### 验证结果

| 检查 | 结果 |
|---|---|
| 阶段 2 聚焦测试 | 9 files、87/87 PASS；包含工具条、Rename modal、Composer/controller、screen context、Canvas permission、偏好协调器、Board store/arrange。 |
| `npm --workspace @workbench/web run test` | 158 files passed、1 skipped；729 passed、1 skipped、730 total。 |
| `npm run e2e:web:board` | 连续多轮 PASS；末次 `saveCount=6`、`finalRevision=15`，阶段 2 五条 Board 命令各保存恰好一次；快速 CAS `If-Match` 为 `"2"`、`"3"`，最大并发为 1；移动端 More 菜单也通过 viewport/rail/composer 边界。 |
| `npm run typecheck` | 全 workspace PASS；OpenAPI、runtime schema、runtime validator、Prisma 生成物和 Web 类型均通过。 |
| `npm run lint:workbench` | PASS，0 warning / 0 error。 |
| `npm run architecture:workbench` | dependency-cruiser 451 modules、1512 dependencies、0 violation；Agent runtime architecture 3/3。 |
| `npm run brand:check` | PASS；运行时表面使用“产品工作台”/`workbench` 命名。 |
| `git diff --check`、尾随空格、冲突标记扫描 | PASS；阶段 2 相关文件无匹配。 |

### 浏览器与截图证据

Board E2E 在 Chromium 中验证 1501×855 和 390×844。工具条可见 surface、More 菜单、Favourites、Design system 均等待 bounds/opacity/transform 稳定后检查 viewport、右侧 rail 和底部 composer；桌面与移动截图已人工目视检查。

| 场景 | 尺寸 | 字节 | SHA-256 | 本地文件 |
|---|---:|---:|---|---|
| Screen context toolbar More | 1501×855 | 503206 | `2e82baa94d3e7baaa7d53d09339aeee15dd07bdeedf4a4a9f04548de718ce9fd` | `output/playwright/workbench-screen-context-toolbar-desktop-1501x855.png` |
| Screen context toolbar | 390×844 | 187906 | `ffba007ab367b57ee2c561ccfff73fcca6a2bc96a37d10faf54ae8fa8fdd345d` | `output/playwright/workbench-screen-context-toolbar-mobile-390x844.png` |
| Board tools desktop | 1501×855 | 538521 | `b6bb06e7a16b061d619d1bc4e77eca426c37c3bd3f4ebb446ec99c1d726ebae0` | `output/playwright/workbench-board-tools-desktop-1501x855.png` |
| Board tools mobile | 390×844 | 195161 | `99615830f06c8214943773f253e305ee5755af3ab9f51309a73522bfdc995ae0` | `output/playwright/workbench-board-tools-mobile-390x844.png` |

截图位于 gitignored `output/`，只作为本机冻结验收证据；字节级 SHA 不要求跨运行稳定。固定 375×812、768×1024、1440×900 视觉矩阵已在阶段 11 章节记录。

### SKIP、偏差与剩余 UNKNOWN

1. 本阶段没有提供 `WORKBENCH_TEST_DATABASE_URL`，未擅自复用历史 QA 数据库；阶段 1 记录的 PostgreSQL 定向测试 skip 仍有效。本阶段无 API/schema/db 改动，未重复运行数据库集成套件。
2. Board E2E 使用 Chromium + mocked HTTP fixture，已验证真实浏览器 DOM、布局、键盘和交互合同；跨浏览器统一 E2E 与真实后端环境仍属于既有发布门禁，不在阶段 2 范围内。
3. active Run 隐藏上下文工具条是 Evidence Bundle 明确状态语义；领域层保留 immutable runtime/read availability，但本阶段不新增阶段 3 的 Agent 画布操作入口。
4. 当前交付仍依赖既有 dirty worktree；提交前必须按阶段审查文件所有权，不能把不相关改动混入阶段 2。

### 阶段 2 结束时边界（历史记录）

- 阶段 2 结束时阶段 3 尚未开始；当时没有 Agent canvas read/write tools、Live Mode gateway、审批协议或外部工具授权。
- 阶段 3 随后独立实现，没有把阶段 2 的本地 typed intent 直接当成 Agent 画布执行能力。

## 阶段 3：Live Mode Canvas Tool Gateway（首批 8 工具已完成）

### 执行边界

- 本阶段实现规格 3.4 第一批的 `get_visible_screens`、`get_selected_screens`、`view_screen`、`select_screen`、`quick_edit`、`duplicate_screen`、`rename_screen`、`navigate_canvas`。
- 第二批工具没有提前实现；阶段 4 的 Prototype 增量 Patch 合同、apply queue、recovery 和客户端 patch 投影均未开始。
- `/Users/liyannong/stitch-evidence-bundle` 始终只读，没有复制到仓库、`knowledge-vault`、项目数据库知识库或任何外部知识库。
- 产品可见名称继续使用“产品工作台”；旧参考名称只出现在内部规格与证据对比说明中。
- 没有提交、推送、部署、发布或操作外部服务。

### 产品与运行时结果

| 能力 | 阶段 3 最终行为 |
|---|---|
| 动态能力描述 | Worker 根据当前 Project、Run、浏览器 Canvas snapshot、选择、权限、active mutation 和 edit model 生成有序 `declaredTools`，签发短期 request-scoped capability；模型参数不能提交 principal、Project、Run、Board、revision、endpoint 或 token。 |
| 读取 | `get_visible_screens` 与 `get_selected_screens` 只返回当前 snapshot 内的 opaque screen reference 和受限摘要；分页、数量、route、标题与结构均受合同上限约束。 |
| `view_screen` | API 返回真实节点、action、state、motion 计数并发出 `preview.open` client command；Web 打开 isolated Preview 后同步完整 Canvas state 再 ACK。当前不向模型提供截图，见偏差说明。 |
| UI 指示 | `select_screen` 与 `navigate_canvas` 只产生绑定 Project、Thread、Run、client session generation、Board revision 和 Canvas state revision 的 client command，不直接持久化 Board。 |
| Run intent | `quick_edit`、`rename_screen`、`duplicate_screen` 只在当前 active edit Run 的精确单屏 target 上接受；不创建嵌套 Run，也不由 API 提前修改 Artifact。 |
| 最终发布 | `quick_edit` 由 Runtime 返回完整 revise 文档；rename/duplicate 作为有序 staged intent 叠加到 Runtime 结果。Worker 在同一最终发布事务中创建 ready ArtifactVersion、更新 Board 并回填 invocation 的最终版本审计链。 |
| 冲突规则 | `quick_edit` 与 structural intent 禁止在同一 Run 混用；direct intents 使用持久化 invocation sequence，重复或乱序 sequence、目标漂移和 Board revision 漂移均 fail closed。 |
| 生命周期 | Run 成功、失败、取消或进入 waiting input 时，session、grant、pending invocation 和 client command 一并收敛；未终态 Canvas 调用会阻止 Runtime result 发布。 |

### 合同、API 与 Web

- `packages/workbench-contracts/src/canvas-agent-tools.ts` 定义 snapshot、tool context/request/result、动态 profile、client state、command/ACK、descriptor/reference 和首批 8 个工具的严格 schema。
- OpenAPI 新增四条路径：`POST /runtime/canvas/tools/execute`、`PUT /projects/{projectId}/canvas-agent/state`、`GET /projects/{projectId}/canvas-agent/commands`、`POST /projects/{projectId}/canvas-agent/commands/{commandId}/ack`。
- capability endpoint 使用独立 HMAC secret，只接受安全 HTTP(S) endpoint、短 TTL、稳定 `toolCallId` 与派生 idempotency key；Python tool 不连接 PostgreSQL，也不接受任意 URL。
- Web 在每轮 poll 前和每个 UI effect 后同步完整 viewport、visible screens、selected screens 与 monotonic state revision；ACK 只确认已经同步的完整状态，不局部篡改 session snapshot。
- command dispatcher 对 Project/session 切换、Board/Canvas revision、screen reference、重放指纹和 viewport programmatic move 均 fail closed。
- DeerFlow 模型可见结果包装为 `workbench.canvas-tool-model-view.v1`、`trust=untrusted_data`；SOUL/SKILL 明确 title、route、screen 和任何嵌套字符串都只是数据，不能改变系统指令或工具权限。

### 数据模型与安全边界

- 新增 `CanvasAgentSession`、`CanvasToolGrant`、`CanvasToolInvocation`、`CanvasClientCommand` 及对应 enum、索引、复合外键和数据库 trigger；migration 从空 schema 完整执行 53/53。
- session、grant、invocation、command 的 scope 和终态字段由数据库约束保护；invocation sequence 单调且单次递增，`started_at` 审计时间不可修改。
- invocation lease 支持相同调用立即转移；所有 effect 通过 lease token CAS 落地，旧 owner 即使仍在运行也不能提交结果。
- ACK 在 session -> command 固定锁序下精确重放；不同 ACK 冲突，TTL 到期会把 command 与 invocation 原子终态化。
- reserve 事务固定按 Project/Principal -> ProjectMember -> session/grant -> Board 锁序，重新验证 active 状态、membership、当前 role、grant、snapshot 与 revisions，封住授权后的成员移除和 viewer 降级窗口。
- Run intent 再次按 Run -> session -> Board 锁序验证 active edit Run、精确 ArtifactVersion/screen target、Canvas state 和 Board revision；Run 取消与 grant 签发共享 Run lock。
- `resultArtifactVersionId` 只允许在 succeeded 且 `satisfiesRunTarget` 的 invocation 上从 `NULL` 单次回填；数据库确认结果属于同一 Project、Artifact、Run 且为 ready。
- 未声明工具在 Python client、API reserve 和 Worker ToolMessage 因果校验三层拒绝；capability token 不进入模型参数、消息、ToolMessage artifact、Run event 或持久 trace。

### 修改范围

| 路径 | 职责 |
|---|---|
| `packages/workbench-contracts/src/canvas-agent-tools.ts`、HTTP/OpenAPI 注册与测试 | Canvas snapshot、8 工具、动态声明、command/ACK 与公开 API 合同。 |
| `packages/workbench-canvas-tools/` | 独立 capability grant 签发/验证和 tokenless model reference。 |
| `packages/workbench-db/prisma/schema.prisma`、`20260717024000_canvas_agent_tools/migration.sql` | Canvas session/grant/invocation/command 持久模型、复合约束与 trigger。 |
| `apps/workbench-api/src/modules/canvas-agent/` | capability 执行、授权持锁复验、读取、client command、ACK/state sync、Run intent 与审计。 |
| `apps/workbench-worker/src/runtime/canvas-tool-grant.service.ts`、`deerflow-runtime.adapter.ts` | snapshot 授权、descriptor 注入、secret 隔离和 Canvas ToolMessage 因果门禁。 |
| `apps/workbench-worker/src/runs/canvas-staged-intents.ts`、`run-processor.ts` | staged intent 分类、最终 Artifact/Board 发布、结果关联和生命周期清理。 |
| `apps/web/lib/workbench/features/canvas-agent/`、`workbench-project-route.tsx` | snapshot 捕获、完整 state sync、command poll/dispatch/ACK 和 UI effect。 |
| `integrations/deerflow/runtime-tools/deerflow_workbench_tools/canvas_{client,tool}.py` | 受信 HTTP client、严格输入/响应验证、pending poll 和模型不可信数据包装。 |
| `scripts/deerflow-workbench-tool-contract.mjs`、DeerFlow merge/deployment tests | 4 个核心工具 + 8 个 Canvas 工具的唯一 canonical 注册清单和精确生产门禁。 |
| `scripts/workbench-postgres-http-e2e.mjs` | 真实 API/Worker/PostgreSQL + fake DeerFlow 的 8 工具跨层往返与数据库审计。 |

### 验证结果

| 检查 | 结果 |
|---|---|
| API Canvas 聚焦 | 29/29 PASS；覆盖 lease 转移/fencing、state/Board TOCTOU、成员移除、viewer 降级、Project/Principal 停用、外 Project target、非 Run 精确 target、并发 quick edit、ACK 重放和 TTL。 |
| API 全量 | 379 passed、28 skipped；typecheck/build PASS。 |
| Worker 全量 | 139 passed、12 skipped；typecheck/build PASS。 |
| Worker 真实 PostgreSQL | 151/151 PASS；包含 quick edit/direct intent 最终发布和数据库 trigger。 |
| PostgreSQL constraint suite | 282/282 PASS；53 migrations 从空 schema 成功，migration checksum 与本地文件一致，Canvas 测试数据清理检查通过。 |
| Contracts / OpenAPI | Contracts 139/139；typecheck/build PASS；84 paths 的 OpenAPI 生成、Redocly 和自定义验证 PASS。 |
| Canvas capability package | 11/11；typecheck/build PASS。 |
| Web | 771 passed、1 skipped；typecheck、ESLint、Next production build PASS；dependency-cruiser 471 modules、1552 dependencies、0 violation。 |
| DeerFlow tools / architecture | 38/38 PASS；Canvas client 会持续轮询 pending，仍未终态时显式失败，不会把 waiting 结果当 DONE。 |
| DeerFlow deployment / bootstrap | 13/13 与 4/4 PASS；canonical 12-tool 清单、Skill `allowed-tools`、merge 幂等/冲突/缺项/多项均 fail closed。 |
| 全 workspace typecheck / production build | PASS；同时验证 OpenAPI、Runtime schema、重新生成后的 Runtime validator、Prisma、全部后端 workspace、Next production build 和 Figma importer 打包。 |
| PostgreSQL HTTP E2E | PASS、`ok:true`；真实 API + Worker + 53 migrations + fake DeerFlow 覆盖全部 8 工具，3 个 client command ACK，最终 Board revision 3。 |
| 静态健康检查 | `node --check scripts/workbench-postgres-http-e2e.mjs`、YAML 结构解析、冲突标记扫描、尾随空格扫描和 `git diff --check` PASS。 |

Web 全量第一次与 lint/architecture 并行施压时有一个 route preload 用例超过 5 秒；focused 2/2 和全量顺序复跑均通过，没有放宽 timeout 或修改生产加载逻辑。

### 跨层 E2E 证据

E2E 使用两个独立 edit Run 遵守生产互斥规则：

1. quick-edit Run 依次调用 `get_visible_screens`、`get_selected_screens`、`view_screen`、`select_screen`、`navigate_canvas`、`quick_edit`；client simulator 按 Web 的 sync -> poll -> UI -> sync -> ACK 顺序处理 3 条 command。
2. direct-intent Run 先读取当前 selection，再调用 `rename_screen` 与 `duplicate_screen`；Worker 在 Runtime revise 结果上按持久 sequence 应用两项 intent。
3. 数据库最终保留 9 条 succeeded invocation、3 条 acknowledged command、2 个 completed session 和 2 个 revoked grant；quick edit 关联中间 ready version，rename/duplicate 同时关联最终 ready version，两条 Board node 均 pin 到最终版本。

### 明确偏差与剩余风险

1. `view_screen` 当前只返回真实结构计数并为用户打开 isolated Preview，`visualCapabilityId` 固定为 `null`；没有截图、像素或渲染图进入模型上下文，因此不能让 Agent 判断颜色、布局和真实视觉细节。这与 Evidence Bundle 的视觉观察语义不等价。
2. 固定 DeerFlow commit 仍静态注册 8 个 Canvas 工具，但候选派生镜像已用 commit/SHA-256 绑定的最小 source patch 安装 `WorkbenchToolScopeMiddleware`：模型绑定只看到本 Run `configurable.workbench_canvas_tools.declaredTools`，未声明调用在 ToolNode handler 前拒绝，缺失或畸形策略隐藏并拒绝全部 Canvas 工具，非 Canvas 工具不受影响。该实现已进入代码与构建/preflight 合同；升为生产通过仍需固定 digest 镜像和真实 Run E2 证据。
3. `npm run openapi:breaking` 本轮未得到差异结论：固定 `oasdiff` 下载访问 `proxy.golang.org` 超时。OpenAPI 生成一致、Redocly 和自定义 validator 已通过，但 breaking-diff 仍需在依赖可用的 CI/发布环境执行。
4. 阶段 3 当时本机没有 Docker CLI，无法执行 `docker compose config --quiet`；已用严格 YAML parser 验证 `deploy/workbench-compose.yml` 包含 14 个合法 service，并通过仓库 deployment network/upload/auth/DeerFlow 静态门禁。服务器 candidate Compose preflight 后续已通过，见阶段 11。
5. 当前交付仍依赖既有 dirty worktree；提交前必须按阶段审查文件所有权，不能混入不相关改动。

### 阶段 3 结束时边界（历史记录）

- 阶段 3 结束时阶段 4 尚未开始；当时 staged intent 只在 Run 最终发布时一次性生成完整下一版本，不是 Prototype 增量 Patch 协议。
- 阶段 4 随后新增独立 patch 合同、sequence/idempotency、Worker apply queue、recovery 和客户端增量投影，没有把 Canvas invocation 或旧 DOM mutation 当成兼容层复用。

## 阶段 4：Prototype 增量 Patch 与断点恢复（已完成）

### 执行边界

- 本阶段只实现实施规格中的阶段 4，没有提前进入阶段 5 的 Generate Prototype、Preview 设备模式或 QR capability。
- `/Users/liyannong/stitch-evidence-bundle` 始终只读，没有复制到仓库、`knowledge-vault`、项目数据库知识库或任何外部知识库。
- 产品可见名称继续使用“产品工作台”；没有新增旧参考品牌的运行时文案。
- 本阶段直接建立新的 Prototype Patch 合同、持久模型和投影链路，没有增加旧接口、旧事件或 DOM mutation 兼容层。
- 没有提交、推送、部署、发布、删除线上旧项目或操作任何外部服务；全部实现和验证都留在当前 dirty worktree 与本机隔离测试环境。

### 合同与增量语义

| 能力 | 阶段 4 最终行为 |
|---|---|
| Patch 协议 | 使用 `workbench.runtime.prototype-patch.v1`；每批绑定 `artifactIndex`、`screenId`、`baseRevision`、`nextRevision` 和 `resultingChecksum`，且只允许 `nextRevision = baseRevision + 1`。 |
| 操作集合 | 支持 `insert_node`、`replace_node`、`remove_node`、`update_screen`，以及 state/action/binding/motion 的 put/remove，共 12 类 operation；每批最多 128 项、canonical JSON 最多 256 KiB。 |
| 投影校验 | Patch 在完整 `PrototypeDocument` 上应用，并重新计算 `workbench.prototype-screen-projection.v1` 的 SHA-256；revision、screen identity、跨 screen 引用、节点/实体存在性和最终文档 schema 任一不满足即拒绝。 |
| Run 事件 | 新增 `artifact.prototype.patch.created` 与 `artifact.prototype.patch.degraded`；事件保留 Attempt、Runtime Attempt、Artifact/Version、source event、request SHA、revision、operations 和结果 checksum 的完整因果链。 |
| Draft checkpoint | 每个 Prototype `artifact.draft` 都携带 Adapter 从当时完整文档计算的 `checkpointScreens`；最终发布前再执行 trusted final checkpoint，禁止以局部或过期 screen set 完成发布。 |
| 恢复 API | 新增 `GET /runs/{runId}/artifact-drafts/{artifactVersionId}/checkpoint`，返回权威 staging 文档、document checksum、逐 screen revision/checksum 和完整 screen set；冲突使用 typed `409 ProblemDetails`。 |

### Worker、Attempt 与恢复

- `PrototypePatchService` 按 staging ArtifactVersion/screen 保存当前 revision、checksum 和状态；Patch application 与 staging 文档更新、Run Event、application 审计在同一数据库事务内提交。
- `(runtimeAttemptId, sourceEventId)` 是持久化幂等边界；相同请求可精确重放，不同 payload 指纹、旧 Attempt、Artifact scope 漂移或 source 因果不一致均 fail closed。
- 首个完整 Draft 建立 revision 0 checkpoint；连续 Patch 已覆盖 `0 -> 1 -> 2`，每一步都验证输入 revision、数据库 projection、Adapter 内存文档和 resulting checksum 一致。
- DeerFlow Patch tool 只接收模型可写的 Patch 内容，Project、Run、ArtifactVersion、Attempt 和 source event 等可信身份由 Runtime/Worker 注入；返回 artifact 经过严格 schema 和因果验证后才会变成进度事件。
- DeerFlow `values` 是累计全状态时，Adapter 会从完整状态中识别本轮新增提交，避免旧 checkpoint 或旧 Patch 被再次应用；重放历史 checkpoint 不会改变 document 或 revision。
- 新 Runtime Attempt 会从持久化的 active baseline 继续，而不是从 revision 0 重启；baseline 同时写入模型上下文和 `runtime.context.workbench`，且文档 checksum、screen set、scope、revision/checksum 任一损坏都会在执行前失败。
- degraded projection 会携带持久化 application ledger 的 recovery revision。下一 Attempt 必须先发完整 checkpoint，恢复 revision 取 projection 与 rejected ledger 的最高进度，再从该 revision 继续；不会用旧文档静默覆盖已知 Patch 历史。
- 阶段 3 的 Canvas direct intent 会在 Runtime 完整 revise 文档上继续应用 rename/duplicate，可能改变 screen set。该内部合成路径现会先把 effective Prototype 写回 staging version，再执行 `trusted_final` 完整 checkpoint，并追加带完整 `screens` revision/checksum 集合的内部 `artifact.draft.created`；因此 direct intent 也满足阶段 4 的 projection 完整性，不能绕过 finalization 门禁。
- waiting input 会暂停 active projection，恢复执行时重新激活；Run 失败/取消会 discard，最终 ArtifactVersion 发布只允许所有 screen projection 都为 active、完整且 checksum 与最终文档一致，随后原子 finalized。

### PostgreSQL 与 API 边界

- 新增 `PrototypePatchProjection` 和 `PrototypePatchApplication`：前者保存每个 staging version/screen 的权威 revision、checksum 与 active/paused/degraded/finalized/discarded 生命周期，后者保存 applied/degraded 的不可丢失审计记录。
- migration `20260718010000_prototype_patch_projections` 增加复合外键、唯一约束、索引和 trigger，约束 Run/Project/Artifact/Version/RuntimeAttempt/RunEvent scope、终态时间、application outcome 与 degraded reason 的一致性。
- Worker 在固定锁序下加载和更新 Run、staging version 与 projection；重复 source event、revision gap、checksum mismatch、Patch rejection、checkpoint unavailable 和 buffer overflow 都有确定性结果，不依赖进程内锁保证正确性。
- checkpoint API 重新验证 principal、Project membership、Run/ArtifactVersion scope、staging/Prototype 状态和 projection 完整性；document checksum、每个 screen projection checksum 或 screen set 不一致时返回 typed 409，不把损坏状态作为成功 checkpoint 暴露给 Web。
- ready ArtifactVersion 发布前继续执行既有完整文档 checksum 门禁；Patch 投影不能绕过 Artifact/Board 的权限、revision、Run 状态和最终发布事务。

### Web 投影与无闪烁交接

- Web 新增独立 Prototype Patch projector store，以 Project/request/Run/Attempt 为 scope，并按 ArtifactVersion/screen 维护 revision、checksum、phase、issue 和文档投影；旧 Attempt、旧 scope 和已覆盖 sequence 不会污染当前 Run。
- Draft 到达时先读取权威 checkpoint；checkpoint 前到达的 Patch 有界缓冲，随后按 screen revision 顺序排空。gap、checksum mismatch、degraded event、队列超过 64 events/2 MiB 或本地 apply 失败都会进入 recovery。
- recovery 使用同一 ArtifactVersion 的请求合并、有限次数指数退避、AbortSignal 和 scope generation fencing；Project/Run/Attempt 切换会取消旧请求，迟到响应不会覆盖新 scope。
- 多 screen 使用独立 revision map 和投影订阅；稳定 store identity 配合 screen-key subscription，只重渲染实际变化的 screen，不会为每个 Patch 重建 React Flow 根树。
- Board 节点直接消费投影中的增量 `PrototypeDocument`，因此 Runtime Patch 可以逐步呈现真实 screen 变化；loading/recovering/degraded/finalizing 状态保持稳定尺寸，不改变节点布局。
- ready Artifact/Board 数据接管前继续保留已完成的 staging 投影；只有 finalized screen 已被 ready 内容覆盖后才释放临时投影，避免最后一个 Patch 与最终 ready 版本之间出现空白、回退或闪烁。

### 错误与安全门禁

1. Patch payload 对未知字段、非法 operation、超过大小/数量、revision 非单步递增、screen 不存在、跨 screen 节点、根节点删除、节点 identity 改写和最终 projection/schema 损坏均 fail closed。
2. Worker 同时校验 RuntimeAttempt、artifact index、staging ArtifactVersion、source event、request SHA 和持久 projection；模型不能指定或覆盖可信 scope，也不能用同一 source event 提交不同 Patch。
3. degraded 不是“跳过错误继续”：它持久化 rejected application 和 Run Event，冻结该 screen 的增量应用，必须由完整 checkpoint 显式恢复。
4. API checkpoint 不信任 projection 表中的 checksum 字段本身，会从权威 Prototype 文档重新计算 document 与逐 screen checksum，并要求数据库与文档的 screen set 精确相等。
5. Web 不把客户端 projection 写回数据库；恢复只通过受鉴权 checkpoint API 获取权威状态，所有最终持久化仍由 Worker 的事务与发布门禁负责。

### 修改范围

| 路径 | 职责 |
|---|---|
| `packages/workbench-contracts/src/prototype-patches.ts`、`runtime.ts`、`runs.ts`、HTTP/OpenAPI 注册与测试 | 12 类 Patch、revision/checksum、Runtime progress、Run events、checkpoint 和 typed error 合同。 |
| `packages/workbench-db/prisma/schema.prisma`、`20260718010000_prototype_patch_projections/migration.sql` | projection/application 持久模型、生命周期、复合 scope 约束、索引和 trigger。 |
| `apps/workbench-worker/src/runs/prototype-patch-{applier,service}.ts`、`run-processor.ts` | Patch apply/verify、事务持久化、幂等/降级、checkpoint、Attempt baseline、终态收敛和最终发布。 |
| `apps/workbench-worker/src/runtime/deerflow-runtime.adapter.ts`、`runtime.port.ts` | DeerFlow Patch artifact 验证、累计状态去重、active/degraded baseline、完整 checkpoint 和 Runtime context。 |
| `apps/workbench-api/src/modules/prototype-patches/` | Run-scoped checkpoint 查询、权限/scope/checksum/screen-set 校验和 typed 409。 |
| `apps/web/lib/workbench/features/prototype-patches/` | API adapter、纯 reducer/queue、稳定 projector store、recovery coordinator、Provider 和 screen-key 订阅。 |
| `apps/web/components/workbench/workbench-prototype-patch-board*` 及 Project/Board 接线 | 增量 screen 渲染、状态 surface、最终 ready 无闪烁交接。 |
| `integrations/deerflow/runtime-tools/deerflow_workbench_tools/`、DeerFlow `SKILL.md`/`SOUL.md` | Prototype Patch 工具、严格响应 artifact 与“恢复不能从 revision 0 重启”的模型约束。 |
| `scripts/workbench-postgres-http-e2e.mjs` | 真实 API + Worker + PostgreSQL + fake DeerFlow 的 Prototype Patch 跨层场景。 |

### 验证结果

| 检查 | 结果 |
|---|---|
| Contracts 全量 | 157/157 PASS；Patch apply/checksum、12 类 operation、revision、payload 上限、Run event 和 checkpoint schema 均覆盖。 |
| Worker 全量 | 145 个非 skip 用例 PASS；prepare、typecheck 和 build PASS。 |
| Worker Prototype Patch PostgreSQL | 8/8 PASS；覆盖应用、重放、revision/checksum 降级、active/degraded baseline、新 Attempt 和最终状态。 |
| API 全量 | 385 个非 skip 用例 PASS；typecheck 和 build PASS。 |
| API checkpoint 聚焦 | 6/6 PASS；另有 PostgreSQL checkpoint 1/1 PASS。 |
| Web 全量 | 812 passed、1 skipped；Prototype Patch/Board 定向 74/74 PASS，typecheck 和 Next production build PASS。 |
| OpenAPI | 85 paths；生成一致、自定义 validator 和 Redocly 检查 PASS。 |
| PostgreSQL migration / constraints | 空 schema 顺序执行 54 个 migration PASS；Prototype Patch projection/application 的 constraint 与 trigger 检查 PASS。 |
| Runtime / DeerFlow | Runtime schema、runtime validator、DeerFlow tools 和 deployment/bootstrap 相关检查 PASS。 |
| 根级工程门禁 | `npm run workbench:prepare`、`npm run typecheck`、配置生产上传 Origin 后的 `npm run build`、`npm run lint:workbench`、`npm run architecture:workbench` PASS。 |
| 静态健康检查 | `node --check scripts/workbench-postgres-http-e2e.mjs`、冲突标记扫描、尾随空格扫描和 `git diff --check` PASS。 |
| 真实 PostgreSQL HTTP E2E | PASS、`ok:true`；真实 API + Worker + 隔离 PostgreSQL + fake DeerFlow 的 Prototype Patch Run 共 28 个事件，连续 Patch sequence 为 `[18, 19]`，两条 application 后 screen revision 为 2；显式 final checkpoint、ready Artifact/Board 与 revision 2 checkpoint 全部通过。同轮 Canvas Gateway direct-intent 完整 checkpoint 修复后也通过，覆盖全部 8 个 Canvas 工具，`finalBoardRevision=3`。 |

### 偏差与剩余风险

1. 阶段 4 结束时的 Web 聚焦测试覆盖投影、恢复、Board 接线和 ready 交接；固定三视口和完整动效状态机属于当时尚未开始的阶段 11，现已在顶部章节完成。
2. 阶段 3 记录的两个上游能力偏差已进入候选实现：`view_screen` 通过独立 visual capability 传入图像，固定 DeerFlow commit 的派生镜像通过审计 source patch 按 Run 动态裁剪模型可见 Canvas 工具并在执行前二次拒绝；两项仍需真实候选镜像、浏览器和模型消费 E2 才能记为生产通过。
3. 当前交付仍依赖既有 dirty worktree；提交前必须按阶段审查文件所有权，不能混入不相关改动。

### 阶段 4 结束时边界

- 阶段 5 尚未开始；阶段 4 只负责已有 staging Prototype 的增量生产、持久化、恢复与渲染，没有把选择上下文的普通 `generate` 隐式改成 Generate Prototype。
- 阶段 5 应继续使用 `workflow: "generate"`，仅在显式请求 Prototype 且捕获明确单屏/多屏 target 时携带 `artifactTargets`；Worker 必须创建新的 Prototype ArtifactVersion，不能覆盖源版本。
- Preview 设备模式与 QR capability 属于阶段 5；QR 只能编码短期 Preview capability URL，不能复用 share URL、JWT 或持久 token。

## 阶段 5：Generate Prototype 与设备化 Preview（已完成）

### 执行边界

- 本阶段实现显式 Generate Prototype 产品流程、设备化 Preview 和 QR capability，没有提前实现阶段 6 的导出交付矩阵。
- `/Users/liyannong/stitch-evidence-bundle` 始终只读；没有复制证据、源资产或对话内容到仓库、`knowledge-vault`、项目数据库知识库或任何外部知识库。
- 产品可见名称继续使用“产品工作台”；没有引入旧参考品牌运行时文案。
- Run 合同直接演进为新项目所需语义，没有新增旧字段、旧接口、双写或兼容层；旧对话数据不在本阶段迁移范围内。
- 没有提交、推送、部署、发布、删除线上旧项目或操作外部服务；实现与验证仍位于当前 dirty worktree 和本机隔离环境。

### Generate Prototype 语义

| 能力 | 阶段 5 最终行为 |
|---|---|
| 明确意图 | 继续使用 `workflow: "generate"`，新增 `generationIntent: "interactive-prototype"`；只有显式选择源 screen 且 `requestedArtifactKinds` 包含 `prototype` 时才能发起 targeted Generate。 |
| 单屏/多屏 target | `artifactTargets` 保留用户选择顺序，最多选择 12 个 ArtifactVersion 或 screen；target 必须属于当前 Project、指向 ready ArtifactVersion，并在 API 与 Worker 两层重新校验。 |
| 源内容最小投影 | `workbench.prototype-source-projection.v1` 只向 Runtime 暴露所选 screens、对应 nodes/state/action/binding/motion、实际引用的 token/variable/asset，以及跨出选择范围的 navigation target stub。 |
| 新版本边界 | Generate Prototype 创建新的 Prototype Artifact 和 ArtifactVersion；不会把生成结果作为源 ArtifactVersion 的 revision，也不会修改源 checksum、内容或 Board pin。 |
| 已有 Prototype | 所选 screen 已具备可运行 action 时，`Preview` 直接打开隔离预览；没有可运行 action 时才进入 `Generate prototype` 确认和 Composer intent。 |
| 生命周期 | Run 继续复用已有 queued/running/waiting/completed/cancelled/retry、Artifact draft、Prototype Patch、final checkpoint 与 ready 发布链路；没有建立第二套生成状态机。 |
| 运行时上下文 | `generationIntent`、有序 source projection、目标类型和 target identity 随 Run request 进入 Worker 与 DeerFlow context；模型不能覆盖可信 Project、ArtifactVersion 或 screen scope。 |

### Preview、设备与 QR

- Preview 使用独立 `ProjectPreview` 命令，不把预览等同于可下载 ExportJob。请求冻结 `boardId`、`boardRevision` 和 selection，异步完成后再签发短期 capability。
- 设备模式包含 `mobile` 390x844、`phone-landscape` 844x390、`tablet` 768x1024、`desktop` 1440x900、`responsive` 和 `custom`；自定义 viewport 限制在 240x240 至 2560x1600，固定设备按可用区域等比缩小但不放大。
- Preview iframe 必须使用与产品工作台不同的隔离 origin，并以 capability 绑定的 RPC channel 通信；过期、origin 不匹配或无效 capability 均 fail closed。
- QR 仅在 capability 尚未过期时显示，二维码内容就是短期 Preview capability URL；不编码 Better Auth JWT、share token、Blob locator、长期 token 或内部存储凭证。
- Project/selection 切换会废弃旧预览请求和 capability；Web 对异步结果使用 generation fencing，迟到响应不能覆盖当前 Project 的 Preview。

### 合同、API 与 Worker

- `generationIntent` 只允许 `followup-design` 或 `interactive-prototype`，且只在 `generate` workflow 中有效；无 target 的普通 Generate 必须使用 `generationIntent: null`。
- `edit` 仍要求 target 且禁止 `generationIntent`；`redesign`/`ideate` 继续禁止 `artifactTargets`，没有为了前端流程放宽原有 schema 门禁。
- API 在持久化前重新执行 workflow/intent/target 组合验证；Run mapper、SubmissionIntent、Web 生成类型和 OpenAPI 使用同一 canonical contract。
- Worker 从权威 ready ArtifactVersion 构造 source projection，重新校验源 checksum、screen identity、资产 pin 和 projection checksum；选区外完整 screen 内容不会进入模型上下文。
- Runtime 产物沿阶段 4 的 staging、Patch、checkpoint 和最终发布事务生成新 ArtifactVersion；取消、重试或失败不会污染源版本。
- Project Preview API 提供创建、查询和短期 token 签发；权限、Project/Board revision、selection 与过期时间均由服务端确定。

### 修改范围

| 路径 | 职责 |
|---|---|
| `packages/workbench-contracts/src/{runs,prototype-sources,previews,http-routes,openapi-document}.ts` | Generate intent、source projection、Project Preview、短期 capability 与 HTTP/OpenAPI 合同。 |
| `apps/workbench-api/src/modules/runs/`、`submission-intents/`、`exports/` | workflow/intent/target 复验、Run 映射、预览创建/查询和 capability 签发。 |
| `apps/workbench-worker/src/runs/run-processor.ts`、`runtime/deerflow-runtime.adapter.ts` | 最小源投影、checksum/asset pin 校验、Runtime context 和新 Prototype 发布。 |
| `apps/web/components/workbench/workbench-{screen-context-toolbar,project-composer,run-preview,project-preview-overlay,isolated-preview}*` | Preview/Generate Prototype 分支、确认流程、Run 状态、设备选择、QR 与隔离 iframe。 |
| `apps/web/lib/workbench/features/{preview-device,workbench-publication-controller,exports}/` | viewport 解析、Project Preview 协调、capability 校验、请求恢复和 scope fencing。 |
| `scripts/e2e/workbench-{run-preview,isolated-preview}-smoke.mjs`、`scripts/workbench-postgres-http-e2e.mjs` | Run/Preview 浏览器场景和真实 PostgreSQL 跨层 Generate 场景。 |

### 验证结果

| 检查 | 结果 |
|---|---|
| Generate Prototype 合同与服务测试 | targeted Generate、普通 Generate、Edit/Redesign/Ideate 非法组合、单屏/多屏、越权与 source projection 均已进入 Contracts、API、Worker 和 Web 全量套件；阶段 6 收口时的最终总数见下一章。 |
| 真实 PostgreSQL targeted Generate | PASS；`generationIntent=interactive-prototype`，选择顺序 `[screen-admin, screen-home]` 保留；Runtime projection 仅含 2 screens、4 nodes、2 assets，并只保留 `screen-settings` navigation stub。 |
| 不可变源与新产物 | PASS；生成新的 Artifact/ArtifactVersion，源 ArtifactVersion checksum 和 content 在执行前后保持不变。 |
| 真实 PostgreSQL HTTP E2E | PASS；真实 API、Runtime Worker、隔离 PostgreSQL 与 fake DeerFlow 覆盖 targeted Generate、Prototype staging/patch/final checkpoint 和 ready 发布。 |
| 根 `npm run typecheck` | PASS；包含 Contracts、API、Runtime Worker、Export Worker、Web、Preview、Prisma、OpenAPI 和 runtime 生成物。 |
| Board / Preview 浏览器回归 | PASS；Board `saveCount=6`、`finalRevision=18`，桌面/390x844 工具、上下文菜单、收藏、Design system 与 Prototype Preview 选择均通过；Preview viewer 通过 2 次 Project Preview、3 个短期 capability、iframe handshake/交互、QR 和 mobile/landscape/tablet/desktop/responsive/custom 设备矩阵。 |

### 安全边界、偏差与剩余风险

1. Source projection 是 Runtime 可见的唯一 Generate 输入；未选择 screen 的完整 nodes/state/action/binding/motion 不会因同属一个 Prototype 文档而被一并泄露。
2. QR capability 是短期、只读、独立 preview origin 的访问能力，不替代项目权限、分享发布或下载授权；过期后必须重新签发。
3. 本阶段没有新增数据库 migration；Generate 语义保存在现有 Run request/SubmissionIntent 合同中，Project Preview 继续使用已有持久模型。
4. Preview 浏览器 smoke 要求 Web 进程在启动时显式设置 `WORKBENCH_PREVIEW_ORIGIN`；缺少该变量时 Next 会把 public origin 编译为空并按设计 fail closed。本轮已用 `http://127.0.0.1:4300` 重启验证。

### 阶段 5 结束时边界

- 阶段 5 已把“预览已有交互原型”和“从选中设计屏生成交互原型”拆成两个显式流程，没有用前端 prompt 拼接或兼容字段模拟意图。
- 阶段 6 在此基础上独立扩展 Export 的 format、packaging 和 delivery，不复用 Preview capability、share token 或内部 Blob URL 作为第三方发布凭证。

## 阶段 6：导出矩阵扩展（已完成）

### 执行边界

- 本阶段完成导出 format/packaging/delivery 三维模型、本地下载与剪贴板、外部交付生命周期、Worker 恢复审计和 Web 刷新恢复；阶段 6 结束当时阶段 7 尚未开始，阶段 7 后续已独立完成，见文档顶部当前状态。
- `/Users/liyannong/stitch-evidence-bundle` 始终只读，没有复制到仓库或任何内部/外部知识库。
- 产品可见名称继续使用“产品工作台”；运行时表面没有新增旧参考品牌名称。
- 这是新项目合同的直接演进：`packaging` 变为必填，capability 改为 `formats/packaging/external`，没有保留旧响应、可选旧字段、双路由或其他兼容层；OpenAPI baseline 已经显式接受为新的 canonical contract。
- 没有部署、发布、推送、删除服务器旧项目或向真实第三方传输数据；外部 adapter 的生产默认行为仍是 capability unavailable/fail closed。

### 导出与交付矩阵

| 维度 | 阶段 6 最终模型 |
|---|---|
| format | `html`、`react`、`figma`、`mcp`；renderer 只负责构建内容形态。 |
| packaging | `single_file`、`zip`；HTML 支持两种 packaging，React/Figma/MCP 必须使用 ZIP，非法组合在合同、API 和数据库三层拒绝。 |
| delivery | `download`、`clipboard`、`external`；下载与剪贴板复用已完成的 ExportJob output，不为动作再复制一套 renderer。 |
| 外部目标 | `ai_studio`、`netlify`、`lovable`、`bolt`；能力目录分别报告 availability、authentication 与稳定 reason code。 |
| 产品入口 | 顺序为 AI Studio、Figma、MCP、Netlify、Lovable、Bolt、Download `.zip`、Copy code；React 作为开发者格式保留。 |
| 本地产物 | HTML ZIP 确定性归档；Copy code 只读取 succeeded single-file HTML；React、Figma、MCP 均下载 ZIP。 |

### 外部交付与二次确认

- 第一步只创建 `pending_confirmation` delivery：服务端冻结 `exportJobId`、release、format、packaging、selection，以及 output 的 media type、byte size、SHA-256 和 file name；此时不会授权传输。
- Web 确认区展示冻结 selection、文件名、大小和摘要。只有用户再次显式确认，API 才通过 `If-Match` CAS 把 delivery 置为 `queued`，Worker 才能进入传输链路。
- 状态机为 `pending_confirmation -> queued -> running -> succeeded/failed`，取消中的远端补偿使用独立 `cancelling`；retry/cancel/confirm 统一受 ETag revision 保护，cancel API 返回 `202`。
- `attempt` 记录真实执行次数，`transferAuthorizedAt` 是外发授权审计点；没有该证据不能持久化 remote receipt，成功必须同时具备授权、远端引用和完整时间戳。
- delivery 列表响应使用 `Cache-Control: private, no-store`；凭证、OAuth token、内部 Blob URL 和 share/preview token 不进入 payload snapshot、日志或远端引用。
- 当前 production capability 目录中 AI Studio 明确 unavailable，Netlify/Lovable/Bolt 要求外部认证；未配置真实 provider adapter 时 Worker 明确失败，不做 best-effort 上传。

### Worker 恢复、幂等与取消

- Worker 使用数据库 lease claim 和 fencing token；活跃 owner 存在时不重复执行，lease 过期后允许接管，旧 owner 失去 lease 后不能写入结果。
- 暂态失败在重试预算内释放或使 lease 立即可接管；`attempt` 单调递增，终态错误持久化稳定 code 和有界 detail。
- Blob quarantine 与 transfer authorization 使用固定数据库锁序；Worker 在授权前重新读取并校验 output bytes、size 和 SHA-256，quarantine 或 identity 漂移均 fail closed。
- Provider 调用使用 delivery ID 作为稳定幂等键；远端成功但 receipt 落库失败时可用同一键重放并恢复相同 remote reference，不创建第二份远端产物。
- 授权后收到取消时进入 `cancelling`：若尚未传输则直接终态化；若已有 receipt，则恢复 revoke，只有补偿完成才清除远端引用并进入 `cancelled`。
- 数据库 constraint 同时保护 request hash、format/packaging、状态/lease/时间戳、transfer evidence、remote reference 和 failure 字段组合，不能只靠进程内状态机维持一致性。

### Web 恢复与并发边界

- 刷新后从当前 ExportJob 的 delivery 列表恢复最新 external delivery，并继续轮询 queued/running/cancelling；终态恢复后用户仍可主动切换其他目标。
- 恢复时依据 delivery 自身的 target 还原 AI Studio/Netlify/Lovable/Bolt，不会被底层 React/HTML format 错误覆盖成另一个产品入口。
- 外部操作按 Project 单飞，双击或重复触发不能创建两条 `pending_confirmation` delivery；下载、Copy code 和外部交付各自保持独立 operation fencing。
- `cancelling` 会禁用 confirm/retry/cancel 等重复动作并持续轮询；Project 切换会隔离旧异步结果，迟到响应不能覆盖当前项目。
- Download 使用响应 `Content-Disposition` 和 digest，Copy code 只在完整 bytes 验证成功后写入 clipboard；权限拒绝或写入失败保持显式错误，不伪造成功。

### 修改范围

| 路径 | 职责 |
|---|---|
| `packages/workbench-contracts/src/exports.ts`、HTTP/OpenAPI 注册与测试 | format/packaging/delivery、capability、immutable payload、external lifecycle 与 API 合同。 |
| `packages/workbench-db/prisma/schema.prisma`、`20260718020000_export_delivery_matrix/migration.sql` | `ExportPackaging`、external delivery、状态/lease/transfer evidence 约束、索引与外键。 |
| `packages/workbench-export-core/` | standalone HTML、React、Figma、MCP、确定性 ZIP、离线 runtime 与文件名/摘要。 |
| `apps/workbench-api/src/modules/exports/` | capability 目录、ExportJob packaging、外部 delivery 创建/列表/确认/重试/取消、ETag/CAS 与授权。 |
| `apps/workbench-export-worker/src/{export,delivery}/` | output 读取校验、lease claim/fencing、provider adapter、receipt、重试、取消和 revoke 恢复。 |
| `apps/web/components/workbench/workbench-export-dialog.tsx` | 导出目标矩阵、二次确认、冻结 payload 摘要、`cancelling` 与可访问状态 UI。 |
| `apps/web/lib/workbench/features/workbench-publication-controller.ts`、`exports/` | job/delivery 恢复、Project 单飞、目标还原、下载、clipboard 和 external CAS 操作。 |
| `scripts/e2e/workbench-export-recovery-smoke.mjs`、PostgreSQL constraint/HTTP E2E 脚本 | ZIP 下载、Netlify 二次确认、刷新恢复、数据库约束与跨层交付验证。 |

### 验证结果

| 检查 | 结果 |
|---|---|
| Contracts 全量 | 168/168 PASS。 |
| Workbench API 全量 | 397 passed、29 skipped。 |
| Export Core 全量 | 34/34 PASS。 |
| Export Worker 全量 | 40 passed、1 skipped。 |
| Runtime Worker 全量 | 167 passed、21 skipped。 |
| Web 全量 | 836 passed、1 skipped。 |
| Preview 全量 | 12 passed、1 skipped。 |
| TypeScript | Contracts、Workbench API、Export Core、Export Worker、Web 定向 typecheck PASS；根 `npm run typecheck` PASS。 |
| OpenAPI 生成与校验 | 90 paths / 109 operations；生成一致、自定义 validator 与 Redocly 检查 PASS；新项目 baseline 已显式接受并更新。 |
| `npm run openapi:breaking` | **未得到 breaking-diff 结论**；固定 `oasdiff` 外部工具访问 `proxy.golang.org` 时网络不可用，本轮进程随后中止。该项不是代码失败，但绝不能记为 breaking PASS；baseline 接受也不等同于差异工具通过。 |
| PostgreSQL migrations / constraints | 315/315 PASS；阶段 6 export delivery matrix 定向约束 33/33 PASS。 |
| 真实 PostgreSQL HTTP E2E | PASS；真实 API、Worker、隔离 PostgreSQL 与 fake provider 覆盖 Generate Prototype、ExportJob、不可变 delivery、确认、执行和审计链。 |
| Runtime/OpenAPI 生成物 | Runtime schema、runtime validator 与 Web OpenAPI schema 校验 PASS。 |
| 静态工程门禁 | `npm run lint:workbench`、`npm run brand:check` PASS；architecture 为 491 modules、1613 dependencies、0 violation。 |
| Board / Preview / Exports 浏览器回归 | PASS；Board `saveCount=6`、`finalRevision=18` 且移动首个 action bounds/scroll 断言通过；Preview viewer 通过 `projectPreviewCount=2`、`previewTokenCount=3`、sandbox/origin/handshake/QR/设备矩阵；Exports `cancelCalls=1`、`detailPolls=2`、`contentDownloads=1`、`deliveryPrepares=1`、`deliveryConfirms=1`、`deliveryPolls=2`，ZIP 文件名为 `workbench-project-export-recovery-export-download.zip`，桌面与 390x844 面板边界通过，三条 smoke 均无 console error/unknown request。 |

### 浏览器截图证据

本轮截图位于 gitignored `output/playwright/`，只作为本机验收资产；字节级 hash 用于标识本轮运行，不承诺跨浏览器或跨运行稳定。

| 场景 | 尺寸 | SHA-256 | 本地文件 |
|---|---:|---|---|
| Export 外部交付完成态 | 1501x855 | `239ee3cf31d6350f6bbcf3b8ee4b427ec1e3437a71f43e91ed711491a0efcef2` | `output/playwright/workbench-export-recovery-1501x855.png` |
| Export 外部交付完成态 | 390x844 | `97762a5a6df98a9cb93961c445a02cbf50bb5df54fb602e8ed615bc6d9b48a89` | `output/playwright/workbench-export-recovery-390x844.png` |
| Isolated Preview 自定义完成态 | 1501x855 | `a17533e1deaf38a6cc0d80d6cef47ee3c7462f5d05160ea131bc2743b593a202` | `output/playwright/workbench-isolated-preview-desktop-1501x855.png` |
| Isolated Preview 自定义完成态 | 390x844 | `ffbfe232cc29d24af243517967681bf0ec7ec767b8df6178f7e0bd23d5b0d54f` | `output/playwright/workbench-isolated-preview-mobile-390x844.png` |
| Board 工具完成态 | 1501x855 | `b5cc82aa9ee854163c57443b0b779df72c5b46b7e3b084e03a79bc3349f3cae7` | `output/playwright/workbench-board-tools-desktop-1501x855.png` |
| Board 工具完成态 | 390x844 | `99615830f06c8214943773f253e305ee5755af3ab9f51309a73522bfdc995ae0` | `output/playwright/workbench-board-tools-mobile-390x844.png` |
| Screen context toolbar | 390x844 | `ffba007ab367b57ee2c561ccfff73fcca6a2bc96a37d10faf54ae8fa8fdd345d` | `output/playwright/workbench-screen-context-toolbar-mobile-390x844.png` |

截图 hash 仅用于标识本轮本机验收资产，不承诺跨运行字节级稳定。

### OpenAPI 与无兼容层决策

- 当前合同相对阶段 4 及旧 baseline 存在有意 breaking change：`packaging` 变为必填，capability 从旧扁平结构改为 `formats/packaging/external`，并新增完整 external delivery 生命周期。
- 用户已明确这是新项目，旧版上线后删除，不需要兼容层；因此已审查并显式接受当前 90/109 合同为新 baseline，没有添加可选旧字段或旧 endpoint 来骗过 breaking diff。
- `oasdiff` 的网络中断仍作为独立发布门禁缺口保留。后续在依赖可用的 CI/发布环境运行时，结果应解释为“相对已接受新 baseline 的后续变化”，不能反推本轮 breaking change 从未发生。

### 偏差与剩余风险

1. Board 移动工具条曾因 flex 最小内容宽度和 resize 后 scrollLeft 保留出现首项裁切；现已通过 `min-w-0`、viewport/selection scroll reset 和首项 bounds 断言修复并复跑通过。
2. AI Studio、Netlify、Lovable、Bolt 已有 capability、UI、不可变 payload、审计状态机和 adapter port，但当前生产默认没有真实 provider 凭证/adapter；本轮 fake provider 只验证协议与恢复，不代表真实第三方发布已上线。
3. `openapi:breaking` 因 Go 依赖网络不可用且本轮中止，尚无工具差异报告；正式发布环境仍需补跑，不能用 baseline 更新替代该证据。
4. 当前交付仍依赖既有 dirty worktree；提交前必须按阶段审查文件所有权，不能混入不相关改动。
5. 本阶段没有部署、删除或改动服务器项目；本轮只重启本机 Web dev server 注入 Preview origin，真实服务器验证仍是独立发布动作。

### 阶段 6 结束条件（已满足）

- 主线程已回填 Board、Preview、Exports 三项浏览器结果；控制台/unknown request 为 0，下载文件名、ZIP 内容入口和外部二次确认均通过。
- 阶段 6 完全闭环后才开始阶段 7 Import Source 矩阵；该顺序已执行完成，Import Source 没有把导入解析、外部 OAuth 或 provider 细节塞进 Export Core。

## 阶段 0：基线与执行护栏（已完成）

### 执行边界

- 本阶段只建立基线和架构护栏，没有修改合同、API、数据库 schema、运行时行为或前端可见行为。
- `/Users/liyannong/stitch-evidence-bundle` 仅作为本地敏感证据源；本阶段没有复制其内容到仓库、`knowledge-vault` 或任何外部知识库。
- 没有提交、推送、部署或外部发布。
- 动画触发、阶段变化和画布动效仍以实施规格及 Evidence Bundle 为后续验收依据；阶段 0 未提前实现阶段 1-11 的功能。

### 基线锚点

| 项目 | 值 |
|---|---|
| 分支 | `codex/workbench-greenfield` |
| HEAD | `162c4f42003263814899f31dc5e3111d04e20aa8` |
| 工作区检查点 | 新增本状态文件前，`git status --short` 为 293 个目录折叠条目（132 tracked、161 untracked）；阶段结束为 294（132 tracked、162 untracked） |
| 展开口径 | 阶段结束时 `git status --short --untracked-files=all` 为 1782 项（132 tracked、1650 个 untracked 文件）；默认口径不是文件数 |
| 基线含义 | HEAD 加当时本地 dirty worktree，而不是可由 HEAD 单独复现的提交 |

本阶段开始前已记录的结果：

| 检查 | 修改前结果 |
|---|---|
| `npm run workbench:prepare` | PASS |
| `npm run typecheck` | PASS |
| Web tests | PASS：668 passed，1 skipped |
| Worker tests | 原始记录为 126 total；未持久保存 pass/skip 拆分，不能重写为精确的 126 passed；配置隔离测试数据库后的 PostgreSQL 定向检查曾为 6/6 |
| DeerFlow runtime tools | PASS：17/17 |
| DeerFlow deployment | PASS：10/10 |
| lint / architecture / brand | PASS |
| production build | PASS；使用本地非敏感上传 bucket URL 占位配置 |
| 首次根 `npm test` | FAIL：Export Core `prototype-runtime.chromium.spec.ts` 离线 React Prototype 场景 30 秒超时；该 workspace 32 passed、1 failed，根测试随后停止 |

修改前的 Export Core 失败没有归因于阶段 0。之后单独复跑 Export Core 为 33/33 通过，本阶段最终根 `npm test` 也通过，说明该次 30 秒超时未稳定复现。

### 六条执行护栏

| 边界 | 状态 | 可执行证据 |
|---|---|---|
| Workbench Web 不直接导入数据库层 | 新增并通过 | ESLint 同时拒绝静态 import 与字面量 `import()` 的 Workbench DB、旧 DB 包、Prisma、`pg`、`pg-boss` 和旧 `lib/db`；dependency-cruiser 保留 workspace package 依赖边但不递归解析，并用真实临时违规文件证明规则生效。 |
| Agent runtime tool 不直接访问数据库 repository | 新增并通过 | Python AST 扫描 `deerflow_workbench_tools/**/*.py`，拒绝数据库/ORM/repository import、常量动态 import、`importlib` 模块/函数别名和数据库句柄调用；HTTP client 合法样例用于防误报。 |
| Preview URL 必须跨 origin | 已确认 | Web 组件、API 配置、Export service、publication controller 和浏览器 smoke 均验证独立 Preview origin。 |
| Preview iframe 不含 `allow-same-origin` | 已确认 | 组件 sandbox、Preview CSP、Preview service 和浏览器 smoke 四层覆盖；iframe 同时保持 `credentialless` 和 `no-referrer`。 |
| Run sequence gap 必须失败 | 已确认 | `run/stream.spec.ts` 与 `run/reducer.spec.ts` 均为负向 gap 测试；HTTP E2E 的 `assertOrderedEvents` 验证真实 SSE 输出连续。 |
| Artifact ready 前校验 checksum | 加强并通过 | 保留 RunProcessor 发布门；新增“内容不变但持久化 checksum 漂移为另一合法 SHA-256”用例，确认在 ArtifactVersion、Artifact、Board Node 和 Run Event 写入前失败。 |

HTTP E2E 没有人工注入 gapped 服务端流；“收到 gap 必须失败”的直接负向证据由 Web stream 和 reducer 测试提供。

### 修改文件

| 文件 | 职责 |
|---|---|
| `.dependency-cruiser.cjs` | 增加数据库层禁令，并保留 workspace package 依赖边用于真实规则匹配。 |
| `apps/web/eslint.config.mjs` | 增加静态及动态数据库 import 限制，并保持 Better Auth 合法服务端边界。 |
| `apps/web/package.json` | 让 `lint:workbench` 覆盖 Workbench/Auth 页面与组件目录。 |
| `apps/web/lib/workbench/features/feature-boundaries.spec.ts` | 用违规 import 样例验证 ESLint，并验证 dependency-cruiser 规则已接线。 |
| `integrations/deerflow/runtime-tools/test_runtime_tool_architecture.py` | 新增 Agent tool 数据库/repository AST 架构测试。 |
| `apps/workbench-worker/test/run-processor.spec.ts` | 新增持久 checksum 漂移的 fail-closed 发布测试。 |
| `package.json` | 将 Agent 架构测试接入 `architecture:workbench` 和 `deerflow:tools:test`。 |
| `scripts/assert-workbench-brand.mjs` | 仅允许规格指定的内部实施状态文档提及 Stitch，运行时与其他产品表面仍禁止旧品牌。 |
| `scripts/e2e/workbench-run-preview-smoke.mjs` | 将过期合成节点 fixture 改为真实连续 Run stage、Artifact Draft 与 staging PrototypeVersion。 |
| `scripts/e2e/workbench-approval-preferences-smoke.mjs` | 在交互前生成当前产品工作台 Home 静态基线。 |
| `scripts/e2e/workbench-board-tools-smoke.mjs` | 生成 succeeded Run + ready Artifact 的当前 Project 完成态静态基线，再恢复原画布工具场景。 |
| `docs/stitch-parity/IMPLEMENTATION-STATUS.md` | 记录阶段状态、基线、验证、偏差和 UNKNOWN。 |

### 验证结果

#### PASS

| 命令 | 结果 |
|---|---|
| `npm --workspace @workbench/web run test -- lib/workbench/features/feature-boundaries.spec.ts components/auth/auth-ownership.spec.ts` | 9/9；先验证缺规则、动态 import 与真实 depcruise fixture 的红灯，再实现绿灯 |
| `npm --workspace @workbench/web run test -- lib/workbench/features/feature-boundaries.spec.ts components/auth/auth-ownership.spec.ts components/workbench/workbench-isolated-preview.spec.tsx lib/workbench/run/stream.spec.ts lib/workbench/run/reducer.spec.ts` | 5 files、34/34 |
| `npm run architecture:workbench` | dependency-cruiser：439 modules、1472 dependencies、0 violation；Agent AST：3/3 |
| `npm run lint:workbench` | PASS |
| `npm run deerflow:tools:test` | 20/20 |
| `npm --workspace @workbench/workbench-worker exec -- vitest run test/run-processor.spec.ts` | 50/50 |
| `npm --workspace @workbench/workbench-worker run test` | 117 passed、10 skipped、127 total |
| `npm --workspace @workbench/web run test` | 串行最终结果：669 passed、1 skipped、670 total |
| `npm --workspace @workbench/workbench-preview run test` | 12 passed、1 skipped |
| `npm --workspace @workbench/workbench-contracts run test` | 129/129 |
| `npm run openapi:check` | 79 paths，schema/registry 产物一致 |
| `npm run runtime:schema:check` | PASS |
| `npm run runtime:validator:check` | PASS |
| `npm run typecheck` | 全 workspace PASS |
| `WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL=https://uploads.workbench.example.com/workbench npm run build` | PASS；使用仓库示例中的非敏感 HTTPS Origin，Next 生产构建与 Figma importer 打包成功 |
| `npm test` | 最终 PASS；Export Core 33/33 |
| `npm run deerflow:deployment:test` | 10/10 |
| `npm run runtime:deerflow:knowledge:smoke:test` | 7/7 |
| `npm run brand:check` | PASS：运行时使用“产品工作台”/`workbench` 命名 |
| `npm run bundle:workbench:check` | PASS |
| `npm run e2e:web:preview` | PASS：viewer、2 次 project preview、3 个 token；sandbox 无 `allow-same-origin` |
| `npm run e2e:web` | PASS：Run Draft、审批、画布、Chromium/Firefox/WebKit 路由动效、设计系统、导出和 isolated Preview 全链路 |
| `git diff --check` | PASS |
| `rg -n '[[:blank:]]+$' <阶段 0 untracked 交付文件>` | PASS：无匹配；补足普通 `git diff --check` 不覆盖 untracked 文件的口径 |
| `rg -n -e '^<<<<<<<' -e '^=======' -e '^>>>>>>>' <阶段 0 untracked 交付文件>` | PASS：无冲突标记 |

Web 全量测试在与多个 workspace suites 并行施压时，route-module preload 用例发生过 5 秒超时（668 passed、1 failed、1 skipped）；该文件定向复跑 2/2 通过，按仓库正常单命令串行全量复跑为 669 passed、1 skipped。两种结果均保留，不将压力失败隐藏为通过，也没有放宽超时。

统一 E2E 最初两次等待已删除的 `generated-interface-2` 合成节点而失败。审计确认生产逻辑要求真实 Artifact Draft 才投影画布；fixture 已改为连续 sequence 8/9 的 `screen-streaming` + `artifact.draft.created`、合法 staging PrototypeVersion 和语义节点选择器。生产投影未改，修正后统一 E2E 完整通过。

#### FAIL / SKIP

| 命令 | 结果与处理 |
|---|---|
| `npm run build`（当前未配置上传 Origin 的 shell） | EXPECTED CONFIG FAILURE：加载 `next.config.ts` 时因缺少 `WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL` fail-closed；没有放宽生产配置门禁，使用上表显式非敏感 Origin 后完整构建通过。 |
| `npm run test:workbench:postgres-constraints` | SKIP（执行时以前置条件失败退出）：当前未提供 `WORKBENCH_TEST_DATABASE_URL`。不擅自复用先前 QA 数据库；修改前已记录配置环境下 6/6 通过。 |

### 浏览器与截图基线

阶段 0 当前截图由统一 E2E 在 2026-07-17 生成；截图瞬间禁用 animation 并隐藏 caret，动效时序由三浏览器 navigation smoke 独立验证：

| 场景 | 尺寸 | 字节 | SHA-256 | 本地文件 |
|---|---:|---:|---|---|
| 当前产品工作台 Home | 1501x855 | 120646 | `5b889a758e711f8f29b646da43fda151768c6e4fc0232f06d968c92ef99b0235` | `output/playwright/workbench-phase0-baseline-home-1501x855.png` |
| 当前 Project 完成态 | 1501x855 | 469693 | `ee9e5537da725b25fe9be9658ab2547910199b46c2ac74411c8b3c4c7711386c` | `output/playwright/workbench-phase0-baseline-project-complete-1501x855.png` |

上述 SHA 用于标识本次冻结的本地资产，不承诺 E2E 每次生成字节级相同的 PNG；视觉回归以页面断言、画布像素检查和冻结资产人工对照共同判定。

两张 2026-07-12 历史截图仍保留为接入起点证据，SHA-256 与 `docs/workbench-visual-baseline.md` 一致：

| 场景 | 尺寸 | 字节 | SHA-256 | 本地文件 |
|---|---:|---:|---|---|
| 首页默认态 | 1501x855 | 116365 | `03f50dfa3a4f918a20e3243f08b0f0514d6c3a5d8d5c2afce734a52d9420cf5c` | `output/playwright/workbench-greenfield-baseline-home-1501x855.png` |
| 项目生成完成态 | 1501x855 | 594218 | `03c57f356277d787aee66fa0d01910225344418f9e4d58c0e78aec54f0123e98` | `output/playwright/workbench-greenfield-baseline-project-complete-1501x855.png` |

这些文件位于 gitignored `output/`，属于 2026-07-12 的本地历史验收资产，不是 HEAD 中的可追溯文件。首页历史图仍显示旧 `Stitch` 文本；当前产品品牌为“产品工作台”，该品牌迁移是允许差异，不能用旧文案要求当前页面逐像素一致。

所有截图位于 gitignored `output/`，状态文档以尺寸、字节数和 SHA-256 索引本机冻结资产。它们不是 HEAD 中的可追溯文件；固定视口矩阵已完成并在阶段 11 章节索引。

### 合同、迁移与安全

- 合同/API 变化：无。
- 数据迁移：无。
- 生产功能变化：无。
- 权限、revision、idempotency、Run SSE、Preview capability 和外部发布确认边界均未改变。
- checksum 边界只增加回归测试，没有放宽或改变发布语义。

### 偏差与剩余 UNKNOWN

1. 规格字面写“Web 不得直接导入数据库层”；当前边界按现有架构限定为 Workbench/Auth 产品页面、组件和 `lib/workbench`，保留 `lib/auth/workbench-auth.server.ts` 为 Better Auth 服务端合法 `pg` owner。扩大到整个 `apps/web` 会破坏当前 Better Auth 架构，因此这是明确偏差，不是静默例外。
2. 品牌检查只对白名单 `docs/stitch-parity/IMPLEMENTATION-STATUS.md` 放行旧产品参考词，原因是规格要求该内部证据路径与对比说明；运行时、其他文档和产品表面仍严格禁止旧品牌。
3. 阶段 0 当时的视觉基线只有 1501x855；当前已补充 390x844、320x720 交互 smoke，并已在阶段 11 完成 375x812、768x1024、1440x900 固定矩阵。
4. PostgreSQL 约束测试本轮没有在显式隔离测试库上复跑；只有修改前 6/6 记录和当前无环境变量的前置失败。
5. 修改前 Worker 的精确 pass/skip 拆分没有持久日志，只能确认当时总数 126；本阶段新增 1 个非 skip 用例后，当前权威结果为 117 passed、10 skipped、127 total。
6. HEAD 本身不包含实施规格、Workbench 新模块或本状态文档；当前基线依赖 dirty worktree，后续提交前必须按阶段精确审查文件所有权。
7. Evidence Bundle 中失败的私有 RPC 抓包仍只可标为失败样本；不得据此推断 Google 服务端协议。

### 阶段 0 完成时记录的下一阶段前置条件

- 为需要 PostgreSQL 验证的阶段提供显式隔离的 `WORKBENCH_TEST_DATABASE_URL`。
- 阶段 1 开始时重新读取真实画布 controller/store/test 调用点，严格先补工具语义测试，不提前混入阶段 2 以后功能。
