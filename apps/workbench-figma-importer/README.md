# 产品工作台 Importer

这是固定版本 `1.0.0` 的 Figma Desktop 插件。它只读取产品工作台导出的离线 ZIP，不访问网络、不生成或伪造 `.fig` 文件。

## 构建

```bash
npm run package
```

构建会先运行 `create-figma-plugin@4.0.3`，再生成可分发的 `dist/workbench-figma-importer-1.0.0.zip`。插件的固定入口位于 `build/main.js` 和 `build/ui.js`，合同版本由 `@workbench/workbench-contracts` 的 `workbenchFigmaImporterVersion` 约束。

## 在 Figma Desktop 使用

1. 打开 Figma Desktop，进入 **Plugins → Development → Import plugin from manifest…**。
2. 选择本目录生成的 `manifest.json`，或解压分发 ZIP 后选择其中的 `manifest.json`。
3. 运行 **产品工作台 Importer**，选择产品工作台导出的 ZIP。

插件 UI 会先解压并校验 `figma-export.json` 与 `assets/<sha256>.<ext>`，主线程会再次校验合同和 SHA-256，然后通过官方 Plugin API 创建 Page、Screen frame 与可编辑节点。节点会写入源 ArtifactVersion、Prototype id、动作、绑定、动效和旋转原点等 pluginData，便于后续追溯。

真实 Figma Desktop Plugin API、字体是否安装、图片解码和大文件性能仍需在 Figma Desktop 中进行最终验收；Vitest fake API 只验证确定性导入计划和 API 调用契约。
