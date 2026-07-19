export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { workbenchAuthIpAddressOptions } = await import(
    "@/lib/auth/workbench-auth-ip"
  );
  workbenchAuthIpAddressOptions();
  const { initializeTelemetry } = await import("@workbench/workbench-telemetry");
  initializeTelemetry({ serviceName: "workbench-web-bff" });
}
