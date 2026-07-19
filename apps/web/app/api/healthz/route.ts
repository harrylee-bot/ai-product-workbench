import { checkWorkbenchAuthStorage } from "@/lib/auth/workbench-auth.server";
import { tracedFetch } from "@workbench/workbench-telemetry";

const readinessCacheTtlMs = 2_000;
let cachedReadiness: { readonly expiresAt: number; readonly ready: boolean } | null = null;
let activeReadinessProbe: Promise<boolean> | null = null;

export async function GET(): Promise<Response> {
  if (await readiness()) {
    return Response.json(
      { status: "ready" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  return Response.json(
    { status: "not_ready" },
    {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

async function readiness(): Promise<boolean> {
  const now = Date.now();
  if (cachedReadiness && cachedReadiness.expiresAt > now) return cachedReadiness.ready;
  activeReadinessProbe ??= probeReadiness().then((ready) => {
    cachedReadiness = { expiresAt: Date.now() + readinessCacheTtlMs, ready };
    return ready;
  }).finally(() => {
    activeReadinessProbe = null;
  });
  return activeReadinessProbe;
}

async function probeReadiness(): Promise<boolean> {
  try {
    const apiBaseUrl = internalApiBaseUrl();
    const [, apiResponse] = await Promise.all([
      checkWorkbenchAuthStorage(),
      tracedFetch(`${apiBaseUrl}/system/ready`, {
        cache: "no-store",
        signal: AbortSignal.timeout(8_000),
      }),
    ]);
    return apiResponse.ok;
  } catch {
    return false;
  }
}

function internalApiBaseUrl(): string {
  const configured = process.env.WORKBENCH_API_INTERNAL_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  if (process.env.NODE_ENV !== "production" || process.env.NEXT_PHASE === "phase-production-build") {
    return "http://127.0.0.1:4100/api/v1";
  }
  throw new Error("WORKBENCH_API_INTERNAL_URL is required");
}
