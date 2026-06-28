# 知识库重设计：需求对齐评估与修复路线图

> 本文档基于一次全量知识库设计审计（8 维度、97 个 agent、78 条经对抗式验证的发现），
> 在明确系统真实需求后，对知识库（KB）设计合理性做的**需求对齐重审**与**修复路线图**。
>
> 审计日期：2026-06-28。所有问题结论均逐条对照源码核实，引用格式为 `file:line`。

---

## 0. 系统真实需求（判定基准）

知识库服务于整个系统，核心场景是：

1. **AI 读 KB + agent 自主联网搜索** → 获取用户提问的产品信息 → 形成 PRD 和原型（未来还有画布等能力）。
2. 联网搜索由系统内 agent **自主决策**：KB 内没有的信息，agent 判断是否调用网络搜索工具补全产品信息或获取最前沿技术。
3. **沿用 vs 重做的判断**：在老功能上加新功能 → 沿用之前的产品架构和原型设计；完全全新的功能 → 判断是"完全全新的系统/页面"还是"在某页面上加新功能"。
4. **tab 栏样式决策**：全新系统若有 tab 栏 → 沿用之前的样式、页面样式完全重做；若无 tab 栏 → 可完全重新设计。
5. **主力更新方式**：用 codex 导入其他产品经理写的需求文档和原型图。
6. **画布只是前端展示**，知识库不需要感知画布结构。

这 6 条是下文所有"合理/不合理"判定的基准。

---

## 1. 审计结论（需求对齐后）

**当前知识库是一个"为 Obsidian vault 同步场景设计的、规则类知识检索系统"，与上述需求错位。骨架可复用，但五条核心链路从代码层面是断的。**

- ✅ **可复用的骨架**：类型化枚举（KnowledgeType/Status/Scope/Priority/Source）、自引用分类树 + 一致的 FK 级联策略、全量版本快照、候选→条目入库审批流水线（pending 门禁 + QA 门禁 + 强制拒绝理由 + 审计）、Phase 5 死表死列清理已落地、嵌入禁用时优雅降级。
- 🔴 **四条核心断链**（不修则需求不成立）：
  1. **非 vault 路径不嵌入**——codex/上传导入的主力内容语义检索不可见。
  2. **无跨产品维度**——"沿用已有产品架构/原型"结构性不可行。
  3. **联网协同断链**——联网 tool 不存在、置信度信号丢失、无沉淀链路。
  4. **图片知识进不了 KB**——"沿用之前原型图"无解。
- ✅ **已澄清：原型生成会读 KB**。原型与 PRD 共用 `VibeService.runDeerFlowTurn`，生成前会调用 `KnowledgeRetrievalService.search` 并把 `knowledgeContext` 注入 DeerFlow；`PrototypeService` 只是产物落库服务，不是生成入口。
- ⚠️ **决策规则硬编码在源码**：需求②③④的判断逻辑在 prompt 里，不可版本化/热替换，且判断结果不被代码消费。

> 与原审计的差异：原审计的 critical（非 vault 路径不嵌入）在需求视角下被放大——它不是"人工编辑项漂移"，而是"主力更新方式产出的全部知识语义不可见"。同时，后续代码探查修正了"原型生成不读 KB"这一误判：原型与 PRD 共用同一条 `vibe.service` 生成链路，KB 检索已发生。

---

## 2. 需求逐条对齐评估

### 需求①：AI 读 KB + 联网搜索 → 生成 PRD 和原型

