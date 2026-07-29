# 产品工作台 G5-G11 生产验收操作手册

本手册用于为一个已冻结的产品工作台候选版本生成可进入 G12 的生产证据包。操作顺序固定为：

1. 从受保护 CI run 取得 release chain、G4 镜像清单和固定 verifier commit。
2. 在执行任何观察前生成 acceptance plan。
3. 在目标生产环境执行受保护 catalog 的全部 48 个控制项。
4. 由独立 observation workflow 重算阈值并封印 G5-G11 ledger。
5. 完成 hard-cut receipt，冻结 package envelope，再由四个独立角色签名。
6. 使用 assembler 重新验证 observation、签名和 `hard-cut --enforce`，生成单一 v3 包。
7. 仅由受保护的 production acceptance workflow 下载该包并执行 G12。

任何一步中的 candidate、deploy、environment、release chain、镜像、配置、迁移、catalog 或证据
摘要变化，都必须从 plan 重新开始。不得修改旧 ledger 或复用另一个候选的 observation。

## 权限边界

`.github/workflows/workbench-production-observation.yml` 只能运行在
`production-observation` environment 和带 `production-observer` 标签的只读 self-hosted runner。
该身份可以执行探测和读取审计数据，但不能部署、切流、删除资源、修改数据库或签发 hard-cut
receipt。工作流权限只有 `actions: read` 和 `contents: read`。

`.github/workflows/workbench-production-acceptance.yml` 是唯一 G12 入口。四方批准私钥只能位于各自
HSM、KMS 或离线签名环境，不能放入仓库、runner、GitHub secret、observation source 或证据包。

## 冻结 Plan

先验证同一个 production CI run 的 `verified-release-chain`、
`production-image-manifest` 和 Cosign bundle，再计算受保护 catalog 的原始字节 SHA-256。Plan 输出
必须位于 source checkout 之外：

```sh
node scripts/production-acceptance/plan.mjs \
  --catalog docs/evidence/governance/production-acceptance-control-catalog.v1.json \
  --catalog-sha256 "$CONTROL_CATALOG_SHA256" \
  --image-manifest "$PRODUCTION_IMAGE_MANIFEST" \
  --image-manifest-sha256 "$PRODUCTION_IMAGE_MANIFEST_SHA256" \
  --candidate-id "$CANDIDATE_ID" \
  --source-commit "$SOURCE_COMMIT" \
  --signed-tag "$SIGNED_TAG" \
  --release-chain-id "$RELEASE_CHAIN_ID" \
  --deploy-id "$DEPLOY_ID" \
  --environment-id "$ENVIRONMENT_ID" \
  --environment-description "$ENVIRONMENT_DESCRIPTION" \
  --region "$REGION" \
  --config-sha256 "$CONFIG_SHA256" \
  --migration-sha256 "$MIGRATION_SHA256" \
  --planner-id "$PLANNER_ID" \
  --created-at "$PLAN_CREATED_AT_UTC" \
  --output "$EXTERNAL_ROOT/production-acceptance-plan.json"
```

不要从部署环境手工抄写 candidate、commit、tag 或 chain ID；这些值只能来自已验证 release chain。
Plan 的 `payloadSha256`、G4 manifest SHA、完整镜像 digest 集合和 catalog SHA 是之后所有 observation
与 ledger 的共同绑定。

## 执行控制项

目录 `docs/evidence/governance/production-acceptance-control-catalog.v1.json` 是唯一控制事实源。
每个控制项必须产生且只产生一个 canonical
`observations/<controlId>.json`，schema 为
`workbench.production-control-observation.v1`。不得仅记录 `PASS`；必须记录可重新计算的
`result.observedValue`。

每个 observation 必须满足：

