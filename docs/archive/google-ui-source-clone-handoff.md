# Google Stitch 视觉来源复刻交接（历史归档）

更新时间：2026-07-10

> 本文只保留外部 Google Stitch 视觉来源、旧路径和旧调试凭据的历史证据；文中的 `Stitch` 不代表当前产品品牌。当前用户可见品牌为“产品工作台”，内部产品标识为 `workbench`。

## 1. 目标与硬性要求

目标是完整复刻 `https://stitch.withgoogle.com/` 的前端视觉、交互和动效。

执行顺序必须保持：

1. 先完成首页和画布的整体框架、颜色、布局与大动效。
2. 再完成画布背景、左右工具区域、对话框和生成阶段动画。
3. 整体通过后，才逐模块扣菜单、图标、文案和像素细节。
4. 样式和动效必须依据原版页面或录屏帧核对，不能凭感觉新增效果。

其他要求：

- 首页和画布页都必须保留。
- 使用当前开源画布实现，项目已使用 `@xyflow/react`。
- 只保留一个本地调试项目，不复制用户在 Stitch 中的全部项目。
- 不要把参考截图、录屏帧或其他参考素材加入应用源码。
- 不要使用 `3000` 端口，本项目固定预览在 `3010`。
- 不要恢复此前删除的 `docs/stitch-frontend-handoff.md` 或其他参考噪音。
- 工作树包含大量与本任务无关的用户修改，不得回退或覆盖。

## 2. Git 与运行环境

- 仓库：`/Users/liyannong/ai-product-workbench`
- 当前分支：`codex/stitch-frontend-handoff`
- 用户指定起点提交：`162c4f4 feat: hand off stitch frontend shell`
- 预览地址：`http://localhost:3010`
- 当前开发服务器：端口 `3010` 正在监听。

启动命令：

```bash
cd /Users/liyannong/ai-product-workbench
npm --workspace @workbench/web run dev -- --port 3010
```

本地前端预览认证：

- Cookie：`access_token=local-stitch-preview`
- Local Storage：`stitch-local-demo-user=1`

Playwright 已安装在仓库根目录，可直接：

```js
const { chromium } = require("playwright");
```

## 3. 主要代码位置

本任务应优先只改：

- `apps/web/components/stitch/stitch-workbench.tsx`
- `apps/web/app/globals.css`

相关但通常不需要继续改：

- `apps/web/app/(chat)/layout.tsx`
- `apps/web/lib/auth/nest-auth.tsx`
- `apps/web/package.json`
- `package-lock.json`

工作树中的 API、知识库、部署脚本等修改与本任务无关，不要处理。

## 4. 原版核对资料

原始录屏文件目前不在 Downloads 中，但已提取的原版帧仍在本机：

```text
/Users/liyannong/Downloads/video_frames/
```

这些文件只用于本机视觉核对，不要复制进仓库。

关键帧：

- `frame_001.jpg`：首页静态状态。
- `frame_002.jpg`：首页输入框聚焦状态。
- `frame_003.jpg`：首页输入状态。
- `frame_004.jpg`：首页提交中的加载状态。
- `frame_005.jpg`：进入画布后的初始状态。
- `frame_006.jpg` 至 `frame_009.jpg`：PRD、选择、对话框和开始生成。
- `frame_010.jpg` 至 `frame_014.jpg`：浅色界面生成及完成。
- `frame_015.jpg` 至 `frame_018.jpg`：深色界面生成、逐屏显现和完成。
- `frame_018.jpg`：当前画布完成态最重要参考。
- `frame_detailed_*.jpg`：悬停、聚焦、鼠标点阵高亮和中间生成状态。

原版画布有一个明确的大动效：鼠标附近的点阵会形成约 140px 半径的高亮区域，而不是只移动一层暗色径向渐变。

原版输入框聚焦后也不是静态亮边：紫色和青色边缘会持续沿轮廓移动，输入时保持，失焦后退回静态，提交时压暗。

## 5. 当前已完成内容

### 5.1 首页整体框架