| 环节 | 现状 | 判定 |
|---|---|---|
| 读 KB（生成 PRD） | [vibe.service.ts:504](../apps/api/src/ai/vibe.service.ts) 检索后注入 prompt | ⚠️ 能跑，但非 vault 路径知识不嵌入（见需求⑤） |
| **读 KB（生成原型）** | 原型与 PRD 共用 [vibe.service.ts](../apps/api/src/ai/vibe.service.ts) 的 `runDeerFlowTurn`；生成前会检索 KB 并注入 `knowledgeContext` | ✅ 已接入；需重点确保产品级知识、UI 样式、原型资产能被召回 |
| 联网搜索 | 本仓库无任何 web_search tool；[SKILL.md](../integrations/deerflow/skills/ai-product-workbench/SKILL.md) allowed-tools 是封闭文件操作集；编排在外部 DeerFlow | 🔴 不存在 |
| KB 置信度 → 触发联网 | score 在 [knowledge-retrieval.service.ts:139](../apps/api/src/knowledge/knowledge-retrieval.service.ts) 算出，但 [toReference:157](../apps/api/src/knowledge/knowledge-retrieval.service.ts) 丢弃，agent 拿不到 topScore/matchedCount | 🔴 信号断链 |
| 联网结果沉淀 | candidate source 枚举只有 prd/prototype/product_design_state/conversation/uploaded_file（[schema.prisma:241](../packages/db/prisma/schema.prisma)），无 web 来源 | 🔴 无沉淀链路 |
| 检索失败 vs 空召回 | [vibe.service.ts:520](../apps/api/src/ai/vibe.service.ts) 静默吞错，两者都伪装成空召回 | ⚠️ agent 无法区分"KB 没有"与"KB 挂了" |

### 需求②：判断"新功能 vs 完全新系统"

- 决策逻辑**硬编码在 prompt**（[deerflow-runtime.service.ts:431](../apps/api/src/ai/deerflow-runtime.service.ts)），不是知识库条目，不可版本化/热替换。
- 现有三分类 `historical_extension / new_capability / one_sentence_completion` 把"全新系统"笼统并进 `new_capability`，**没有独立"全新系统/页面"类别**。
- `requirementMode` 判断结果**不被任何代码消费**——grep 全仓只有定义处与 vault 文档描述处，无消费处。不驱动检索分支、不改变召回策略。**判了也白判**。

### 需求③：tab 栏样式沿用 / 无 tab 栏重做

- KB 里**零条**相关条目（grep 全仓无 tab/导航栏/样式沿用/样式规范）。
- 唯一规则在 prompt 一句话："preserve layout unless redesign"（[deerflow-runtime.service.ts:434](../apps/api/src/ai/deerflow-runtime.service.ts)）。
- 产物层有 `PrototypeComponentSpec.type: "nav"|"tabs"`（[ai-vibe.types.ts:203,210](../apps/api/src/ai/ai-vibe.types.ts)）和 `ProductDesignState.frontendRules`（[schema.prisma:639](../packages/db/prisma/schema.prisma)），但这是**当前项目产物**，不是可跨产品复用的知识库样式规范。

### 需求④：沿用之前的产品架构和原型设计

- **无跨产品"产品/系统"维度**。`sourceProjectId` 是唯一产品关联，检索时 [只过滤当前 projectId + global](../apps/api/src/knowledge/knowledge-retrieval.service.ts)（`:37-42`）。新建项目 B **检索不到**已有产品 A 的项目级知识——要沿用只能把 A 的资产存成 `scope=global`，失去产品归属。**结构性阻断**。
- **KnowledgeType 缺设计资产类型**。现有 7 个类型（[schema.prisma:205](../packages/db/prisma/schema.prisma)）全是"规则/规范/案例/概念"性质：

  | 设计资产 | 现有类型能否表达 | 缺口 |
  |---|---|---|
  | 已有产品架构概览 | 部分（混进 `default_rule`） | 无 `product_architecture` |
  | 页面清单 | 无（只存在产物字段 `ProductDesignState.pages`） | 无 `page_inventory` |
  | tab 栏 / 组件样式规范 | 部分（塞进 `prototype_rule`） | 无 `ui_style_guide` |
  | 某具体产品的原型资产引用 | 无（原型是产物，不在 KB） | 无 `prototype_asset_ref` |

### 需求⑤：用 codex 导入其他 PM 写的需求文档和原型图

