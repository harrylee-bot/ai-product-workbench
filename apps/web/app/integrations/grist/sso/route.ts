import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { authRouteWithReturnPath } from "@/lib/auth/auth-return-path";
import { gristSsoCallbackUrl, gristSsoUrl, safeGristReturnPath } from "@/lib/auth/grist-sso";
import { auth } from "@/lib/auth/workbench-auth.server";

export async function GET(request: NextRequest) {
  const next = safeGristReturnPath(request.nextUrl.searchParams.get("next"));
  const secret = process.env.WORKBENCH_GRIST_SSO_SECRET?.trim();
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("WORKBENCH_GRIST_SSO_SECRET is required in production");
    }
    return NextResponse.redirect(gristSsoUrl(next));
  }

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    const returnPath = `/integrations/grist/sso?next=${encodeURIComponent(next)}`;
    return NextResponse.redirect(new URL(
      authRouteWithReturnPath("/login", returnPath),
      requiredEnv("BETTER_AUTH_URL"),
    ));
  }

  return NextResponse.redirect(gristSsoCallbackUrl({
    value: next,
    gristOrigin: requiredEnv("WORKBENCH_GRIST_ORIGIN"),
    workbenchOrigin: requiredEnv("BETTER_AUTH_URL"),
    secret,
    user: session.user,
  }));
}

function requiredEnv(name: "WORKBENCH_GRIST_ORIGIN" | "BETTER_AUTH_URL") {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
