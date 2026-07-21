export function isWorkbenchEnterpriseSsoEnabled(
  environment: {
    NODE_ENV?: string;
    WORKBENCH_ENTERPRISE_SSO_ENABLED?: string;
  } = process.env,
): boolean {
  const configured = environment.WORKBENCH_ENTERPRISE_SSO_ENABLED?.trim().toLowerCase();
  if (!configured || configured === "false") return false;
  if (configured === "true") return true;
  throw new Error("WORKBENCH_ENTERPRISE_SSO_ENABLED must be true or false");
}
