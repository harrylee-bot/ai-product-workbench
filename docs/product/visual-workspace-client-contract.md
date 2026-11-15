# Studio 客户端合同

代码基线：`aa7700cd20653dd11bccf22b841ded54e315527e`。应用版本为 1.0.0。执行结果只记入 `docs/audit/1.0.0.md`。

## 开源来源与应用边界

编辑器前端二开自 Onlook（Apache-2.0），固定提交 `423e2e924366419e418ee049093872d535eea41a`。原始文件、SHA-256、许可证、修改范围和维护方式见 `third_party/onlook/`；`npm run studio:source-check` 校验来源。实际复用包括 Main、DesignPanel、Canvas、几何框、ChatInput、项目卡片、设备目录与尺寸输入。不运行完整 Onlook 云应用，不引入其账号、Supabase、计费或生成编排。

项目首页由 StudioHome 承载；项目路径为 `/studio/:projectId`。URL 使用 `plan`、`revision`、`page`、`view`，不识别旧 query。底部对话框、中央舞台、互斥工具面板均属于新组件树。业务服务从 `lib/studio/api.ts` 接入已有授权 API；不挂载旧 WorkbenchRuntime、React Flow 画布或旧产物组件。依赖检查禁止它们进入新应用模块图。

页面、文档、资料、知识、运行、发布和项目设置使用新导航。视口尺寸按用户／项目保存在 sessionStorage。Composer 的可见意图、固定提交目标、文字、模型、终端、输出、设计与资料引用按账户／项目保存在 IndexedDB，并分别保留新建、调整计划、修改源版本、完善产物的草稿；退出账户清理两种私有缓存。未上传附件仅持久化文件元数据，文件字节只在当前页面内存中；刷新后须重新选择或移除，未恢复前禁止提交。上传准备成功后替换为授权 sourceId。生成版本和上传文件仍由服务端管理，临时对象 URL 不作持久引用。预览尺寸不改变生成目标终端。

## 授权进度

`GET projects/:projectId/prototype-v2/plans/:planId/progress` 沿用项目 viewer 权限与 Run SSE。响应包含项目、计划、输入摘要、显式绑定的 Run、快照游标、有界事件投影和最终 revisionId。未绑定 Run 时返回 null，客户端不猜测。事务隔离为 RepeatableRead；事件不得超过快照序列，只选择当前 attempt 的最新页面投影、草稿元数据、阶段及活动，最多 64 条。

重连或缺口先读取权威快照，再从其游标接续 `runs/:runId/events`。重复序列丢弃，旧 attempt 不覆盖当前内容；项目／计划／运行身份同时校验，401/403 清理投影。窗口快照是状态种子，不按完整历史事件重放。

中间预览最多 4 页、每页 120 节点，`coverage=window`，窗口外页面不等于删除。已见页面保留在目录中，超出当前窗口明确显示暂无中间预览。节点计数只针对当前投影去重；只有实际内容变化才高亮该页面。最终 Revision 支持最多 50 页，单页预览只有一个活动 iframe，总览使用惰性静态缩略图。

## 选择与测量

新协议 `workbench.studio.frame.v1` 包含 sessionId、revisionId、pageId、单调 sequence、事件种类和有界节点几何。节点必须有稳定的 `data-wb-node`，页面使用 `data-wb-screen`，不通过旧属性、DOM 路径或相似文本回退定位。消息源必须是当前 iframe.contentWindow，且为 opaque origin。

坐标来自 iframe 内的真实 getBoundingClientRect，单位为 CSS px；覆盖层和 iframe 共用 Onlook Canvas 变换。滚动、resize、节点变更经 requestAnimationFrame 合并；无效节点清除覆盖框。客户端拒绝非有限坐标、越界尺寸、超过 120 项图层或身份不匹配的消息。

桥接只注入内存副本，不修改冻结字节和 SHA。iframe 仅有 allow-scripts、allow-forms，禁止 allow-same-origin、网络和跨 frame DOM 读取。浏览模式保持页面操作，选择模式阻止业务点击。消息不收集输入内容或密码。导出下载校验服务提供的字节数和 SHA-256。

## 当前服务边界与待收口项

