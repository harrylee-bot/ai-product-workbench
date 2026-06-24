import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ProjectStatus, PrototypeArtifactStatus, ShareLinkStatus, ShareScope, UserRole, UserStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ShareService } from "../src/ai/share.service";

describe("ShareService", () => {
  const prisma = {
    project: { findUnique: vi.fn() },
    shareLink: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    requirementDocument: { findFirst: vi.fn() },
    prototypeArtifact: { findFirst: vi.fn() },
  };
  const stateService = { getCurrentState: vi.fn() };
  const documentService = { getCurrentForProject: vi.fn() };
  const prototypeService = { getCurrentForProject: vi.fn() };
  const service = new ShareService(
    prisma as never,
    stateService as never,
    documentService as never,
    prototypeService as never,
  );
  const user = {
    id: "user-1",
    username: "owner",
    displayName: "Owner",
    role: UserRole.user,
    status: UserStatus.active,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a share link only when the requested artifacts are ready", async () => {
    prisma.project.findUnique.mockResolvedValue({
      id: "project-1",
      ownerId: "user-1",
      title: "签到活动",
      status: ProjectStatus.prototype_ready,
      deletedAt: null,
    });
    stateService.getCurrentState.mockResolvedValue({ id: "state-1", title: "签到活动" });
    documentService.getCurrentForProject.mockResolvedValue({ document: { id: "prd-1" } });
    prototypeService.getCurrentForProject.mockResolvedValue({
      artifact: { id: "artifact-1", status: PrototypeArtifactStatus.ready },
    });
    prisma.shareLink.create.mockResolvedValue({
      id: "share-1",
      token: "tok-abc",
      projectId: "project-1",
      scope: ShareScope.both,
      status: ShareLinkStatus.active,
      title: "签到活动",
      prdDocumentId: "prd-1",
      prototypeArtifactId: "artifact-1",
      productDesignStateId: "state-1",
      expiresAt: null,
      viewCount: 0,
      lastViewedAt: null,
      revokedAt: null,
      createdBy: "user-1",
      createdAt: new Date("2026-06-24T00:00:00.000Z"),
      updatedAt: new Date("2026-06-24T00:00:00.000Z"),
    });

    const result = await service.createForUser(user, { projectId: "project-1", scope: ShareScope.both });

    expect(result.share).toMatchObject({
      id: "share-1",
      token: "tok-abc",
      scope: ShareScope.both,
      status: ShareLinkStatus.active,
      url: "/share/tok-abc",
    });
  });

  it("refuses to share a prototype that is not ready", async () => {
    prisma.project.findUnique.mockResolvedValue({
      id: "project-1",
      ownerId: "user-1",
      title: "签到活动",
      status: ProjectStatus.prd_ready,
      deletedAt: null,
    });
    stateService.getCurrentState.mockResolvedValue({ id: "state-1", title: "签到活动" });
    documentService.getCurrentForProject.mockResolvedValue({ document: { id: "prd-1" } });
    prototypeService.getCurrentForProject.mockResolvedValue({ artifact: null });

    await expect(
      service.createForUser(user, { projectId: "project-1", scope: ShareScope.both }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("resolves public payload read-only and increments view count", async () => {
    prisma.shareLink.findUnique.mockResolvedValue({
      id: "share-1",
      token: "tok-abc",
      projectId: "project-1",
      scope: ShareScope.both,
      status: ShareLinkStatus.active,
      title: "签到活动",
      prdDocumentId: "prd-1",
      prototypeArtifactId: "artifact-1",
      expiresAt: null,
    });
    prisma.project.findUnique.mockResolvedValue({
      id: "project-1",
      ownerId: "user-1",
      title: "签到活动",
      status: ProjectStatus.prototype_ready,
      deletedAt: null,
    });
    prisma.requirementDocument.findFirst.mockResolvedValue({
      id: "prd-1",
      title: "签到活动 PRD",
      sections: [{ title: "背景", content: "签到背景" }],
      updatedAt: new Date("2026-06-24T00:00:00.000Z"),
    });
    prisma.prototypeArtifact.findFirst.mockResolvedValue({
      id: "artifact-1",
      title: "签到原型",
      status: PrototypeArtifactStatus.ready,
      htmlContent: "<!doctype html><html><body>签到</body></html>",
      pageCount: 1,
      updatedAt: new Date("2026-06-24T00:00:00.000Z"),
    });
    prisma.shareLink.update.mockResolvedValue({});

    const result = await service.resolvePublic("tok-abc");

    expect(result.readOnly).toBe(true);
    expect(result.allowDownload).toBe(false);
    expect(result.allowEdit).toBe(false);
    expect(result.prd?.title).toBe("签到活动 PRD");
    expect(result.prototype?.html).toContain("<!doctype html>");
    expect(prisma.shareLink.update).toHaveBeenCalledWith({
      where: { id: "share-1" },
      data: { viewCount: { increment: 1 }, lastViewedAt: expect.any(Date) },
    });
  });

  it("treats revoked links as not found", async () => {
    prisma.shareLink.findUnique.mockResolvedValue({
      id: "share-1",
      token: "tok-abc",
      projectId: "project-1",
      scope: ShareScope.both,
      status: ShareLinkStatus.revoked,
      expiresAt: null,
    });

    await expect(service.resolvePublic("tok-abc")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("treats expired links as not found", async () => {
    prisma.shareLink.findUnique.mockResolvedValue({
      id: "share-1",
      token: "tok-abc",
      projectId: "project-1",
      scope: ShareScope.both,
      status: ShareLinkStatus.active,
      expiresAt: new Date("2000-01-01T00:00:00.000Z"),
    });

    await expect(service.resolvePublic("tok-abc")).rejects.toBeInstanceOf(NotFoundException);
  });
});
