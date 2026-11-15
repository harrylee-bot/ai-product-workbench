import { describe, expect, it, vi } from "vitest";
const activity = vi.hoisted(() => ({ signal: new AbortController().signal, heartbeat: vi.fn(), cancelled: vi.fn(), attempt: 2 }));
vi.mock("@temporalio/activity", () => ({ cancelled: activity.cancelled, cancellationSignal: () => activity.signal, heartbeat: activity.heartbeat, activityInfo: () => ({ attempt: activity.attempt }) }));
import { createTemporalSdkActivities } from "../src/prototypes/temporal-sdk-activities.js";
import { PrototypeExportCancelledError } from "../src/prototypes/prototype-export-state.js";

describe("versioned prototype Temporal lifecycle adapter", () => {
  it.each([false, true])("heartbeats provider cleanup and stops the timer when settled (failure=%s)", async fails => {
    vi.useFakeTimers();
    activity.heartbeat.mockClear();
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const gate = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const adapted = createTemporalSdkActivities({ preparePrototypeGeneration: vi.fn(), markPlanFailed: vi.fn(() => gate) } as never);
    const operation = adapted.markPlanFailedV2({ planId: "plan", code: "PROTOTYPE_WORKFLOW_CANCELLED", detail: "Cancelled" });
    const settled = operation.then(() => "done", () => "error");
    try {
      await vi.advanceTimersByTimeAsync(35_000);
      expect(activity.heartbeat.mock.calls).toEqual(Array.from({ length: 4 }, () => ["deerflow:cleanup"]));
      if (fails) reject(new Error("provider unavailable")); else resolve();
      expect(await settled).toBe(fails ? "error" : "done");
      await vi.advanceTimersByTimeAsync(35_000);
      expect(activity.heartbeat).toHaveBeenCalledTimes(4);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it("passes the current activity attempt to runtime recovery and forwards heartbeat", async () => {
    const generatePrototype = vi.fn(async (_input, _signal, heartbeat) => { heartbeat("deerflow:stream"); return { title: "Demo", pages: [] }; });
    const adapted = createTemporalSdkActivities({ preparePrototypeGeneration: vi.fn(), generatePrototype } as never);
    const input = { projectId: "p", planId: "plan", revisionId: "rev", prompt: "Make", title: "Demo", createdById: "owner" };
    await adapted.generatePrototypeV3(input);
    expect(generatePrototype).toHaveBeenCalledWith(input, activity.signal, expect.any(Function), { retryCount: 1, retryLimit: 2 });
    expect(activity.heartbeat).toHaveBeenCalledWith("deerflow:stream");
  });
  it("forwards export heartbeat and cancellation through the real SDK adapter", async () => {
    activity.heartbeat.mockClear();
    const persistPrototypeExport = vi.fn(async (_input, heartbeat) => {
      heartbeat("build:load"); heartbeat("storage:committed");
      return { key: "artifact", sha256: "a".repeat(64), byteSize: 1, mediaType: "text/html" };
    });
    const adapter = createTemporalSdkActivities({ preparePrototypeGeneration: vi.fn(), persistPrototypeExport } as never);
    const input = { projectId: "p", exportId: "e", commandId: "prototype_command_test", revisionId: "rev", format: "html" as const };
    await expect(adapter.persistPrototypeExportV3(input)).resolves.toMatchObject({ byteSize: 1 });
    expect(persistPrototypeExport).toHaveBeenCalledWith(input, expect.any(Function), activity.signal);
    expect(activity.heartbeat.mock.calls).toEqual([["export:working"], ["build:load"], ["storage:committed"]]);
  });

  it("waits for durable Temporal cancellation with heartbeats after same-command DB cancellation", async () => {
    vi.useFakeTimers(); activity.heartbeat.mockClear(); activity.cancelled.mockReset();
    let deliverCancellation!: (error: Error) => void;
    activity.cancelled.mockReturnValue(new Promise<never>((_resolve, reject) => { deliverCancellation = reject; }));
    const base = { preparePrototypeGeneration: vi.fn(), persistPrototypeExport: vi.fn().mockRejectedValue(new PrototypeExportCancelledError()) };
    const adapter = createTemporalSdkActivities(base as never);
    let settled = false;
    const operation = adapter.persistPrototypeExportV3({} as never);
    const result = operation.catch(error => { settled = true; return error; });
    try {
      await vi.advanceTimersByTimeAsync(35_000);
      expect(settled).toBe(false);
      expect(activity.cancelled).toHaveBeenCalledOnce();
      expect(base.persistPrototypeExport).toHaveBeenCalledOnce();
      expect(activity.heartbeat.mock.calls).toEqual([["export:working"], ["export:awaiting-cancellation"], ...Array.from({ length: 3 }, () => ["export:working"])]);
      const cancellation = new Error("Temporal cancellation delivered");
      deliverCancellation(cancellation);
      expect(await result).toBe(cancellation);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("does not treat a replaced command as cancellation", async () => {
    activity.cancelled.mockReset();
    const error = new Error("PROTOTYPE_EXPORT_EXECUTION_CHANGED");
    const adapter = createTemporalSdkActivities({ preparePrototypeGeneration: vi.fn(), persistPrototypeExport: vi.fn().mockRejectedValue(error) } as never);
    await expect(adapter.persistPrototypeExportV3({} as never)).rejects.toBe(error);
    expect(activity.cancelled).not.toHaveBeenCalled();
  });

  it.each(["build", "export", "freeze"])("keeps %s heartbeating during slow storage and forwards cancellation", async kind => {
    vi.useFakeTimers(); activity.heartbeat.mockClear();
    let resolve!: (value: unknown) => void;
    const gate = new Promise(resolveGate => { resolve = resolveGate; });
    const operation = vi.fn(() => gate);
    const adapter = createTemporalSdkActivities({ preparePrototypeGeneration: vi.fn(), buildPrototype: operation, persistPrototypeExport: operation, freezePrototypePreview: operation } as never);
    const pending = kind === "build" ? adapter.buildPrototypeV3({} as never) : kind === "export" ? adapter.persistPrototypeExportV3({} as never) : adapter.freezePrototypePreviewV2({} as never);
    try {
      await vi.advanceTimersByTimeAsync(35_000);
      expect(activity.heartbeat).toHaveBeenCalledTimes(4);
      expect(operation.mock.calls[0]!.at(-1)).toBe(activity.signal);
      resolve({}); await pending;
      await vi.advanceTimersByTimeAsync(35_000);
      expect(activity.heartbeat).toHaveBeenCalledTimes(4);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("registers build, preview freeze, share create and share revoke activities", () => {
    const base = {
      preparePrototypeGeneration: vi.fn(),
      generatePrototype: vi.fn(),
      buildPrototype: vi.fn(),
      persistPrototypeRevision: vi.fn(),
      persistPrototypeExport: vi.fn(),
      freezePrototypePreview: vi.fn(),
      createPrototypeShare: vi.fn(),
      revokePrototypeShare: vi.fn(),
      markPlanFailed: vi.fn(),
      markExportFailed: vi.fn(),
      markExportCancelled: vi.fn(),
    } as never;
    const adapted = createTemporalSdkActivities(base);
    expect(Object.keys(adapted).sort()).toEqual([
      "buildPrototypeV3",
      "createPrototypeShareV2",
      "freezePrototypePreviewV2",
      "generatePrototypeV3",
      "markExportCancelledV3",
      "markExportFailedV3",
      "markPlanFailedV2",
      "persistPrototypeExportV3",
      "persistPrototypeRevisionV3",
      "preparePrototypeGenerationV3",
      "revokePrototypeShareV2",
    ].sort());
  });
});
