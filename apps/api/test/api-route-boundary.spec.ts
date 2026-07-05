import "reflect-metadata";
import { RequestMethod } from "@nestjs/common";
import { GUARDS_METADATA, HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { describe, expect, it } from "vitest";
import { AuthController } from "../src/auth/auth.controller";
import { JwtAuthGuard } from "../src/auth/jwt-auth.guard";
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
  });

  it("still protects routes that require an authenticated user object", () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AuthController.prototype.me)).toEqual([JwtAuthGuard]);
    expect(Reflect.getMetadata(GUARDS_METADATA, ShareLinkController)).toEqual([JwtAuthGuard]);
  });
});
