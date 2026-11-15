"use client";

import { WorkbenchQueryProvider } from "@/lib/workbench/query";
import { WorkbenchTransportProvider } from "@/lib/workbench/transport";
import { useWorkbenchPublicShare } from "@/lib/workbench/features";
import { PublicShareStatus } from "@/components/studio/public-share-status";
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
  if (!token || query.isError) {
    return (
      <PublicShareStatus
        error={query.error}
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (query.isPending || !query.data) {
    return (
      <div className="studio-loading" role="status">
        正在加载分享内容...
      </div>
    );
  }
  return <PublicRelease share={query.data.value} token={token} />;
}
