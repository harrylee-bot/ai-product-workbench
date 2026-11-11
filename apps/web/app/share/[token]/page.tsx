import { Suspense } from "react";
import { ShareClient } from "@/components/share/share-client";

type ShareTokenPageProps = { params: Promise<{ token: string }> };

async function ShareTokenContent({ params }: ShareTokenPageProps) {
  const { token } = await params;
  return <ShareClient token={token} />;
}

export default function ShareTokenPage({ params }: ShareTokenPageProps) {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <div className="text-muted-foreground text-sm">加载分享内容...</div>
        </div>
      }
    >
      <ShareTokenContent params={params} />
    </Suspense>
  );
}
