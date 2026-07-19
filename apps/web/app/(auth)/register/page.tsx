"use client";

import Link from "next/link";
import Form from "next/form";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { LoaderIcon } from "@/components/auth/auth-icons";
import { authToast } from "@/components/auth/auth-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  authRouteWithReturnPath,
  safeAuthReturnPath,
} from "@/lib/auth/auth-return-path";
import { useWorkbenchAuth } from "@/lib/auth/workbench-auth";
import {
  isWorkbenchEmail,
  isWorkbenchUsername,
  WORKBENCH_PASSWORD_MIN_LENGTH,
} from "@/lib/auth/workbench-auth.shared";

export default function Page() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { register } = useWorkbenchAuth();
  const [isSuccessful, setIsSuccessful] = useState(false);
  const nextPath = safeAuthReturnPath(searchParams.get("next"));
  const publicRegistrationEnabled =
    process.env.NEXT_PUBLIC_WORKBENCH_PUBLIC_REGISTRATION_ENABLED === "true";

  useEffect(() => {
    if (!publicRegistrationEnabled) {
      router.replace(authRouteWithReturnPath("/login", nextPath));
    }
  }, [nextPath, publicRegistrationEnabled, router]);

  if (!publicRegistrationEnabled) return null;

  const handleSubmit = async (formData: FormData) => {
    const username = (formData.get("username") as string)?.trim() ?? "";
    const email = (formData.get("email") as string)?.trim() ?? "";
    const password = (formData.get("password") as string) ?? "";

    if (!isWorkbenchUsername(username)) {
      authToast({
        type: "error",
        description: "用户名需为 3-30 位字母、数字、点、横线或下划线",
      });
      return;
    }
    if (!isWorkbenchEmail(email)) {
      authToast({ type: "error", description: "请填写有效的邮箱" });
      return;
    }
    if (password.length < WORKBENCH_PASSWORD_MIN_LENGTH) {
      authToast({
        type: "error",
        description: `密码至少需要 ${WORKBENCH_PASSWORD_MIN_LENGTH} 位`,
      });
      return;
    }

    try {
      await register({
        username,
        email,
        password,
      });
      authToast({ type: "success", description: "账号已创建" });
      setIsSuccessful(true);
      window.location.assign(nextPath);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "创建账号失败";
      authToast({ type: "error", description: message });
    }
  };

  return (
    <>
      <Form action={handleSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label
            className="font-normal text-muted-foreground"
            htmlFor="username"
          >
            用户名
          </Label>
          <Input
            autoComplete="username"
            autoFocus
            className="h-10 rounded-lg border-border/50 bg-muted/50 text-sm transition-colors focus:border-foreground/20 focus:bg-muted"
            id="username"
            name="username"
            placeholder="your-username"
            required
            type="text"
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label className="font-normal text-muted-foreground" htmlFor="email">
            邮箱
          </Label>
          <Input
            autoComplete="email"
            className="h-10 rounded-lg border-border/50 bg-muted/50 text-sm transition-colors focus:border-foreground/20 focus:bg-muted"
            id="email"
            name="email"
            placeholder="name@company.com"
            required
            type="email"
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label
            className="font-normal text-muted-foreground"
            htmlFor="password"
          >
            密码
          </Label>
          <Input
            autoComplete="new-password"
            className="h-10 rounded-lg border-border/50 bg-muted/50 text-sm transition-colors focus:border-foreground/20 focus:bg-muted"
            id="password"
            name="password"
            placeholder="&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;"
            required
            type="password"
          />
        </div>

        <Button
          aria-disabled={isSuccessful}
          className="relative"
          disabled={isSuccessful}
          type="submit"
        >
          创建工作台
          {isSuccessful && (
            <span className="absolute right-4 animate-spin">
              <LoaderIcon />
            </span>
          )}
        </Button>

        <p className="text-center text-[13px] text-muted-foreground">
          {"已有工作台账号？"}
          <Link
            className="text-foreground underline-offset-4 hover:underline"
            href={authRouteWithReturnPath("/login", nextPath)}
          >
            登录继续
          </Link>
        </p>
      </Form>
    </>
  );
}
