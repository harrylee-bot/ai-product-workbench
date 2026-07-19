# 线上知识库整理与跳转故障交接

更新时间：2026-07-10 23:25（Asia/Shanghai）

## 一句话状态

用户截图对应的侧栏/全局关系图跳转丢失 `/knowledge` 问题已经修复并上线。生产当前提交为 `3386d9e2`，健康检查正常，Explorer 实际点击已验证成功。继续接手时不要重复排查 DNS；当前待处理的是表格内 Wiki 链接渲染、虚拟文件夹页重复列表、品牌名和模板目录公开等站点质量问题。

## 本轮范围

- 全面检查线上知识库：<https://aionbench.com/knowledge/>
- 整理本地 `knowledge-vault` 的分层、索引和审计规则。
- 检查用户给出的 `原型转HTML.zip` 与 `html.zip`，归档原包并补充结构化索引。
- 修复用户截图中的页面跳转报错。
- 验证源站、CDN、Quartz 构建结果和真实浏览器交互。

## 已完成

### 1. 两个 HTML 原型包均已归档和索引

原包只保存在 `storage/`，没有塞进公开 Quartz 站点：

```text
storage/source-assets/prototype-html/原型转HTML.zip
storage/source-assets/prototype-html/html.zip
```

对应结构化索引：

```text
knowledge-vault/07-来源资产索引/旧版整理/01-产品知识/手册与原型资料库/原型转HTML资产索引-2026-07-03.md
knowledge-vault/07-来源资产索引/旧版整理/01-产品知识/手册与原型资料库/HTML原型补充资产索引-2026-07-10.md
```

校验值：

```text
原型转HTML.zip  SHA-256 5e1322d9ab4bdafcd58d619f92742736d3f14e59ba8778b7cc72fa28b724453a
html.zip          SHA-256 712790a2dfb02e4fda1f935c155306b2233a191c60d70c28a1b06cf02d9bbf7f
```

`html.zip` 包含 33 套项目、8142 个文件，其中 436 个 HTML；两包内容不同，不能互相替代。

### 2. 跳转报错根因已确认

不是 DNS 故障，实际有三层问题：

1. Quartz Explorer 和 Graph 通过 `document.body.dataset.basepath` 生成链接。
2. 当前固定的 Quartz `v5.0.0` 不会输出 `data-basepath`，导致点击后从 `/knowledge/...` 变成站点根路径 `/...`。
3. CDN 曾把旧 HTML 缓存 3600 秒，源站临时修复后公网仍会命中旧对象。

另一个独立问题是 Quartz 缺少 frontmatter 解析插件，YAML 会出现在正文里，页面标题变成“无题”。

### 3. 已上线的代码修复

提交 `f1ed4529 fix(knowledge): preserve base path navigation`：

- `apps/knowledge/finalize-output.mjs`
  - 构建后遍历 HTML。
  - 从 `QUARTZ_BASE_URL=aionbench.com/knowledge` 推导 `/knowledge`。
  - 给所有含 `<body>` 的真实页面注入 `data-basepath="/knowledge"`。
  - 跳过没有 `<body>` 的 alias redirect 页面。
  - 可重复执行，第二次不会再次改写。
- `apps/knowledge/Dockerfile`
  - 把 finalizer 复制进镜像。
- `apps/knowledge/docker-entrypoint.sh`
  - Quartz 构建完成后运行 finalizer。
- `apps/knowledge/quartz.config.yaml`
  - 加入锁定版本的 `note-properties` 插件。
  - 隐藏属性面板，只解析 frontmatter。
  - 禁用额外的 `article-title`，避免页面出现两个 H1。
- `apps/knowledge/quartz.lock.json`
  - 锁定 `note-properties` 到 `3cb40141e792a8a9ba9f99553cd436f36411bf8d`。
- `apps/knowledge/nginx.conf`
  - HTML 响应增加 `no-cache, no-store, must-revalidate`，防止以后发布继续被 CDN 留旧页。

提交 `3386d9e2 fix(knowledge): remove invalid template date`：

- 删除 `_templates/知识条目模板.md` 中会被 Quartz 当成坏日期的 `date: YYYY-MM-DD`。
- 线上持久化知识卷优先于镜像种子，因此已手工把该已提交模板从 `/seed-vault` 同步到 `/storage/knowledge-vault` 并重启容器。

