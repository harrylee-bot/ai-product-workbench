# 可视化原型 V2 后端实施账本

基线为[本地正式 PRD 1.3](visual-prototype-frontend-rebuild-requirements.md)。本文记录服务入口、实现合同与固定候选的核对操作。执行结果、证据边界、待验项和发布状态见[现行审计](../audit/1.0.0.md)，Studio 操作见[前端实施账本](frontend-rebuild-delivery-plan.md)。

## 服务入口

| 领域 | 执行职责 | 源码 | 对应用例 |
| --- | --- | --- | --- |
| 项目 | 项目、角色与启动快照 | [apps/workbench-api/src/modules/projects/projects.service.ts](../../apps/workbench-api/src/modules/projects/projects.service.ts) | [projects.postgres.spec.ts](../../apps/workbench-api/test/projects.postgres.spec.ts) |
| 需求 | 讨论、会话消息分页、幂等、摘要和确认 | [HTTP 控制器](../../apps/workbench-api/src/modules/requirements/requirements.controller.ts)、[需求服务](../../apps/workbench-api/src/modules/requirements/requirements.service.ts) | [requirements-http.postgres.spec.ts](../../apps/workbench-api/test/requirements-http.postgres.spec.ts) |
| 依据 | 当前发布、权限、检索与知识引用 | [apps/workbench-api/src/modules/requirements/requirement-knowledge.ts](../../apps/workbench-api/src/modules/requirements/requirement-knowledge.ts) | [knowledge-retrieval.postgres.spec.ts](../../apps/workbench-api/test/knowledge-retrieval.postgres.spec.ts) |
| 分析 | 结构化 Flash 分析。配置名 `deepseek-4.1-flash` 映射到唯一允许的请求模型 ID `deepseek-flash` | [需求分析执行器](../../apps/workbench-api/src/modules/requirements/requirements.processor.ts)、[模型约束](../../apps/workbench-api/src/modules/requirements/requirement-model.ts) | [requirement-model.spec.ts](../../apps/workbench-api/test/requirement-model.spec.ts) |
| 门禁 | 生成前确认、冻结请求和派发 | [apps/workbench-api/src/modules/requirements/requirement-generation-gate.ts](../../apps/workbench-api/src/modules/requirements/requirement-generation-gate.ts) | [requirements.postgres.spec.ts](../../apps/workbench-api/test/requirements.postgres.spec.ts) |
| 原型 | 计划、版本、批注、冻结和交付 | [apps/workbench-api/src/modules/prototypes/prototype-v2.service.ts](../../apps/workbench-api/src/modules/prototypes/prototype-v2.service.ts) | [prototype-v2.postgres.spec.ts](../../apps/workbench-api/test/prototype-v2.postgres.spec.ts) |
| 事件 | 事件游标、重放和运行进度 | [apps/workbench-api/src/modules/runs/run-event.store.ts](../../apps/workbench-api/src/modules/runs/run-event.store.ts) | [run-event-stream.service.spec.ts](../../apps/workbench-api/test/run-event-stream.service.spec.ts) |
| 生成 | Runtime 与中间草稿回传 | [apps/workbench-worker/src/prototypes/prototype-runtime-bridge.ts](../../apps/workbench-worker/src/prototypes/prototype-runtime-bridge.ts) | [prototype-progress.spec.ts](../../apps/workbench-api/test/prototype-progress.spec.ts) |
| 预览 | 固定版本预览和资源读取 | [apps/workbench-api/src/modules/prototypes/prototype-artifact-storage.reader.ts](../../apps/workbench-api/src/modules/prototypes/prototype-artifact-storage.reader.ts) | [prototype-artifact-preview.postgres.spec.ts](../../apps/workbench-api/test/prototype-artifact-preview.postgres.spec.ts) |
| 运行 | 运行、审批、重试和取消 | [apps/workbench-api/src/modules/runs/runs.service.ts](../../apps/workbench-api/src/modules/runs/runs.service.ts) | [run-approval.spec.ts](../../apps/workbench-api/test/run-approval.spec.ts) |
| 定位 | 版本范围内解析页面和锚点 | [apps/workbench-api/src/modules/prototypes/prototype-feedback-location.ts](../../apps/workbench-api/src/modules/prototypes/prototype-feedback-location.ts) | [prototype-feedback-location.spec.ts](../../apps/workbench-api/test/prototype-feedback-location.spec.ts) |
| 差异 | 相对指定来源版本的差异 | [apps/workbench-api/src/modules/prototypes/prototype-revision-diff.ts](../../apps/workbench-api/src/modules/prototypes/prototype-revision-diff.ts) | [prototype-revision-diff.spec.ts](../../apps/workbench-api/test/prototype-revision-diff.spec.ts) |
| 关系 | PRD 和原型版本关系 | [apps/workbench-api/src/modules/artifacts/artifact-links.service.ts](../../apps/workbench-api/src/modules/artifacts/artifact-links.service.ts) | [prototype-prd-relations-migration.postgres.spec.ts](../../apps/workbench-api/test/prototype-prd-relations-migration.postgres.spec.ts) |
| 资料 | 文件、导入上下文和引用 | [apps/workbench-api/src/modules/import-sources/import-sources.service.ts](../../apps/workbench-api/src/modules/import-sources/import-sources.service.ts) | [files.service.spec.ts](../../apps/workbench-api/test/files.service.spec.ts) |
| 分享 | 固定版本、匿名读取、撤销和过期 | [apps/workbench-api/src/modules/shares/shares.service.ts](../../apps/workbench-api/src/modules/shares/shares.service.ts) | [shares.postgres.spec.ts](../../apps/workbench-api/test/shares.postgres.spec.ts) |
| 导出 | 导出执行、文件身份与取消 | [apps/workbench-export-worker/src/export/export.processor.ts](../../apps/workbench-export-worker/src/export/export.processor.ts) | [export-worker-processes.postgres.spec.ts](../../apps/workbench-api/test/export-worker-processes.postgres.spec.ts) |
| 账户 | 邀请和成员资格 | [apps/workbench-api/src/modules/projects/project-invitations.service.ts](../../apps/workbench-api/src/modules/projects/project-invitations.service.ts) | [project-invitations.postgres.spec.ts](../../apps/workbench-api/test/project-invitations.postgres.spec.ts) |
| 权限 | 身份、成员资格和项目范围 | [apps/workbench-api/src/modules/access/access.service.ts](../../apps/workbench-api/src/modules/access/access.service.ts) | [requirements-http.postgres.spec.ts](../../apps/workbench-api/test/requirements-http.postgres.spec.ts) |
| 合同 | OpenAPI 路由、响应与前后端共同类型 | [packages/workbench-contracts/src/http-routes.ts](../../packages/workbench-contracts/src/http-routes.ts) | 参见前端实施账本与合同验证 |
| 前端 | Studio 舞台和本机交互，服务依赖列在同行 | [apps/web/components/studio/workspace.tsx](../../apps/web/components/studio/workspace.tsx) | 参见前端实施账本与合同验证 |

