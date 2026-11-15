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

业务反馈 API 仍持久化 `pageId + selector + quote`；Studio 只从稳定 nodeId 生成一个规范 selector，没有旧节点回退。需求 FR-20 要求的独立 nodeId／源版本锚点持久化合同仍需收口，不能把本次前端测量协议当成已经完成该后端变更。

新增进度、完整输入合同、OpenAPI、API 控制器／服务和 `20261115100000_prototype_plan_input` 迁移必须随前端集成，不替换 Temporal／DeerFlow。真实模型至少两次中间变化、完整交付、所有业务能力和性能验收以审计中的逐项状态为准。fixture 与真实 PostgreSQL 接口测试不能代替模型和生产集成验收。

## 文档运行生命周期

纯文档和普通产物提交成功后，URL 的 `run` 固定被接受的 Run。新工作区直接读取 Run 快照、消费既有 SSE，并使用既有三秒权威快照核对；没有第二套任务编排。刷新只恢复，不重复提交。活动 Run（包括 waiting_input 与 cancelling）阻止再次发送，但不禁止编辑下一轮文字。终态刷新项目产物，文档视图按真实 `createdByRunId` 定位新成果；用户显式选择的历史文档不被替换。重试返回新 Run 时更新 URL 和跟踪对象，取消接受不等于已经停止。

待办和操作采用实时投影与快照中的较新状态。投影须匹配 project/run/request/thread，且 attempt 与序列不能落后。工作区与运行详情共享已有投影，不为同一详情重复启动事件订阅。失效资料仍保留可移除的引用条目；删除源会失效全部该项目资料查询，不清除输入文本。

## 完整输入与有来源的修改计划

令 `P = projects/:projectId/prototype-v2`。`GET P/plans/:planId/input` 返回授权的完整固定请求、资料/设计/知识快照及摘要 SHA；已绑定运行时读取该 Run 的权威输入。旧记录缺少快照时明确返回 null，不声称已经固定。

`POST P/plans/:planId/input` 使用 If-Match 与 Idempotency-Key，仅允许尚未绑定 Run 的 draft。调整包括需求、模型、终端、输出、资料与设计，保留 artifactTargets、generationIntent 和来源身份。快照与输入一次性保存；数据库限制执行中改写及任何来源身份变化。412/409 后保留所有本地调整，读取最新输入，用户核对后明确继续；不自动覆盖。

`GET P/revisions/:revisionId/input` 读取生成所选内容版本的实际计划/Run，而非始终取根计划。`POST P/revisions/:revisionId/plans` 创建待审批修改计划，固定 rootPlanId、sourceRevisionId、内容版本、选定反馈；审批前不启动运行。新增资料须就绪并校验项目和 blob 清单，保留的资料/设计沿用源快照。服务将修改请求绑定为 edit 及该源版本的精确 prototype artifactVersion；基准已变化时返回冲突，不把修改附到其他版本。

浏览计划、版本或前后导航不改变正在编辑的提交目标，输入区始终显示固定来源。显式切换新计划或文档操作会暂存先前完整草稿，并提供恢复入口。提交分支直接来自同一上下文状态；异步加载来源期间输入的文字保留，已放弃上下文的迟到响应不抢回输入区。设计预设选择固定 id/version/checksum；失效设计或模型要求明确替换，只有确有服务端快照的原设计可以继续沿用。

## 后续合同提案（尚未实现，不是可调用 API）

以下是需求 1.2 的剩余合同工作，不应将本节当成接口已经存在。

| 需求 | 建议合同与约束 | 集成验证 |
| --- | --- | --- |
| FR-24 PRD→原型/多屏与双向关系 | 生成意图固定 sourcePrdVersionId 和明确 screen/flow 范围；授权验证源版本，服务返回 PRD 版本与 prototype revision/artifact version 的持久关系、分项状态；按固定关系查询双向入口 | 文档生成界面、多屏、联合输出及分项失败；不得用时间接近或标题猜测关系 |
| FR-20 持久化锚点 | 反馈保存 sourceRevisionId/pageId/nodeId、文本引用与可选几何；服务幂等写入；解析锚点返回 resolved/missing，不以旧 selector 作为新协议回退 | 跨版本节点消失仍保留正文，旧帧/错误来源不能写入，重复保存不产生两条 |

媒体与关系/变体入口、完整成员和邀请管理、项目级分享、公开错误细分、上传/提交意图中断后的完整恢复等继续按业务能力清单验收，不挂载旧前端作为备用路径。
