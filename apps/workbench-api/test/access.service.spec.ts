import { AccessService } from "../src/modules/access/access.service.js";

describe("resource access disclosure boundary", () => {
  it("conceals unknown and unauthorized Workspace ids behind the same 404", async () => {
    const db = { workspaceMember: { findUnique: vi.fn().mockResolvedValue(null) } };
    const service = new AccessService(db as never);

    await expect(service.assertWorkspaceMember("principal_2", "workspace_real"))
      .rejects.toMatchObject({ status: 404 });
  });

  it("constrains Project lookup by membership and returns 404 for misses", async () => {
    const db = { project: { findFirst: vi.fn().mockResolvedValue(null) } };
    const service = new AccessService(db as never);

    await expect(service.findProject("principal_2", "project_real")).rejects.toMatchObject({
      status: 404,
    });
    expect(db.project.findFirst).toHaveBeenCalledWith({
      where: {
        id: "project_real",
        status: "active",
        members: { some: { principalId: "principal_2" } },
      },
      include: {
        members: {
          where: { principalId: "principal_2" },
          select: { role: true },
        },
      },
    });
  });

  it("constrains Thread lookup by nested membership instead of a post-query 403", async () => {
    const db = { thread: { findFirst: vi.fn().mockResolvedValue(null) } };
    const service = new AccessService(db as never);

    await expect(service.findThread("principal_2", "thread_real")).rejects.toMatchObject({
      status: 404,
    });
    expect(db.thread.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "thread_real",
        project: expect.objectContaining({
          members: { some: { principalId: "principal_2" } },
        }),
      }),
    }));
  });

  it("loads ordered immutable source snapshots only after Run membership is proven", async () => {
    const db = { run: { findFirst: vi.fn().mockResolvedValue(null) } };
    const service = new AccessService(db as never);

    await expect(service.findRun("principal_2", "run_real")).rejects.toMatchObject({ status: 404 });
    expect(db.run.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "run_real",
        thread: expect.objectContaining({
          project: expect.objectContaining({
            members: { some: { principalId: "principal_2" } },
          }),
        }),
      }),
      include: expect.objectContaining({
        sourceSnapshots: { orderBy: { position: "asc" } },
      }),
    }));
  });

  it("requires editor or owner roles for Project writes", async () => {
    const db = { project: { findFirst: vi.fn().mockResolvedValue(null) } };
    const service = new AccessService(db as never);

    await expect(service.findProject("principal_2", "project_real", "edit"))
      .rejects.toMatchObject({ status: 404 });
    expect(db.project.findFirst).toHaveBeenCalledWith({
      where: {
        id: "project_real",
        status: "active",
        members: {
          some: {
            principalId: "principal_2",
            role: { in: ["owner", "editor"] },
          },
        },
      },
      include: {
        members: {
          where: { principalId: "principal_2" },
          select: { role: true },
        },
      },
    });
  });

  it("requires owner role for Project administration", async () => {
    const db = { project: { findFirst: vi.fn().mockResolvedValue(null) } };
    const service = new AccessService(db as never);

    await expect(service.findProject("principal_2", "project_real", "owner"))
      .rejects.toMatchObject({ status: 404 });
    expect(db.project.findFirst).toHaveBeenCalledWith({
      where: {
        id: "project_real",
        status: "active",
        members: { some: { principalId: "principal_2", role: "owner" } },
      },
      include: {
        members: {
          where: { principalId: "principal_2" },
          select: { role: true },
        },
      },
    });
  });
});
