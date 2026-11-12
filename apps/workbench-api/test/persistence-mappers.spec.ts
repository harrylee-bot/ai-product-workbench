import { mapRunApproval } from "../src/modules/runs/run-approval.mapper.js";
import { publicRunEventPayload, RunEventStore } from "../src/modules/runs/run-event.store.js";
import { mapRun } from "../src/modules/runs/run.mapper.js";
import { RunsService } from "../src/modules/runs/runs.service.js";
import { mapThreadEntry } from "../src/modules/threads/thread.mapper.js";

const now = new Date("2026-07-12T00:00:00.000Z");

describe("persisted JSON mappers", () => {
  it("removes private diagnostics from stored and authorized-stream failure events", async () => {
    const payload = {
      code: "RUNTIME_EXECUTION_FAILED",
      message: "PRIVATE_DIAGNOSTIC_MARKER internal provider response",
      retryable: false,
    };
    const publicPayload = {
      ...payload,
      message: payload.code,
    };
    const run = {
      id: "run_1",
      requestId: "request_1",
      projectId: "project_1",
      threadId: "thread_1",
      traceId: "trace_1",
    };
    const storedEvent = {
      id: "event_1",
      sequence: 1,
      type: "run.failed",
      payload,
      occurredAt: now,
      run,
    };
    const db = {
      runEvent: { findMany: vi.fn().mockResolvedValue([storedEvent]) },
      $queryRaw: vi.fn().mockResolvedValue([{
        runId: run.id,
        requestId: run.requestId,
        projectId: run.projectId,
        threadId: run.threadId,
        traceId: run.traceId,
        status: "failed",
        eventId: storedEvent.id,
        sequence: storedEvent.sequence,
        eventType: storedEvent.type,
        payload,
        occurredAt: now,
      }]),
    };
    const eventStore = new RunEventStore();
    const service = new RunsService(
      db as never,
      {} as never,
      eventStore,
      {} as never,
      {} as never,
      {} as never,
    );

    const listedEvents = await eventStore.listAfter(run.id, 0);
    const streamed = await service.pollAuthorizedEventStream("principal_1", run.id, 0);

    expect(listedEvents[0]?.payload).toEqual(publicPayload);
    expect(streamed?.events[0]?.payload).toEqual(publicPayload);
    expect(JSON.stringify([listedEvents, streamed])).not.toContain("PRIVATE_DIAGNOSTIC_MARKER");
    expect(payload.message).toContain("PRIVATE_DIAGNOSTIC_MARKER");
    expect(publicRunEventPayload("run.started", { attempt: 1 })).toEqual({ attempt: 1 });
  });

  it("restores requested artifact intent from the persisted Run request", () => {
    const persisted = {
      id: "run_1",
      requestId: "request_1",
      projectId: "project_1",
      threadId: "thread_1",
      retryOfRunId: null,
      status: "running" as const,
      modelId: "quality",
      request: {
        prompt: "Create a document and prototype",
        modelId: "quality",
        workflow: "edit",
        targetSurface: "web",
        designStyle: {
          kind: "preset",
          presetId: "workbench.bauhaus",
          version: 1,
          checksum: "a".repeat(64),
        },
        sourceIds: ["source_1"],
        artifactTargets: [
          { artifactId: "artifact_prototype", artifactVersionId: "version_prototype", screenIds: ["screen_main"] },
          { artifactId: "artifact_prd", artifactVersionId: "version_prd", screenIds: [] },
        ],
        requestedArtifactKinds: ["document", "prototype"],
      },
      sourceSnapshots: [{
        id: "run_source_1",
        runId: "run_1",
        projectId: "project_1",
        position: 0,
        sourceId: "source_1",
        kind: "file" as const,
        label: "requirements.pdf",
        checksum: "a".repeat(64),
        descriptor: {
          kind: "file",
          fileAssetId: "file_1",
          originalName: "requirements.pdf",
          mediaType: "application/pdf",
        },
        snapshot: {
          protocol: "workbench.import-source-snapshot.v1",
          sourceRevision: 1,
          checksum: "a".repeat(64),
          blobs: [{
            position: 0,
            blobId: "blob_1",
            role: "primary",
            path: null,
            mediaType: "application/pdf",
            byteSize: 123,
            sha256: "a".repeat(64),
          }],
        },
        createdAt: now,
      }],
      knowledgeReleaseId: null,
      phase: "generating" as const,
      phaseLabel: "Generating",
      progress: 0.5,
      attempt: 1,
      eventSequence: 5,
      cancelRequestedAt: null,
      errorCode: null,
      errorDetail: null,
      errorRetryable: null,
      cancellationReason: null,
      createdAt: now,
      startedAt: now,
      finishedAt: null,
    };

    expect(mapRun(persisted)).toMatchObject({
      workflow: "edit",
      targetSurface: "web",
      designStyle: {
        kind: "preset",
        presetId: "workbench.bauhaus",
        version: 1,
        checksum: "a".repeat(64),
      },
      artifactTargets: [
        { artifactId: "artifact_prototype", artifactVersionId: "version_prototype", screenIds: ["screen_main"] },
        { artifactId: "artifact_prd", artifactVersionId: "version_prd", screenIds: [] },
      ],
      requestedArtifactKinds: ["document", "prototype"],
      retryOfRunId: null,
      phase: "generating",
      phaseLabel: "Generating",
      progress: 0.5,
      attempt: 1,
      lastEventSequence: 5,
      failure: null,
      sources: [{ sourceId: "source_1", snapshot: { blobs: [{ blobId: "blob_1", byteSize: 123 }] } }],
    });
    expect(mapRun({
      ...persisted,
      status: "failed",
      errorCode: "RUNTIME_PROVIDER_CONTENT_FILTERED",
      errorDetail: "PRIVATE_DIAGNOSTIC_MARKER https://internal.example.test/?token=secret",
      errorRetryable: false,
      finishedAt: now,
    }).failure).toEqual({
      code: "RUNTIME_PROVIDER_CONTENT_FILTERED",
      message: "模型服务商拦截了本次输出，任务已停止。",
      retryable: false,
    });
    expect(mapRun({
      ...persisted,
      status: "failed",
      errorCode: "RUNTIME_EXECUTION_FAILED",
      errorDetail: "PRIVATE_DIAGNOSTIC_MARKER https://internal.example.test/?token=secret",
      errorRetryable: false,
      finishedAt: now,
    }).failure).toEqual({
      code: "RUNTIME_EXECUTION_FAILED",
      message: "RUNTIME_EXECUTION_FAILED",
      retryable: false,
    });
    for (const incomplete of [
      { errorCode: "RUNTIME_EXECUTION_FAILED" },
      { errorDetail: "PRIVATE_DIAGNOSTIC_MARKER" },
      { errorRetryable: false },
    ]) {
      expect(() => mapRun({ ...persisted, ...incomplete }))
        .toThrow("Persisted Run failure snapshot is incomplete");
    }
    expect(() => mapRun({
      ...persisted,
      request: { ...persisted.request, providerSecret: "must-not-pass" },
    })).toThrow();
    expect(() => mapRun({
      ...persisted,
      sourceSnapshots: [{ ...persisted.sourceSnapshots[0]!, projectId: "project_2" }],
    })).toThrow();
    expect(() => mapRun({
      ...persisted,
      sourceSnapshots: [{
        ...persisted.sourceSnapshots[0]!,
        snapshot: {
          ...persisted.sourceSnapshots[0]!.snapshot,
          blobs: [{
            ...persisted.sourceSnapshots[0]!.snapshot.blobs[0]!,
            byteSize: Number.MAX_SAFE_INTEGER + 1,
          }],
        },
      }],
    })).toThrow();
  });

  it("rejects unversioned or envelope-mismatched ThreadEntry content", () => {
    const persisted = {
      id: "entry_1",
      threadId: "thread_1",
      sequence: 1,
      role: "assistant" as const,
      kind: "message" as const,
      content: {
        protocol: "workbench.entry.v1",
        type: "assistant.message",
        text: "Done",
      },
      producedByRunId: "run_1",
      createdAt: now,
    };
    expect(mapThreadEntry(persisted).content.type).toBe("assistant.message");
    expect(() => mapThreadEntry({ ...persisted, content: { text: "legacy" } })).toThrow();
    expect(() => mapThreadEntry({ ...persisted, role: "user" })).toThrow();
  });

  it("strictly parses persisted approval options and responses", () => {
    const persisted = {
      id: "approval_1",
      runId: "run_1",
      kind: "confirmation",
      prompt: "Publish?",
      options: [{
        id: "publish",
        label: "Publish",
        description: null,
        value: { action: "publish" },
      }],
      attempt: 1,
      status: "pending" as const,
      response: null,
      decidedById: null,
      decidedAt: null,
      revision: 0,
      createdAt: now,
      updatedAt: now,
    };
    expect(mapRunApproval(persisted).options[0]?.value).toEqual({ action: "publish" });
    expect(() => mapRunApproval({ ...persisted, options: [{ label: "guessed" }] })).toThrow();
  });
});
