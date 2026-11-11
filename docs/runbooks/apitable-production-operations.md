# APITable 生产运维

本 runbook 定义 `requirements.aionbench.com` 需求池的连接事实、操作边界和验证步骤。仓库不保存密码、密钥、Cookie 或数据库凭据。

## 当前入口

| 项目 | 当前值 |
| --- | --- |
| 用户域名 | `https://requirements.aionbench.com` |
| Origin IPv4 | `REDACTED_ORIGIN_IP` |
| 远端主机名 | `REDACTED_ORIGIN_HOSTNAME` |
| SSH 用户 | `受控环境提供的 SSH 用户` |
| SSH 身份 | `仓库外受控的 SSH 身份` |
| 应用目录 | `受控环境提供的 APITable 安装目录` |
| Compose 文件 | `受控环境提供的 Compose 文件` |
| Compose 项目 | `workbench-apitable` |
| 公网入口 | `受控公网入口 -> 本机网关 -> APITable gateway` |

## 连接确认

每次操作前解析域名并确认目标主机：

开启 VPN 或代理时，普通 UDP DNS 查询可能被本机接管，即使显式指定公共解析器也不能证明查询到达该解析器。先使用保持 TLS 验证的 HTTPS DoH 交叉核验；不要因为本机返回代理合成地址就改公网 DNS：

```sh
curl --fail --silent --show-error --connect-timeout 8 --max-time 20 \
  'https://dns.google/resolve?name=requirements.aionbench.com&type=A'
curl --fail --silent --show-error --connect-timeout 8 --max-time 20 \
  -H 'accept: application/dns-json' \
  'https://cloudflare-dns.com/dns-query?name=requirements.aionbench.com&type=A'
```

需要独立物理出口时，先在 macOS 用 `networksetup -listallhardwareports` 和 `ifconfig` 确认当前有地址且 active 的接口，再对单次连接设置接口。Wi-Fi 和 USB 有线网卡的接口名称可能不同，不能固定假设是 `en0`。可用 `curl --interface <已核验接口> --noproxy '*' --resolve dns.alidns.com:443:223.5.5.5 'https://dns.alidns.com/resolve?name=requirements.aionbench.com&type=A'` 对照阿里公共 DNS，保持证书校验，不改系统路由或关闭 VPN。SSH/SCP 使用同一 `-o BindInterface=<已核验接口>`；接口不可用时停止，不重试默认路由。

```sh
ssh -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="$HOME/.ssh/workbench_known_hosts" "${REQUIREMENT_POOL_USER:?}@${REQUIREMENT_POOL_HOST:?}" \
  'hostname; test -d "$APITABLE_INSTALL_DIR" && echo apitable-found'
```

只有独立核验结果与仓库外受控运维记录中的 Origin、主机名和 APITable 安装目录全部匹配时，才允许继续。任一条件不满足，停止操作并核验部署信息。

## 本机 SSH 身份丢失时

通过实际服务器厂商的已认证管理控制台恢复访问。DNS 托管商不等于服务器厂商，不能仅凭 `hichina.com` 等权威 NS 判断主机属于哪家云。用控制台资产记录中的 IP 与实例身份确认目标，再通过串行控制台、VNC 或厂商命令通道核对 `hostname` 和受控的 APITable 安装目录。

在控制台读取 `/etc/ssh/ssh_host_ed25519_key.pub` 并计算 `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`，将该受控来源的公开主机密钥写入本机专用 `~/.ssh/workbench_known_hosts`。网络扫描得到的密钥只能用于比对，不能自动作为信任来源；恢复本机访问不需要重新生成服务器 host key。

生成新的专用客户端密钥时，私钥仅留在仓库外的本机 `~/.ssh/`，权限 `0600`。通过已认证控制台将公钥追加到正确用户的 `authorized_keys`，保留其他合法条目，不覆盖整份文件、不把私钥上传服务器、不启用密码登录来替代该流程。新的密钥尚未安装时不能宣称已经恢复 SSH 访问；安装后以专用 known_hosts、明确身份文件和严格校验完成只读主机检查。后续部署可通过 `WORKBENCH_SSH_KEY_PATH` 指定恢复身份。

