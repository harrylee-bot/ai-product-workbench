"use client";

import {
  createContext,
  type FormEvent,
  useContext,
  useRef,
  useState,
} from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { authToast } from "./auth-toast";

type AuthFormAction = (formData: FormData) => void | Promise<void>;

const AuthFormPendingContext = createContext(false);

export function useAuthFormPending() {
  return useContext(AuthFormPendingContext);
}

export function useAuthFormSubmission(action: AuthFormAction) {
  const [pending, setPending] = useState(false);
  const submittingRef = useRef(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submittingRef.current) return;
    const formData = new FormData(event.currentTarget);
    submittingRef.current = true;
    setPending(true);
    try {
      await action(formData);
    } catch {
      authToast({ type: "error", description: "提交失败，请重试" });
    } finally {
      submittingRef.current = false;
      setPending(false);
    }
  };

  return { handleSubmit, pending };
}

export function AuthForm({
  action,
  children,
  defaultAccount = "",
}: {
  action: AuthFormAction;
  children: React.ReactNode;
  defaultAccount?: string;
}) {
  const { handleSubmit, pending } = useAuthFormSubmission(action);

  return (
    <form aria-busy={pending} className="flex flex-col gap-4" onSubmit={handleSubmit}>
      <div className="flex flex-col gap-2">
        <Label className="font-normal text-muted-foreground" htmlFor="account">
          用户名或邮箱
        </Label>
        <Input
          autoComplete="username"
          autoFocus
          className="h-10 rounded-lg border-border/50 bg-muted/50 text-base sm:text-sm transition-colors focus:border-foreground/20 focus:bg-muted"
          defaultValue={defaultAccount}
          id="account"
          name="account"
          placeholder="username"
          required
          type="text"
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label className="font-normal text-muted-foreground" htmlFor="password">
          密码
        </Label>
        <Input
          autoComplete="current-password"
          className="h-10 rounded-lg border-border/50 bg-muted/50 text-base sm:text-sm transition-colors focus:border-foreground/20 focus:bg-muted"
          id="password"
          name="password"
          placeholder="&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;"
          required
          type="password"
        />
      </div>

      <AuthFormPendingContext.Provider value={pending}>
        {children}
      </AuthFormPendingContext.Provider>
    </form>
  );
}
