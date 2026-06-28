import { ProjectStatus, UserRole, UserStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VersionHistoryService } from "../src/ai/version-history.service";

describe("VersionHistoryService", () => {
  const prisma = {
    project: { findUnique: vi.fn() },
    productDesignVersion: { findMany: vi.fn() },
    requirementDocumentVersion: { findMany: vi.fn() },
    prototypeVersion: { findMany: vi.fn() },
    qAReport: { findMany: vi.fn() },
    rollbackRecord: { findMany: vi.fn() },
    $transaction: vi.fn(),
  };
  const service = new VersionHistoryService(prisma as never);
  const user = {
    id: "user-1",
    username: "owner",
    displayName: "Owner",
    role: UserRole.user,
    status: UserStatus.active,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.project.findUnique.mockResolvedValue({
      id: "project-1",
      ownerId: "user-1",
      status: ProjectStatus.prototype_ready,
      deletedAt: null,
    });
    prisma.$transaction.mockImplementation(async (queries) => Promise.all(queries));
  });

  it("merges all version sources into a descending project timeline", async () => {
    prisma.productDesignVersion.findMany.mockResolvedValue([
      {
        id: "state-version-1",
        version: 2,
        reason: "更新状态",
        stateId: "state-1",
        createdBy: "user-1",
        createdAt: new Date("2026-06-28T08:00:00.000Z"),
      },
    ]);
    prisma.requirementDocumentVersion.findMany.mockResolvedValue([
      {
        id: "prd-version-1",
        version: 1,
        reason: "生成 PRD",
        documentId: "prd-1",
        createdBy: "user-1",
        createdAt: new Date("2026-06-28T08:01:00.000Z"),
      },
    ]);
    prisma.prototypeVersion.findMany.mockResolvedValue([
      {
        id: "prototype-version-1",
        version: 1,
        reason: "生成原型",
        artifactId: "artifact-1",
        createdBy: "user-1",
        createdAt: new Date("2026-06-28T08:02:00.000Z"),
      },
    ]);
    prisma.qAReport.findMany.mockResolvedValue([
      {
        id: "qa-1",
        status: "warning",
        summary: "存在提示",
        createdBy: "user-1",
        createdAt: new Date("2026-06-28T08:03:00.000Z"),
      },
    ]);
    prisma.rollbackRecord.findMany.mockResolvedValue([
      {
        id: "rollback-1",
        status: "succeeded",
        reason: null,
        fromProductDesignStateVersion: 3,
        toProductDesignStateVersion: 2,
        createdBy: "user-1",
        createdAt: new Date("2026-06-28T08:04:00.000Z"),
      },
    ]);

    const result = await service.listProjectTimeline(user, "project-1");

    expect(result.items.map((item) => item.type)).toEqual([
      "rollback",
      "qa",
      "prototype",
      "prd",
      "product_design_state",
    ]);
    expect(result.items[0]).toMatchObject({
      id: "rollback-1",
      title: "回滚 succeeded",
      description: "v3 -> v2",
      relatedId: "rollback-1",
    });
    expect(prisma.$transaction).toHaveBeenCalledWith([
      expect.any(Promise),
      expect.any(Promise),
      expect.any(Promise),
      expect.any(Promise),
      expect.any(Promise),
    ]);
  });

  it("allows admins and blocks non-owners", async () => {
    prisma.project.findUnique.mockResolvedValueOnce({
      id: "project-1",
      ownerId: "other-user",
      status: ProjectStatus.prototype_ready,
      deletedAt: null,
    });

    await expect(service.listProjectTimeline(user, "project-1")).rejects.toThrow("VERSION_FORBIDDEN");

    prisma.project.findUnique.mockResolvedValueOnce({
      id: "project-1",
      ownerId: "other-user",
      status: ProjectStatus.archived,
      deletedAt: null,
    });
    prisma.productDesignVersion.findMany.mockResolvedValue([]);
    prisma.requirementDocumentVersion.findMany.mockResolvedValue([]);
    prisma.prototypeVersion.findMany.mockResolvedValue([]);
    prisma.qAReport.findMany.mockResolvedValue([]);
    prisma.rollbackRecord.findMany.mockResolvedValue([]);

    await expect(service.listProjectTimeline({ ...user, role: UserRole.admin }, "project-1")).resolves.toEqual({ items: [] });
  });
});
