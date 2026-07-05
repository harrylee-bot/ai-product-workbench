"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { getApiBase } from "@/lib/api/config";
import { useAuth } from "@/lib/auth/nest-auth";
import { ShareView } from "./share-view";

export function ShareClient({ token: tokenProp }: { token?: string }) {
  const searchParams = useSearchParams();
  const token = tokenProp ?? searchParams.get("token") ?? "";
  const { user, loading: authLoading } = useAuth();

  const [shareData, setShareData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) { setLoading(false); return; }
    if (authLoading) return;
    if (!user) {
      window.location.href = `/login?next=${encodeURIComponent(`/share/${encodeURIComponent(token)}`)}`;
      return;
    }
    fetch(`${getApiBase()}/authenticated-share/${token}`, { credentials: "include" })
      .then((res) => {
        if (!res.ok) throw new Error(`加载失败 (${res.status})`);
        return res.json();
      })
      .then((data) => { if (data) setShareData(data); })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [authLoading, token, user]);

  if (!token) return <div className="flex min-h-screen items-center justify-center"><p className="text-muted-foreground text-sm">无效的分享链接</p></div>;
  if (loading) return <div className="flex min-h-screen items-center justify-center"><p className="text-muted-foreground text-sm">加载分享内容…</p></div>;
  if (error) return <div className="flex min-h-screen items-center justify-center"><p className="text-destructive text-sm">{error}</p></div>;
  if (!shareData) return null;
  return <ShareView shareData={shareData} token={token} />;
}
