import { ForbiddenException } from "@nestjs/common";
import { UserRole, UserStatus } from "@prisma/client";
import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../src/auth/auth.service";

describe("AuthService", () => {
  const prisma = {
    user: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    loginAuditLog: {
      create: vi.fn(),
    },
  };
  const jwtService = {
    signAsync: vi.fn(),
  };
  const service = new AuthService(prisma as never, jwtService as never);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("logs in with username and returns an accessToken without passwordHash", async () => {
    const passwordHash = await bcrypt.hash("User123456", 4);
    const user = {
      id: "user-1",
      username: "zhangsan",
      email: "zhangsan@example.local",
      displayName: "张三",
      passwordHash,
      role: UserRole.user,
      status: UserStatus.active,
      lastLoginAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    prisma.user.findFirst.mockResolvedValue(user);
    prisma.user.update.mockResolvedValue({ ...user, lastLoginAt: new Date() });
    jwtService.signAsync.mockResolvedValue("signed-token");

    const result = await service.login(
      { account: "zhangsan", password: "User123456" },
      { ip: "127.0.0.1", userAgent: "vitest" },
    );

    expect(result.accessToken).toBe("signed-token");
    expect(result.user).toMatchObject({
      id: "user-1",
      username: "zhangsan",
      role: UserRole.user,
      status: UserStatus.active,
    });
    expect(result.user).not.toHaveProperty("passwordHash");
    expect(prisma.loginAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        account: "zhangsan",
        success: true,
      }),
    });
  });

  it("rejects disabled users with the required message", async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: "user-disabled",
      username: "zhangsan",
      email: "zhangsan@example.local",
      displayName: "张三",
      passwordHash: await bcrypt.hash("User123456", 4),
      role: UserRole.user,
      status: UserStatus.disabled,
      lastLoginAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(
      service.login({ account: "zhangsan", password: "User123456" }, {}),
    ).rejects.toThrow(ForbiddenException);

    expect(prisma.loginAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        account: "zhangsan",
        success: false,
        failReason: "当前账号已被禁用，请联系管理员",
      }),
    });
  });

  it("uses one message for missing account and bad password", async () => {
    prisma.user.findFirst.mockResolvedValue(null);

    await expect(
      service.login({ account: "missing", password: "bad" }, {}),
    ).rejects.toThrow("账号或密码错误");
  });
});
