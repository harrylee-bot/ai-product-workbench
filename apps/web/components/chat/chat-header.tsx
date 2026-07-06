"use client";

import { PanelLeftIcon, SparklesIcon } from "lucide-react";
import { memo } from "react";
import { Button } from "@/components/ui/button";
import { useSidebar } from "@/components/ui/sidebar";
import { VisibilitySelector, type VisibilityType } from "./visibility-selector";

function PureChatHeader({
  chatId,
  selectedVisibilityType,
  isReadonly,
}: {
  chatId: string;
  selectedVisibilityType: VisibilityType;
  isReadonly: boolean;
}) {
  const { toggleSidebar } = useSidebar();

  return (
    <header className="relative z-10 flex h-13 shrink-0 items-center justify-between gap-3 border-b border-white/10 bg-black/10 px-3 backdrop-blur-xl">
      <div className="flex min-w-0 items-center gap-2">
        <Button
          aria-label="打开侧边栏"
          className="md:hidden"
          onClick={toggleSidebar}
          size="icon-sm"
          variant="ghost"
        >
          <PanelLeftIcon className="size-4" />
        </Button>
        <div className="hidden min-w-0 items-center gap-2 sm:flex">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-white/[0.06] text-foreground ring-1 ring-white/10">
            <SparklesIcon className="size-3.5" />
          </span>
          <span className="truncate text-[13px] font-medium text-foreground/85">
            工作台对话
          </span>
        </div>
      </div>

      {!isReadonly && (
        <VisibilitySelector
          chatId={chatId}
          selectedVisibilityType={selectedVisibilityType}
        />
      )}
    </header>
  );
}

export const ChatHeader = memo(PureChatHeader, (prevProps, nextProps) => {
  return (
    prevProps.chatId === nextProps.chatId &&
    prevProps.selectedVisibilityType === nextProps.selectedVisibilityType &&
    prevProps.isReadonly === nextProps.isReadonly
  );
});
