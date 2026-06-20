"use client";

import clsx from "clsx";
import { BriefcaseBusiness, ChevronsLeft, ChevronsRight } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { UserMenu } from "./user-menu";

export function WorkspaceShell({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <main className="min-h-screen bg-[#F6F7F9] text-gray-950">
      <header className="flex h-16 items-center justify-between border-b border-gray-200 bg-white px-8">
        <div className="text-base font-semibold">AI产品工作台（内测）</div>
        <UserMenu />
      </header>
      <div
        className={clsx(
          "grid min-h-[calc(100vh-64px)] transition-[grid-template-columns] duration-200 ease-out",
          collapsed ? "grid-cols-[64px_1fr]" : "grid-cols-[164px_1fr]",
        )}
      >
        <aside
          className={clsx(
            "flex flex-col justify-between border-r border-gray-200 bg-white py-7 transition-[padding] duration-200 ease-out",
            collapsed ? "px-2" : "px-3",
          )}
        >
          <nav>
            <div
              className={clsx(
                "flex h-9 items-center rounded-[8px] bg-gray-100 text-sm font-medium text-gray-800",
                collapsed ? "justify-center px-0" : "gap-2 px-3",
              )}
              title="工作空间"
            >
              <BriefcaseBusiness className="h-4 w-4 shrink-0" />
              <span className={clsx(collapsed && "sr-only")}>工作空间</span>
            </div>
          </nav>
          <button
            type="button"
            aria-expanded={!collapsed}
            aria-label={collapsed ? "展开侧栏" : "收起侧栏"}
            title={collapsed ? "展开" : "收起"}
            onClick={() => setCollapsed((value) => !value)}
            className={clsx(
              "flex h-8 items-center rounded-[8px] text-sm text-gray-600 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900/20",
              collapsed ? "justify-center px-0" : "gap-2 px-2",
            )}
          >
            {collapsed ? (
              <ChevronsRight className="h-4 w-4 shrink-0" />
            ) : (
              <ChevronsLeft className="h-4 w-4 shrink-0" />
            )}
            <span className={clsx(collapsed && "sr-only")}>{collapsed ? "展开" : "收起"}</span>
          </button>
        </aside>
        {children}
      </div>
    </main>
  );
}