业务反馈保存独立 `sourceRevisionId/pageId/nodeId` 锚点。`scope=node` 必须对应源 revision 文档中的同页稳定节点，`scope=page` 只绑定页面，null 表示整个版本；正文和锚点创建后不可改写。创建沿用服务幂等回执。旧 selector 仅通过一次性数据库迁移转换；不能明确转换的记录标记 unresolved，并保留正文和引文。运行时不再读取 selector。

`GET projects/:projectId/prototype-v2/revisions/:revisionId/feedback-locations?sourceRevisionId=...` 按项目 viewer 权限，在同一家族内对照来源批注与目标版本。状态为 resolved/missing/version；只有相同 pageId/nodeId 才定位，节点或页面消失、源文档不可解析时保留原文并返回明确缺失原因。跨版本比较不改变批注的归属；批量改稿须返回来源版本。只读成员可定位，不能创建或解决批注。

`feedback` 与 `feedback-locations` 都按 createdAt/id 降序进行有界游标分页，接受 limit（默认 50，最大 100）、status、pageId，返回 items/nextCursor；状态和页面筛选覆盖全部持久记录。游标固定项目、来源/目标版本及筛选条件，不能跨条件复用。界面提供加载更多、筛选与清空所选；选择跨分页/筛选保留，批量操作仍最多 100 条，服务重新校验未解决状态和源版本。保存成功切回当前版本的全部列表，新记录排在前面。保存失败保留正文；幂等意图按最终 revisionId/body/anchor 确定，相同请求复用键，明确更改范围/页面后创建新意图。定位请求只执行一次，不持续抢回用户随后选择的页面。

新增进度、完整输入合同、OpenAPI、API 控制器／服务和 `20261115100000_prototype_plan_input`、`20261115120000_prototype_feedback_nodes` 迁移必须随前端集成，不替换 Temporal／DeerFlow。真实模型至少两次中间变化、完整交付、所有业务能力和性能验收以审计中的逐项状态为准。fixture 与真实 PostgreSQL 接口测试不能代替模型和生产集成验收。

## 文档运行生命周期

纯文档和普通产物提交成功后，URL 的 `run` 固定被接受的 Run。新工作区直接读取 Run 快照、消费既有 SSE，并使用既有三秒权威快照核对；没有第二套任务编排。刷新只恢复，不重复提交。活动 Run（包括 waiting_input 与 cancelling）阻止再次发送，但不禁止编辑下一轮文字。终态刷新项目产物，文档视图按真实 `createdByRunId` 定位新成果；用户显式选择的历史文档不被替换。重试返回新 Run 时更新 URL 和跟踪对象，取消接受不等于已经停止。

待办和操作采用实时投影与快照中的较新状态。投影须匹配 project/run/request/thread，且 attempt 与序列不能落后。工作区与运行详情共享已有投影，不为同一详情重复启动事件订阅。失效资料仍保留可移除的引用条目；删除源会失效全部该项目资料查询，不清除输入文本。

## 完整输入与有来源的修改计划

令 `P = projects/:projectId/prototype-v2`。`GET P/plans/:planId/input` 返回授权的完整固定请求、资料/设计/知识快照及摘要 SHA；已绑定运行时读取该 Run 的权威输入。旧记录缺少快照时明确返回 null，不声称已经固定。

`POST P/plans/:planId/input` 使用 If-Match 与 Idempotency-Key，仅允许尚未绑定 Run 的 draft。调整包括需求、模型、终端、输出、资料与设计，保留 artifactTargets、generationIntent 和来源身份。快照与输入一次性保存；数据库限制执行中改写及任何来源身份变化。412/409 后保留所有本地调整，读取最新输入，用户核对后明确继续；不自动覆盖。

`GET P/revisions/:revisionId/input` 读取生成所选内容版本的实际计划/Run，而非始终取根计划。历史 `request` 原样保留；另返回服务归一化的 `modificationRequest`，明确 edit 操作与精确源产物目标。Composer 按该操作筛选模型，不改写历史输入，也不自动替换原模型；不兼容时保留并提示用户选择支持编辑的模型。刷新恢复保留操作上下文，旧缓存缺少操作上下文时须重新载入源版本。

