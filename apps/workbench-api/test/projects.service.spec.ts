import { ProjectMembersService } from "../src/modules/projects/project-members.service.js";
import { ProjectsController } from "../src/modules/projects/projects.controller.js";
import {
  encodeCursor,
  ProjectsService,
} from "../src/modules/projects/projects.service.js";

const now = new Date("2026-07-13T06:00:00.000Z");
const project = {
  id: "project_1",
  workspaceId: "workspace_1",
  createdById: "principal_1",
  title: "Dashboard",
  summary: "Shared operations dashboard",
  status: "active" as const,
  revision: 3,
  createdAt: now,
  updatedAt: now,
};

describe("Projects service", () => {
  it("rejects repeated q parameters instead of passing an array to the search layer", () => {
    const controller = new ProjectsController({} as never, {} as never, {} as never);
    expect(() => controller.list(
      { id: "principal_1" } as never,
      ["first", "second"],
    )).toThrow(expect.objectContaining({ status: 400 }));
  });

  it("binds q and relationship to a member-scoped cursor page", async () => {
    const db = {
      project: {
        findMany: vi.fn().mockResolvedValue([{ ...project, members: [{ role: "editor" }] }]),
      },
    };
    const service = new ProjectsService(db as never, {} as never);

    await expect(service.list(
      "principal_1",
      "  shared   operations ",
      "shared",
      undefined,
      20,
    )).resolves.toEqual({
      items: [expect.objectContaining({
        id: "project_1",
        role: "editor",
        relationship: "shared",
      })],
      nextCursor: null,
    });
    expect(db.project.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: "active",
        members: {
          some: {
            principalId: "principal_1",
            role: { in: ["editor", "viewer"] },
          },
        },
        AND: expect.arrayContaining([
          expect.objectContaining({
            OR: [
              { title: { contains: "shared operations", mode: "insensitive" } },
              { summary: { contains: "shared operations", mode: "insensitive" } },
            ],
          }),
        ]),
      }),
    }));
  });

  it("escapes LIKE metacharacters before using Prisma contains", async () => {
    const db = { project: { findMany: vi.fn().mockResolvedValue([]) } };
    const service = new ProjectsService(db as never, {} as never);

    await service.list("principal_1", "100%_\\path");

    expect(db.project.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        AND: expect.arrayContaining([{
          OR: [
            { title: { contains: "100\\%\\_\\\\path", mode: "insensitive" } },
            { summary: { contains: "100\\%\\_\\\\path", mode: "insensitive" } },
          ],
        }]),
      }),
    }));
  });

  it("rejects a cursor replayed under different list filters", async () => {
    const db = { project: { findMany: vi.fn() } };
    const service = new ProjectsService(db as never, {} as never);
    const cursor = encodeCursor({
      updatedAt: now.toISOString(),
      id: "project_1",
      q: "dashboard",
      relationship: "owned",
    });

    await expect(service.list(
      "principal_1",
      "dashboard",
      "shared",
      cursor,
    )).rejects.toMatchObject({ status: 400 });
    expect(db.project.findMany).not.toHaveBeenCalled();
  });

  it("creates the Project owner in the same transaction as its default graph", async () => {
    const tx = {
      project: { create: vi.fn().mockResolvedValue({ ...project, revision: 0 }) },
      projectMember: { create: vi.fn().mockResolvedValue({}) },
      thread: { create: vi.fn().mockResolvedValue({}) },
      board: { create: vi.fn().mockResolvedValue({}) },
    };
    const db = { $transaction: vi.fn((callback) => callback(tx)) };
    const access = { assertWorkspaceMember: vi.fn().mockResolvedValue({}) };
    const service = new ProjectsService(db as never, access as never);

    await service.create("principal_1", "workspace_1", { title: "Dashboard" });
    expect(tx.projectMember.create).toHaveBeenCalledWith({
      data: {
        projectId: "project_1",
        workspaceId: "workspace_1",
        principalId: "principal_1",
        role: "owner",
      },
    });
  });

  it("bootstraps the newest 500 Thread entries in chronological order", async () => {
    const thread = {
      id: "thread_1",
      projectId: project.id,
      title: "Main",
      status: "active" as const,
      revision: 0,
      createdAt: now,
      updatedAt: now,
    };
    const persistedEntries = Array.from({ length: 501 }, (_, index) => {
      const sequence = index + 1;
      return {
        id: `entry_${sequence}`,
        threadId: thread.id,
        sequence,
        role: "user" as const,
        kind: "message" as const,
        content: {
          protocol: "workbench.entry.v1",
          type: "user.prompt",
          text: `Prompt ${sequence}`,
          sourceIds: [],
        },
        producedByRunId: null,
        createdAt: now,
      };
    });
    const findEntries = vi.fn((query: {
      orderBy: { sequence: "asc" | "desc" };
      take: number;
    }) => Promise.resolve(
      [...persistedEntries]
        .sort((left, right) => query.orderBy.sequence === "desc"
          ? right.sequence - left.sequence
          : left.sequence - right.sequence)
        .slice(0, query.take),
    ));
    const db = {
      thread: { findMany: vi.fn().mockResolvedValue([thread]) },
      board: {
        findUnique: vi.fn().mockResolvedValue({
          id: "board_1",
          projectId: project.id,
          revision: 0,
          viewport: { x: 0, y: 0, zoom: 1 },
          nodes: [],
          edges: [],
        }),
      },
      artifact: { findMany: vi.fn().mockResolvedValue([]) },
      threadEntry: { findMany: findEntries },
      run: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    const access = {
      findProject: vi.fn().mockResolvedValue({
        ...project,
        members: [{ role: "owner" }],
      }),
    };
    const service = new ProjectsService(db as never, access as never);

    const bootstrap = await service.bootstrap("principal_1", project.id);

    expect(findEntries).toHaveBeenCalledWith({
      where: { threadId: thread.id },
      orderBy: { sequence: "desc" },
      take: 500,
    });
    expect(bootstrap.entries).toHaveLength(500);
    expect(bootstrap.entries.map((entry) => entry.sequence)).toEqual(
      Array.from({ length: 500 }, (_, index) => index + 2),
    );
  });

  it("bootstraps only Artifacts with a ready current version", async () => {
    const readyVersion = {
      id: "version_1",
      artifactId: "artifact_1",
      version: 1,
      schemaVersion: 1,
      status: "ready" as const,
      checksum: "a".repeat(64),
      createdByRunId: "run_1",
      createdAt: now,
    };
    const db = {
      thread: { findMany: vi.fn().mockResolvedValue([]) },
      board: {
        findUnique: vi.fn().mockResolvedValue({
          id: "board_1",
          projectId: project.id,
          revision: 0,
          viewport: { x: 0, y: 0, zoom: 1 },
          nodes: [],
          edges: [],
        }),
      },
      artifact: {
        findMany: vi.fn().mockResolvedValue([{
          id: "artifact_1",
          projectId: project.id,
          kind: "prototype" as const,
          title: "Ready prototype",
          revision: 1,
          currentVersionId: readyVersion.id,
          currentVersion: readyVersion,
          createdAt: now,
          updatedAt: now,
        }]),
      },
    };
    const access = {
      findProject: vi.fn().mockResolvedValue({
        ...project,
        members: [{ role: "owner" }],
      }),
    };
    const service = new ProjectsService(db as never, access as never);

    await expect(service.bootstrap("principal_1", project.id)).resolves.toMatchObject({
      artifacts: [{
        id: "artifact_1",
        currentVersion: { artifactVersionId: "version_1", status: "ready" },
      }],
    });
    expect(db.artifact.findMany).toHaveBeenCalledWith({
      where: {
        projectId: project.id,
        currentVersionId: { not: null },
        currentVersion: { is: { status: "ready" } },
      },
      include: { currentVersion: true },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    });
  });

  it("rechecks edit capability under the Project update lock", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "project_1", revision: 3 }]),
      projectMember: { findUnique: vi.fn().mockResolvedValue({ role: "viewer" }) },
      project: { update: vi.fn() },
    };
    const db = { $transaction: vi.fn((callback) => callback(tx)) };
    const service = new ProjectsService(db as never, {} as never);

    await expect(service.update("principal_1", "project_1", 3, { title: "Blocked" }))
      .rejects.toMatchObject({ status: 404 });
    expect(tx.project.update).not.toHaveBeenCalled();
  });

  it("blocks archive while a file pipeline operation is active", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "project_1", revision: 3 }]),
      projectMember: { findUnique: vi.fn().mockResolvedValue({ role: "owner" }) },
      run: { count: vi.fn().mockResolvedValue(0) },
      exportJob: { count: vi.fn().mockResolvedValue(0) },
      fileAsset: { count: vi.fn().mockResolvedValue(1) },
      fileUploadSession: { count: vi.fn().mockResolvedValue(0) },
      fileExtraction: { count: vi.fn().mockResolvedValue(0) },
      shareGrant: { updateMany: vi.fn() },
      project: { update: vi.fn() },
    };
    const db = { $transaction: vi.fn((callback) => callback(tx)) };
    const access = { findProject: vi.fn().mockResolvedValue(project) };
    const service = new ProjectsService(db as never, access as never);

    await expect(service.archive("principal_1", "project_1", 3))
      .rejects.toMatchObject({ status: 409 });
    expect(tx.project.update).not.toHaveBeenCalled();
  });
});

