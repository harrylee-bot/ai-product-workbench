"use client";

import { useRouter } from "next/navigation";
import { Suspense, useEffect } from "react";
import { Toaster } from "sonner";
import { AppSidebar } from "@/components/chat/app-sidebar";
import { DataStreamProvider } from "@/components/chat/data-stream-provider";
import { ChatShell } from "@/components/chat/shell";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { ActiveChatProvider } from "@/hooks/use-active-chat";
import { useAuth } from "@/lib/auth/nest-auth";

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <DataStreamProvider>
        <Suspense fallback={<div className="flex h-dvh bg-sidebar" />}>
          <SidebarShell>{children}</SidebarShell>
        </Suspense>
      </DataStreamProvider>
    </>
  );
}

function SidebarShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (!loading && !user) {
      router.replace("/login");
    }
  }, [loading, router, user]);

  if (loading || !user) {
    return <div className="flex h-dvh bg-sidebar" />;
  }

  // 客户端读取 sidebar 折叠状态（原 next/headers cookies() 的替代）。
  const isCollapsed =
    typeof document !== "undefined" &&
    document.cookie
      .split("; ")
      .find((row) => row.startsWith("sidebar_state="))
      ?.split("=")[1] !== "true";

  return (
    <SidebarProvider defaultOpen={!isCollapsed}>
      {/* AppSidebar 内部用 useAuth() 取当前用户，无需服务端注入。 */}
      <AppSidebar />
      <SidebarInset>
        <Toaster
          position="top-center"
          theme="system"
          toastOptions={{
            className:
              "!bg-card !text-foreground !border-border/50 !shadow-[var(--shadow-float)]",
          }}
        />
        <Suspense fallback={<div className="flex h-dvh" />}>
          <ActiveChatProvider>
            <ChatShell />
          </ActiveChatProvider>
        </Suspense>
        {children}
      </SidebarInset>
    </SidebarProvider>
  );
}
