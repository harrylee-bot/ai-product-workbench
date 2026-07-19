"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { Toaster } from "sonner";

import { useWorkbenchAuth } from "@/lib/auth/workbench-auth";
import {
  projectInvitationTokenFromHash,
  projectInvitationTokenStorageKey,
} from "@/lib/workbench/features/projects";
import { WorkbenchQueryProvider } from "@/lib/workbench/query";
import { WorkbenchTransportProvider } from "@/lib/workbench/transport";

export default function InvitationLayout({ children }: { children: React.ReactNode }) {
  const { user } = useWorkbenchAuth();
  return (
    <WorkbenchQueryProvider privateCacheNamespace={user?.id ?? null}>
      <WorkbenchTransportProvider>
        <AuthenticatedInvitationLayout>{children}</AuthenticatedInvitationLayout>
      </WorkbenchTransportProvider>
    </WorkbenchQueryProvider>
  );
}

function AuthenticatedInvitationLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { loading, user } = useWorkbenchAuth();

  useEffect(() => {
    const hadFragment = Boolean(window.location.hash);
    const token = projectInvitationTokenFromHash(window.location.hash);
    try {
      if (token) window.sessionStorage.setItem(projectInvitationTokenStorageKey, token);
      else if (hadFragment) window.sessionStorage.removeItem(projectInvitationTokenStorageKey);
    } catch {
      // The acceptance page can still consume the fragment in this render.
    }
    if (hadFragment) {
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${window.location.search}`,
      );
    }
  }, []);

  useEffect(() => {
    if (loading || user) return;
    const query = searchParams.toString();
    const next = `${pathname}${query ? `?${query}` : ""}`;
    router.replace(`/login?next=${encodeURIComponent(next)}`);
  }, [loading, pathname, router, searchParams, user]);

  if (loading || !user) return <div className="h-screen bg-[#131314]" />;

  return (
    <div className="min-h-screen bg-[#131314] text-[#f1f3f4]">
      <Toaster position="top-center" theme="dark" />
      {children}
    </div>
  );
}
