import { describe, expect, it } from "vitest";

import { workbenchHttpRoutes } from "../src/http-routes.js";
import {
  runEventSchema,
  runGenerationStageSchema,
  runPrototypePatchCheckpointSchema,
  runSchema,
  startRunRequestSchema,
} from "../src/runs.js";
import { prototypeDocumentFixture } from "./prototype-fixture.js";

const request = {
  prompt: "Edit the selected prototype",
  modelId: "quality",
  workflow: "edit" as const,
  targetSurface: "web" as const,
  designStyle: { kind: "automatic" as const },
};

describe("Run target ArtifactVersion contracts", () => {
  it("rejects mixed PRD and Prototype/code work before a Run is created", () => {
    for (const requestedArtifactKinds of [
      ["prd", "prototype"],
      ["prd", "code"],
    ] as const) {
      const parsed = startRunRequestSchema.safeParse({
        ...request,
        workflow: "generate",
        requestedArtifactKinds,
      });
      expect(parsed.success).toBe(false);
      if (parsed.success) throw new Error("Expected mixed PRD work to be rejected");
      expect(parsed.error.issues).toContainEqual(expect.objectContaining({
        path: ["requestedArtifactKinds"],
        message: expect.stringContaining("two sequential Runs"),
      }));
    }
  });

  it("defaults ordinary Generate targets to an empty immutable-reference list", () => {
    expect(startRunRequestSchema.parse({ ...request, workflow: "generate" })).toMatchObject({
      artifactTargets: [],
      generationIntent: null,
    });
    expect(startRunRequestSchema.safeParse(request).success).toBe(false);
  });

  it("accepts explicit Generate Prototype screen sources and rejects ambiguous Generate targets", () => {
    const source = {
      artifactId: "artifact_target",
      artifactVersionId: "version_target",
      screenIds: ["screen_home"],
    };
    expect(startRunRequestSchema.safeParse({
      ...request,
      workflow: "generate",
      generationIntent: "interactive-prototype",
      artifactTargets: [source],
      requestedArtifactKinds: ["prototype"],
    }).success).toBe(true);
    expect(startRunRequestSchema.safeParse({
      ...request,
      workflow: "generate",
      generationIntent: "interactive-prototype",
      artifactTargets: [source],
      requestedArtifactKinds: ["prd"],
    }).success).toBe(false);
    expect(startRunRequestSchema.safeParse({
      ...request,
      workflow: "generate",
      generationIntent: "interactive-prototype",
      artifactTargets: [{ ...source, screenIds: [] }],
      requestedArtifactKinds: ["prototype"],
    }).success).toBe(false);
    expect(startRunRequestSchema.safeParse({
      ...request,
      workflow: "generate",
      artifactTargets: [source],
      requestedArtifactKinds: ["prototype"],
    }).success).toBe(false);
    expect(startRunRequestSchema.safeParse({
      ...request,
      workflow: "generate",
      generationIntent: "followup-design",
    }).success).toBe(false);
  });

  it("forbids Artifact targets for Redesign and Ideate", () => {
    const target = {
      artifactId: "artifact_target",
      artifactVersionId: "version_target",
      screenIds: ["screen_home"],
    };
    expect(startRunRequestSchema.safeParse({
      ...request,
      workflow: "redesign",
      sourceIds: ["source_file"],
      artifactTargets: [target],
    }).success).toBe(false);
    expect(startRunRequestSchema.safeParse({
      ...request,
      workflow: "ideate",
      artifactTargets: [target],
    }).success).toBe(false);
  });

  it("applies the same Generate Prototype semantics to returned Run snapshots", () => {
    const timestamp = "2026-07-18T00:00:00.000Z";
    const run = {
      id: "run_generate_prototype",
      requestId: "request_generate_prototype",
      projectId: "project_1",
      threadId: "thread_1",
      retryOfRunId: null,
      status: "queued",
      modelId: "quality",
      workflow: "generate",
      generationIntent: "interactive-prototype",
      targetSurface: "web",
      designStyle: { kind: "automatic" },
      artifactTargets: [{
        artifactId: "artifact_source",
        artifactVersionId: "version_source",
        screenIds: ["screen_home"],
      }],
      requestedArtifactKinds: ["prototype"],
      sources: [],
      knowledgeReleaseId: null,
      phase: null,
      phaseLabel: null,
      progress: null,
      attempt: 0,
      lastEventSequence: 0,
      cancelRequestedAt: null,
      failure: null,
      cancellationReason: null,
      createdAt: timestamp,
      startedAt: null,
      finishedAt: null,
    };
    expect(runSchema.safeParse(run).success).toBe(true);
    expect(runSchema.safeParse({ ...run, generationIntent: null }).success).toBe(false);
    expect(runSchema.safeParse({ ...run, requestedArtifactKinds: ["prd"] }).success).toBe(false);
    expect(runSchema.safeParse({
      ...run,
      artifactTargets: [{ ...run.artifactTargets[0], screenIds: [] }],
    }).success).toBe(false);
  });

  it("rejects a returned Run whose selected sources materialize more than fifty blobs", () => {
    const timestamp = "2026-07-18T00:00:00.000Z";
    const source = (sourceIndex: number, blobCount: number) => ({
      id: `snapshot_${sourceIndex}`,
      runId: "run_source_limit",
      projectId: "project_1",
      position: sourceIndex,
      sourceId: `source_${sourceIndex}`,
      kind: "file" as const,
      label: `source-${sourceIndex}.txt`,
      checksum: "a".repeat(64),
      descriptor: {
        kind: "file" as const,
        fileAssetId: `file_${sourceIndex}`,
        originalName: `source-${sourceIndex}.txt`,
        mediaType: "text/plain",
      },
      snapshot: {
        protocol: "workbench.import-source-snapshot.v1" as const,
        sourceRevision: 1,
        checksum: "a".repeat(64),
        blobs: Array.from({ length: blobCount }, (_, blobIndex) => ({
          position: blobIndex,
          blobId: `blob_${sourceIndex}_${blobIndex}`,
          role: "source",
          path: `source-${sourceIndex}-${blobIndex}.txt`,
          mediaType: "text/plain",
          byteSize: 1,
          sha256: "a".repeat(64),
        })),
      },
      createdAt: timestamp,
    });
    const run = {
      id: "run_source_limit",
      requestId: "request_source_limit",
      projectId: "project_1",
      threadId: "thread_1",
      retryOfRunId: null,
      status: "queued",
      modelId: "quality",
      workflow: "generate",
      generationIntent: null,
      targetSurface: "web",
      designStyle: { kind: "automatic" },
      artifactTargets: [],
      requestedArtifactKinds: [],
      sources: [source(0, 25), source(1, 25)],
      knowledgeReleaseId: null,
      phase: null,
      phaseLabel: null,
      progress: null,
      attempt: 0,
      lastEventSequence: 0,
      cancelRequestedAt: null,
      failure: null,
      cancellationReason: null,
      createdAt: timestamp,
      startedAt: null,
      finishedAt: null,
    };

    expect(runSchema.safeParse(run).success).toBe(true);
    expect(runSchema.safeParse({
      ...run,
      sources: [source(0, 25), source(1, 26)],
    }).success).toBe(false);
  });

  it("keeps target order while rejecting duplicate versions and more than twelve selections", () => {
    const artifactTargets = [
      { artifactId: "artifact_second", artifactVersionId: "version_second", screenIds: ["screen_b", "screen_a"] },
      { artifactId: "artifact_first", artifactVersionId: "version_first", screenIds: [] },
    ];
    expect(startRunRequestSchema.parse({
      ...request,
      artifactTargets,
    }).artifactTargets).toEqual(artifactTargets);

    expect(startRunRequestSchema.safeParse({
      ...request,
      artifactTargets: [
        { artifactId: "artifact_same", artifactVersionId: "version_same", screenIds: [] },
        { artifactId: "artifact_same", artifactVersionId: "version_same", screenIds: [] },
      ],
    }).success).toBe(false);
    expect(startRunRequestSchema.safeParse({
      ...request,
      artifactTargets: [{
        artifactId: "artifact_many",
        artifactVersionId: "version_many",
        screenIds: Array.from({ length: 13 }, (_, index) => `screen_${index}`),
      }],
    }).success).toBe(false);
  });
});

