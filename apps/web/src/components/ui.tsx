import clsx from "clsx";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

export function Button({
  children,
  variant = "primary",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
}) {
  return (
    <button
      className={clsx(
        "inline-flex h-10 items-center justify-center gap-2 rounded-[10px] px-4 text-sm font-semibold transition",
        "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-gray-950/10",
        "disabled:cursor-not-allowed disabled:opacity-60",
        variant === "primary" && "bg-[var(--color-primary)] text-white shadow-[var(--shadow-control)] hover:bg-[var(--color-primary-hover)]",
        variant === "secondary" && "border border-[var(--color-border)] bg-white text-gray-900 shadow-[var(--shadow-control)] hover:border-[var(--color-border-strong)] hover:bg-gray-50",
        variant === "ghost" && "text-gray-600 hover:bg-gray-100 hover:text-gray-950",
        variant === "danger" && "bg-[var(--color-danger)] text-white shadow-[var(--shadow-control)] hover:bg-red-700",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function FieldLabel({ children }: { children: ReactNode }) {
  return <label className="text-sm font-medium text-gray-900">{children}</label>;
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={clsx(
        "h-11 w-full rounded-[10px] border border-gray-300 bg-white px-3 text-sm text-gray-900 shadow-[var(--shadow-control)] transition",
        "placeholder:text-gray-400 hover:border-gray-400",
        "focus:border-gray-950 focus:outline-none focus:ring-3 focus:ring-gray-950/10",
        "disabled:bg-gray-100 disabled:text-gray-500",
        props.className,
      )}
    />
  );
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={clsx(
        "h-10 rounded-[10px] border border-gray-300 bg-white px-3 text-sm text-gray-900 shadow-[var(--shadow-control)] transition",
        "hover:border-gray-400 focus:border-gray-950 focus:outline-none focus:ring-3 focus:ring-gray-950/10",
        props.className,
      )}
    />
  );
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={clsx(
        "min-h-[92px] w-full rounded-[10px] border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-[var(--shadow-control)] transition",
        "placeholder:text-gray-400 hover:border-gray-400",
        "focus:border-gray-950 focus:outline-none focus:ring-3 focus:ring-gray-950/10",
        "disabled:bg-gray-100 disabled:text-gray-500",
        props.className,
      )}
    />
  );
}

export function InlineError({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <div className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-[13px] leading-5 text-red-700">
      {message}
    </div>
  );
}

export function StatusBadge({ status }: { status: "active" | "disabled" }) {
  const active = status === "active";
  return (
    <span
      className={clsx(
        "inline-flex h-6 items-center rounded-full border px-2 text-xs font-medium",
        active
          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
          : "border-gray-200 bg-gray-100 text-gray-600",
      )}
    >
      {active ? "启用" : "禁用"}
    </span>
  );
}

export function RoleBadge({ role }: { role: "user" | "admin" }) {
  return (
    <span className="inline-flex h-6 items-center rounded-full border border-gray-200 bg-white px-2 text-xs font-medium text-gray-700">
      {role === "admin" ? "管理员" : "普通用户"}
    </span>
  );
}
