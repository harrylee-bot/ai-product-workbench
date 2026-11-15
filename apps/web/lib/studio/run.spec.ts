import { describe, expect, it } from "vitest";
import type { Run } from "@workbench/workbench-contracts";
import { createRunProjection } from "@/lib/workbench/run/reducer";
import { isActiveRun, projectedRun } from "./run";

const snapshot: Run = {
  id: "run-1",
  requestId: "request-1",
  projectId: "project-1",
  threadId: "thread-1",
  retryOfRunId: null,
  status: "running",
  modelId: "model-1",
  workflow: "generate",
  generationIntent: null,
  targetSurface: "web",
  designStyle: { kind: "automatic" },
  artifactTargets: [],
  requestedArtifactKinds: ["prd"],
  sources: [],
  knowledgeReleaseId: null,
  phase: "generating",
  phaseLabel: "正在生成",
  progress: null,
  attempt: 2,
  lastEventSequence: 10,
  cancelRequestedAt: null,
  failure: null,
  cancellationReason: null,
  createdAt: "2026-11-15T00:00:00.000Z",
  startedAt: "2026-11-15T00:00:00.000Z",
  finishedAt: null,
};

describe("Studio live run state", () => {
  it("uses live waiting-input state while the snapshot remains running", () => {
    const projection = {
      ...createRunProjection(snapshot),
      status: "waiting_input" as const,
      lastSequence: 11,
    };
    expect(projectedRun(snapshot, projection)).toMatchObject({
      status: "waiting_input",
      lastEventSequence: 11,
    });
    expect(snapshot.status).toBe("running");
    expect(isActiveRun(projectedRun(snapshot, projection))).toBe(true);
  });

  it.each([
    { runId: "another-run" },
    { projectId: "another-project" },
    { requestId: "another-request" },
    { threadId: "another-thread" },
    { lastSequence: 9 },
    { attempt: 1 },
  ])("rejects stale or foreign projection %j", (override) => {
    const projection = {
      ...createRunProjection(snapshot),
      status: "waiting_input" as const,
      ...override,
    };
    expect(projectedRun(snapshot, projection)).toBe(snapshot);
  });

  it("keeps a newer authoritative terminal state over incomplete replay", () => {
    const terminal = {
      ...snapshot,
      status: "succeeded" as const,
      lastEventSequence: 20,
    };
    const replay = {
      ...createRunProjection(snapshot),
      status: "waiting_input" as const,
      lastSequence: 15,
    };
    expect(projectedRun(terminal, replay)).toBe(terminal);
    expect(isActiveRun(projectedRun(terminal, replay))).toBe(false);
  });
});
