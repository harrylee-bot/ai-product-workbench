# Workbench 磁盘维护

此规程只定义维护边界；执行时间、空间变化、线上验证与未完成项记录在 `docs/audit/1.0.0.md`。脱敏输出放在 `output/audit/1.0.0/`。

## 定位与清理

先核对域名、主机和挂载点，再用 `df -hT`、`df -i`、`docker system df` 和分目录 `du -x` 区分镜像、容器写层、数据库、日志、转储及安装缓存。使用 containerd snapshotter 时，同时检查 `/var/lib/containerd`；不能只看 `/var/lib/docker`。

清理前记录所有容器（包括退出容器）的镜像 ID、启动时间、挂载和镜像 tags，并核对当前部署配置与保留的回退配置。只有两者均不引用的镜像才可能是清理对象。逐项指定已核验目标，不运行全量 `docker system prune` 或 `docker image prune -a`；Docker 的 reclaimable 汇总不能作为删除依据。清理后复核 tags 和 digest 可解析、容器未意外重启、公网 `/api/healthz`、登录页及知识页可达。

npm、pip 下载缓存可在确认没有构建/安装进程后按明确目录清理；同时取得 `/run/lock/workbench-direct-build.lock`。这会使后续安装重新下载依赖，不会移除已安装的包。不要删除源码、模型缓存、项目附件、知识来源、数据库、对象存储、运行历史或其他应用的备份。

## 构建保护

直连发布在 `npm ci` 前执行 `deploy/workbench-disk-preflight.mjs`，有界镜像构建在启动 builder 前再次执行。根盘、Docker 和 containerd 所在文件系统至少保留 20 GiB 可用空间，发布目录所在文件系统至少保留 5 GiB；有 inode 总量的文件系统至少保留 1%。无法读取或不足时停止，不自动删除任何对象。此检查是启动门槛，不是构建过程的硬磁盘配额。

宿主机构建 shell 使用 `ulimit -c 0`，Compose 的全部构建服务设置 `build.ulimits.core` 的 soft/hard 为 0，避免 Node/TypeScript 构建崩溃后留下大体积原始 core。限制作用于此发布入口和这些构建服务，不承诺覆盖其他项目、自行启动的 builder 或操作系统的所有崩溃报告。Compose 的构建限制见 [Docker 官方规范](https://docs.docker.com/reference/compose-file/build/#ulimits)。

以上源码修改只有被正式发布流程使用时才生效；单独验证脚本或运行隔离构建探针不等于发布了应用。

## 日志保护

宿主机策略源为 `deploy/workbench-host-journald.conf`，安装到 `/etc/systemd/journald.conf.d/70-workbench-disk.conf` 前备份已存在的同名文件。策略为持久 journal 目标上限 1 GiB、预留 5 GiB、临时 journal 128 MiB、保留时间最长 30 天；通过重启 `systemd-journald` 应用，不能以重启 Docker 代替。活动日志文件会造成短时超额，语义见 [systemd 官方说明](https://www.freedesktop.org/software/systemd/man/latest/journald.conf.html)。回退时恢复原文件（之前不存在则删除该 drop-in），再重启 journald。

Docker 日志必须检查**运行容器**的 `HostConfig.LogConfig`。仓库 Compose 存在 `20m × 5` 不代表旧容器已应用。需要通过对应服务的受控部署重建容器后才会生效；不要直接截断或用外部 logrotate 操作 Docker 的 JSON 日志文件。APITable 的配置变更与重建另按 `apitable-production-operations.md` 执行。

## DeerFlow 检查点

SQLite 的 `checkpoints`、`writes` 属于会话恢复状态。生成失败或没有最终 Artifact，也可能已经保存多次完整状态。先按 thread 汇总体积，再关联运行和项目；不把“0 文档”作为删除依据。

当前维护过程仅只读检查。上线保留策略前，应明确可恢复时间窗口；备份并验证恢复；保护活动/待恢复运行、线程最新状态、运行引用的历史 checkpoint、子图 namespace 与 pending writes；在维护窗口内用事务执行已核验清单并复核引用。只有回收空间值得承担锁定和临时文件成本时才执行 SQLite 压缩；`freelist_count=0` 时单独 VACUUM 不能解决历史累计问题。未通过这些验证，不执行按时间或“每线程留一个”的数据库删除。
