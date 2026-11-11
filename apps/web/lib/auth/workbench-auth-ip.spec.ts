import { getIP, getIPFromHeader } from "@better-auth/core/utils/ip";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import {
  WORKBENCH_CANONICAL_CLIENT_IP_HEADER,
  workbenchAuthIpAddressOptions,
} from "./workbench-auth-ip";

describe("Workbench Better Auth client IP trust", () => {
  it("fails closed when production runtime configuration is absent", () => {
    expect(() => workbenchAuthIpAddressOptions({ NODE_ENV: "production" }))
      .toThrow(/WORKBENCH_AUTH_CLIENT_IP_HEADER is required/);
  });

  it("permits the fixed build-time contract without weakening runtime validation", () => {
    expect(workbenchAuthIpAddressOptions({
      NODE_ENV: "production",
      NEXT_PHASE: "phase-production-build",
    })).toEqual({
      ipAddressHeaders: [WORKBENCH_CANONICAL_CLIENT_IP_HEADER],
      ipv6Subnet: 64,
    });
  });

  it("rejects forwarding and Edge source headers as application trust roots", () => {
    for (const configuredHeader of ["x-forwarded-for", "x-workbench-edge-client-ip"]) {
      expect(() => workbenchAuthIpAddressOptions({
        NODE_ENV: "production",
        WORKBENCH_AUTH_CLIENT_IP_HEADER: configuredHeader,
      })).toThrow(`must be ${WORKBENCH_CANONICAL_CLIENT_IP_HEADER}`);
    }
  });

  it("reads a valid IPv4 address only from the canonical header", () => {
    const headers = new Headers({
      [WORKBENCH_CANONICAL_CLIENT_IP_HEADER]: "203.0.113.42",
      "x-workbench-edge-client-ip": "198.51.100.9",
      "x-forwarded-for": "198.51.100.10, 172.24.0.1",
    });

    expect(getIP(headers, {
      advanced: { ipAddress: workbenchAuthIpAddressOptions({ NODE_ENV: "test" }) },
    })).toBe("203.0.113.42");
  });

  it("normalizes a valid IPv6 address to the configured /64 bucket", () => {
    expect(getIPFromHeader("2001:db8:1234:5678:abcd::42", {
      ipv6Subnet: 64,
    })).toBe("2001:0db8:1234:5678:0000:0000:0000:0000");
  });

  it("returns null in production when the canonical header is missing", () => {
    const { TEST: _test, ...productionEnv } = process.env;
    const output = execFileSync(process.execPath, [
      "--input-type=module",
      "--eval",
      [
        'import { getIP } from "@better-auth/core/utils/ip";',
        "const headers = new Headers({",
        '  "x-workbench-edge-client-ip": "198.51.100.9",',
        '  "x-forwarded-for": "198.51.100.10, 172.24.0.1",',
        "});",
        "const value = getIP(headers, { advanced: { ipAddress: {",
        `  ipAddressHeaders: ["${WORKBENCH_CANONICAL_CLIENT_IP_HEADER}"],`,
        "  ipv6Subnet: 64,",
        "} } });",
        "process.stdout.write(JSON.stringify(value));",
      ].join("\n"),
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...productionEnv, NODE_ENV: "production" },
    });

    expect(output).toBe("null");
  });

  it.each([
    ["empty", ""],
    ["multiple", "203.0.113.42, 172.24.0.1"],
    ["invalid", "not-an-ip"],
  ])("rejects a %s canonical header value", (_case, value) => {
    expect(getIPFromHeader(value, { ipv6Subnet: 64 })).toBeNull();
  });
});
