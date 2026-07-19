export function isWorkbenchPublicRegistrationEnabled(
  environment: {
    NODE_ENV?: string;
    WORKBENCH_PUBLIC_REGISTRATION_ENABLED?: string;
  } = process.env,
) {
  const configured = environment.WORKBENCH_PUBLIC_REGISTRATION_ENABLED?.trim().toLowerCase();
  if (configured === "true") return true;
  if (configured === "false") return false;
  if (configured) throw new Error("WORKBENCH_PUBLIC_REGISTRATION_ENABLED must be true or false");
  return environment.NODE_ENV !== "production";
}
