# Studio 客户端合同

应用版本为 1.0.0。共享 schema 与本文件随增量需求确认服务一并集成；源码与验证身份记入 `docs/audit/1.0.0.md`。

## 开源来源与应用边界

编辑器前端二开自 Onlook（Apache-2.0），固定提交 `423e2e924366419e418ee049093872d535eea41a`。原始文件、SHA-256、许可证、修改范围和维护方式见 `third_party/onlook/`；`npm run studio:source-check` 校验来源。实际复用包括 Main、DesignPanel、Canvas、几何框、ChatInput、项目卡片、设备目录与尺寸输入。不运行完整 Onlook 云应用，不引入其账号、Supabase、计费或生成编排。

项目首页由 StudioHome 承载；项目路径为 `/studio/:projectId`。URL 使用 `plan`、`revision`、`page`、`view`，不识别旧 query。底部对话框、中央舞台、互斥工具面板均属于新组件树。业务服务从 `lib/studio/api.ts` 接入已有授权 API；不挂载旧 WorkbenchRuntime、React Flow 画布或旧产物组件。依赖检查禁止它们进入新应用模块图。

页面、文档、资料、知识、运行、发布和项目设置使用新导航。视口尺寸按用户／项目保存在 sessionStorage。Composer 的可见意图、固定提交目标、文字、模型、终端、输出、设计与资料引用按账户／项目保存在 IndexedDB，并分别保留新建、修改源版本、完善产物的讨论输入；退出账户清理两种私有缓存。未上传附件仅持久化文件元数据，文件字节只在当前页面内存中；刷新后须重新选择或移除，未恢复前禁止提交。上传准备成功后替换为授权 sourceId。生成版本和上传文件仍由服务端管理，临时对象 URL 不作持久引用。预览尺寸不改变生成目标终端。

## 授权进度

`GET projects/:projectId/prototype-v2/plans/:planId/progress` 沿用项目 viewer 权限与 Run SSE。响应包含项目、计划、输入摘要、显式绑定的 Run、快照游标、有界事件投影和最终 revisionId。只有已确认并绑定 Run 的计划才可查询进度；缺失绑定返回404。事务隔离为 RepeatableRead；事件不得超过快照序列，只选择当前 attempt 的最新页面投影、草稿元数据、阶段及活动，最多 64 条。

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

令 `P = projects/:projectId/prototype-v2`。`GET P/plans/:planId/input` 返回授权的完整固定请求、资料/设计/知识快照及摘要 SHA；请求与快照均从绑定 Run 读取，缺失绑定时返回404，不从旧草稿重建。


`GET P/revisions/:revisionId/input` 读取生成所选内容版本的实际计划/Run，而非始终取根计划。历史 `request` 原样保留；另返回服务归一化的 `modificationRequest`，明确 edit 操作与精确源产物目标，并移除旧 `requirementConfirmationId`；新意图须重新讨论确认。Composer 按该操作筛选模型，不改写历史输入，也不自动替换原模型；不兼容时保留并提示用户选择支持编辑的模型。刷新恢复保留操作上下文，旧缓存缺少操作上下文时须重新载入源版本。

针对固定修订提出新改动，使用 `context.kind=revision` 进入需求交流，固定 sourceRevisionId、选定反馈及页面/节点锚点。明确确认后创建已审批的派生计划，不再进行第二次审批。新增资料须就绪且属于当前项目；已固定的资料/设计及源产物版本不会换成最新版本。服务将修改绑定为 edit，保持用户明确选择的 PRD/原型输出；基准变化时返回冲突。

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

媒体与关系/变体入口、上传/需求确认中断后的完整恢复等继续按业务能力清单验收，不挂载旧前端作为备用路径。

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

## 图片上传与版本编辑

“文档与产物”提供添加图片，固定图片版本提供编辑入口。裁剪复用 `react-easy-crop`；文件上传使用现有 Uppy multipart、校验和检查点，不挂载原资料画布或其状态。PNG/JPEG/WebP/GIF 可保留原文件上传；裁剪明确输出静态 PNG，最大 32,000,000 像素。单文件遵循服务 25 MiB 上限。

