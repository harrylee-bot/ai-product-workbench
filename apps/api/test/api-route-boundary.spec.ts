import "reflect-metadata";
import { RequestMethod } from "@nestjs/common";
import { GUARDS_METADATA, HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { describe, expect, it, vi } from "vitest";
import { AuthController } from "../src/auth/auth.controller";
import { JwtAuthGuard } from "../src/auth/jwt-auth.guard";
import { UserRole, UserStatus } from "@prisma/client";
import { AuthenticatedShareController, ShareLinkController } from "../src/ai/share.controller";

describe("API route boundaries", () => {
  it("keeps share access under the authenticated share boundary", () => {
    expect(Reflect.getMetadata(PATH_METADATA, ShareLinkController)).toBe("share-links");
    expect(Reflect.getMetadata(PATH_METADATA, AuthenticatedShareController)).toBe("authenticated-share");
    expect(Reflect.getMetadata(PATH_METADATA, AuthenticatedShareController)).not.toBe("public/share");

    expect(Reflect.getMetadata(GUARDS_METADATA, AuthenticatedShareController)).toEqual([JwtAuthGuard]);
    expect(Reflect.getMetadata(PATH_METADATA, AuthenticatedShareController.prototype.resolve)).toBe(":token");
    expect(Reflect.getMetadata(METHOD_METADATA, AuthenticatedShareController.prototype.resolve)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(PATH_METADATA, AuthenticatedShareController.prototype.prototypeHtml)).toBe(":token/prototype");
  });

  it("keeps logout idempotent and quiet for expired sessions", () => {
    expect(Reflect.getMetadata(PATH_METADATA, AuthController)).toBe("auth");
    expect(Reflect.getMetadata(PATH_METADATA, AuthController.prototype.logout)).toBe("logout");
    expect(Reflect.getMetadata(METHOD_METADATA, AuthController.prototype.logout)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, AuthController.prototype.logout)).toBe(200);
    expect(Reflect.getMetadata(GUARDS_METADATA, AuthController.prototype.logout)).toBeUndefined();
    expect(Reflect.getMetadata(PATH_METADATA, AuthController.prototype.logoutAll)).toBe("logout-all");
    expect(Reflect.getMetadata(GUARDS_METADATA, AuthController.prototype.logoutAll)).toEqual([JwtAuthGuard]);
  });

  it("exposes registration capability without requiring a session", () => {
    expect(Reflect.getMetadata(PATH_METADATA, AuthController.prototype.registrationStatus)).toBe("registration-status");
    expect(Reflect.getMetadata(METHOD_METADATA, AuthController.prototype.registrationStatus)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(GUARDS_METADATA, AuthController.prototype.registrationStatus)).toBeUndefined();
  });

  it("still protects routes that require an authenticated user object", () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AuthController.prototype.me)).toEqual([JwtAuthGuard]);
    expect(Reflect.getMetadata(PATH_METADATA, AuthController.prototype.deleteMe)).toBe("me");
    expect(Reflect.getMetadata(METHOD_METADATA, AuthController.prototype.deleteMe)).toBe(RequestMethod.DELETE);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, AuthController.prototype.deleteMe)).toBe(200);
    expect(Reflect.getMetadata(GUARDS_METADATA, AuthController.prototype.deleteMe)).toEqual([JwtAuthGuard]);
    expect(Reflect.getMetadata(GUARDS_METADATA, ShareLinkController)).toEqual([JwtAuthGuard]);
  });

  it("clears the auth cookie only after self-deletion succeeds", async () => {
    const auth = { deleteMe: vi.fn().mockResolvedValue({ success: true }) };
    const response = { clearCookie: vi.fn() };
    const controller = new AuthController(auth as never);
    const user = {
      id: "user-1",
      username: "smoke-user",
      displayName: "Smoke",
      role: UserRole.user,
      status: UserStatus.active,
    };

    await expect(controller.deleteMe(user, response as never)).resolves.toEqual({
      success: true,
    });
    expect(auth.deleteMe).toHaveBeenCalledWith(user);
    expect(response.clearCookie).toHaveBeenCalledWith(
      "access_token",
      expect.objectContaining({ httpOnly: true, path: "/" }),
    );
  });
});
