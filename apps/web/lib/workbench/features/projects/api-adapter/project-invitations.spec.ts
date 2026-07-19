import { describe, expect, it, vi } from "vitest";

import { createWorkbenchApiClient } from "../../../api/client";
import { WorkbenchProjectsApi } from "./index";

const token = `wbi_${Buffer.from("00000000-0000-4000-8000-000000000000").toString("base64url")}.${"a".repeat(43)}`;
const invitation = {
  id: "invitation-1",
  projectId: "project-1",
  workspaceId: "workspace-1",
  email: "invitee@example.com",
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
};

describe("Projects API invitation contracts", () => {
  it("sends owner list, CAS create, preview, accept, and CAS revoke through the typed BFF", async () => {
    const fetch = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (request.method === "GET") {
        expect(url.pathname).toBe("/api/v1/projects/project-1/invitations");
        expect(url.searchParams.get("status")).toBe("pending");
        return Response.json({ items: [{ invitation, token }], nextCursor: null });
      }
      if (url.pathname.endsWith("/projects/project-1/invitations") && request.method === "POST") {
        expect(request.headers.get("if-match")).toBe('"3"');
        expect(request.headers.get("idempotency-key")).toBe("invite-key-123");
        expect(await request.json()).toEqual({ email: "invitee@example.com", role: "editor" });
        return Response.json(
          { invitation, token, deliveryStatus: "not_configured" },
          { status: 201, headers: { ETag: '"4"' } },
        );
      }
      if (url.pathname.endsWith("/project-invitations/preview")) {
        expect(await request.json()).toEqual({ token });
        return Response.json({
          invitationId: invitation.id,
          projectId: invitation.projectId,
          projectTitle: "采购工作台",
          workspaceId: invitation.workspaceId,
          workspaceName: "产品团队",
          email: invitation.email,
          role: invitation.role,
          status: invitation.status,
          expiresAt: invitation.expiresAt,
        });
      }
      if (url.pathname.endsWith("/project-invitations/accept")) {
        return Response.json({
          invitation: {
            ...invitation,
            status: "accepted",
            acceptedById: "principal-2",
            acceptedAt: "2026-07-16T00:00:00.000Z",
            revision: 1,
          },
          member: {
            projectId: "project-1",
            principalId: "principal-2",
            role: "editor",
            displayName: "Invitee",
            email: "invitee@example.com",
            createdAt: "2026-07-16T00:00:00.000Z",
            updatedAt: "2026-07-16T00:00:00.000Z",
          },
        }, { headers: { ETag: '"5"' } });
      }
      if (request.method === "DELETE") {
        expect(url.pathname).toBe("/api/v1/projects/project-1/invitations/invitation-1");
        expect(request.headers.get("if-match")).toBe('"5"');
        return Response.json({
          ...invitation,
          status: "revoked",
          revokedAt: "2026-07-16T00:00:00.000Z",
          revision: 1,
        }, { headers: { ETag: '"6"' } });
      }
      throw new Error(`Unexpected invitation request: ${request.method} ${url.pathname}`);
    });
    const api = new WorkbenchProjectsApi(createWorkbenchApiClient({
      baseUrl: "http://workbench.test/api/v1",
      fetch,
    }));

    await expect(api.listProjectInvitations("project-1", { status: "pending" }))
      .resolves.toEqual({ items: [{ invitation, token }], nextCursor: null });
    await expect(api.createProjectInvitation(
      "project-1",
      { email: "INVITEE@EXAMPLE.COM", role: "editor" },
      '"3"',
      "invite-key-123",
    )).resolves.toMatchObject({ etag: '"4"', value: { deliveryStatus: "not_configured" } });
    await expect(api.previewProjectInvitation(token))
      .resolves.toMatchObject({ projectTitle: "采购工作台", status: "pending" });
    await expect(api.acceptProjectInvitation(token))
      .resolves.toMatchObject({ etag: '"5"', value: { member: { role: "editor" } } });
    await expect(api.revokeProjectInvitation("project-1", "invitation-1", '"5"'))
      .resolves.toMatchObject({ etag: '"6"', value: { status: "revoked" } });
  });
});
