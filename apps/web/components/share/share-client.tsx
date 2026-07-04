"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { getApiBase } from "@/lib/api/config";
import { ShareView } from "./share-view";

export function ShareClient() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";

  const [shareData, setShareData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) { setLoading(false); return; }
    fetch(`${getApiBase()}/public/share/${token}`, { credentials: "include" })
      .then((res) => {
        if (res.status === 401) { window.location.href = `/login?redirect=/share?token=${token}`; return null; }
        if (!res.ok) throw new Error(`加载失败 (${res.status})`);
        return res.json();
      })
      .then((data) => { if (data) setShareData(data); })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [token]);

  if (!token) return <div className="flex min-h-screen items-center justify-center"><p className="text-muted-foreground text-sm">无效的分享链接</p></div>;
  if (loading) return <div className="flex min-h-screen items-center justify-center"><p className="text-muted-foreground text-sm">加载分享内容…</p></div>;
  if (error) return <div className="flex min-h-screen items-center justify-center"><p className="text-destructive text-sm">{error}</p></div>;
  if (!shareData) return null;
  return <ShareView shareData={shareData} token={token} />;
}