describe("Run creation route ownership", () => {
  it("creates Runs only through durable SubmissionIntent submission", () => {
    const routes = workbenchHttpRoutes.map((route) => (
      `${route.method} ${route.path} ${route.operationId}`
    ));

    expect(routes).not.toContain("post /threads/{threadId}/runs startRun");
    expect(routes).toContain(
      "post /threads/{threadId}/submission-intents createSubmissionIntent",
    );
    expect(routes).toContain(
      "post /submission-intents/{intentId}/submit submitSubmissionIntent",
    );
  });
});

describe("Run generation stage contract", () => {
  it("accepts only the evidence-backed generation stages", () => {
    const stages = [
      "thinking",
      "collecting-prd-context",
      "structuring-prd",
      "drafting-prd",
      "validating-prd",
      "design-system",
      "mapping-components",
      "creating-flows",
      "generating-ui",
      "screen-streaming",
      "summarizing",
      "screen-stable",
    ];

    expect(stages.map((stage) => runGenerationStageSchema.parse(stage))).toEqual(stages);
    expect(runGenerationStageSchema.safeParse("complete").success).toBe(false);
    expect(runGenerationStageSchema.safeParse("generating").success).toBe(false);
  });

  it("binds each generation stage event to a positive Runtime attempt", () => {
    const generationStageEvent = {
      protocol: "workbench.run.v1",
      id: "event-stage-1",
      projectId: "project-1",
      threadId: "thread-1",
      runId: "run-1",
      requestId: "request-1",
      sequence: 2,
      occurredAt: "2026-07-17T00:00:00.000Z",
      traceId: "trace-1",
      type: "run.generation.stage.changed",
      payload: { attempt: 1, stage: "design-system" },
    };

    expect(runEventSchema.parse(generationStageEvent)).toEqual(generationStageEvent);
    expect(runEventSchema.safeParse({
      ...generationStageEvent,
      payload: { ...generationStageEvent.payload, attempt: 0 },
    }).success).toBe(false);
    expect(runEventSchema.safeParse({
      ...generationStageEvent,
      payload: { ...generationStageEvent.payload, stage: "complete" },
    }).success).toBe(false);
  });
});

