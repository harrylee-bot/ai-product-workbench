"use client";
import Link from "next/link";
import { isWorkbenchApiError } from "@/lib/workbench/api";
import { useWorkbenchProjectBootstrap } from "@/lib/workbench/features/projects";
import { StudioWorkspace } from "./workspace";
import { useStudioProjectAccess } from "@/lib/studio/project-access";
import { useWorkbenchAuth } from "@/lib/auth/workbench-auth";
export function StudioProject({ projectId }: { projectId: string }) {
  const { user } = useWorkbenchAuth();
  return <ProjectAccess key={`${user?.id ?? ""}:${projectId}`} projectId={projectId} />;
}
function ProjectAccess({ projectId }: { projectId: string }) {
  const access = useStudioProjectAccess(projectId);
  const query = useWorkbenchProjectBootstrap(projectId, undefined, !access.blocked);
  if (access.blocked) return (
    <main className="studio-loading">
      <h1>正在核验项目访问权限</h1>
      <p role={access.checking ? "status" : "alert"}>{access.checking ? "正在重新读取项目权限…" : access.error}</p>
      <button disabled={access.checking} onClick={() => void access.verify()}>重新核验权限</button>
      <Link href="/">返回项目</Link>
    </main>
  );
  if (query.isPending)
    return (
      <main className="studio-loading" role="status">
        正在加载工作区…
      </main>
    );
  if (
    !query.data ||
    (isWorkbenchApiError(query.error) &&
      [401, 403, 404].includes(query.error.status))
  )
    return (
      <main className="studio-loading">
        <h1>无法打开项目</h1>
        <p>{query.error?.message}</p>
        <button onClick={() => void query.refetch()}>重试</button>
        <Link href="/">返回项目</Link>
      </main>
    );
  const data = query.data.value,
    canEdit = data.access.role !== "viewer";
  return (
    <StudioWorkspace
      key={`${projectId}:${access.generation}`}
      projectId={projectId}
      canEdit={canEdit}
      bootstrap={data}
      composer={{
        projectId,
        bootstrap: data,
        busy: false,
        uploads: [],
        disabled: !canEdit,
      }}
    />
  );
}
