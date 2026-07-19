import type {
  FileAsset,
  FileStatus,
} from "@workbench/workbench-contracts";

export const DEFAULT_FILE_POLL_INTERVAL_MS = 1_000;

export type WorkbenchFilePollingOptions = {
  enabled?: boolean;
  intervalMs?: number;
};

export type FileListOptions = {
  cursor?: string;
  limit?: number;
  status?: Exclude<FileStatus, "deleted">;
};

export function needsWorkbenchFilePolling(file: FileAsset): boolean {
  if (file.status === "uploading" || file.status === "verifying") return true;
  return file.latestExtraction?.status === "queued"
    || file.latestExtraction?.status === "running";
}

export function workbenchFileRefetchInterval(
  file: FileAsset | undefined,
  options: WorkbenchFilePollingOptions = {},
): number | false {
  if (options.enabled === false || !file || !needsWorkbenchFilePolling(file)) return false;
  const intervalMs = options.intervalMs ?? DEFAULT_FILE_POLL_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs < 100) {
    throw new Error("File polling interval must be at least 100ms");
  }
  return intervalMs;
}
