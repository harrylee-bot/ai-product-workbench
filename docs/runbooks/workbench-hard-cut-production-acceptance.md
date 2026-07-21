# 产品工作台生产验收与 Hard-cut

本流程把候选构建和不可逆 G12 操作分开。`.github/workflows/workbench-ci.yml` 只生成
G0-G4 及镜像、SBOM、provenance、digest 证据；它不会读取生产删除回执，也不会执行
hard-cut。G12 只能由受保护的
`.github/workflows/workbench-production-acceptance.yml` `workflow_dispatch` 工作流执行。

## 外部证据包

证据包是一个单一 JSON 文件，发布到不可变对象存储或制品仓库。它的字节由工作流输入的
`evidence_package_sha256` 固定，URL 必须是无用户名、密码、fragment、凭证 query 参数的
HTTPS URL，路径不得使用 `latest`、`current` 或 `head`。证据包不进入 source checkout。

顶层 schema 为 `workbench.hard-cut-acceptance-package.v3`，必须包含：

- `candidate`：`candidateId`、`sourceCommit`、`signedTag`、同一 G0-G2 `chainId`；
- `createdAtUtc`、`acceptedAtUtc`、`implementerId`；
- `productionImages`：同一 CI run 中经 Cosign 验证的 G4 manifest 字节 SHA-256，以及按名称排序、完整且不多不少的 10 个生产镜像 digest；
- `controlCatalog`：固定 verifier commit 内 `workbench.production-acceptance-control-catalog.v1` 的精确 SHA-256；catalog 原字节还必须位于包内固定路径；
- `hardCutManifest`：证据包内 manifest 的相对路径和 SHA-256；
- `files`：所有 manifest、ledger、receipt、gate 和 approval 文件的内容、相对路径和 SHA-256；
- `gates`：且只能包含 G5-G11，每项 `status=PASS`，绑定同一 candidate、观察时间和证据文件；每个 gate 文件还必须是 canonical sealed `workbench.evidence-ledger.v1`，其 binding 与 manifest 完全一致，所有 entry 均为该 Gate 的 `PASS` 且证据等级为 E1/E2；
- `approvals`：且只能包含 Security、Data、Operations、Release 四项，`decision=APPROVE`，
  approver 身份和 key fingerprint 互不相同且不等于 Implementer。每项使用独立 Ed25519
  key 签署 candidate、release chain、G4 manifest/images、control catalog、hard-cut manifest
  digest、排序后的 G5-G11 evidence digest 集合以及自身 approval evidence digest。

Hard-cut manifest 及每个 G5-G11 ledger/entry 的 binding 必须同时携带同一
`releaseChainId`、`imageManifestSha256`、`controlCatalogSha256` 和完整镜像集合。每个 Gate
的 ledger entry ID 与控制字段必须和受保护 catalog 完全一致，缺项、多项或漂移均拒绝。

证据包不得携带或覆盖信任根。生产公钥、角色、scope、有效期和撤销状态来自包外
`workbench.production-trust-policy.v1`。其 URL 与 SHA-256 由受保护 environment variables
`WORKBENCH_PRODUCTION_TRUST_POLICY_URL` 和
`WORKBENCH_PRODUCTION_TRUST_POLICY_SHA256` 固定。私钥只能保存在各批准方独立的 HSM、
KMS 或离线签名环境，不能进入仓库、GitHub Actions variables/secrets 或证据包。

Hard-cut receipt 必须使用 `workbench.hard-cut-receipt.v2`。Receipt 只记录 `keyId` 和签名，
不得再通过包内 `publicKeyUri` 自带信任根；每个删除 scope 的唯一 signer 由同一包外 trust
policy 的 `receiptAuthorities` 指定。v2 package 和 v1 receipt 均不兼容并被 enforce 拒绝。

校验器拒绝路径穿越、重复文件、hash 不一致、manifest 自引用、future timestamp、
跨候选 gate/manifest、缺审批、审批晚于 acceptance 或 G5-G11 不完整。所有文件只会写入
新建且必须为空的临时 evidence root；随后 hard-cut verifier 使用该 root，绝不读取 source
树中的 production receipt。

## 运行

在 GitHub Actions 中配置 protected environment `production-acceptance`，要求独立的
Security、Data、Operations、Release authority 审批，并配置以下受保护变量：

- `WORKBENCH_ACCEPTANCE_VERIFIER_COMMIT`：固定的 40 位治理 verifier commit；不得使用待验候选自带 verifier；
- `WORKBENCH_PRODUCTION_TRUST_POLICY_URL`：不可变、无凭证 HTTPS trust policy URL；
- `WORKBENCH_PRODUCTION_TRUST_POLICY_SHA256`：trust policy 精确字节 SHA-256。

production branch 的完整 CI 必须先成功。CI 会把 G0/G1/G2 原始对象、重算后的 release-chain
结果和 Cosign keyless bundle 作为 `verified-release-chain` artifact 上传；同一 run 还必须上传
`production-image-manifest` 及其 Cosign bundle。生产验收只接收
该 CI run ID，不接收 dispatcher 自报的 candidate ID、commit、tag 或 chain ID：

```sh
gh workflow run workbench-production-acceptance.yml \
  --ref production \
  -f release_chain_run_id=<successful-production-ci-run-id> \
  -f evidence_package_url=https://evidence.example.invalid/releases/<immutable-version>/hard-cut.json \
  -f evidence_package_sha256=<64-lowercase-hex>
```

工作流先通过 GitHub API 验证 run 属于同仓库、`workbench-ci.yml`、production push、完整
成功且未跨 fork，再从同一 run 下载两个固定 artifact。随后以精确 workflow identity 和 GitHub OIDC issuer
分别执行 `cosign verify-blob`，并从 G0/G1/G2 原始对象独立重算 release chain；candidate 身份只从
该结果派生。之后才下载和 hash 证据包及 trust policy、校验四方签名，并执行
`hard-cut:manifest --enforce`。

任何 candidate、镜像、配置、迁移、部署 revision、gate evidence 或 trust policy digest 变化，
都会改变签名 subject，四方必须重新签署。Key 轮换应先把新公钥加入 policy 并发布新 digest；
撤销时设置 `revokedAtUtc`，被撤销 key 的 package/receipt 一律不得进入新的验收。验收摘要需记录
CI run/attempt、artifact digest、Cosign certificate identity、trust policy digest 和四个 keyId，
不得记录私钥或可复用凭证。

`hard-cut --enforce` 的实际 PASS 仍需真实生产删除回执、零残留、观察窗口和签名证据；本地
fixture、历史服务器回执或 checkout 内 manifest 不能代替它们。

本地合同测试：

```sh
node --test scripts/workbench-hard-cut-manifest.test.mjs
```
