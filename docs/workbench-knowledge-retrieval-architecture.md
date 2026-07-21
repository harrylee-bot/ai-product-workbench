# 产品工作台知识检索与不可变 Profile 方案

更新日期：2026-07-15
状态：仓库内主链已实现；生产模型采用仍取决于固定中文评测集

## 结论

知识库是唯一迁移的既有业务资产，不能让临时的 `vector(1536)`、某个供应商别名或 OpenAI tokenizer 成为长期事实源。

最终方案是：

1. 删除 `KnowledgeChunk.embedding vector(1536)` 与 `embeddingModel`。
2. 新建一等 `EmbeddingProfile` 和独立 `KnowledgeChunkEmbedding` 表；内容 chunk 与向量实现分离。
3. 首选 PoC 为 `Qwen/Qwen3-Embedding-0.6B` 全维 1024 + Hugging Face Text Embeddings Inference（TEI）。
4. `BAAI/bge-m3` 作为必须比较的 1024 维基线，不凭公开榜单直接采用。
5. reranker 独立使用 `BAAI/bge-reranker-v2-m3` + TEI `/rerank`，不写入 EmbeddingProfile；更换 reranker 不触发无意义的全量重嵌入。
6. 中文 lexical 使用 `jieba-wasm + PostgreSQL simple FTS`；dense 与 lexical 用 RRF 合并，不直接相加不可比的原始分数。
7. DeerFlow 只能取得已 pin KnowledgeRelease 的 citation-ready 检索结果或短期签名的本地检索 tool grant，不能只收到一个数据库 ID 后自行越权查询。
8. v1 支持第三方 embedding 服务，但必须通过独立 adapter 创建新的不可变 profile；可变的 `latest` 模型名不能伪装成同一 revision。

推荐组件均可免费自托管。没有 SDK 或模型调用许可费，实际成本是 CPU/GPU、内存、存储、运维，以及选择第三方托管服务时的调用费。

## 当前事实

- Vault 当前有 85 个 Markdown：34 个 production、43 个 source lookup、6 个 excluded、2 个 quarantine。
- 历史 800-token 配置下约 542 chunks、105,065 个 `o200k_base` token；该数字仅用于迁移规模估算，不是生产切分事实。
- 当前已完成 EmbeddingProfile、独立向量表、release profile pin、持久化 embedding batch、TEI adapter 和数据库完整性 finalizer；这些能力已通过模拟 provider 故障与真实 PostgreSQL 崩溃重放，但尚未用最终候选模型完成评测和生产验收。
- `KnowledgeRelease` 通过五列复合外键同时固定 RetrievalProfile ID/spec SHA-256 与 embedding profile ID/spec SHA-256/dimension；manifest 固定同一身份，Run 和 ArtifactVersion 经不可变 release 保留传递 pin。
- `EmbeddingProfile v1` 严格合同与 RFC 8785 `specSha256` 已实现；数据库已删除 `KnowledgeChunk.embeddingModel` 与临时 `vector(1536)`，改为独立、无 typmod 的 `KnowledgeChunkEmbedding`。
- 数据库已用 `(documentId, releaseId)`、`(chunkId, releaseId)`、`(profileId, specSha256, dimension)` 和 release/profile 复合外键证明归属，并约束实际向量维度、L2 norm、profile 生命周期、batch 状态机以及已发布 release/batch/embedding 不可变。
- 当前尚未登记任何通过中文评测后进入 `adopted` 的生产 profile，也没有部署固定权重、revision 和镜像 digest 的生产 TEI；因此代码链路完成不等于 dense 检索已可用。
- File Worker 已改为启动时加载本地 Hugging Face `tokenizer.json` + `tokenizer_config.json`，用两份文件的 canonical artifact SHA-256 与 EmbeddingProfile pin 做 fail-closed 校验；切分上限直接取 profile 的 `chunkMaximumTokens`，不再存在独立 token ceiling。TEI adapter 仍会调用 `/tokenize` 精确复核单条与整批 token 上限。
- 产品工作台已有 citation-ready 检索 service、参数化 PostgreSQL lexical/dense candidate store、profile 驱动 RRF、TEI query embedding/reranker adapter、capability ledger 与 DeerFlow trusted citation tool。生产 adopted 模型、可达部署和质量评测未完成，因此仍不能宣称生产 dense 检索已验收。
- 本地 `storage/` 约 5.2 GiB，包含旧对话与烟测数据，不能整体视为知识资产迁移。

