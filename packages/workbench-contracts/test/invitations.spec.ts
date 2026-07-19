import { describe, expect, it } from "vitest";
import {
  createProjectInvitationRequestSchema,
  projectInvitationListItemSchema,
  projectInvitationSchema,
  projectInvitationTokenSchema,
} from "../src/invitations.js";

const pendingInvitation = {
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

const token = `wbi_${Buffer.from("00000000-0000-4000-8000-000000000000").toString("base64url")}.${"a".repeat(43)}`;

describe("Project invitation contracts", () => {
  it("normalizes invitation email addresses at the request boundary", () => {
    expect(createProjectInvitationRequestSchema.parse({
      email: "  Person@Example.COM ",
      role: "viewer",
    })).toEqual({ email: "person@example.com", role: "viewer" });
  });

  it("binds accepting identity and timestamps to the accepted state", () => {
    expect(projectInvitationSchema.safeParse({
      ...pendingInvitation,
      status: "accepted",
      acceptedById: null,
      acceptedAt: null,
    }).success).toBe(false);

    expect(projectInvitationSchema.parse({
      ...pendingInvitation,
      status: "accepted",
      acceptedById: "principal-2",
      acceptedAt: "2026-07-16T00:00:00.000Z",
    })).toMatchObject({ status: "accepted", acceptedById: "principal-2" });
  });

  it("exposes signed tokens only for pending owner-list projections", () => {
    expect(projectInvitationTokenSchema.parse(token)).toBe(token);
    expect(projectInvitationListItemSchema.parse({
      invitation: pendingInvitation,
      token,
    })).toMatchObject({ token });
    expect(projectInvitationListItemSchema.safeParse({
      invitation: { ...pendingInvitation, status: "expired" },
      token,
    }).success).toBe(false);
  });
});