- 仓库内**不存在 codex 导入入口**（"codex" 只出现在文档里，指 DeerFlow 外部节点）。实际主力路径是：上传文件 → FileParser 解析（**分块但不进 KB**）→ AI 抽 KnowledgeCandidate → 人工 approve → KnowledgeItem。
- 这条 approve 路径**不调用 syncItem**（[knowledge-candidate.service.ts:150](../apps/api/src/knowledge/knowledge-candidate.service.ts)），导入的需求文档沉淀后 `embedding=null`，**语义检索永远 0 分、永远不召回**，只靠字面 token 匹配兜底。原审计 critical 在此**确认命中且范围更大**。
- 长需求文档：vault 路径会分块（[obsidian-vault.service.ts:618](../apps/api/src/knowledge/obsidian-vault.service.ts)），但上传文档走 candidate 时**不再分块**，单条 string 写入，>8000 字截断（[knowledge-embedding.service.ts:88](../apps/api/src/knowledge/knowledge-embedding.service.ts)）。
- **图片知识进不了 KB**：[file-parser.service.ts:187](../apps/api/src/files/file-parser.service.ts) 不做 OCR/视觉描述，只产占位文本"图片已保存为视觉上下文，模块 4 不做 OCR"。`KnowledgeItem.content` 是纯 String，嵌入只吃文本。**"沿用之前产品的原型图"在图片层面完全无法实现**。

### 需求⑥：画布只是前端展示

- 当前 `scope: global|project` 已足够，**不需要**多租户/画布结构化组织。
- 据此**删除**原审计 P4 中"规划多租户/画布结构化"的建议。

---

## 3. 修复路线图

按"不修则需求不成立 → 核心决策与协同 → 规模与治理 → 长期演进"四级排列。
每条标注：**问题 / 改动位置 / 验收方式**。

### P0 — 不修则需求完全不成立

#### P0-1（已澄清）原型生成已接入 KB 检索
- **澄清**：`PrototypeService` 只是原型产物落库服务，不是生成入口；PRD 与原型生成共用 [vibe.service.ts](../apps/api/src/ai/vibe.service.ts) 的 `runDeerFlowTurn`，生成前已经调用 `KnowledgeRetrievalService.search` 并注入 `knowledgeContext`。
- **后续重点**：不是“给 PrototypeService 补检索”，而是确保生成前检索能覆盖 `product_architecture` / `page_inventory` / `ui_style_guide` / `prototype_asset_ref`，并把 Product 维度纳入召回。
- **验收**：发起原型生成时，`knowledge_retrieval` step 有检索事件，prompt context 内包含产品级 UI/原型资产知识。

#### P0-2 接通非 vault 路径嵌入同步（原 critical，范围上调）
- **问题**：`syncItem` 仅 [obsidian-vault.service.ts:367,378,381](../apps/api/src/knowledge/obsidian-vault.service.ts) 调用。`createItem`（[knowledge-item.service.ts:29](../apps/api/src/knowledge/knowledge-item.service.ts)，连 `KnowledgeEmbeddingService` 都未注入）、`approveCandidate`/`mergeCandidate`（[knowledge-candidate.service.ts:150,236](../apps/api/src/knowledge/knowledge-candidate.service.ts)）全部不嵌入。codex/上传导入的主力内容 `embedding=null`，语义检索永远 0 分。
- **改动**：
  1. `KnowledgeItemService` 构造函数注入 `KnowledgeEmbeddingService`。
  2. 在 `createItem` / `updateItem`（内容相关变更）/ `approveCandidate` / `mergeCandidate` **事务提交后**调用 `syncItem`，用 `isEnabled()` 守卫。
  3. 加 `lastEmbeddedAt` / `embeddingStale` 标志，便于补嵌。
- **验收**：经上传→候选→approve 路径入库一条知识，查 DB `embedding` 非空；语义检索能召回。

#### P0-3 补"产品/系统"维度，使跨产品沿用可行
- **问题**：`sourceProjectId` 是唯一产品关联，检索只过滤当前 projectId + global（[knowledge-retrieval.service.ts:37-42](../apps/api/src/knowledge/knowledge-retrieval.service.ts)）。新建项目检索不到已有产品的项目级知识。
- **改动**（二选一，推荐 A）：
  - **A. 引入 `productId`/`systemId` 共享轴**：`KnowledgeItem` 加 `sourceProductId String?` + FK 到新 `Product` 表（或复用现有概念）；检索 where 增加 `sourceProductId IN (当前项目所属产品集 + 共享产品集)`。多条目可挂同一产品，跨项目沿用。
  - **B. 允许 `sourceProjectId` 指向非当前项目** + 检索时纳入"可沿用项目白名单"。改动小但语义弱。
