import { ShareClient } from "@/components/share/share-client";

// 分享页面依赖运行时 token，禁用静态预渲染
export const dynamic = "force-dynamic";

interface SharePageProps {
  params: Promise<{
    token: string;
  }>;
}

export default async function SharePage({ params }: SharePageProps) {
  const { token } = await params;
  return <ShareClient token={token} />;
}
