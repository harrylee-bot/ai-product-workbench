import { beforeEach, describe, expect, it, vi } from "vitest";
const activities = vi.hoisted(() => ({ persistPrototypeExportV3: vi.fn(), markExportFailedV3: vi.fn(), markExportCancelledV3: vi.fn() }));
vi.mock("@temporalio/workflow", () => ({
  ActivityCancellationType: { WAIT_CANCELLATION_COMPLETED: "WAIT_CANCELLATION_COMPLETED" },
  CancellationScope: { nonCancellable: (action: () => Promise<unknown>) => action() },
  isCancellation: (error: unknown) => error instanceof Error && error.name === "CancelledFailure",
  proxyActivities: () => activities,
}));
import { visualPrototypeExportV3 } from "../src/prototypes/temporal-sdk-workflows.js";

describe("export workflow execution identity", () => {
  beforeEach(() => vi.clearAllMocks());
  it.each([false, true])("carries the same command identity into failure and cancellation cleanup (cancel=%s)", async cancelled => {
    const error = new Error("activity failed"); if (cancelled) error.name = "CancelledFailure";
    activities.persistPrototypeExportV3.mockRejectedValueOnce(error);
    const input = { projectId: "project", exportId: "export", revisionId: "revision", format: "html" as const, commandId: "prototype_command_a" };
    await expect(visualPrototypeExportV3(input)).rejects.toBe(error);
    expect(activities.persistPrototypeExportV3).toHaveBeenCalledWith(input);
    const cleanup = cancelled ? activities.markExportCancelledV3 : activities.markExportFailedV3;
    expect(cleanup).toHaveBeenCalledWith(expect.objectContaining({ projectId: input.projectId, exportId: input.exportId, commandId: input.commandId }));
    expect(cancelled ? activities.markExportFailedV3 : activities.markExportCancelledV3).not.toHaveBeenCalled();
  });
});
