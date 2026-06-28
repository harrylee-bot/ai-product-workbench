# 最新版知识库接入指南

> 适用范围：PR #2 当前实现（Product 维度、产品级知识范围、检索置信度信号、非 vault 路径嵌入同步、DeerFlow 生成上下文增强）。
>
> 目标读者：后端业务服务、DeerFlow / agent 接入方、管理端、部署运维。

---

## 1. 一句话概念模型

最新版知识库不再只是“全局规则库”，而是三层召回：

```text
全局知识 global
  + 当前项目知识 project(sourceProjectId = 当前 projectId)
  + 当前产品知识 product(sourceProductId = 当前项目绑定的 productId)
```

生成 PRD / 原型时，系统会在 `VibeService.runDeerFlowTurn` 中先调用知识检索，把召回结果注入 DeerFlow 的 `knowledgeContext`，DeerFlow 再基于这些知识判断：

- 是历史功能增量（沿用原产品架构/原型/样式）；
- 是既有产品里的新能力（复用产品架构与页面框架）；
- 是全新系统（有 tab 栏则沿用 tab 样式，无 tab 栏可完全重做）；
- 是一句话需求补全。

关键代码：

- 检索服务：[apps/api/src/knowledge/knowledge-retrieval.service.ts](../apps/api/src/knowledge/knowledge-retrieval.service.ts)
- 检索类型定义：[apps/api/src/knowledge/knowledge.types.ts](../apps/api/src/knowledge/knowledge.types.ts)
- 生成路径注入：[apps/api/src/ai/vibe.service.ts](../apps/api/src/ai/vibe.service.ts)
- DeerFlow prompt contract：[apps/api/src/ai/deerflow-runtime.service.ts](../apps/api/src/ai/deerflow-runtime.service.ts)
- Product 管理 API：[apps/api/src/products/product.controller.ts](../apps/api/src/products/product.controller.ts)

---

## 2. 数据模型怎么接

### 2.1 Product

新增 `Product` 模型，用来表示“可被多个项目复用的一套产品/系统”。

核心字段：

```prisma
model Product {
  id             String          @id @default(cuid())
  name           String
  description    String?
  createdBy      String          @map("created_by")
  projects       Project[]
  knowledgeItems KnowledgeItem[]
}
```

### 2.2 Project 绑定 Product

`Project` 新增：

```prisma
productId String?  @map("product_id")
product   Product? @relation(fields: [productId], references: [id], onDelete: SetNull)
```

含义：一个项目可以绑定到一个产品。绑定后，生成时会自动召回同产品下的产品级知识。

### 2.3 KnowledgeItem 绑定 Product

`KnowledgeItem` 新增：

```prisma
scope           KnowledgeScope @default(global)
sourceProjectId String?        @map("source_project_id")
sourceProductId String?        @map("source_product_id")
product         Product?       @relation(fields: [sourceProductId], references: [id], onDelete: SetNull)
```

`KnowledgeScope` 现在有：

```prisma
global
project
product
```

推荐语义：

| scope | 用途 | 召回条件 |
|---|---|---|
| `global` | 全系统通用规则、写作规范、通用案例 | 所有项目都可召回 |
| `project` | 单项目上下文，临时或高度项目化知识 | `sourceProjectId = 当前 projectId` |
| `product` | 某产品/系统的架构、页面清单、UI 样式、历史原型资产 | `sourceProductId = 当前项目 productId` |

### 2.4 新增设计资产 KnowledgeType

新增 4 个知识类型：

| KnowledgeType | 应存什么 |
|---|---|
| `product_architecture` | 产品架构、模块关系、能力地图、核心对象 |
| `page_inventory` | 页面清单、导航结构、tab 栏结构、页面归属 |
| `ui_style_guide` | UI 样式规范、组件规范、tab 栏样式、布局约定 |
| `prototype_asset_ref` | 历史原型资产引用、已有页面原型描述、可复用交互案例 |

原有类型仍保留：`strong_rule`、`default_rule`、`reference_case`、`design_pattern`、`prd_writing_rule`、`prototype_rule`、`business_concept`。

---

## 3. 后端业务怎么写入知识

### 3.1 管理端直接创建知识

入口：`POST /admin/knowledge/items`

关键 DTO：[CreateKnowledgeItemDto](../apps/api/src/knowledge/knowledge.dto.ts)

建议写产品级知识时传：

```json
{
  "title": "CRM 产品 tab 栏样式规范",
  "content": "CRM 后台一级 tab 使用 ...",
  "type": "ui_style_guide",
  "scope": "product",
  "sourceProductId": "<productId>",
  "priority": "high",
  "tags": ["tab栏", "CRM", "样式规范"]
}
```

注意：

