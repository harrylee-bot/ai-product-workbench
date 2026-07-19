import { describe, expect, it, vi } from "vitest";

import { WorkbenchDesignSystemsApi } from "./index";

const sha256 = "a".repeat(64);
const createdAt = "2026-07-13T00:00:00.000Z";

function documentFixture() {
  return {
    protocol: "workbench.design-system.v1" as const,
    documentId: "design-main",
    title: "Product UI",
    tokens: [],
    assets: [],
    principles: [],
    guidelines: [],
    components: [],
  };
}

describe("Design Systems API contracts", () => {
  it("lists the Workspace catalog through the generated route", async () => {
    const catalog = {
      items: [{
        projectId: "project_source",
        projectTitle: "Source Project",
        artifactId: "artifact_source",
        artifactTitle: "Product UI",
        artifactVersionId: "version_source",
        version: 1,
        checksum: sha256,
        createdAt,
        updatedAt: createdAt,
      }],
      nextCursor: "next-page",
    };
    const api = { GET: vi.fn().mockResolvedValue({ data: catalog }) };
    const service = new WorkbenchDesignSystemsApi(api as never);

    await expect(service.listDesignSystemCatalog("workspace_1", {
      q: "Product",
      limit: 20,
    })).resolves.toEqual(catalog);
    expect(api.GET).toHaveBeenCalledWith("/workspaces/{workspaceId}/design-systems", {
      params: {
        path: { workspaceId: "workspace_1" },
        query: { q: "Product", limit: 20 },
      },
    });
  });

  it("creates and imports immutable versions with idempotency keys", async () => {
    const creation = {
      id: "creation_1",
      projectId: "project_target",
      artifactId: "artifact_target",
      artifactVersionId: "version_target",
      checksum: sha256,
      createdById: "principal_1",
      idempotencyKey: "design:create:12345678",
      requestHash: "b".repeat(64),
      createdAt,
    };
    const imported = {
      id: "import_1",
      targetProjectId: "project_target",
      targetArtifactId: "artifact_imported",
      targetArtifactVersionId: "version_imported",
      sourceProjectId: "project_source",
      sourceArtifactId: "artifact_source",
      sourceArtifactVersionId: "version_source",
      sourceChecksum: sha256,
      createdById: "principal_1",
      idempotencyKey: "design:import:12345678",
      requestHash: "c".repeat(64),
      createdAt,
    };
    const api = {
      POST: vi.fn()
        .mockResolvedValueOnce({ data: creation })
        .mockResolvedValueOnce({ data: imported }),
    };
    const service = new WorkbenchDesignSystemsApi(api as never);
    const createRequest = { title: "Product UI", document: documentFixture() };

    await expect(service.createDesignSystem(
      "project_target",
      createRequest,
      creation.idempotencyKey,
    )).resolves.toEqual(creation);
    await expect(service.importDesignSystem(
      "project_target",
      { sourceArtifactVersionId: "version_source" },
      imported.idempotencyKey,
    )).resolves.toEqual(imported);

    expect(api.POST).toHaveBeenNthCalledWith(1, "/projects/{projectId}/design-systems", {
      params: {
        path: { projectId: "project_target" },
        header: { "Idempotency-Key": creation.idempotencyKey },
      },
      body: createRequest,
    });
    expect(api.POST).toHaveBeenNthCalledWith(2, "/projects/{projectId}/design-system-imports", {
      params: {
        path: { projectId: "project_target" },
        header: { "Idempotency-Key": imported.idempotencyKey },
      },
      body: { sourceArtifactVersionId: "version_source" },
    });
  });
});
