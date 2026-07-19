import { getSessionCookie } from "better-auth/cookies";
import { APIError } from "better-auth/api";

import { auth } from "@/lib/auth/workbench-auth.server";
import { createWorkbenchBffHandler } from "@/lib/workbench/bff/proxy";

type WorkbenchRouteContext = {
  params: Promise<{ path: string[] }>;
};

const handler = createWorkbenchBffHandler({
  upstreamBaseUrl: runtimeEnv(
    "WORKBENCH_API_INTERNAL_URL",
    "http://127.0.0.1:4100/api/v1",
  ),
  expectedOrigin: runtimeEnv("BETTER_AUTH_URL", "http://localhost:3000"),
  maximumRequestBytes: positiveIntegerEnv(
    "WORKBENCH_BFF_MAX_REQUEST_BYTES",
    2 * 1024 * 1024,
  ),
  async getBearerToken(headers) {
    if (!getSessionCookie(headers, { cookiePrefix: "workbench" })) return null;
    try {
      const result = await auth.api.getToken({ headers });
      return result.token;
    } catch (error) {
      if (error instanceof APIError && (error.statusCode === 401 || error.statusCode === 403)) {
        return null;
      }
      throw error;
    }
  },
});

async function dispatch(request: Request, context: WorkbenchRouteContext) {
  const { path } = await context.params;
  return handler(request, path);
}

export const GET = dispatch;
export const HEAD = dispatch;
export const POST = dispatch;
export const PUT = dispatch;
export const PATCH = dispatch;
export const DELETE = dispatch;

function runtimeEnv(name: string, developmentFallback: string): string {
  const value = process.env[name]?.trim();
  if (value) return value;
  if (process.env.NODE_ENV !== "production" || process.env.NEXT_PHASE === "phase-production-build") {
    return developmentFallback;
  }
  throw new Error(`${name} is required`);
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} exceeds the safe integer range`);
  return value;
}
