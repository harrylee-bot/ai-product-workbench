import type { ExportJob } from "@workbench/workbench-contracts";

export function needsExportPolling(job?: ExportJob) {
  return job?.status === "queued" || job?.status === "running";
}

/** Pick the newest export whose progress or result is useful after refresh. */
export function selectLatestRestorableExport(
  jobs: readonly ExportJob[] | undefined,
): ExportJob | null {
  const candidates = (jobs ?? []).filter((job) => (
    needsExportPolling(job) || job.status === "succeeded"
  ));
  return latestExport(candidates);
}

function latestExport(jobs: readonly ExportJob[]): ExportJob | null {
  return [...jobs].sort((left, right) => {
    const updatedDifference = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    if (updatedDifference !== 0) return updatedDifference;
    const createdDifference = Date.parse(right.createdAt) - Date.parse(left.createdAt);
    if (createdDifference !== 0) return createdDifference;
    return right.id.localeCompare(left.id);
  })[0] ?? null;
}
