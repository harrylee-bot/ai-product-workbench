"use client";

import { WorkbenchQueryProvider } from "@/lib/workbench/query";
import { WorkbenchTransportProvider } from "@/lib/workbench/transport";
import { useWorkbenchPublicShare } from "@/lib/workbench/features";
import { isWorkbenchApiError } from "@/lib/workbench/api";
import { PublicRelease } from "@/components/studio/public-release";

export function ShareClient({ token }: { token: string }) {
  return (
    <WorkbenchQueryProvider>
      <WorkbenchTransportProvider>
        <PublicShareContent token={token} />
      </WorkbenchTransportProvider>
    </WorkbenchQueryProvider>
  );
}

function PublicShareContent({ token }: { token: string }) {
  const query = useWorkbenchPublicShare(token);
  if (!token || (query.isError && isMissingShare(query.error))) {
    return <ShareStatus tone="error">分享链接无效或已失效</ShareStatus>;
  }
  if (query.isError) {
    return (
      <ShareStatus onRetry={() => void query.refetch()} tone="error">
        分享服务暂不可用，请稍后重试
      </ShareStatus>
    );
  }
  if (query.isPending || !query.data) {
    return <ShareStatus>正在加载分享内容...</ShareStatus>;
  }
  return <PublicRelease share={query.data.value} token={token} />;
}

function isMissingShare(error: unknown): boolean {
  return isWorkbenchApiError(error) && (error.status === 404 || error.status === 410);
}

function ShareStatus({
  children,
  onRetry,
  tone = "default",
}: {
  children: string;
  onRetry?: () => void;
  tone?: "default" | "error";
}) {
  const message = (
    <p className={tone === "error" ? "text-sm text-red-700" : "text-sm text-slate-600"}>
      {children}
    </p>
  );

  return (
    <div className="grid min-h-screen place-items-center bg-slate-50 px-6">
      {onRetry ? (
        <div className="text-center">
          {message}
          <button
            className="mt-3 rounded-full border border-slate-200 px-4 py-2 text-sm text-slate-800 hover:bg-white/[0.06]"
            onClick={onRetry}
            type="button"
          >
            重试
          </button>
        </div>
      ) : message}
    </div>
  );
}