图片编辑沿用 `POST /artifacts/{artifactId}/versions`，新增 `kind: image`、固定 `baseArtifactVersionId` 和已校验同项目 `source.fileAssetId`。需要编辑权限、当前 ready 图片基线、If-Match 与幂等键；创建不可变 blob 版本并持久化 base/result 编辑收据。数据库迁移 `20261116010000_image_artifact_version_edits` 扩展收据约束，保留已有文档、原型和不可变保护。此功能需联动迁移、API、Contracts/OpenAPI 与 Web。

一次保存意图内，文件完成后重试复用 fileAssetId 和写入键；改变裁剪范围后创建新文件意图，改变目标或名称后创建新写入意图。源历史版本只可另存新图片；两端的固定版本通过另存来源关联保存。取消等待 multipart abort 确认，校验或保存阶段不宣称上传仍可撤销。离开页面销毁本地控制器，迟到响应不得创建产物或更改导航。图片上传校验完成后的写入命令按用户、项目及固定来源版本保存到本标签页的 sessionStorage，关闭编辑器或刷新后可明确确认原保存；重放复用原 fileAssetId、正文、CAS 与幂等键。未上传的文件字节和裁剪中间像素仍只在内存中，刷新后需重新选择文件。跨产物关系见下方合同。

创建产物的幂等响应中，artifactVersion 始终表示该创建请求产生的固定版本；artifact.currentVersion 可因后续编辑指向更高版本。两者引用同一 artifact，版本号必须与各自身份一致，不能把创建重放误解为新建另一张图片。


### Studio 编辑与提交恢复

文档视图把实际打开的版本写入新 URL；后台当前指针推进不会把编辑基线换成另一版本。PRD 手动编辑保留 documentId、引用与原始版本，保存时递增 revision.number。未提交草稿与已准备命令分别保留：准备后固定 changedAt、正文、ETag 和写入键，收到丢失响应或 5xx 时不重新生成命令。明确放弃仅清除本地草稿，不删除服务器版本。

计划和 Run 提交在附件转为授权资料引用后计算规范化请求身份；文件对象转换为同一 sourceId 不属于新意图。保存完整请求和固定提交目标后才执行写入。相同输入重试或“确认上次提交”会重放原命令，恢复入口不清空用户后来输入的文字。已明确收到的 412 CAS 拒绝不保留待确认命令；用户核对并接受最新版本后产生新命令。服务尚未明确回应的请求仍使用原 ETag 和键，避免已成功的写入被误当成新请求。

本地记录使用 schema 校验，键按用户、项目、文档/图片固定版本或提交场景隔离，不包含文件字节、会话令牌或存储凭据。退出登录由统一认证层清除全部 `workbench:studio:` 记录，旧异步操作随后不能重新写入或继续下一步提交。作用域离开后即使又返回同一项目，旧操作仍失效。存储不可用时明确提示刷新会丢失未保存内容，当前内存编辑保留。


### PRD 语义阅读与结构化编辑

新 Studio 依据 PRD v3 合同渲染活动渠道、安全基线、封面和版本记录。安全基线的固定要求与适用范围来自 `prdSafetyBaselineItems`，与保存版本的判定及备注按序号结合；保留完整 intro。渠道使用 `prdChannelLabels`，不展示内部枚举值。

