# 生成与知识入库闭环

更新日期：2026-09-24

本次修复覆盖仓库实现和本地验证。未部署生产、未采用生产模型，也未将生成内容同步到外部知识库或公开 Quartz。

## 强制知识证据

- API 在事务内选择当前 Project 的最新 ready KnowledgeRelease，否则选择可访问的 workspace/global ready release。没有可用版本时返回 `KNOWLEDGE_RELEASE_REQUIRED`，不创建 Run、对话条目或队列任务。
- Worker 拒绝缺少 release pin 的历史 queued Run；缺少知识工具授权不能成功完成生成。
- 知识工具预算使用 Prisma 类型化、幂等写入，与授权使用同一 UTC 时间，避免非 UTC 数据库会话将预算创建时间偏移后阻止实际检索。
- 成功发布前，Worker 核对同一 Run、RuntimeAttempt、Project、principal、release 的成功检索 receipt，校验其 canonical SHA-256、hybrid/production 范围和非空结果。
- 每个 Artifact 的引用必须完整匹配实际检索返回的 citation，且 chunk/document/sourcePath 属于固定 release 的 production 文档。空引用、伪造引用、跨版本引用均失败。
- 数据库同时约束新 Run 的知识版本、成功 Run 的检索记录、生成版本的知识 pin/非空引用以及联合生成的 PRD 关系。readiness 不再在零 ready release 时返回成功。

## 联合生成

复用现有 Run、RuntimeAttempt 和 ArtifactVersion，不再引入另一套重复的 GenerationTask 状态机。

`requestedArtifactKinds: ["prd", "prototype"]` 是一个 Run。PRD 完成规范读取与四个生成阶段后，在 index 0 发布草稿；Prototype 随后完成自己的阶段，在 index 1 发布草稿。最终结果包含两个产物，不能在 PRD 草稿成功后自动结束。

Prototype 的 `sourcePrdVersionId` 固定同一 Run 的 PRD 版本。人工编辑和 AI 修订均继承这一关系。数据库拒绝把联合生成的 Prototype 绑定到其他 Run、Project 或未就绪的 PRD。单独生成原型的既有流程保留；联合生成的新 PRD 不会被历史文档替代。

## 确认与入库

新增 `ArtifactFinalization`、`KnowledgeIngestionJob` 和 `KnowledgeDocumentSource`。KnowledgeRelease 的 `parentReleaseId` 与 `ingestionJobId` 保存不可变来源链，无需重复保存第二份 lineage 表。

拥有者可以操作以下接口：

| 方法 | 路径后缀 | 行为 |
| --- | --- | --- |
| GET | `/artifacts/{artifactId}/versions/{artifactVersionId}/finalization` | 查询确认和入库状态，尚未确认时为 null |
| POST | 同上 | 携带 `{ checksum }` 确认指定 ready 版本 |
| POST | 同上加 `/retry` | 重试失败任务 |
| POST | 同上加 `/withdraw` | 撤回确认及其知识发布链 |

确认事务校验版本与内容 checksum，并创建唯一 finalization、唯一 ingestion job 和事务内队列投递。并发或重复确认返回相同对象，不重复入库。PRD、结构化业务文档和 Prototype 的可索引文本被转换为项目私有 Markdown 快照；资产、存储路径和已有 citation 元数据不混入正文。

File Worker 读取该不可变快照，复制固定父 release 的文档、chunk 与来源关系，再构建和嵌入新内容。全部向量批次通过现有完整性 finalizer 后，新 release 才进入 ready。父 release 的内容和 manifest 不修改。

任务失败保留当前 ready 知识库，原任务的重试创建新的 release attempt。每个 Project 同时只接受一个进行中的入库任务，其他确认返回 `KNOWLEDGE_INGESTION_IN_PROGRESS`，避免并发分支相互覆盖知识。

入库分块的重复投递使用“固定父版本 + 本次新增文档”的完整 manifest 做一致性校验。构建中和发布后的合法重放均幂等；重放时修改标题等 manifest 内容仍会返回 `KNOWLEDGE_RELEASE_REPLAY_CONFLICT`。这避免将新增文档的局部摘要误当作完整 release 摘要。

撤回会锁定原发布及其所有后代，原子退休 ready 版本、终止 building 版本，并撤回相关任务及确认。即使发布事务正在完成，也不能漏掉刚转为 ready 的后代。未来 Run 回退到仍 ready 的前代或基础知识版本；所有历史内容、引用与审计记录保留。后代确认一并撤回是有意的保守行为，不做隐式内容删除或自动语义合并。

尚未提供语义冲突自动裁决。用户确认表示允许将该固定版本追加为项目知识，不代表系统已证明它与全部历史事实一致。

## 分享与下载

