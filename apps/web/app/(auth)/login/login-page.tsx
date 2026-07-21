"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";

import { AuthForm } from "@/components/auth/auth-form";
import { AuthSubmitButton } from "@/components/auth/auth-submit-button";
import { authToast } from "@/components/auth/auth-toast";
import { Button } from "@/components/ui/button";
import {
  authRouteWithReturnPath,
  safeAuthReturnPath,
} from "@/lib/auth/auth-return-path";
import { useWorkbenchAuth } from "@/lib/auth/workbench-auth";
import {
  isEmailLoginIdentifier,
  isWorkbenchEmail,
  isWorkbenchUsername,
  WORKBENCH_PASSWORD_MIN_LENGTH,
} from "@/lib/auth/workbench-auth.shared";

export function LoginPage({ enterpriseSsoEnabled }: { enterpriseSsoEnabled: boolean }) {
  const searchParams = useSearchParams();
  const { login, loginWithOidc } = useWorkbenchAuth();
  const [account, setAccount] = useState("");
  const [isSuccessful, setIsSuccessful] = useState(false);
  const [isSsoPending, setIsSsoPending] = useState(false);
  const nextPath = safeAuthReturnPath(searchParams.get("next"));
  const publicRegistrationEnabled =
    process.env.NEXT_PUBLIC_WORKBENCH_PUBLIC_REGISTRATION_ENABLED === "true";

  const handleSubmit = async (formData: FormData) => {
    const accountValue = ((formData.get("account") as string) ?? "").trim();
    const passwordValue = (formData.get("password") as string) ?? "";

    setAccount(accountValue);

    const validAccount = isEmailLoginIdentifier(accountValue)
      ? isWorkbenchEmail(accountValue)
      : isWorkbenchUsername(accountValue);
    if (!validAccount) {
      authToast({ type: "error", description: "请输入有效的用户名或邮箱" });
      return;
    }
    if (passwordValue.length < WORKBENCH_PASSWORD_MIN_LENGTH) {
      authToast({
        type: "error",
        description: `密码至少需要 ${WORKBENCH_PASSWORD_MIN_LENGTH} 位`,
      });
      return;
    }

    try {
      await login({ account: accountValue, password: passwordValue });
      setIsSuccessful(true);
      window.location.assign(nextPath);
    } catch {
      authToast({ type: "error", description: "账号或密码不正确" });
    }
  };

  const handleOidcSubmit = async () => {
    try {
      setIsSsoPending(true);
      await loginWithOidc(nextPath);
    } catch {
      setIsSsoPending(false);
      authToast({ type: "error", description: "企业账号登录暂时不可用" });
    }
  };

  return (
    <>
      <AuthForm action={handleSubmit} defaultAccount={account}>
        <AuthSubmitButton isSuccessful={isSuccessful}>登录</AuthSubmitButton>
        {publicRegistrationEnabled && (
          <p className="text-center text-[13px] text-muted-foreground">
            {"还没有产品账号？"}
            <Link
              className="text-foreground underline-offset-4 hover:underline"
              href={authRouteWithReturnPath("/register", nextPath)}
            >
              创建一个
            </Link>
          </p>
        )}
      </AuthForm>

      {enterpriseSsoEnabled && (
        <>
          <div className="flex items-center gap-3" aria-hidden="true">
            <span className="h-px flex-1 bg-border/60" />
            <span className="text-xs text-muted-foreground">或</span>
            <span className="h-px flex-1 bg-border/60" />
          </div>

          <form action={handleOidcSubmit} className="flex flex-col">
            <Button
              aria-disabled={isSsoPending}
              disabled={isSsoPending}
              type="submit"
              variant="outline"
            >
              企业 SSO 登录
            </Button>
          </form>
        </>
      )}
    </>
  );
}
