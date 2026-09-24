# Word/PDF 导出兼容补丁

Word 与 PDF 使用 `single_file`；HTML 保持 `single_file` 和 `zip` 两种形式，
React、Figma、MCP 保持 `zip`。
Word/PDF 选择必须恰好包含一个 PRD；多个产物的发布版本会被明确拒绝，不能只导出第一份。

## 数据库

只需按顺序应用以下两个新增迁移，无需重建 Runtime 队列或重新运行旧迁移：

1. `20260916010000_document_export_formats`
2. `20260916011000_document_export_packaging`

第一个迁移明确提交 `docx`、`pdf` 枚举值，第二个迁移再引用这些值。
不要把两个迁移放进同一个外层事务。执行身份应为 Workbench 数据库的专用
migrator，`search_path` 使用该部署的 Workbench schema。

迁移不修改既有记录，不关闭行级触发器，不替换业务函数。`preview` 任务仍然只
允许 HTML，普通导出任务继续受原有发布版本、状态流转、输出 Blob 和不可变性校验。

## 旧版运行时的定向更新

生产快照可能仍有 `initialScreenId` 预览字段及独立的任务失败信息/重试保护。
此补丁不要求修改这些行为。不要整包覆盖生产 `contracts/dist`、API `dist` 或
Prisma generated client 来修复导出，也不要为本地已删除的预览字段臆造默认值。

对旧快照只合并以下差异：

- 导出格式枚举和能力响应增加 `docx`、`pdf`。
- 导出请求校验与 `assertExportPackaging` 使用本文件开头的格式规则。
- 输出文件名映射增加 `.docx`、`.pdf`。
- Prisma 的 `ExportFormat` 枚举、对应运行时 schema 增加两种格式；保留其余旧版
  datamodel，特别是已有的 `initialScreenId`。

常规新镜像由 Dockerfile 中的 `prisma generate` 在 Linux 构建环境生成客户端。
旧镜像定向更新时应保留部署已有的 Linux query engine，不能用本地 macOS
`libquery_engine-darwin-*` 替换它。客户端包/engine 的 Prisma 版本必须一致。

## Worker 依赖与验证

Worker 使用单独的 Python virtualenv，安装带 SHA256 校验的 `python-docx`
和 `typing_extensions`；lxml、Pillow、LibreOffice Writer 与中文字体由发行版
包提供。镜像复制固定 Word 模板和质量检查脚本。

PDF 每次转换使用自身临时目录中的 LibreOffice profile，适配只读根文件系统，
避免并发转换共用 profile。渲染子进程超过两分钟会连同子进程组一起终止。

构建镜像时以 `node` 用户执行 `deploy/check-workbench-document-export.mjs`。
该检查使用真实 PRD 示例，经过请求契约、Word 渲染及质量校验，再转换 PDF，
验证输出格式与非空文档。使用本地已有依赖复查：

```sh
npm --workspace @workbench/workbench-contracts run build
npm --workspace @workbench/workbench-export-core run build
node deploy/check-workbench-document-export.mjs
```

上线验收仍需经过实际 API 创建导出任务、轮询成功、下载字节并核对摘要；
仅容器 healthy 或能力接口返回 available 不能代替该检查。
