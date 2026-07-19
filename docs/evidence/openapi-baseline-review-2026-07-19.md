# OpenAPI 基线审查记录（2026-07-19）

## 审查范围

- 旧基线：92 paths / 113 operations
- 当前合同：93 paths / 114 operations
- 旧基线 SHA-256：`7268e2f45d3086cbc99fe4b3e35970bcab99f87d455dd4a7445d5d4e79c88f82`
- 当前合同 SHA-256：`09924ac32caf1c2df2eb02180eb54b827d369ee40780f3efa5998d3220180e3c`
- 检查工具：官方 `oasdiff v1.23.0`，Linux amd64 发布包 SHA-256
  `972b10535c3db4366b9dc3ebc11ca021279af3095267c3cffdca854a3a3c4f89`

## 差异结论

新增 `GET /runtime/canvas/visuals/{visualCapabilityId}`。该端点只允许持有同一
Run、Principal、Project、Session 和 Grant 的短期 Canvas capability 读取服务端
归一化截图。

`POST /projects/{projectId}/canvas-agent/commands/{commandId}/ack` 的请求体从
durable ACK 改为 wire ACK。`view_screen` 成功 ACK 必须携带 command-bound
`visualCapture`，API 在归一化并发布截图后剥离 base64，数据库和响应仍只保存
durable ACK。其他 Canvas command 不允许携带截图。

刷新前运行 breaking check 得到一个预期错误：

```text
request-body-one-of-removed
POST /projects/{projectId}/canvas-agent/commands/{commandId}/ack
```

这是有意的绿地合同替换，不提供旧客户端兼容层。旧前端和旧 API 会在服务器硬切后
整体删除；当前 Web dispatcher、poller、API controller/service 和生成类型已共同迁移
到新 wire ACK 合同。因此本次审查批准把当前合同冻结为新基线，但不把刷新前结果
改写成“无 breaking change”。刷新后仍必须使用同一固定版本重新运行 breaking check。

刷新后基线与当前合同 SHA-256 均为
`09924ac32caf1c2df2eb02180eb54b827d369ee40780f3efa5998d3220180e3c`；同一
`oasdiff v1.23.0` 复检结果为 `No changes detected`。