## 导出取消与迁移合同

| 范围 | 持久化合同与入口 | 可重跑的验收 |
| --- | --- | --- |
| BE-012 · 跨 Worker 执行租约 | [导出 API](../../apps/workbench-api/src/modules/exports/exports.service.ts)按项目写权限和 revision 接受取消，将任务写为 `cancelling` 并在同一事务登记取消队列。[执行器](../../apps/workbench-export-worker/src/export/export.processor.ts)通过 PostgreSQL 持有和续约执行租约，将同一取消信号传给浏览器、构建和上传。[存储层](../../apps/workbench-export-worker/src/export/export.store.ts)以租约令牌约束提交。续租只更新内部字段。 | 重跑[执行器回归](../../apps/workbench-export-worker/test/export.processor.spec.ts)和[双连接 fencing 回归](../../apps/workbench-export-worker/test/export-fencing.postgres.spec.ts)，验证旧持有者无法续租和提交成功或失败，并核对公开 revision 与终态。 |
| BE-013 · 清理完成后确认取消 | Worker 按执行租约记录资源占用。[资源占用迁移](../../packages/workbench-db/prisma/migrations/20261118140000_export_active_resources/migration.sql)支持跨进程读取。即使执行租约自然过期，其他取消消费者仍需等待旧持有者清理浏览器、上传和对象预留，资源释放后才能确认 `cancelled`。排队但从未执行的任务可由取消消费者确认；共享对象由预留和 Blob GC 协调。 | 重跑[双进程 PgBoss 回归](../../apps/workbench-api/test/export-worker-processes.postgres.spec.ts)和[共享对象回归](../../apps/workbench-export-worker/test/s3-export-shared-cancellation.postgres.spec.ts)。分别验证活动及自然过期租约、暂停时仍开放的上传、清理屏障及取消队列事务回滚。 |
| BE-014 · 保留原第 99 号迁移 | [原始 SQL](../../packages/workbench-db/prisma/migrations/20261118110000_export_job_execution_leases/migration.sql)固定 SHA-256 `20a1e8961f949616cc972e18f4d745a7f4e8bec13a5884151be2cf6cea1f7a26`。[迁移入口](../../scripts/deploy-workbench-migrations.mjs)用 PostgreSQL advisory lock 串行部署。若 #99 尚未登记，在单个事务中回填历史 `cancelling` 所需时间，以原校验和登记 #99，再执行前向迁移；已登记原 #99 的库直接走前向迁移。 | 重跑[带历史数据的升级用例](../../apps/workbench-export-worker/test/export-upgrade.postgres.spec.ts)和[迁移合同](../../scripts/workbench-migration-contract.test.mjs)。分别从 98 和已应用原版 99 升级，覆盖六种历史导出状态及 Prisma 记录；模拟历史回填提交后登记失败及两个部署程序竞争重试。 |