- `scope = product` 时必须传 `sourceProductId`。
- 创建后会自动调用 `KnowledgeEmbeddingService.syncItem`，使其进入语义检索。
- 如果 embedding 环境变量没配置，`syncItem` 会返回 skipped，不会阻断创建。

### 3.2 候选知识审批入库

入口：

- `POST /admin/knowledge/candidates/:candidateId/approve`
- `POST /admin/knowledge/candidates/:candidateId/merge`

当前行为：

1. 候选知识来自 PRD、原型、产品设计状态、对话、上传文件等路径。
2. approve 时会查询候选所属项目的 `productId`。
3. 如果项目绑定了 Product，则新知识入为：

```text
scope = product
sourceProjectId = candidate.projectId
sourceProductId = project.productId
```

4. approve / merge 后都会自动同步 embedding。

这意味着：通过 codex / 上传文档 / 其他 PM 需求文档抽取出来的知识，审批后会变成可语义检索的产品级知识。

### 3.3 Obsidian vault 同步

入口：`POST /admin/knowledge/vault/sync`

同步逻辑会根据路径/标题/标签自动推断 KnowledgeType。新版增加这些映射：

| 路径/关键词 | 推断类型 |
|---|---|
| `08-产品架构/`、产品架构、能力地图、核心对象 | `product_architecture` |
| `09-页面清单/`、页面清单、信息架构、导航结构、tab 栏 | `page_inventory` |
| `10-UI样式规范/`、UI 样式、组件样式、tab 栏样式 | `ui_style_guide` |
| `11-原型资产/`、原型资产、页面原型、历史原型 | `prototype_asset_ref` |

文件：

- [apps/api/src/knowledge/obsidian-vault.service.ts](../apps/api/src/knowledge/obsidian-vault.service.ts)

---

## 4. 后端业务怎么检索知识

统一入口：

```ts
KnowledgeRetrievalService.search(input: KnowledgeSearchInput): Promise<KnowledgeSearchOutput>
```

类型定义：

```ts
export type KnowledgeSearchInput = {
  projectId?: string;
  productId?: string;
  conversationId?: string;
  runId?: string;
  runtimeName?: string;
  query: string;
  taskType?: ModelTaskType | string;
  preferredTypes?: KnowledgeType[];
  strictPreferredTypes?: boolean;
  limit?: number;
};
```

### 4.1 推荐调用方式

如果调用方在项目上下文里，直接传 `projectId` 即可：

```ts
const retrieval = await knowledgeRetrieval.search({
  projectId,
  conversationId,
  runId,
  runtimeName: "runtime_generation",
  query: userMessage,
  limit: 8,
  preferredTypes: [
    KnowledgeType.strong_rule,
    KnowledgeType.default_rule,
    KnowledgeType.design_pattern,
    KnowledgeType.prd_writing_rule,
    KnowledgeType.prototype_rule,
    KnowledgeType.business_concept,
    KnowledgeType.reference_case,
    KnowledgeType.product_architecture,
    KnowledgeType.page_inventory,
    KnowledgeType.ui_style_guide,
    KnowledgeType.prototype_asset_ref,
  ],
});
```

`search` 会自动：

1. 用 `projectId` 查询 `Project.productId`；
2. 召回：
   - `scope=global`
   - `scope=project && sourceProjectId=projectId`
   - `scope=product && sourceProductId=productId`
3. 计算 keyword score + semantic score；
4. 返回分数、命中数和错误信息。

如果调用方没有 `projectId`，但已经知道产品 ID，也可以直接传 `productId`。

### 4.2 strictPreferredTypes

默认 `preferredTypes` 是软偏好：命中指定类型会加分，但不会过滤掉其他类型。

如果只想要某几类知识，传：

```ts
strictPreferredTypes: true
```

例如只找 UI 样式：

```ts
await knowledgeRetrieval.search({
  projectId,
  query: "tab 栏样式",
  preferredTypes: [KnowledgeType.ui_style_guide],
  strictPreferredTypes: true,
  limit: 5,
});
```

### 4.3 返回值怎么用

```ts
export type KnowledgeSearchOutput = {
  results: KnowledgeRetrievalResult[];
  references: KnowledgeReference[];
  topScore?: number;
  matchedCount: number;
  selectedCount: number;
  retrievalError?: string;
};
```

推荐接入判断：

| 情况 | 判断 |
|---|---|
| `retrievalError` 有值 | 检索失败，应该降级，但不要当成“知识库没有” |
| `selectedCount === 0` 且无 error | 真正空召回，可让 agent 自主考虑联网搜索 |
| `topScore` 很低 | 低置信召回，可让 agent 谨慎使用或联网补全 |
| `matchedCount > selectedCount` | 有更多候选被截断，可考虑增大 limit 或 rerank |

`references` 是推荐给 prompt / agent 的结构：