- **验收**：产品 A 的架构知识（`sourceProductId=A`）在产品 A 的新项目里可被语义检索命中。

### P1 — 核心决策与联网协同

#### P1-1 决策规则入库 + `requirementMode` 驱动分支
- **问题**：需求②③④的判断逻辑硬编码在 [deerflow-runtime.service.ts:431](../apps/api/src/ai/deerflow-runtime.service.ts) prompt；三分类把"全新系统"并进 `new_capability`；`requirementMode` 不被消费。
- **改动**：
  1. KnowledgeType 新增 `product_architecture` / `page_inventory` / `ui_style_guide`（含 tab 栏）/ `prototype_asset_ref`（[schema.prisma:205](../packages/db/prisma/schema.prisma)）。
  2. 把"新功能 vs 全新系统 vs tab 栏沿用 vs 无 tab 重做"规则从 prompt 移入 KB 条目（`strong_rule`/`prototype_rule`/`ui_style_guide`），prompt 只引用。
  3. 扩 `requirementMode` 为 `historical_extension | new_feature_on_existing | brand_new_system`，**让代码消费它**：不同 mode 检索不同 type 集（全新系统→`product_architecture`+`page_inventory`；新功能→该产品 `prototype_asset_ref`）。
- **验收**：触发一次"全新系统"请求，断言检索了 `product_architecture` 而非 `prototype_asset_ref`；规则条目修改后行为变化无需改代码。

#### P1-2 KB 检索暴露置信度信号
- **问题**：score 算了但 [toReference:157](../apps/api/src/knowledge/knowledge-retrieval.service.ts) 丢弃，agent 拿不到"KB 没有"信号。
- **改动**：
  1. `KnowledgeReference`（[knowledge.types.ts:33](../apps/api/src/knowledge/knowledge.types.ts)）加 `score?` / `topScore?` / `matchedCount?`。
  2. [vibe.service.ts:513](../apps/api/src/ai/vibe.service.ts) 注入 context 时带上 `topScore`/`matchedCount`/`isEmpty`（[deerflow-runtime.service.ts:399-443](../apps/api/src/ai/deerflow-runtime.service.ts) context 结构）。
  3. 区分检索失败 vs 空召回（去掉 [vibe.service.ts:520](../apps/api/src/ai/vibe.service.ts) 静默吞错，向 agent/前端透出"检索失败"）。
- **验收**：低置信（topScore < 阈值或 matchedCount=0）时 context JSON 带显式信号；检索服务挂掉时前端显示"检索失败"而非"未召回"。

#### P1-3 联网搜索落地 + 沉淀链路
- **问题**：联网 tool 不存在；candidate 无 web 来源。
- **改动**：
  1. DeerFlow 侧注册 web_search tool + [SKILL.md](../integrations/deerflow/skills/ai-product-workbench/SKILL.md) allowed-tools 声明（本仓库无法独立完成，需协同 DeerFlow）。
  2. `KnowledgeCandidateSource` 枚举加 `web_search`（[schema.prisma:241](../packages/db/prisma/schema.prisma)）。
  3. 打通"联网结果 → KnowledgeCandidateDraft → createMany → 审批入库"沉淀链路（[knowledge-candidate.service.ts:41-111](../apps/api/src/knowledge/knowledge-candidate.service.ts)）。
- **验收**：联网抓回的内容可沉淀为 candidate，审批后成为 KB 条目，下次同类问题不再联网（命中本地）。

