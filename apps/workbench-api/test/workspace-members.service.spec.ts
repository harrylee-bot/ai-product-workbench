import { WorkspaceMembersController } from "../src/modules/workspaces/workspace-members.controller.js";
import {
  decodeWorkspaceMemberCursor,
  encodeWorkspaceMemberCursor,
  WorkspaceMembersService,
} from "../src/modules/workspaces/workspace-members.service.js";

const now = new Date("2026-07-15T06:00:00.000Z");

function member(principalId: string, role: "owner" | "admin" | "member" = "member") {
  return {
    workspaceId: "workspace_1",
    principalId,
    role,
    createdAt: now,
    updatedAt: now,
    principal: {
      displayName: `Member ${principalId}`,
      email: `${principalId}@example.com`,
    },
  };
}

describe("Workspace members service", () => {
  it("authorizes any Workspace member and returns a stable principal cursor page", async () => {
    const db = {
      workspaceMember: {
        findMany: vi.fn().mockResolvedValue([
          member("principal_1", "owner"),
          member("principal_2"),
          member("principal_3", "admin"),
        ]),
      },
    };
    const access = { assertWorkspaceMember: vi.fn().mockResolvedValue({ role: "member" }) };
    const service = new WorkspaceMembersService(db as never, access as never);

    const result = await service.list(
      "requester_1",
      "workspace_1",
      "  Product%_ Owner ",
      undefined,
      2,
    );

    expect(access.assertWorkspaceMember).toHaveBeenCalledWith("requester_1", "workspace_1");
    expect(db.workspaceMember.findMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace_1",
        principal: {
          is: {
            OR: [
              { displayName: { contains: "Product\\%\\_ Owner", mode: "insensitive" } },
              { email: { contains: "Product\\%\\_ Owner", mode: "insensitive" } },
            ],
          },
        },
      },
      include: {
        principal: { select: { displayName: true, email: true } },
      },
      orderBy: { principalId: "asc" },
      take: 3,
    });
    expect(result.items.map(({ principalId }) => principalId))
      .toEqual(["principal_1", "principal_2"]);
    expect(result.items[0]).toMatchObject({
      role: "owner",
      displayName: "Member principal_1",
      email: "principal_1@example.com",
    });
    expect(decodeWorkspaceMemberCursor(result.nextCursor!)).toEqual({
      version: 1,
      workspaceId: "workspace_1",
      q: "Product%_ Owner",
      principalId: "principal_2",
    });
  });

  it("binds cursors to Workspace and normalized search filters", async () => {
    const db = { workspaceMember: { findMany: vi.fn().mockResolvedValue([]) } };
    const access = { assertWorkspaceMember: vi.fn().mockResolvedValue({}) };
    const service = new WorkspaceMembersService(db as never, access as never);
    const cursor = encodeWorkspaceMemberCursor({
      version: 1,
      workspaceId: "workspace_1",
      q: "Alice",
      principalId: "principal_1",
    });

    await expect(service.list("requester_1", "workspace_2", "Alice", cursor))
      .rejects.toMatchObject({ status: 400 });
    await expect(service.list("requester_1", "workspace_1", "Bob", cursor))
      .rejects.toMatchObject({ status: 400 });
    expect(db.workspaceMember.findMany).not.toHaveBeenCalled();

    await expect(service.list("requester_1", "workspace_1", "Alice", cursor, 10))
      .resolves.toEqual({ items: [], nextCursor: null });
    expect(db.workspaceMember.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: "workspace_1",
        principalId: { gt: "principal_1" },
      }),
      orderBy: { principalId: "asc" },
      take: 11,
    }));
  });

  it("rejects malformed cursors and repeated query parameters", async () => {
    const service = new WorkspaceMembersService(
      { workspaceMember: { findMany: vi.fn() } } as never,
      { assertWorkspaceMember: vi.fn().mockResolvedValue({}) } as never,
    );
    await expect(service.list("requester_1", "workspace_1", undefined, "not+a+cursor"))
      .rejects.toMatchObject({ status: 400 });

    const controller = new WorkspaceMembersController(service);
    expect(() => controller.list(
      { id: "requester_1" } as never,
      "workspace_1",
      { q: ["Alice", "Bob"] },
    )).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => controller.list(
      { id: "requester_1" } as never,
      "workspace_1",
      { limit: "101" },
    )).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => controller.list(
      { id: "requester_1" } as never,
      "workspace_1",
      { cursor: "" },
    )).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => controller.list(
      { id: "requester_1" } as never,
      "workspace_1",
      { privateSubject: "forbidden" },
    )).toThrow(expect.objectContaining({ status: 400 }));
  });
});
