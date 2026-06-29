"use client";

import Link from "next/link";
import Form from "next/form";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { LoaderIcon } from "@/components/chat/icons";
import { toast } from "@/components/chat/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth/nest-auth";

export default function Page() {
  const router = useRouter();
  const { register } = useAuth();
  const [isSuccessful, setIsSuccessful] = useState(false);

  const handleSubmit = async (formData: FormData) => {
    const username = (formData.get("username") as string)?.trim() ?? "";
    const email = (formData.get("email") as string)?.trim() ?? "";
    const password = (formData.get("password") as string) ?? "";
    const displayName = (formData.get("displayName") as string)?.trim() ?? "";

    if (!username) {
      toast({ type: "error", description: "Username is required!" });
      return;
    }
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      toast({ type: "error", description: "Failed validating your submission!" });
      return;
    }
    if (password.length < 6) {
      toast({ type: "error", description: "Failed validating your submission!" });
      return;
    }

    try {
      await register({
        username,
        email,
        password,
        ...(displayName ? { displayName } : {}),
      });
      toast({ type: "success", description: "Account created!" });
      setIsSuccessful(true);
      router.push("/");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to create account!";
      toast({ type: "error", description: message });
    }
  };

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Create account</h1>
      <p className="text-sm text-muted-foreground">Get started for free</p>
      <Form action={handleSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label
            className="font-normal text-muted-foreground"
            htmlFor="username"
          >
            Username
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
          <Label
            className="font-normal text-muted-foreground"
            htmlFor="displayName"
          >
            Display name (optional)
          </Label>
          <Input
            autoComplete="nickname"
            className="h-10 rounded-lg border-border/50 bg-muted/50 text-sm transition-colors focus:border-foreground/20 focus:bg-muted"
            id="displayName"
            name="displayName"
            placeholder="Your name"
            type="text"
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label className="font-normal text-muted-foreground" htmlFor="email">
            Email
          </Label>
          <Input
            autoComplete="email"
            className="h-10 rounded-lg border-border/50 bg-muted/50 text-sm transition-colors focus:border-foreground/20 focus:bg-muted"
            id="email"
            name="email"
            placeholder="you@someo.ne"
            required
            type="email"
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label
            className="font-normal text-muted-foreground"
            htmlFor="password"
          >
            Password
          </Label>
          <Input
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
          Sign up
          {isSuccessful && (
            <span className="absolute right-4 animate-spin">
              <LoaderIcon />
            </span>
          )}
        </Button>

        <p className="text-center text-[13px] text-muted-foreground">
          {"Have an account? "}
          <Link
            className="text-foreground underline-offset-4 hover:underline"
            href="/login"
          >
            Sign in
          </Link>
        </p>
      </Form>
    </>
  );
}
