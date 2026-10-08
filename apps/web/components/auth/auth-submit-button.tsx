"use client";

import { Button } from "@/components/ui/button";

import { useAuthFormPending } from "./auth-form";
import { LoaderIcon } from "./auth-icons";

export function AuthSubmitButton({
  children,
  isSuccessful,
}: {
  children: React.ReactNode;
  isSuccessful: boolean;
}) {
  const pending = useAuthFormPending();

  return (
    <Button
      aria-disabled={pending || isSuccessful}
      className="relative"
      disabled={pending || isSuccessful}
      type={pending ? "button" : "submit"}
    >
      {children}

      {(pending || isSuccessful) && (
        <span className="absolute right-4 animate-spin">
          <LoaderIcon />
        </span>
      )}

      <output aria-live="polite" className="sr-only">
        {pending || isSuccessful ? "加载中" : "提交表单"}
      </output>
    </Button>
  );
}