- `catalog`、`binding`、`environment` 与 plan 精确一致；
- `toolVersions` 精确等于 catalog 指定的单个工具，不能追加 wrapper 或人工自报版本；
- `toolAttestation` 同时引用工具制品和构建 provenance 的不可变 URI 与 SHA-256，且 `provenanceSubjectSha256` 必须等于制品摘要；
- `evidence` 和每次 retry 只引用 `file:./raw/...`、匹配摘要的 `urn:sha256:`、digest 固定 OCI，或无凭证且版本固定的 HTTPS 对象；
- `executedAtUtc` 不早于 plan，且不晚于 collection；
- `executionStatus=PASS` 时 `observedValue` 必须满足 catalog 的 boolean 或 numeric threshold。

控制范围如下。各 Gate 中每一项都必须 PASS，不能以抽样替代：

| Gate | 控制数 | 必须证明的生产边界 |
| --- | ---: | --- |
| G5 | 6 | 最小数据库权限、fresh/upgrade migration、backup restore、RPO、RTO |
| G6 | 8 | Better Auth 密码登录；SSO disabled fail-closed / enabled 完整 OIDC；注册关闭；JWT 生命周期；KMS 轮换；Canvas 完整性；租户/SSRF；S3/扫描；Edge origin auth |
| G7 | 6 | DeerFlow supply chain、durable replay、provider failure matrix、request-scoped secrets、声明式工具 scope、Canvas 实际视图 |
| G8 | 5 | Import 扫描隔离、multipart checksum、Export provider failures、双 origin Preview、显式发布确认 |
| G9 | 4 | 中文检索基准、引用路由隔离、模型 digest adoption、Quartz delivery |
| G10 | 11 | catalog-bound 100 active Runs、100-ID batch、poller QPS、取消 p95、60 秒恢复、clean host、TLS/WireGuard、OTLP/告警、故障矩阵、零 blocking incident |
| G11 | 8 | 浏览器/viewport、reduced motion、console/network 零错误、Figma scope 和完整产品主路径 |

G10 的容量 profile 必须把 `activeRuns=100`、`cancellationQueryBatchSize=100`、
`pollerQpsPerReplica=4`、`cancelP95Ms=10000` 和 `recoveryMs=60000` 写入同一不可变证据，
并绑定 candidate config 与 catalog digest。只跑一个 Run 或只证明配置范围不算容量验收。

## G11 部署真实栈证据

除 `G11.FIGMA.SCOPE` 外，G11 的七个正式控制项必须从同一份 canonical
`workbench.production-g11-real-stack-manifest.v1` 派生。fixture browser smoke、
`route.fulfill`、受控本地 provider、synthetic session/API/SSE 和 localhost 截图只能用于诊断，
不得作为该 manifest 或生产 observation 的输入。

证据根目录必须在源码仓库之外，并使用以下受限布局：

```text
<evidence-root>/
  raw/g11/manifest.json
  raw/g11/screenshots/*.png
  raw/g11/flows/*
  observations/*.json
```

Manifest 必须与冻结 plan 的 `planId`、`payloadSha256`、完整 `binding` 和 `environment`
逐字节语义一致，绑定同一 candidate、deploy、environment、image/config/migration/catalog
digest。被测 Web 与 Preview 必须是互不相同、无凭证和无查询参数的 HTTPS origin；provider
必须是批准的生产 provider。浏览器集合必须精确为 Chromium、Firefox、WebKit。

视觉矩阵必须完整且无重复：

- 状态：`prd-active`、`prd-pending`、`prototype-after-prd`；
- viewport：`375x812`、`768x1024`、`1440x900`；
- motion：`normal`、`reduced`；
- browser：Chromium、Firefox、WebKit。

因此 manifest 必须包含正好 54 个 screenshot cell。每张 PNG 都必须位于
`file:./raw/g11/screenshots/`，摘要、像素尺寸和非空画面由 runner 重新验证。Manifest 还必须
完整记录 account/invitation/workspace/project/role/revocation、PRD、mixed request 零副作用拒绝、
Prototype-after-PRD、refresh/reconnect、Preview/Import/Export、Run success/failure/cancel/retry、
approval/Canvas/typed Prototype Patch/SSE/Artifact persistence、authorization/idempotency、
7,686+ 长 Run、Knowledge null/valid、provider-state integrity，以及
accessibility/Preview security 十一个 flow；所有 flow 原始证据也必须是 evidence root 内的
不可变、摘要匹配文件。