`POST P/revisions/:revisionId/plans` 创建待审批修改计划，固定 rootPlanId、sourceRevisionId、内容版本、选定反馈；审批前不启动运行。新增资料须就绪并校验项目和 blob 清单，保留的资料/设计沿用源快照。服务将修改请求绑定为 edit 及该源版本的精确 prototype artifactVersion；基准已变化时返回冲突，不把修改附到其他版本。

浏览计划、版本或前后导航不改变正在编辑的提交目标，输入区始终显示固定来源。显式切换新计划或文档操作会暂存先前完整草稿，并提供恢复入口。提交分支直接来自同一上下文状态；异步加载来源期间输入的文字保留，已放弃上下文的迟到响应不抢回输入区。设计预设选择固定 id/version/checksum；失效设计或模型要求明确替换，只有确有服务端快照的原设计可以继续沿用。

## 固定 PRD 生成与持久版本关联

`generationIntent=prd-prototype|prd-flow` 采用 Generate，精确引用一个已保存的 PRD ArtifactVersion，screenIds 为空，输出仅为 prototype。`prdScreenPlan` 显式固定页面 id、标题和顺序；单屏恰好一页，多屏为 2–12 页且 id 唯一。普通 Generate 的源屏幕规则保持原合同。编辑源原型时归一化为 edit 并移除生成范围，不覆盖历史请求。

API 验证源 PRD 属于当前项目、已就绪且为有效内联 PRD v3。Worker 校验实际源字节的 checksum，将固定来源写入 prototype ArtifactVersion 的 sourcePrdVersionId；草稿及终态均核对输出屏幕 id/顺序，终态要求一个原型。PRD 当前版本后来改变不影响已保存的关联。

`GET artifacts/:artifactId/versions/:artifactVersionId/relations` 返回版本来源、精确 sourcePrd 和关联原型，按 createdAt/id 降序进行有界游标分页（默认 30、最大 100），游标绑定源版本。`GET P/revisions/:revisionId/relations` 通过 sourceArtifactVersionId 返回该修订的实际产物与 PRD 来源。项目成员权限适用，响应不含完整正文；历史无确定来源时明确 null，不按标题或时间猜测。

`GET runs/:runId/outputs` 返回该 Run 的分项产物状态及可导航的精确版本。ready 才提供可用成果入口；失败 Run 中已暂存但未发布的内容标为 unpublished，缺失输出标为 failed/cancelled。超过 20 个实际产物时 coverage=window，不能将截断之外解释为缺失。新文档 URL 使用 artifact/artifactVersion，运行 URL 使用 run；直接访问先核对项目归属，不退回其他文档或最近运行。

必须一并集成 `20261115140000_prototype_prd_relations` 迁移。它仅回填同项目、实际绑定 Run、相同内容版本与完全相同文档的唯一匹配；模糊或跨项目记录不回填。数据库阻止已记录源身份改写并验证固定 PRD 来源。客户端、合同、API、Worker、运行提示与校验器一起交付；本合同不表示真实模型或全部需求已验收。

## 项目管理与文档交付

项目成员区使用现有项目 CAS 合同执行角色变更、移除和添加工作区成员。仅所有者读取邀请与工作区候选并展示管理操作；最后一位所有者不可在界面降级或移除，最终权限和约束仍由服务验证。冲突后保留用户选择并读取最新项目修订号。

邀请按状态筛选并游标分页，展示待接受/已接受/已撤销/已过期。未配置邮件投递时明确提示复制链接；邀请 token 仅进入既有接受路由的 fragment，不写入 query。相同规范化邮箱与角色的失败重试复用动作键，创建/撤销后刷新项目修订号及列表。剪贴板不可用时提供可选择的链接文本。

发布与文档导出列表支持加载更多。项目级分享仅向所有者开放，从已就绪发布中精确选择一个原型版本，创建前说明新链接会替换原项目级链接。列表不伪造已丢失的 token；生成时展示实际链接，撤销后清除。原型修订的独立分享保持其自身权限与版本绑定。