#### P1-4 图片知识通路
- **问题**：[file-parser.service.ts:187](../apps/api/src/files/file-parser.service.ts) 不做 OCR/视觉描述；`KnowledgeItem.content` 纯文本；嵌入只吃文本。原型图无法入 KB。
- **改动**（二选一）：
  - **A. 视觉模型描述 + 文本嵌入**：上传原型图时调视觉模型生成结构化描述（页面布局/组件/tab 栏/字段），描述进 `KnowledgeItem.content` 再嵌入。成本低、与现有文本检索兼容。
  - **B. 多模态嵌入**：`embedText` 扩展支持 image input（[knowledge-embedding.service.ts:55-80](../apps/api/src/knowledge/knowledge-embedding.service.ts)），`KnowledgeItem` 加 `imageRef`。检索精度高但依赖多模态嵌入模型。
- **验收**：上传一张带 tab 栏的原型图，描述/嵌入后能被"tab 栏样式"类 query 语义召回。

### P2 — 规模与治理（规模即崩或引用完整性）

| # | 问题 | 改动位置 |
|---|---|---|
| P2-1 | 无 pgvector/ANN，全表拉内存 JS 算余弦（O(N)） | 迁移 embedding 至 `vector(dim)` + HNSW/IVFFlat，`<=>` 排序 + LIMIT 下推 |
| P2-2 | prompt 注入全量未截断、无 token 预算 | [deerflow-runtime.service.ts:410,449](../apps/api/src/ai/deerflow-runtime.service.ts) 加单项上限 + 全局预算，超预算按分降序丢低分项，优先用 `snippet` |
| P2-3 | 无真实阈值地板（0.18 仅标注不过滤） | [knowledge-retrieval.service.ts:53,134](../apps/api/src/knowledge/knowledge-retrieval.service.ts) 引入可配置最低综合分 |
| P2-4 | `cosineSimilarity` 取 `Math.min` 长度掩盖维度漂移 | [knowledge-embedding.service.ts:123-135](../apps/api/src/knowledge/knowledge-embedding.service.ts) 记录维度/模型，不匹配报错而非截断 |
| P2-5 | `sourceProjectId` 软引用无 FK，软删项目仍被检索命中 | [schema.prisma:953](../packages/db/prisma/schema.prisma) 加 `@relation` + 检索 join 校验项目状态 |
| P2-6 | `KnowledgeVersion` 无 `@@unique` + 写入未事务化，版本号竞态 | [schema.prisma:989-1002](../packages/db/prisma/schema.prisma) + [knowledge-item.service.ts:164-183](../apps/api/src/knowledge/knowledge-item.service.ts) 加 unique + 事务 |
| P2-7 | tags 自由 JSONB + 内存过滤破坏分页 | 加 GIN 索引 + Prisma `array_contains` 下推，或重建标签表 |
| P2-8 | 无 `metadata`/`language`/`expiresAt`，模型僵硬；无 stale 复审 | [schema.prisma:940-970](../packages/db/prisma/schema.prisma) 加扩展列 + `lastReviewedAt` |
| P2-9 | KnowledgeType 7 值 enum 在 4+ 处硬编码 switch 无完备性保证 | [ai-vibe.types.ts:22-33](../apps/api/src/ai/ai-vibe.types.ts) 改 `Record<KnowledgeType, ...>` 表驱动 |
| P2-10 | `sourceFileId` 一列两域（UUID vs 路径）；`sourceKnowledgeId` 混 UUID 与 `vibe:*` 语义串 | 拆类型联合 / 加 origin 枚举字段 |
| P2-11 | config-knowledge 与 content-knowledge 同表，prompt 逻辑硬编码 | 引入 `prompt_template`/`few_shot` 类型或独立模型，可版本化/热替换 |

### P3 — 运营与可观测（把"能跑"变成"能运营改进"）