- 顶栏、品牌、侧栏、公告、主标题、输入框、推荐词和灵感区域已重建。
- 1501x855 下主要位置已按原版校准。
- 主内容使用响应式 `clamp(...)`，不再依赖单一固定显示器宽度。
- 只显示一个本地调试项目。
- 首页提交后保留约 `760ms` 的加载状态，再进入画布。

### 5.2 首页输入框动效

- 首页输入框尺寸约 `1000x221`，位置已对齐原版。
- 聚焦、悬停、菜单打开或输入时使用持续彩色绕边动画。
- 动画名称：`stitch-composer-border-orbit`。
- 当前周期：`5.4s linear infinite`。
- 内部青紫弱光使用 `stitch-composer-inner-drift`。
- 失焦且无活动内容后，动态边缘透明度回到 `0`。
- 提交中动态边缘压暗，发送按钮显示旋转加载状态。

已验证截图：

```text
output/playwright/local-home-selection-idle.png
output/playwright/local-home-selection-hover.png
output/playwright/local-home-selection-focus-0.png
output/playwright/local-home-selection-focus-1.png
output/playwright/local-home-selection-focus-2.png
```

### 5.3 画布整体框架

- 使用 React Flow 实现画布、节点选择、拖拽、缩放和画布工具模式。
- 已有文档模式、生成模式以及 `generating / refining / complete` 三阶段。
- 已有生成进度 `0/3 -> 3/3`、逐屏显现、完成后视口切换和提示 Toast。
- 已有 93%、63%、28%、10% 等视口状态。
- 10% 鸟瞰实际缩放与显示标签分离，避免画面过大。
- 右侧工具条、顶部项目栏、缩放工具、分享和导出抽屉已实现。

### 5.4 画布背景鼠标动效

最新实现增加了两层 React Flow `Background`：

- 第一层为基础暗色点阵。
- 第二层为亮色点阵，通过径向 `mask-image` 只显示鼠标周围区域。
- 鼠标进入画布后设置 `data-stitch-pointer-active="true"`。
- 高亮半径当前为 `145px`，透明度为 `0.86`。
- 点阵尺寸和 gap 会随普通画布/生成画布/10% 鸟瞰状态匹配。

相关位置：

- `useStitchPointerVars(...)`
- `.stitch-pointer-background`
- `id="stitch-grid-base"`
- `id="stitch-grid-pointer"`

已验证截图：

```text
output/playwright/local-canvas-macro-pointer-highlight.png
```

### 5.5 画布底部对话框

已按原版重新校准：

- 距离底部 `16px`。
- 无文档附件时尺寸约 `580x96`。
- 带文档附件时尺寸约 `580x154`。
- 进入文档或生成画布后，输入框会清空并显示 placeholder，不再保留上一条已提交文本。
- 聚焦后使用持续绕边动画，当前周期 `5.8s`。
- `generating` 和 `refining` 都显示旋转加载状态。

Playwright 实测：

```text
普通画布对话框：x=460.5, y=743, width=580, height=96, bottom=16
文档画布对话框：x=460.5, y=685, width=580, height=154, bottom=16
```

已验证截图：

```text
output/playwright/local-canvas-macro-composer-focus.png
output/playwright/local-canvas-macro-composer-focus-later.png
```

### 5.6 左侧两个状态面板

顶部 Agent 面板：

- 固定 `left=16px, top=80px, width=280px`。
- 完成态高度约 `126px`。
- 生成态会展开，显示说明文本、进度文案和旋转状态图标。
- 青紫边缘使用 `stitch-agent-border-orbit` 持续运动。
- 完成态周期 `8.4s`，生成态周期 `5.8s`。

底部任务面板：

- 固定 `left=16px, bottom=16px, width=280px`。
- 完成态包含 Generate Prototype、历史任务和智能体日志入口。
- 高度会通过 Framer Motion layout 动画变化。
- 任务 pill 和状态 spinner 已实现。

刚刚完成但需要新对话首先复验的改动：