## 已落地基础与验证

截至 2026-07-15，以下基础切片已落地：

1. `packages/workbench-knowledge` 提供 `parseEmbeddingProfileV1`，严格拒绝未知字段、可变 revision 别名、未固定镜像 digest、非法 token/batch 上限和非 v1 输出语义；返回冻结的 canonical spec、维度和 RFC 8785 SHA-256。
2. 迁移 `20260714174500_knowledge_embedding_profiles` 新建 `EmbeddingProfile` 与 `KnowledgeChunkEmbedding`，并物理移除 chunk 上的供应商模型列和 1536 维向量列。
3. 迁移 `20260714183000_knowledge_embedding_batches` 强制绿地重建旧 release，新增 release profile pin、`chunksReadyAt` 和 durable batch 状态机；同一 release 的 chunk 不能跨 batch 重复。
4. File Worker 已实现 `stage chunks -> assert TEI profile -> claim/embed/publish batch -> finalize`，provider 单次请求无隐式重试，408/429/5xx 交给 pg-boss delivery 重投，lease heartbeat 与数据库 CAS 负责并发和崩溃恢复。
5. TEI adapter 会校验 `/info` 的模型 ID、revision、TEI 版本、容量与 `auto_truncate=false`，通过 `/tokenize` 精确核对 token，再校验 `/embed` 数量、维度、有限 float32 值、L2 norm、响应编码和请求/响应字节上限。
6. 真实 PostgreSQL 已验证混合维度、profile/归属约束、batch 状态机、首批成功后第二批 503 恢复、提交成功但响应丢失的幂等重放，以及只有所有 batch/embedding 完整时 release 才能进入 `ready`。
7. API 内部检索切片已实现授权后的 workspace/project scope、`production`/显式 `source_lookup` route、lexical/dense 各 top 40、`RRF(k=60)`、确定性 tie-break、稳定 citation locator 和独立 reranker port；reranker 请求或输出失败会返回显式 degraded evidence。独立 PostgreSQL 用例覆盖跨 workspace 隔离、release/profile/dimension pin、route 泄漏为零和维度漂移拒绝。
8. 迁移 `20260715100000_retrieval_profiles` 新建 RetrievalProfile 状态机与不可变 spec；KnowledgeRelease 使用五列复合 FK 同时固定 retrieval/embedding identity，旧知识投影必须从 `knowledge-vault` 重建，不提供兼容回填。
9. 查询参数由 RetrievalProfile 的 lexical/dense limit、RRF `k`、rerank candidate/final limit 派生；readiness 会校验 canonical profile、manifest、Jieba、embedding/reranker config 与 `/info` identity。capability 只对当前 RuntimeAttempt 开放，并有持久化预算、并发、重试与幂等 receipt。

这些切片完成了长期事实模型、可恢复 embedding 写入、不可变 RetrievalProfile、混合查询、受限工具调用和模型原生 tokenizer 前置切分，但不改变后续门禁：真实模型评测、production adopted profile、固定权重/revision/image digest、真实 conformance probe 与真实网络 E2E 全部完成前，不能把 Knowledge 链路宣称为生产 dense 检索。

## 目标拓扑