describe("Artifact draft Run event contract", () => {
  const draftEvent = {
    protocol: "workbench.run.v1",
    id: "event-draft-1",
    projectId: "project-1",
    threadId: "thread-1",
    runId: "run-1",
    requestId: "request-1",
    sequence: 3,
    occurredAt: "2026-07-17T00:00:00.000Z",
    traceId: "trace-1",
    type: "artifact.draft.created",
    payload: {
      attempt: 1,
      artifactIndex: 0,
      artifactId: "artifact-draft-1",
      artifactVersionId: "version-draft-1",
      kind: "prototype",
      checksum: "a".repeat(64),
      draftChecksum: "b".repeat(64),
      screens: [{
        id: "screen-home",
        name: "Home",
        route: "/home",
        viewport: { width: 1440, height: 900 },
        revision: 0,
        checksum: "c".repeat(64),
      }],
    },
  };

  it("accepts a strict prototype draft summary with unique screens", () => {
    expect(runEventSchema.parse(draftEvent)).toEqual(draftEvent);
    expect(runEventSchema.safeParse({
      ...draftEvent,
      payload: { ...draftEvent.payload, unexpected: true },
    }).success).toBe(false);
    expect(runEventSchema.safeParse({
      ...draftEvent,
      payload: { ...draftEvent.payload, artifactIndex: -1 },
    }).success).toBe(false);
    expect(runEventSchema.safeParse({
      ...draftEvent,
      payload: {
        ...draftEvent.payload,
        screens: draftEvent.payload.screens.map(({ revision: _revision, ...screen }) => screen),
      },
    }).success).toBe(false);
  });

  it("requires prototype screens to be non-empty and uniquely identified", () => {
    expect(runEventSchema.safeParse({
      ...draftEvent,
      payload: { ...draftEvent.payload, screens: [] },
    }).success).toBe(false);
    expect(runEventSchema.safeParse({
      ...draftEvent,
      payload: {
        ...draftEvent.payload,
        screens: [draftEvent.payload.screens[0], draftEvent.payload.screens[0]],
      },
    }).success).toBe(false);
  });

  it("forbids screen summaries on non-prototype drafts", () => {
    expect(runEventSchema.safeParse({
      ...draftEvent,
      payload: { ...draftEvent.payload, kind: "document" },
    }).success).toBe(false);
    expect(runEventSchema.safeParse({
      ...draftEvent,
      payload: { ...draftEvent.payload, kind: "document", screens: [] },
    }).success).toBe(true);
  });
});