- 删除了叠在 Agent 图标上的第二个独立省略号按钮。
- Agent 图标现在只保留一个白色双点胶囊。
- 最后一张局部截图因截图时机/裁剪问题是空图，尚未完成最终视觉复验。

### 5.7 画布生成阶段动画

当前流程：

1. 首页提交后进入 `generating`。
2. 初始显示三张 PRD/生成中屏幕。
3. 约 `6.2s` 进入 `refining`。
4. 屏幕按中间、右侧、左侧顺序显现。
5. 进度依次变为 `1/3`、`2/3`、`3/3`。
6. 约 `9.3s` 进入 `complete`。
7. 视口平滑切换到完成态，左上状态卡收起，Toast 延迟出现。

最新完整阶段截图：

```text
output/playwright/local-canvas-macro2-generating-0.png
output/playwright/local-canvas-macro2-generating-1.png
output/playwright/local-canvas-macro2-refining.png
output/playwright/local-canvas-macro2-complete.png
```

## 6. 最近验证结果

最近一次完整验证在删除重复省略号按钮之前完成：

```bash
npm --workspace @workbench/web run typecheck
git diff --check -- apps/web/components/stitch/stitch-workbench.tsx apps/web/app/globals.css
```

两项均通过。

删除重复按钮后应重新运行一次上述命令。

## 7. 新对话应立即执行的顺序

不要先改菜单、文案或图标细节。按下面顺序继续：

1. 重新运行 typecheck 和 `git diff --check`。
2. 在 1501x855 下打开文档画布，确认左上只剩一个双点胶囊，没有叠加按钮。
3. 运行一次完整生成流程，检查 generating、refining、complete 三阶段。
4. 对照 `frame_015.jpg` 至 `frame_018.jpg`，只调整大面积颜色、视口、节点显现顺序和面板进退场。
5. 检查鼠标点阵高亮在 93%、63% 和 10% 三种缩放下是否与基础点阵完全重合。
6. 检查画布左侧上下两个面板的高度、底部 16px 间距和展开/收起动画。
7. 检查首页和画布输入框的聚焦、输入、失焦、提交四种动画状态。
8. 完成 1920x1080、1501x855、1440x900、1366x768、1280x720 的整体适配截图。
9. 大框架通过后，再处理样式菜单、模型菜单、侧栏 hover、公告、灵感轮播等细节。

## 8. 已知待处理项

- 最新双点 Agent 图标改动需要重新截图确认。
- 画布点阵聚光已实现，但需要检查不同缩放下是否出现点阵错位。
- 生成阶段的精确时间只能根据提取帧估算；如果新对话能稳定连接已登录的 Stitch 页面，应优先直接观察原版。
- 首页样式菜单和模型菜单已实现，但文案、位置和弹出动画尚未最终逐项审核。
- 右侧工具条及部分 hover/tooltip 已实现，但还未完成全模块 1:1 动效审核。
- 1280 和移动端需要重新检查，尤其是左侧状态面板、底部输入框和右侧工具条是否互相遮挡。
- 不要删除当前已完成的生成流程、分享/导出抽屉和视口逻辑。

## 9. Playwright 最小验证模板

```js
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({
    viewport: { width: 1501, height: 855 },
  });

  await context.addCookies([{
    name: "access_token",
    value: "local-stitch-preview",
    url: "http://localhost:3010",
  }]);

  const page = await context.newPage();
  await page.addInitScript(() => {
    localStorage.setItem("stitch-local-demo-user", "1");
  });

  await page.goto("http://localhost:3010", {
    waitUntil: "domcontentloaded",
  });

  await page.screenshot({
    path: "output/playwright/stitch-handoff-check.png",
  });

  await browser.close();
})();
```

## 10. 给新对话的首条指令建议

```text
读取 docs/stitch-clone-current-handoff.md，继续当前 Stitch 1:1 复刻任务。
先按文档第 7 节复验最新改动，不要先扣菜单和图标细节。
保持 localhost:3010，不要动工作树中的无关文件，也不要把参考图加入源码。
```
