import { UserRole, UserStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminUsersService } from "../src/admin-users/admin-users.service";

describe("AdminUsersService authVersion invalidation", () => {
  const prisma = {
    user: { update: vi.fn() },
  };
  const audit = { record: vi.fn() };
  const service = new AdminUsersService(prisma as never, audit as never);
  const admin = {
    id: "admin-1",
    username: "admin",
    email: "admin@example.local",
    displayName: "Admin",
    role: UserRole.admin,
    status: UserStatus.active,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.user.update.mockResolvedValue(userRecord());
  });

  it("increments authVersion when disabling or enabling a user", async () => {
    await service.disableUser("user-1", admin);
    expect(prisma.user.update).toHaveBeenLastCalledWith({
      where: { id: "user-1" },
      data: {
        status: UserStatus.disabled,
        authVersion: { increment: 1 },
      },
    });

    await service.enableUser("user-1", admin);
    expect(prisma.user.update).toHaveBeenLastCalledWith({
      where: { id: "user-1" },
      data: {
        status: UserStatus.active,
        authVersion: { increment: 1 },
      },
    });
  });

  it("increments authVersion in the same update as a password reset", async () => {
    await service.resetPassword("user-1", "User123456", admin);

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: {
        passwordHash: expect.any(String),
        authVersion: { increment: 1 },
      },
    });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: "user.reset_password",
      detail: undefined,
    }));
  });

  it("invalidates sessions for role/status changes but not profile-only changes", async () => {
    await service.updateUser("user-1", { role: UserRole.admin }, admin);
    expect(prisma.user.update).toHaveBeenLastCalledWith({
      where: { id: "user-1" },
      data: expect.objectContaining({ authVersion: { increment: 1 } }),
    });

    await service.updateUser("user-1", { displayName: "New name" }, admin);
    expect(prisma.user.update).toHaveBeenLastCalledWith({
      where: { id: "user-1" },
      data: expect.objectContaining({ authVersion: undefined }),
    });
  });
});

function userRecord(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-07-11T00:00:00.000Z");
  return {
    id: "user-1",
    username: "user",
    email: "user@example.local",
    displayName: "User",
    passwordHash: "hidden",
    role: UserRole.user,
    status: UserStatus.active,
    authVersion: 0,
    lastLoginAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