文档导出按发布/产物版本创建，失败或取消后重新导出仍使用原请求；创建请求响应丢失时复用幂等键。取消接受与最终状态分别表达。下载必须通过服务元数据中的字节数与 SHA-256 校验，已离开的发布视图不触发迟到下载。普通 blob 产物原文件下载也校验这两个字段。真实 Word/PDF 内容验收另行记录。

媒体与关系/变体入口、上传/提交意图中断后的完整恢复等继续按业务能力清单验收，不挂载旧前端作为备用路径。

## 匿名分享状态与缓存

原型修订和项目发布分享均周期性重新校验公开 capability。任何校验错误优先于已有缓存内容，移除旧 iframe 或发布视图；不继续显示已撤销、过期或当前无法验证的内容。原型分享使用完整视口的独立 Studio 外壳，匿名页面不依赖登录后布局提供高度，也不请求项目内部端点。

未知 token 仍返回不含私有资源信息的 404。已识别 token 的撤销和过期状态分别返回 `SHARE_REVOKED`、`SHARE_EXPIRED`，HTTP 状态仍为 404；原型尚无可用预览返回 409 `SHARE_PREVIEW_UNAVAILABLE`。前端按受控错误码显示无效、过期、撤销、预览暂不可用、权限或服务失败，不显示任意服务端 detail。预览和临时故障可明确重试。OpenAPI 将原型分享 GET 标记为公开入口，并声明 404/409/503。

## 固定产物的实际预览

文档与产物和项目级匿名分享中的 prototype schemaVersion 1、2 均自动打开独立预览，不将原型结构对象递归显示成正文。沿用版本级 `preview-token` 入口；API 验证项目成员或有效公开分享，能力绑定 artifact/version/checksum 及 principal 或 share/revision。Preview 服务每次访问（含条件请求）重新校验授权，过期或撤销的 capability 不返回缓存的 304。

schemaVersion 1 使用服务端共享导出渲染器生成完整交互 HTML，保留实际控件、变量、动作和跨屏导航。资源只从该版本固定清单解析，匹配 ready Blob 的身份、SHA、字节数、媒体类型并通过受控存储完整性读取；单次资源和最终 HTML 受预览大小上限约束。schemaVersion 2 继续读取并验证冻结构建。两条路径共用隔离来源、脚本哈希 CSP 和不含 same-origin 的 iframe；未引入旧 UI 或节点协议回退。Preview 服务的 export-core 运行依赖与 Docker 构建必须同步集成。

原型 capability 的客户端查询按授权域及固定版本隔离，离开组件后不保留查询缓存；服务端凭证仍由权限和有效期约束，预览到期移除 iframe 并可重新打开。普通 blob 产物在校验字节数和 SHA 后显示图片、音视频、PDF 或文本；损坏内容不显示也不提供下载，重试不改变固定版本。切换资源及时撤销对象 URL，原文件下载使用服务给出的文件名。

产物版本采用 30 项游标分页，未在当前页的固定版本仍显示其实际身份。Studio 的原生 History 更新传入 null，由 Next.js 维护内部历史数据并通知 useSearchParams；不得复制包含其内部导航标记的 window.history.state，否则地址栏变化不会同步文档或运行视图。前进后退及直达 URL 使用同一版本合同。

## 完整产物与对话目录

- 新前端的资料、产物、对话和运行目录通过各自服务游标分页读取（每页 30），不将 Bootstrap 的有界投影当作完整列表。合并页按资源 ID 去重，已选择的固定产物/版本、运行与对话不随加载更多或筛选改变。
- `thread` 是运行视图的新路由参数。固定 Run 以其授权响应中的 threadId 为准；首批目录之外的对话先读取详情并核对 projectId，再请求该对话的运行与消息。切换对话更新地址并清除固定 Run。
- 对话历史按服务 `afterSequence` 读取，每页 100 条，按 sequence 排序。完整展示当前对话中的用户输入、助手回复和状态；`producedByRunId: null` 的输入不能被丢弃或根据时间归入某一 Run。带明确关联的回复可跳转对应 Run。
- 消息历史提供显式刷新；完成的历史列表不持续轮询所有页。资料仅在解析中、运行仅在活动状态轮询，失败保留已读目录并提供重试。产物生成终态会失效产物目录缓存。
