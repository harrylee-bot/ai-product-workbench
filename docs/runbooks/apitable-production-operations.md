# APITable 生产运维

本 runbook 定义 `requirements.aionbench.com` 需求池的连接事实、操作边界和验证步骤。仓库不保存密码、密钥、Cookie 或数据库凭据。

## 当前入口

| 项目 | 当前值 |
| --- | --- |
| 用户域名 | `https://requirements.aionbench.com` |
| Origin IPv4 | `45.207.206.119` |
| 远端主机名 | `C202607221115992` |
| SSH 用户 | `root` |
| SSH 身份 | `~/.ssh/id_ed25519` |
| 应用目录 | `/opt/apitable` |
| Compose 文件 | `/opt/apitable/docker-compose.yml` |
| Compose 项目 | `workbench-apitable` |
| 公网入口 | Origin Caddy -> `127.0.0.1:4290` -> APITable gateway |

## 连接确认

每次操作前解析域名并确认目标主机：

```sh
getent ahostsv4 requirements.aionbench.com | head
ssh -i ~/.ssh/id_ed25519 -o IdentitiesOnly=yes root@45.207.206.119 \
  'hostname; test -d /opt/apitable && echo apitable-found'
```

只有解析地址为 `45.207.206.119`、主机名为 `C202607221115992` 且 `/opt/apitable` 存在时，才允许继续。任一条件不满足，停止操作并核验部署信息。

## 生产边界

- 需求池写操作优先使用 APITable changeset/API。
- 修改 Compose 前在服务器受控目录创建带时间戳的配置备份。
- 直接改库前备份相关表，并同步处理 revision、operation 和 room-server 缓存一致性。
- 不执行全量 Docker prune，不删除未核验的卷、镜像、目录或数据。
- 不打印 `/opt/apitable/.env`，不将数据库密码、MinIO 密钥、Redis 密码或会话凭据写回项目。
- APITable 与 Workbench 的发布、迁移、重启和数据写入分开执行，不能用 Workbench 操作替代 APITable 变更。

## 数据与分享

| 对象 | 标识 |
| --- | --- |
| 需求管理数据表 | `dstnxGcpRsUm5qWQfH` |
| 公开分享 | `shrPUYuZSibCBSVwCFJ97` |
| 日历视图 | `viwNjQTvSA7Zn` |
| 日历字段 | `fldaTbnewNzuc` |
| 需求收集表单 | `fom56i1yeByua9NWye` |
| 表单分享 | `shrFkh595KUCsuR5Q3hS8` |

公开分享保持 `onlyRead: true`。匿名访客只能阅读；已授权协作者登录后，由 `/node/canEdit` 按真实文件权限进入编辑入口。不得把公开分享设置为互联网用户可编辑。

## 运行检查

```sh
cd /opt/apitable
docker compose ps
docker compose images
grep -n 'image:' docker-compose.yml
docker compose logs --tail=100 backend-server web-server room-server
```

上线后确认容器健康、公开分享只读、授权协作者可编辑、日历按发版日期展示，并记录脱敏的命令结果。

## 管理员重置成员密码

入口为「成员管理 → 成员详情 → 重置密码」，桌面和手机共用。输入两次新密码后提交；密码规则沿用原生的 8–24 位、同时包含英文字母和数字。成功后，该账号使用新密码登录，旧登录会话被撤销。

账号密码属于整个安装实例。部署必须显式配置 `WORKBENCH_PASSWORD_RESET_SPACE_ID=spchwV2gnndQw` 和 `WORKBENCH_PASSWORD_RESET_ORIGIN=https://requirements.aionbench.com`，将账户恢复权限授予这个可信需求池空间；缺失配置时关闭该能力。不要把空间 ID 改为请求者任意选择的空间。

- 需求池主管理员可重置该空间其他已激活成员，包括子管理员。
- 子管理员必须具有原生 `UPDATE_MEMBER` 权限，且目标为需求池普通成员。
- 禁止重置自己、需求池主管理员、未激活/已移除/已停用账号，以及其他空间的成员。
- 成员持有系统自动创建的个人空间不阻止恢复。弹窗明确提示，此操作影响该账号在所有空间的登录。
- 后端提交时重新查询权限；使用原生密码哈希与会话撤销服务，不接受客户端传入用户 ID 或管理员标志。仅接受配置来源的 JSON 请求，并保留原生 CSRF 校验。
- 不记录、返回或持久化明文密码。格式错误的请求使用局部通用错误处理，避免解析异常记录密码片段。
- 密码更新已提交但会话撤销失败时返回明确的部分成功提示；管理员重试处理。上游登录中正在进行的请求存在原生并发边界，严格跨请求原子失效需要后续凭证版本机制。

维护源文件在 `deploy/apitable-community-backend/` 与 `deploy/apitable-community-web/`。后端 Dockerfile 在产出镜像前编译并运行不连接生产数据库的 Java 行为测试；前端行为测试入口为 `node --test scripts/e2e/apitable-password-reset.test.mjs`。前端覆盖目录放入对应上游源码的 `self-hosted-community-web/` 后按其 Dockerfile 构建。构建和测试结果记录到当前审计，不能用修改真实成员密码代替验收。

发布时先备份服务器 `.env` 与 Compose 到仅管理员可读的备份目录，保留旧镜像；仅替换 `backend-server` 与 `web-server`，并让 gateway 重新解析容器地址。后端健康、页面加载、匿名重置被拒绝和公开分享只读均通过后，再更新对应源码下载包。需要回退时恢复备份配置并使用保留的旧镜像重建这两个服务。

## 需求表单登录入口

表单的登录提示必须跳到本站 `/login`，由原生 Router 编码 `reference` 和 `spaceId`，避免空登录地址产生 `/undefined`，或返回地址里的 `&`、`#` 被拆成登录页参数。普通 `/login` 初始显示账号密码登录，邀请注册流程保留；登录成功后由原生逻辑返回同站表单。浏览器存储失败不应阻断登录导航。

配置保留 `FORM_LOGIN_URL=/login`，用于兼容旧前端镜像；新覆盖文件 `form_container.tsx` 直接使用站内路由，不依赖外部登录地址。修复不放开匿名填报或表格编辑权限。

回归测试为 `node --test scripts/e2e/apitable-form-login.test.mjs`。上线后运行 `node scripts/e2e/apitable-form-login-production-smoke.mjs`，检查真实桌面/手机页面的工作台表单登录跳转、分享表单提示和完整返回地址。该 smoke 拦截所有写请求，并仅在浏览器中模拟登录成功响应；不能据此宣称已经验证真实账号凭据，也不提交测试需求记录。
