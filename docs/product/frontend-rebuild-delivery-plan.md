# Studio 前端重构实施账本

基线采用[本地正式需求](visual-prototype-frontend-rebuild-requirements.md)。已核对 [GitHub main 的需求正文](https://github.com/harrylee-bot/ai-product-workbench/blob/main/docs/product/visual-prototype-frontend-rebuild-requirements.md)。公开正文为较早的 1.2 版，本地保留已确认的需求交流、增量边界、单次确认与 Swarm 补充。以当前前端工作树为实施边界，运行结果和本地日志见[现行审计](../audit/1.0.0.md)。

- **待开发**表示产品行为或入口存在缺口。**待接入**表示 UI 已具备相应入口，仍需固定服务候选或真实基础设施。**待验收**表示代码路径已具备，可继续在实际新界面验收。**已验证**表示当前证据直接满足该项所述边界。
- 表中的 Studio 源码路径相对 `apps/web/`。`C/` 为 `components/studio/`，`S/` 为 `lib/studio/`。证据名指 `output/audit/1.0.0/` 下目录或文件，详细结果见现行审计。除注明真实服务外，浏览器数据为受控合同场景。
- A 舞台与 Composer，B 知识讨论与生成，C 原型浏览与修订，D 资料与交付，E 响应式、可访问性及性能。统一候选沿用同一套新界面和既有业务数据。

## 功能需求

| 需求 | 包 · 新入口 | 实际代码路径 | 实现情况 | 可操作浏览器证据 | 后端依赖 · 下一步 |
|---|---|---|---|---|---|
| FR-01 | A · 项目 → 页面、文档、资料、运行 | C/workspace.tsx、C/onlook/main.tsx、app/(workbench)/studio/[projectId]/page.tsx | 待验收，统一壳已挂载 | 综合浏览器验证 7 视图及 4 个面板 | 项目 bootstrap · 验证新候选切换与恢复 |
| FR-02 | A · 默认浅色舞台及侧面板 | C/onlook/main.tsx、app/globals.css | 待验收，浅色与紧凑布局已实现 | stage2-comprehensive-20m 桌面主区 95.8% | 无 · 用新候选复拍展开和收起状态 |
| FR-03 | D · 首页、左栏、Composer 补充输入及交付菜单 | C/home.tsx、C/project-views.tsx、C/context-library.tsx、C/project-publishing.tsx | 待验收，入口已挂载 | 综合浏览器覆盖面板及一级入口，media/variants/history 各有流程 | 项目、资料、运行、产物、导入、发布 · 逐项操作实际账户 |
| FR-04 | A · 舞台下方 Composer 与专注预览 | C/requirement-input.tsx、C/workspace.tsx、C/onlook/chat-input.tsx | 生成期间收起空闲讨论，保留输入、停止、澄清与确认；窄屏可展开输入设置 | studio-integrated-stage-final 实测桌面草稿可见高度 569.5 px，展开讨论时 383.5 px；390×480 聚焦输入后 164.5 px | 待实际设备软键盘与读屏复核 |
| FR-05 | A · Composer 的附件、来源、模型、设计及三种输出 | C/composer.tsx、C/context-library.tsx、S/use-input-preparation.ts | 待接入，输入与错误恢复已接到正式接口形状 | requirement-workflow 验三种输出，input/media 验附件状态及实际选择文件 | 存储、解析、授权来源、模型目录 · 真实上传并核对固定引用 |
| FR-06 | A · 从版本或元素进入修改，Composer 切新建或清除上下文 | C/workspace.tsx、C/requirement-input.tsx、S/composer-session.ts | 待验收，有固定版本与引用、按上下文保留草稿 | requirement-workflow 的固定版本修改；variants 手机操作 | 版本关系、模型能力 · 真实核对修改请求和源版本 |
| FR-07 | A · 当前讨论历史、生成中追加 | C/requirement-discussion.tsx、S/use-requirement-discussion.ts | 已接单会话消息 API，按操作者、Thread 和会话保存查询，倒序分页后按时间正序展示 | session-messages-http-postgres 验证交错会话、翻页、追加、刷新；studio-integrated-discussion 验三路径的后续消息 | 待真实生成和设备联验 |
| FR-08 | B · 讨论确认卡及固定输入详情 | C/requirement-discussion.tsx、S/requirement-view-adapter.ts | 待接入，单次确认取代旧 Plan 审批 | requirement-workflow 的确认及重复动作场景 | 用户授权摘要/CAS/固定确认 · 实际核对卡片与 Run |
| FR-09 | A · Composer 上方进度及详情 | C/workspace.tsx、S/run.ts | 待验收，阶段来自服务状态。耗时与进度分开 | 综合浏览器 SSE 及历史运行视图 | Run 进度流 · 核对实际阶段链与未知总量 |
| FR-10 | A · 生成时的草稿与 Swarm 动效开关 | C/page-stage.tsx、C/draft-projection.tsx、C/swarm/engine.ts | 待接入，真实投影事件可驱动节点变化；真实模型样本待取得 | stage2-comprehensive-20m 记录 SSE 驱动的可见变化与舞台截图 | Worker 投影、Flash · 真实终态前两次变化与事件对应 |
| FR-11 | A · 草稿页面与色框、窗口节点数 | C/page-stage.tsx、C/draft-projection.tsx、C/swarm/snapshot.ts | 待验收，窗口计数与节点差异已实现 | 综合浏览器 SSE、动效开关与 Swarm 组件专项 | 有界节点投影 · 复核重复、替换、无坐标活动与用户定位 |
| FR-12 | A · 草稿页切换与最终预览 | C/page-stage.tsx、C/workspace.tsx | 待验收，首批投影可直接显示。已知窗口外页保留选择，匹配页接入最终版本 | studio-stage-a 的旧页直达、窗口离开/返回、刷新与草稿至冻结截图 | 投影窗口、冻结版本 · 实际模型下复核视口及切换 |
| FR-13 | B · 运行详情与打开新结果 | S/run.ts、C/workspace.tsx、lib/workbench/prototype-v2/ | 待验收，恢复与去重已接入 | 综合浏览器双项目隔离与投影；真实断线终态待测 | Run snapshot/SSE、attempt · 同候选恢复和故障注入 |
| FR-14 | B · 停止、运行详情及重试 | C/workspace.tsx、S/run.ts、S/use-requirement-discussion.ts | 待接入，取消与固定 Plan 重试已接；核对终态和恢复 | requirement-workflow 的派发恢复；缺实运行取消录屏 | Plan/Run 取消、重试、输入待办 · 验排队与执行中停止 |
| FR-15 | C · 页面总览、搜索及缩略图 | C/page-stage.tsx | 待验收，懒加载缩略图与单页入口 | 综合浏览器 50 页及切换指标 | 冻结页面列表 · 核对失效缩略图和总览位置 |
| FR-16 | C · 适应、缩放、设备尺寸及平移 | C/page-stage.tsx、C/onlook/canvas.tsx、C/onlook/device-selector.tsx | 待验收，Onlook 指针/键盘平移与缩放已接 | 综合浏览器尺寸、DPR 及页面切换 | 预览文档 · 实测触摸与四角可达 |
| FR-17 | C · 最终原型浏览模式 | C/page-stage.tsx、C/preview.ts | 待接入，独立沙箱内交互已接 | visual-workspace 表单与保存；swarm-public 页内交互 | 冻结 HTML 与预览协议 · 验真实生成样本的完整交互 |
| FR-18 | C · 选择元素、图层、父级与 Esc | C/page-stage.tsx、C/geometry-bridge.ts、C/onlook/base-rect.tsx | 待验收，双向定位已接 | visual-workspace 与综合浏览器的元素、图层操作 | 节点 ID 及沙箱协议 · 复核键盘及选择退出 |
| FR-19 | C · 蓝色轮廓、尺寸、定位失效 | C/geometry-bridge.ts、C/page-stage.tsx、C/preview.ts | 待验收，消息边界与换页清理已实现 | 综合浏览器 DPR 2 + 缩放 ≤2 CSS px，拒绝无效消息 | 冻结框架 · 扩展 Safari、DPR 及滚动验证 |
| FR-20 | C · 批注当前版本、页面、所选元素 | C/workspace.tsx、C/page-stage.tsx | 待验收，绑定、幂等和缺失锚点提示已接 | visual-workspace 锚点与断线恢复；实际迭代待验证 | 批注与位置解析 · 使用新的真实生成版本核对 |
| FR-21 | C · 筛选并选中部分批注发起修改 | C/workspace.tsx、C/requirement-input.tsx | 待接入，有上限、显式选择和版本上下文 | 批注专项及固定版本讨论 | 批注 CAS、确认与新版本 · 验已解决竞争 |
| FR-22 | C · 版本历史、相对源版本差异 | C/workspace.tsx、C/page-stage.tsx | 待验收，固定选择、版本到达提示及页面变更 | lifecycle / visual-workspace 的版本操作 | 历史版本、diff、来源 · 真实迭代与历史不抢切 |
| FR-23 | C · 版本确认、驳回及生成完成状态 | C/workspace.tsx、C/actions.tsx | 待验收，独立审核动作和冲突恢复 | lifecycle 受控审核；真实内容 hash 待测 | CAS、版本审核及冻结 · 确认、驳回后复核 hash |
| FR-24 | D · 文档视图、来源关系及继续生成 | C/document-view.tsx、C/relations.tsx、C/artifact-links.tsx | 待接入，文档、PRD 与原型导航及分项状态已接 | requirement-workflow、document-recovery、variants | Run 产物、固定关系、文档导出 · 真三输出与分项失败 |
| FR-25 | D · 资料、设计、知识及 Composer 引用 | C/content.tsx、C/context-library.tsx、C/composer.tsx | 待接入，来源目录分页与按 ID 核验已实现 | 综合浏览器的解析失败，input/media 与分页专项 | S3、导入、知识授权 · 验真实失败、删除、权限、替换 |
| FR-26 | D · 交付面板分享与公开页 | C/workspace.tsx、C/project-publishing.tsx、C/public-prototype.tsx、C/public-release.tsx | 待接入，版本固定、撤销与到期处理已接 | swarm-public 匿名交互与失效，7/30 天同键恢复专项 | 分享持久化与公共读取 · 真实创建、撤销、自然到期 |
| FR-27 | D · 交付面板 HTML/React 及发布页导出 | C/workspace.tsx、C/project-publishing.tsx、C/actions.tsx | 待接入，有版本、任务与下载校验、取消回执 | 综合浏览器失败恢复；FE-L014 回执专项 | Export Worker、S3 · 实下载、校验并构建 React，验取消终态 |
| FR-28 | D · 首页、登录/注册、邀请、项目菜单和运行发布 | C/home.tsx、C/project-members.tsx、C/project-views.tsx、C/project-publishing.tsx | 待验收，已具新入口和局部真实权限证据 | studio-live-flash/1794930509434 真账户、邀请、撤权。邮件验证使用测试前置状态 | Auth、邮件、角色、运行发布 · 核对完整导航与实际邮件边界 |
| FR-29 | E · 各主视图中的提示及原位恢复 | C/project-route.tsx、S/project-access.ts、C/workspace.tsx、C/document-view.tsx | 待验收，撤权、并发及丢响应状态分离 | document-recovery、真实成员撤权专项 | 401/403/404/409/412、网络 · 同一候选逐域核对 |
| FR-30 | E · 手机底部输入及折叠面板 | C/onlook/main.tsx、C/workspace.tsx、app/globals.css | 待验收，移动布局及软键盘 viewport 处理已接 | 综合浏览器 390×480 模拟键盘；media 五视口 | 无 · 实际移动 Safari 软键盘及全流程 |
| FR-31 | E · 键盘、焦点、读屏与减弱动画 | C/page-stage.tsx、C/composer.tsx、C/draft-projection.tsx、app/globals.css | 待验收，焦点与系统动效偏好已接；真实读屏证据缺失 | studio-keyboard-focus、综合浏览器 200% 与 reduced-motion | 无 · VoiceOver 逐流程验及焦点修复 |
| FR-32 | E · 新路由直达、页面版本与草稿恢复 | C/workspace.tsx、S/composer-session.ts、S/stored-record.ts | 待验收，隔离与链接恢复已接 | history 与综合浏览器；真实权限专项检验原账户草稿恢复 | 身份、授权和版本 · 真环境多项目、重载、前进后退 |
| FR-33 | E · 新项目、分享与邀请路由 | app/(workbench)/、C/project-route.tsx、S/api.ts | 待验收，旧工作台渲染及旧 Plan 审批入口退出 | 综合浏览器导航与退役路由检查 | 现有业务持久数据与新合同 · 固定发布树真实流程 |
| FR-34 | A · Onlook 舞台及 React Swarm 绘制 | C/onlook/、C/swarm/、仓库根目录 third_party/ | 已验证来源、许可证及实际挂载 | 来源校验与综合浏览器舞台几何、动画录像 | 当前 Workbench 服务 · 随发布树复查来源与依赖 |
| FR-35 | B · 普通发送进入需求讨论 | C/composer.tsx、S/use-requirement-discussion.ts、S/requirement-api.ts | 待接入，三路径只在确认后启动生成 | requirement-workflow 四条路径，普通发送无 Run | RequirementSession、模型 · 真模型简短和充分输入 |
| FR-36 | B · 确认卡已有能力、复用、新增与平台级提议 | C/requirement-discussion.tsx、S/requirement-view-adapter.ts | 待接入，分组与平台级显式边界已接 | 受控局部改动卡及同意动作 | 发布知识、结构化评估 · 核对真实增量语义 |
| FR-37 | B · 少量关键问题与确认可用状态 | C/requirement-discussion.tsx、S/use-requirement-discussion.ts | 待接入，按服务状态处理就绪与阻塞 | requirement-workflow 的确认流程，缺真实问答质量证据 | Flash 和结构化评估 · 核对关键澄清与充分输入 |
| FR-38 | B · 可审阅确认卡及继续调整 | C/requirement-discussion.tsx、C/requirement-input.tsx | 待验收，有事实/建议/来源分组与自然语言调整 | requirement-workflow 中未提交文本会禁用旧确认 | 摘要修订、授权来源 · 真链路核对更新与冲突 |
| FR-39 | B · 确认需求并生成 | S/use-requirement-discussion.ts、C/workspace.tsx | 待接入，确认绑定摘要、回执和派发恢复 | requirement-workflow 单次确认与刷新 | 原子冻结、CAS、幂等派发 · 对照执行记录 |
| FR-40 | B · 单 PRD、单原型及联合作品 | C/workspace.tsx、C/project-views.tsx、C/document-view.tsx | 待接入，路由、来源关系与分项结果可呈现 | requirement-workflow 三路径，历史和关系专项 | 同一冻结基线、逐项操作和固定版本 · 真产物逐项核对 |
| FR-41 | B · 持久讨论、冲突与恢复原动作 | S/use-requirement-discussion.ts、C/requirement-sessions.tsx | 待验收，待提交动作与同键恢复已接 | requirement-workflow 重载，真实权限专项 | 会话分页、CAS、幂等回执 · 真双标签及丢响应 |
| FR-42 | B · 当前生成期间保存后续要求 | C/workspace.tsx、S/use-requirement-discussion.ts | 待验收，有当前与后续边界提示 | requirement-workflow 的追加不启动另一 Run | 冻结确认、后续讨论、取消/重试 · 真流程跨刷新 |
| FR-43 | B · 依据、适用范围和冲突提示 | C/requirement-discussion.tsx、S/requirement-view-adapter.ts | 待接入，按服务区分来源范围和缺口 | 卡片受控响应与组件专项 | 已发布知识检索及权限 · 真缺口/冲突/区域/撤权四类 |
| FR-44 | B · 正式需求 API、错误恢复与知识依据 | S/requirement-api.ts、S/requirement-view-adapter.ts、C/workspace.tsx | 待接入，正式合同 UI 已接。统一运行和真实验收未完成 | 真实权限专项，以及标注受控的浏览器确认流程 | 固定 OpenAPI、Flash、检索与存储 · 联调和最终集成 |

## 验收标准

| 验收 | 新界面操作 · 代码入口 | 当前状态与可操作证据 | 服务依赖 · 余下动作 |
|---|---|---|---|
| AC-01 | 项目舞台收放两侧 · C/onlook/main.tsx | 待验收。综合浏览器已测默认主区 95.8% | bootstrap · 当前候选截图 |
| AC-02 | 项目左栏、面板与交付菜单 · C/workspace.tsx | 待验收。综合浏览器 7 视图 4 面板可达 | 各业务接口 · 实际逐项操作 |
| AC-03 | 展开面板、长输入与页面底部 · C/composer.tsx | 待验收。综合浏览器验证居中与底部可达 | 无 · 当前构建录像 |
| AC-04 | 附件/资料/模型/设计引用 · S/use-input-preparation.ts | 待接入。受控请求与分页恢复已验证 | 存储/来源权限 · 核对真实请求引用 |
| AC-05 | 普通修改、元素修改、新建和中文输入 · C/workspace.tsx | 待验收。固定上下文与草稿专项，IME 受控 | 版本及需求 API · 真元素修改 |
| AC-06 | 确认卡及重复点击 · C/requirement-discussion.tsx | 待接入。受控单次确认通过 | CAS / 派发 · 实际 Run 验一次确认 |
| AC-07 | 展开运行阶段 · C/workspace.tsx | 待接入。SSE 受控阶段投影 | 实际阶段事件 · 录屏核对阶段与时间 |
| AC-08 | 页面舞台观察真实生成 · C/draft-projection.tsx | 待接入。受控动效可操作，真实变化待取得 | Flash、Worker · 两次真实画面与事件 |
| AC-09 | 草稿切页、节点更新及窗口外页 · C/page-stage.tsx | 待验收。studio-stage-a 已操作旧页跳入首批草稿、窗口边界及动效选择 | 投影窗口 · 真实生成复核范围与计数 |
| AC-10 | 从草稿到冻结预览 · C/workspace.tsx、C/page-stage.tsx | 待接入。studio-stage-a 受控 SSE 刷新后成功交接到冻结 iframe 同页 | 真实 Run 与冻结原型 · 核对页面和可保留视口连续 |
| AC-11 | 生成中刷新、断线及直达 · S/run.ts | 待验收。受控恢复与事件去重 | Run snapshot/SSE · 真端到端恢复 |
| AC-12 | 迟到或重复事件并切项目 · S/run.ts | 待验收。综合浏览器双项目、事件专项 | 相同候选的 Run 事件 · 缺口及旧 attempt 实验 |
| AC-13 | 停止、失败、从原输入重试 · C/workspace.tsx | 待接入。固定 Plan 重试入口已接 | 取消及待办回执 · 真排队、运行、终态 |
| AC-14 | 总览搜索并进入 50 页 · C/page-stage.tsx | 待验收。综合浏览器已有 50 页样本与 P95 | 冻结样本 · 当前构建复跑及视图恢复 |
| AC-15 | 在最终 iframe 输入、提交、切页 · C/page-stage.tsx | 待接入。受控表单、公开页实际浏览器交互 | 生成出的完整有效 HTML · 真场景录屏 |
| AC-16 | 选择、图层、父级及 Esc · C/page-stage.tsx | 待验收。综合浏览器 Escape，visual-workspace 锚点选择 | 节点协议 · 当前候选全键盘 |
| AC-17 | 尺寸、滚动、缩放与 DPR · C/geometry-bridge.ts | 待验收。综合浏览器 DPR 2 ≤2 px | iframe · 浏览器差异与无效节点清理 |
| AC-18 | 版本/元素批注及丢响应后重试 · C/workspace.tsx | 待验收。有固定锚点和受控恢复 | 批注与冻结节点 · 真新版本删节点 |
| AC-19 | 部分批注修订与并发 · C/workspace.tsx | 待接入。有上限与冲突处理 | 权威批注状态、冻结引用 · 真并发、源内容 hash |
| AC-20 | 查看差异、确认/驳回与历史页 · C/workspace.tsx | 待验收。lifecycle 与差异局部检查 | 版本审核、冻结 · 实际迭代及查看不抢切 |
| AC-21 | 三种输出与文档/原型关联 · C/project-views.tsx | 待接入。requirement-workflow 三种路由 | Flash、产物、冻结关系 · 验分项失败 |
| AC-22 | 失效资料、模型或设计选项 · C/context-library.tsx | 待接入。资料失败、来源分页、模型/设计恢复 | 解析、授权、模型目录 · 真实故障 |
| AC-23 | 创建、访问、撤销、到期和无效链接 · C/public-prototype.tsx | 待接入。swarm-public 有受控匿名与失效操作 | 分享实际凭据 · 真自然到期及无私人读取 |
| AC-24 | 交付面板下载 HTML/React · C/actions.tsx | 待接入。当前有校验逻辑及真实验收入口 | S3/Export Worker · 字节、hash、安装、构建与交互 |
| AC-25 | 交付面板 · C/project-publishing.tsx | FE-L015 组件回归通过。三种终态均能抵御迟到活动页，关闭并重新进入面板仍正确，新 ID 可独立取消 | Worker 清理确认、真实导出文件与重试链路继续验收 |
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
| AC-37 | 各发一条简短及充分需求 · C/requirement-discussion.tsx | 待接入。受控普通发送无 Run | Flash/检索 · 核对是否只问影响业务的问题 |
| AC-38 | 活动字段和规则局部扩展 · C/requirement-discussion.tsx | 待接入。固定依据与改动分组已渲染 | 已发布知识 · 真局部改造及无关能力保留 |
| AC-39 | 新功能与平台成本提案 · C/requirement-discussion.tsx | 待接入。平台范围显式授权门禁已接 | 平台能力检索 · 真新增模块归属 |
| AC-40 | 缺失/冲突/区域/受限依据 · S/requirement-view-adapter.ts | 待接入。有结构化结果映射 | 真实发布知识各类样本 · 逐项核对范围与阻塞 |
| AC-41 | 修改描述、切换输出或追加资料后核对旧卡 · C/workspace.tsx | 待验收。dirty 输入与 CAS 受控回归 | 真实摘要版本 · 验新卡差异与旧确认失效 |
| AC-42 | 分别确认三种产物 · S/use-requirement-discussion.ts | 待接入。浏览器受控路径通过 | 冻结基线与知识版本 · 真实逐条核对 |
| AC-43 | 同一消息/确认重复、丢回执和刷新 · S/use-requirement-discussion.ts | 待验收。持久动作与重放有局部证据 | 权威幂等回执 · 真HTTP 丢响应 |
| AC-44 | 双标签 CAS、角色和资料范围 · S/project-access.ts、S/use-requirement-discussion.ts | 待验收。真实撤权/草稿；受控 CAS | 同候选真双标签和授权来源拒绝 |
| AC-45 | 生成中续写、停止/重试并确认后续 · C/workspace.tsx | 待接入。受控追加不会启动下一 Run | 真实取消、重试与后续确认 · 核对冻结内容 |
| AC-46 | 成品对照确认卡与知识发布历史 · C/document-view.tsx、C/relations.tsx | 待接入。现有关系可导航，真实语义待核对 | 两种真实产物 · 对比增量规则与出典 |
| AC-47 | 小屏讨论、分页、IME 与键盘 · C/requirement-input.tsx、C/composer.tsx | 390×480 缩短视口已测，聚焦可继续输入并保留草稿区。单会话 keyset 分页真实 HTTP 已测 | 实际移动软键盘、VoiceOver 与长讨论全键盘操作待验证 |
| AC-48 | 实际检索/模型失败、重连和三种输出 · S/requirement-api.ts | 待接入。前端走正式服务端接口。当前缺真实生成证据 | 唯一 Flash、检索与依赖 · 真失败恢复 |
| AC-49 | 从真实生成到四类文件交付 · C/workspace.tsx、C/project-publishing.tsx | 待接入。受控舞台及局部访问证据已取得 | Flash、Worker、存储 · 真模型持续变化、最终交互及导出检查 |
| AC-50 | 对照服务、Web、GitHub 身份 · S/requirement-api.ts、lib/workbench/api/schema.d.ts | 待接入。导出取消 OpenAPI 已同步并通过生成校验。统一运行和全量验收待完成 | 固定源树/运行证明 · 随联合候选验收与集成交付 |

## 当前工作顺序

1. A 已验证草稿首屏、切页、窗口边界、动效和冻结交接。生成期间空闲讨论区与窄屏设置已收起，剩余真模型与实际设备复核。
2. B 联验讨论就绪、确认摘要、后续要求与运行恢复。C 补看页、差异、几何、批注及冻结版本的操作链。
3. D 从新入口完成真实资料、文档、媒体和交付。E 汇总 Safari、VoiceOver、移动软键盘与固定候选性能。现有本地访问实测与受控 UI 证据分别保留。
