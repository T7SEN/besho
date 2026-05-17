// src/app/api/cron/heartbeat-watch/route.ts
//
// Watches the OTHER cron jobs for staleness and alerts Sir when one
// silently stops firing. cron-job.org has no failure-alert escalation
// of its own — if it stops invoking one of our endpoints (rate
// limiting, account suspension, schedule edit, free-tier issues), Sir
// won't notice until the next /admin/health visit, which could be
// hours or days later.
//
// This route reads `cron:last-run:{name}` for each tracked cron,
// checks each against its expected fresh window, and fires a
// sentinel-deduped FCM to Sir when any are stale. Skips itself in the
// staleness check (no self-monitoring); /admin/health surfaces its
// own telemetry for manual sanity checks.
//
// Add to cron-job.org separately at e.g. every 30 minutes — that's
// the resolution at which heartbeat-watch can detect staleness, AND
// the rate at which the sentinel-deduped alerts could re-fire if a
// stale cron is acknowledged but unfixed.
//
// Auth shape mirrors the other crons: `Authorization: Bearer
// ${CRON_SECRET}` required; refuses if env not set.

import { NextRequest } from "next/server";
import { sendNotification } from "@/app/actions/notifications";
import { logger } from "@/lib/logger";
import { redis } from "@/lib/redis";
import {
  readAllCronTelemetry,
  writeCronTelemetry,
  type CronName,
} from "@/lib/cron-telemetry";

// Expected fresh window per cron, in ms. If a cron's lastRun is
// older than this (or missing entirely), it is considered stale and
// triggers an alarm. Slack is baked in to tolerate normal cron-job.org
// scheduling jitter and our own pipeline latency.
//
// `heartbeat-watch` itself is set to Infinity so the sweep skips it —
// the watcher never alerts on itself. Sir reads `/admin/health` to
// confirm heartbeat-watch is alive.
const FRESH_WINDOW_MS: Record<CronName, number> = {
  "obedience-sweep": 30 * 60 * 60 * 1000, // daily, 30h fresh
  "ritual-windows": 10 * 60 * 1000, // minute cadence, 10m fresh
  "review-window-open": 30 * 60 * 60 * 1000, // daily, 30h fresh
  "heartbeat-watch": Number.POSITIVE_INFINITY,
  "timer-expire": 15 * 60 * 1000, // 5-min cadence, 15m fresh (2 missed ticks)
};

const NOTIFIED_TTL_SECONDS = 24 * 60 * 60;
const notifiedKey = (name: CronName) => `cron:stale-notified:${name}`;

function unauthorized() {
  return new Response("Unauthorized", { status: 401 });
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    logger.warn("[cron/heartbeat-watch] CRON_SECRET not set; refusing run");
    return unauthorized();
  }
  if (auth !== `Bearer ${expected}`) return unauthorized();

  const startedAt = Date.now();
  const fired: string[] = [];
  const skippedDueToSentinel: string[] = [];
  const fresh: string[] = [];
  const stale: string[] = [];

  try {
    const snapshots = await readAllCronTelemetry();
    const now = Date.now();

    for (const snap of snapshots) {
      if (snap.name === "heartbeat-watch") continue; // never self-alarm

      const window = FRESH_WINDOW_MS[snap.name];
      const lastTs = snap.lastRun?.ts ?? 0;
      const ageMs = now - lastTs;
      const isStale = !snap.lastRun || ageMs > window;

      if (!isStale) {
        fresh.push(snap.name);
        continue;
      }
      stale.push(snap.name);

      // Sentinel-deduped: only fire one alert per stale cron per 24h,
      // even if heartbeat-watch runs every 30 minutes. Without this,
      // a single stuck cron could generate 48 push notifications per
      // day until acknowledged.
      const acquired = await redis.set(notifiedKey(snap.name), "1", {
        nx: true,
        ex: NOTIFIED_TTL_SECONDS,
      });
      if (!acquired) {
        skippedDueToSentinel.push(snap.name);
        continue;
      }

      const ageDescription = snap.lastRun
        ? `${Math.round(ageMs / 60_000)}m ago`
        : "never";
      try {
        await sendNotification(
          "T7SEN",
          {
            title: "🚨 Cron stale",
            body: `${snap.name} hasn't reported in ${ageDescription}. Check cron-job.org.`,
            url: "/admin/health",
          },
          { bypassPresence: true },
        );
        fired.push(snap.name);
        logger.warn("[cron/heartbeat-watch] alarm fired", {
          cron: snap.name,
          ageMs,
        });
      } catch (err) {
        logger.error("[cron/heartbeat-watch] alarm send failed", err, {
          cron: snap.name,
        });
        // Release the sentinel so the next sweep can retry rather
        // than silently waiting 24h for the TTL.
        await redis.del(notifiedKey(snap.name)).catch(() => {});
      }
    }

    const durationMs = Date.now() - startedAt;
    await writeCronTelemetry("heartbeat-watch", {
      ok: true,
      durationMs,
      summary: {
        fired,
        skippedDueToSentinel,
        fresh,
        stale,
      },
    });
    return Response.json({
      ok: true,
      durationMs,
      fired,
      skippedDueToSentinel,
      fresh,
      stale,
    });
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : "Unknown error";
    await writeCronTelemetry("heartbeat-watch", {
      ok: false,
      durationMs,
      error: message,
    });
    logger.error("[cron/heartbeat-watch] failed", err);
    return Response.json(
      { ok: false, error: message, durationMs },
      { status: 500 },
    );
  }
}
