import {
  createFileUploadRequestSchema,
  createSubmissionIntentRequestSchema,
  currentSubmissionIntentSchema,
  submissionIntentSchema,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

const automaticRequest = {
  prompt: "Build a product dashboard",
  modelId: "quality",
  workflow: "generate" as const,
  targetSurface: "web" as const,
  designStyle: { kind: "automatic" as const },
};

describe("SubmissionIntent contracts", () => {
  it("rejects a source-free generic PRD request before generation can invent scope", () => {
    const genericRequest = {
      ...automaticRequest,
      prompt: "帮我写个需求文档",
      requestedArtifactKinds: ["prd" as const],
    };
    for (const prompt of [
      "帮我写个需求文档",
      "麻烦帮忙出一份 PRD",
      "我想要一个产品需求说明书",
      "Please draft a product requirements document",
    ]) {
      const result = createSubmissionIntentRequestSchema.safeParse({
        request: { ...genericRequest, prompt },
        attachments: [],
      });

      expect(result.success, prompt).toBe(false);
      if (result.success) throw new Error("Expected generic PRD input to be rejected");
      expect(result.error.issues).toContainEqual(expect.objectContaining({
        path: ["request", "prompt"],
        message: expect.stringContaining("业务功能、目标用户和核心变化"),
      }));
    }

    expect(createSubmissionIntentRequestSchema.safeParse({
      request: { ...genericRequest, prompt: "为订单状态通知设置编写需求文档" },
      attachments: [],
    }).success).toBe(true);
    expect(createSubmissionIntentRequestSchema.safeParse({
      request: genericRequest,
      attachments: [{ kind: "existing", fileAssetId: "file_requirement_source" }],
    }).success).toBe(true);
  });

  it("derives the durable Run request with canonical sourceIds", () => {
    expect(createSubmissionIntentRequestSchema.parse({
      request: automaticRequest,
      attachments: [],
    })).toEqual({
      request: {
        ...automaticRequest,
        sourceIds: [],
        artifactTargets: [],
        generationIntent: null,
        requestedArtifactKinds: [],
        canvasSnapshot: null,
      },
      attachments: [],
    });
    expect(createSubmissionIntentRequestSchema.safeParse({
      request: { ...automaticRequest, attachmentIds: ["file_1"] },
      attachments: [],
    }).success).toBe(false);
    expect(createSubmissionIntentRequestSchema.safeParse({
      request: { ...automaticRequest, sourceIds: ["source_1", "source_1"] },
      attachments: [],
    }).success).toBe(false);
  });

  it("revalidates workflow rules against durable attachment slots", () => {
    const redesign = { ...automaticRequest, workflow: "redesign" as const };
    expect(createSubmissionIntentRequestSchema.safeParse({
      request: redesign,
      attachments: [],
    }).success).toBe(false);
    expect(createSubmissionIntentRequestSchema.safeParse({
      request: redesign,
      attachments: [{
        kind: "upload",
        clientFingerprint: "slot:%E4%B8%AD%E6%96%87 name:1",
        fileName: "中文 需求稿.pdf",
        declaredMediaType: "application/pdf",
        byteSize: 42,
        lastModified: 1_786_771_200_000,
      }],
    }).success).toBe(true);
  });

  it("shares Generate Prototype target semantics without duplicate issues", () => {
    const ambiguous = createSubmissionIntentRequestSchema.safeParse({
      request: {
        ...automaticRequest,
        generationIntent: null,
        artifactTargets: [{
          artifactId: "artifact_source",
          artifactVersionId: "version_source",
          screenIds: [],
        }],
      },
      attachments: [],
    });
    expect(ambiguous.success).toBe(false);
    if (ambiguous.success) throw new Error("Expected Generate target validation to fail");
    expect(ambiguous.error.issues.map((issue) => issue.path)).toEqual([
      ["request", "generationIntent"],
      ["request", "requestedArtifactKinds"],
      ["request", "artifactTargets", 0, "screenIds"],
    ]);

    expect(createSubmissionIntentRequestSchema.safeParse({
      request: {
        ...automaticRequest,
        generationIntent: "interactive-prototype",
        artifactTargets: [{
          artifactId: "artifact_source",
          artifactVersionId: "version_source",
          screenIds: ["screen_home"],
        }],
        requestedArtifactKinds: ["prototype"],
      },
      attachments: [],
    }).success).toBe(true);
    expect(createSubmissionIntentRequestSchema.safeParse({
      request: {
        ...automaticRequest,
        generationIntent: "followup-design",
        artifactTargets: [{
          artifactId: "artifact_source",
          artifactVersionId: "version_source",
          screenIds: ["screen_home"],
        }],
        requestedArtifactKinds: ["prototype"],
      },
      attachments: [],
    }).success).toBe(true);
  });

  it("requires unique existing ids and opaque upload slot fingerprints", () => {
    expect(createSubmissionIntentRequestSchema.safeParse({
      request: automaticRequest,
      attachments: [
        { kind: "existing", fileAssetId: "file_1" },
        { kind: "existing", fileAssetId: "file_1" },
      ],
    }).success).toBe(false);
    expect(createSubmissionIntentRequestSchema.safeParse({
      request: automaticRequest,
      attachments: [
        {
          kind: "upload",
          clientFingerprint: "stable slot with spaces % encoded",
          fileName: "A file.pdf",
          declaredMediaType: "application/pdf",
          byteSize: 1,
          lastModified: 0,
        },
        {
          kind: "upload",
          clientFingerprint: "stable slot with spaces % encoded",
          fileName: "B file.pdf",
          declaredMediaType: "application/pdf",
          byteSize: 1,
          lastModified: 0,
        },
      ],
    }).success).toBe(false);
  });

  it("binds a file-upload request through a strict first-class slot reference", () => {
    const request = {
      fileName: "中文 原型图.png",
      declaredMediaType: "image/png",
      byteSize: 1_024,
      submissionIntent: {
        submissionIntentId: "intent_1",
        attachmentPosition: 2,
        clientFingerprint: "slot:%E4%B8%AD%E6%96%87 file:2",
      },
    };
    expect(createFileUploadRequestSchema.parse(request)).toEqual(request);
    expect(createFileUploadRequestSchema.safeParse({
      ...request,
      submissionIntent: { ...request.submissionIntent, checkpointFingerprint: "uppy-value" },
    }).success).toBe(false);
  });

  it("uses an explicit null current item and enforces terminal lifecycle fields", () => {
    expect(currentSubmissionIntentSchema.parse({ item: null })).toEqual({ item: null });
    const timestamp = "2026-07-15T00:00:00.000Z";
    const pending = {
      id: "intent_1",
      projectId: "project_1",
      threadId: "thread_1",
      status: "pending",
      request: { ...automaticRequest, artifactTargets: [], requestedArtifactKinds: [] },
      attachments: [],
      runId: null,
      lastFailure: null,
      revision: 0,
      submittedAt: null,
      cancelledAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    expect(submissionIntentSchema.safeParse(pending).success).toBe(true);
    expect(submissionIntentSchema.safeParse({
      ...pending,
      request: {
        ...pending.request,
        artifactTargets: [{
          artifactId: "artifact_source",
          artifactVersionId: "version_source",
          screenIds: ["screen_home"],
        }],
      },
    }).success).toBe(false);
    expect(submissionIntentSchema.safeParse({
      ...pending,
      request: { ...pending.request, workflow: "redesign" },
    }).success).toBe(false);
    expect(submissionIntentSchema.safeParse({
      ...pending,
      status: "submitted",
      runId: "run_1",
      submittedAt: timestamp,
    }).success).toBe(true);
    expect(submissionIntentSchema.safeParse({ ...pending, status: "submitted" }).success).toBe(false);
    expect(submissionIntentSchema.safeParse({
      ...pending,
      status: "cancelled",
      cancelledAt: timestamp,
    }).success).toBe(true);
  });
});
