"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import type { ReactNode } from "react";
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
    <main className="flex min-h-screen items-center justify-center bg-[#F6F7F9] px-4">
      <div className="rounded-[16px] border border-gray-200 bg-white px-5 py-4 text-sm text-gray-500 shadow-sm">
        加载中...
      </div>
    </main>
  );
}
