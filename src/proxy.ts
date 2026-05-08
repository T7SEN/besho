// src/proxy.ts
//
// Next 16 renamed `middleware` → `proxy`. Same lifecycle (runs before
// the matched request reaches the route handler / RSC render), same
// `next/server` request/response API, just a different filename and
// the named export `proxy` instead of `middleware`.
//
// Three responsibilities:
//
// 1. Global auth gate — unauthenticated visitors get bounced to
//    /login from any non-login page.
// 2. Session refresh — re-issue a 30-day JWT when there's <7 days
//    remaining so an active user is never surprise-logged-out.
// 3. Sir-only gate + no-cache headers on `/admin/*` — bounce non-Sir
//    BEFORE the RSC render runs (saves a render and masks the
//    existence of admin routes), and stamp `Cache-Control: no-store,
//    private` on every admin response so no CDN or browser cache
//    keeps a copy. The layout's `requireSir()` redirect is kept as
//    defense-in-depth.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { decrypt, encrypt } from "@/lib/auth-utils";

const ADMIN_PREFIX = "/admin";

function withAdminCacheHeaders(res: NextResponse, isAdminPath: boolean) {
  if (isAdminPath) {
    res.headers.set("Cache-Control", "no-store, private");
  }
  return res;
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const isPublicAsset = pathname.startsWith("/icon-");

  if (isPublicAsset) return NextResponse.next();

  const sessionCookie = request.cookies.get("session")?.value;
  const isLoginPage = pathname === "/login";
  const isAdminPath = pathname.startsWith(ADMIN_PREFIX);

  const session = sessionCookie ? await decrypt(sessionCookie) : null;

  if (!session?.isAuthenticated && !isLoginPage) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  if (session?.isAuthenticated && isLoginPage) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  // Sir-only gate for /admin/*. Authenticated-but-not-Sir users get
  // redirected to /, NOT /login (they already have a session — sending
  // them back to the login page would prompt for a passcode they
  // already entered). Layout's redirect remains as defense-in-depth.
  if (isAdminPath && session?.isAuthenticated && session.author !== "T7SEN") {
    return NextResponse.redirect(new URL("/", request.url));
  }

  // ── Session refresh ──────────────────────────────────────────────────────
  // If the session has fewer than 7 days remaining, re-issue a fresh 30-day
  // JWT so an active user is never unexpectedly logged out.
  if (session?.isAuthenticated && session.expiresAt) {
    const msRemaining = new Date(session.expiresAt).getTime() - Date.now();
    const daysRemaining = msRemaining / (1000 * 60 * 60 * 24);

    if (daysRemaining < 7) {
      const newExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      const newToken = await encrypt({
        isAuthenticated: true,
        author: session.author,
        expiresAt: newExpiresAt.toISOString(),
      });

      const response = NextResponse.next();
      response.cookies.set("session", newToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        expires: newExpiresAt,
        sameSite: "lax",
        path: "/",
      });
      return withAdminCacheHeaders(response, isAdminPath);
    }
  }

  return withAdminCacheHeaders(NextResponse.next(), isAdminPath);
}

export const config = {
  matcher: [
    "/((?!api|_next/static|_next/image|favicon\\.ico|manifest\\.json|icon-|\\.*\\.svg$).*)",
  ],
};
