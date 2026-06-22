import clsx from "clsx";
import { AlertCircle, Inbox, Loader2 } from "lucide-react";
import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";

export const uiClass = {
  focusRing: "focus:outline-none focus-visible:ring-3 focus-visible:ring-gray-950/10",
  controlRadius: "rounded-[var(--radius-control)]",
  panelRadius: "rounded-[var(--radius-panel)]",
  cardRadius: "rounded-[var(--radius-card)]",
  controlShadow: "shadow-[var(--shadow-control)]",
  panelShadow: "shadow-[var(--shadow-panel)]",
  floatShadow: "shadow-[var(--shadow-float)]",
  border: "border border-[var(--color-border)]",
  borderStrong: "border border-[var(--color-border-strong)]",
};

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "icon";

export function Button({
  children,
  variant = "primary",
  size = "md",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return (
    <button
      className={clsx(
        "inline-flex shrink-0 items-center justify-center gap-2 rounded-[var(--radius-control)] text-sm font-semibold transition",
        uiClass.focusRing,
        "disabled:cursor-not-allowed disabled:opacity-60",
        size === "sm" && "h-9 px-3",
        size === "md" && "h-10 px-4",
        size === "icon" && "h-9 w-9 px-0",
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

export function IconButton({
  children,
  label,
  variant = "ghost",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  variant?: ButtonVariant;
}) {
  return (
    <Button
      type="button"
      size="icon"
      variant={variant}
      aria-label={label}
      title={label}
      className={className}
      {...props}
    >
      {children}
    </Button>
  );
}

export function FieldLabel({ children }: { children: ReactNode }) {
  return <label className="text-sm font-semibold text-gray-900">{children}</label>;
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={clsx(
        "h-11 w-full rounded-[var(--radius-control)] border border-[var(--color-border-strong)] bg-white px-3 text-sm text-gray-900 shadow-[var(--shadow-control)] transition",
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
        "h-10 rounded-[var(--radius-control)] border border-[var(--color-border-strong)] bg-white px-3 text-sm text-gray-900 shadow-[var(--shadow-control)] transition",
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
        "min-h-[92px] w-full rounded-[var(--radius-control)] border border-[var(--color-border-strong)] bg-white px-3 py-2 text-sm text-gray-900 shadow-[var(--shadow-control)] transition",
        "placeholder:text-gray-400 hover:border-gray-400",
        "focus:border-gray-950 focus:outline-none focus:ring-3 focus:ring-gray-950/10",
        "disabled:bg-gray-100 disabled:text-gray-500",
        props.className,
      )}
    />
  );
}

export function InlineError({ message, className }: { message?: string | null; className?: string }) {
  if (!message) return null;
  return (
    <div className={clsx("rounded-[var(--radius-control)] border border-red-100 bg-red-50 px-3 py-2 text-[13px] leading-5 text-red-700", className)}>
      {message}
    </div>
  );
}

type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "accent";

const badgeToneClass: Record<Tone, string> = {
  neutral: "border-gray-200 bg-gray-100 text-gray-600",
  info: "border-sky-200 bg-sky-50 text-sky-700",
  success: "border-emerald-200 bg-emerald-50 text-emerald-700",
  warning: "border-amber-200 bg-amber-50 text-amber-700",
  danger: "border-red-200 bg-red-50 text-red-700",
  accent: "border-blue-200 bg-blue-50 text-blue-700",
};

export function Badge({
  tone = "neutral",
  children,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={clsx(
        "inline-flex h-6 shrink-0 items-center rounded-full border px-2 text-xs font-semibold",
        badgeToneClass[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: "active" | "disabled" }) {
  const active = status === "active";
  return <Badge tone={active ? "success" : "neutral"}>{active ? "启用" : "禁用"}</Badge>;
}

export function RoleBadge({ role }: { role: "user" | "admin" }) {
  return <Badge tone="neutral" className="bg-white text-gray-700">{role === "admin" ? "管理员" : "普通用户"}</Badge>;
}

export function Surface({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={clsx(
        "rounded-[var(--radius-panel)] border border-[var(--color-border)] bg-white shadow-[var(--shadow-control)]",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className,
}: {
  value: T;
  options: Array<{ value: T; label: string; icon?: ReactNode }>;
  onChange: (value: T) => void;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={clsx("inline-flex rounded-full bg-gray-100 p-1 shadow-inner", className)}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(option.value)}
            className={clsx(
              "inline-flex h-8 items-center justify-center gap-1.5 rounded-full px-3 text-sm font-semibold transition",
              uiClass.focusRing,
              selected ? "bg-white text-gray-950 shadow-sm" : "text-gray-500 hover:text-gray-900",
            )}
          >
            {option.icon}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  icon,
  className,
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={clsx(
        "rounded-[var(--radius-panel)] border border-dashed border-[var(--color-border)] bg-white px-5 py-10 text-center shadow-[var(--shadow-control)]",
        className,
      )}
    >
      <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--color-surface-subtle)] text-gray-400">
        {icon ?? <Inbox className="h-5 w-5" />}
      </div>
      <div className="text-sm font-semibold text-gray-950">{title}</div>
      {description ? <p className="mx-auto mt-2 max-w-[360px] text-sm leading-6 text-gray-500">{description}</p> : null}
    </div>
  );
}

export function LoadingState({
  label = "加载中...",
  className,
}: {
  label?: string;
  className?: string;
}) {
  return (
    <Surface className={clsx("flex items-center gap-2 px-3 py-3 text-sm text-gray-500", className)}>
      <Loader2 className="h-4 w-4 animate-spin text-[var(--color-accent)]" />
      {label}
    </Surface>
  );
}

export function ErrorState({
  title = "加载失败",
  description,
  className,
}: {
  title?: string;
  description?: string;
  className?: string;
}) {
  return (
    <div className={clsx("rounded-[var(--radius-panel)] border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700", className)}>
      <div className="flex items-center gap-2 font-semibold">
        <AlertCircle className="h-4 w-4" />
        {title}
      </div>
      {description ? <div className="mt-1 leading-6 text-red-600">{description}</div> : null}
    </div>
  );
}
