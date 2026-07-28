import {
  approvalOptionsSchema,
  blobGcJobSchema,
  completeFileUploadRequestSchema,
  createFileUploadRequestSchema,
  fileAssetSchema,
  fileExtractJobSchema,
  fileExtractionSchema,
  fileUploadSessionSchema,
  fileVerifyJobSchema,
  jsonValueSchema,
  knowledgeReleaseBuildJobSchema,
  listUploadPartsResponseSchema,
  multipartEtagSchema,
  projectBootstrapSchema,
  runtimeModelListSchema,
  runApprovalSchema,
  runEventSchema,
  runSchema,
  signUploadPartRequestSchema,
  signUploadPartResponseSchema,
  startRunRequestSchema,
  submitApprovalRequestSchema,
  threadEntryContentSchema,
  threadEntrySchema,
  threadSchema,
} from "@workbench/workbench-contracts";

describe("workbench v1 contracts", () => {
  it("accepts a durable ordered run event", () => {
    const event = runEventSchema.parse({
      protocol: "workbench.run.v1",
      id: "event_1",
      projectId: "project_1",
      threadId: "thread_1",
      runId: "run_1",
      requestId: "request_1",
      sequence: 1,
      occurredAt: "2026-07-12T00:00:00.000Z",
      traceId: "trace_1",
      type: "run.queued",
      payload: { position: null },
    });
    expect(event.sequence).toBe(1);
  });

  it("rejects an unversioned provider packet", () => {
    expect(() => runEventSchema.parse({ type: "text-delta", delta: "hello" })).toThrow();
  });

  it("normalizes optional run arrays", () => {
    expect(startRunRequestSchema.parse({
      prompt: "Build a dashboard",
      modelId: "quality",
      workflow: "generate",
      generationIntent: null,
      targetSurface: "app",
      designStyle: { kind: "automatic" },
    })).toEqual({
      prompt: "Build a dashboard",
      modelId: "quality",
      workflow: "generate",
      generationIntent: null,
      targetSurface: "app",
      designStyle: { kind: "automatic" },
      sourceIds: [],
      artifactTargets: [],
      requestedArtifactKinds: [],
      canvasSnapshot: null,
    });
    expect(startRunRequestSchema.safeParse({
      prompt: "Build a dashboard",
      modelId: "quality",
      workflow: "generate",
      generationIntent: null,
      targetSurface: "app",
      designStyle: { kind: "automatic" },
      sourceIds: ["source_1", "source_1"],
    }).success).toBe(false);
    expect(startRunRequestSchema.safeParse({
      prompt: "Build a dashboard",
      modelId: "quality",
      workflow: "edit",
      targetSurface: "app",
      designStyle: { kind: "automatic" },
      artifactTargets: [
        { artifactId: "artifact_1", artifactVersionId: "version_1", screenIds: [] },
        { artifactId: "artifact_1", artifactVersionId: "version_1", screenIds: [] },
      ],
    }).success).toBe(false);
    expect(startRunRequestSchema.safeParse({
      prompt: "Build a dashboard",
      modelId: "quality",
      workflow: "generate",
      generationIntent: null,
      targetSurface: "app",
      designStyle: { kind: "automatic" },
      artifactTargets: [
        { artifactId: "artifact_1", artifactVersionId: "version_1", screenIds: [] },
      ],
    }).success).toBe(false);
  });

  it.each([
    "生成一份 PRD 和原型",
    "先做原型，再给 PRD",
    "Create a PRD and a prototype",
    "Prototype plus product requirements document",
  ])("rejects mixed PRD and Prototype requests before a Run can be created: %s", (prompt) => {
    const request = {
      prompt,
      modelId: "quality",
      workflow: "generate",
      generationIntent: null,
      targetSurface: "app",
      designStyle: { kind: "automatic" },
      requestedArtifactKinds: ["prd", "prototype"],
    };
    const result = startRunRequestSchema.safeParse(request);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(expect.objectContaining({
        path: ["requestedArtifactKinds"],
        message: "PRD and Prototype/code must be requested in two sequential Runs: complete the PRD Run first",
      }));
    }
  });

  it("requires ordered immutable Run Import Source snapshots", () => {
    const timestamp = "2026-07-12T00:00:00.000Z";
    const source = {
      id: "run_source_1",
      runId: "run_1",
      projectId: "project_1",
      position: 0,
      sourceId: "source_1",
      kind: "file",
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
          byteSize: 42,
          sha256: "a".repeat(64),
        }],
      },
      createdAt: timestamp,
    };
    const run = {
      id: "run_1",
      requestId: "request_1",
      projectId: "project_1",
      threadId: "thread_1",
      retryOfRunId: null,
      status: "queued",
      modelId: "quality",
      workflow: "generate",
      generationIntent: null,
      targetSurface: "app",
      designStyle: { kind: "automatic" },
      artifactTargets: [],
      requestedArtifactKinds: [],
      sources: [source],
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
    expect(runSchema.safeParse({ ...run, retryOfRunId: run.id }).success).toBe(false);
    expect(runSchema.safeParse({
      ...run,
      sources: [{ ...source, position: 1 }],
    }).success).toBe(false);
    expect(runSchema.safeParse({
      ...run,
      sources: [{ ...source, projectId: "project_2" }],
    }).success).toBe(false);
    expect(runSchema.safeParse({
      ...run,
      sources: [{ ...source, storageKey: "private/object" }],
    }).success).toBe(false);
  });

  it("keeps workflow, target surface, and design style separate from the model", () => {
    expect(startRunRequestSchema.safeParse({
      prompt: "Explore a dashboard concept",
      modelId: "quality",
      workflow: "ideate",
      targetSurface: "web",
      designStyle: {
        kind: "preset",
        presetId: "workbench.bauhaus",
        version: 1,
        checksum: "a".repeat(64),
      },
    }).success).toBe(true);
    expect(startRunRequestSchema.safeParse({
      prompt: "Redesign this screen",
      modelId: "quality",
      workflow: "redesign",
      targetSurface: "app",
      designStyle: { kind: "automatic" },
      sourceIds: [],
    }).success).toBe(false);
  });

  it("defines strict, storage-safe file and upload DTOs", () => {
    const timestamp = "2026-07-12T00:00:00.000Z";
    const sha256 = "a".repeat(64);
    const file = {
      id: "file_1",
      projectId: "project_1",
      blobId: "blob_1",
      originalName: "research.pdf",
      declaredMediaType: "application/pdf",
      detectedMediaType: "application/pdf",
      byteSize: 0,
      status: "ready",
      revision: 2,
      sha256,
      failure: null,
      currentExtraction: null,
      latestExtraction: null,
      verifiedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    expect(fileAssetSchema.parse(file)).toEqual(file);
    expect(fileAssetSchema.safeParse({ ...file, storageKey: "tenant/private" }).success).toBe(false);
    expect(fileAssetSchema.safeParse({ ...file, blobId: null }).success).toBe(false);

    const upload = {
      id: "upload_1",
      fileAssetId: "file_1",
      status: "initiated",
      partSize: 8 * 1024 * 1024,
      revision: 1,
      expiresAt: timestamp,
    };
    expect(fileUploadSessionSchema.parse(upload)).toEqual(upload);
    expect(fileUploadSessionSchema.safeParse({ ...upload, providerUploadId: "secret" }).success).toBe(false);
  });

  it("validates file names, MIME values, digests, and exact integer bounds", () => {
    const request = {
      fileName: "requirements.docx",
      declaredMediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      byteSize: 25 * 1024 ** 2,
      sha256: "f".repeat(64),
    };
    expect(createFileUploadRequestSchema.safeParse(request).success).toBe(true);
    expect(createFileUploadRequestSchema.safeParse({ ...request, sha256: undefined }).success).toBe(true);
    expect(createFileUploadRequestSchema.safeParse({ ...request, byteSize: 0 }).success).toBe(false);
    expect(createFileUploadRequestSchema.safeParse({ ...request, fileName: "../secret" }).success).toBe(false);
    expect(createFileUploadRequestSchema.safeParse({ ...request, fileName: "   " }).success).toBe(false);
    expect(createFileUploadRequestSchema.safeParse({ ...request, declaredMediaType: "text/plain; charset=utf-8" }).success).toBe(false);
    expect(createFileUploadRequestSchema.safeParse({ ...request, byteSize: request.byteSize + 1 }).success).toBe(false);
    expect(createFileUploadRequestSchema.safeParse({ ...request, sha256: "F".repeat(64) }).success).toBe(false);
  });

  it("requires extraction status, timestamps, and digest to agree", () => {
    const timestamp = "2026-07-12T00:00:00.000Z";
    const extraction = {
      id: "extraction_1",
      fileAssetId: "file_1",
      attempt: 1,
      status: "ready",
      parser: "docling",
      parserVersion: "2.0.0",
      outputSchemaVersion: 1,
      contentSha256: "b".repeat(64),
      failure: null,
      startedAt: timestamp,
      finishedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    expect(fileExtractionSchema.safeParse(extraction).success).toBe(true);
    expect(fileExtractionSchema.safeParse({ ...extraction, contentSha256: null }).success).toBe(false);
    expect(fileExtractionSchema.safeParse({
      ...extraction,
      status: "failed",
      contentSha256: null,
      failure: null,
    }).success).toBe(true);
    expect(fileExtractionSchema.safeParse({
      ...extraction,
      status: "queued",
      contentSha256: null,
      startedAt: timestamp,
      finishedAt: null,
    }).success).toBe(false);
  });

  it("restricts signed upload URLs and headers to non-ambient credentials", () => {
    const response = {
      uploadSessionId: "upload_1",
      partNumber: 1,
      method: "PUT",
      url: "https://uploads.example.com/object?signature=opaque",
      headers: { "content-type": "application/pdf" },
      expiresAt: "2026-07-12T00:00:00.000Z",
    };
    expect(signUploadPartResponseSchema.safeParse(response).success).toBe(true);
    expect(signUploadPartResponseSchema.safeParse({ ...response, url: "not-a-url" }).success).toBe(false);
    expect(signUploadPartResponseSchema.safeParse({ ...response, url: "http://127.0.0.1:9000/object" }).success).toBe(true);
    expect(signUploadPartResponseSchema.safeParse({ ...response, url: "http://uploads.example.com/object" }).success).toBe(false);
    expect(signUploadPartResponseSchema.safeParse({ ...response, url: "https://user@uploads.example.com/object" }).success).toBe(false);
    expect(signUploadPartResponseSchema.safeParse({ ...response, url: "https://uploads.example.com/object#fragment" }).success).toBe(false);
    expect(signUploadPartResponseSchema.safeParse({
      ...response,
      headers: { "x-amz-meta-name": "safe\r\ninjected: true" },
    }).success).toBe(false);
    expect(signUploadPartRequestSchema.safeParse({ contentLength: 5 * 1024 ** 3 }).success).toBe(true);
    expect(signUploadPartRequestSchema.safeParse({ contentLength: 0 }).success).toBe(false);
    expect(signUploadPartRequestSchema.safeParse({ contentLength: 5 * 1024 ** 3 + 1 }).success).toBe(false);
  });

  it("requires strong multipart ETags and unique ascending part numbers", () => {
    const part = (partNumber: number) => ({ partNumber, etag: `"etag-${partNumber}"`, byteSize: 10 });
    expect(multipartEtagSchema.safeParse('"etag-1"').success).toBe(true);
    expect(multipartEtagSchema.safeParse("etag-1").success).toBe(false);
    expect(listUploadPartsResponseSchema.safeParse({ parts: [part(1), part(3)] }).success).toBe(true);
    expect(listUploadPartsResponseSchema.safeParse({ parts: [part(2), part(1)] }).success).toBe(false);
    expect(listUploadPartsResponseSchema.safeParse({ parts: [part(1), part(1)] }).success).toBe(false);
    expect(completeFileUploadRequestSchema.safeParse({
      parts: [part(1), part(3)].map(({ partNumber, etag }) => ({ partNumber, etag })),
      sha256: "c".repeat(64),
    }).success).toBe(true);
    expect(completeFileUploadRequestSchema.safeParse({
      parts: [{ partNumber: 1, etag: '"etag-1"' }],
      sha256: "C".repeat(64),
    }).success).toBe(false);
    expect(completeFileUploadRequestSchema.safeParse({ parts: [] }).success).toBe(false);
  });

  it("keeps file pipeline queue payloads minimal and strict", () => {
    expect(fileVerifyJobSchema.parse({ uploadSessionId: "upload_1" })).toEqual({ uploadSessionId: "upload_1" });
    expect(fileExtractJobSchema.parse({ extractionId: "extract_1" })).toEqual({ extractionId: "extract_1" });
    expect(knowledgeReleaseBuildJobSchema.parse({ releaseId: "release_1" })).toEqual({ releaseId: "release_1" });
    expect(blobGcJobSchema.parse({ blobId: "blob_1" })).toEqual({ blobId: "blob_1" });
    expect(fileVerifyJobSchema.safeParse({ uploadSessionId: "upload_1", storageKey: "private" }).success).toBe(false);
  });

  it("requires a complete project bootstrap snapshot", () => {
    expect(projectBootstrapSchema.safeParse({ project: {} }).success).toBe(false);
  });

  it("requires explicit Thread lifecycle and approval decision state", () => {
    expect(threadSchema.parse({
      id: "thread_1",
      projectId: "project_1",
      title: "Main",
      status: "active",
      revision: 0,
      createdAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:00.000Z",
    }).status).toBe("active");
    expect(runApprovalSchema.safeParse({ id: "approval_1" }).success).toBe(false);
    expect(submitApprovalRequestSchema.safeParse({ decision: "submit" }).success).toBe(false);
    expect(submitApprovalRequestSchema.safeParse({ decision: "submit", value: "answer" }).success).toBe(true);
    expect(submitApprovalRequestSchema.safeParse({ decision: "submit", value: null }).success).toBe(true);
    expect(submitApprovalRequestSchema.safeParse({ decision: "approve", value: undefined }).success).toBe(true);
    expect(submitApprovalRequestSchema.safeParse({ decision: "approve", value: Number.NaN }).success).toBe(false);
    expect(jsonValueSchema.safeParse({ nested: [true, null, 42] }).success).toBe(true);
    expect(jsonValueSchema.safeParse(() => "not JSON").success).toBe(false);
  });

  it("uses stable approval options with unique ids and JSON values", () => {
    const option = {
      id: "publish",
      label: "Publish",
      description: "Publish the generated result",
      value: { action: "publish" },
    };
    expect(approvalOptionsSchema.parse([option])).toEqual([option]);
    expect(approvalOptionsSchema.safeParse([option, option]).success).toBe(false);
    expect(approvalOptionsSchema.safeParse([{ ...option, value: undefined }]).success).toBe(false);
  });

  it("defines versioned ThreadEntry content and enforces its role/kind envelope", () => {
    const contents = [
      {
        protocol: "workbench.entry.v1",
        type: "user.prompt",
        text: "Build a dashboard",
        sourceIds: [],
      },
      { protocol: "workbench.entry.v1", type: "assistant.message", text: "Done" },
      {
        protocol: "workbench.entry.v1",
        type: "activity.status",
        activityId: "activity_1",
        status: "running",
        label: "Generating",
        detail: null,
      },
      {
        protocol: "workbench.entry.v1",
        type: "approval.request",
        approvalId: "approval_1",
        kind: "confirmation",
        prompt: "Publish?",
        options: [],
        attempt: 1,
      },
    ];
    for (const content of contents) expect(threadEntryContentSchema.safeParse(content).success).toBe(true);

    const base = {
      id: "entry_1",
      threadId: "thread_1",
      sequence: 1,
      role: "user",
      kind: "message",
      content: contents[0],
      producedByRunId: null,
      createdAt: "2026-07-12T00:00:00.000Z",
    };
    expect(threadEntrySchema.safeParse(base).success).toBe(true);
    expect(threadEntrySchema.safeParse({ ...base, role: "assistant" }).success).toBe(false);
    expect(threadEntryContentSchema.safeParse({ text: "legacy" }).success).toBe(false);
  });

  it("exposes only a strict, uniquely keyed runtime model catalog", () => {
    const catalog = {
      items: [{
        id: "quality",
        displayName: "Quality",
        description: null,
        supportedWorkflows: ["generate", "redesign", "ideate", "edit"],
        supportsThinking: true,
        supportsReasoningEffort: false,
      }],
    };
    expect(runtimeModelListSchema.parse(catalog)).toEqual(catalog);
    expect(runtimeModelListSchema.safeParse({ ...catalog, token: "secret" }).success).toBe(false);
    expect(runtimeModelListSchema.safeParse({ items: [catalog.items[0], catalog.items[0]] }).success)
      .toBe(false);
  });
});