```text
knowledge-vault + reachable storage assets
        |
deterministic parse / route / chunk / lexical projection
        |
EmbeddingProfile + RetrievalProfile(adopted)
        |
KnowledgeRelease(building, composite pinned)
        |
EmbeddingProfile + TEI adapter -> resumable embedding batches
        |
integrity finalizer -> KnowledgeRelease(ready)
        |
query route filter
  lexical top 40 + dense top 40
        |
  RRF(k=60) -> top 24 -> reranker -> final 10
        |
citation-ready RetrievalResult -> DeerFlow tool grant / Run context
```

TEI 是独立、无公网出口的推理服务。File/Knowledge Worker 负责批处理与重试，API 负责权限和检索工具授权；DeerFlow、Web 和数据库领域对象都不依赖 TEI/OpenAI 的响应类型。

## EmbeddingProfile v1

```ts
type EmbeddingProfileV1 = {
  schema: "workbench.embedding-profile.v1";
  id: string;
  protocol: "tei.embed.v1" | "openai.embeddings.v1";
  engine: {
    id: string;
    version: string;
    imageDigest?: string;
  };
  model: {
    id: string;
    revision: string;
    artifactSha256: string;
  };
  tokenizer: {
    id: string;
    revision: string;
    artifactSha256: string;
    modelMaximumTokens: number;
    chunkMaximumTokens: number;
    overflow: "reject";
  };
  input: {
    queryPrefix: string;
    documentPrefix: string;
    normalization: "utf8-nfc-lf-v1";
  };
  output: {
    dimension: number;
    dtype: "float32";
    pooling: "cls" | "last_token";
    normalization: "l2";
    distance: "cosine";
  };
  batch: {
    maximumInputs: number;
    maximumTokens: number;
  };
  conformanceProbeSha256: string;
};
```

Profile 内容以 RFC 8785/JCS canonical bytes 计算 `specSha256`。同一个 `id` 不得改变 spec；model revision、权重 checksum、tokenizer、prompt、pooling、normalization 或维度任一变化都创建新 profile。

`conformanceProbeSha256` 固定一组中英文输入及期望维度、norm 和相似度矩阵，防止模型服务在镜像或配置升级后静默改变语义。

## RetrievalProfile v1

RetrievalProfile 与 EmbeddingProfile 分离并已作为一等数据库实体落地，固定：

- embeddingProfileId。
- Jieba 版本、`cut_for_search`、`hmm=false`、默认词典、自定义词典与停用词 checksum。
- lexical top 40、dense top 40。
- RRF `k=60`。
- rerank top 24、最终 10 chunks。
- reranker engine/model/revision/tokenizer、最大 token 和失败策略。
- production/source_lookup 路由规则、Workspace/Project scope 与 citation 格式。

状态机固定为 `candidate -> poc -> adopted -> retired`；spec 一经创建不可修改，存在 building release 时不得退休。reranker 失败默认退回 RRF 结果并记录明确 degraded evidence；embedding 服务失败时不允许把不完整 release 发布为 ready。

## 数据库形态

使用一个无 typmod 的 `vector` 列存不同 profile 维度，但每一行必须由 profile 和约束证明维度。不要为每个模型建一张业务表，也不要在一个全局 HNSW 中混入不同向量空间。

```sql
CREATE TABLE embedding_profiles (
  id text PRIMARY KEY,
  spec jsonb NOT NULL,
  spec_sha256 text NOT NULL UNIQUE,
  dimension integer NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, dimension)
);

CREATE TABLE retrieval_profiles (
  id text PRIMARY KEY,
  spec jsonb NOT NULL,
  spec_sha256 text NOT NULL UNIQUE,
  embedding_profile_id text NOT NULL,
  embedding_profile_spec_sha256 text NOT NULL,
  embedding_dimension integer NOT NULL,
  status text NOT NULL,
  UNIQUE (
    id, spec_sha256, embedding_profile_id,
    embedding_profile_spec_sha256, embedding_dimension
  )
);

CREATE TABLE knowledge_chunk_embeddings (
  chunk_id text NOT NULL,
  release_id text NOT NULL,
  profile_id text NOT NULL,
  dimension integer NOT NULL,
  embedding vector NOT NULL,
  embedding_sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chunk_id, profile_id),
  CHECK (vector_dims(embedding) = dimension),
  CHECK (embedding_sha256 ~ '^[0-9a-f]{64}$'),
  FOREIGN KEY (profile_id, dimension)
    REFERENCES embedding_profiles(id, dimension),
  FOREIGN KEY (chunk_id, release_id)
    REFERENCES knowledge_chunks(id, release_id)
);
```

