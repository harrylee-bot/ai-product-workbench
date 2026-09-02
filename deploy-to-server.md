# 部署产品工作台到服务器

## 当前状态
- **提交**: `0159818f` 
- **分支**: `codex/runtime-database-remediation`
- **已推送**: ✅ 已推送到 GitHub

## 部署步骤

### 1. 准备工作

**在服务器上执行：**

```bash
# 进入项目目录
cd /path/to/ai-product-workbench

# 如果服务器上还没有代码，先克隆
# git clone https://github.com/harrylee-bot/ai-product-workbench.git
# cd ai-product-workbench

# 确保有部署配置文件
ls -la deploy/workbench.env
```

如果没有 `workbench.env`，需要创建：

```bash
cp deploy/workbench.env.example deploy/workbench.env
# 然后编辑 deploy/workbench.env，填写实际的配置
```

### 2. 拉取最新代码

```bash
# 拉取最新代码
git fetch origin
git checkout codex/runtime-database-remediation
git pull origin codex/runtime-database-remediation

# 验证提交
git log -1 --oneline
# 应该显示: 0159818f fix(workbench): resolve critical UI and interaction issues
```

### 3. 执行部署

**方式一：使用项目自带的部署脚本**

```bash
WORKBENCH_ENV_FILE="$PWD/deploy/workbench.env" \
WORKBENCH_DEPLOY_IMAGE_MODE=build \
WORKBENCH_PREFLIGHT_SCRIPT="$PWD/deploy/workbench-server-preflight.sh" \
DEPLOY_TARGET=all \
bash deploy/server-deploy.sh
```

**方式二：更新已运行的服务（如果服务已在运行）**

```bash
# 更新所有服务
WORKBENCH_ENV_FILE="$PWD/deploy/workbench.env" \
DEPLOY_TARGET=all \
bash deploy/server-deploy.sh
```

**方式三：只更新 Web 前端**

```bash
WORKBENCH_ENV_FILE="$PWD/deploy/workbench.env" \
DEPLOY_TARGET=workbench-web \
bash deploy/server-deploy.sh
```

### 4. 验证部署

```bash
# 检查容器状态
docker compose -f deploy/workbench-compose.yml ps

# 查看日志
docker compose -f deploy/workbench-compose.yml logs workbench-web --tail 50
docker compose -f deploy/workbench-compose.yml logs workbench-api --tail 50

# 检查健康状态
docker ps --filter "name=workbench" --format "table {{.Names}}\t{{.Status}}"
```

### 5. 访问应用

根据配置文件中的 `WORKBENCH_WEB_ORIGIN`，访问：
- 生产环境：`https://aionbench.com`
- 本地测试：`http://localhost:4180`

## 快速部署脚本

如果服务器上已有配置，可以使用这个一键脚本：

```bash
#!/usr/bin/env bash
set -Eeuo pipefail

cd /path/to/ai-product-workbench

echo "拉取最新代码..."
git fetch origin
git checkout codex/runtime-database-remediation
git pull origin codex/runtime-database-remediation

echo "执行部署..."
WORKBENCH_ENV_FILE="$PWD/deploy/workbench.env" \
WORKBENCH_DEPLOY_IMAGE_MODE=build \
DEPLOY_TARGET=all \
bash deploy/server-deploy.sh

echo "部署完成！"
docker compose -f deploy/workbench-compose.yml ps
```

## 本次修复内容

本次部署包含以下关键修复：

1. ✅ **修复主页面空白问题** - 集成 HomeScreen 组件
2. ✅ **修复 PRD 文档格式** - 响应式表格、文字换行、图表可视化
3. ✅ **优化页面交互** - 简化平台选择、改进菜单逻辑
4. ✅ **添加修复文档** - 详见 FIXES.md

## 回滚方案

如果部署后出现问题，可以回滚到上一个版本：

```bash
# 查看上一个提交
git log -2 --oneline

# 回滚到上一个提交
git checkout <previous-commit-hash>

# 重新部署
WORKBENCH_ENV_FILE="$PWD/deploy/workbench.env" \
DEPLOY_TARGET=all \
bash deploy/server-deploy.sh
```

## 故障排查

### 问题：容器启动失败

```bash
# 查看详细日志
docker compose -f deploy/workbench-compose.yml logs --tail 100

# 检查配置
docker compose -f deploy/workbench-compose.yml config
```

### 问题：数据库连接失败

```bash
# 检查数据库容器
docker compose -f deploy/workbench-compose.yml ps postgres

# 测试数据库连接
docker compose -f deploy/workbench-compose.yml exec postgres \
  psql -U workbench_runtime -d workbench -c "SELECT 1"
```

### 问题：前端白屏

1. 检查浏览器控制台错误
2. 查看 workbench-web 日志
3. 确认 API 服务正常运行
4. 检查 CORS 配置

## 注意事项

1. **备份数据**：部署前建议备份数据库
2. **配置检查**：确保所有环境变量正确配置
3. **健康检查**：部署后验证所有服务健康状态
4. **监控日志**：持续监控应用日志确保稳定运行

## 需要帮助？

如果部署过程中遇到问题：
1. 检查 [FIXES.md](../FIXES.md) 了解本次修复详情
2. 查看服务器日志定位具体错误
3. 提供错误信息和日志以获取支持
