"use client";

import { useRouter } from "next/navigation";
import { Suspense, useEffect } from "react";
import { Toaster } from "sonner";

import { WorkbenchRuntimeProvider } from "@/components/workbench/workbench-runtime";
import { useWorkbenchAuth } from "@/lib/auth/workbench-auth";
import { WorkbenchQueryProvider } from "@/lib/workbench/query";
import { WorkbenchTransportProvider } from "@/lib/workbench/transport";

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <WorkbenchDataProviders>
      <Suspense fallback={<div className="flex h-screen bg-background" />}>
        <WorkbenchAuthenticatedShell>
          <WorkbenchRuntimeProvider />
          {children}
        </WorkbenchAuthenticatedShell>
      </Suspense>
    </WorkbenchDataProviders>
  );
}

function WorkbenchDataProviders({ children }: { children: React.ReactNode }) {
  const { user } = useWorkbenchAuth();
  return (
    <WorkbenchQueryProvider privateCacheNamespace={user?.id ?? null}>
      <WorkbenchTransportProvider>
        {children}
      </WorkbenchTransportProvider>
    </WorkbenchQueryProvider>
  );
}

function WorkbenchAuthenticatedShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { user, loading } = useWorkbenchAuth();

  useEffect(() => {
    if (!loading && !user) {
      router.replace("/login");
    }
  }, [loading, router, user]);

  if (loading || !user) {
    return <div className="flex h-screen bg-background" />;
  }

  return (
    <div className="h-screen w-screen overflow-hidden bg-[#131314] text-white">
      <Toaster
        position="top-center"
        theme="dark"
        toastOptions={{
          className:
            "!bg-card !text-foreground !border-border/70 !shadow-[var(--shadow-float)] !backdrop-blur-xl",
        }}
      />
      <div className="h-full w-full overflow-hidden bg-[#131314]">
        {children}
      </div>
    </div>
  );
}
