import { ProjectDuplicatesService } from "../src/modules/projects/project-duplicates.service.js";

const now = new Date("2026-07-17T00:00:00.000Z");

describe("ProjectDuplicatesService", () => {
  it("copies only source Artifacts with a ready current version", async () => {
    const targetProject = {
      id: "project_target",
      workspaceId: "workspace_1",
      createdById: "principal_1",
      title: "Target",
      summary: null,
      status: "active",
      revision: 0,
      createdAt: now,
      updatedAt: now,
    };
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "locked" }]),
      $executeRaw: vi.fn(),
      project: {
        findFirst: vi.fn().mockResolvedValue({
          id: "project_source",
          workspaceId: "workspace_1",
          title: "Source",
          summary: null,
        }),
        create: vi.fn().mockResolvedValue(targetProject),
      },
      projectDuplicate: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({
          sourceProjectId: "project_source",
          targetProjectId: targetProject.id,
          workspaceId: "workspace_1",
          createdById: "principal_1",
          idempotencyKey: "duplicate-key",
          requestHash: "request-hash",
          createdAt: now,
          targetProject,
        }),
      },
      board: {
        findUnique: vi.fn().mockResolvedValue({
          id: "board_source",
          viewport: { x: 0, y: 0, zoom: 1 },
          nodes: [],
          edges: [],
        }),
        create: vi.fn().mockResolvedValue({ id: "board_target" }),
      },
      artifact: {
        findMany: vi.fn().mockResolvedValue([]),
        createMany: vi.fn(),
      },
      artifactVersion: { findMany: vi.fn(), createMany: vi.fn(), updateMany: vi.fn() },
      artifactVersionAsset: { createMany: vi.fn() },
      projectMember: { create: vi.fn().mockResolvedValue({}) },
      thread: { create: vi.fn().mockResolvedValue({}) },
      boardNode: { createMany: vi.fn() },
      boardEdge: { createMany: vi.fn() },
    };
    const db = {
      projectDuplicate: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const access = { findProject: vi.fn().mockResolvedValue({ id: "project_source" }) };
    const service = new ProjectDuplicatesService(db as never, access as never);

    await service.create("principal_1", "project_source", "duplicate-key", {});

    expect(tx.artifact.findMany).toHaveBeenCalledWith({
      where: {
        projectId: "project_source",
        currentVersionId: { not: null },
        currentVersion: { is: { status: "ready" } },
      },
      orderBy: { id: "asc" },
    });
    expect(tx.artifact.createMany).not.toHaveBeenCalled();
    expect(tx.artifactVersion.findMany).not.toHaveBeenCalled();
  });
});
