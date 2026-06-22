"use client";

import { Eye, EyeOff } from "lucide-react";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { Button, FieldLabel, InlineError, TextInput } from "@/components/ui";
import { useAuth } from "@/lib/auth-context";

export function LoginClient() {
  const router = useRouter();
  const { login, loading, user, expiredMessage, clearExpiredMessage } = useAuth();
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && user) {
      router.replace("/workspace");
    }
  }, [loading, router, user]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    clearExpiredMessage();

    if (!account.trim() || !password) {
      setError("请输入账号和密码");
      return;
    }

    setSubmitting(true);
    try {
      await login(account.trim(), password);
      router.replace("/workspace");
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "登录失败，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--color-app-bg)] px-4 py-10">
      <section className="w-full max-w-[400px] rounded-[18px] border border-gray-200 bg-white p-8 shadow-[var(--shadow-panel)]">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold text-gray-950">智能产品工作台</h1>
          <div className="mt-4 inline-flex h-8 items-center rounded-[10px] bg-gray-100 px-3 text-[13px] font-medium text-gray-600">
            内测版
          </div>
        </div>

        <form onSubmit={onSubmit} className="space-y-5">
          <div className="space-y-2">
            <FieldLabel>账号</FieldLabel>
            <TextInput
              value={account}
              onChange={(event) => setAccount(event.target.value)}
              disabled={submitting}
              placeholder="请输入用户名或邮箱"
              autoComplete="username"
            />
          </div>

          <div className="space-y-2">
            <FieldLabel>密码</FieldLabel>
            <div className="relative">
              <TextInput
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={submitting}
                type={showPassword ? "text" : "password"}
                placeholder="请输入密码"
                autoComplete="current-password"
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowPassword((value) => !value)}
                disabled={submitting}
                className="absolute right-3 top-1/2 inline-flex -translate-y-1/2 rounded-md p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus-visible:ring-3 focus-visible:ring-gray-950/10 disabled:cursor-not-allowed disabled:opacity-60"
                aria-label={showPassword ? "隐藏密码" : "显示密码"}
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          <InlineError message={error ?? expiredMessage} />

          <Button type="submit" className="h-11 w-full" disabled={submitting}>
            {submitting ? "登录中..." : "登录"}
          </Button>
        </form>

        <p className="mt-8 text-center text-xs leading-6 text-gray-500">内测账号由管理员统一创建</p>
      </section>
    </main>
  );
}