### 4. 当前生产状态

```text
服务器：8.130.160.177
代码目录：/opt/ai-product-workbench
分支：prod
HEAD：3386d9e2
容器：ai-product-knowledge
健康检查：http://127.0.0.1:3001/__health -> ok
```

生产仓库里仅有一个已知未跟踪目录：`backups/`。不要删除。

已推送的连续提交：

```text
799c8bec docs: index supplemental html prototypes
f1ed4529 fix(knowledge): preserve base path navigation
3386d9e2 fix(knowledge): remove invalid template date
```

独立干净工作树：

```text
/tmp/aipw-online-knowledge-reorg
branch: codex/online-knowledge-reorg
```

主工作区 `/Users/liyannong/ai-product-workbench` 有大量其他任务的未提交修改，绝对不要整体 `git add .`、reset 或覆盖。

## 已完成验证

### 知识库审计

命令：

```bash
npm run audit:knowledge-vault
```

结果：

```text
passed: true
Markdown: 85
进入索引: 78
排除: 7
errors: 0
```

剩余两条历史提示不阻塞发布：

- 一个 2026-06-22 旧需求资产清单过长。
- 来源/收件箱有 34 个旧条目缺 `description`，它们不参与正式生成。

### 生产 HTML

容器内统计：

```json
{"html":391,"body":236,"redirects":155,"missing":0,"untitled":0,"frontmatter":0}
```

解释：

- 236 个真实页面全部有 `data-basepath="/knowledge"`。
- 155 个 alias redirect HTML 没有 `<body>`，finalizer 按设计跳过。
- “无题”页面为 0。
- frontmatter 泄漏到正文为 0。

### CDN

当前首页响应：

```text
Cache-Control: no-cache, no-store, must-revalidate
Pragma: no-cache
Expires: 0
X-Cache: MISS TCP_MISS
X-Swift-CacheTime: 0
```

旧的 3600 秒缓存问题已经消除。

### Playwright

已验证：

- 首页标题为 `策划宝产品知识库`，不是“无题”。
- Explorer 中所有一级目录链接都包含 `/knowledge/`。
- 点击 `07-来源资产索引` 后 URL 仍为 `/knowledge/07-来源资产索引/`，HTTP 200。
- 全局关系图弹窗可以打开并正常绘制，不再是空白 Canvas。
- 浏览器控制台只有 Explorer 调试日志，没有 404 或 JavaScript 错误。

尚未完成：

- 还没有稳定点中一个“非当前页”的 Graph Canvas 节点，因此 Graph 节点跳转只验证了弹窗和路径生成逻辑，未完成最终点击断言。
- 移动端 390px 视口尚未做最后截图回归。

Playwright 临时产物在主工作区 `.playwright-cli/`，无需提交。

## 新发现但尚未处理

以下问题是在真实浏览器回归时发现的，均未提交修改。

### P1：Markdown 表格里的 Wiki 链接被拆坏

首页“目录职责”表格已经能看到字面量 `[[00-知识库使用规范/README`，别名被拆到下一列。

根因：Markdown 表格中的 Wiki 别名分隔符必须转义：

```text
错误：[[path|label]]
正确：[[path\|label]]
```

受影响的不止首页。定位命令：

```bash
rg -n '^\|.*\[\[[^]]+\|[^]]+\]\]' knowledge-vault -g '*.md'
```

建议：只对表格行中的 Wiki 链接做机械转义，并在 `scripts/knowledge-vault-audit.mjs` 增加硬检查，避免再次回归。不要全库替换普通段落里的 Wiki 链接。

### P1：虚拟文件夹页把同一列表渲染两次

例如 `/knowledge/07-来源资产索引/` 会连续显示两遍“此文件夹下有 2 条笔记”。

根因位于固定 Quartz v5 核心：

```text
/opt/quartz/quartz/plugins/pageTypes/dispatcher.ts
populateVirtualPageHtmlAst(...)
```

它先把 `FolderContent` 渲染结果写回虚拟页 `tree`，正式输出时又用同一个 `FolderContent` 包裹该 `tree`，形成嵌套重复。不要只靠 CSS 隐藏；应优先确认上游是否已有修复，再选择升级锁定 Quartz commit 或对 dispatcher 做带 `git apply --check` 的显式补丁。

### P1：站点品牌名不一致