调用 runner 时显式传入 evidence root：

```sh
node scripts/production-acceptance/run-control.mjs \
  --control "$CONTROL_ID" \
  --plan "$WORKBENCH_ACCEPTANCE_PLAN" \
  --result "$WORKBENCH_CONTROL_RESULT" \
  --evidence-root "$WORKBENCH_EVIDENCE_ROOT" \
  --output "$WORKBENCH_OBSERVATION_OUTPUT"
```

Runner 不接受 result 自报的 G11 `observedValue`。它必须先校验 manifest 与所有引用文件，
再分别派生七个控制的 boolean 或错误计数，并把 manifest、54 张截图和 flow 原始证据写入
typed observation evidence。任一缺项、重复项、路径逃逸、符号链接、摘要不符、错误部署绑定
或 fixture 标记都必须 fail closed。`G11.FIGMA.SCOPE` 仍按 G0 中冻结的独立人工/N/A 决策执行，
不能由浏览器 manifest 代签。独立 collection workflow 和最终 package replay 会再次读取同一
manifest、重算全部引用摘要与七个 observed value；手工构造 observation 不能绕过 runner。

## Observation Source

交给 workflow 的 source 是 canonical
`workbench.production-observation-source.v1` JSON。它只允许 `observations/` 和 `raw/` 路径：

```json
{
  "files": [
    {
      "contentBase64": "Li4u",
      "path": "observations/G6.AUTH.PASSWORD_LOGIN.json",
      "sha256": "<64-lowercase-hex>"
    }
  ],
  "schemaVersion": "workbench.production-observation-source.v1"
}
```

本地可先执行与 workflow 相同的安全物化和采集：

```sh
node scripts/production-acceptance/materialize-source.mjs \
  --source "$SOURCE_BUNDLE" \
  --source-sha256 "$SOURCE_BUNDLE_SHA256" \
  --output-root "$EXTERNAL_ROOT/source"

node scripts/production-acceptance/collect.mjs \
  --plan "$PLAN" \
  --observations "$EXTERNAL_ROOT/source/observations" \
  --evidence-root "$EXTERNAL_ROOT/source" \
  --output-root "$EXTERNAL_ROOT/collection" \
  --collected-at "$COLLECTED_AT_UTC"
```

生产 collection 必须由独立 workflow 生成：

```sh
gh workflow run workbench-production-observation.yml \
  --ref production \
  -f release_chain_run_id="$CI_RUN_ID" \
  -f plan_url="$IMMUTABLE_PLAN_URL" \
  -f plan_sha256="$PLAN_SHA256" \
  -f observation_source_url="$IMMUTABLE_SOURCE_URL" \
  -f observation_source_sha256="$SOURCE_BUNDLE_SHA256"
```

workflow 会再次验证 CI run、release chain、G4 Cosign bundle、plan、catalog 和 source hash，随后重算
48 个 threshold。产物 `production-observation-collection-<run-id>` 中的 `collection/` 才可进入签名和组包。

## Hard-cut 与四方签名

组包前，独立 hard-cut evidence root 的根目录必须包含 `manifest.json`。Manifest 必须已是
`status=completed`，具备完整 policy、八类外部遗留资源、三个 cutover receipt 和全部签名 ledger；
所有本地 URI 均相对于最终 package evidence root。Assembler 会实际运行 `hard-cut --enforce`，
不会只检查 manifest 外形。

Security、Data、Operations、Release 四个不同 approver 使用不同 Ed25519 key。签名 subject schema 为
`workbench.production-approval-signature.v3`，覆盖：

- `implementerId`、`createdAtUtc`、`acceptedAtUtc`；
- candidate、release chain、G4 manifest 和完整镜像 digest；
- control catalog、hard-cut manifest、排序后的 G5-G11 ledger；
- 当前角色、approver、keyId、signedAt 和自身 approval evidence digest。

