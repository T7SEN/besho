// src/app/api/admin/cli/summon/route.ts
//
// CLI-only summon endpoint. Mirrors `summonKitten()` in
// `src/app/actions/admin/notifications.ts` — same payload, same
// channel/priority/sound, same audit shape — but bearer-authed via
// `ADMIN_CLI_TOKEN` instead of the session cookie, and logged with
// a `(cli)` marker so the activity feed distinguishes desktop ops
// from in-app /admin clicks.
//
// No body. POST with empty body is fine.

import { sendNotification } from "@/app/actions/notifications";
import { logger } from "@/lib/logger";
import { requireCliAuth, cliAuthError } from "@/lib/admin-cli-auth";

export async function POST(req: Request) {
  const guard = requireCliAuth(req);
  if (!guard.ok) return cliAuthError(guard);

  try {
    await sendNotification(
      "Besho",
      {
        title: "Heel, kitten.",
        body: "You're mine. Drop everything and come to me — now.",
        url: "/",
      },
      {
        bypassPresence: true,
        android: {
          channelId: "safeword",
          priority: "max",
          sound: "default",
        },
      },
    );
    logger.interaction("[admin] kitten summoned", { by: "T7SEN (cli)" });
    return Response.json({ ok: true });
  } catch (err) {
    logger.error("[admin/cli] summon failed", err);
    return Response.json(
      { error: "Summon failed." },
      { status: 500 },
    );
  }
}
