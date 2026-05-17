// src/app/api/cron/timer-expire/route.ts
//
// Cron that finalizes time-bounded surfaces whose deadlines have
// passed. Runs on a 5-minute cadence (cron-job.org) — minute
// precision isn't needed: the punishment sentinel carries a 10-min
// grace buffer, a late directive-miss is just bookkeeping (the
// countdown overlay resolves on-device), and TOD TTLs run to days.
// Combined endpoint by design — keeps the cron count bounded as
// more time-windowed features arrive.
//
// Currently sweeps:
//   1. Directives — expires past `expiresAt`, emits `directive_missed`.
//   2. Punishments — bails past `endsAt + BACKGROUND_GRACE_SEC`,
//      auto-creates a "bailed" ledger entry, emits `punishment_bailed`.
//   3. Truth or Dare challenges — expires past `expiresAt`, emits
//      `tod_expired` for Kitten direction only.
//
// Auth: `Authorization: Bearer ${CRON_SECRET}`. Triggered by
// cron-job.org (out-of-band, no `vercel.json` per Hobby tier rule).
// Best-effort overall — telemetry writes always run; per-record
// failures log but don't abort the sweep.

import { NextRequest } from "next/server";
import { expireDueDirectives } from "@/app/actions/directive";
import { expireDuePunishments } from "@/app/actions/punishment";
import {
  expireDueChallenges,
  warnExpiringChallenges,
} from "@/app/actions/games/truth-or-dare";
import { logger } from "@/lib/logger";
import { writeCronTelemetry } from "@/lib/cron-telemetry";

function unauthorized() {
  return new Response("Unauthorized", { status: 401 });
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    logger.warn("[cron/timer-expire] CRON_SECRET not set; refusing run");
    return unauthorized();
  }
  if (auth !== `Bearer ${expected}`) return unauthorized();

  const startedAt = Date.now();
  let directiveScanned = 0;
  let directiveExpired = 0;
  let punishmentScanned = 0;
  let punishmentBailed = 0;
  let todScanned = 0;
  let todExpired = 0;
  let todWarned = 0;

  try {
    const directiveSweep = await expireDueDirectives(200);
    directiveScanned = directiveSweep.scanned;
    directiveExpired = directiveSweep.expired;

    const punishmentSweep = await expireDuePunishments(200);
    punishmentScanned = punishmentSweep.scanned;
    punishmentBailed = punishmentSweep.bailed;

    const todSweep = await expireDueChallenges(200);
    todScanned = todSweep.scanned;
    todExpired = todSweep.expired;

    // Pre-warning walker runs after the expiry sweep so a record that
    // just expired this tick won't get a stale "expires soon" push.
    const todWarn = await warnExpiringChallenges(200);
    todWarned = todWarn.warned;

    const durationMs = Date.now() - startedAt;
    await writeCronTelemetry("timer-expire", {
      ok: true,
      durationMs,
      summary: {
        directiveScanned,
        directiveExpired,
        punishmentScanned,
        punishmentBailed,
        todScanned,
        todExpired,
        todWarned,
      },
    });

    return Response.json({
      ok: true,
      durationMs,
      directives: { scanned: directiveScanned, expired: directiveExpired },
      punishments: { scanned: punishmentScanned, bailed: punishmentBailed },
      tod: { scanned: todScanned, expired: todExpired, warned: todWarned },
    });
  } catch (err) {
    logger.error("[cron/timer-expire] tick failed", err);
    const durationMs = Date.now() - startedAt;
    await writeCronTelemetry("timer-expire", {
      ok: false,
      durationMs,
      summary: {
        directiveScanned,
        directiveExpired,
        punishmentScanned,
        punishmentBailed,
        todScanned,
        todExpired,
        todWarned,
      },
      error: err instanceof Error ? err.message : "Tick failed.",
    });
    return Response.json(
      {
        ok: false,
        error: "Tick failed.",
        durationMs,
        directives: { scanned: directiveScanned, expired: directiveExpired },
        punishments: { scanned: punishmentScanned, bailed: punishmentBailed },
        tod: { scanned: todScanned, expired: todExpired, warned: todWarned },
      },
      { status: 500 },
    );
  }
}
