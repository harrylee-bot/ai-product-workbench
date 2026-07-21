export const WORKBENCH_CANONICAL_CLIENT_IP_HEADER = "x-workbench-client-ip";

export type WorkbenchAuthIpAddressOptions = {
  ipAddressHeaders: string[];
  ipv6Subnet: number;
};

export function workbenchAuthIpAddressOptions(
  env: NodeJS.ProcessEnv = process.env,
): WorkbenchAuthIpAddressOptions {
  const configuredHeader = env.WORKBENCH_AUTH_CLIENT_IP_HEADER?.trim().toLowerCase();
  const isProductionRuntime =
    env.NODE_ENV === "production" && env.NEXT_PHASE !== "phase-production-build";

  if (!configuredHeader && isProductionRuntime) {
    throw new Error(
      `WORKBENCH_AUTH_CLIENT_IP_HEADER is required in production and must be ${WORKBENCH_CANONICAL_CLIENT_IP_HEADER}`,
    );
  }
  if (
    configuredHeader
    && configuredHeader !== WORKBENCH_CANONICAL_CLIENT_IP_HEADER
  ) {
    throw new Error(
      `WORKBENCH_AUTH_CLIENT_IP_HEADER must be ${WORKBENCH_CANONICAL_CLIENT_IP_HEADER}`,
    );
  }

  return {
    // The origin replaces this single-value header only after authenticating
    // the dedicated Edge over WireGuard.
    // Never fall back to end-user-controlled forwarding headers here.
    ipAddressHeaders: [WORKBENCH_CANONICAL_CLIENT_IP_HEADER],
    ipv6Subnet: 64,
  };
}
