"use client";

import { useRouter } from "next/navigation";
import { Suspense, useEffect } from "react";
import { Toaster } from "sonner";
import { DataStreamProvider } from "@/components/chat/data-stream-provider";
import { ChatShell } from "@/components/chat/shell";
import { useAuth } from "@/lib/auth/nest-auth";

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <DataStreamProvider>
        <Suspense fallback={<div className="flex h-[900px] bg-background" />}>
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
    const previousMinWidth = document.body.style.minWidth;
    document.body.style.minWidth = "1440px";
    return () => {
      document.body.style.minWidth = previousMinWidth;
    };
  }, []);

  useEffect(() => {
    if (!loading && !user) {
      router.replace("/login");
    }
  }, [loading, router, user]);

  if (loading || !user) {
    return <div className="flex h-[900px] bg-background" />;
  }

  return (
    <div className="min-h-[900px] bg-[#1c1c1c] text-white">
      <Toaster
        position="top-center"
        theme="dark"
        toastOptions={{
          className:
            "!bg-card !text-foreground !border-border/70 !shadow-[var(--shadow-float)] !backdrop-blur-xl",
        }}
      />
      <div className="mx-auto h-[900px] min-w-[1440px] max-w-[1440px] overflow-hidden bg-[#1f2022]">
        <Suspense fallback={<div className="flex h-[900px]" />}>
          <ChatShell />
        </Suspense>
        {children}
      </div>
    </div>
  );
}
