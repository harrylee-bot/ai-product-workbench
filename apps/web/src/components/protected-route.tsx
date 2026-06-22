"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import type { ReactNode } from "react";
import { LoadingState } from "@/components/ui";
import { useAuth } from "@/lib/auth-context";

export function ProtectedRoute({
  children,
  requireAdmin = false,
}: {
  children: ReactNode;
  requireAdmin?: boolean;
}) {
  const router = useRouter();
  const { loading, user } = useAuth();

  useEffect(() => {
    if (loading) return;
    if (!user) {
      router.replace("/login");
      return;
    }
    if (requireAdmin && user.role !== "admin") {
      router.replace("/403");
    }
  }, [loading, requireAdmin, router, user]);

  if (loading || !user || (requireAdmin && user.role !== "admin")) {
    return <RouteLoading />;
  }

  return children;
}

export function RouteLoading() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--color-app-bg)] px-4">
      <LoadingState label="加载中..." />
    </main>
  );
}
