import { ForbiddenException } from "@nestjs/common";
import { UserRole, UserStatus } from "@prisma/client";
import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../src/modules/auth/auth.service";

describe("AuthService", () => {
  const prisma = {
    user: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  };
  const jwtService = {
    signAsync: vi.fn(),
    verifyAsync: vi.fn(),
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
    );

    expect(result.accessToken).toBe("signed-token");
    expect(result.user).toMatchObject({
      id: "user-1",
      username: "zhangsan",
      role: UserRole.user,
      status: UserStatus.active,
    });
    expect(result.user).not.toHaveProperty("passwordHash");
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
      service.login({ account: "zhangsan", password: "User123456" }),
    ).rejects.toThrow(ForbiddenException);
  });

  it("uses one message for missing account and bad password", async () => {
    prisma.user.findFirst.mockResolvedValue(null);

    await expect(
      service.login({ account: "missing", password: "bad" }),
    ).rejects.toThrow("账号或密码错误");
  });

  it("returns an empty session without token or invalid token", async () => {
    await expect(service.session()).resolves.toBeNull();

    jwtService.verifyAsync.mockRejectedValue(new Error("bad token"));
    await expect(service.session("bad-token")).resolves.toBeNull();
  });

  it("returns the active user for a valid session token", async () => {
    jwtService.verifyAsync.mockResolvedValue({ sub: "user-1", userId: "user-1", role: UserRole.user });
    prisma.user.findUnique.mockResolvedValue({
      id: "user-1",
      username: "zhangsan",
      email: "zhangsan@example.local",
      displayName: "张三",
      passwordHash: "hidden",
      role: UserRole.user,
      status: UserStatus.active,
      lastLoginAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(service.session("good-token")).resolves.toMatchObject({
      id: "user-1",
      username: "zhangsan",
      status: UserStatus.active,
    });
  });
});