- ShareGrant 固定一个 Prototype 的 `artifactVersionId`，scope 仅允许 view。
- 公共 release 投影只保留指定 Prototype，去除其他产物、注释、框架和边；内容与资源下载入口再次核对该 pin。
- 过期或撤销返回不可区分的 404；新版本不会改变旧链接。切换选中原型后，前端不会复用另一个版本的缓存链接。
- 迁移会撤销历史未固定产物的 active 分享，避免旧整项目链接继续暴露其他内容。重新分享必须选择一个 Prototype。
- DOCX/PDF 支持固定版本 PRD v2 和普通 `{ text }` / `{ markdown }` 文档。一次选择一个文档，原型仍通过独立预览和分享交付，不伪装为 Word 文档。
- 普通文档按安全文本渲染，不执行 HTML、脚本或下载远程资源。Markdown 标题保留层级，其余正文保留文本，不承诺完整富文本 Markdown 转换。

## 验收对应

| 编号 | 验收项 | 本地结论 |
| --- | --- | --- |
| 1 | 无 ready release 不创建可执行 Run | API 拒绝测试、数据库约束 |
| 2 | 成功生成固定知识版本 | Worker 发布与数据库约束 |
| 3 | 每次生成成功检索 | 当前 attempt receipt 校验 |
| 4 | 无有效引用不成功 | 契约、Runtime、Worker 多层拒绝 |
| 5 | 一次输入生成 PRD 与 Prototype | 请求契约、前端意图、Runtime 顺序与 Worker 回归 |
| 6 | 联合产物固定同任务 PRD | 版本外键、Worker 测试和数据库约束 |
| 7 | 固定版本 DOCX/PDF | 渲染测试和普通中文文档页面检查 |
| 8 | 链接仅暴露指定 Prototype | 元数据、正文、资源入口隔离测试 |
| 9 | 只读、过期、撤销、版本固定 | Share service 和前端链接切换测试 |
| 10 | 确认后单个幂等入库任务 | PostgreSQL 并发确认测试；前端入口待确认 |
| 11 | 新 release 不修改旧版本 | PostgreSQL 内容与来源不可变验证 |
| 12 | 失败隔离、重试、回滚 | PostgreSQL 注入失败、重试及发布/撤回竞争测试 |

新增迁移按顺序为 `20260924010000_knowledge_generation_lifecycle`、`20260924011000_artifact_knowledge_source`、`20260924012000_knowledge_source_integrity`。仅在隔离本地 PostgreSQL 执行，生产迁移尚未执行。

本地通过了 OpenAPI、全工作区 typecheck、API、Worker、File Worker、Web、contracts、knowledge、导出与部署契约相关回归。数据库生命周期测试需要显式设置指向 localhost 测试库的 `WORKBENCH_TEST_DATABASE_URL`，未设置时跳过。模拟嵌入用于验证生命周期，不构成真实模型质量或网络验收。

2026-09-24 续验使用新建的 localhost PostgreSQL 测试库，执行现有全部迁移和数据库约束脚本，并验证了：

- API 全量 552 项测试通过，包含定版、幂等入库、不可变来源、失败重试、发布与撤回竞争、分享隔离等数据库用例。
- Worker 常规与共享测试库套件 486 项通过；RuntimeAttempt 专用独立库套件另有 42 项通过，共 528 项。Web 1092 项通过、3 项既有跳过，lint 无错误或警告。
- 联合发布在缺少同 Run PRD 关系时原子回滚；恢复关系后两个产物一起发布，已发布关系不能修改。
- 知识授权新增显式 `Asia/Shanghai` 数据库会话测试，预算时间与授权时间保持一致。
- 定版 hooks 覆盖禁用查询、未确认状态、确认/重试/撤回、切换版本后的延迟结果隔离；版本记录弹窗已接入拥有者专属的最终版确认、入库状态、失败重试与撤回操作。
- 知识包 84 项、contracts 285 项、核心契约脚本 115 项通过；知识库审计仍为 41 个 Markdown、40 个索引、34 个发布、0 个错误。
- 全工作区 15 个 typecheck 通过，追加修改的 API、Worker、File Worker、Web 也单独复验。

测试数据库默认时区设为 UTC，与现有时间存储约定一致；授权预算的时区回归在事务内显式切换为非 UTC，不依赖这个默认设置。RuntimeAttempt 回填用例扫描整库，须把 `WORKBENCH_RUNTIME_ATTEMPT_TEST_DATABASE_URL` 指向不同于共享测试库的独立空库，通过 Worker 的 `test:postgres` 入口执行，不能复用其他套件遗留的 Run 数据。未运行生产数据库迁移或真实模型网络验收。

普通 DOCX/PDF 页面检查使用 bundled Python、LibreOffice 和 Poppler。macOS bundled LibreOffice 需要显式指定其 `Resources/fontconfig/fonts.conf`，否则即使 PDF 文本可提取，中文 glyph 也可能缺失。生产镜像仍需安装并验证 CJK 字体。

## 未完成的验收

- 最终确认、重试、撤回的 API、前端 client/hooks 和版本记录弹窗入口已实现；尚未执行真实生产用户流程验收。
- production adopted embedding/retrieval profile、模型权重/revision/image digest、真实 conformance 和网络 E2E 未执行，不能声明 dense 检索生产可用。
- 工作区保留既有未提交修改，`baselineDirty: true`。本次没有清理或覆盖用户改动，也没有生成干净发布基线。
