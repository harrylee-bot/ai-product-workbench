# 前端清理评审结论

日期：2026-06-26

## 评审结论

Claude Code 的前端交接里，样式清理、弹窗替换、admin 公共组件抽取、巨型文件拆分这些方向与新架构不冲突。

但原交接文档默认保留了一部分旧 runtime 前端入口，这会和 DeerFlow-first 流程冲突。因此本次已先做减法：

- 工作台不再调用旧的局部修改、内联编辑、原型局部编辑接口。
- 右侧预览只保留 PRD、Canvas、原型三个稳定视图。
- admin 日志中心不再暴露旧局部修改日志页面。
- 运行事件面板不再把旧 runtime 事件包装成特殊业务流程。
- 阻塞式浏览器弹窗已替换为项目内 Modal。
- seed 不再自动创建默认项目和默认会话。

## 可继续做但不阻塞新架构

- 拆分 `phase1-workspace-client.tsx` 的类型、store、normalizer、事件 reducer。
- 拆分 admin 的用户、模型、知识库、日志客户端。
- admin 区逐步迁移到 React Query。
- 抽取 admin 常用日期、表单、反馈组件。

这些属于维护性重构，可以在 DeerFlow runtime 接入前后分批做；不应该恢复任何旧 runtime 调用入口。
