# 产品工作台 Export Worker 与 Preview Origin

更新日期：2026-07-28

## 1. 结论

产品工作台导出链只消费已经冻结为 `ready` 的 `ProjectRelease`、其 `ReleaseArtifactVersion` pins，以及 pins 指向的 `ready ArtifactVersion/Blob`。它不读取当前 Board、当前 ArtifactVersion 或旧 Conversation，因此同一 ExportJob 的输入在重试期间不会漂移。

仓库内已实现 ExportJob 刷新恢复、轮询、CAS 取消、下载和终态优先排序，较旧 `running` job 不会遮挡同一导出目标较新的 `succeeded` job；`workbench.figma-export.v1` 和产品工作台 Importer 1.0.0 也已落盘。这里的“已实现”只描述当前合同与代码，不替代实际门禁结果；真实 S3/IAM、PostgreSQL、双 HTTPS origin、生产网络、Docker 容器镜像及 Figma Desktop 验收仍是硬切门禁。

生产链为：

```text
Authorized API
  -> transactionally INSERT ExportJob(queued) + SEND export.build
  -> isolated Export Worker claims queued -> running
  -> verify release/manifest/board/artifact checksums
  -> render with fixed adapters and validate output
  -> content-addressed S3 publication
  -> one DB transaction: Blob(pending -> ready) + ExportJob(running -> succeeded)
  -> authorized download or short-lived Preview capability
```

## 2. 开源复用

| 能力 | 固定实现 | 自研边界 |
|---|---|---|
| 队列租约、heartbeat、retry | `pg-boss@12.26.0` | ExportJob CAS、终态发布和 reconciler |
| 对象存储 | AWS SDK S3 | Blob 内容寻址、身份校验和数据库引用 |
| HTML 浏览器验收 | `playwright-core@1.61.1` + system Chromium | 阻断网络、错误收集、固定验收条件 |
| React 转换 | Babel AST/generator、Prettier、esbuild；当前静态叶片过渡使用 `html-to-jsx-transform@1.2.1` | 长期由 Prototype IR 生成共享 RenderPlan，再直出 React AST/runtime data；HTML 不成为语义事实源 |
| MCP | `@modelcontextprotocol/sdk@1.30.0`、`@hono/node-server@2.0.12`、esbuild | 冻结 release 的只读 resources/tools 与 Node HTTP host |
| Figma 稳定导入 | `create-figma-plugin@4.0.3` + `@figma/plugin-typings@1.130.0` + `fflate@0.8.3` | 固定产品工作台 Importer 用官方 Plugin API 读取内部 `FigmaExportDocument`，校验归档、资产长度与 SHA-256 |
| ZIP | `archiver@8.0.0` | 固定 entry 顺序、时间戳和大小上限 |
| Preview CSP | `parse5@8.0.0` | 对实际 inline script/style 计算 CSP SHA-256 |

内部 `PrototypeDocument`、Release pins、权限、状态机、checksum 和 adapter 输入仍由项目维护；不会把第三方编辑器或导出器的数据模型当数据库事实源。

## 3. 格式语义

### HTML

输出单文件 UTF-8 HTML。Prototype screen、node layout/style、Lucide icon、内嵌 image/font、navigate/setState/openUrl/submit action、literal binding 和 motion 都从 `workbench.prototype.v1` 生成。生成后必须在无网络 Chromium context 中执行且无 page/console error 才能发布。

### React

输出 ZIP，包含格式化后的 `src/App.jsx`、runtime、CSS、固定依赖版本及 esbuild 预编译的 `dist/`。构建失败时 ExportJob 明确失败，不返回空 ZIP 或占位地址。

当前实现先把本项目生成的静态 body markup 转成 JSX，state/action/binding/motion 仍由 IR 派生的 runtime data 驱动；这条路径是可验证的过渡实现，不是长期事实源。收口目标为 `PrototypeDocument -> RenderPlan -> React AST/runtime data`，HTML 与 React 只共享 RenderPlan，不互相反向转换。

### MCP

输出 ZIP，包含由官方 SDK 构建的 Node 22 stdio server。它只暴露冻结 manifest、board、ArtifactVersion resources，以及只读 `list_artifacts/get_artifact` tools，不连接主站数据库或运行时。

### Figma

ExportJob 从冻结的 Prototype IR 确定性生成 `workbench.figma-export.v1` ZIP，固定包含 `figma-export.json`、manifest、内容寻址资产和导入说明。合同记录 `compatibleImporterVersion: 1.0.0`；客户端不得传入转换器选项，也不存在服务端 PoC 开关。

`apps/workbench-figma-importer` 是唯一导入实现。它通过官方 Plugin API 创建可编辑 Page、Screen、文本、图片、SVG、auto-layout 和受支持的 Prototype 节点，并把源 ID、ArtifactVersion、action、binding、motion 与 transform origin 写入 `pluginData`。导入器和导出合同分别版本化，历史 ExportJob 不随插件升级漂移。