签名前必须冻结上述 envelope。修改 implementer、时间、gate、manifest 或任何 digest 后，旧签名无效。
四个 approval evidence 文件固定为 `security.json`、`data.json`、`operations.json`、`release.json`，
approval set 中路径固定为 `approvals/<role>.json`。

每个角色使用同一冻结 envelope 独立生成待签字节。以 Security 为例：

```sh
node scripts/production-acceptance/prepare-approval-payload.mjs \
  --collection-root "$EXTERNAL_ROOT/collection" \
  --hard-cut-root "$EXTERNAL_ROOT/hard-cut" \
  --production-image-manifest "$PRODUCTION_IMAGE_MANIFEST" \
  --role Security \
  --approver-id "$SECURITY_APPROVER_ID" \
  --key-id "$SECURITY_KEY_ID" \
  --signed-at "$SECURITY_SIGNED_AT_UTC" \
  --approval-evidence "$EXTERNAL_ROOT/approval-evidence/security.json" \
  --implementer-id "$IMPLEMENTER_ID" \
  --accepted-at "$ACCEPTED_AT_UTC" \
  --created-at "$PACKAGE_CREATED_AT_UTC" \
  --output "$EXTERNAL_ROOT/security-approval-payload.json"
```

把输出文件的原始字节提交给该角色的 Ed25519 HSM/KMS；不要再次 pretty-print、重排或包装后再签。
将返回的 canonical base64url 64-byte signature 与命令输出的 approval 元数据组成
`workbench.production-approval-set.v1`。对另外三个角色重复执行。Assembler 会从包外 trust policy
重新解析 authority 并验证每个签名，任何手工字段漂移都会失败。

## 组装并验证 v3 包

四方签名完成后执行：

```sh
node scripts/production-acceptance/assemble-package.mjs \
  --collection-root "$EXTERNAL_ROOT/collection" \
  --hard-cut-root "$EXTERNAL_ROOT/hard-cut" \
  --approvals "$EXTERNAL_ROOT/approval-set.json" \
  --approval-evidence-root "$EXTERNAL_ROOT/approval-evidence" \
  --production-image-manifest "$PRODUCTION_IMAGE_MANIFEST" \
  --trust-policy "$PRODUCTION_TRUST_POLICY" \
  --trust-policy-sha256 "$PRODUCTION_TRUST_POLICY_SHA256" \
  --implementer-id "$IMPLEMENTER_ID" \
  --accepted-at "$ACCEPTED_AT_UTC" \
  --created-at "$PACKAGE_CREATED_AT_UTC" \
  --output "$EXTERNAL_ROOT/hard-cut-acceptance-package.json"
```

Assembler 只有在以下全部通过后才以 `0600`、exclusive create 写出文件：collection seal、plan、48 个
observation replay、工具 provenance、G5-G11 ledger、G4 binding、catalog、四方签名、v3 schema、
package verifier 和实际 hard-cut enforce。输出的 SHA-256 是 production acceptance workflow 的
`evidence_package_sha256`，不得把包放回 source checkout。

## 失败处理

- `FAIL`、`BLOCKED`、`INCONCLUSIVE`、缺 observation、额外 observation、threshold 不满足：修复环境后生成新 observation source，不能改旧 ledger。
- 工具制品或 provenance digest 变化：更新受保护 catalog/工具发布并从 plan 重来。
- candidate、deploy、配置、迁移、镜像或 catalog 变化：旧 plan、collection 和四方签名全部作废。
- `.incomplete` 存在：该 source/collection 从未完成，不得恢复为 PASS 或进入 assembler。
- 私钥、token、cookie、签名 URL 或其他可复用凭证出现在证据中：隔离该证据并轮换凭证。
- G12 workflow 未 PASS：不得切流、删除旧资源或宣告上线完成。

本地合同回归：

```sh
npm run production:acceptance:test
node --test scripts/workbench-hard-cut-manifest.test.mjs scripts/evidence-ledger.test.mjs
```
