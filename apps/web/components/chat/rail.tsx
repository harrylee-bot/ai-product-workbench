"use client";

import {
  HomeIcon,
  MessageSquareIcon,
  BookOpenIcon,
  SettingsIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";

export function Rail() {
  const router = useRouter();

  return (
    <aside className="rail" aria-label="Navigation">
      {/* Gemini-style logo mark */}
      <button
        className="gemini-mark"
        type="button"
        aria-label="Home"
        onClick={() => router.push("/")}
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <path
            d="M12 2C12 2 14.5 7 19 9C14.5 11 12 16 12 16C12 16 9.5 11 5 9C9.5 7 12 2 12 2Z"
            fill="url(#gemini-grad)"
          />
          <defs>
            <linearGradient id="gemini-grad" x1="5" y1="2" x2="19" y2="16" gradientUnits="userSpaceOnUse">
              <stop stopColor="#4285F4" />
              <stop offset="1" stopColor="#8B5CF6" />
            </linearGradient>
          </defs>
        </svg>
      </button>

      {/* Top nav buttons */}
      <div className="rail-stack">
        <RailButton
          icon={<HomeIcon size={20} />}
          label="新对话"
          onClick={() => router.push("/")}
        />
        <RailButton
          icon={<MessageSquareIcon size={20} />}
          label="历史记录"
        />
        <RailButton
          icon={<BookOpenIcon size={20} />}
          label="知识库"
        />
      </div>

      {/* Bottom actions */}
      <div className="rail-bottom">
        <RailButton
          icon={<SettingsIcon size={20} />}
          label="设置"
        />
        <button
          className="avatar"
          type="button"
          aria-label="账号"
        >
          A
        </button>
      </div>
    </aside>
  );
}

function RailButton({
  icon,
  label,
  onClick,
  active,
}: {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      data-tip={label}
      onClick={onClick}
      className={cn(
        "tool-button rail-button",
        active && "is-active"
      )}
    >
      {icon}
    </button>
  );
}
