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

## 固定 builder 与缓存存储

增量发布依赖固定的 `workbench-direct-release` builder 及其缓存卷；发布完成只执行 `docker buildx stop`，不能把该停止容器当作历史垃圾删除。`.next/cache` 与 npm 缓存随 builder 保留。服务器 `current/release-plan.json` 是最近健康发布的增量基线，不能与旧镜像一起删除；私有 `base.env` 供失败恢复，不复制回仓库。

生产缓存位于数据盘 `[SERVER_PRIVATE_PATH]`，通过宿主机 bind mount 挂到 Docker 卷目录 `/var/lib/docker/volumes/buildx_buildkit_workbench-direct-release0_state/_data`。`/etc/fstab` 为该条目设置 `x-systemd.requires-mounts-for=/home/data`。发布前及主机重启后，用 `findmnt` 确认这两个路径指向同一数据盘缓存，并核验固定 builder 的卷挂载；不能在数据盘或 bind mount 缺失时启动构建，否则可能把新缓存写回根盘。空间检查须同时覆盖根盘、数据盘和 containerd。

迁移或回退缓存时，同时取得私有目录的 `direct-release.lock` 和 `/run/lock/workbench-direct-build.lock`，确认没有构建进行，并停止固定 builder。先备份 fstab、核对源/目标设备与足够容量，再复制缓存并校验内容、权限和硬链接。切换挂载后验证 `findmnt`、builder 的卷挂载及缓存可读，成功后才移除旧副本；不需要重启 Docker 或业务容器。

回退到根盘时，先确认根盘能容纳完整缓存并仍满足 20 GiB 余量，在停止 builder 后把数据盘缓存复制并校验到根盘临时目录；解除 bind mount，将已校验副本放回卷目录，撤销对应 fstab 条目并执行 `systemctl daemon-reload`，再核验 builder。回退验收前保留数据盘原副本。不得在仍挂载数据盘时删除 `_data` 内的内容，也不得直接删除该 builder 或卷来处理挂载问题。

确因磁盘压力需要清理缓存时，先取得上述锁并核对目标；清理会使后续发布失去热缓存，不能作为每次发布的默认收尾。非运行发布源码目录的 `node_modules` 可以重装，但删除前仍须确认没有宿主机安装/编译进程，也没有容器挂载该目录；保留源码、私有配置和回退镜像。

需要保留宿主机依赖而数据盘空间不足时，可以把指定发布的 `node_modules` 放在根盘 `/var/cache/workbench-host-dependencies/<完整提交>/`，在原源码位置建立符号链接。先取得上述两把锁，确认相关安装/构建进程已经结束、容器未挂载该目录，并核对根盘复制后的余量。逐文件验证内容、权限、所有者和符号链接；npm workspace 的相对链接还需要缓存目录中的 `apps`、`packages` 指回同一发布源码。先保留原依赖目录，切换链接并验证实际包解析；成功后才删除已验证的重复副本，失败则恢复原目录。缓存所引用的源码不能提前删除；此目录不是 BuildKit 缓存，也不包含生产环境配置。

## 日志保护

宿主机策略源为 `deploy/workbench-host-journald.conf`，安装到 `/etc/systemd/journald.conf.d/70-workbench-disk.conf` 前备份已存在的同名文件。策略为持久 journal 目标上限 1 GiB、预留 5 GiB、临时 journal 128 MiB、保留时间最长 30 天；通过重启 `systemd-journald` 应用，不能以重启 Docker 代替。活动日志文件会造成短时超额，语义见 [systemd 官方说明](https://www.freedesktop.org/software/systemd/man/latest/journald.conf.html)。回退时恢复原文件（之前不存在则删除该 drop-in），再重启 journald。

Docker 日志必须检查**运行容器**的 `HostConfig.LogConfig`。仓库 Compose 存在 `20m × 5` 不代表旧容器已应用。需要通过对应服务的受控部署重建容器后才会生效；不要直接截断或用外部 logrotate 操作 Docker 的 JSON 日志文件。APITable 的配置变更与重建另按 `apitable-production-operations.md` 执行。

## DeerFlow 检查点

SQLite 的 `checkpoints`、`writes` 属于会话恢复状态。生成失败或没有最终 Artifact，也可能已经保存多次完整状态。先按 thread 汇总体积，再关联运行和项目；不把“0 文档”作为删除依据。

当前维护过程仅只读检查。上线保留策略前，应明确可恢复时间窗口；备份并验证恢复；保护活动/待恢复运行、线程最新状态、运行引用的历史 checkpoint、子图 namespace 与 pending writes；在维护窗口内用事务执行已核验清单并复核引用。只有回收空间值得承担锁定和临时文件成本时才执行 SQLite 压缩；`freelist_count=0` 时单独 VACUUM 不能解决历史累计问题。未通过这些验证，不执行按时间或“每线程留一个”的数据库删除。
