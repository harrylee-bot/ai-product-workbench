"use client";

import clsx from "clsx";
import {
  Activity,
  ArrowLeft,
  BookOpen,
  Boxes,
  ClipboardCheck,
  DatabaseZap,
  FileWarning,
  FolderOpen,
  Gauge,
  History,
  KeyRound,
  Layers,
  ListChecks,
  LogOut,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  ServerCog,
  Settings2,
  ShieldCheck,
  UserCog,
  Workflow,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";
import { ProtectedRoute } from "@/components/protected-route";
import { useAuth } from "@/lib/auth-context";

type NavItem = {
  title: string;
  href?: string;
  icon: typeof Gauge;
  children?: { title: string; href: string; icon: typeof Gauge }[];
};

const navItems: NavItem[] = [
  { title: "概览", href: "/admin", icon: Gauge },
  { title: "用户管理", href: "/admin/users", icon: UserCog },
  { title: "项目管理", href: "/admin/projects", icon: Layers },
  {
    title: "模型管理",
    icon: ServerCog,
    children: [
      { title: "模型供应商", href: "/admin/model-providers", icon: Network },
      { title: "模型配置", href: "/admin/model-configs", icon: Boxes },
      { title: "任务模型映射", href: "/admin/model-task-profiles", icon: Settings2 },
    ],
  },
  {
    title: "知识库",
    icon: BookOpen,
    children: [
      { title: "Quartz 知识库", href: "/admin/knowledge/vault", icon: FolderOpen },
      { title: "知识条目", href: "/admin/knowledge/items", icon: DatabaseZap },
      { title: "知识候选", href: "/admin/knowledge/candidates", icon: ClipboardCheck },
    ],
  },
  {
    title: "日志中心",
    icon: Activity,
    children: [
      { title: "Runtime Run 日志", href: "/admin/logs/runtime-runs", icon: Workflow },
      { title: "模型调用日志", href: "/admin/logs/model-calls", icon: KeyRound },
      { title: "文件解析日志", href: "/admin/logs/file-parses", icon: FileWarning },
      { title: "QA 报告", href: "/admin/logs/qa-reports", icon: ListChecks },
    ],
  },
  { title: "系统审计", href: "/admin/audit-logs", icon: History },
];

export function AdminShell({
  title,
  children,
  actions,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const { user, logout } = useAuth();
  const router = useRouter();

  async function handleLogout() {
    await logout();
    router.replace("/login");
  }

  return (
    <ProtectedRoute requireAdmin>
      <main
        className={clsx(
          "grid min-h-screen bg-[var(--color-app-bg)] text-gray-950",
          collapsed ? "grid-cols-[72px_1fr]" : "grid-cols-[240px_1fr]",
        )}
      >
        <AdminSidebar collapsed={collapsed} onToggle={() => setCollapsed((value) => !value)} />
        <section className="min-w-0">
          <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-gray-200 bg-white px-6">
            <div className="min-w-0">
              <h1 className="truncate text-lg font-semibold text-gray-950">{title}</h1>
            </div>
            <div className="flex items-center gap-2">
              {actions}
              <Link
                href="/workspace"
                className="inline-flex h-9 items-center gap-2 rounded-lg px-3 text-sm text-gray-600 hover:bg-gray-100 hover:text-gray-950"
              >
                <ArrowLeft className="h-4 w-4" />
                返回工作台
              </Link>
              <div className="hidden border-l border-gray-200 pl-3 text-sm text-gray-600 sm:block">
                {user?.displayName ?? user?.username}
              </div>
              <button
                type="button"
                onClick={() => void handleLogout()}
                className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-950"
                aria-label="退出登录"
                title="退出登录"
              >
                <LogOut className="h-4 w-4" />
              </button>
            </div>
          </header>
          <div className="px-6 py-6">{children}</div>
        </section>
      </main>
    </ProtectedRoute>
  );
}

function AdminSidebar({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  const pathname = usePathname();
  const activeParent = useMemo(
    () => navItems.find((item) => item.children?.some((child) => pathname.startsWith(child.href))),
    [pathname],
  );

  return (
    <aside className="border-r border-gray-200 bg-white">
      <div className="flex h-14 items-center justify-between border-b border-gray-200 px-4">
        <div className={clsx("flex items-center gap-2", collapsed && "justify-center")}>
          <ShieldCheck className="h-5 w-5 text-gray-900" />
          {!collapsed ? <span className="text-sm font-semibold">管理后台</span> : null}
        </div>
        <button
          type="button"
          onClick={onToggle}
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-900"
          aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}
          title={collapsed ? "展开侧边栏" : "收起侧边栏"}
        >
          {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
        </button>
      </div>
      <nav className="space-y-1 px-3 py-4">
        {navItems.map((item) => (
          <NavGroup
            key={item.title}
            item={item}
            collapsed={collapsed}
            pathname={pathname}
            defaultOpen={activeParent?.title === item.title}
          />
        ))}
      </nav>
    </aside>
  );
}

function NavGroup({
  item,
  collapsed,
  pathname,
  defaultOpen,
}: {
  item: NavItem;
  collapsed: boolean;
  pathname: string;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const Icon = item.icon;
  const active = item.href ? pathname === item.href : defaultOpen;

  if (!item.children) {
    return (
      <Link
        href={item.href ?? "/admin"}
        title={item.title}
        className={clsx(
          "flex h-10 items-center gap-2 rounded-lg px-3 text-sm transition",
          collapsed && "justify-center px-0",
          active ? "bg-gray-950 font-medium text-white" : "text-gray-600 hover:bg-gray-100 hover:text-gray-950",
        )}
      >
        <Icon className="h-4 w-4 shrink-0" />
        {!collapsed ? item.title : null}
      </Link>
    );
  }

  return (
    <div>
      <button
        type="button"
        title={item.title}
        onClick={() => setOpen((value) => !value)}
        className={clsx(
          "flex h-10 w-full items-center gap-2 rounded-lg px-3 text-left text-sm transition",
          collapsed && "justify-center px-0",
          active ? "bg-gray-100 font-medium text-gray-950" : "text-gray-600 hover:bg-gray-100 hover:text-gray-950",
        )}
      >
        <Icon className="h-4 w-4 shrink-0" />
        {!collapsed ? item.title : null}
      </button>
      {!collapsed && open ? (
        <div className="mt-1 space-y-1 pl-3">
          {item.children.map((child) => {
            const ChildIcon = child.icon;
            const childActive = pathname === child.href;
            return (
              <Link
                key={child.href}
                href={child.href}
                className={clsx(
                  "flex h-9 items-center gap-2 rounded-lg px-3 text-sm transition",
                  childActive
                    ? "bg-gray-950 font-medium text-white"
                    : "text-gray-600 hover:bg-gray-100 hover:text-gray-950",
                )}
              >
                <ChildIcon className="h-4 w-4 shrink-0" />
                {child.title}
              </Link>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
