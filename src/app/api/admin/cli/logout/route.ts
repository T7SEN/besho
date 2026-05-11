// src/app/api/admin/cli/logout/route.ts
//
// CLI-only force-logout. Body: `{ author }`. Bumps the per-author
// session epoch so existing JWTs reject on next request. Mirrors the
// admin /devices Sessions section's force-logout button.

import { revokeAuthorSessions } from "@/lib/auth-utils";
import { logger } from "@/lib/logger";
import { requireCliAuth, cliAuthError } from "@/lib/admin-cli-auth";
import type { Author } from "@/lib/constants";

interface LogoutBody {
  author: Author;
}

export async function POST(req: Request) {
  const guard = requireCliAuth(req);
  if (!guard.ok) return cliAuthError(guard);

  let body: LogoutBody;
  try {
    body = (await req.json()) as LogoutBody;
  } catch {
    return Response.json(
      { error: "Invalid JSON body." },
      { status: 400 },
    );
  }
  if (body?.author !== "T7SEN" && body?.author !== "Besho") {
    return Response.json(
      { error: "Body requires { author: 'T7SEN' | 'Besho' }." },
      { status: 400 },
    );
  }

  try {
    await revokeAuthorSessions(body.author);
    logger.warn("[admin] force logout via cli", {
      by: "T7SEN (cli)",
      author: body.author,
    });
    return Response.json({ ok: true, author: body.author });
  } catch (err) {
    logger.error("[admin/cli] logout failed", err);
    return Response.json(
      { error: "Force logout failed." },
      { status: 500 },
    );
  }
}
