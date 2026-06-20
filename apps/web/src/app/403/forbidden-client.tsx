"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { ProtectedRoute } from "@/components/protected-route";

export function ForbiddenClient() {
  const router = useRouter();

  return (
    <ProtectedRoute>
      <main className="flex min-h-screen items-center justify-center bg-[#F6F7F9] px-4">
        <section className="w-full max-w-[400px] rounded-[16px] border border-gray-200 bg-white p-8 text-center shadow-[0_18px_45px_rgba(17,24,39,0.08)]">
          <h1 className="text-2xl font-semibold text-gray-950">无权限访问</h1>
          <p className="mt-4 text-sm leading-6 text-gray-500">
            当前账号无权访问该页面，请联系管理员。
          </p>
          <Button type="button" onClick={() => router.push("/workspace")} className="mt-8 w-full">
            返回工作台
          </Button>
        </section>
      </main>
    </ProtectedRoute>
  );
}
