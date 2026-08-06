"use client";

import { useEffect, useRef } from "react";

import { workbenchAuthClient } from "@/lib/auth/workbench-auth.client";

export default function GristLogoutPage() {
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void workbenchAuthClient.signOut().finally(() => {
      window.location.replace("/login");
    });
  }, []);

  return (
    <main className="grid min-h-dvh place-items-center bg-background text-sm text-muted-foreground">
      正在退出账号...
    </main>
  );
}
