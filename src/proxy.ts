import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { decrypt } from "@/lib/auth-utils";

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const isPublicAsset =
    pathname === "/manifest.json" ||
    pathname.startsWith("/icon-") ||
    pathname.startsWith("/serwist/") ||
    pathname === "/~offline";

  if (isPublicAsset) {
    return NextResponse.next();
  }

  const sessionCookie = request.cookies.get("session")?.value;
  const isLoginPage = pathname === "/login";

  const session = sessionCookie ? await decrypt(sessionCookie) : null;

  if (!session?.isAuthenticated && !isLoginPage) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  if (session?.isAuthenticated && isLoginPage) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!api|_next/static|_next/image|favicon\\.ico|manifest\\.json|icon-|serwist|~offline|\\.*\\.svg$).*)",
  ],
};
