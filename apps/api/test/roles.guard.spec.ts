import { ForbiddenException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import { UserRole, UserStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { RolesGuard } from "../src/auth/roles.guard";

function createContext(role: UserRole): ExecutionContext {
  return {
    getHandler: vi.fn(),
    getClass: vi.fn(),
    switchToHttp: () => ({
      getRequest: () => ({
        user: {
          id: "user-1",
          username: "zhangsan",
          displayName: "张三",
          role,
          status: UserStatus.active,
        },
      }),
    }),
  } as unknown as ExecutionContext;
}

describe("RolesGuard", () => {
  it("allows admins to access admin routes", () => {
    const reflector = {
      getAllAndOverride: vi.fn().mockReturnValue([UserRole.admin]),
    };
    const guard = new RolesGuard(reflector as never);

    expect(guard.canActivate(createContext(UserRole.admin))).toBe(true);
  });

  it("rejects normal users from admin routes", () => {
    const reflector = {
      getAllAndOverride: vi.fn().mockReturnValue([UserRole.admin]),
    };
    const guard = new RolesGuard(reflector as never);

    expect(() => guard.canActivate(createContext(UserRole.user))).toThrow(ForbiddenException);
  });
});
