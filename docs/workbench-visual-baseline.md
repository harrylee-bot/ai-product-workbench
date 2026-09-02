# 产品工作台前端保真基线

更新日期：2026-07-28

## 不可变要求

后台接入不得改变产品工作台新前端的可见布局、组件外观、操作路径、动效、动画、画布手势和响应式表现。真实数据接入只能通过 props、feature model、Query cache、Run reducer 和 Board store 进入现有视觉组件。

当前运行时为持久 `(workbench)` layout -> `WorkbenchRuntimeProvider` -> `WorkbenchScene`；Next Home/Project pages 只承担 URL 并返回 `null`。Home/Project 过渡由 Scene 内唯一的页面级 `AnimatePresence mode="sync"` 拥有，Project 经 fulfilled-module cache 动态拆包。Home/Project route root 使用稳定 `onUpdate` 订阅让根 opacity 留在 Framer 主线程驱动，避免 11.18.2 的 WAAPI 收尾阶段单帧回落到 initial 值；这不改变 DOM、CSS、Motion 参数或动画时序，未来升级 Framer 时必须重跑三浏览器逐帧非空门禁。P1 -> P2 固定 `key="project"`，Project root、header 和 React Flow DOM identity 必须保持；禁止 `key={projectId}` 或任何等价 remount。内部技术标识统一为 `workbench`，用户可见名称统一为“产品工作台”；选择器成对改名或注入数据后，仍必须用下方状态矩阵证明计算样式、渲染和交互等价。

## 浏览器基线

历史截图、已删除文件哈希和旧测试计数不再作为当前基线保存。浏览器门禁按下方状态矩阵生成临时截图和像素证据，验证完成后清理 `output/`；任何 PASS 只以当前命令与同一候选的证据为准。

NavigationGuard 必须在 Chromium、Firefox、WebKit 验证 Home/Project 过渡逐帧非空、被拒绝的 Back 不出现 Home 帧、P1 -> P2 提交规范 `/projects/p2` URL 与准确 Next route tree，以及 Project root/header/React Flow DOM identity 不变。Board 自动保存、离开 flush 与成功 retry 还必须复用同一 idempotency key 和完全相同的请求体快照。

## 必须覆盖的状态矩阵

1. 首页：idle、focus、typing、submitting；我的项目、与我共享、搜索、空状态；附件、命令、样式、模型菜单。
2. 项目：document generating/complete；generated generating 0/3、refining 1-3/3、complete 63%、overview 10%。
3. 画布：未选、单选、全选；10/28/57/63/93/100% 缩放；平移、框选；Frame、Draw、Media、Style、Special；撤销和重做。
4. Agent：折叠、展开、任务栈、历史选择、取消以及运行阶段动画。
5. 产物：PRD、三屏原型、刷新、预览、版本切换。
6. 分享：关闭、未启用、已启用、复制完成、撤销、公开访问和重混创建。
7. 导出：未选择、已选择、目标切换、进行中、完成、失败；Figma、HTML/CSS、React、MCP 四个目标都要验证真实产物。
8. 响应式：桌面不小于 1024px、平板小于 1024px、手机小于 640px。
9. 辅助入口：首页 Docs、Gift/公告、更多菜单，项目菜单中的 Docs、共享、导出、反馈、删除，以及帮助入口；每个可见按钮都必须验证真实导航、命令或明确的禁用状态。

## 回归规则

- 所有后端状态必须映射成当前 `phase`、`generationProgress` 和现有节点表现，禁止用新的加载页覆盖工作台。
- 禁止删除或缩短现有 motion/CSS keyframe；Run 结束只改变状态来源，不改变动画时间和 easing。
- 视觉截图之外还要验证键盘、outside click、拖拽、缩放、选择、取消、断线恢复和刷新恢复。
- “保留交互”不等于只保留按钮响应；当前可见工具、项目菜单、分享和四类导出必须产生可持久化、可恢复、可验证的真实结果。
- 视觉差异必须先证明是动态内容差异；布局、颜色、尺寸和动画差异一律视为回归。
