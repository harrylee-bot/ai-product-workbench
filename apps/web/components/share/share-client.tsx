"use client";

import { useEffect, useState } from "react";
import { getApiBase } from "@/lib/api/config";
import { ShareView } from "./share-view";

interface ShareClientProps {
  token: string;
}

export function ShareClient({ token }: ShareClientProps) {
  const [shareData, setShareData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${getApiBase()}/public/share/${token}`, {
      credentials: "include",
    })
      .then((res) => {
        if (res.status === 401) {
          window.location.href = `/login?redirect=/share/${token}`;
          return null;
        }
        if (!res.ok) {
          throw new Error(`加载失败 (${res.status})`);
        }
        return res.json();
      })
      .then((data) => {
        if (data) setShareData(data);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [token]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-muted-foreground text-sm">加载分享内容…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-destructive text-sm">{error}</div>
      </div>
    );
  }

  if (!shareData) return null;

  return <ShareView shareData={shareData} token={token} />;
}
