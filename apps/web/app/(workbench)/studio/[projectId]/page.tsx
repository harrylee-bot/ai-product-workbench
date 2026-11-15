import { StudioProject } from "@/components/studio/project-route";
export default async function Page({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <StudioProject key={projectId} projectId={projectId} />;
}
