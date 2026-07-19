import { hashRequest } from "../src/common/idempotency.js";
import { ProjectInvitationsController } from "../src/modules/projects/project-invitations.controller.js";
import {
  decodeProjectInvitationCursor,
  encodeProjectInvitationCursor,
  normalizeProjectInvitationEmail,
  ProjectInvitationsService,
} from "../src/modules/projects/project-invitations.service.js";
import { ProjectInvitationTokenService } from "../src/modules/projects/project-invitation-token.service.js";

const now = new Date("2026-07-15T08:00:00.000Z");
const invitationId = "00000000-0000-4000-8000-000000000001";
const secret = Buffer.alloc(32, 41).toString("base64url");

describe("Project invitation token service", () => {
  it("reproduces an invitation token and verifies a retained rotation key", () => {
    const previous = Buffer.alloc(32, 17).toString("base64url");
    const oldTokens = tokenService(previous);
    const old = oldTokens.issue(invitationId);
    const rotated = tokenService(secret, previous);

    expect(oldTokens.issue(invitationId, old.keyId)).toEqual(old);
    expect(rotated.verify(old.token)).toEqual({ invitationId, keyId: old.keyId });
    expect(rotated.verify(`${old.token.slice(0, -1)}x`)).toBeNull();
  });
});

describe("Project invitations service", () => {
  beforeEach(() => vi.useFakeTimers({ now }));
  afterEach(() => vi.useRealTimers());

  it("replays the same idempotent create even after the Project revision advances", async () => {
    const tokens = tokenService();
    const issued = tokens.issue(invitationId);
    const replay = invitationRecord({
      id: invitationId,
      tokenHash: tokens.hash(issued.token),
      tokenKeyId: issued.keyId,
      requestHash: hashRequest({ email: "invitee@example.com", role: "editor" }),
    });
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{
        id: "project-1",
        workspaceId: "workspace-1",
        revision: 9,
      }]),
      projectMember: { findUnique: vi.fn().mockResolvedValue({ role: "owner" }) },
      projectInvitation: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findFirst: vi.fn().mockResolvedValue(replay),
      },
    };
    const service = invitationService({ $transaction: vi.fn((callback) => callback(tx)) }, tokens);

    await expect(service.create(
      "owner-1",
      "project-1",
      3,
      "invite-key-123",
      { email: "Invitee@Example.com", role: "editor" },
    )).resolves.toMatchObject({
      projectRevision: 9,
      response: {
        invitation: { id: invitationId, email: "invitee@example.com" },
        token: issued.token,
        deliveryStatus: "not_configured",
      },
    });
  });

  it("creates a normalized pending invitation and advances the Project CAS revision", async () => {
    const tokens = tokenService();
    const tx = {
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([{ id: "project-1", workspaceId: "workspace-1", revision: 3 }])
        .mockResolvedValueOnce([{ exists: false }]),
      projectMember: { findUnique: vi.fn().mockResolvedValue({ role: "owner" }) },
      projectInvitation: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findFirst: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(null),
        create: vi.fn(async ({ data }) => invitationRecord({
          ...data,
          createdAt: now,
          updatedAt: now,
        })),
      },
      project: { update: vi.fn().mockResolvedValue({ revision: 4 }) },
    };
    const service = invitationService({ $transaction: vi.fn((callback) => callback(tx)) }, tokens);

    const result = await service.create(
      "owner-1",
      "project-1",
      3,
      "invite-key-123",
      { email: " INVITEE@EXAMPLE.COM ", role: "viewer" },
    );

    expect(result).toMatchObject({
      projectRevision: 4,
      response: {
        invitation: { email: "invitee@example.com", role: "viewer", status: "pending" },
        deliveryStatus: "not_configured",
      },
    });
    expect(tx.projectInvitation.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        email: "invitee@example.com",
        workspaceId: "workspace-1",
        role: "viewer",
      }),
    }));
  });

  it("rejects acceptance by a signed-in account with a different normalized email", async () => {
    const tokens = tokenService();
    const issued = tokens.issue(invitationId);
    const invitation = invitationRecord({
      id: invitationId,
      tokenHash: tokens.hash(issued.token),
      tokenKeyId: issued.keyId,
    });
    const db = {
      projectInvitation: { findUnique: vi.fn().mockResolvedValue(invitation) },
      $transaction: vi.fn(),
    };
    const service = invitationService(db, tokens);

    await expect(service.accept(principal("different@example.com"), issued.token))
      .rejects.toMatchObject({ status: 409 });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("accepts only into the target Project with the invited role", async () => {
    const tokens = tokenService();
    const issued = tokens.issue(invitationId);
    const pending = invitationRecord({
      id: invitationId,
      tokenHash: tokens.hash(issued.token),
      tokenKeyId: issued.keyId,
      role: "editor",
    });
    const accepted = invitationRecord({
      ...pending,
      status: "accepted",
      acceptedById: "principal-2",
      acceptedAt: now,
      revision: 1,
    });
    const projectMember = {
      projectId: "project-1",
      workspaceId: "workspace-1",
      principalId: "principal-2",
      role: "editor",
      createdAt: now,
      updatedAt: now,
      principal: { displayName: "Invitee", email: "invitee@example.com" },
    };
    const tx = {
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([{ id: "project-1", workspaceId: "workspace-1", revision: 3 }])
        .mockResolvedValueOnce([{ id: invitationId }]),
      projectInvitation: {
        findUnique: vi.fn().mockResolvedValue(pending),
        update: vi.fn().mockResolvedValue(accepted),
      },
      projectMember: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(projectMember),
      },
      workspaceMember: { upsert: vi.fn() },
      project: { update: vi.fn().mockResolvedValue({ revision: 4 }) },
    };
    const db = {
      projectInvitation: { findUnique: vi.fn().mockResolvedValue(pending) },
      $transaction: vi.fn((callback) => callback(tx)),
    };
    const service = invitationService(db, tokens);

    await expect(service.accept(principal("Invitee@Example.com"), issued.token))
      .resolves.toMatchObject({
        projectRevision: 4,
        response: {
          invitation: { status: "accepted", acceptedById: "principal-2" },
          member: { principalId: "principal-2", role: "editor" },
        },
      });
    expect(tx.workspaceMember.upsert).not.toHaveBeenCalled();
    expect(tx.projectMember.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ role: "editor", principalId: "principal-2" }),
    }));
  });

  it("binds list cursors to the Project and status filter", () => {
    const cursor = encodeProjectInvitationCursor({
      version: 1,
      projectId: "project-1",
      status: "pending",
      createdAt: now.toISOString(),
      id: invitationId,
    });
    expect(decodeProjectInvitationCursor(cursor)).toEqual({
      version: 1,
      projectId: "project-1",
      status: "pending",
      createdAt: now.toISOString(),
      id: invitationId,
    });

    const controller = new ProjectInvitationsController({} as never);
    expect(() => controller.list(
      principal("owner@example.com") as never,
      "project-1",
      { status: ["pending", "expired"] },
    )).toThrow(expect.objectContaining({ status: 400 }));
  });
});