Prisma 继续把 `vector` 作为 `Unsupported("vector")`，相似度查询和约束迁移使用参数化 SQL。`KnowledgeChunk` 已使用非空 `release_id`，并以 `(document_id, release_id)` 复合外键引用 `KnowledgeDocument(id, release_id)`；embedding 表以 `(id, release_id)` 唯一键引用 chunk。这样 chunk、document、release 的归属由数据库证明，不能只靠应用代码相信 join 路径。

当前 542 个向量先在 `release_id + profile_id` 过滤后做精确 cosine 排序。单 release 达到约 50,000 chunks，或实际 p95/CPU 压测证明必要后，才为 adopted profile 增加 partial expression HNSW：

```sql
CREATE INDEX knowledge_embedding_qwen3_1024_hnsw
ON knowledge_chunk_embeddings
USING hnsw ((embedding::vector(1024)) vector_cosine_ops)
WHERE profile_id = 'qwen3-embedding-0.6b-1024-r1'
  AND dimension = 1024;
```

启用 HNSW 后必须证明带 release/profile 过滤时执行计划正确，并相对精确检索达到 `Recall@20 >= 0.99`。

## 构建与恢复

KnowledgeRelease 构建阶段固定为：

```text
building -> chunks_ready -> embedding -> finalizing -> ready
                                      -> failed
```

实现要求：

1. Parse/chunk/FTS 与 embedding batch 都有独立 checkpoint 和租约；Worker 重放继续已有 batch，不重复发布另一套向量。
2. 每批记录 profile、chunk ids、输入 checksum、输出维度和向量 checksum。
3. finalizer 校验所有应嵌入 chunk 均存在、profile/dimension 正确、所有值有限、L2 norm 在容差内、无重复或跨 release 行。
4. 完成 finalizer 前不得把 KnowledgeRelease 标成 ready。
5. 新 profile 或 model revision 创建新 KnowledgeRelease 并全量重嵌入；历史 release 与 Run pin 不原地修改。
6. 构建失败或模型不可用时保留可诊断状态，但不允许 Run 选择半成品 release。

上述 durable batch、lease、checksum、不可变写入、finalizer、RetrievalProfile 状态机、release/manifest pin、授权查询、PostgreSQL 候选、profile 驱动 RRF、query embedding/reranker adapter、citation locator、DeerFlow capability tool 和模型原生 tokenizer 前置切分均已实现。受限运维 KnowledgeRelease 命令也已实现 `key + version` advisory transaction lock、业务行与 pg-boss job 原子提交、adopted profile pin、终态幂等重放和 `exclusive + releaseId singletonKey` 队列断言；使用方式见根 README。仍未完成的门禁是固定候选模型的真实中文质量/延迟评测、production adopted profile 登记、固定权重与镜像、真实 conformance probe、该命令在受控生产凭据下的执行和生产网络验收。部署配置必须显式提供 adopted profile ID/spec SHA-256、TEI URL、镜像 digest 及只读 tokenizer artifact 路径；仓库不提供未经评测的默认模型服务。

## 模型候选

| 候选 | 公布许可证（采用前复核 model card） | revision | v1 用法 | 结论 |
|---|---|---|---|---|
| Qwen3-Embedding-0.6B | Apache-2.0 | PoC 下载时锁定 commit | dense 1024、last-token pooling、L2、query instruction | 首选 PoC |
| BGE-M3 | MIT | PoC 下载时锁定 commit | dense 1024、CLS、L2；不用 sparse/ColBERT 支线 | 必测基线 |
| bge-reranker-v2-m3 | Apache-2.0 | PoC 下载时锁定 commit | 独立 reranker，top 24 -> 8-12 | 首选 PoC |
| TEI | Apache-2.0 | PoC 后固定 image digest | `/embed` 与 `/rerank` 独立实例/模型 | 服务首选 |

