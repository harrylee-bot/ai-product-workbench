# AI产品工作台（内测）模块 1

一期实现范围：用户登录、JWT 鉴权、角色权限、用户管理、前端权限路由和基础页面。

## 技术栈

- 前端：Next.js + React + TypeScript + Tailwind CSS
- 后端：NestJS + TypeScript
- 数据库：PostgreSQL
- ORM：Prisma
- 认证：JWT
- 密码哈希：bcrypt

## 本地启动

```bash
npm install
npm run db:generate
docker compose up -d postgres
npm run db:migrate
npm run db:seed
npm run dev
```

服务地址：

- 前端：http://localhost:3000
- 后端：http://localhost:4000/api

## 默认账号

| 角色 | 用户名 | 邮箱 | 密码 |
|---|---|---|---|
| 管理员 | admin | admin@example.local | Admin123456 |
| 普通用户 | zhangsan | zhangsan@example.local | User123456 |

## 页面路由

- `/login`：登录页，未登录可访问。
- `/workspace`：工作台占位页，登录用户可访问。
- `/admin`：重定向到 `/admin/users`。
- `/admin/users`：用户管理页，仅管理员可访问。
- `/403`：无权限页，登录用户可访问。

## 核心 API

- `POST /api/auth/login`
- `GET /api/auth/me`
- `POST /api/auth/logout`
- `GET /api/admin/users`
- `POST /api/admin/users`
- `PATCH /api/admin/users/:id`
- `POST /api/admin/users/:id/disable`
- `POST /api/admin/users/:id/enable`
- `POST /api/admin/users/:id/reset-password`

## 视觉依据

前端页面按 Product Design 方向 2 实现：登录页与用户端工作台保持连续的浅灰背景、白色卡片、清晰边框、克制控件和高密度内部工具风格。

参考图保存在：

```text
docs/reference/option-2-login-workspace.png
```

实际实现中，`/login` 与 `/workspace` 是独立页面，不会把登录前后状态拼在同一个页面里。
