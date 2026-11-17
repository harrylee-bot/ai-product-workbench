"use client";
import Link from "next/link";
import { isWorkbenchApiError } from "@/lib/workbench/api";
import { useWorkbenchProjectBootstrap } from "@/lib/workbench/features/projects";
import { usePlanSubmission } from "@/lib/studio/use-plan-submission";
import { StudioWorkspace } from "./workspace";
export function StudioProject({ projectId }: { projectId: string }) {
  const query = useWorkbenchProjectBootstrap(projectId),
    submission = usePlanSubmission(projectId);
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
      key={projectId}
      projectId={projectId}
      canEdit={canEdit}
      bootstrap={data}
      submissionNotice={submission.recoveryNotice}
      recoveryTitle={submission.recoveryTitle}
      onRecoverSubmission={submission.recover}
      composer={{
        projectId,
        bootstrap: data,
        busy: submission.pending,
        uploads: submission.uploads,
        disabled: !canEdit,
      }}
    />
  );
}
