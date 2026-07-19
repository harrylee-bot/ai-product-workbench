import {
  decodeDesignSystemCatalogCursor,
  DesignSystemCatalogService,
  encodeDesignSystemCatalogCursor,
  escapeCatalogContainsPattern,
} from "../src/modules/design-systems/design-system-catalog.service.js";

const updatedAt = new Date("2026-07-13T02:00:00.000Z");
const createdAt = new Date("2026-07-13T01:00:00.000Z");

function createDb() {
  return {
    artifact: { findMany: vi.fn() },
  };
}

describe("DesignSystemCatalogService", () => {
  it("lists readable ready current versions across active Projects without exposing content", async () => {
    const db = createDb();
    db.artifact.findMany.mockResolvedValue([{
      id: "artifact_design",
      title: "Product UI",
      updatedAt,
      project: { id: "project_source", title: "Source Project" },
      currentVersion: {
        id: "version_design",
        version: 2,
        checksum: "a".repeat(64),
        createdAt,
      },
    }]);
    const access = { assertWorkspaceMember: vi.fn().mockResolvedValue({ role: "member" }) };
    const service = new DesignSystemCatalogService(db as never, access as never);

    await expect(service.list("principal_1", "workspace_1", "  Product   UI  ")).resolves.toEqual({
      items: [{
        projectId: "project_source",
        projectTitle: "Source Project",
        artifactId: "artifact_design",
        artifactTitle: "Product UI",
        artifactVersionId: "version_design",
        version: 2,
        checksum: "a".repeat(64),
        createdAt: createdAt.toISOString(),
        updatedAt: updatedAt.toISOString(),
      }],
      nextCursor: null,
    });
    expect(db.artifact.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        kind: "design_system",
        currentVersion: { is: { status: "ready", schemaVersion: 1, contentBlobId: null } },
        project: {
          is: {
            workspaceId: "workspace_1",
            status: "active",
            members: { some: { principalId: "principal_1" } },
          },
        },
      }),
      select: expect.not.objectContaining({ content: expect.anything() }),
    }));
    expect(escapeCatalogContainsPattern("50%_off\\today")).toBe("50\\%\\_off\\\\today");
  });

  it("binds the opaque cursor to its Workspace and normalized query", async () => {
    const db = createDb();
    db.artifact.findMany.mockResolvedValue([]);
    const access = { assertWorkspaceMember: vi.fn().mockResolvedValue({ role: "member" }) };
    const service = new DesignSystemCatalogService(db as never, access as never);
    const cursor = encodeDesignSystemCatalogCursor({
      workspaceId: "workspace_1",
      q: "Product UI",
      updatedAt: updatedAt.toISOString(),
      artifactId: "artifact_design",
    });

    expect(decodeDesignSystemCatalogCursor(cursor)).toMatchObject({ artifactId: "artifact_design" });
    await expect(service.list("principal_1", "workspace_2", "Product UI", cursor))
      .rejects.toMatchObject({ status: 400 });
    await expect(service.list("principal_1", "workspace_1", "Other", cursor))
      .rejects.toMatchObject({ status: 400 });
    expect(db.artifact.findMany).not.toHaveBeenCalled();
  });

  it("checks Workspace membership before querying catalog data", async () => {
    const db = createDb();
    const access = {
      assertWorkspaceMember: vi.fn().mockRejectedValue({ status: 404 }),
    };
    const service = new DesignSystemCatalogService(db as never, access as never);

    await expect(service.list("principal_2", "workspace_1")).rejects.toMatchObject({ status: 404 });
    expect(db.artifact.findMany).not.toHaveBeenCalled();
  });
});