流程图和架构图使用 [Dagre 官方库](https://github.com/dagrejs/dagre) 3.1.3（MIT；graphlib 4.0.6）计算布局，在本地 SVG 中绘制真实节点、业务标签和有方向的连线；不经过旧资料画布。图形保持可读字号并允许局部滚动，每张图保留完整描述及可展开的文字关系供键盘和辅助技术使用。规模继续受合同 40 节点、80 条边限制。

手动编辑提供三个渠道开关、21 项安全基线判定和备注、业务降级适用开关，以及工单和修订记录。工单名称同步文档/封面标题，业务章节名称同步目录；固定模板标题不能被误改。不涉及的基线项使用 null 备注，是/否仍需依据和对应正文事实。字段变化沿用本地草稿与固定保存命令恢复机制；校验失败只保留草稿并解释对应内容，不发送写入，也不放宽合同的语义一致性校验。

### 固定版本产物关联

产物详情中的“产物关联”随固定版本读取两个方向。项目内的产物、目标版本和关联列表各自分页，用户明确选择可用版本。关系的来源、目标、类型和说明创建后固定。移除检查关系 revision，保留两端版本及可查看的移除记录。查看权限可读取关联，编辑权限可添加和移除。

`GET /projects/{projectId}/artifact-links` 接受可选的固定版本过滤与移除记录过滤，游标同时绑定项目和这两个过滤条件。创建使用幂等键，重放核对操作者和完整请求。移除使用 If-Match，重复请求返回同一移除结果。浏览器在发出写入前保存原命令，以便刷新后确认操作。

图片另存通过可选 `derivedFrom` 明确指定同项目的可用源图片版本。新图片、创建收据及来源关联在同一事务提交。此前没有该字段的创建命令仍沿用原请求身份。迁移 `20261116020000_artifact_version_links` 从历史画布导入两端都明确绑定到可用产物版本的边，沿用原方向、类型与说明。升级需迁移、API、Contracts/OpenAPI 和 Web 一并生效。

## 增量需求交流与一次确认生成（服务端合同 v1）

普通消息先进入需求交流。先创建/选定已有 Thread，再 `POST /threads/{threadId}/requirement-sessions`（Idempotency-Key，正文 `{generationRequest: StartRunRequest}`）。此处的 request 是输入配置，创建会话不发起生成。会话按操作者、项目和 Thread 隔离。`GET /threads/{threadId}/requirement-sessions` 只返回当前操作者的会话，按 cursor/limit 分页（默认30，最大100），返回 nextCursor；游标绑定用户和 Thread；`GET /requirement-sessions/{sessionId}` 返回完整快照及 ETag。前端依据服务端 state，不按文字长短或完整度评分决定进入生成。

`POST /requirement-sessions/{sessionId}/messages` 要求 Idempotency-Key、If-Match，正文 `{text, generationRequest?, intent: "discuss" | "confirm_suggestion"}`，返回 202 快照。可随消息调整输入/输出/模型/资料/设计，生成模型保留产品支持列表中的用户选择，并固定其身份。需求分析内部默认 Flash 是服务端成本配置；Flash-only 仅约束本轮实际测试，不删减产品的生成模型选择能力。消息保存到现有 ThreadEntry；普通分析有独立持久回执和取消/失败状态，不创建产物 Run。新消息立即使旧摘要确认失效，并取代仍在分析的旧消息；迟到模型响应不能覆盖新版本。生成已开始时新增消息开启下一轮讨论，已经冻结的 Run 输入不变。

快照含 `revision/state/context/generationRequest/summaryVersion/summaryChecksum/card/evidence/activeTurn/confirmation`。state 为 discussing、analyzing、needs_clarification、ready_to_confirm、confirmed、generating。activeTurn.status 为 queued、running、succeeded、failed、cancelled、superseded；modelId 固定 deepseek-flash；failureCode 和 tokens 只记录受控状态，不暴露供应商原始响应。失败/取消不删除输入。取消与重试分别为 `POST .../turns/{turnId}/cancel|retry`，同样使用 CAS 和幂等键；重试不得重新保存同一用户消息。

讨论阶段 card 可为 null 或仅包含已知字段，允许纯知识问答和未知平台/角色/模块。仅服务端判断达到 ready_to_confirm 时才要求完整就绪卡；不根据模型 blocking 布尔值单独决定。就绪 card 固定目标、业务平台/模块/角色、existingCapabilities（带 evidenceIds 和适用范围）、reuse、changes、affectedPages、affectedFlows、targetSurface、designConstraints、outputKinds、assumptions、issues、platformChanges、preserved。引用包含固定 release/document/chunk 身份、原文和 SHA-256。检索命中只证明出处，不能将“未检索到”判定为平台没有该能力。区域/模板/原型证据不升级为全平台事实。未处理的 scope/workflow/permission/financial/external_dependency/platform 缺口或冲突阻止生成。平台改造必须显示在 platformChanges 并由用户单独接受。模型建议始终留在 assumptions，不标记为用户已确认。

`POST /requirement-sessions/{sessionId}/confirm` 正文 `{summaryVersion,summaryChecksum,acceptedAssumptionIds,acceptedPlatformChanges}`，要求该快照的 ETag 和固定动作键。用户只确认一次，服务冻结完整卡片、消息与引用版本、输入资料/设计及输出配置，并衔接现有 Plan/Run；原计划审批由这次确认完成。PRD-only 也经此入口。重复确认、丢回执和刷新重放返回同一个逻辑生成结果。pending/started 确认公开 planId/runId，客户端轮询会话直到 started，再导航既有 Plan/Run 页面。

`intent=confirm_suggestion` 表示用户在这一条消息中明确授权按建议生成。服务端仍需分析并通过关键缺口、证据和边界检查，只有 ready_to_confirm 才走同一确认实现；不能从模型答复中推导这一意图。它不允许消除关键问题、扩大已批准边界或自动接受尚有争议的平台改造。

新的初始 PRD/原型生成请求必须携带服务端出具的 `requirementConfirmationId`，且与冻结请求完全相符。公开生成入口只有需求会话确认；无直接 Plan 创建、独立审批或 SubmissionIntent 提交流程。历史版本读取、分享、导出及同一次固定输入的原样重试保留原记录。针对现有版本提出新功能改动是新意图，必须进入需求对话并明确确认。context 仅为 {kind:"new"} 或 {kind:"revision",revisionId,feedbackIds,anchor}；保持精确来源，不得从提示词猜测。服务端错误：REQUIREMENT_CONFIRMATION_REQUIRED、REQUIREMENT_BASELINE_CHANGED、REQUIREMENT_NOT_READY、REQUIREMENT_ASSUMPTIONS_UNACCEPTED、REQUIREMENT_PLATFORM_CHANGE_UNACCEPTED、REQUIREMENT_ALREADY_STARTED、REQUIREMENT_TURN_LIMIT、REQUIREMENT_MODEL_UNAVAILABLE、REQUIREMENT_MODEL_OUTPUT_INVALID、REQUIREMENT_KNOWLEDGE_UNAVAILABLE。409 表示状态或基线冲突，412 表示 CAS 过期，429 表示限额，503 表示当前服务不可用；同一动作重放先核对原回执，不能因 ETag 变旧而重新生成。

接入需要共享 schema/OpenAPI、API、迁移、Worker 的固定需求基线读取一起集成。本文不声明新服务已上线或真实模型验收完成。知识维护源文件不等于当前授权 release 已索引；发布阶段必须按既有知识发布流程检查版本覆盖。

完整就绪卡中的 affectedPages/affectedFlows 字段必须明确出现；空数组表示用户目标明确不涉及该维度，省略表示讨论中尚未明确。仅文档的接口或后端规则增量可以没有页面改动；请求原型输出时需要明确页面范围。业务名称包含“未知渠道”等正常术语不等于未明确。已有能力的 scope 必须有实际同范围来源支持，不能仅由模型把不确定或区域来源重贴为模板/平台规则。

确认端点的重放响应中，confirmation 始终对应本次提交的摘要/动作回执，即使会话后来进入了新一轮讨论；该响应仍给出当前 revision/state。GET 会话返回当前讨论快照。前端用 confirmation.summaryVersion/checksum 识别原确认，不能把旧确认套到后来修改的卡片。pending 回执的 failureCode 用于展示派发失败，后台按固定动作键有界重试；生成结果和讨论任务使用各自状态。

Flash 测试映射以现有授权 Provider 配置及实时模型目录为准：产品所称 deepseek-4.1-flash 使用 wire id deepseek-flash。此映射只有一个目标，不是候选模型或自动回退；禁止 Pro。需求分析私有配置可写该别名或 wire id，服务统一请求 deepseek-flash。生成仍冻结用户选择的受支持 modelId。

roles 字段同样区分未知与明确不涉及：讨论可省略；完整的纯文档/后台增量可明确提供空数组，表示不新增或改变角色，保留现有调用方/权限边界。若涉及新权限或调用方差异，必须在 issues 中解决；原型输出仍需要明确角色与页面范围，不能为了满足卡片数量而发明人类角色。

来源修改在确认事务中再次核对所选批注的项目、源修订、正文、锚点和状态/修订号，与分析时的固定记录一致。就绪后批注被解决等变化返回 REQUIREMENT_BASELINE_CHANGED（409），保留讨论供用户重新核对；不能沿用旧卡片发起修改。生成已经开始后，解决批注不会改写其冻结输入；同一确认重放仍返回原任务。

原样重试保持确认作者、request、知识发布、设计快照、资料及完整重试来源链。实际重试操作者依当前项目编辑权限授权，可与原确认作者不同；Worker验证同项目链最终归属于原确认Run，不将重试操作者当作新的确认作者。后来发布知识或切换设计不会改变重试输入。


### 确认派发故障与恢复

后台对同一冻结确认执行最多12次、有界间隔的派发尝试。达到上限仍保留 pending、failureCode、原输入和确认，不重新分析需求。页面提供“重试派发”：`POST /requirement-sessions/{sessionId}/confirmations/{confirmationId}/retry`，无正文，使用当前 If-Match 与新的 Idempotency-Key。服务重新校验身份、当前确认及基线，恢复同一确认的派发预算；进程重启继续读取持久记录。若已经 started，返回同一 planId/runId。刷新后可仅依靠服务端会话和 confirmationId 恢复，不依赖找回浏览器原确认键。

仍持有原确认命令时，重放 `POST .../confirm` 的同一动作也能恢复失败的 pending 派发，使用原摘要、正文和幂等键；重放先核对回执，不因旧 ETag 重建确认。确认失效或需求已改变时，重试端点拒绝恢复旧输入。两个入口均不会创建第二个逻辑生成任务，也不要求用户再次回答需求问题。


原型计划的公开 `prompt` 展示已确认卡片的目标与本次改动；完整生成指令、批注身份、证据及机器上下文留在不可变 `generationRequest`/Run 请求中。重试沿用该展示文本和原冻结请求，不把机器 JSON 当正文显示。

第95迁移 `20261117020000_prototype_retry_run_lineage` 衔接第94迁移，保留旧迁移和历史行。原型计划重试可使用其已失败或已取消的 Run，包括未标为普通可重试的失败；必须存在同项目、同请求、准确源计划/Run 关联的 approved 派生计划，并保留知识与设计快照，Run 记录 `retryOfRunId`。普通 Run 重试仍仅接受 failed 且 `errorRetryable=true`。成功生成后仅构建失败继续复用原成功 Run，不再请求模型。


## 统一新产品模型

新建、按版本修改、按批注修改均在需求会话讨论和调整输入；通过就绪校验后确认一次。包含原型时确认事务直接生成approved计划与绑定Run，approved表示已确认、等待执行，不存在draft审批阶段。公开计划状态为approved、generating、ready、failed、cancelled。取消、原样重试、版本确认/驳回、分享和导出沿用各自业务状态。

公开合同删除 `POST P/plans`、`POST P/plans/:planId/approve`、`POST P/plans/:planId/input`、`POST P/revisions/:revisionId/plans`、`POST P/revisions/:revisionId/revise` 及全部SubmissionIntent接口/上传绑定；这些路径不存在。资料通过独立文件上传和ImportSource形成sourceId，再纳入讨论；分片上传、断点续传及幂等回执保留。讨论配置canvasSnapshot只能为null，版本与节点来源以revision、反馈锚点和artifactTargets绑定。

`GET P/plans/:planId/input` 与进度只读取明确绑定的Run，snapshot为必填对象，不从旧草稿或后来的资料重建。修改输入须重新讨论确认；原样重试仍使用原确认链。API拒绝重试无确认的旧Run，Worker拒绝无确认的执行与原型构建准备。旧表、行与迁移保留，旧draft不进入公开计划列表、不恢复旧审批；已有冻结版本、资料和导出数据不删除。此为产品流程替换，不提供双写、旧入口别名、历史JSON展示修复或执行豁免。
