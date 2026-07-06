"use client";

import Link from "next/link";
import Form from "next/form";
import { useState } from "react";

import { LoaderIcon } from "@/components/chat/icons";
import { toast } from "@/components/chat/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth/nest-auth";

export default function Page() {
  const { register } = useAuth();
  const [isSuccessful, setIsSuccessful] = useState(false);

  const handleSubmit = async (formData: FormData) => {
    const username = (formData.get("username") as string)?.trim() ?? "";
    const email = (formData.get("email") as string)?.trim() ?? "";
    const password = (formData.get("password") as string) ?? "";

    if (!username) {
      toast({ type: "error", description: "请输入用户名" });
      return;
    }
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      toast({ type: "error", description: "请填写有效的邮箱" });
      return;
    }
    if (password.length < 6) {
      toast({ type: "error", description: "密码至少需要 6 位" });
      return;
    }

    try {
      await register({
        username,
        email,
        password,
      });
      toast({ type: "success", description: "账号已创建" });
      setIsSuccessful(true);
      window.location.assign("/");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "创建账号失败";
      toast({ type: "error", description: message });
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
            href="/login"
          >
            登录继续
          </Link>
        </p>
      </Form>
    </>
  );
}