| # | 问题 | 改动位置 |
|---|---|---|
| P3-1 | 检索日志写而不读，无 eval/指标 | [knowledge-retrieval.service.ts:57-68](../apps/api/src/knowledge/knowledge-retrieval.service.ts) 建消费侧：零召回率/top query/命中率端点 |
| P3-2 | `matchedKnowledgeIds` 与 `selectedKnowledgeIds` 恒等（slice 在前） | [knowledge-retrieval.service.ts:65-66](../apps/api/src/knowledge/knowledge-retrieval.service.ts) matched 取 slice 前、selected 取 slice 后 |
| P3-3 | vault 同步 N+1 串行无批处理 | [obsidian-vault.service.ts:326-415](../apps/api/src/knowledge/obsidian-vault.service.ts) 批量 upsert + 有界并发 embedding + 事务内错误捕获 |
| P3-4 | QA 规则合规用 `content.slice(0,12)` 子串匹配 JSON | [qa-rule-check.service.ts:215-230](../apps/api/src/ai/qa-rule-check.service.ts) 改用 `knowledgeRefsUsed` 交叉校验或 embedding 语义判定 |
| P3-5 | 无硬删/恢复端点；listItems 内存过滤分页 | [knowledge-admin.controller.ts:23-138](../apps/api/src/knowledge/knowledge-admin.controller.ts) 加 DELETE/restore + tag 过滤下推 |
| P3-6 | 无 KB 级统计，dashboard 仅 1 指标 | [admin.service.ts:55-91](../apps/api/src/knowledge/admin.service.ts) 加按 type/status/scope 计数、缺嵌入项数、检索量端点 |
| P3-7 | 版本历史只写不读，无 GET/diff/revert | [knowledge-admin.controller.ts](../apps/api/src/knowledge/knowledge-admin.controller.ts) 加 versions 读端点 + revert |
| P3-8 | 补 `(scope, source_project_id)` 复合索引 | migration `20260621012000` |

### P4 — 长期演进（minor/nit）

- 中文分词用 jieba/ICU 替换正则 + 硬编码词典 + 28 token 上限（[knowledge-retrieval.service.ts:175-282](../apps/api/src/knowledge/knowledge-retrieval.service.ts)）。
- 引入 BM25/TF-IDF 替换加法权重 keyword scorer + cross-encoder rerank 二阶段。
- 长知识项分块嵌入 + multi-vector max-pooling。
- 统一 `runtimeName`→`agent_name` 命名（跨 3 模型）。

> **已删除**：原审计 P4 的"规划多租户/画布结构化"——与需求⑥冲突，画布只是前端展示。

---

## 4. 设计亮点（保留勿动）

- Phase 5 死表/死列清理真实有效（`knowledge_tags`、`file_assets.parse_result_id`）。
- FK 删除策略刻意且一致（category SetNull / parent SetNull / version Cascade / candidate RESTRICT）。
- 候选入库治理完善（pending 门禁 + QA 门禁 + 强制拒绝理由 + 审计）。
- 全量版本快照（`createVersionSnapshot` 存完整 `toItem()` JSON）。
- 嵌入禁用时诚实的优雅降级（docstring 明确反"伪装 enabled"模式）。
- vault 同步幂等 + 变更检测（stable `vault_<sha1>` ID + `hasKnowledgeChanged` 闸门）。
- 生成路径非阻塞隔离（检索 try/catch 不阻断生成）。
- KB admin 全类级 `@Roles(admin)` 门禁，无未鉴权端点。
- 生成与 QA 上游均校验 `project.ownerId`，关闭跨项目读向量。

---

## 5. 推进建议

**建议进入当前迭代的最小集**：P0-2、P0-3、P1-1、P1-2。P0-1 已澄清为现有链路能力，不再作为新增实现项；当前最需要优先保障的是主力导入内容可嵌入、跨产品召回可用、设计资产类型可召回，以及置信度信号可供 agent 决策。

**第二个迭代**：P1-1、P1-2（让"判断"真正起作用 + 为联网决策铺信号），P1-4（图片通路，解锁"沿用原型图"）。

**第三个迭代**：P1-3（需协同 DeerFlow 侧，周期长，宜早启动设计、晚落地），P2 规模护栏按检索量增长择机。

**净评估**：知识库设计是"好骨架 + 五条核心断链 + 一组可纠正的扩展裂缝"。P0 三条即可让需求主干成立；P1 让决策与协同真正运转；P2/P3 把"能跑"变成"能规模化运营改进"。
