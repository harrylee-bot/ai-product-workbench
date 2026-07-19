// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ProjectInvitationAcceptPage from "./page";

const mocks = vi.hoisted(() => ({
  accept: vi.fn(),
  preview: vi.fn(),
}));

vi.mock("@/lib/workbench/features/projects", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workbench/features/projects")>()),
  useAcceptWorkbenchProjectInvitation: mocks.accept,
  useWorkbenchProjectInvitationPreview: mocks.preview,
}));

const token = `wbi_${btoa("00000000-0000-4000-8000-000000000000").replaceAll("=", "")}.${"a".repeat(43)}`;

describe("产品工作台邀请接受页", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState(null, "", `/invitations/accept#token=${token}`);
    mocks.preview.mockImplementation((currentToken: string) => currentToken
      ? {
          data: {
            invitationId: "invitation-1",
            projectId: "project-1",
            projectTitle: "采购工作台",
            workspaceId: "workspace-1",
            workspaceName: "产品团队",
            email: "invitee@example.com",
            role: "editor",
            status: "pending",
            expiresAt: "2026-07-22T00:00:00.000Z",
          },
          error: null,
          isPending: false,
          refetch: vi.fn(),
        }
      : { data: undefined, error: null, isPending: false, refetch: vi.fn() });
    mocks.accept.mockReturnValue({
      error: null,
      isPending: false,
      mutateAsync: vi.fn(async () => ({
        value: { invitation: { projectId: "project-1" } },
      })),
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("consumes the fragment without leaving the bearer token in the address bar", async () => {
    render(<ProjectInvitationAcceptPage />);

    expect(await screen.findByText("采购工作台")).not.toBeNull();
    expect(window.location.hash).toBe("");
    expect(window.location.search).toBe("");
    expect(window.sessionStorage.getItem("workbench.project-invitation-token.v1")).toBe(token);
    expect(mocks.preview).toHaveBeenCalledWith(token);

    await userEvent.click(screen.getByRole("button", { name: "接受邀请" }));
    await waitFor(() => {
      expect(window.sessionStorage.getItem("workbench.project-invitation-token.v1")).toBeNull();
    });
  });
});
