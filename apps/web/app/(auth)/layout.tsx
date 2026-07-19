import { AuthSpotlightShell } from "@/components/auth/auth-spotlight-shell";
import { AuthToaster } from "@/components/auth/auth-toast";

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <AuthSpotlightShell>{children}</AuthSpotlightShell>
      <AuthToaster />
    </>
  );
}