function tokenService(current = secret, previous?: string) {
  return new ProjectInvitationTokenService({
    get: (name: string) => {
      if (name === "WORKBENCH_INVITATION_TOKEN_SECRET") return current;
      if (name === "WORKBENCH_INVITATION_TOKEN_PREVIOUS_SECRETS") return previous;
      return undefined;
    },
  } as never);
}

function invitationService(db: unknown, tokens = tokenService()) {
  return new ProjectInvitationsService(
    db as never,
    tokens,
    { get: vi.fn().mockReturnValue("168") } as never,
  );
}

function principal(email: string) {
  return {
    id: "principal-2",
    issuer: "test",
    subject: "principal-2",
    email,
    displayName: "Invitee",
    defaultWorkspaceId: "personal-2",
  };
}

function invitationRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: invitationId,
    projectId: "project-1",
    workspaceId: "workspace-1",
    email: "invitee@example.com",
    role: "editor" as const,
    status: "pending" as const,
    deliveryStatus: "not_configured" as const,
    createdById: "owner-1",
    acceptedById: null,
    idempotencyKey: "invite-key-123",
    requestHash: hashRequest({ email: "invitee@example.com", role: "editor" }),
    tokenHash: "0".repeat(64),
    tokenKeyId: "0".repeat(16),
    revision: 0,
    expiresAt: new Date("2026-07-22T08:00:00.000Z"),
    acceptedAt: null,
    revokedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("Project invitation email normalization", () => {
  it("normalizes Unicode width, whitespace, and case once at the domain boundary", () => {
    expect(normalizeProjectInvitationEmail("  INVITEE＠EXAMPLE.COM  "))
      .toBe("invitee@example.com");
  });
});
