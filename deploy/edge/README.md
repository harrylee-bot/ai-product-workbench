# 产品工作台公网入口与可选 Edge

## 当前直连拓扑（2026-07-21）

当前 `aionbench.com` 验证/直连拓扑不使用 CDN，也不依赖本目录中的 Edge 主机。阿里云权威 DNS 将项目 hostname 直接解析到批准的 Origin 验证服务器 `45.207.206.119`；TLS 由 Origin Caddy 终止，当前公网快照已验证登录跳转、独立 Preview、uploads 和 identity hostname。`datatoken.shop` 是线上 AI Provider URL，不是项目 DNS 目标。

当前 DNS 记录为：

| 名称 | 类型 | 值 | 说明 |
|---|---|---|---|
| `@` | `A` | `45.207.206.119` | 主站直达当前 Origin |
| `www` | `A` | `45.207.206.119` | 由 Origin 跳转主域 |
| `preview` | `A` | `45.207.206.119` | 独立 Preview hostname |
| `uploads` | `A` | `45.207.206.119` | 当前验证对象存储入口 |
| `identity` | `A` | `45.207.206.119` | 当前验证身份入口 |

不要把下面的可选 Edge 示例地址写入当前 DNS；只有 Edge/WireGuard 完成独立批准和 E1 验收后，才可以新增一套候选切换记录。

## 可选 Edge/WireGuard 拓扑

未来 Edge 只运行 WireGuard 与 Caddy；应用、数据库、对象存储凭据和构建工具不部署到 Edge。它不是 CDN 缓存层，也不能消除带宽上限。只有在明确需要 WAF、DDoS 清洗或静态资源就近分发时，才另行引入 CDN/云负载均衡，并且动态 API、SSE 和 Preview 必须保持不缓存语义。

未来 Edge 切换时的 DNS 记录（将 `<EDGE_PUBLIC_IP>` 替换为经过批准的地址）为：

| 名称 | 类型 | 值 | 说明 |
|---|---|---|---|
| `@` | `A` | `<EDGE_PUBLIC_IP>` | 主站切到未来 Edge；不得在当前验证阶段使用 |
| `www` | `CNAME` | `aionbench.com` | 由 Edge 统一签发证书并跳转主域 |
| `preview` | `A` | `<EDGE_PUBLIC_IP>` | 独立 Preview origin，不能与主站共域 |
| `@`/`www`/`preview` | `AAAA` | 无，除非 Edge 已配置 IPv6 | 未配置 IPv6 时删除 AAAA，避免部分用户走坏链路 |

DNS 切换前必须先完成 Origin/Edge 的双向探活；在新 Origin 尚未监听 WireGuard 地址时，不得把记录切到 Edge。

推荐切换顺序：

1. 在 Origin 部署 Workbench、WireGuard 和只绑定 `10.88.0.2:8080` 的源站 Caddy，先用本机和隧道地址完成 health/readiness 与负向探测。
2. 在 Edge 部署 WireGuard peer 和本文件对应的 Caddy 配置，使用 `caddy validate`、Edge/Origin preflight 和 `curl --resolve` 验证 TLS、SSE、Preview、403 门禁。
3. 将 `@`、`www`、`preview` 的 DNS 记录切到经批准的 Edge，保留低 TTL 观察窗口；上传域名继续直达 S3/OSS。
4. 观察回源延迟、SSE 断开、连接数、带宽和错误率；只有同一候选通过生产门禁并完成观察窗口后，才停用旧入口或删除旧应用数据。

该 Edge 是单点入口，不提供分布式缓存或流量清洗能力。主站、SSE、Preview 和经应用下载的流量共享该实例的公网带宽；浏览器大文件上传必须直达 S3/OSS。实例带宽上限、月流量和计费方式必须以云控制台/API 的可审计证据确认并作为上线门禁。未缓存的动态请求会承担跨主机回源时延，生产观察必须持续记录 RTT、回源延迟、连接数和带宽水位。

WireGuard 使用点对点 `/32` 路由：Edge 为 `10.88.0.1`，应用源站为 `10.88.0.2`。应用源站 Caddy 只绑定 `10.88.0.2:8080`，并同时校验 Edge WireGuard 地址和独立 `X-Workbench-Edge-Auth` 密钥。源站公网防火墙不得开放该端口。隧道只承载公网入站请求；Origin 的模型、对象存储和其他出站流量保持直连，禁止配置默认路由到 Edge。

部署前从两个 `.example` 文件生成各自主机的私密配置，私钥和 Edge 鉴权密钥不得写入仓库。Edge 配置静态检查命令：

```bash
sudo WORKBENCH_EDGE_ENV_FILE=/etc/workbench/edge/workbench-edge.env \
  WORKBENCH_EDGE_WIREGUARD_CONFIG=/etc/wireguard/wg0.conf \
  sh /opt/workbench/deploy/edge/workbench-edge-preflight.sh
```

生产验收必须包含：未携带 Edge 鉴权的 WireGuard 请求返回 `403`；源站公网地址不可直达 Web 或 Preview；SSE 首事件与 15 秒心跳不被缓冲；Preview 非 `/preview/*` 路径返回 `404`；Preview capability URL 不进入访问日志。

Origin 在 production/server preflight 中会自动执行专用 WireGuard 路由检查。也可在切换前单独运行：

```bash
sudo WORKBENCH_ENV_FILE=/etc/workbench/release/workbench.env \
  WORKBENCH_ORIGIN_WIREGUARD_CONFIG=/etc/wireguard/wg0.conf \
  sh /opt/workbench/deploy/edge/workbench-origin-wireguard-preflight.sh
```

该检查要求 Origin 配置恰好一个 Edge peer，且唯一 `AllowedIPs` 严格等于 `10.88.0.1/32`；任何额外网段或 IPv4/IPv6 默认路由都会阻断部署。