首次只读盘点只提取必要的非秘密字段：当前源码提交、容器镜像摘要与标签、Compose 文件摘要、迁移名称/状态、DeerFlow 版本、知识发布 ID/manifest 摘要和备份索引。禁止打印私有环境文件全文。将生产状态与恢复出的各源码提交逐项对账后，才选择候选及发布方式；GitHub 快照恢复成功不等于生产源码恢复成功。

## 生产边界

- 需求池写操作优先使用 APITable changeset/API。
- 修改 Compose 前在服务器受控目录创建带时间戳的配置备份。
- 直接改库前备份相关表，并同步处理 revision、operation 和 room-server 缓存一致性。
- 不执行全量 Docker prune，不删除未核验的卷、镜像、目录或数据。
- 不打印 APITable 安装目录下的私有环境文件，不将数据库密码、MinIO 密钥、Redis 密码或会话凭据写回项目。
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
cd "$APITABLE_INSTALL_DIR"
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

## 与产品工作台共用账号

需求池可信空间 `spchwV2gnndQw` 的有效成员，以相同邮箱和需求池密码登录产品工作台。需求池是这些账号的密码来源；原生 bcrypt 摘要仅在服务器内同步到工作台，工作台通过 `apitable-bcrypt:` 命名空间校验，并继续支持原有工作台 scrypt 账号。同步不读取或保存明文密码。

运维脚本为 `deploy/sync-requirement-accounts.py`，默认只报告计划；在已核验的源站执行 `--execute` 才写入工作台技术身份表。每次变更前备份工作台三个账号/会话表至私有恢复目录，事务失败整体回滚。需求池数据库只读，不变更表格、空间、成员或分享权限。工作台已有用户 ID、Principal、Workspace 和 Project 关联不变。

`workbench-requirement-account-sync.timer` 每分钟执行一次；成员新增、密码更新、停用/移除通常在下一轮生效。同步身份用 `auth_accounts` 的 `apitable-sync` provider 和需求池用户 UUID 固定绑定，不能因邮箱变化合并其他用户。密码改变或成员失效时撤销该工作台账号的旧会话；已签发 API JWT 仍受原有 5 分钟有效期限制。删除成员不会删除其项目。两套系统各自持有登录会话，用户分别登录。

若首次同步遇到同邮箱但尚未绑定的工作台本地账号，整批停止并先核验真实身份；不能仅凭邮箱自动接管已有账号。当前首次导入成员与工作台原有账号无此冲突。

安装前先上线工作台密码兼容代码并验证，再运行同步及安装两个 systemd 单元；使用 `systemctl list-timers workbench-requirement-account-sync.timer` 和服务日志检查计数。停用 timer 可停止后续同步；回退代码之前必须恢复同步前的账号表备份。不要将私有备份或数据库输出复制进仓库。

回归测试：`python3 -m unittest discover -s deploy -p test_sync_requirement_accounts.py`；服务器隔离 PostgreSQL 验证：`python3 scripts/e2e/requirement-account-sync-postgres.py`；上线后可显式执行 `python3 scripts/e2e/requirement-account-login-production-smoke.py`，用两个随即清理的专用账号核对已安装需求池原生密码校验器、公网工作台登录、错误密码、改密和停用后的旧会话失效。真实成员明文密码不参与测试。

## 需求表单登录入口

表单的登录提示必须跳到本站 `/login`，由原生 Router 编码 `reference` 和 `spaceId`，避免空登录地址产生 `/undefined`，或返回地址里的 `&`、`#` 被拆成登录页参数。普通 `/login` 初始显示账号密码登录，邀请注册流程保留；登录成功后由原生逻辑返回同站表单。浏览器存储失败不应阻断登录导航。

配置保留 `FORM_LOGIN_URL=/login`，用于兼容旧前端镜像；新覆盖文件 `form_container.tsx` 直接使用站内路由，不依赖外部登录地址。修复不放开匿名填报或表格编辑权限。

回归测试为 `node --test scripts/e2e/apitable-form-login.test.mjs`。上线后运行 `node scripts/e2e/apitable-form-login-production-smoke.mjs`，检查真实桌面/手机页面的工作台表单登录跳转、分享表单提示和完整返回地址。该 smoke 拦截所有写请求，并仅在浏览器中模拟登录成功响应；不能据此宣称已经验证真实账号凭据，也不提交测试需求记录。