```ts
{
  id,
  knowledgeId,
  title,
  snippet,
  content,
  type,
  score,
  semanticScore,
  reason,
  sourceType,
  sourceId
}
```

---

## 5. DeerFlow / agent 怎么对接

### 5.1 当前系统已经做了生成前检索

生成入口在 [VibeService.runDeerFlowTurn](../apps/api/src/ai/vibe.service.ts)。

当前流程：

```text
用户消息
  → VibeService.runDeerFlowTurn
  → KnowledgeRetrievalService.search
  → knowledgeContext 注入 DeerFlow prompt
  → DeerFlow lead agent 生成 PRD/原型/答复
  → finalAction 落库
```

DeerFlow 收到的 `knowledgeContext` 已包含：

```ts
{
  id,
  title,
  snippet,
  content,
  type,
  score,
  semanticScore,
  reason
}
```

### 5.2 DeerFlow 必须遵守的 requirementMode

DeerFlow final action 里应返回：

```json
{
  "requirementMode": "historical_extension | new_capability | brand_new_system | one_sentence_completion",
  "knowledgeRefsUsed": ["引用过的知识标题或路径"]
}
```

含义：

| requirementMode | 含义 | 应如何使用知识 |
|---|---|---|
| `historical_extension` | 在已有产品/页面上加功能或改功能 | 尽量沿用 `prototype_asset_ref`、`ui_style_guide`、`page_inventory` |
| `new_capability` | 既有产品里的新能力 | 复用 `product_architecture` 与平台页面框架 |
| `brand_new_system` | 完全新系统/新页面 | 有 tab 栏则沿用 `ui_style_guide` 的 tab 样式；无 tab 栏可重新设计 |
| `one_sentence_completion` | 一句话补全 | 用产品架构、业务概念、历史案例推断普通细节 |

这些规则已写入 [deerflow-runtime.service.ts](../apps/api/src/ai/deerflow-runtime.service.ts) 的 `finalActionContract.constraints`。

### 5.3 联网搜索如何接

当前仓库内**没有** web search tool。推荐接法：

1. DeerFlow 侧注册 `web_search` 工具。
2. DeerFlow 看到：
   - `selectedCount === 0`；或
   - `topScore` 低；或
   - 用户问题明显需要最新产品/技术信息；
   时，自主调用 `web_search`。
3. 搜索结果用于本轮生成。
4. 如需要沉淀，后续扩展 `KnowledgeCandidateSource.web_search`，走候选审批入库。

注意：不要把 `retrievalError` 当成“知识库没有”。有 `retrievalError` 表示系统故障或日志写入失败，应降级并记录。

---

## 6. 管理端 / API 怎么对接 Product

Product 管理 API：

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/admin/products` | 创建产品 |
| `GET` | `/admin/products` | 列表 |
| `GET` | `/admin/products/:productId` | 详情 |
| `PATCH` | `/admin/products/:productId` | 更新名称/描述 |
| `DELETE` | `/admin/products/:productId` | 删除产品；关联项目/知识会 `SET NULL` |

鉴权：`JwtAuthGuard + RolesGuard + admin`。

Project 绑定 Product：

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/projects` | 创建项目时可传 `productId` |
| `PATCH` | `/projects/:projectId` | 更新项目 `title` / `description` / `productId` |

示例：

```json
PATCH /projects/:projectId
{
  "productId": "<productId>"
}
```

绑定后，该项目生成时会自动召回同 Product 的产品级知识。

---

## 7. 嵌入服务怎么配置

嵌入服务由 [KnowledgeEmbeddingService](../apps/api/src/knowledge/knowledge-embedding.service.ts) 使用环境变量控制：

```bash
EMBEDDING_API_BASE_URL=...
EMBEDDING_API_KEY=...
EMBEDDING_MODEL=...
```

三者都存在时，embedding 才启用。

行为：

- 未配置：`syncItem` 返回 skipped，不阻断写入。
- 调用失败：返回 failed，不抛异常，不阻断写入。
- 成功：更新 `knowledge_items.embedding`。

会触发嵌入同步的路径：

| 写入路径 | 是否同步 embedding |
|---|---|
| `KnowledgeItemService.createItem` | 是 |
| `KnowledgeItemService.updateItem` 内容相关字段变化 | 是 |
| `KnowledgeCandidateService.approveCandidate` | 是 |
| `KnowledgeCandidateService.mergeCandidate` | 是 |
| Obsidian vault sync | 是 |
| enable/disable | 否，状态变化不重嵌 |
| createMany candidate | 否，候选未入库前不嵌 |

---

## 8. 部署 / 迁移 checklist

发布最新版知识库前，按以下顺序执行：

1. 确保环境有：

```bash
DATABASE_URL=...
```

2. 应用 Prisma migration：

