// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkbenchProjectMembersDialog } from "./workbench-project-members-dialog";

const mocks = vi.hoisted(() => ({
  members: vi.fn(),
  invitations: vi.fn(),
  workspaceMembers: vi.fn(),
  createInvitation: vi.fn(),
  revokeInvitation: vi.fn(),
  setRole: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("@/lib/workbench/features/projects", () => ({
  projectInvitationAcceptUrl: (token: string, origin: string) => `${origin}/invitations/accept#token=${token}`,
  useCreateWorkbenchProjectInvitation: mocks.createInvitation,
  useInfiniteWorkbenchProjectInvitations: mocks.invitations,
  useInfiniteWorkbenchWorkspaceMembers: mocks.workspaceMembers,
  useRemoveWorkbenchProjectMember: mocks.remove,
  useRevokeWorkbenchProjectInvitation: mocks.revokeInvitation,
  useSetWorkbenchProjectMemberRole: mocks.setRole,
  useWorkbenchProjectMembers: mocks.members,
}));

beforeEach(() => {
  mocks.invitations.mockReturnValue(infiniteQuery([{ items: [], nextCursor: null }]));
  mocks.createInvitation.mockReturnValue({ isPending: false, mutateAsync: vi.fn() });
  mocks.revokeInvitation.mockReturnValue({ isPending: false, mutateAsync: vi.fn() });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("产品工作台成员与权限", () => {
  it("lists members and adds a searched workspace member", async () => {
    mocks.members.mockReturnValue(query({
      items: [member("principal-1", "owner", "项目所有者", "owner@example.com")],
    }));
    mocks.workspaceMembers.mockReturnValue(infiniteQuery([{
      items: [workspaceMember("principal-2", "编辑候选", "editor@example.com")],
      nextCursor: null,
    }]));
    const setRole = vi.fn(async () => undefined);
    mocks.setRole.mockReturnValue({ isPending: false, mutateAsync: setRole });
    mocks.remove.mockReturnValue({ isPending: false, mutateAsync: vi.fn(async () => undefined) });

    render(
      <WorkbenchProjectMembersDialog
        canManageMembers
        onOpenChange={vi.fn()}
        open
        projectId="project-1"
        projectTitle="采购工作台"
        workspaceId="workspace-1"
      />,
    );

    expect(screen.getByText("项目所有者")).not.toBeNull();
    await userEvent.type(screen.getByRole("textbox", { name: "搜索工作区成员" }), "editor");
    expect(await screen.findByText(/编辑候选/)).not.toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "添加" }));

    expect(setRole).toHaveBeenCalledWith({
      principalId: "principal-2",
      request: { role: "editor" },
    });
  });

  it("loads and can add the 31st matching Workspace member", async () => {
    const firstPage = Array.from({ length: 30 }, (_, index) => workspaceMember(
      `principal-${index + 1}`,
      `候选成员 ${String(index + 1).padStart(2, "0")}`,
      `member${index + 1}@example.com`,
    ));
    const secondPage = [workspaceMember(
      "principal-31",
      "候选成员 31",
      "member31@example.com",
    )];
    let pages: Array<{
      items: ReturnType<typeof workspaceMember>[];
      nextCursor: string | null;
    }> = [{ items: firstPage, nextCursor: "workspace-cursor-31" }];
    const fetchNextPage = vi.fn(async () => {
      pages = [...pages, { items: secondPage, nextCursor: null }];
    });
    const setRole = vi.fn(async () => undefined);
    mocks.members.mockReturnValue(query({ items: [] }));
    mocks.workspaceMembers.mockImplementation(() => infiniteQuery(pages, { fetchNextPage }));
    mocks.setRole.mockReturnValue({ isPending: false, mutateAsync: setRole });
    mocks.remove.mockReturnValue({ isPending: false, mutateAsync: vi.fn() });

    const rendered = render(
      <WorkbenchProjectMembersDialog
        canManageMembers
        onOpenChange={vi.fn()}
        open
        projectId="project-1"
        projectTitle="采购工作台"
        workspaceId="workspace-1"
      />,
    );

    await userEvent.type(screen.getByRole("textbox", { name: "搜索工作区成员" }), "member");
    await userEvent.click(screen.getByRole("button", { name: "加载更多工作区成员" }));
    expect(fetchNextPage).toHaveBeenCalledOnce();
    rendered.rerender(
      <WorkbenchProjectMembersDialog
        canManageMembers
        onOpenChange={vi.fn()}
        open
        projectId="project-1"
        projectTitle="采购工作台"
        workspaceId="workspace-1"
      />,
    );

    const candidate = screen.getByText(/候选成员 31/);
    const candidateRow = candidate.closest("div");
    expect(candidateRow).not.toBeNull();
    await userEvent.click(within(candidateRow!).getByRole("button", { name: "添加" }));
    expect(setRole).toHaveBeenCalledWith({
      principalId: "principal-31",
      request: { role: "editor" },
    });
  });

  it("protects the last owner from removal", () => {
    mocks.members.mockReturnValue(query({
      items: [member("principal-1", "owner", "唯一所有者", "owner@example.com")],
    }));
    mocks.workspaceMembers.mockReturnValue(infiniteQuery([{ items: [], nextCursor: null }]));
    mocks.setRole.mockReturnValue({ isPending: false, mutateAsync: vi.fn() });
    mocks.remove.mockReturnValue({ isPending: false, mutateAsync: vi.fn() });

    render(
      <WorkbenchProjectMembersDialog
        canManageMembers
        onOpenChange={vi.fn()}
        open
        projectId="project-1"
        projectTitle="采购工作台"
        workspaceId="workspace-1"
      />,
    );

    expect((screen.getByRole("button", { name: "移除 唯一所有者" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("creates an external invitation and exposes a copyable manual-delivery link", async () => {
    const token = invitationToken();
    const invitation = invitationItem(token);
    const create = vi.fn().mockResolvedValue({
      value: {
        invitation: invitation.invitation,
        token,
        deliveryStatus: "not_configured",
      },
      etag: '"2"',
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    mocks.members.mockReturnValue(query({
      items: [member("principal-1", "owner", "项目所有者", "owner@example.com")],
    }));
    mocks.workspaceMembers.mockReturnValue(infiniteQuery([{ items: [], nextCursor: null }]));
    mocks.invitations.mockReturnValue(infiniteQuery([{
      items: [invitation],
      nextCursor: null,
    }]));
    mocks.createInvitation.mockReturnValue({ isPending: false, mutateAsync: create });
    mocks.setRole.mockReturnValue({ isPending: false, mutateAsync: vi.fn() });
    mocks.remove.mockReturnValue({ isPending: false, mutateAsync: vi.fn() });

    render(
      <WorkbenchProjectMembersDialog
        canManageMembers
        onOpenChange={vi.fn()}
        open
        projectId="project-1"
        projectTitle="采购工作台"
        workspaceId="workspace-1"
      />,
    );

    await userEvent.type(
      screen.getByRole("textbox", { name: "邀请外部成员邮箱" }),
      "External@Example.com",
    );
    await userEvent.click(screen.getByRole("button", { name: "创建邀请" }));
    expect(create).toHaveBeenCalledWith({
      request: { email: "external@example.com", role: "editor" },
    });

    await userEvent.click(screen.getByRole("button", {
      name: "复制 external@example.com 的邀请链接",
    }));
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining(`/invitations/accept#token=${token}`),
    );
    expect(screen.getByTitle("已复制")).not.toBeNull();
  });

  it("loads and can revoke the 31st pending invitation", async () => {
    const token = invitationToken();
    const firstPage = Array.from({ length: 30 }, (_, index) => invitationItem(token, index + 1));
    const secondPage = [invitationItem(token, 31)];
    let pages: Array<{
      items: ReturnType<typeof invitationItem>[];
      nextCursor: string | null;
    }> = [{ items: firstPage, nextCursor: "invitation-cursor-31" }];
    const fetchNextPage = vi.fn(async () => {
      pages = [...pages, { items: secondPage, nextCursor: null }];
    });
    const revoke = vi.fn(async () => undefined);
    mocks.members.mockReturnValue(query({
      items: [member("principal-owner", "owner", "项目所有者", "owner@example.com")],
    }));
    mocks.workspaceMembers.mockReturnValue(infiniteQuery([{ items: [], nextCursor: null }]));
    mocks.invitations.mockImplementation(() => infiniteQuery(pages, { fetchNextPage }));
    mocks.revokeInvitation.mockReturnValue({ isPending: false, mutateAsync: revoke });
    mocks.setRole.mockReturnValue({ isPending: false, mutateAsync: vi.fn() });
    mocks.remove.mockReturnValue({ isPending: false, mutateAsync: vi.fn() });

    const rendered = render(
      <WorkbenchProjectMembersDialog
        canManageMembers
        onOpenChange={vi.fn()}
        open
        projectId="project-1"
        projectTitle="采购工作台"
        workspaceId="workspace-1"
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "加载更多邀请" }));
    expect(fetchNextPage).toHaveBeenCalledOnce();
    rendered.rerender(
      <WorkbenchProjectMembersDialog
        canManageMembers
        onOpenChange={vi.fn()}
        open
        projectId="project-1"
        projectTitle="采购工作台"
        workspaceId="workspace-1"
      />,
    );

    await userEvent.click(screen.getByRole("button", {
      name: "撤销 member31@example.com 的邀请",
    }));
    expect(revoke).toHaveBeenCalledWith({ invitationId: "invitation-31" });
  });
});

function query<T>(data: T) {
  return {
    data,
    error: null,
    isFetching: false,
    isPending: false,
    refetch: vi.fn(),
  };
}

function infiniteQuery<T>(
  pages: Array<{ items: T[]; nextCursor: string | null }>,
  overrides: Record<string, unknown> = {},
) {
  return {
    data: { pages, pageParams: pages.map((_, index) => index) },
    error: null,
    fetchNextPage: vi.fn(),
    hasNextPage: pages.at(-1)?.nextCursor !== null,
    isFetching: false,
    isFetchingNextPage: false,
    isPending: false,
    refetch: vi.fn(),
    ...overrides,
  };
}

function member(principalId: string, role: "owner" | "editor" | "viewer", displayName: string, email: string) {
  return {
    projectId: "project-1",
    principalId,
    role,
    displayName,
    email,
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
  };
}

function workspaceMember(principalId: string, displayName: string, email: string) {
  return {
    workspaceId: "workspace-1",
    principalId,
    role: "member" as const,
    displayName,
    email,
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
  };
}

function invitationToken() {
  return `wbi_${btoa("00000000-0000-4000-8000-000000000000").replaceAll("=", "")}.${"a".repeat(43)}`;
}

function invitationItem(token: string, index = 1) {
  const email = index === 1 ? "external@example.com" : `member${index}@example.com`;
  return {
    invitation: {
      id: `invitation-${index}`,
      projectId: "project-1",
      workspaceId: "workspace-1",
      email,
      role: "editor" as const,
      status: "pending" as const,
      deliveryStatus: "not_configured" as const,
      createdById: "principal-1",
      acceptedById: null,
      revision: 0,
      expiresAt: "2026-07-22T00:00:00.000Z",
      acceptedAt: null,
      revokedAt: null,
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z",
    },
    token,
  };
}
