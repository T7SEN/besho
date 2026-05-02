import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { decrypt, encrypt } from "@/lib/auth-utils";

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const isPublicAsset = pathname.startsWith("/icon-");

  if (isPublicAsset) return NextResponse.next();

  const sessionCookie = request.cookies.get("session")?.value;
  const isLoginPage = pathname === "/login";

  const session = sessionCookie ? await decrypt(sessionCookie) : null;

  if (!session?.isAuthenticated && !isLoginPage) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  if (session?.isAuthenticated && isLoginPage) {
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
      return response;
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!api|_next/static|_next/image|favicon\\.ico|manifest\\.json|icon-|\\.*\\.svg$).*)",
  ],
};
