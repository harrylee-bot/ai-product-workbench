"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";
import { Toaster } from "sonner";


import { useWorkbenchAuth } from "@/lib/auth/workbench-auth";
import { authRouteWithReturnPath, safeAuthReturnPath } from "@/lib/auth/auth-return-path";
import { WorkbenchQueryProvider } from "@/lib/workbench/query";
import { WorkbenchTransportProvider } from "@/lib/workbench/transport";

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <WorkbenchDataProviders>
      <Suspense fallback={<div className="flex h-dvh bg-background" />}>
        <WorkbenchAuthenticatedShell>
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
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { user, loading } = useWorkbenchAuth();

  useEffect(() => {
    if (!loading && !user) {
      const query = searchParams.toString();
      const next = safeAuthReturnPath(`${pathname}${query ? `?${query}` : ""}${window.location.hash}`);
      router.replace(authRouteWithReturnPath("/login", next));
    }
  }, [loading, pathname, router, searchParams, user]);

  if (loading || !user) {
    return <div className="flex h-dvh bg-background" />;
  }

  return (
    <div className="h-dvh w-full overflow-hidden bg-[#f4f5f7] text-slate-900">
      <Toaster
        position="top-center"
        theme="light"
        toastOptions={{
          className:
            "!bg-card !text-foreground !border-border/70 !shadow-[var(--shadow-float)] !backdrop-blur-xl",
        }}
      />
      <div className="h-full w-full overflow-hidden bg-[#f4f5f7]">
        {children}
      </div>
    </div>
  );
}