## 功能需求

| 编号 | 功能 | 涉及领域 | 实施合同与验证操作 |
| --- | --- | --- | --- |
| FR-01 | 统一项目工作区 | 项目、前端 | 已有上表服务或界面入口，须在固定候选执行下表对应操作 |
| FR-02 | 参考视频对应的视觉语言 | 前端、预览 | 已有上表服务或界面入口，须在固定候选执行下表对应操作 |
| FR-03 | 新信息架构中的完整产品功能 | 项目、账户、运行、导出 | 已有上表服务或界面入口，须在固定候选执行下表对应操作 |
| FR-04 | 底部中央 Composer | 前端、需求 | 见前端 Composer 合同。展开/收起讨论面板并以缩短视口聚焦，核对草稿可见性与底部安全区 |
| FR-05 | 完整保留输入能力 | 资料、需求、门禁 | 已有上表服务或界面入口，须在固定候选执行下表对应操作 |
| FR-06 | 新建与修改意图 | 原型、需求、门禁 | 已有上表服务或界面入口，须在固定候选执行下表对应操作 |
| FR-07 | 对话记录与生成期间输入 | 需求、事件 | `GET /requirement-sessions/{sessionId}/messages` 按授权账号与会话绑定 sequence 游标；交错会话并在翻页中追加，核对刷新后独立历史和冻结基线 |
| FR-08 | 可审阅计划 | 需求、分析、门禁 | 已有上表服务或界面入口，须在固定候选执行下表对应操作 |
| FR-09 | 真实进度条与阶段说明 | 事件、运行 | 已有上表服务或界面入口，须在固定候选执行下表对应操作 |
| FR-10 | 生成过程中的页面展示 | 生成、事件 | Worker 按运行作用域回传真实 Flash 草稿。对照终态前至少两次可见变化、数据库事件序号及冻结产物 |
| FR-11 | 页面、图层与当前处理位置 | 生成、事件、定位 | 已有上表服务或界面入口，须在固定候选执行下表对应操作 |
| FR-12 | 草稿覆盖范围与最终切换 | 事件、预览、原型 | 已有上表服务或界面入口，须在固定候选执行下表对应操作 |
| FR-13 | 恢复、断线与事件一致性 | 事件、运行 | 真实 HTTP SSE 由授权快照与持久游标续接。中断流后重取快照，核对缺口、旧 attempt 以及终态 |
| FR-14 | 取消、失败、重试与审批等待 | 运行、原型 | 正式 Plan/Run 提交停止并等待清理，按冻结请求重试；分别核对排队取消、执行取消与基础设施中断恢复 |
| FR-15 | 多页面目录与总览 | 原型、预览 | 已有上表服务或界面入口，须在固定候选执行下表对应操作 |
| FR-16 | 视口、缩放与移动 | 前端、预览 | 已有上表服务或界面入口，须在固定候选执行下表对应操作 |
| FR-17 | 浏览模式 | 预览、原型 | 已有上表服务或界面入口，须在固定候选执行下表对应操作 |
| FR-18 | 选择模式与图层定位 | 前端、定位 | 已有上表服务或界面入口，须在固定候选执行下表对应操作 |
| FR-19 | 几何定位与覆盖层 | 前端、定位 | 预览经沙箱消息桥返回定位。比较 Chromium/WebKit 在不同 DPR、滚动和缩放条件的覆盖层，另复核原生浏览器 |
| FR-20 | 元素批注与普通批注 | 原型、定位 | 已有上表服务或界面入口，须在固定候选执行下表对应操作 |
| FR-21 | 批注驱动修改 | 原型、需求、门禁 | 已有上表服务或界面入口，须在固定候选执行下表对应操作 |
| FR-22 | 版本历史与差异 | 原型、差异 | 已有上表服务或界面入口，须在固定候选执行下表对应操作 |
| FR-23 | 确认、驳回与冻结版本 | 原型、预览 | 已有上表服务或界面入口，须在固定候选执行下表对应操作 |
| FR-24 | 需求文档与原型关联 | 关系、运行 | 已有上表服务或界面入口，须在固定候选执行下表对应操作 |
| FR-25 | 文件、导入源、知识与设计上下文 | 资料、依据 | 资料与推理检索需对账已发布 release |
| FR-26 | 分享与公开访问 | 分享、权限 | 已有上表服务或界面入口，须在固定候选执行下表对应操作 |
| FR-27 | HTML / React 导出 | 原型、导出 | 按固定版本请求 HTML/React，再核对下载字节、SHA-256 与独立运行；取消和升级合同见 BE-012 至 BE-014 |
| FR-28 | 项目、账户、运行与发布入口 | 账户、项目、运行 | 已有上表服务或界面入口，须在固定候选执行下表对应操作 |
| FR-29 | 加载、空态、失败与冲突 | 权限、合同 | 已有上表服务或界面入口，须在固定候选执行下表对应操作 |
| FR-30 | 响应式布局 | 前端 | 以规定视口与缩短可视高度操作输入及交付，实际移动软键盘复核见现行审计 |
| FR-31 | 键盘、读屏和减弱动画 | 前端、事件 | 沿键盘顺序确认焦点、通知和减弱动画下的操作；以实际 VoiceOver 和 Safari 核对 |
| FR-32 | 页面与上下文恢复 | 项目、需求、权限 | 已有上表服务或界面入口，须在固定候选执行下表对应操作 |
| FR-33 | 全新前端架构与旧实现退出 | 前端、合同 | 已有上表服务或界面入口，须在固定候选执行下表对应操作 |
| FR-34 | 开源应用基线与二次开发 | 前端、预览 | 已有上表服务或界面入口，须在固定候选执行下表对应操作 |
| FR-35 | 普通发送先交流需求 | 需求、分析 | 正式 Flash 分析按讨论回合执行。普通发送核对零 Run，再以显式确认触发生成 |
| FR-36 | 平台能力依据与增量边界 | 依据、分析 | 已有上表服务或界面入口，须在固定候选执行下表对应操作 |
| FR-37 | 少量关键澄清与结构化就绪 | 分析、需求 | 已有上表服务或界面入口，须在固定候选执行下表对应操作 |
| FR-38 | 可审阅的增量改动确认卡 | 需求、依据 | 已有上表服务或界面入口，须在固定候选执行下表对应操作 |
| FR-39 | 一次显式确认与不可变基线 | 门禁、需求 | 以真实摘要版本与校验值建立一次不可变确认，重放动作并核对冻结基线、派发和 Run |
| FR-40 | 三种产物共用需求基线 | 门禁、关系、生成 | 已有上表服务或界面入口，须在固定候选执行下表对应操作 |
| FR-41 | 讨论、确认与并发恢复 | 需求、门禁、权限 | 会话归属、分页和幂等恢复采用正式合同；在双标签下比较过期请求、回执重放及原运行 |
| FR-42 | 生成期间追加需求 | 需求、门禁、事件 | 新要求另存讨论回合。比较实际生成中的追加、刷新及重试前后稳定的确认和冻结输入 |
| FR-43 | 知识缺口、冲突与范围呈现 | 依据、权限、分析 | 已有上表服务或界面入口，须在固定候选执行下表对应操作 |
| FR-44 | 前后端分工与真实接入边界 | 合同、需求、生成 | 正式需求 API、发布知识检索和 Flash 分析均已接入；Run、Runtime 及冻结产物按正式合同回读。联验范围见现行审计 |

