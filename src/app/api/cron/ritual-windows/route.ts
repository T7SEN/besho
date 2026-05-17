// src/app/api/cron/ritual-windows/route.ts
//
// Server-side ritual-window FCM trigger. cron-job.org hits this every
// minute; it fires an FCM to the owner when a ritual's window opened
// within the last LOOKBACK_MS and we haven't already fired for this
// (ritual, owningDate) pair.
//
// Local notifications scheduled by `<DeviceTracker />` / the rituals
// page still fire on the device as a parallel path. The two layer
// without dedup because the on-device ones use a different ID range
// and Capacitor / FCM channels render distinct heads-up banners.
//
// Redis cost: this route used to call the page-grade `getRituals()`
// every minute — ~17 commands PER ritual (streaks + 14 history-dot
// HGETALLs the cron never read). It now calls `getRitualsForCron`,
// which does 1 ZRANGE + 1 MGET + an occurrence HGETALL only for
// rituals whose window actually opened in the lookback. Typical run
// is ~2 commands. See the Redis-cost audit.

import { NextRequest } from "next/server";
import { redis } from "@/lib/redis";
import { getRitualsForCron } from "@/app/actions/rituals";
import { sendNotification } from "@/app/actions/notifications";
import { logger } from "@/lib/logger";
import { writeCronTelemetry } from "@/lib/cron-telemetry";

/** Cron tick is 60s; allow 5 minutes of slack for missed ticks (cron
 *  pauses during deploys, jitter, etc.). Anything older is considered
 *  "already past" — local notifications would have fired already. */
const LOOKBACK_MS = 5 * 60 * 1000;

/** Dedup TTL covers any reasonable window-open window plus the
 *  lookback. 36h is a safe upper bound that survives daylight-saving
 *  transitions without needing exact expiry math. */
const DEDUP_TTL_SECONDS = 36 * 60 * 60;

const dedupKey = (ritualId: string, owningDateKey: string) =>
  `ritual:fcm:sent:${ritualId}:${owningDateKey}`;

function unauthorized() {
  return new Response("Unauthorized", { status: 401 });
}

export async function GET(req: NextRequest) {
  // cron-job.org sends `Authorization: Bearer ${CRON_SECRET}`. Reject
  // any request that doesn't carry it — the endpoint is otherwise
  // public.
  const auth = req.headers.get("authorization");
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    logger.warn("[cron/ritual-windows] CRON_SECRET not set; refusing run");
    return unauthorized();
  }
  if (auth !== `Bearer ${expected}`) return unauthorized();

  const startedAt = Date.now();
  let due = 0;
  let fired = 0;
  let dedupHits = 0;

  try {
    // Lean read — returns only the rituals due for a reminder right
    // now (window opened in the lookback, active, not yet acted on).
    const dueRituals = await getRitualsForCron(LOOKBACK_MS);
    due = dueRituals.length;

    for (const r of dueRituals) {
      // Atomic dedup: SET NX with TTL. Returns null when the key
      // already exists, "OK" when we won the race. The NX guard is
      // what prevents the same window firing twice across overlapping
      // ticks.
      let claim: string | null = null;
      try {
        claim = (await redis.set(
          dedupKey(r.id, r.owningDateKey),
          "1",
          { nx: true, ex: DEDUP_TTL_SECONDS },
        )) as string | null;
      } catch (err) {
        logger.error("[cron/ritual-windows] dedup SET failed", err, {
          ritualId: r.id,
        });
        continue;
      }
      if (claim !== "OK") {
        dedupHits++;
        continue;
      }

      try {
        await sendNotification(
          r.owner,
          {
            title: "🕯️ Ritual",
            body: `Time for: ${r.title}`,
            url: "/rituals",
          },
          { bypassPresence: true },
        );
        fired++;
        logger.interaction("[cron/ritual-windows] FCM fired", {
          ritualId: r.id,
          owner: r.owner,
          owningDateKey: r.owningDateKey,
          opensAtMs: r.windowOpensAtMs,
        });
      } catch (err) {
        // Best-effort. The dedup key stays set for 36h — a transient
        // FCM failure means we accept "no notification this window"
        // rather than risking a duplicate on the next tick.
        logger.error("[cron/ritual-windows] FCM send failed", err, {
          ritualId: r.id,
        });
      }
    }

    const durationMs = Date.now() - startedAt;
    await writeCronTelemetry("ritual-windows", {
      ok: true,
      durationMs,
      summary: { due, fired, dedupHits },
    });
    return Response.json({
      ok: true,
      due,
      fired,
      dedupHits,
      durationMs,
    });
  } catch (err) {
    logger.error("[cron/ritual-windows] tick failed", err);
    const durationMs = Date.now() - startedAt;
    await writeCronTelemetry("ritual-windows", {
      ok: false,
      durationMs,
      summary: { due, fired, dedupHits },
      error: err instanceof Error ? err.message : "Tick failed.",
    });
    return Response.json(
      {
        ok: false,
        error: "Tick failed.",
        due,
        fired,
        dedupHits,
        durationMs,
      },
      { status: 500 },
    );
  }
}
