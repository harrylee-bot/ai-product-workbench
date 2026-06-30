"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { useAuth } from "@/lib/auth/nest-auth";
import { toast } from "./toast";

export const SignOutForm = () => {
  const router = useRouter();
  const { logout } = useAuth();
  const [signingOut, setSigningOut] = useState(false);

  const handleSignOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await logout();
      router.push("/login");
    } catch {
      toast({ type: "error", description: "退出登录失败" });
      setSigningOut(false);
    }
  };

  return (
    <button
      className="w-full px-1 py-0.5 text-left text-red-500"
      disabled={signingOut}
      onClick={handleSignOut}
      type="button"
    >
      {signingOut ? "正在退出..." : "退出登录"}
    </button>
  );
};
