import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { ShareView } from "@/components/share/share-view";

interface SharePageProps {
  params: {
    token: string;
  };
}

async function getShareData(token: string) {
  const cookieStore = await cookies();
  const authCookie = cookieStore.get("nest-auth");

  if (!authCookie) {
    // 未登录，重定向到登录页，登录后返回分享页
    redirect(`/login?redirect=/share/${token}`);
  }

  try {
    const response = await fetch(
      `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"}/api/public/share/${token}`,
      {
        headers: {
          Cookie: `nest-auth=${authCookie.value}`,
        },
        cache: "no-store",
      }
    );

    if (!response.ok) {
      if (response.status === 401) {
        redirect(`/login?redirect=/share/${token}`);
      }
      throw new Error(`Failed to fetch share: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error("Error fetching share data:", error);
    throw error;
  }
}

export default async function SharePage({ params }: SharePageProps) {
  const { token } = params;
  const shareData = await getShareData(token);

  return <ShareView shareData={shareData} token={token} />;
}
