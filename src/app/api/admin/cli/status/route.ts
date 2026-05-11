// src/app/api/admin/cli/status/route.ts
//
// CLI-only system status. Read-only, no mutations. Returns:
//   - Both authors' presence (page + freshness)
//   - Cron telemetry snapshot (all 4 named crons + heartbeat-watch)
//   - Restraint state
//   - FCM token counts per author (sanity check delivery channels)
//   - Server time
//
// Used by `ourspace status` — Sir's quick "is everything alive" probe.

import { redis } from "@/lib/redis";
import { readAllCronTelemetry } from "@/lib/cron-telemetry";
import { readRestraintRaw } from "@/lib/restraint";
import { countFcmTokens } from "@/lib/fcm-tokens";
import { logger } from "@/lib/logger";
import { requireCliAuth, cliAuthError } from "@/lib/admin-cli-auth";

interface PresenceSnapshot {
  page: string | null;
  ageMs: number | null;
  fresh: boolean;
}

const PRESENCE_FRESH_MS = 12_000;

async function readPresence(author: "T7SEN" | "Besho"): Promise<PresenceSnapshot> {
  try {
    const raw = await redis.get<string>(`presence:${author}`);
    if (!raw) return { page: null, ageMs: null, fresh: false };
    const parsed = JSON.parse(raw) as { page: string; ts: number };
    const ageMs = Date.now() - parsed.ts;
    return {
      page: parsed.page,
      ageMs,
      fresh: ageMs < PRESENCE_FRESH_MS,
    };
  } catch {
    return { page: null, ageMs: null, fresh: false };
  }
}

export async function GET(req: Request) {
  const guard = requireCliAuth(req);
  if (!guard.ok) return cliAuthError(guard);

  try {
    const [sirPresence, beshoPresence, cron, restraintOn, sirTokens, beshoTokens] =
      await Promise.all([
        readPresence("T7SEN"),
        readPresence("Besho"),
        readAllCronTelemetry(),
        readRestraintRaw(),
        countFcmTokens(redis, "T7SEN"),
        countFcmTokens(redis, "Besho"),
      ]);

    return Response.json({
      ok: true,
      serverTime: Date.now(),
      presence: {
        T7SEN: sirPresence,
        Besho: beshoPresence,
      },
      cron,
      restraint: { on: restraintOn },
      fcm: {
        T7SEN: sirTokens,
        Besho: beshoTokens,
      },
    });
  } catch (err) {
    logger.error("[admin/cli] status read failed", err);
    return Response.json(
      { error: "Status read failed." },
      { status: 500 },
    );
  }
}
