import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

const PROTECTED_PREFIXES = ["/admin", "/projects"];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isProtected =
    pathname === "/" ||
    PROTECTED_PREFIXES.some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    );

  if (!isProtected || getSessionCookie(request, { cookiePrefix: "workbench" })) {
    return NextResponse.next();
  }

  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", `${pathname}${request.nextUrl.search}`);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/", "/admin/:path*", "/projects/:path*"],
};