describe("Prototype patch Run transport contracts", () => {
  const eventBase = {
    protocol: "workbench.run.v1" as const,
    id: "event-patch-1",
    projectId: "project-1",
    threadId: "thread-1",
    runId: "run-1",
    requestId: "request-1",
    sequence: 4,
    occurredAt: "2026-07-17T00:00:00.000Z",
    traceId: "trace-1",
  };
  const payload = {
    attempt: 1,
    runtimeAttemptId: "runtime-attempt-1",
    artifactIndex: 0,
    artifactId: "artifact-1",
    artifactVersionId: "version-1",
    screenId: "screen-a",
    sourceEventId: "tool-call.opaque:1",
    requestSha256: "f".repeat(64),
    baseRevision: 0,
    nextRevision: 1,
    operations: [{ kind: "remove_node" as const, nodeId: "node-a" }],
    resultingChecksum: "a".repeat(64),
  };

  it("accepts a strict created event with one exact screen revision step", () => {
    const event = { ...eventBase, type: "artifact.prototype.patch.created" as const, payload };
    expect(runEventSchema.parse(event)).toEqual(event);
    expect(runEventSchema.safeParse({
      ...event,
      payload: { ...payload, nextRevision: 2 },
    }).success).toBe(false);
    expect(runEventSchema.safeParse({
      ...event,
      payload: { ...payload, artifactIndex: 20 },
    }).success).toBe(false);
  });

  it("publishes only a bounded degraded reason without internal error detail", () => {
    const degraded = {
      ...eventBase,
      id: "event-degraded-1",
      type: "artifact.prototype.patch.degraded" as const,
      payload: {
        attempt: 1,
        runtimeAttemptId: "runtime-attempt-1",
        artifactIndex: 0,
        artifactId: "artifact-1",
        artifactVersionId: "version-1",
        screenId: "screen-a",
        sourceEventId: "tool-call.opaque:1",
        revision: 0,
        reason: "checksum_mismatch" as const,
        requestSha256: payload.requestSha256,
        baseRevision: payload.baseRevision,
        nextRevision: payload.nextRevision,
        operations: payload.operations,
        resultingChecksum: payload.resultingChecksum,
      },
    };
    expect(runEventSchema.parse(degraded)).toEqual(degraded);
    expect(runEventSchema.safeParse({
      ...degraded,
      payload: { ...degraded.payload, message: "database internals" },
    }).success).toBe(false);
    expect(runEventSchema.safeParse({
      ...degraded,
      payload: { ...degraded.payload, artifactIndex: 20 },
    }).success).toBe(false);
  });

  it("validates the Run-scoped authoritative checkpoint and route", () => {
    const document = prototypeDocumentFixture();
    const checkpoint = {
      protocol: "workbench.prototype-patch-checkpoint.v1" as const,
      projectId: "project-1",
      runId: "run-1",
      requestId: "request-1",
      attempt: 1,
      runtimeAttemptId: "runtime-attempt-1",
      artifactIndex: 0,
      artifactId: "artifact-1",
      artifactVersionId: "version-1",
      status: "staging" as const,
      document,
      documentChecksum: "b".repeat(64),
      screens: [{ screenId: "screen-a", revision: 1, checksum: "c".repeat(64) }],
      lastSequence: 4,
    };
    expect(runPrototypePatchCheckpointSchema.parse(checkpoint)).toEqual(checkpoint);
    expect(runPrototypePatchCheckpointSchema.safeParse({
      ...checkpoint,
      screens: [{ screenId: "screen-missing", revision: 1, checksum: "c".repeat(64) }],
    }).success).toBe(false);
    expect(runPrototypePatchCheckpointSchema.safeParse({ ...checkpoint, artifactIndex: 20 }).success)
      .toBe(false);

    const route = workbenchHttpRoutes.find((candidate) => (
      candidate.operationId === "getRunPrototypePatchCheckpoint"
    ));
    expect(route).toMatchObject({
      method: "get",
      path: "/runs/{runId}/artifact-drafts/{artifactVersionId}/checkpoint",
    });
    expect(route?.query?.safeParse({ screenId: "screen-a" }).success).toBe(true);
    expect(route?.query?.safeParse({ screenId: "#selector" }).success).toBe(false);
  });
});
