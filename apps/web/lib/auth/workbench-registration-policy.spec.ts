import { describe, expect, it } from "vitest";

import { isWorkbenchPublicRegistrationEnabled } from "./workbench-registration-policy";

describe("Workbench public registration policy", () => {
  it("fails closed when production has no explicit policy", () => {
    expect(isWorkbenchPublicRegistrationEnabled({ NODE_ENV: "production" })).toBe(false);
  });

  it.each([
    ["true", true],
    ["false", false],
  ])("accepts the exact boolean policy %s", (configured, expected) => {
    expect(isWorkbenchPublicRegistrationEnabled({
      NODE_ENV: "production",
      WORKBENCH_PUBLIC_REGISTRATION_ENABLED: configured,
    })).toBe(expected);
  });

  it.each(["1", "TRUE", " TRUE ", "true ", "true\n"])("rejects ambiguous production policy value %j", (configured) => {
    expect(() => isWorkbenchPublicRegistrationEnabled({
      NODE_ENV: "production",
      WORKBENCH_PUBLIC_REGISTRATION_ENABLED: configured,
    })).toThrow("WORKBENCH_PUBLIC_REGISTRATION_ENABLED must be true or false");
  });

  it("keeps local development registration available by default", () => {
    expect(isWorkbenchPublicRegistrationEnabled({ NODE_ENV: "development" })).toBe(true);
  });
});
