"use client";

import clsx from "clsx";
import { X } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { Button } from "@/components/ui";

export function AdminPanel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={clsx("border border-gray-200 bg-white shadow-sm", className)}>
      {children}
    </section>
  );
}

export function AdminFilterBar({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-y border-gray-200 bg-white px-4 py-4">
      {children}
    </div>
  );
}

export function AdminTable({
  columns,
  children,
  minWidth = 1080,
}: {
  columns: string[];
  children: ReactNode;
  minWidth?: number;
}) {
  return (
    <AdminPanel className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-sm" style={{ minWidth }}>
          <thead className="bg-gray-50 text-xs font-medium text-gray-500">
            <tr>
              {columns.map((column, index) => (
                <th key={column} className={clsx("px-4 py-3", index === columns.length - 1 && "text-right")}>
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 text-gray-700">{children}</tbody>
        </table>
      </div>
    </AdminPanel>
  );
}

export function LoadingRows({ columns, rows = 5 }: { columns: number; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <tr key={rowIndex}>
          {Array.from({ length: columns }).map((__, cellIndex) => (
            <td key={cellIndex} className="px-4 py-3">
              <div className="h-5 animate-pulse rounded bg-gray-100" />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

export function EmptyRow({ columns, label = "暂无数据" }: { columns: number; label?: string }) {
  return (
    <tr>
      <td colSpan={columns} className="px-4 py-16 text-center text-sm text-gray-500">
        {label}
      </td>
    </tr>
  );
}

export function AdminPagination({
  page,
  pageSize,
  total,
  loading,
  onPageChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  loading?: boolean;
  onPageChange: (page: number) => void;
}) {
  const totalPages = Math.max(Math.ceil(total / pageSize), 1);
  return (
    <div className="mt-4 flex items-center justify-between text-sm text-gray-500">
      <div>
        共 {total} 条，第 {page} / {totalPages} 页
      </div>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="secondary"
          disabled={page <= 1 || loading}
          onClick={() => onPageChange(Math.max(page - 1, 1))}
        >
          上一页
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={page >= totalPages || loading}
          onClick={() => onPageChange(Math.min(page + 1, totalPages))}
        >
          下一页
        </Button>
      </div>
    </div>
  );
}

export function AdminStatusBadge({
  label,
  tone = "gray",
}: {
  label: string;
  tone?: "gray" | "green" | "red" | "amber" | "blue";
}) {
  return (
    <span
      className={clsx(
        "inline-flex h-6 items-center rounded-full border px-2 text-xs font-medium",
        tone === "gray" && "border-gray-200 bg-gray-100 text-gray-600",
        tone === "green" && "border-emerald-200 bg-emerald-50 text-emerald-700",
        tone === "red" && "border-red-200 bg-red-50 text-red-700",
        tone === "amber" && "border-amber-200 bg-amber-50 text-amber-700",
        tone === "blue" && "border-sky-200 bg-sky-50 text-sky-700",
      )}
    >
      {label}
    </span>
  );
}

export function AdminDrawer({
  open,
  title,
  children,
  onClose,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-gray-950/25">
      <aside className="ml-auto flex h-full w-full max-w-[720px] flex-col border-l border-gray-200 bg-white shadow-xl">
        <div className="flex h-14 items-center justify-between border-b border-gray-200 px-5">
          <h2 className="truncate text-base font-semibold text-gray-950">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-950"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">{children}</div>
      </aside>
    </div>
  );
}

export function DetailGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-3 sm:grid-cols-2">{children}</div>;
}

export function DetailItem({
  label,
  value,
}: {
  label: string;
  value?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="mt-1 break-words text-sm text-gray-900">{value ?? "-"}</div>
    </div>
  );
}

export function JsonViewer({ value }: { value: unknown }) {
  return (
    <pre className="max-h-[420px] overflow-auto rounded-lg border border-gray-200 bg-gray-950 p-3 text-xs leading-5 text-gray-100">
      {JSON.stringify(value ?? null, null, 2)}
    </pre>
  );
}
