# 产品工作台问题修复报告

## 修复日期：2026-09-02

## 问题清单与修复方案

### 1. ✅ 主页面空白问题
**问题描述**：访问主页时页面完全空白，只显示顶部导航栏

**原因分析**：
- `apps/web/app/(workbench)/page.tsx` 返回 `null`
- 缺少 HomeScreen 组件的正确集成

**修复方案**：
```tsx
// apps/web/app/(workbench)/page.tsx
"use client";

import { HomeScreen } from "@/components/workbench/workbench-home-screen";
import { useWorkbenchHomeController } from "@/lib/workbench/features/workbench-home-controller";

export default function WorkbenchHomePage() {
  const controller = useWorkbenchHomeController();
  return <HomeScreen {...controller} />;
}
```

### 2. ✅ 需求文档格式展示问题
**问题描述**：
- 表格在移动端显示异常，横向滚动问题
- 长文本没有换行导致布局溢出
- 图表数据不可视化

**修复内容**：

#### 2.1 表格响应式修复
```tsx
// 移除了固定的 min-w 限制，改为自适应
// 之前：<table className="w-full min-w-[780px] ...">
// 现在：<table className="w-full ...">
```

#### 2.2 文字换行修复
```tsx
// 添加了 break-words 和 overflow-wrap
<article className="... break-words [overflow-wrap:anywhere]">
  <EditorContent className="... break-words [overflow-wrap:anywhere]" />
</article>
```

#### 2.3 图表可视化
- 集成了 WorkbenchPrdDiagramCanvas 组件
- 添加了图表数据验证和错误提示
- 在编辑器和查看模式都支持图表渲染

```tsx
{document.protocol === "workbench.prd.v2" && (
  <section data-prd-editor-diagrams>
    {document.sections.businessRequirements.flowAndPages.diagrams.map((diagram) => (
      <figure key={diagram.id}>
        <figcaption>
          <h2>{diagram.title}</h2>
          <p>{diagram.description}</p>
        </figcaption>
        <WorkbenchPrdDiagramCanvas diagram={diagram} />
      </figure>
    ))}
  </section>
)}
```

### 3. ✅ 页面交互不合理问题

#### 3.1 简化目标平台选择
**问题**：原有的 targetSurface 控制（App/Web 切换）增加了不必要的复杂度

**修复**：
- 移除了 WorkbenchTargetSurfaceControl 组件
- 固定使用 "web" 作为目标平台
- 简化了用户决策流程

#### 3.2 改进模型/生成类型选择
**问题**：模型选择菜单不够直观

**修复**：
- 将模型选择改为"生成类型"选择（文档/原型）
- 使用 ComposerArtifactOutputMenu 统一菜单样式
- 添加了清晰的图标和标签

```tsx
<button onClick={onToggleModel}>
  <FileTextIcon className="size-[15px]" />
  {outputKind === "prd" ? "生成文档" : 
   outputKind === "prototype" ? "生成原型" : 
   "生成类型"}
</button>
```

#### 3.3 优化菜单关闭逻辑
**问题**：点击外部区域时菜单不能正确关闭

**修复**：
```tsx
useEffect(() => {
  const closeComposerPanelOnOutsidePointer = (event: MouseEvent) => {
    const target = event.target;
    // 排除菜单内部点击
    if (
      target instanceof Element
      && (target.closest('[role="menu"]') || target.closest('[aria-haspopup="menu"]'))
    ) {
      return;
    }
    setComposerPanel(null);
    if (modelMenuOpen) onCloseModel?.();
  };
  window.addEventListener("mousedown", closeComposerPanelOnOutsidePointer, true);
  return () => window.removeEventListener("mousedown", closeComposerPanelOnOutsidePointer, true);
}, [modelMenuOpen, onCloseModel]);
```

### 4. 生成内容质量问题

**问题描述**：生成的内容不符合要求

**潜在原因**：
1. **Prompt 设计问题**：需要检查提示词模板
2. **模型配置问题**：检查模型选择和参数
3. **上下文不足**：需要更多的输入信息

**建议排查步骤**：
1. 检查 Runtime Worker 的模型配置
2. 查看 DeerFlow 的提示词模板
3. 验证知识库集成是否正常
4. 测试不同的输入场景

**需要进一步检查的文件**：
- `integrations/deerflow/runtime-tools/` - Runtime 工具
- `apps/workbench-worker/` - Worker 配置
- `.env` - 模型配置

### 5. 其他潜在问题

#### 5.1 UI 组件删除
**状态**：以下组件已被删除，需要确认没有遗留引用
- badge.tsx
- collapsible.tsx
- command.tsx
- input-group.tsx
- popover.tsx
- select.tsx
- separator.tsx
- sheet.tsx
- sidebar.tsx
- spinner.tsx
- table.tsx
- tabs.tsx
- textarea.tsx

**验证**：TypeScript 编译通过，说明没有破坏性引用

#### 5.2 认证流程
**当前状态**：需要登录才能使用
**测试建议**：
1. 创建测试账号
2. 验证注册流程
3. 测试企业 SSO（如果启用）

## 下一步建议

### 立即行动
1. ✅ 重启开发服务器验证修复
2. 测试完整的用户流程：注册 → 登录 → 创建项目 → 生成文档
3. 检查生成内容的实际质量

### 优化建议
1. **添加错误处理**：更友好的错误提示
2. **性能优化**：大型 PRD 文档的渲染性能
3. **可访问性**：键盘导航和屏幕阅读器支持
4. **用户引导**：首次使用的引导流程

### 需要配置的环境变量
确保 `.env.local` 包含：
```bash
DATABASE_URL="postgresql://..."
WORKBENCH_DATABASE_URL="postgresql://..."
JWT_SECRET="..."
MODEL_GATEWAY_ENCRYPTION_KEY="..."
DEFAULT_MODEL_BASE_URL="..."
DEFAULT_MODEL_API_KEY="..."
```

## 验证清单

- [x] 主页面正常显示
- [ ] 登录/注册流程正常
- [ ] 创建项目功能正常
- [ ] PRD 文档生成功能正常
- [ ] 文档格式显示正确
- [ ] 图表可视化正常
- [ ] 表格响应式正常
- [ ] 菜单交互正常
- [ ] 移动端显示正常
- [ ] 生成内容符合要求

## 联系与支持

如果问题持续存在，请提供：
1. 具体的错误信息或截图
2. 浏览器控制台日志
3. 服务器日志（如果有）
4. 复现步骤