```bash
npm run db:migrate -- --name kb_redesign_product_and_types
```

3. 生成 Prisma client：

```bash
npm run db:generate
```

4. 构建与测试：

```bash
npm run build
npm test
```

5. 配置 embedding 环境变量（可选但推荐）：

```bash
EMBEDDING_API_BASE_URL=...
EMBEDDING_API_KEY=...
EMBEDDING_MODEL=...
```

6. 初始化产品维度：

```text
创建 Product → 把相关 Project 绑定 productId → 导入/审批产品级知识
```

7. 核验一次生成链路：

```text
发起生成 → SSE knowledge_retrieval step 应返回 matchedCount / selectedCount / topScore
```

---

## 9. 推荐接入流程：从其他 PM 文档到可复用知识

```text
1. 创建 Product，例如 “CRM 后台”
2. 创建或更新 Project，绑定 productId
3. 上传其他 PM 的需求文档/原型资料
4. 系统抽取 KnowledgeCandidate
5. 管理员审核 approve
6. approve 后：
   - 若项目绑定 Product → KnowledgeItem.scope = product
   - sourceProductId = project.productId
   - 自动 sync embedding
7. 后续该产品下任意项目生成 PRD/原型时，自动召回这些知识
```

建议沉淀为这些类型：

| 内容 | 类型 |
|---|---|
| 产品结构、模块、核心对象 | `product_architecture` |
| 页面列表、导航、tab 栏位置 | `page_inventory` |
| tab 栏样式、组件样式、布局规范 | `ui_style_guide` |
| 历史页面原型、交互描述 | `prototype_asset_ref` |
| PRD 写作规则 | `prd_writing_rule` |
| 原型输出规范 | `prototype_rule` |
| 不能违反的约束 | `strong_rule` |

---

## 10. 当前未完成但要预留的接口

### 10.1 联网搜索

仓库内尚未实现 web search tool。需要 DeerFlow 侧接入。

建议未来新增：

- `KnowledgeCandidateSource.web_search`
- `web_search` 工具结果转候选知识的 createMany 链路
- 基于 `topScore / selectedCount / retrievalError` 的 agent 决策策略

### 10.2 图片 / 原型图视觉理解

当前图片解析仍不做 OCR/视觉理解。要让“原型图”真正变成知识，需要：

1. 上传图片后调用视觉模型；
2. 输出结构化页面描述、tab 栏、组件样式、布局；
3. 存为 `prototype_asset_ref` 或 `ui_style_guide`；
4. 自动同步 embedding。

### 10.3 两段式 requirementMode 检索

当前 `requirementMode` 是生成后返回的字段，无法在同一轮生成前驱动检索。

未来如需更强控制，可改为：

```text
第一段：轻量分类 requirementMode
第二段：按 requirementMode 定向检索
第三段：生成 PRD/原型
```

---

## 11. 最小接入范例

### 创建产品并绑定项目

```bash
POST /admin/products
{
  "name": "CRM 后台",
  "description": "销售线索、客户、商机、合同相关后台"
}
```

```bash
PATCH /projects/:projectId
{
  "productId": "<productId>"
}
```

### 创建产品级 UI 样式知识

```bash
POST /admin/knowledge/items
{
  "title": "CRM 后台 tab 栏样式",
  "content": "一级 tab 使用顶部横向 tabs，选中态为...",
  "type": "ui_style_guide",
  "scope": "product",
  "sourceProductId": "<productId>",
  "priority": "high",
  "tags": ["tab栏", "CRM", "UI样式"]
}
```

### 业务代码检索

```ts
const retrieval = await knowledgeRetrieval.search({
  projectId,
  query: "在客户详情页增加跟进记录 tab",
  preferredTypes: [
    KnowledgeType.product_architecture,
    KnowledgeType.page_inventory,
    KnowledgeType.ui_style_guide,
    KnowledgeType.prototype_asset_ref,
  ],
  limit: 8,
});

if (retrieval.retrievalError) {
  // 系统故障降级，不要当成知识不存在
}

if (!retrieval.selectedCount) {
  // 真空召回，可交给 agent 判断是否联网
}
```

---

## 12. 验收标准

对接完成后，至少验证：

1. Product 创建成功。
2. Project 能绑定 `productId`。
3. 产品级 KnowledgeItem 创建后 `scope=product`、`sourceProductId` 正确。
4. embedding 环境变量配置后，写入知识能生成 `embedding`。
5. 同 Product 下另一个 Project 的生成请求能召回该产品级知识。
6. `knowledge_retrieval` SSE 事件里有：
   - `knowledgeHitCount`
   - `topScore`
   - `matchedCount`
   - `selectedCount`
   - `retrievalError`
7. DeerFlow final action 能返回并持久化：
   - `requirementMode`
   - `knowledgeRefsUsed`
