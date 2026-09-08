# 产品工作台全量审查与清理最终报告

- 状态：当前最终版
- 更新日期：2026-07-28
- 适用仓库：`workbench`

## 1. 最终结论

本轮已完成项目代码、依赖、测试数据、文档、知识库、来源资产、构建产物和本地缓存的全量审查与清理。清理原则是只保留当前有效实现、当前权威文档、可执行测试合同、数据库回放链和有明确索引的原始来源资产。

所有操作仅发生在本地仓库、项目数据库知识库和本地 `storage/` 归档范围内，未向任何外部知识库同步内容。

| 项目 | 最终结果 |
| --- | ---: |
| 删除的 tracked 文件 | 661 |
| 删除的文本文件 | 658 |
| 删除的文本行 | 47,792 |
| 删除的二进制文件 | 3 |
| 当前 Knowledge Markdown | 40 |
| 当前受索引 `storage/` 资产 | 62 |
| 受索引资产总大小 | 670,027,774 bytes |
| Prisma migrations | 68 |
| 未解析资产引用 | 0 |
| 未索引 `storage/` 文件 | 0 |
| 生成目录、缓存和空目录 | 0 |
| 释放空间 | 约 1 GB |

## 2. 已删除内容

### 2.1 历史知识与文档

- 删除 624 篇旧知识库 Markdown，包括拆分碎片、重复导入结果、历史版本、旧版整理目录和一次性收件箱记录。
- 删除 13 篇过期 `docs/` 文档，包括旧审计、交接、迁移总结、实施状态快照和一次性证据报告。
- 删除旧的综合整改报告、GEMINI UI 迁移材料、线上知识库交接、旧前端评估、工作台实施状态及过期 OpenAPI 基线审查。
- 删除历史 `knowledge-versions` 数据，只保留旧知识库当前分类和当前条目的脱敏导出。
- `docs/` 的当前权威入口统一为 `docs/README.md`，不再保留并行状态报告。

### 2.2 老代码与无引用资产

- 删除 13 个无引用 UI 组件：`badge`、`collapsible`、`command`、`input-group`、`popover`、`select`、`separator`、`sheet`、`sidebar`、`spinner`、`table`、`tabs`、`textarea`。
- 删除无引用的 `use-mobile.ts` 和两个无价值 barrel 文件。
- 删除旧知识迁移脚本及其测试；迁移已经完成，不再保留一次性执行入口。
- 删除旧容器 OSS smoke 脚本；现行部署合同测试已经覆盖相同边界。
- 删除 3 张无引用图片。
- 删除失效的 `knip.json` 和一次性 `design-qa.md`。

### 2.3 历史测试输出与生成物

- 删除原 `output/` 中约 293 MB 的历史测试与证据输出。
- 删除所有项目级 `dist/`、`build/`、`.next/`、Prisma generated client、`*.tsbuildinfo`、`.vite/` 和 `__pycache__/`。
- 删除日志、临时文件、备份文件和删除文件后遗留的空目录。
- 保留 `node_modules/`，使项目仍可直接运行和验证；它不属于源代码或历史测试数据。

## 3. 已合并与收敛

- Knowledge 从 661 篇收敛为 40 篇当前知识，按产品架构、业务域、进化规则、文档规范、原型规范、案例和来源索引组织。
- 原始手册、原型和 HTML 归档统一保存在 `storage/`，Knowledge 只保留结构化索引，不复制大型二进制文件。
- 文档入口收敛为两份当前执行规格、稳定架构文档、runbook 和机器可校验证据合同。
- 公共注册策略从 Web 构建期变量收敛为服务端运行时策略，避免同一镜像因环境不同而重新构建。
- 删除未使用的直接依赖，统一共享依赖位置，并刷新 lockfile 和安全覆盖版本。

## 4. 必须保留的内容

### 4.1 数据库迁移

68 个 Prisma migration 全部保留。它们是数据库从空库到当前 Schema 的确定性回放链，不是可删除的老代码。删除任意历史 migration 都会破坏新环境部署、灾备恢复和迁移审计。

### 4.2 当前测试 fixture

保留的 fixture、baseline 和 snapshot 均被现行测试直接引用，是契约输入而非历史执行输出。删除后会降低 OpenAPI 兼容性、知识检索评估、证据账本、导出和浏览器链路的回归能力。

### 4.3 来源资产与现行业务知识

