import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { UserRole, UserStatus } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JwtStrategy } from "../src/auth/jwt.strategy";

describe("JwtStrategy authVersion", () => {
  const prisma = { user: { findUnique: vi.fn() } };

  beforeEach(() => {
    vi.stubEnv("JWT_SECRET", "test-secret-with-enough-entropy");
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts a legacy token only while the user remains on version zero", async () => {
    prisma.user.findUnique.mockResolvedValue(userRecord({ authVersion: 0 }));
    const strategy = new JwtStrategy(prisma as never, { get: vi.fn() } as never);

    await expect(strategy.validate({
      sub: "user-1",
      userId: "user-1",
      role: UserRole.user,
    })).resolves.toMatchObject({ id: "user-1" });
  });

  it("rejects a token after authVersion changes", async () => {
    prisma.user.findUnique.mockResolvedValue(userRecord({ authVersion: 2 }));
    const strategy = new JwtStrategy(prisma as never, { get: vi.fn() } as never);

    await expect(strategy.validate({
      sub: "user-1",
      userId: "user-1",
      role: UserRole.user,
      authVersion: 1,
    })).rejects.toThrow(UnauthorizedException);
  });

  it("does not revive an old token after a disabled user is enabled again", async () => {
    prisma.user.findUnique
      .mockResolvedValueOnce(userRecord({ status: UserStatus.disabled, authVersion: 1 }))
      .mockResolvedValueOnce(userRecord({ status: UserStatus.active, authVersion: 2 }));
    const strategy = new JwtStrategy(prisma as never, { get: vi.fn() } as never);
    const oldPayload = {
      sub: "user-1",
      userId: "user-1",
      role: UserRole.user,
      authVersion: 0,
    };

    await expect(strategy.validate(oldPayload)).rejects.toThrow(ForbiddenException);
    await expect(strategy.validate(oldPayload)).rejects.toThrow(UnauthorizedException);
  });

  it("continues to reject disabled users explicitly", async () => {
    prisma.user.findUnique.mockResolvedValue(userRecord({ status: UserStatus.disabled, authVersion: 2 }));
    const strategy = new JwtStrategy(prisma as never, { get: vi.fn() } as never);

    await expect(strategy.validate({
      sub: "user-1",
      userId: "user-1",
      role: UserRole.user,
      authVersion: 2,
    })).rejects.toThrow(ForbiddenException);
  });
});

function userRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-1",
    username: "zhangsan",
    email: "zhangsan@example.local",
    displayName: "张三",
    passwordHash: "hidden",
    role: UserRole.user,
    status: UserStatus.active,
    authVersion: 0,
    lastLoginAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}
