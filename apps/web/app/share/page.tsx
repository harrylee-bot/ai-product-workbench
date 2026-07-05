import { redirect } from "next/navigation";

export default async function SharePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const token = (await searchParams).token?.trim();
  if (token) redirect(`/share/${encodeURIComponent(token)}`);
  return (
    <div className="flex min-h-screen items-center justify-center">
      <p className="text-muted-foreground text-sm">无效的分享链接</p>
    </div>
  );
}
