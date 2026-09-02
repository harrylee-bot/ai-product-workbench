---
title: 原型HTML归档索引
description: 两份本地 HTML 原型归档的完整性与安全处理记录。
date: 2026-07-28
status: 仅查来源
tags:
  - 来源资产
  - HTML原型
---

# 原型 HTML 归档索引

| 路径 | byteSize | SHA-256 | 说明 |
| --- | ---: | --- | --- |
| `storage/source-assets/prototype-html/html.zip` | 113155768 | `62367d1ef430b73cff4254a812f5625c841abf5e3f5cb75e44d367f8f2f3fba8` | 安全清理副本；已删除归档中的 `.env.local`，不得用旧摘要恢复原包。 |
| `storage/source-assets/prototype-html/原型转HTML.zip` | 109177017 | `5e1322d9ab4bdafcd58d619f92742736d3f14e59ba8778b7cc72fa28b724453a` | 原始归档。 |

`html.zip` 的原始版本曾包含真实形态的 DashScope API Key。密钥值不进入索引；必须按已泄露凭据轮换或吊销。当前归档只用于本地来源核验，不得发布或同步到外部知识库。
