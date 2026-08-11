import type { Run } from "@workbench/workbench-contracts";

export function workbenchRunIsActive(status: Run["status"] | null): boolean {
  return status === "queued"
    || status === "running"
    || status === "waiting_input"
    || status === "cancelling";
}

/**
 * Returns whether the run is actively producing visual output.
 *
 * `waiting_input` and `cancelling` remain active for controls and permissions,
 * but should not keep generation-only canvas effects mounted.
 */
export function workbenchRunIsVisuallyGenerating(status: Run["status"] | null): boolean {
  return status === "queued" || status === "running";
}