## 验收操作

| 编号 | 关联需求 | 服务落点 | 固定候选的验收操作 |
| --- | --- | --- | --- |
| AC-01 | FR-01、FR-02 | 项目、前端、预览 | 同一项目查看桌面默认、展开目录、展开工具面板 |
| AC-02 | FR-03、FR-28 | 项目、账户、运行、导出 | 按产品能力清单逐项完成新界面中的操作 |
| AC-03 | FR-04 | 前端、需求 | 展开两侧面板、输入长文本、滚到页面底部 |
| AC-04 | FR-05 | 资料、需求、门禁 | 分别使用已有附件、导入、模型和设计上下文 |
| AC-05 | FR-06、FR-07 | 原型、需求、门禁、事件 | 普通文字修改、元素上下文修改、新建计划；中文输入 |
| AC-06 | FR-08、FR-39 | 需求、分析、门禁 | 查看改动卡、单次确认与重复点击 |
| AC-07 | FR-09 | 事件、运行 | 实际生成包含多个阶段、未知总量 |
| AC-08 | FR-10 | 生成、事件 | 真实模型与服务生成代表性多页面原型 |
| AC-09 | FR-11、FR-12 | 生成、事件、定位、预览、原型 | 节点重复更新、页面级更新、部分投影、投影外页面 |
| AC-10 | FR-12、FR-17 | 事件、预览、原型 | 中间草稿转最终版本 |
| AC-11 | FR-13、FR-32 | 事件、运行、项目、需求、权限 | 生成中刷新、断网重连、直接打开链接 |
| AC-12 | FR-13 | 事件、运行 | 注入重复/缺口/旧 attempt 消息并切换项目 |
| AC-13 | FR-14、FR-29 | 运行、原型、权限、合同 | 排队与执行中取消、服务失败、重试、等待审批 |
| AC-14 | FR-15、FR-16 | 原型、预览、前端 | 50 页样例浏览、搜索、缩放、总览与单页往返 |
| AC-15 | FR-17 | 预览、原型 | 真实输入、下拉、复选、表单提交、弹层和跨页跳转 |
| AC-16 | FR-18 | 前端、定位 | 鼠标与键盘选择元素、父级和图层，退出选择 |
| AC-17 | FR-19 | 前端、定位 | 内页滚动、舞台缩放、浏览器缩放、不同 DPR 与 resize |
| AC-18 | FR-20 | 原型、定位 | 元素/普通批注、请求重试、新产品版本迭代后节点不存在 |
| AC-19 | FR-21 | 原型、需求、门禁 | 选部分批注修订、超限、并发解决批注 |
| AC-20 | FR-22、FR-23 | 原型、差异、预览 | 历史版本、差异、确认/驳回、后台新结果到达 |
| AC-21 | FR-24 | 关系、运行 | 分别执行仅 PRD、仅原型、默认联合输出 |
| AC-22 | FR-25 | 资料、依据 | 资料解析失败/删除/无权限，模型/预设不可用 |
| AC-23 | FR-26 | 分享、权限 | 创建分享、匿名访问、撤销、过期和无效 token |
| AC-24 | FR-27 | 原型、导出 | HTML 与 React 实际下载并验证文件 |
| AC-25 | FR-27 | 原型、导出 | 导出排队/构建中取消、失败重试 |
| AC-26 | FR-28、FR-32 | 账户、项目、运行、需求、权限 | 新登录/注册/邀请/分享路由，直接访问、刷新及前进后退 |
| AC-27 | FR-29 | 权限、合同 | 分别触发加载失败、无权限、过期、并发冲突 |
| AC-28 | FR-30 | 前端 | 五个规定视口与手机软键盘 |
| AC-29 | FR-31 | 前端、事件 | 全键盘、读屏重点流程、200% 缩放和减弱动画 |
| AC-30 | FR-32 | 项目、需求、权限 | 两个项目、两个版本、退出登录再进入 |
| AC-31 | 第 4、6 章 | 权限、事件 | viewer、非成员、跨项目 ID、匿名访问进度接口 |
| AC-32 | FR-19、第 4.5 节 | 前端、定位 | 伪造 frame 消息、旧会话、异常坐标、外部请求 |
| AC-33 | 第 6.1 节 | 事件、生成、前端 | 固定提交、设备与样本执行性能场景 |
| AC-34 | 第 8 章 | 事件、定位、导出 | 事件流/几何/缩略图/导出分别故障 |
| AC-35 | FR-01、FR-03、FR-33 | 项目、前端、账户、运行、导出、合同 | 从新应用入口启动并完成资料、文档、运行、生成、版本与交付流程；检查路由与产物依赖 |
| AC-36 | FR-34 | 前端、预览 | 核查上游仓库/提交/许可证、实际复用的核心模块、二次开发差异、构建与业务接入 |
| AC-37 | FR-35、FR-37 | 需求、分析 | 分别提交一句简短目标和业务信息充分的需求 |
| AC-38 | FR-36、FR-38 | 依据、分析、需求 | 基于已有活动做字段/规则局部扩展 |
| AC-39 | FR-36、FR-37 | 依据、分析、需求 | 提交确需新增的业务能力和平台级改造建议 |
| AC-40 | FR-37、FR-43 | 分析、需求、依据、权限 | 缺失知识、来源冲突、区域规则、受限资料 |
| AC-41 | FR-38、FR-39 | 需求、依据、门禁 | 卡片含模型建议，用户自然语言调整、切换产物或新增资料后点击旧确认 |
| AC-42 | FR-39、FR-40 | 门禁、需求、关系、生成 | 联合、仅文档、仅原型分别显式确认生成 |
| AC-43 | FR-41 | 需求、门禁、权限 | 同一消息/确认快速重复、服务已接收后丢响应，再刷新恢复 |
| AC-44 | FR-41、FR-43 | 需求、门禁、权限、依据、分析 | 两标签并发改动、viewer、非成员、跨项目/跨账户及直接链接访问 |
| AC-45 | FR-42 | 需求、门禁、事件 | 生成时发送新要求、刷新、停止/重试，再确认后续需求 |
| AC-46 | FR-40、FR-43 | 门禁、关系、生成、依据、权限、分析 | 对照实际 PRD/原型与确认卡、来源 release 历史 |
| AC-47 | FR-35、FR-38、FR-41 | 需求、分析、依据、门禁、权限 | 小屏、长讨论、历史分页、输入法与全键盘完成澄清/确认/恢复 |
| AC-48 | FR-44 | 合同、需求、生成 | 实际检索与模型失败、重连和真实三种输出 |
| AC-49 | FR-10、FR-27、FR-40 | 生成、事件、原型、导出、门禁、关系 | 新流程真实生成到交付及性能/可访问性全量回归 |
| AC-50 | FR-44、第 4.7 节 | 合同、需求、生成 | 对照固定后端合同提交、前端实现和 GitHub 源码身份 |
