# Workbench 同域上传

`workbench-local-storage-compose.yml` 是可选的 **gateway 路由 overlay**，不改变默认外部 S3 部署，也不创建存储桶或用户。它在启动时从标准 Nginx 配置生成同域上传配置，原来的 Web、API、SSE、知识库路由保持一致。

上传 URL 必须保留桶名，例如：

```dotenv
WORKBENCH_S3_INTERNAL_ENDPOINT=http://object-storage:9000
WORKBENCH_S3_INTERNAL_FORCE_PATH_STYLE=true
WORKBENCH_S3_REGION=us-east-1
WORKBENCH_S3_BUCKET=aionbench-workbench-prod
WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL=https://aionbench.com/aionbench-workbench-prod
```

将这些设置写入服务器实际使用的私有部署配置，并同步 API、Web、全部 Worker 和 Preview 的运行环境。Web 构建和运行时的浏览器上传 URL 应一致。API 的 staging prefix 必须采用 `staging/files`。所有角色使用已配置到该 MinIO 的各自凭据；更改 endpoint 不会自动迁移凭据或历史对象。

保留与当前 Worker 镜像相匹配的条件写入模式；该路由 overlay 不修改 `WORKBENCH_S3_CONDITIONAL_CREATE_MODE`。不要仅因为切换为 MinIO 就盲目更改此值。

该路由只将 `/<bucket>/staging/files/` 下的 PUT、OPTIONS 原样代理到 `object-storage:9000`，每个分片最多 50 MiB。Host、路径和查询参数不重写，签名由 MinIO 校验。其他桶内路径返回 404，下载继续经过工作台 API，预览继续经过独立 Preview。保持桶为私有；预检无需赋予匿名对象访问权限。

标准 Compose 使用已有 `local-object-storage` profile；若使用本机 Docling，还需 `local-docling` profile。依赖配置应等待本机存储健康，而不是旧的 TLS 出口。这个 gateway overlay 本身不替换各 Worker 的依赖或运行凭据。已有生产恢复方案可直接使用下面的渲染方式，仅替换 gateway 的配置挂载，无需启动迁移或重建存储。

```sh
WORKBENCH_S3_BUCKET=aionbench-workbench-prod \
WORKBENCH_LOCAL_STORAGE_BASE_NGINX_CONFIG=/opt/workbench/deploy/workbench-nginx.conf \
WORKBENCH_LOCAL_STORAGE_NGINX_TEMPLATE=/opt/workbench/deploy/workbench-local-storage-nginx.conf.template \
WORKBENCH_LOCAL_STORAGE_NGINX_OUTPUT=/tmp/workbench-local-storage-nginx.conf \
sh /opt/workbench/deploy/workbench-local-storage-nginx.sh --render-only
```

生产变更前应按需求池运维台账核验主机；仅操作 Workbench 的 gateway 与工作台服务，不运行 APITable Compose，也不修改需求表。

验收使用 `run-workbench-public-upload-smoke.sh` 时，同域方案的 `WORKBENCH_UPLOAD_SMOKE_EXPECTED_UPLOAD_ORIGIN` 填 `https://aionbench.com`，不是带桶路径的 URL。该 helper 自动创建并清理临时工作台登录身份，不接受 MinIO 凭据文件。直接使用 `workbench-public-upload-smoke.mjs` 时，从私有环境提供 `WORKBENCH_UPLOAD_SMOKE_EMAIL` 与 `WORKBENCH_UPLOAD_SMOKE_PASSWORD`。不要把登录凭据、S3 凭据或签名 URL 保存到仓库、命令行参数或日志。
