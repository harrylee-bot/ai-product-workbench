# 产品工作台证据账本合同

本目录定义生产验收使用的不可变证据账本和证据索引。这里的 schema、catalog 与 verifier 是字段合同的现行权威，但不把当前候选或任一 Gate 自动判为通过。

## 文件职责

- `ledger.schema.json`：每个验证对象的完整状态和证据合同。
- `index.schema.json`：只允许保存 ledger 的 `ledgerId`、`uri` 和 `sha256`，不得复制执行状态、发现状态、证据等级或结论。
- `scripts/evidence-ledger.mjs`：规范化、封印及验证实现；除 JSON Schema 的结构约束外，还执行跨字段绑定、URI、哈希、排序和敏感数据校验。

ledger 的封印值为以下对象的 canonical JSON SHA-256：

```json
{"payload":{},"schemaVersion":"workbench.evidence-ledger.v1"}
```

实际计算时 `payload` 是完整 payload。canonical JSON 使用 UTF-8、对象 key 词典序、紧凑编码和唯一尾随 LF；SHA-256 计算不包含文件尾随 LF。entries、证据、工具版本、镜像和关联项还必须按 verifier 规定的稳定键排序。修改 ledger 内容而不重新封印会直接失败；index 另以整份 canonical ledger 文件的 SHA-256 固定引用。

## 字段映射

| 规范字段 | ledger 字段 |
| --- | --- |
| Gate ID、控制目标 | `gateId`、`controlObjective` |
| 环境、前置条件 | `environment`、`prerequisites` |
| 精确命令/步骤 | `procedure`，必须二选一 |
| 预期结果、数值/布尔阈值 | `expectedObservation`、`threshold` |
| 实际状态 | `executionStatus`，只接受 `PASS/FAIL/NOT RUN/BLOCKED/INCONCLUSIVE/N/A` |
| 发现状态 | `findingStatus`，只接受 `CONFIRMED/PLAUSIBLE/REFUTED` |
| 证据等级 | `evidenceLevel`，只接受 `E1/E2/E3/E4` |
| UTC、执行者 | `executedAtUtc`、`executor` |
| commit/tag/deploy/environment | 每条 entry 的 `binding`，并必须与 ledger 顶层 binding 完全一致 |
| image/config/migration digest | `binding.digests`；只记录执行当时已存在的镜像，尚未构建时 `images` 必须诚实记录为空数组 |
| 工具版本 | `toolVersions` |
| 原始证据 URI、SHA-256 | `evidence[].uri`、`evidence[].sha256` |
| 重试记录 | `retryRecords`；无重试也必须记录空数组 |
| finding/decision | `relatedFindingsOrDecisions` |

`N/A` 还必须给出范围依据、批准人和到期 UTC；waiver 不允许把事实状态改写为 `PASS`。

ledger 不负责伪造尚不存在的构建产物。R0、G1、G2 等镜像构建前记录允许 `images: []`；进入 G4 及以后阶段时，镜像集合是否齐全、是否覆盖候选 artifact inventory，必须由对应 gate/artifact inventory validator 独立强制。缺镜像时应记录 `NOT RUN`、`BLOCKED` 或 `FAIL`，不得用占位 digest 生成 `PASS`。

## URI 与敏感数据

本地证据使用相对于 verifier `--root` 的 `file:./path`，必须存在、是普通文件、不能经过符号链接、不能逃逸 root，文件字节 SHA-256 必须匹配。index 的 ledger 引用只能使用该形式，以便离线完整验证。

远端原始证据只接受可证明版本固定的 URI：内容寻址 `urn:sha256:`、OCI digest、S3 `versionId`、GCS `generation`、Azure `versionid`，或包含 digest/commit/version 的 HTTPS URI。`http://`、普通 HTTPS、`latest/current/head` 和绝对 `file://` 都会失败。远端 URI 的结构检查不替代仓储权限、保留策略或独立 E1 采集证明。

ledger、index、candidate manifest 和所有本地原始证据都会进行凭证模式扫描。不得纳入 `.env`、cookies、Authorization、JWT、API key、private key 或其他可复用凭证；先脱敏，再计算 SHA-256。`output/`、`.playwright-cli/`、外部设计工具抓包和大体积源资产只能在满足仓储与脱敏规则后以不可变 URI 引用，不能直接复制进公共证据目录。

## 验证

候选、部署和环境 ID 必须由调用方显式给出，不能相信 ledger 自报：

```sh
node scripts/evidence-ledger.mjs \
  --root . \
  --index docs/evidence/index.json \
  --candidate-id rc-20260718-01 \
  --deploy-id deploy-20260718-01 \
  --environment-id production-cn-hz \
  --candidate-manifest /immutable/path/release-candidate.json
```

`--candidate-manifest` 可选；提供后，ledger 必须以 URI+SHA-256 引用同一内容，manifest 暴露的 `candidateId` 必须与显式预期值一致；若 manifest 还暴露 `sourceCommit`、`signedTag.name`、deploy ID 或 environment ID，也必须与 ledger 冻结绑定一致。candidate manifest 为避免改变其自身候选 source tree，可以位于仓库外；此时 ledger 使用 `urn:sha256:<digest>` 或版本固定的远端 URI，显式路径只是供 verifier 读取的本地不可变副本。此工具不会 commit、tag、push、deploy，也不会生成 `PASS` 结论。
