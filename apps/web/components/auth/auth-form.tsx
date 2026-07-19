import Form from "next/form";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function AuthForm({
  action,
  children,
  defaultAccount = "",
}: {
  action: NonNullable<
    string | ((formData: FormData) => void | Promise<void>) | undefined
  >;
  children: React.ReactNode;
  defaultAccount?: string;
}) {
  return (
    <Form action={action} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label className="font-normal text-muted-foreground" htmlFor="account">
          用户名或邮箱
        </Label>
        <Input
          autoComplete="username"
          autoFocus
          className="h-10 rounded-lg border-border/50 bg-muted/50 text-sm transition-colors focus:border-foreground/20 focus:bg-muted"
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
          className="h-10 rounded-lg border-border/50 bg-muted/50 text-sm transition-colors focus:border-foreground/20 focus:bg-muted"
          id="password"
          name="password"
          placeholder="&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;"
          required
          type="password"
        />
      </div>

      {children}
    </Form>
  );
}
