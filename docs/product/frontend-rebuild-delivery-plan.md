# Studio 前端重构实施账本

基线为[本地正式 PRD 1.3](visual-prototype-frontend-rebuild-requirements.md)，沿用 44 项功能需求与 50 项验收标准。本文列出 Studio 的实现入口、正式接口和验收操作。按候选与证据边界记录的运行结果、待验项和发布状态见[现行审计](../audit/1.0.0.md)。

- **待开发**表示产品行为或入口存在缺口。**待接入**表示对应入口还需服务或基础设施。**待验收**表示固定候选仍需执行该项操作。历史证据名称及执行边界以现行审计为准。
- Studio 源码路径相对 `apps/web/`。`C/` 为 `components/studio/`，`S/` 为 `lib/studio/`。A 舞台与 Composer，B 知识讨论与生成，C 原型浏览与修订，D 资料与交付，E 响应式、可访问性及性能。正式工作包及完成条件见 [PRD §9.2](visual-prototype-frontend-rebuild-requirements.md#92-工作包与依赖顺序)。

## 核心接口与验收入口

| 范围 | 实现合同 | 可重跑的验收 |
| --- | --- | --- |
| Composer 和需求历史 | [需求输入](../../apps/web/components/studio/requirement-input.tsx)负责折叠空闲讨论。[Composer](../../apps/web/components/studio/composer.tsx)保留未就绪输入和失效引用，按正式模型目录、版本和输出范围提交。[需求讨论](../../apps/web/lib/studio/use-requirement-discussion.ts)通过仅限当前授权会话的消息游标恢复历史、保存后续要求并显式确认冻结基线。 | 运行[舞台浏览器用例](../../scripts/e2e/workbench-studio-comprehensive-acceptance-smoke.mjs)和[讨论浏览器用例](../../scripts/e2e/workbench-studio-requirement-workflow-smoke.mjs)。在桌面与窄屏开关讨论、聚焦长输入，核对舞台、发送/停止和焦点。在同一 Thread 创建交错的两组讨论，验证分页、追加、刷新与会话切换。 |
| FE-L015 · 发布页导出终态 | [发布面板](../../apps/web/components/studio/project-publishing.tsx)将取消回执和轮询结果写入同一项目的导出查询缓存。对同一任务，较低 revision 和迟到活动状态不能回退已接受的取消中状态或终态。成功保留校验下载，失败与已取消保留固定版本重试，新任务以自己的 ID 跟踪。 | 重跑[发布面板取消回归](../../apps/web/components/studio/generic-export-cancellation.spec.tsx)。依次投递三种终态与迟到的活动页，重新进入面板，再核对新任务可独立取消。服务侧核对见[后端实施账本](backend-rebuild-delivery-plan.md)。 |

## 功能需求

| 需求 | 包 · 新入口 | 实际代码路径 | 实现情况 | 可重跑的浏览器操作 | 后端依赖 · 核对条件 |
|---|---|---|---|---|---|
| FR-01 | A · 项目 → 页面、文档、资料、运行 | C/workspace.tsx、C/onlook/main.tsx、app/(workbench)/studio/[projectId]/page.tsx | 待验收，统一壳已挂载 | 综合浏览器验证 7 视图及 4 个面板 | 项目 bootstrap · 验证新候选切换与恢复 |
| FR-02 | A · 默认浅色舞台及侧面板 | C/onlook/main.tsx、app/globals.css | 待验收，浅色与紧凑布局已实现 | stage2-comprehensive-20m 桌面主区 95.8% | 无 · 用新候选复拍展开和收起状态 |
| FR-03 | D · 首页、左栏、Composer 补充输入及交付菜单 | C/home.tsx、C/project-views.tsx、C/context-library.tsx、C/project-publishing.tsx | 项目首页、资料导入、运行、产物与发布均由新 Studio 入口调用正式服务 | 从左栏或 Composer 打开资料、提交网站/GitHub/Figma 导入并选择 ready 来源 | 核对所选 Source ID、处理失败和账户授权。上游传输与夹具边界见现行审计 |
| FR-04 | A · 舞台下方 Composer 与专注预览 | C/requirement-input.tsx、C/workspace.tsx、C/onlook/chat-input.tsx | 生成时将空闲讨论收进可展开区，保留输入、停止、澄清与确认。窄屏可展开输入设置 | 开关面板并输入长文本，在桌面与缩短视口核对 Composer 居中、草稿面积和页面底部可达 | 在系统软键盘与读屏下复核焦点和安全区 |
| FR-05 | A · Composer 的附件、来源、模型、设计及三种输出 | C/composer.tsx、C/context-library.tsx、S/use-input-preparation.ts | 文件准备状态、正式来源核验、设计版本、模型目录及三种输出共用 Composer。默认联合输出 | 分别选择原始文件与已就绪来源，以正式讨论请求核对 Source、设计及输出参数 | 核对失败、无权和失效输入，并复核同一真实确认所冻结的完整输入 |
| FR-06 | A · 从版本或元素进入修改，Composer 切新建或清除上下文 | C/workspace.tsx、C/requirement-input.tsx、S/composer-session.ts | 待验收，有固定版本与引用、按上下文保留草稿 | requirement-workflow 的固定版本修改；variants 手机操作 | 版本关系、模型能力 · 真实核对修改请求和源版本 |
| FR-07 | A · 当前讨论历史、生成中追加 | C/requirement-discussion.tsx、S/use-requirement-discussion.ts | 按授权操作者、Thread 和会话读取独立消息历史，倒序分页后以时间正序展示。追加区分当前冻结基线与后续讨论 | 交错创建两会话，加载更旧消息、追加、刷新并切换会话 | 在真实运行中串联追加、刷新、停止和再次确认 |
| FR-08 | B · 讨论确认卡及固定输入详情 | C/requirement-discussion.tsx、S/requirement-view-adapter.ts | 正式确认服务按摘要版本与校验值冻结，Studio 由单次显式确认进入生成 | 比较确认卡和 Run 回执，重复点击并检查同一确认 ID | 按输出类型和修改版本复核冻结请求与审批边界 |
| FR-09 | A · Composer 上方进度及详情 | C/workspace.tsx、S/run.ts | 待验收，阶段来自服务状态。耗时与进度分开 | 综合浏览器 SSE 及历史运行视图 | Run 进度流 · 核对实际阶段链与未知总量 |
| FR-10 | A · 生成时的草稿与 Swarm 动效开关 | C/page-stage.tsx、C/draft-projection.tsx、C/swarm/engine.ts | 正式 Flash 原型运行的中间草稿事件驱动舞台节点和可选 Swarm 动效 | 录制真实生成，按事件序号对照终态前的至少两次可见内容变化 | 在修订和联合任务复核草稿与冻结版本，对账见现行审计 |
| FR-11 | A · 草稿页面与色框、窗口节点数 | C/page-stage.tsx、C/draft-projection.tsx、C/swarm/snapshot.ts | 待验收，窗口计数与节点差异已实现 | 综合浏览器 SSE、动效开关与 Swarm 组件专项 | 有界节点投影 · 复核重复、替换、无坐标活动与用户定位 |
| FR-12 | A · 草稿页切换与最终预览 | C/page-stage.tsx、C/workspace.tsx | 待验收，首批投影可直接显示。已知窗口外页保留选择，匹配页接入最终版本 | studio-stage-a 的旧页直达、窗口离开/返回、刷新与草稿至冻结截图 | 投影窗口、冻结版本 · 实际模型下复核视口及切换 |
| FR-13 | B · 运行详情与打开新结果 | S/run.ts、C/workspace.tsx、lib/workbench/prototype-v2/ | 正式 Run 快照与 SSE 按作用域、attempt 和游标恢复，终态保护旧事件无法覆盖新结果 | 中断实际 SSE，断流期间推进阶段，核对重取快照后按最后游标续接 | 在同一真实模型候选串联断线、旧尝试和重试 |
| FR-14 | B · 停止、运行详情及重试 | C/workspace.tsx、S/run.ts、S/use-requirement-discussion.ts | 正式取消与原冻结计划重试已连通，计划抽屉及需求区采用权威终态 | 分别停止排队与执行中的 Run，等待终态，再由原请求重试 | 核对 provider 确认、原 Run 写入指纹和冻结输入。实际回执见现行审计 |
| FR-15 | C · 页面总览、搜索及缩略图 | C/page-stage.tsx | 待验收，懒加载缩略图与单页入口 | 综合浏览器 50 页及切换指标 | 冻结页面列表 · 核对失效缩略图和总览位置 |
| FR-16 | C · 适应、缩放、设备尺寸及平移 | C/page-stage.tsx、C/onlook/canvas.tsx、C/onlook/device-selector.tsx | 待验收，Onlook 指针/键盘平移与缩放已接 | 综合浏览器尺寸、DPR 及页面切换 | 预览文档 · 实测触摸与四角可达 |
| FR-17 | C · 最终原型浏览模式 | C/page-stage.tsx、C/preview.ts | 待接入，独立沙箱内交互已接 | visual-workspace 表单与保存；swarm-public 页内交互 | 冻结 HTML 与预览协议 · 验真实生成样本的完整交互 |
| FR-18 | C · 选择元素、图层、父级与 Esc | C/page-stage.tsx、C/geometry-bridge.ts、C/onlook/base-rect.tsx | 待验收，双向定位已接 | visual-workspace 与综合浏览器的元素、图层操作 | 节点 ID 及沙箱协议 · 复核键盘及选择退出 |
| FR-19 | C · 蓝色轮廓、尺寸、定位失效 | C/geometry-bridge.ts、C/page-stage.tsx、C/preview.ts | 选区按 iframe 当前真实坐标投影，目标隐藏、删除或失效时清理覆盖层 | 在 Chromium/WebKit 跨 DPR、滚动、缩放及 resize 比对 DOM 与选区，阈值为 2 CSS px | 另核对原生 Safari 缩放和键盘图层流程 |
| FR-20 | C · 批注当前版本、页面、所选元素 | C/workspace.tsx、C/page-stage.tsx | 待验收，绑定、幂等和缺失锚点提示已接 | visual-workspace 锚点与断线恢复；实际迭代待验证 | 批注与位置解析 · 使用新的真实生成版本核对 |
| FR-21 | C · 筛选并选中部分批注发起修改 | C/workspace.tsx、C/requirement-input.tsx | 待接入，有上限、显式选择和版本上下文 | 批注专项及固定版本讨论 | 批注 CAS、确认与新版本 · 验已解决竞争 |
| FR-22 | C · 版本历史、相对源版本差异 | C/workspace.tsx、C/page-stage.tsx | 待验收，固定选择、版本到达提示及页面变更 | lifecycle / visual-workspace 的版本操作 | 历史版本、diff、来源 · 真实迭代与历史不抢切 |
| FR-23 | C · 版本确认、驳回及生成完成状态 | C/workspace.tsx、C/actions.tsx | 待验收，独立审核动作和冲突恢复 | lifecycle 受控审核；真实内容 hash 待测 | CAS、版本审核及冻结 · 确认、驳回后复核 hash |
| FR-24 | D · 文档视图、来源关系及继续生成 | C/document-view.tsx、C/relations.tsx、C/artifact-links.tsx | 待接入，文档、PRD 与原型导航及分项状态已接 | requirement-workflow、document-recovery、variants | Run 产物、固定关系、文档导出 · 真三输出与分项失败 |
| FR-25 | D · 资料、设计、知识及 Composer 引用 | C/content.tsx、C/context-library.tsx、C/composer.tsx | 待接入，来源目录分页与按 ID 核验已实现 | 综合浏览器的解析失败，input/media 与分页专项 | S3、导入、知识授权 · 验真实失败、删除、权限、替换 |
| FR-26 | D · 交付面板分享与公开页 | C/workspace.tsx、C/project-publishing.tsx、C/public-prototype.tsx、C/public-release.tsx | 待接入，版本固定、撤销与到期处理已接 | swarm-public 匿名交互与失效，7/30 天同键恢复专项 | 分享持久化与公共读取 · 真实创建、撤销、自然到期 |
| FR-27 | D · 交付面板 HTML/React 及发布页导出 | C/workspace.tsx、C/project-publishing.tsx、C/actions.tsx | 从正式交付入口固定历史版本，按大小和 SHA-256 校验下载，并保留已确认的导出终态 | 实际下载 HTML/React 并独立打开或构建，再模拟取消期间的迟到列表并创建新任务 | 定位 FE-L015 及后端 BE-012 至 BE-014 |
| FR-28 | D · 首页、登录/注册、邀请、项目菜单和运行发布 | C/home.tsx、C/project-members.tsx、C/project-views.tsx、C/project-publishing.tsx | 待验收，已具新入口和局部真实权限证据 | studio-live-flash/1794930509434 真账户、邀请、撤权。邮件验证使用测试前置状态 | Auth、邮件、角色、运行发布 · 核对完整导航与实际邮件边界 |
| FR-29 | E · 各主视图中的提示及原位恢复 | C/project-route.tsx、S/project-access.ts、C/workspace.tsx、C/document-view.tsx | 待验收，撤权、并发及丢响应状态分离 | document-recovery、真实成员撤权专项 | 401/403/404/409/412、网络 · 同一候选逐域核对 |
| FR-30 | E · 手机底部输入及折叠面板 | C/onlook/main.tsx、C/workspace.tsx、app/globals.css | 待验收，移动布局及软键盘 viewport 处理已接 | 综合浏览器 390×480 模拟键盘；media 五视口 | 无 · 实际移动 Safari 软键盘及全流程 |
| FR-31 | E · 键盘、焦点、读屏与减弱动画 | C/page-stage.tsx、C/composer.tsx、C/draft-projection.tsx、app/globals.css | 待验收，焦点与系统动效偏好已接；真实读屏证据缺失 | studio-keyboard-focus、综合浏览器 200% 与 reduced-motion | 无 · VoiceOver 逐流程验及焦点修复 |
| FR-32 | E · 新路由直达、页面版本与草稿恢复 | C/workspace.tsx、S/composer-session.ts、S/stored-record.ts | 面板按已授权账号与项目恢复，页面、版本、草稿和视口沿各自作用域恢复 | 尝试两个项目/版本的刷新和前进后退，撤权或退出后换账号，核对私有状态和键盘回焦 | 核对当前候选的完整恢复链 |
| FR-33 | E · 新项目、分享与邀请路由 | app/(workbench)/、C/project-route.tsx、S/api.ts | 待验收，旧工作台渲染及旧 Plan 审批入口退出 | 综合浏览器导航与退役路由检查 | 现有业务持久数据与新合同 · 固定发布树真实流程 |
| FR-34 | A · Onlook 舞台及 React Swarm 绘制 | C/onlook/、C/swarm/、仓库根目录 third_party/ | 已验证来源、许可证及实际挂载 | 来源校验与综合浏览器舞台几何、动画录像 | 当前 Workbench 服务 · 随发布树复查来源与依赖 |
| FR-35 | B · 普通发送进入需求讨论 | C/composer.tsx、S/use-requirement-discussion.ts、S/requirement-api.ts | 普通发送走正式 Flash 需求讨论。显式确认是创建生成运行的入口 | 提交简短和充分的需求，核对普通发送后 Run 数量及澄清/就绪状态 | 分别在仅 PRD、仅原型、联合及固定修改上下文核对 |
| FR-36 | B · 确认卡已有能力、复用、新增与平台级提议 | C/requirement-discussion.tsx、S/requirement-view-adapter.ts | 正式已发布知识依据随需求卡呈现，卡片区分已有能力、复用、新增和平台级提议 | 对照真实知识条目的 release、范围及卡片提议，核对局部改造和显式同意 | 按 PRD 与原型实际产物检查无关能力保留 |
| FR-37 | B · 少量关键问题与确认可用状态 | C/requirement-discussion.tsx、S/use-requirement-discussion.ts | 正式 Flash 分析返回结构化就绪或澄清状态，Studio 依权威状态显示确认可用性 | 以短目标、缺知识、平台改造和充分需求检查关键问题与就绪转换 | 分别核对有无用户明确同意时的展示与固定输入 |
| FR-38 | B · 可审阅确认卡及继续调整 | C/requirement-discussion.tsx、C/requirement-input.tsx | 待验收，有事实/建议/来源分组与自然语言调整 | requirement-workflow 中未提交文本会禁用旧确认 | 摘要修订、授权来源 · 真链路核对更新与冲突 |
| FR-39 | B · 确认需求并生成 | S/use-requirement-discussion.ts、C/workspace.tsx | 显式确认绑定真实摘要、固定基线与派发回执。刷新可恢复原动作 | 比对确认卡和实际 Run 的 checksum，重放动作并核对仅有一次派发 | 按三种输出及固定版本修改逐条对账 |
| FR-40 | B · 单 PRD、单原型及联合作品 | C/workspace.tsx、C/project-views.tsx、C/document-view.tsx | 三种输出使用正式确认接口，Studio 按产物类型呈现路由、来源关系和分项结果 | 逐一确认三种输出，从历史打开固定产物并跟随双向关联 | 核对冻结基线、分项恢复和实际产物，运行边界见现行审计 |
| FR-41 | B · 持久讨论、冲突与恢复原动作 | S/use-requirement-discussion.ts、C/requirement-sessions.tsx | 待验收，待提交动作与同键恢复已接 | requirement-workflow 重载，真实权限专项 | 会话分页、CAS、幂等回执 · 真双标签及丢响应 |
| FR-42 | B · 当前生成期间保存后续要求 | C/workspace.tsx、S/use-requirement-discussion.ts | 待验收，有当前与后续边界提示 | requirement-workflow 的追加不启动另一 Run | 冻结确认、后续讨论、取消/重试 · 真流程跨刷新 |
| FR-43 | B · 依据、适用范围和冲突提示 | C/requirement-discussion.tsx、S/requirement-view-adapter.ts | 按正式知识检索结果展示依据、适用范围、缺口与冲突 | 用真实缺失、冲突、区域和受限案例核对卡片分组、权限及确认门禁 | 对照最终产物中的引用、范围及真实来源版本 |
| FR-44 | B · 正式需求 API、错误恢复与知识依据 | S/requirement-api.ts、S/requirement-view-adapter.ts、C/workspace.tsx | Studio 通过正式需求 API 接入知识检索和 Flash 分析，通过正式 Run 合同读取执行进度和产物 | 用实际会话核对授权引用、错误恢复、单次确认、Run 回执及产物校验 | 按固定发布树复核三种输出及整体交付，阶段性真实边界见现行审计 |

## 验收标准

| 验收 | 新界面操作 · 代码入口 | 验收操作与实现依据 | 服务依赖 · 余下动作 |
|---|---|---|---|
| AC-01 | 项目舞台收放两侧 · C/onlook/main.tsx | 待验收。综合浏览器已测默认主区 95.8% | bootstrap · 当前候选截图 |
| AC-02 | 项目左栏、面板与交付菜单 · C/workspace.tsx | 待验收。综合浏览器 7 视图 4 面板可达 | 各业务接口 · 实际逐项操作 |
| AC-03 | 展开面板、长输入与页面底部 · C/composer.tsx | 待验收。综合浏览器验证居中与底部可达 | 无 · 当前构建录像 |
| AC-04 | 附件/资料/模型/设计引用 · S/use-input-preparation.ts | 待接入。受控请求与分页恢复已验证 | 存储/来源权限 · 核对真实请求引用 |
| AC-05 | 普通修改、元素修改、新建和中文输入 · C/workspace.tsx | 待验收。固定上下文与草稿专项，IME 受控 | 版本及需求 API · 真元素修改 |
| AC-06 | 确认卡及重复点击 · C/requirement-discussion.tsx | 待接入。受控单次确认通过 | CAS / 派发 · 实际 Run 验一次确认 |
| AC-07 | 展开运行阶段 · C/workspace.tsx | 待接入。SSE 受控阶段投影 | 实际阶段事件 · 录屏核对阶段与时间 |
| AC-08 | 页面舞台观察真实生成 · C/draft-projection.tsx | 运行真实 Flash 原型并录制终态前的内容变化 | 以实际事件序号对照至少两次草稿变化，保留成功冻结回执 |
| AC-09 | 草稿切页、节点更新及窗口外页 · C/page-stage.tsx | 待验收。studio-stage-a 已操作旧页跳入首批草稿、窗口边界及动效选择 | 投影窗口 · 真实生成复核范围与计数 |
| AC-10 | 从草稿到冻结预览 · C/workspace.tsx、C/page-stage.tsx | 待接入。studio-stage-a 受控 SSE 刷新后成功交接到冻结 iframe 同页 | 真实 Run 与冻结原型 · 核对页面和可保留视口连续 |
| AC-11 | 生成中刷新、断线及直达 · S/run.ts | 待验收。受控恢复与事件去重 | Run snapshot/SSE · 真端到端恢复 |
| AC-12 | 迟到或重复事件并切项目 · S/run.ts | 待验收。综合浏览器双项目、事件专项 | 相同候选的 Run 事件 · 缺口及旧 attempt 实验 |
| AC-13 | 停止、失败、从原输入重试 · C/workspace.tsx | 在排队和运行中停止并从原冻结请求重试 | 核对取消终态、provider 确认、重试产物和原 Run 无迟到写入 |
| AC-14 | 总览搜索并进入 50 页 · C/page-stage.tsx | 待验收。综合浏览器已有 50 页样本与 P95 | 冻结样本 · 当前构建复跑及视图恢复 |
| AC-15 | 在最终 iframe 输入、提交、切页 · C/page-stage.tsx | 待接入。受控表单、公开页实际浏览器交互 | 生成出的完整有效 HTML · 真场景录屏 |
| AC-16 | 选择、图层、父级及 Esc · C/page-stage.tsx | 待验收。综合浏览器 Escape，visual-workspace 锚点选择 | 节点协议 · 当前候选全键盘 |
| AC-17 | 尺寸、滚动、缩放与 DPR · C/geometry-bridge.ts | 比较 Chromium/WebKit 页内 DOM 和选区，覆盖 DPR、滚动、缩放、resize 及目标失效 | 阈值 ≤2 CSS px。复核 Safari 原生缩放 |
| AC-18 | 版本/元素批注及丢响应后重试 · C/workspace.tsx | 待验收。有固定锚点和受控恢复 | 批注与冻结节点 · 真新版本删节点 |
| AC-19 | 部分批注修订与并发 · C/workspace.tsx | 待接入。有上限与冲突处理 | 权威批注状态、冻结引用 · 真并发、源内容 hash |
| AC-20 | 查看差异、确认/驳回与历史页 · C/workspace.tsx | 待验收。lifecycle 与差异局部检查 | 版本审核、冻结 · 实际迭代及查看不抢切 |
| AC-21 | 三种输出与文档/原型关联 · C/project-views.tsx | 待接入。requirement-workflow 三种路由 | Flash、产物、冻结关系 · 验分项失败 |
| AC-22 | 失效资料、模型或设计选项 · C/context-library.tsx | 待接入。资料失败、来源分页、模型/设计恢复 | 解析、授权、模型目录 · 真实故障 |
| AC-23 | 创建、访问、撤销、到期和无效链接 · C/public-prototype.tsx | 待接入。swarm-public 有受控匿名与失效操作 | 分享实际凭据 · 真自然到期及无私人读取 |
| AC-24 | 交付面板下载 HTML/React · C/actions.tsx | 通过正式交付入口下载固定版本 HTML/React | S3/Export Worker · 校验字节和 SHA-256，再独立构建并检查交互 |
| AC-25 | 交付面板 · C/project-publishing.tsx | 按 FE-L015 操作取消、延迟列表、重新进入面板和新任务 | 结合 BE-012 至 BE-014 核对 Worker 清理回执、导出重试及历史升级 |
| AC-26 | 新登录/邀请/分享与回退 · C/project-route.tsx | 待验收。真实注册与邀请接受（验证邮箱用测试前置状态） | Auth/邮件/公开路由 · 补真实登录及历史导航 |
| AC-27 | 局部错误、撤权和编辑冲突 · C/document-view.tsx、S/project-access.ts | 待验收。已有真实撤权及受控冲突恢复 | HTTP 错误与权限 · 验证各类局部状态 |
| AC-28 | 五个视口及手机输入与交付 · C/onlook/main.tsx | 待验收。综合浏览器仅有模拟键盘，media 五视口 | 无 · Studio 五视口与移动 Safari 真软键盘 |
| AC-29 | 键盘、读屏、200% 与减弱动画 · C/composer.tsx、C/page-stage.tsx | 待验收。焦点、减弱动画及 200% 有 Chromium 证据 | 无 · 真读屏和 Safari 焦点 |
| AC-30 | 两账户/两项目/两版本与退出 · S/composer-session.ts | 待验收。真实账户隔离及综合浏览器跨项目版本 | 身份与成员服务 · 合并全流程 |
| AC-31 | viewer、跨项目及匿名进度 · C/project-route.tsx | 待验收。真实非成员/移除测试；未覆盖全部进度场景 | 服务端成员授权 · 实测 viewer 写入及匿名进度 |
| AC-32 | 预览选择及沙箱边界 · C/geometry-bridge.ts | 待验收。综合浏览器消息校验及沙箱属性 | 冻结 HTML · 同候选复核外部请求与内容 hash |
| AC-33 | 50 页、SSE、20 分钟及 P95 · C/page-stage.tsx | 待验收。历史同构操作实测 P95 50.9/10.72/285.14 ms，有资源对照 | 固定浏览器和候选 · 当前树重新长跑 |
| AC-34 | 流断开、几何、缩略图或导出故障 · C/page-stage.tsx、S/run.ts | 待验收。综合浏览器覆盖部分局部失败 | SSE 与工件接口 · 同候选四种故障 |
| AC-35 | 完成新入口全路径 · app/(workbench)/、S/api.ts | 待验收。退役路由与架构已有检查 | 真实全流程 · 发布树依赖核对 |
| AC-36 | 舞台、选择与 Swarm · C/onlook/、C/swarm/ | 已验证开源上游、署名、派生与运行 | 同树来源校验 · 发布前复查 |
| AC-37 | 各发一条简短及充分需求 · C/requirement-discussion.tsx | 以实际 Flash 讨论核对普通发送后仍为零 Run，比较关键澄清及充分需求就绪 | Flash/检索 · 对照授权依据和结构化状态 |
| AC-38 | 活动字段和规则局部扩展 · C/requirement-discussion.tsx | 待接入。固定依据与改动分组已渲染 | 已发布知识 · 真局部改造及无关能力保留 |
| AC-39 | 新功能与平台成本提案 · C/requirement-discussion.tsx | 待接入。平台范围显式授权门禁已接 | 平台能力检索 · 真新增模块归属 |
| AC-40 | 缺失/冲突/区域/受限依据 · S/requirement-view-adapter.ts | 以已发布知识构造缺失、冲突、地域限制与受限样本 | 逐项核对引用范围、权限遮蔽和确认门禁 |
| AC-41 | 修改描述、切换输出或追加资料后核对旧卡 · C/workspace.tsx | 待验收。dirty 输入与 CAS 受控回归 | 真实摘要版本 · 验新卡差异与旧确认失效 |
| AC-42 | 分别确认三种产物 · S/use-requirement-discussion.ts | 逐一提交仅 PRD、仅原型和联合输出。每路显式确认一次 | 核对冻结基线、知识版本、Run 数量及固定产物 |
| AC-43 | 同一消息/确认重复、丢回执和刷新 · S/use-requirement-discussion.ts | 待验收。持久动作与重放有局部证据 | 权威幂等回执 · 真HTTP 丢响应 |
| AC-44 | 双标签 CAS、角色和资料范围 · S/project-access.ts、S/use-requirement-discussion.ts | 待验收。真实撤权/草稿；受控 CAS | 同候选真双标签和授权来源拒绝 |
| AC-45 | 生成中续写、停止/重试并确认后续 · C/workspace.tsx | 待接入。受控追加不会启动下一 Run | 真实取消、重试与后续确认 · 核对冻结内容 |
| AC-46 | 成品对照确认卡与知识发布历史 · C/document-view.tsx、C/relations.tsx | 待接入。现有关系可导航，真实语义待核对 | 两种真实产物 · 对比增量规则与出典 |
| AC-47 | 小屏讨论、分页、IME 与键盘 · C/requirement-input.tsx、C/composer.tsx | 在缩短视口聚焦输入并操作单会话分页。检查追加后的顺序与会话隔离 | 用实际移动软键盘、VoiceOver 和中文输入法完成长讨论及键盘确认 |
| AC-48 | 实际检索/模型失败、重连和三种输出 · S/requirement-api.ts | 调用正式讨论/运行服务，分别触发检索与 Flash 故障，通过原会话恢复 | 分别核对三种输出、重连和授权引用，运行实证见现行审计 |
| AC-49 | 从真实生成到四类文件交付 · C/workspace.tsx、C/project-publishing.tsx | 从真实 Flash 生成观察中间变化与最终交互，提取固定版本并申请交付 | Flash、Worker、存储 · 检查四类文件并在同一候选执行性能与可访问性回归 |
| AC-50 | 对照服务、Web、GitHub 身份 · S/requirement-api.ts、lib/workbench/api/schema.d.ts | 校对正式 OpenAPI、生成类型、Web 和 Runtime 来源身份 | 固定源树与运行证明 · 发布及回退记录见现行审计 |

## 固定候选的复验顺序

1. 先从新 Studio 打开舞台、Composer 和单会话历史，核对草稿首屏、切页、投影窗口、焦点及冻结交接。
2. 再分别通过正式知识与 Flash 服务提交讨论、确认、运行与恢复，核对原型版本、差异、批注、分享和交付。
3. 随最终候选复核原生浏览器、读屏、移动软键盘与性能。每项执行的候选、服务边界及结果录入[现行审计](../audit/1.0.0.md)。
