"use client";

import { ChevronDown, LogOut, ShieldCheck, UserCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth-context";

export function UserMenu({
  compact = false,
  placement = "bottom",
}: {
  compact?: boolean;
  placement?: "top" | "bottom";
}) {
  const router = useRouter();
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  if (!user) return null;

  const roleLabel = user.role === "admin" ? "管理员" : "普通用户";

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        className={[
          "inline-flex h-10 items-center gap-2 rounded-[10px] text-sm font-semibold text-gray-900 transition hover:bg-gray-100 focus:outline-none focus-visible:ring-3 focus-visible:ring-gray-950/10",
          compact ? "w-10 justify-center px-0" : "w-full justify-start px-2",
        ].join(" ")}
      >
        <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--color-primary)] text-xs font-semibold text-white shadow-[var(--shadow-control)]">
          {initials(user.displayName)}
        </span>
        {compact ? null : (
          <>
            <span className="min-w-0 flex-1 truncate text-left">{user.displayName}</span>
            <ChevronDown className="h-4 w-4 text-gray-400" />
          </>
        )}
      </button>

      {open ? (
        <div
          role="menu"
          className={[
            "absolute z-30 w-56 overflow-hidden rounded-[12px] border border-gray-200 bg-white shadow-[var(--shadow-float)]",
            placement === "top" ? "bottom-12 left-0" : "right-0 top-12",
          ].join(" ")}
        >
          <div className="flex items-center gap-3 px-4 py-3">
            <UserCircle className="h-5 w-5 text-gray-700" />
            <div>
              <div className="text-sm font-medium text-gray-950">{user.displayName}</div>
              <div className="text-xs text-gray-500">{roleLabel}</div>
            </div>
          </div>
          <div className="border-t border-gray-200" />
          {user.role === "admin" ? (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                router.push("/admin");
              }}
              className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm text-gray-700 transition hover:bg-gray-50 focus:outline-none focus-visible:bg-gray-50"
            >
              <ShieldCheck className="h-4 w-4" />
              管理后台
            </button>
          ) : null}
          <button
            type="button"
            onClick={async () => {
              setOpen(false);
              await logout();
              router.replace("/login");
            }}
            className="flex w-full items-center gap-3 border-t border-gray-200 px-4 py-3 text-left text-sm text-gray-700 transition hover:bg-gray-50 focus:outline-none focus-visible:bg-gray-50"
          >
            <LogOut className="h-4 w-4" />
            退出登录
          </button>
        </div>
      ) : null}
    </div>
  );
}

function initials(name: string) {
  const trimmed = name.trim();
  if (!trimmed) return "用";
  if (/^[A-Za-z]/.test(trimmed)) return trimmed.slice(0, 2).toUpperCase();
  return trimmed.slice(0, 1);
}
