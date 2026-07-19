import type { Run } from "@workbench/workbench-contracts";

export function workbenchRunIsActive(status: Run["status"] | null): boolean {
  return status === "queued"
    || status === "running"
    || status === "waiting_input"
    || status === "cancelling";
}
