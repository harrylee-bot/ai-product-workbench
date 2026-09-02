# 产品工作台文档索引

更新日期：2026-07-28

`docs/` 只保留当前架构、执行规格、生产操作手册和机器可校验的证据合同。历史审计、迁移总结、交接记录、阶段状态快照和一次性测试报告不在这里归档；当前实现状态与测试结果以仓库代码、CI 和实际命令输出为准。

## 当前权威入口

| 范围 | 文档 |
| --- | --- |
| 项目全量审查、清理结论与保留边界 | `PROJECT-CLEANUP-FINAL.md` |
| 功能、视觉、浏览器与发布整改 | `CODEX-WORKBENCH-FUNCTIONAL-VISUAL-REMEDIATION-SPEC-20260727.md` |
| Runtime、数据库与 Knowledge 整改 | `CODEX-RUNTIME-DATABASE-REMEDIATION-SPEC-20260723.md` |
| 稳定目标架构与硬切原则 | `workbench-greenfield-implementation-plan.md` |
| 开源复用与自研边界 | `workbench-open-source-reuse-strategy.md` |
| 第三方依赖、许可证与采用状态 | `workbench-dependency-register.md` |
| Export Worker 与 Preview Origin | `workbench-export-preview-architecture.md` |
| Knowledge 检索与不可变 Profile | `workbench-knowledge-retrieval-architecture.md` |
| 前端视觉与交互基线 | `workbench-visual-baseline.md` |
| 预切流删除范围 | `workbench-hard-cut-deletion-manifest.json` |
| APITable 需求池生产入口与运维台账 | `runbooks/apitable-production-operations.md` |

## 操作与证据

- `runbooks/`：当前生产验收、恢复演练和 rollout 操作手册。
- `evidence/README.md`：证据账本、索引和敏感数据规则。
- `evidence/governance/README.md`：G0 范围与责任批准合同。
- `evidence/**/*.schema.json` 与固定 catalog：机器校验合同，不是历史执行结果。

生产证据、截图、构建输出和运行时生成的 ledger/index 不提交到本目录。它们只按 runbook 写入受控临时目录或不可变外部制品，并由 schema 和 verifier 校验。
