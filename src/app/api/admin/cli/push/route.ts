// src/app/api/admin/cli/push/route.ts
//
// CLI-only generic push. Body: `{ to, title, body, url?, bypassPresence? }`.
// `to` is "T7SEN" | "Besho" | "both". When "both", fan out to both
// authors (mirrors the /admin/push-test "Both" recipient behavior).
//
// Logs each delivery as `[admin] cli push` so the activity feed shows
// what Sir fired from the terminal.

import { sendNotification } from "@/app/actions/notifications";
import { logger } from "@/lib/logger";
import { requireCliAuth, cliAuthError } from "@/lib/admin-cli-auth";
import type { Author } from "@/lib/constants";

interface PushBody {
  to: Author | "both";
  title: string;
  body: string;
  url?: string;
  bypassPresence?: boolean;
}

export async function POST(req: Request) {
  const guard = requireCliAuth(req);
  if (!guard.ok) return cliAuthError(guard);

  let payload: PushBody;
  try {
    payload = (await req.json()) as PushBody;
  } catch {
    return Response.json(
      { error: "Invalid JSON body." },
      { status: 400 },
    );
  }
  if (
    !payload?.title ||
    !payload?.body ||
    (payload.to !== "T7SEN" && payload.to !== "Besho" && payload.to !== "both")
  ) {
    return Response.json(
      {
        error:
          "Body requires { to: 'T7SEN' | 'Besho' | 'both', title: string, body: string, url?: string, bypassPresence?: boolean }.",
      },
      { status: 400 },
    );
  }

  const recipients: Author[] =
    payload.to === "both" ? ["T7SEN", "Besho"] : [payload.to];
  const url = payload.url ?? "/";
  const bypassPresence = payload.bypassPresence === true;

  let fired = 0;
  const errors: string[] = [];
  for (const to of recipients) {
    try {
      await sendNotification(
        to,
        {
          title: payload.title,
          body: payload.body,
          url,
        },
        bypassPresence ? { bypassPresence: true } : undefined,
      );
      fired++;
    } catch (err) {
      errors.push(
        err instanceof Error
          ? `${to}: ${err.message}`
          : `${to}: send failed`,
      );
      logger.error("[admin/cli] push send failed", err, { to });
    }
  }

  logger.interaction("[admin] cli push", {
    by: "T7SEN (cli)",
    to: payload.to,
    title: payload.title,
    body: payload.body,
    url,
    bypassPresence,
    fired,
    errors: errors.length > 0 ? errors : undefined,
  });

  if (fired === 0) {
    return Response.json(
      { error: "All sends failed.", details: errors },
      { status: 500 },
    );
  }
  return Response.json({
    ok: true,
    fired,
    ...(errors.length > 0 && { partialErrors: errors }),
  });
}
