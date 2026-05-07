// src/lib/cron-telemetry.ts
//
// Last-run telemetry for the three cron-job.org-driven routes:
// /api/cron/obedience-sweep, /api/cron/ritual-windows,
// /api/cron/review-window-open. Each tick writes one
// `cron:last-run:{name}` STRING (JSON) at the end of execution
// (success and failure paths). Sir reads it on /admin/health to
// confirm the cron is alive and surface the most recent summary —
// closes the visibility hole that made the earlier FCM-spam debug
// feel blind.
//
// 7-day TTL: a tick that hasn't fired in over a week implies the
// cron-job.org schedule is broken and the entry should expire so
// the UI can render "never run" rather than a 9-day-old snapshot.
//
// Best-effort writer: telemetry never breaks the calling cron, so
// `writeCronTelemetry` swallows its own errors. The cron's primary
// work has already completed by the time we write — losing the
// telemetry bit is annoying but not actionable.

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

export const CRON_NAMES = [
  "obedience-sweep",
  "ritual-windows",
  "review-window-open",
] as const;

export type CronName = (typeof CRON_NAMES)[number];

const TELEMETRY_TTL_SECONDS = 7 * 24 * 60 * 60;

export const cronLastRunKey = (name: CronName) => `cron:last-run:${name}`;

export interface CronLastRun {
  /** Unix ms when the tick finished (success or failure). */
  ts: number;
  /** Whether the tick reported success (HTTP 2xx body `ok: true`). */
  ok: boolean;
  /** Wall-clock duration in ms. */
  durationMs: number;
  /** Free-form per-cron summary (counts, dedup hits, weeks finalized). */
  summary?: Record<string, unknown>;
  /** Present when ok === false. */
  error?: string;
}

export async function writeCronTelemetry(
  name: CronName,
  payload: Omit<CronLastRun, "ts">,
): Promise<void> {
  try {
    const record: CronLastRun = {
      ts: Date.now(),
      ...payload,
    };
    await redis.set(cronLastRunKey(name), record, {
      ex: TELEMETRY_TTL_SECONDS,
    });
  } catch {
    // best-effort — telemetry must never break the cron
  }
}

export interface CronTelemetrySnapshot {
  name: CronName;
  lastRun: CronLastRun | null;
}

export async function readAllCronTelemetry(): Promise<CronTelemetrySnapshot[]> {
  try {
    const keys = CRON_NAMES.map((n) => cronLastRunKey(n));
    const raws = await redis.mget<(CronLastRun | string | null)[]>(...keys);
    return CRON_NAMES.map((name, i) => {
      const raw = raws?.[i] ?? null;
      let lastRun: CronLastRun | null = null;
      if (raw) {
        if (typeof raw === "string") {
          try {
            lastRun = JSON.parse(raw) as CronLastRun;
          } catch {
            lastRun = null;
          }
        } else if (typeof raw === "object") {
          lastRun = raw as CronLastRun;
        }
      }
      return { name, lastRun };
    });
  } catch {
    return CRON_NAMES.map((name) => ({ name, lastRun: null }));
  }
}