describe("Project members service", () => {
  it("treats PUT of the existing role as a no-op without revision churn", async () => {
    const current = {
      projectId: "project_1",
      workspaceId: "workspace_1",
      principalId: "principal_1",
      role: "owner" as const,
      createdAt: now,
      updatedAt: now,
      principal: { displayName: "Owner", email: "owner@example.com" },
    };
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "project_1", workspaceId: "workspace_1", revision: 3 }]),
      projectMember: {
        findUnique: vi.fn()
          .mockResolvedValueOnce({ role: "owner" })
          .mockResolvedValueOnce(current),
        upsert: vi.fn(),
      },
      workspaceMember: { findUnique: vi.fn().mockResolvedValue({ principalId: "principal_1" }) },
      project: { update: vi.fn() },
    };
    const db = { $transaction: vi.fn((callback) => callback(tx)) };
    const access = { findProject: vi.fn().mockResolvedValue(project) };
    const service = new ProjectMembersService(db as never, access as never);

    await expect(service.setRole("principal_1", "project_1", "principal_1", 3, "owner"))
      .resolves.toMatchObject({ projectRevision: 3, member: { role: "owner" } });
    expect(tx.projectMember.upsert).not.toHaveBeenCalled();
    expect(tx.project.update).not.toHaveBeenCalled();
  });

  it("refuses to remove the last owner", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "project_1", workspaceId: "workspace_1", revision: 3 }]),
      projectMember: {
        findUnique: vi.fn()
          .mockResolvedValueOnce({ role: "owner" })
          .mockResolvedValueOnce({ role: "owner" }),
        count: vi.fn().mockResolvedValue(0),
        delete: vi.fn(),
      },
      project: { update: vi.fn() },
    };
    const db = { $transaction: vi.fn((callback) => callback(tx)) };
    const access = { findProject: vi.fn().mockResolvedValue(project) };
    const service = new ProjectMembersService(db as never, access as never);

    await expect(service.remove("principal_1", "project_1", "principal_1", 3))
      .rejects.toMatchObject({ status: 409 });
    expect(tx.projectMember.delete).not.toHaveBeenCalled();
  });
});
