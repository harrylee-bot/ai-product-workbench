# APITable 生产运维台账

更新日期：2026-08-06（Asia/Shanghai）

本文件是 `requirements.aionbench.com` 需求池的生产入口台账。它记录可以安全提交到项目的连接事实和操作边界，不记录任何密码、密钥、Cookie 或数据库凭据。

## 当前入口

| 项目 | 当前值 |
| --- | --- |
| 用户域名 | `https://requirements.aionbench.com` |
| 当前 Origin IPv4 | `45.207.206.119` |
| 远端主机名 | `C202607221115992` |
| SSH 用户 | `root` |
| 本地 SSH 身份 | `~/.ssh/id_ed25519`（仅引用，不进入仓库） |
| 应用目录 | `/opt/apitable` |
| Compose 文件 | `/opt/apitable/docker-compose.yml` |
| Compose 项目 | `workbench-apitable` |
| 公网入口 | Origin Caddy -> `127.0.0.1:4290` -> APITable gateway |

`8.130.16.170` 是过期的历史地址。除非发生明确迁移并同时更新 DNS、本台账和验证证据，否则不得用它操作需求池。

## 服务器边界

当前团队可控服务器总数为两台。需求池只在 `45.207.206.119` 上；另一台服务器不是 APITable 目标。不要遍历或猜测历史服务器 IP。

每次操作前必须从一个已经可连接的受控服务器或允许联网的终端解析域名，然后把结果与本台账比较：

```sh
getent ahostsv4 requirements.aionbench.com | head
```

连接生产机后必须进行身份和目录双重确认：

```sh
ssh -i ~/.ssh/id_ed25519 -o IdentitiesOnly=yes root@45.207.206.119 \
  'hostname; test -d /opt/apitable && echo apitable-found'
```

期望主机名为 `C202607221115992`，并输出 `apitable-found`。任一项不符都应停止写操作，先查明是否迁移。

## 运行时快照

以下是 2026-08-06 11:54 左右的现场快照，只用于辨认部署进度，不能替代操作时的实时检查：

| 服务 | 镜像/状态 |
| --- | --- |
| `backend-server` | `workbench/apitable-backend:v1.13.0-beta.1-ce-collaboration.3`，healthy |
| `web-server` | `workbench/apitable-web:v1.13.0-beta.1-ce-collaboration.14`，running |
| `gateway` | `docker.io/apitable/openresty:latest`，绑定 `127.0.0.1:4290` |
| `room-server` | `docker.io/apitable/room-server:latest` |
| `databus-server` | `docker.io/apitable/databus-server:latest` |
| `mysql` | `mysql:8.0.32`，healthy |
| `redis` | `redis:7.0.8` |
| `minio` | `minio/minio:RELEASE.2023-01-25T00-19-54Z`，healthy |

当前协作者和分享入口修复版本：

- 后端：`workbench/apitable-backend:v1.13.0-beta.1-ce-collaboration.3`
- 前端：`workbench/apitable-web:v1.13.0-beta.1-ce-collaboration.14`
- 前端构建日志：`/opt/apitable/apitable-web-v14-build.log`

2026-08-05 上线核验：

- `/node/listRole`：现有登录会话全部返回成功。
- `/node/collaborator/page`：按前端 `pageObjectParams` 参数返回 4 名协作者。
- `/org/loadOrSearch`：带正常 `X-Space-Id` 请求头后，每个会话可加载 3–5 个候选成员。
- `/node/addRole`：登录态、CSRF 和请求路由均到达参数校验层；空成员列表被拒绝且没有写入副作用。
- `/node/canEdit`：匿名请求被拒绝；登录成员按实际 `EDIT_NODE` 权限返回结果。
- 节点当前为独立权限模式（`extend: false`），4 个角色单元均为 `editor`。
- 公开分享继续显示“只可阅读”。
- 公开分享页对已登录且拥有文件编辑权限的成员自动跳转到对应 `/workbench/...` 编辑入口；无权限成员和匿名访客继续留在只读分享页。
- 附件在传统网格和 Konva 网格中均可首次点击直接打开内置在线预览；下载按钮仍按原有权限保留。
- `.docx` 附件由浏览器内置 `docx-preview` 和 `JSZip` 本地渲染，不上传到 Google 或第三方转换服务；失败时保留原有下载入口。
- DOCX 预览 effect 按稳定的附件 URL 去重，并在附件切换时取消旧请求，避免同一大附件被重复下载导致预览失败。
- 日历通过 `SetCalendarStyle` changeset 从“开始时间”切到“发版日期”，数据表与元数据 revision 均为 `276`。
- 当时有效记录数为 `183`；这是现场事实，不得依据旧交接中的 `182` 擅自删行。
- 完整对应源码已发布：当前后端 `.3` 与前端 `.14` 归档均包含上游源码、`self-hosted-community-backend` 和 `self-hosted-community-web`，并提供 SHA256；两个归档内容来自同一份已部署源码快照，公开归档排除了部署 `.env` 文件。

查看实时状态：

```sh
cd /opt/apitable
docker compose ps
docker compose images
grep -n 'image:' docker-compose.yml
```

## 需求管理数据标识

| 对象 | ID/配置 |
| --- | --- |
| 需求管理数据表 | `dstnxGcpRsUm5qWQfH` |
| 公开分享 | `shrPUYuZSibCBSVwCFJ97` |
| 日历视图 | `viwNjQTvSA7Zn` |
| 日历当前错误字段（开始时间） | `fldI70rHSOvDb` |
| 日历目标字段（发版日期） | `fldaTbnewNzuc` |
| 本周发版内容视图 | 使用 `fldaTbnewNzuc` 做 `ThisWeek` 筛选和倒序排序 |

公开分享应保持 `onlyRead: true`。公开 `/share/...` 对匿名用户只读；已授权协作者打开同一个公开链接并完成登录后，由 `/node/canEdit` 按真实文件权限判断并自动进入 `/workbench/...` 编辑。不要为了协作者编辑而把公开分享改成“互联网用户可编辑”。

## 操作规则

1. 先解析域名，再确认 SSH 主机名和 `/opt/apitable`，最后才执行写操作。
2. 修改 `/opt/apitable/docker-compose.yml` 前创建带时间戳的备份。
3. 视图和数据优先通过 APITable 正常 changeset/API 写入；必须直接改库时先备份相关表并处理 revision、operation 与 room-server 缓存一致性。
4. 不打印 `/opt/apitable/.env`，不把数据库密码、MinIO 密钥、Redis 密码或会话凭据带回项目。
5. 上线后至少验证容器健康、数据记录数、公开分享仍只读、协作者可编辑、日历按“发版日期”展示。
6. AGPL 修改镜像上线时同步发布对应源码归档和 SHA256，并更新本项目两个 APITable README 的版本链接。

## 快速诊断

```sh
# 域名与 HTTP
getent ahostsv4 requirements.aionbench.com | head
curl -sSIL --max-time 10 https://requirements.aionbench.com | head -20

# 容器状态（远端）
cd /opt/apitable
docker compose ps
docker compose logs --tail=100 backend-server web-server room-server

# 构建状态（远端）
tail -100 /opt/apitable/apitable-web-v14-build.log
test -f /opt/apitable/apitable-web-v14-build.exit && \
  cat /opt/apitable/apitable-web-v14-build.exit
```
