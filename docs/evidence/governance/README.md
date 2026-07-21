# 产品工作台 G0 范围与责任批准合同

本目录只定义 G0 的机器可校验合同，不记录任何真实批准，也不把当前候选升级为
`PASS`。`g0-scope-approval.example.json` 的状态固定为 `NOT RUN`，其中 `.invalid`
身份仅用于展示字段；校验器明确禁止把这些示例身份用于 `PASS`。

## 合同边界

- `product` 固定为 `产品工作台`，Gate 固定为 `G0`。
- 候选同时绑定 `candidateId`、`sourceCommit`、annotated signed tag identity 和
  candidate manifest 的 URI/SHA-256。调用方还必须从命令行传入预期候选，不能相信
  JSON 的自报值。
- 环境必须记录 `environmentId`、`kind`、`target` 和 `region`；`PASS` 只接受
  `production`。
- 当前整改规范中的 G0-G12、D-001-D-045 和 P-001-P-019 必须完整纳入 scope。
- `advertised`、`deferred`、`N/A` 三种能力分类必须显式出现，并记录理由、分类到期、
  目标日期、升级路径、逾期处理和批准。`N/A` 不能由 Implementer 批准，过期分类直接
  失败。
- Implementer、Security、Data、Operations、Evidence、Release 六个角色必须全部有
  非占位 Owner。Security/Data/Operations/Release 不能与 Implementer 是同一身份。
- 每个 Gate/finding 必须且只能被一个 schedule 分组覆盖，以保证目标日期、升级路径和
  逾期处理没有遗漏。
- waiver 不得改写执行事实；source provenance、tenant isolation、secret exposure、
  object checksum integrity、不可逆数据恢复和最终独立生产批准不可 waiver。其余 waiver
  也必须由 Security/Data/Operations/Release 四方批准并设置到期和修复路径。

批准引用只接受两种形式：

1. 相对 `file:./...` 普通文件及精确 SHA-256；文件不得经过符号链接或逃逸校验 root。
2. 不可变 URI 及 SHA-256，例如 `urn:sha256:`、OCI digest、对象存储 version/generation，
   或包含固定 digest/commit/version 的 HTTPS URI。普通 HTTPS、`latest/current/head`、
   绝对 `file://` 均失败。

校验器会扫描批准记录、candidate manifest 和本地批准证据中的 secret/cookie/token/JWT/
private key 模式。签署时间必须是 UTC，不能晚于记录时间或校验时间。

## 校验

```sh
node scripts/g0-scope-approval.mjs \
  --root . \
  --approval /immutable/path/g0-scope-approval.json \
  --candidate-id sha256:<64-lowercase-hex> \
  --source-commit <40-or-64-lowercase-hex> \
  --signed-tag <annotated-signed-tag> \
  --candidate-manifest /immutable/path/release-candidate-manifest.json
```

结构及证据有效且状态为 `PASS` 时退出码为 0；有效但为 `NOT RUN/FAIL/BLOCKED/`
`INCONCLUSIVE` 时输出 `gatePassed:false` 并使用退出码 2；合同或证据无效时使用退出码 1。
因此，校验示例不会被自动化误计为 G0 PASS。

该校验只能证明合同、绑定、引用和所给签署元数据一致。批准人的真实身份、签名系统权限
和证据保留策略仍须由受信审批系统与独立审查证明；本工具不会创建签名、批准、commit、
tag、push 或部署。
