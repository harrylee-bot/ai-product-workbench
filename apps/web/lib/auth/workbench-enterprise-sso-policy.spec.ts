import { describe, expect, it } from "vitest";

import { isWorkbenchEnterpriseSsoEnabled } from "./workbench-enterprise-sso-policy";

describe("Workbench enterprise SSO policy", () => {
  it.each([
    [undefined, false],
    ["false", false],
    ["true", true],
    [" TRUE ", true],
  ])("resolves %s to %s", (configured, expected) => {
    expect(isWorkbenchEnterpriseSsoEnabled({
      WORKBENCH_ENTERPRISE_SSO_ENABLED: configured,
    })).toBe(expected);
  });

  it("rejects ambiguous values", () => {
    expect(() => isWorkbenchEnterpriseSsoEnabled({
      WORKBENCH_ENTERPRISE_SSO_ENABLED: "1",
    })).toThrow("WORKBENCH_ENTERPRISE_SSO_ENABLED must be true or false");
  });
});
