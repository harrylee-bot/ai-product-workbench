# [历史归档] Gemini Canvas UI/UX 迁移计划

## 目标
将 gemini-canvas-replica 的完整 UI/UX/交互迁移到 ai-product-workbench，保持所有功能、交互和视觉一致性。

## 关键差异分析

### 1. 布局结构 (Layout)

**源 (gemini-canvas-replica):**
```jsx
<main className="gemini-shell">
  <Rail />                        {/* 56px 固定宽度 */}
  <ChatPane />                    {/* 390-482px */}
  <CanvasPanel />                 {/* flex 1 */}
</main>

// Canvas 关闭时
<main className="gemini-shell is-canvas-closed">
  <Rail />                        {/* 56px */}
  <ChatPane />                    {/* 640px+ 居中 */}
</main>
```

**目标 (ai-product-workbench):**
```tsx
<SidebarProvider>
  <AppSidebar />                  {/* 可折叠，宽度不固定 */}
  <SidebarInset>
    <ChatHeader />
    <Messages />
    <MultimodalInput />
  </SidebarInset>
  <Artifact />                    {/* 条件渲染 */}
</SidebarProvider>
```

**需要改动:**
- ✅ shell.tsx: 改为三栏固定布局 `grid-template-columns: 56px minmax(390px,482px) minmax(560px,1fr)`
- ✅ 移除 SidebarProvider，使用固定宽度 Rail
- ✅ Canvas 关闭时切换为 `grid-template-columns: 56px minmax(640px,1fr)`

---

### 2. Rail 导航栏

**源:**
- 56px 固定宽度
- Gemini sparkle logo 顶部
- 垂直导航按钮
- 底部设置 + 用户头像

**目标 (app-sidebar.tsx):**
- 可折叠侧边栏
- 宽度不固定
- 历史对话列表

**需要改动:**
- ✅ 创建新的 `rail.tsx` 组件
- ✅ 56px 固定宽度
- ✅ Gemini sparkle icon
- ✅ 简化导航按钮
- ✅ 底部头像圆形按钮

---

### 3. Canvas 面板样式

**源:**
```css
.canvas-panel {
  border-radius: 34px;
  border: 1px solid #3c4043;
  box-shadow: 0 22px 58px rgba(0,0,0,0.42);
  background: #1f1f1f;
  margin: 24px 48px 24px 0;
  height: calc(100vh - 48px);
}
```

**目标 (artifact.tsx):**
- 矩形面板，无圆角
- 不同的阴影和边框

**需要改动:**
- ✅ artifact.tsx: 添加 `artifact-panel` class
- ✅ 34px 圆角
- ✅ Canvas 阴影
- ✅ 外边距 24px

---

### 4. 聊天消息样式

**源 (ChatPane.jsx):**
```jsx
// 用户消息
<div className="user-bubble">
  {message}
</div>

// 助手消息
<div className="streaming-assistant">
  <SparkleIcon />
  <div className="streaming-text">
    {text}<span className="typing-caret" />
  </div>
</div>

// Canvas 卡片
<button className="canvas-doc-card">
  <div className="card-header">
    <FileIcon />
    <span>{title}</span>
  </div>
  <small>{subtitle}</small>
  {!panelOpen && <span>打开</span>}
</button>
```

**目标 (message.tsx):**
- 统一的 message 容器
- 不同的样式类

**需要改动:**
- ✅ message.tsx: 用户消息添加 `user-message-bubble` class
- ✅ 助手消息添加 Gemini sparkle icon
- ✅ 添加 typing caret 动画
- ✅ canvas-document-card.tsx: 应用 Gemini 卡片样式

---

### 5. Prompt 输入框

**源:**
```jsx
<form className="prompt-box">
  <textarea placeholder="输入消息" />
  <div className="prompt-actions">
    <button className="send-button">
      <SendIcon />
    </button>
  </div>
</form>
```

**目标 (multimodal-input.tsx):**
- 复杂的多模态输入
- 文件上传、Canvas 模式切换等

**需要改动:**
- ✅ multimodal-input.tsx: 添加 `composer-box` class
- ✅ 圆角 28px
- ✅ Send 按钮圆形白色背景
- ✅ 简化视觉，保持功能

---

### 6. Canvas Header

**源 (CanvasHeader.jsx):**
```jsx
<header className="canvas-header">
  <div className="document-title">
    <Icon name="description" />
    <span>{title}</span>
    <small>版本 {revision}</small>
  </div>
  <div className="header-tools">
    <button>文档</button>
    <button>HTML</button>
    <button className="tool-button">导出</button>
    <button className="tool-button">关闭</button>
  </div>
</header>
```

**目标 (artifact-actions.tsx):**
- 不同的布局和按钮样式

