import { ForbiddenException } from "@nestjs/common";
import { UserRole, UserStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { ConstraintController } from "../src/constraint/constraint.controller";

describe("ConstraintController ownership", () => {
  const admin = {
    id: "admin-1",
    username: "admin",
    displayName: "Admin",
    role: UserRole.admin,
    status: UserStatus.active,
  };

  it("does not let an admin mutate another user's conversation through the ordinary build route", async () => {
    const prisma = {
      conversation: {
        findUnique: vi.fn().mockResolvedValue({
          id: "conversation-1",
          ownerId: "user-1",
          status: "active",
          deletedAt: null,
        }),
      },
    };
    const constraints = { build: vi.fn(), context: vi.fn() };
    const controller = new ConstraintController(prisma as never, constraints as never);

    await expect(controller.build(admin, {
      conversationId: "conversation-1",
      input: "重建约束",
    })).rejects.toThrow(ForbiddenException);
    expect(constraints.build).not.toHaveBeenCalled();
  });

  it("retains admin read access to constraint context", async () => {
    const prisma = {
      conversation: {
        findUnique: vi.fn().mockResolvedValue({
          id: "conversation-1",
          ownerId: "user-1",
          status: "active",
          deletedAt: null,
        }),
      },
    };
    const constraints = { build: vi.fn(), context: vi.fn().mockResolvedValue({ mustFollow: [] }) };
    const controller = new ConstraintController(prisma as never, constraints as never);

    await expect(controller.context(admin, "conversation-1")).resolves.toEqual({ mustFollow: [] });
  });
});