`apps/knowledge/quartz.config.yaml` 仍配置：

```yaml
pageTitle: 业务需求知识库
```

正文和浏览器标题使用“策划宝产品知识库”。左上角当前仍显示“业务需求知识库”。应统一为“策划宝产品知识库”。

### P1：`_templates` 被公开在 Explorer

当前 `ignorePatterns` 有 `templates`，但真实目录叫 `_templates`，因此模板目录被公开并进入关系图。应增加 `_templates`，重新构建后确认模板不在 HTML、`contentIndex.json`、Explorer 和 Graph 中。

### P2：Graph 可读性一般

全局图中有大量孤立节点沿边缘分布。先修复表格 Wiki 链接并排除 `_templates`，再评估是否需要把来源层/收件箱从默认 Graph 隐藏；不要直接删知识。

### P2：第三方插件有打包告警

`note-properties` 内置的 `gray-matter` JavaScript engine 含 `eval`，esbuild 会发 direct-eval 告警。当前配置固定使用 YAML，实际走 `yaml.safeLoad`，不会调用 JavaScript engine；这是残余告警，不是本轮跳转故障。后续若替换插件，应重新验证 frontmatter、标题、别名和标签。

## 部署注意事项

### `QUARTZ_BASE_URL` 有陷阱

生产 `.env` 里的旧值仍是：

```text
QUARTZ_BASE_URL="8.130.160.177:3001"
```

本轮部署通过 shell 显式覆盖为 `aionbench.com/knowledge`。如果直接执行普通 `docker compose up` 而不覆盖，会再次生成空 base path。

可用部署方式：

```bash
cd /opt/ai-product-workbench
git pull --ff-only origin prod
QUARTZ_BASE_URL=aionbench.com/knowledge \
  docker compose --env-file .env -f deploy/docker-compose.yml up -d --build knowledge
```

`deploy/server-deploy.sh` 会根据 `KNOWLEDGE_APP_PUBLIC_URL` 重新计算正确值，但脚本内部使用 `git reset --hard`；接手者应先确认生产工作树，避免覆盖未知修改。

长期应把生产 `.env` 的 `QUARTZ_BASE_URL` 改成 `aionbench.com/knowledge`，然后再取消显式覆盖。

### 镜像种子不会覆盖线上知识卷

容器配置：

```text
QUARTZ_CONTENT_DIR=/storage/knowledge-vault
volume: api-storage:/storage
image seed: /seed-vault
```

entrypoint 只在知识卷完全为空时复制 `/seed-vault`。因此只提交 `knowledge-vault/*.md` 并重建镜像，不会自动更新线上已有知识。内容修改还需要通过项目知识同步机制写入 `api-storage`；不要用镜像重建误判为已同步。

## 建议接手顺序

1. 从 `/tmp/aipw-online-knowledge-reorg` 或生产 `3386d9e2` 新建干净工作树，不要在主工作区混合提交。
2. 修复表格 Wiki 链接并给审计脚本加回归门禁。
3. 处理 Quartz 虚拟文件夹重复列表，优先核对上游修复。
4. 统一 `pageTitle`，排除 `_templates`。
5. 运行 `node --check apps/knowledge/finalize-output.mjs`、`git diff --check`、`npm run audit:knowledge-vault`。
6. 构建并部署时显式设置正确 `QUARTZ_BASE_URL`，同时把内容变更同步到线上知识卷。
7. 容器内再次统计 `missing/untitled/frontmatter`，并检查 CDN 为 `X-Swift-CacheTime: 0`。
8. 用 Playwright完成 Explorer、正文链接、Graph 非当前节点、Escape/外部点击关闭、桌面和 390px 移动端回归。

## 最终验收标准

- 任意 Explorer、正文、面包屑、标签和 Graph 节点跳转始终保留 `/knowledge`。
- 真实页面 0 个缺少 `data-basepath="/knowledge"`。
- 0 个“无题”页面，0 个 frontmatter 正文泄漏。
- 表格中不出现字面量 `[[...`，所有链接可点击。
- 文件夹页列表只出现一次。
- `_templates` 不出现在公开索引、Explorer 和 Graph。
- 左上角、首页 H1、浏览器标题品牌一致。
- 桌面和移动端无内容重叠，Graph 可打开、跳转、关闭。
- CDN HTML 缓存时间为 0，发布后不再持续返回旧页面。