**需要改动:**
- ✅ artifact-actions.tsx: 重构为 Gemini header 样式
- ✅ 左侧标题 + 版本号
- ✅ 右侧工具按钮

---

### 7. 流式生成动画

**源:**
- Loading dots (3个动画点)
- Typing caret (闪烁光标)
- Canvas 呼吸动画
- Shimmer 骨架屏

**目标:**
- 基础的 loading spinner

**需要改动:**
- ✅ 添加 LoadingDots 组件
- ✅ 添加 typing caret CSS 动画
- ✅ 添加 canvas-breathe 动画
- ✅ 添加 shimmer 骨架屏样式

---

### 8. FloatingTools 悬浮工具栏

**源 (FloatingTools.jsx):**
- Canvas 右侧悬浮工具条
- 工具抽屉弹出

**目标:**
- 不存在

**需要改动:**
- ✅ 创建 floating-tools.tsx
- ✅ 绝对定位在 Canvas 右侧
- ✅ 工具按钮垂直排列

---

### 9. Document Editor

**源 (DocumentCanvas.jsx):**
- TipTap 编辑器
- 实时流式写入
- Cursor spark 动画

**目标 (text-editor.tsx):**
- ProseMirror 编辑器
- 不同的样式

**需要改动:**
- ✅ text-editor.tsx: 保持 ProseMirror
- ✅ 添加 cursor spark 动画（可选）
- ✅ 应用 Gemini 文档样式

---

### 10. HTML Canvas

**源 (HtmlCanvas.jsx):**
- Monaco 编辑器 + iframe 预览
- 分栏切换（代码/预览/分屏）
- 工具栏按钮

**目标 (code-editor.tsx):**
- Monaco 编辑器
- 不同的布局

**需要改动:**
- ✅ code-editor.tsx: 添加分栏模式
- ✅ 添加预览 iframe
- ✅ 工具栏样式

---

## 实施顺序

### Phase 1: 核心布局 (1-2 小时)
1. ✅ globals.css - Gemini 颜色变量（已完成）
2. ⏳ shell.tsx - 三栏布局
3. ⏳ rail.tsx - 创建 Rail 组件
4. ⏳ artifact.tsx - 圆角 Canvas 面板

### Phase 2: 消息和输入 (1 小时)
5. ⏳ message.tsx - Gemini 消息气泡
6. ⏳ multimodal-input.tsx - Gemini prompt 输入框
7. ⏳ canvas-document-card.tsx - Canvas 卡片样式

### Phase 3: Canvas 功能 (1-2 小时)
8. ⏳ artifact-actions.tsx - Canvas header
9. ⏳ floating-tools.tsx - 悬浮工具栏
10. ⏳ code-editor.tsx - HTML 预览模式

### Phase 4: 动画和细节 (30 分钟)
11. ⏳ 添加 LoadingDots 组件
12. ⏳ Typing caret 动画
13. ⏳ Canvas 呼吸动画
14. ⏳ Shimmer 骨架屏

---

## 功能对齐清单

### ✅ 已有功能（保持）
- 聊天历史
- 消息编辑
- 文件上传
- Canvas 文档生成
- 代码高亮
- Markdown 渲染
- 用户认证
- 数据持久化

### ❌ gemini 有但 workbench 缺失
- [低] Canvas 开关平滑动画
- [中] FloatingTools 悬浮工具栏
- [低] ToolDrawer 工具抽屉
- [中] 文档版本号显示
- [低] Cursor spark 动画
- [中] HTML 预览分栏模式
- [低] 响应式布局优化

### 🔄 需要样式调整
- [高] 三栏布局替换侧边栏
- [高] Rail 替换 AppSidebar
- [高] 圆角 Canvas 面板
- [高] 用户消息气泡
- [高] Prompt 输入框样式
- [中] Canvas header 样式
- [中] Loading dots 动画
- [低] 按钮 hover 效果

---

## 技术注意事项

1. **保持现有功能**: 不删除任何后端逻辑、API 调用、状态管理
2. **样式优先**: 主要是 CSS 和组件结构调整
3. **渐进式迁移**: 一个组件一个组件改，每改完验证功能正常
4. **响应式**: Gemini replica 是固定宽度，workbench 需要保持响应式
5. **TypeScript**: 保持类型安全
6. **性能**: 不引入新的性能问题

---

## 验证标准

每个组件改完后验证：
- ✅ TypeScript 编译通过
- ✅ 视觉样式与 Gemini 一致
- ✅ 原有功能正常工作
- ✅ 无控制台错误
- ✅ 动画流畅（60fps）

---

## 下一步

从 Phase 1 开始：修改 shell.tsx 实现三栏布局。
