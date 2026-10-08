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
