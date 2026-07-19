import { describe, expect, it } from "vitest";
import {
  artifactCreationSchema,
  createArtifactRequestSchema,
} from "../src/index.js";

const createdAt = "2026-07-14T07:00:00.000Z";
const checksum = "a".repeat(64);

describe("Artifact creation contract", () => {
  it("accepts only the strict image-from-file v1 command", () => {
    expect(createArtifactRequestSchema.parse({
      kind: "image",
      title: "  Hero image  ",
      source: { kind: "file", fileAssetId: "file_1" },
    })).toEqual({
      kind: "image",
      title: "Hero image",
      source: { kind: "file", fileAssetId: "file_1" },
    });
    expect(() => createArtifactRequestSchema.parse({
      kind: "image",
      title: "Hero image",
      source: { kind: "blob", blobId: "blob_1" },
    })).toThrow();
    expect(() => createArtifactRequestSchema.parse({
      kind: "image",
      title: "Hero image",
      source: { kind: "file", fileAssetId: "file_1" },
      storageKey: "private/key",
    })).toThrow();
  });

  it("requires the returned current pointer to match the ready blob-backed image version", () => {
    const response = imageCreation();
    expect(artifactCreationSchema.parse(response)).toEqual(response);
    expect(() => artifactCreationSchema.parse({
      ...response,
      artifactVersion: { ...response.artifactVersion, artifactVersionId: "version_other" },
    })).toThrow(/matching current version/);
    expect(() => artifactCreationSchema.parse({
      ...response,
      artifactVersion: {
        ...response.artifactVersion,
        contentMode: "inline",
        content: {},
      },
    })).toThrow();
  });
});

function imageCreation() {
  const currentVersion = {
    artifactId: "artifact_1",
    artifactVersionId: "version_1",
    version: 1,
    kind: "image" as const,
    schemaVersion: 1,
    status: "ready" as const,
    checksum,
    createdByRunId: null,
    createdAt,
  };
  return {
    artifact: {
      id: "artifact_1",
      projectId: "project_1",
      kind: "image" as const,
      title: "Hero image",
      revision: 1,
      currentVersion,
      createdAt,
      updatedAt: createdAt,
    },
    artifactVersion: {
      ...currentVersion,
      citations: [],
      knowledgeReleaseId: null,
      contentMode: "blob" as const,
      blob: {
        blobId: "blob_1",
        mediaType: "image/png",
        byteSize: 42,
        sha256: checksum,
        fileName: null,
      },
    },
  };
}
