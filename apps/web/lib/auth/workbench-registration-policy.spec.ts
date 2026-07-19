import { describe, expect, it } from "vitest";

import { isWorkbenchPublicRegistrationEnabled } from "./workbench-registration-policy";

describe("Workbench public registration policy", () => {
  it("fails closed when production has no explicit policy", () => {
    expect(isWorkbenchPublicRegistrationEnabled({ NODE_ENV: "production" })).toBe(false);
  });

  it.each([
    ["true", true],
    ["false", false],
    [" TRUE ", true],
  ])("accepts the exact boolean policy %s", (configured, expected) => {
    expect(isWorkbenchPublicRegistrationEnabled({
      NODE_ENV: "production",
      WORKBENCH_PUBLIC_REGISTRATION_ENABLED: configured,
    })).toBe(expected);
  });

  it("rejects ambiguous production policy values", () => {
    expect(() => isWorkbenchPublicRegistrationEnabled({
      NODE_ENV: "production",
      WORKBENCH_PUBLIC_REGISTRATION_ENABLED: "1",
    })).toThrow("WORKBENCH_PUBLIC_REGISTRATION_ENABLED must be true or false");
  });

  it("keeps local development registration available by default", () => {
    expect(isWorkbenchPublicRegistrationEnabled({ NODE_ENV: "development" })).toBe(true);
  });
});
