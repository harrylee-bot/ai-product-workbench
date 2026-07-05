import { Suspense } from "react";
import { ShareClient } from "@/components/share/share-client";

export default async function ShareTokenPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <div className="text-muted-foreground text-sm">加载分享内容...</div>
        </div>
      }
    >
      <ShareClient token={token} />
    </Suspense>
  );
}
