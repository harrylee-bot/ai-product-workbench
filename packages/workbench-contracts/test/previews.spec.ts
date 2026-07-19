import { describe, expect, it } from "vitest";

import {
  createProjectPreviewRequestSchema,
  projectPreviewSchema,
} from "../src/previews.js";

describe("Project Preview contracts", () => {
  it("accepts only an immutable Release selection and a bounded lifecycle projection", () => {
    expect(createProjectPreviewRequestSchema.parse({
      boardId: "board-1",
      boardRevision: 4,
      selection: {
        kind: "artifact",
        artifactId: "artifact-1",
        artifactVersionId: "version-1",
        screenId: "screen-1",
      },
    })).toMatchObject({ boardId: "board-1", boardRevision: 4 });

    expect(projectPreviewSchema.parse({
      id: "preview-1",
      projectId: "project-1",
      boardId: "board-1",
      boardRevision: 4,
      selection: { kind: "release" },
      status: "queued",
      revision: 0,
      failure: null,
      createdAt: "2026-07-15T00:00:00.000Z",
      expiresAt: "2026-07-15T00:15:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z",
    }).status).toBe("queued");
  });

  it("does not accept Export format, options, output, or download identity", () => {
    expect(createProjectPreviewRequestSchema.safeParse({
      boardId: "board-1",
      boardRevision: 4,
      selection: { kind: "release" },
      format: "html",
    }).success).toBe(false);
    expect(projectPreviewSchema.safeParse({
      id: "preview-1",
      projectId: "project-1",
      boardId: "board-1",
      boardRevision: 4,
      selection: { kind: "release" },
      status: "succeeded",
      revision: 1,
      failure: null,
      createdAt: "2026-07-15T00:00:00.000Z",
      expiresAt: "2026-07-15T00:15:00.000Z",
      updatedAt: "2026-07-15T00:01:00.000Z",
      output: { blobId: "blob-1" },
    }).success).toBe(false);
  });
});