该链路不生成或伪装私有 `.fig`/Kiwi 文件，不读写 Figma 剪贴板协议，也不把插件节点结构作为数据库事实源。分发物固定为 `apps/workbench-figma-importer/dist/workbench-figma-importer-1.0.0.zip`；生产门禁仍须在真实 Figma Desktop 中验证字体、图片解码、大文件性能和当前官方 Plugin API。

## 4. 幂等与崩溃恢复

- API 在同一 PostgreSQL transaction 内写 ExportJob 和 pg-boss job，避免“有业务行、无队列消息”。
- Worker 只用条件更新领取 `queued`，重放遇到 terminal 状态立即返回。
- 输出字节确定后按 SHA-256 预留 Blob generation，S3 `If-None-Match: *` 防覆盖，并回读校验 byteSize/mediaType/SHA-256。
- S3 上传成功但 DB 响应丢失时，重试复用 `pending/exports/*` reservation 和相同 canonical key。
- Worker 不会接管 File Worker 的 `pending/blobs/*`；相同 digest 正在由其他所有者发布时重试。
- `Blob ready + ExportJob succeeded` 在同一数据库 transaction 发布；数据库 trigger 要求 revision 单步递增、终态不可修改、succeeded output 必须是非空 ready Blob。
- reconciler 重投长期 queued 或 stale running job；重复投递由数据库状态和内容寻址吸收。
- Web 恢复列表按业务时间和终态优先级选择有效结果，较旧的 `running` job 不得遮挡同一导出目标较新的 `succeeded` job；该排序场景已具备独立回归，真实 S3/IAM 与生产数据库恢复仍须外部环境验收。

## 5. 隔离边界

`workbench-export-worker`：

- Compose 只连接 `workbench-internal`，不连接 `workbench-egress`；生产 PostgreSQL/S3 必须提供私网 endpoint。
- read-only root filesystem、`no-new-privileges`、drop all capabilities、受限 tmpfs/PID/CPU/memory。
- Chromium 禁止 background networking，Playwright route 再次 abort HTTP/HTTPS/WSS 请求。
- 并发、输入/输出字节、浏览器时间和 pg-boss execution time 均有上限。
- 使用独立 `WORKBENCH_EXPORT_S3_*` IAM，只读 ready inputs，并仅写 export pending/canonical keys。

`workbench-preview`：

- 必须使用与 `WORKBENCH_WEB_ORIGIN` 不同的 `WORKBENCH_PREVIEW_ORIGIN`；iframe 声明 `credentialless`，Preview capability 请求若携带 `Cookie`、`Authorization` 或 `Proxy-Authorization` 一律拒绝，服务不把主站身份带入预览。
- capability token 为 HMAC-SHA256，payload 只含 `exportJobId/exp`，raw token 不落库。
- token 只解析到 `succeeded html ExportJob -> ready output Blob`，对象回读必须再次校验身份。
- CSP 基于实际 script/style 字节生成 hash；response sandbox 允许脚本但不含 `allow-same-origin`，`connect-src/object-src/frame-src/worker-src` 全部关闭。
- iframe 与 Preview 页通过固定 `penpal@7.0.6` 建立 capability 级 channel，只暴露 `workbench.preview` v1 `handshake`；父端校验配置 origin、严格返回 schema、8 秒连接超时与 2 秒调用超时，切换/刷新/失败/卸载均销毁连接。
- capability path 在 Preview Nginx 中关闭 access log，响应 `Referrer-Policy: no-referrer` 和 `Cache-Control: no-store`。
- 使用独立只读 `WORKBENCH_PREVIEW_S3_*` IAM。

## 6. 验收命令

```bash
npm --workspace @workbench/workbench-preview-token run typecheck
npm --workspace @workbench/workbench-preview-token run test
npm --workspace @workbench/workbench-export-core run typecheck
npm --workspace @workbench/workbench-export-core run test
npm --workspace @workbench/workbench-export-worker run typecheck
npm --workspace @workbench/workbench-export-worker run test
npm --workspace @workbench/workbench-preview run typecheck
npm --workspace @workbench/workbench-preview run test
npm --workspace @workbench/figma-importer run typecheck
npm --workspace @workbench/figma-importer run test
npm --workspace @workbench/figma-importer run package
```

受控 Chromium UI/sandbox 用例是仓库门禁：

```bash
WORKBENCH_RUN_BROWSER_INTEGRATION=1 npm --workspace @workbench/workbench-export-worker run test
```

该 Chromium 用例只证明生成内容可在无网络浏览器中打开，以及 Preview 的 opaque sandbox、CSP、Penpal handshake、origin/source、超时和销毁行为；使用 route mock、内存 fixture 或测试 token 时，不证明真实 API、PostgreSQL、S3/IAM、TLS、反向代理或生产 hostname 链路。

当前开发机没有 Docker CLI，只能验证 Compose YAML、单元/编译、受控 Chromium 和确定性插件分发包，不能声称镜像或全服务生产验收完成。生产验收还必须构建 Export 与 Preview 镜像，以真实 PostgreSQL、私网 S3、独立 IAM、Chromium 和独立双 HTTPS hostname 跑 HTTP E2E，并在真实 Figma Desktop 导入固定验收集。