本轮执行环境无法连接 Hugging Face 完成在线元数据复核，因此表内许可证按公开 model-card 信息作为候选记录，不作为最终法务证据。PoC 必须在可联网的受控环境下载权重、tokenizer/config，锁定 commit，登记逐文件许可证和 artifact SHA-256，并固定 TEI image digest；任一项未完成都保持 `candidate`。BGE-M3 的 sparse/ColBERT 能力不进入 v1，中文 lexical 继续由 Jieba + PostgreSQL FTS 负责。

第三方供应商通过同一 EmbeddingPort 接入。每个 provider 必须关闭 SDK 隐式重试，重试由 durable queue 管理；供应商请求/响应、计费 ID 和模型别名不得进入 KnowledgeRelease 领域合同。

## 评测门禁

用当前 34 个 production 文档建立至少 100 条人工标注中文查询，覆盖产品术语、缩写、精确字段、自然语言、多义词、表格、中文夹英文和 source lookup。固定比较：

1. Jieba FTS。
2. BGE-M3 dense。
3. Qwen3-Embedding-0.6B dense。
4. 两者各自的 FTS + dense RRF。
5. RRF + bge-reranker-v2-m3。

采用门槛：

- production `Recall@20 >= 0.90`。
- `nDCG@10` 相比 lexical-only 至少提升 3%。
- reranker 不得使关键业务 slice 回退，整体再提升至少 2%。
- production 检索泄漏 source_lookup/excluded/quarantine 必须为 0。
- 固定 probe 的维度、pooling、prompt、norm 和相似度矩阵在容差内。
- 选定硬件、并发 4 时，embedding p95 <= 200 ms，24 passage rerank p95 <= 800 ms，总检索 p95 <= 1.2 s。
- 超时、429/5xx、进程重启、重复 batch 和 finalizer 崩溃均有恢复测试。

任何候选未过门槛都保持 `poc`，不能因为“模型免费”或公开排行榜更高就升为 `adopted`。

仓库提供离线评测合同和 CLI，避免用手工表格或 provider 日志宣称通过。数据集固定 `zh-Hans-CN`、query、route scope、graded relevance 和阈值；结果文件固定 dataset canonical SHA-256、返回项 route 和每条延迟。评测计算 macro `Recall@K`、graded `nDCG@K`、nearest-rank p95，并对 production/source_lookup 的全部返回项执行 route leakage 硬门禁：`source_lookup`、`excluded` 或 `quarantine` 进入 production 结果均失败。

```bash
npm run knowledge:retrieval:eval -- \
  --dataset=packages/workbench-knowledge/test/fixtures/retrieval-evaluation-dataset.v1.json \
  --results=packages/workbench-knowledge/test/fixtures/retrieval-evaluation-results.v1.json \
  --output-dir=storage/evaluation/knowledge-smoke
```

该命令只评估显式提供的结果，不伪造真实模型调用；生产验收应由同一合同接入真实检索函数或固定 provider 输出。当前仓库 smoke fixture 的结果仅证明 runner、阈值和零泄漏门禁可执行，不代表最终模型已 adopted。

## 资产保留

不迁移旧对话、conversation 派生知识、旧 embedding 或整个 `storage/`。迁移闭包只包含：

- `knowledge-vault` 的结构化 Markdown。
- Markdown/index 经过解析后实际引用的 `storage/source-assets` 与 `storage/imports` 文件。
- 每个保留资产的规范路径、media type、byte size、SHA-256 和引用来源。

