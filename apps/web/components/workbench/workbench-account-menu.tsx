"use client";

import { LogOutIcon } from "lucide-react";
import { useState } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { WorkbenchUser } from "@/lib/auth/workbench-auth";

export function WorkbenchAccountMenu({
  onLogout,
  user,
}: {
  onLogout: () => Promise<void>;
  user: WorkbenchUser | null;
}) {
  const [busy, setBusy] = useState(false);
  const displayName = user?.name.trim() || user?.email.trim() || "当前用户";
  const initial = Array.from(displayName)[0]?.toLocaleUpperCase() || "用";

  const logout = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onLogout();
    } finally {
      setBusy(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label={`${displayName}账户`}
          className="grid size-[34px] place-items-center overflow-hidden rounded-full bg-[#536a74] text-[15px] font-semibold hover:ring-2 hover:ring-white/[0.18]"
          type="button"
        >
          {initial}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-[228px] border-white/[0.08] bg-[#18191b]/96 text-[#f1f3f4]"
      >
        <div className="min-w-0 px-[10px] py-[8px]">
          <div className="truncate text-[13px] font-semibold">{displayName}</div>
          {user?.email && (
            <div className="mt-[3px] truncate text-[11px] text-[#9aa0a6]">{user.email}</div>
          )}
        </div>
        <DropdownMenuSeparator className="bg-white/[0.08]" />
        <DropdownMenuItem
          disabled={busy}
          onSelect={() => void logout()}
          variant="destructive"
        >
          <LogOutIcon />
          {busy ? "正在退出..." : "退出登录"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
