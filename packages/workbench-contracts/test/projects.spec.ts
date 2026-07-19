import { describe, expect, it } from "vitest";
import {
  duplicateProjectRequestSchema,
  projectListSchema,
  projectMemberSchema,
  setProjectMemberRoleRequestSchema,
} from "../src/projects.js";
import {
  workspaceMemberListSchema,
  workspaceMemberSchema,
} from "../src/workspaces.js";

const timestamp = "2026-07-13T00:00:00.000Z";

describe("Project lifecycle contracts", () => {
  it("exposes explicit owned/shared list semantics", () => {
    const list = projectListSchema.parse({
      items: [{
        id: "project_1",
        workspaceId: "workspace_1",
        title: "Workbench",
        summary: null,
        status: "active",
        revision: 0,
        role: "editor",
        relationship: "shared",
        createdAt: timestamp,
        updatedAt: timestamp,
      }],
      nextCursor: null,
    });
    expect(list.items[0]).toMatchObject({ role: "editor", relationship: "shared" });
  });

  it("keeps duplicate and member commands strict", () => {
    expect(duplicateProjectRequestSchema.parse({})).toEqual({});
    expect(duplicateProjectRequestSchema.safeParse({ workspaceId: "workspace_2" }).success)
      .toBe(false);
    expect(setProjectMemberRoleRequestSchema.safeParse({ role: "admin" }).success).toBe(false);
  });

  it("returns only public member identity fields", () => {
    const member = projectMemberSchema.parse({
      projectId: "project_1",
      principalId: "principal_1",
      role: "owner",
      displayName: "Owner",
      email: "owner@example.com",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    expect(member).not.toHaveProperty("workspaceId");
  });
});

describe("Workspace member discovery contracts", () => {
  it("returns only collaborator discovery identity and Workspace role fields", () => {
    const member = workspaceMemberSchema.parse({
      principalId: "principal_2",
      role: "member",
      displayName: "Collaborator",
      email: "collaborator@example.com",
    });

    expect(member).toEqual(expect.objectContaining({
      principalId: "principal_2",
      role: "member",
      displayName: "Collaborator",
      email: "collaborator@example.com",
    }));
    expect(workspaceMemberSchema.safeParse({ ...member, issuer: "private" }).success).toBe(false);
  });

  it("requires an explicit opaque next cursor and rejects unknown page fields", () => {
    const page = {
      items: [],
      nextCursor: null,
    };
    expect(workspaceMemberListSchema.parse(page)).toEqual(page);
    expect(workspaceMemberListSchema.safeParse({ ...page, total: 0 }).success).toBe(false);
  });
});