构建前先执行可达性审计；缺失、越界、符号链接逃逸或 checksum 冲突必须 fail closed。重型原文件继续留在 `storage/`，Vault 只保存结构化索引，不把二进制复制进 Quartz 公共目录。

### 资产闭包审计门禁

`npm run audit:knowledge-vault` 输出单个 JSON 报告，并以非零退出码阻断失败构建。默认扫描仓库的 `knowledge-vault/` 和 `storage/`；隔离测试或迁移演练可分别通过 `KNOWLEDGE_VAULT_ROOT`、`KNOWLEDGE_STORAGE_ROOT` 指定只读根目录。

审计器从 frontmatter 标量、Markdown 行内代码、Markdown 链接和明确的裸路径中提取 `storage/...` 引用。只有 `storage/source-assets/**` 与 `storage/imports/**` 下被明确引用的普通文件进入 `assetClosure.referencedAssets`；`storage/` 或允许分类中的目录提及会单独报告，但绝不递归扩展为迁移闭包。其他 storage 分类、绝对 storage 路径、`file://`、路径穿越、缺失目标和逃逸允许分类的符号链接全部 fail closed。

每个闭包文件始终输出规范相对路径、media type、实际 byte size、实际 SHA-256 和所有引用来源。索引使用 `SHA-256` / `checksum` 或 `byteSize` / `文件大小` / `压缩包大小` 声明完整性时，声明必须能唯一绑定到一个资产，并与实际文件完全一致；同一资产的多个声明互相冲突也会失败。

R0 候选捕获必须提供可读但不纳入 Git 的 `storage/` 外部闭包（例如受控只读挂载或按引用 allowlist 物化的临时目录）。只有知识库明确引用的文件进入候选 inventory 的 `external` 项，并由实际字节重新计算大小和 SHA-256；纯 fresh clone 没有该闭包时必须失败，不能用测试 fixture、旧 manifest 或“目录存在”替代原始资产证据。这样既保持重型原文件不进入 source candidate，也避免 clean candidate 丢失运行所需的知识资产。

`assetClosure.unreferencedStorage.byTopLevel` 按 storage 顶层分类输出文件数、字节数、闭包引用数和未引用摘要，只作为清理决策证据，不执行删除。删除动作必须使用另行批准的 allowlist，不能从报告中的示例路径反推批量删除命令。定向回归测试使用 `node --test scripts/knowledge-vault-audit.test.mjs`，覆盖成功闭包、缺失文件、路径穿越、绝对路径、非允许分类、symlink escape、SHA-256 与 byteSize 不匹配。

## 费用与工作量

Qwen3 Embedding、BGE-M3、bge reranker、TEI、pgvector 和 Jieba 的推荐核心均可免费自托管。开发和一次性小规模构建可使用约 8 vCPU / 16 GiB CPU；低并发生产建议至少 16 GiB 显存，embedding 与 reranker 同卡并保留动态 batch 余量时优先 24 GiB L4/A10 级别。当前语料很小，不值得只为一次构建常驻专用 GPU，可复用受资源隔离的推理节点。

完整实现约 13-22 人日，已包含在绿地总预算的 Knowledge 范围内：合同/迁移 2-3，TEI adapter 与可恢复 embedding 3-5，检索 API/tool 3-5，人工评测与 benchmark 3-5，部署/观测/故障验收 2-4。第三方托管调用费和新增语料的持续重建成本按供应商另计。

## 官方来源

- Qwen3 Embedding: https://huggingface.co/Qwen/Qwen3-Embedding-0.6B
- BGE-M3: https://huggingface.co/BAAI/bge-m3
- BGE reranker v2 m3: https://huggingface.co/BAAI/bge-reranker-v2-m3
- Text Embeddings Inference: https://github.com/huggingface/text-embeddings-inference
- pgvector mixed dimensions: https://github.com/pgvector/pgvector#can-i-store-vectors-with-different-dimensions-in-the-same-column
- PostgreSQL full-text search: https://www.postgresql.org/docs/16/textsearch.html
