import { AuthSpotlightShell } from "@/components/auth/auth-spotlight-shell";

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AuthSpotlightShell>{children}</AuthSpotlightShell>;
}
