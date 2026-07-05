"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { AuthForm } from "@/components/chat/auth-form";
import { SubmitButton } from "@/components/chat/submit-button";
import { toast } from "@/components/chat/toast";
import { useAuth } from "@/lib/auth/nest-auth";

export default function Page() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [isSuccessful, setIsSuccessful] = useState(false);
  const nextPath = safeNextPath(searchParams.get("next"));

  const handleSubmit = async (formData: FormData) => {
    const emailValue = (formData.get("email") as string) ?? "";
    const passwordValue = (formData.get("password") as string) ?? "";

    setEmail(emailValue);

    if (!emailValue || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailValue)) {
      toast({ type: "error", description: "请填写有效的邮箱和密码" });
      return;
    }
    if (passwordValue.length < 6) {
      toast({ type: "error", description: "密码至少需要 6 位" });
      return;
    }

    try {
      await login({ email: emailValue, password: passwordValue });
      setIsSuccessful(true);
      router.push(nextPath);
    } catch {
      toast({ type: "error", description: "邮箱或密码不正确" });
    }
  };

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">欢迎回来</h1>
      <p className="text-sm text-muted-foreground">
        登录后继续使用 AI 产品工作台
      </p>
      <AuthForm action={handleSubmit} defaultEmail={email}>
        <SubmitButton isSuccessful={isSuccessful}>登录</SubmitButton>
        <p className="text-center text-[13px] text-muted-foreground">
          {"还没有账号？"}
          <Link
            className="text-foreground underline-offset-4 hover:underline"
            href="/register"
          >
            注册
          </Link>
        </p>
      </AuthForm>
    </>
  );
}

function safeNextPath(value: string | null) {
  if (!value?.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}