- 保留 58 份原始手册和原型、2 份 HTML 归档、2 份旧知识库当前 NDJSON 导出。
- 62 个资产全部唯一、有索引，实际 byte size 和 SHA-256 与审计结果一致。
- “历史案例库”“历史业务增量规则”和 `legacy-read` 属于当前业务决策规则、来源证据或切换控制，不是历史噪音。
- 两份当前整改规格分别覆盖功能视觉和 Runtime 数据库，职责不同，不属于重复文档。

### 4.4 公共入口文件

`board.ts`、`releases.ts`、`shares.ts`、`public-shares.ts` 虽然只有三行，但承担 Dependency Cruiser 的公共入口边界。直接删除会产生绕过 public entry 的架构违规，因此保留。

## 5. 后续可合并项

以下内容不是无引用代码，不能直接删除；需要在保持服务边界、错误语义和测试合同的前提下重构。

| 优先级 | 候选 | 建议 |
| --- | --- | --- |
| 高 | API 与 Runtime Worker 的 `board-revision-owner.ts`，55 行实现相同 | 迁入合适的共享数据库包，并增加双方合同测试 |
| 中 | API 与 File Worker 的 TEI 请求、超时、有界 JSON 和 UTF-8 解析 | 抽取无框架依赖的 HTTP 响应内核 |
| 中 | Export、Import、Preview 配置解析 | 先统一环境变量合同和错误类型，再抽共享函数 |
| 中 | 多个 reconciler 的启动、停止和定时器生命周期 | 只共享生命周期模板，保留各服务领域行为 |
| 中 | E2E 浏览器 helper，约 451 行重复 | 建立单一测试 helper 包并逐套件迁移 |
| 低 | 两个 Prisma client 包装和相似 Vitest 配置 | 合并收益低于新增耦合，继续保留 |

## 6. 验证结果

| 检查 | 结果 |
| --- | --- |
| 根 `npm test` | 通过 |
| Web 全量测试 | 1,021 passed，3 skipped |
| 受影响 Web 聚焦测试 | 71/71 passed |
| 干净 checkout 类型检查 | 32/32 commands passed |
| 生产构建 | 通过 |
| OpenAPI | 93 paths，Schema 与生成物一致 |
| Next.js 生产路由 | 14 routes 构建完成 |
| Figma Importer | 构建与测试通过 |
| 架构检查 | 510 modules，1,700 dependencies，0 violations |
| Knowledge 审计 | 40 Markdown，62 assets，0 warnings，0 errors |
| Markdown/Wiki 链接 | 0 断链 |
| `npm audit` | 0 vulnerabilities |
| 依赖树 | 通过 |
| `git diff --check` | 通过 |

生产构建使用以下非真实占位 Origin 验证构建合同：

```bash
WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL=https://uploads.example.invalid \
WORKBENCH_PREVIEW_ORIGIN=https://preview.example.invalid \
  npm run build
```

## 7. 安全处置

`storage/source-assets/prototype-html/html.zip` 已移除 `.env.local`：

- byte size：`113155768`
- SHA-256：`62367d1ef430b73cff4254a812f5625c841abf5e3f5cb75e44d367f8f2f3fba8`
- 当前归档未发现有效 DashScope Key 或其他常见活跃密钥形态。

但是，删除归档内的密钥不能让已经暴露的凭据恢复安全。此前暴露的 DashScope Key 必须立即在供应商控制台轮换或吊销，并检查调用日志、额度消耗和异常来源。只有完成轮换或吊销，安全闭环才算完成。

## 8. 剩余风险与验收边界

- 本地测试、构建和静态审查不能替代真实生产环境的数据库、对象存储、镜像签名、网络隔离和回滚演练。
- 生产发布仍应按 `docs/runbooks/` 完成候选绑定、镜像摘要、审批、恢复和观测证据。
- Sharp 的非当前平台可选 WASM 依赖可能在 `npm ls --all --json` 中显示低优先级 extraneous 噪音；普通依赖树检查与运行时验证均通过。
- 本报告描述当前清理结果，不替代 Git 提交。提交前应审阅完整 diff，确保 661 个删除路径和当前整改修改被放入明确的提交范围。

## 9. 最终验收清单

- [x] 历史文档、重复知识和旧状态报告已删除。
- [x] 无引用代码、图片和一次性脚本已删除。
- [x] 历史测试输出、构建产物、缓存和空目录已删除。
- [x] 当前测试 fixture、数据库 migration 和来源资产均有保留理由。
- [x] Knowledge、链接、依赖、架构、测试和构建检查通过。
- [x] 未向外部知识库同步项目内容。
- [ ] 轮换或吊销此前暴露的 DashScope Key。
- [ ] 在真实生产环境完成发布门禁、回滚和观测验收。
