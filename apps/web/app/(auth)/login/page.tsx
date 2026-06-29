"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { AuthForm } from "@/components/chat/auth-form";
import { SubmitButton } from "@/components/chat/submit-button";
import { toast } from "@/components/chat/toast";
import { useAuth } from "@/lib/auth/nest-auth";

export default function Page() {
  const router = useRouter();
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [isSuccessful, setIsSuccessful] = useState(false);

  const handleSubmit = async (formData: FormData) => {
    const emailValue = (formData.get("email") as string) ?? "";
    const passwordValue = (formData.get("password") as string) ?? "";

    setEmail(emailValue);

    if (!emailValue || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailValue)) {
      toast({ type: "error", description: "Failed validating your submission!" });
      return;
    }
    if (passwordValue.length < 6) {
      toast({ type: "error", description: "Failed validating your submission!" });
      return;
    }

    try {
      await login({ email: emailValue, password: passwordValue });
      setIsSuccessful(true);
      router.push("/");
    } catch {
      toast({ type: "error", description: "Invalid credentials!" });
    }
  };

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Welcome back</h1>
      <p className="text-sm text-muted-foreground">
        Sign in to your account to continue
      </p>
      <AuthForm action={handleSubmit} defaultEmail={email}>
        <SubmitButton isSuccessful={isSuccessful}>Sign in</SubmitButton>
        <p className="text-center text-[13px] text-muted-foreground">
          {"No account? "}
          <Link
            className="text-foreground underline-offset-4 hover:underline"
            href="/register"
          >
            Sign up
          </Link>
        </p>
      </AuthForm>
    </>
  );
}
