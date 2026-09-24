# 产品工作台文档

`docs/` 保存当前系统架构、实现合同、生产 runbook、证据 schema 和部署约束。

## 架构与合同

| 范围 | 文档 |
| --- | --- |
| Runtime、数据库、Provider State 与 Knowledge capability | `runtime-database-contract.md` |
| 产品流程、Web、PRD、Prototype、导出与发布 | `workbench-product-contract.md` |
| 系统架构与模块边界 | `workbench-greenfield-implementation-plan.md` |
| Knowledge 检索、EmbeddingProfile 与 RetrievalProfile | `workbench-knowledge-retrieval-architecture.md` |
| 强制知识生成、最终版入库、原型分享与验收边界 | `workbench-generation-knowledge-lifecycle.md` |
| Export Worker、Preview Origin 与文件读取 | `workbench-export-preview-architecture.md` |
| 前端视觉、交互和浏览器状态 | `workbench-visual-baseline.md` |
| 开源复用、许可证和自研边界 | `workbench-open-source-reuse-strategy.md` |
| 依赖、许可证和采用状态 | `workbench-dependency-register.md` |

## 运维

- `runbooks/workbench-runtime-provider-state-rollout.md`：Runtime projection、观测和 rollout。
- `runbooks/workbench-postgres-recovery-drill.md`：隔离 PostgreSQL 备份恢复演练。
- `runbooks/workbench-production-acceptance-g6-g11.md`：生产验收控制项。
- `runbooks/workbench-hard-cut-production-acceptance.md`：签名候选与生产执行边界。
- `runbooks/apitable-production-operations.md`：需求池生产入口和安全操作边界。

## 证据合同

- `evidence/`：生产观察、批准、ledger 和验收包的 JSON Schema。
- `schemas/`：发布候选、运行结果和部署配置的机器校验合同。

生产证据、截图、构建输出和运行时生成文件写入受控外部目录，不提交到 `docs/`。
