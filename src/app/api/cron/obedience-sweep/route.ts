// src/app/api/cron/obedience-sweep/route.ts
//
// Daily obedience sweep — emits the negative events that aren't tied
// to a Besho-driven action: missed tasks, missed rituals, unacked
// rules. Also walks back up to 4 prior weeks finalizing any week that
// rolled over without finalize being called.
//
// Triggered exclusively by cron-job.org — Vercel Hobby tier rejects
// per-minute crons at build time, so there is no `vercel.json`. The
// endpoint refuses to run unless the bearer matches CRON_SECRET.
//
// Idempotent end-to-end:
//  - Every emit uses ZSET member dedup. Re-running the cron the same
//    day produces no duplicates.
//  - Finalization sets the `obedience:finalized:{author}:{weekKey}`
//    sentinel; re-running is a no-op.
//
// Granularity is per-day; the cron should be hit once per Cairo day,
// shortly after midnight (e.g., 00:30 Cairo). Hitting it more often is
// safe but wasteful.

import { NextRequest } from "next/server";
import { Redis } from "@upstash/redis";
import { logger } from "@/lib/logger";
import {
  catchUpFinalizations,
  recordObedienceEventForWeek,
  currentWeekKey,
} from "@/lib/obedience";
import {
  previousDateKey,
  todayKeyCairo,
  weekdayOfDateKey,
  cairoMidnightMs,
} from "@/lib/cairo-time";
import type { Task } from "@/app/actions/tasks";
import type { Rule } from "@/app/actions/rules";
import type { Ritual } from "@/app/actions/rituals";

const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

function unauthorized() {
  return new Response("Unauthorized", { status: 401 });
}

interface SweepResult {
  tasksMissed: number;
  ritualsMissed: number;
  rulesUnacked: number;
  weeksFinalized: number;
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    logger.warn("[cron/obedience-sweep] CRON_SECRET not set; refusing run");
    return unauthorized();
  }
  if (auth !== `Bearer ${expected}`) return unauthorized();

  const startedAt = Date.now();
  const result: SweepResult = {
    tasksMissed: 0,
    ritualsMissed: 0,
    rulesUnacked: 0,
    weeksFinalized: 0,
  };

  try {
    const [tasksMissed, ritualsMissed, rulesUnacked, weeksFinalized] =
      await Promise.all([
        sweepTasks(),
        sweepRituals(),
        sweepRules(),
        catchUpFinalizations("Besho", 4),
      ]);
    result.tasksMissed = tasksMissed;
    result.ritualsMissed = ritualsMissed;
    result.rulesUnacked = rulesUnacked;
    result.weeksFinalized = weeksFinalized;

    return Response.json({
      ok: true,
      ...result,
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    logger.error("[cron/obedience-sweep] failed", err);
    return Response.json(
      {
        ok: false,
        error: "Sweep failed.",
        ...result,
        durationMs: Date.now() - startedAt,
      },
      { status: 500 },
    );
  }
}

// ── Tasks ────────────────────────────────────────────────────────────────

async function sweepTasks(): Promise<number> {
  try {
    const ids =
      ((await redis.zrange<unknown[]>("tasks:index", 0, -1)) ?? []).map(String);
    if (!ids.length) return 0;
    const tasks =
      (await redis.mget<Task[]>(...ids.map((id) => `task:${id}`))) ?? [];
    const now = Date.now();
    let count = 0;
    for (const t of tasks) {
      if (!t) continue;
      if (t.status === "completed") continue;
      if (typeof t.deadline !== "number") continue;
      if (t.deadline > now) continue;
      // Score lands in the week containing the deadline.
      const weekKey = currentWeekKey(t.deadline);
      await recordObedienceEventForWeek(
        "Besho",
        "task_missed",
        t.id,
        weekKey,
      );
      count++;
    }
    return count;
  } catch (err) {
    logger.error("[cron/obedience-sweep] task sweep failed", err);
    return 0;
  }
}

// ── Rules ────────────────────────────────────────────────────────────────

async function sweepRules(): Promise<number> {
  try {
    const ids =
      ((await redis.zrange<unknown[]>("rules:index", 0, -1)) ?? []).map(String);
    if (!ids.length) return 0;
    const rules =
      (await redis.mget<Rule[]>(...ids.map((id) => `rule:${id}`))) ?? [];
    const now = Date.now();
    let count = 0;
    for (const r of rules) {
      if (!r) continue;
      if (r.status !== "pending") continue;
      if (typeof r.acknowledgeDeadline !== "number") continue;
      if (r.acknowledgeDeadline > now) continue;
      const weekKey = currentWeekKey(r.acknowledgeDeadline);
      await recordObedienceEventForWeek(
        "Besho",
        "rule_unacked",
        r.id,
        weekKey,
      );
      count++;
    }
    return count;
  } catch (err) {
    logger.error("[cron/obedience-sweep] rule sweep failed", err);
    return 0;
  }
}

// ── Rituals ──────────────────────────────────────────────────────────────

/**
 * Yesterday-only sweep for daily and weekly cadences. `every_n_days` is
 * skipped here because reconstructing prescribed-or-not for arbitrary
 * historical dates needs more anchor math than we want in the hot path.
 * `submitOccurrence` still emits positive on-time scores for every
 * cadence — only the missed-emit is daily/weekly.
 */
async function sweepRituals(): Promise<number> {
  try {
    const ids =
      ((await redis.zrange<unknown[]>("rituals:index", 0, -1)) ?? []).map(String);
    if (!ids.length) return 0;
    const rituals =
      (await redis.mget<Ritual[]>(...ids.map((id) => `ritual:${id}`))) ?? [];

    const today = todayKeyCairo();
    const yesterday = previousDateKey(today);
    const yesterdayWeekday = weekdayOfDateKey(yesterday);
    const yesterdayMidnightMs = cairoMidnightMs(yesterday);
    const now = Date.now();

    let count = 0;
    for (const r of rituals) {
      if (!r) continue;
      if (r.owner !== "Besho") continue;
      if (!r.active) continue;
      if (typeof r.pausedUntil === "number" && r.pausedUntil > now) continue;

      // Was yesterday prescribed?
      let prescribed = false;
      if (r.cadence === "daily") {
        prescribed = true;
      } else if (r.cadence === "weekly") {
        prescribed = (r.weekdays ?? []).includes(yesterdayWeekday);
      } else if (r.cadence === "every_n_days") {
        // Skipped — see function-level comment.
        continue;
      }
      if (!prescribed) continue;

      // The window must have closed by `now`. Midnight-crossing windows
      // that opened yesterday could still be open if cron runs too soon
      // after midnight. Skip if window hasn't closed yet.
      const opensAtMs = yesterdayMidnightMs + hhmmToMs(r.windowStart);
      const closesAtMs = opensAtMs + r.windowDurationMinutes * 60_000;
      if (now < closesAtMs) continue;

      // Was it submitted (or skipped)?
      const occ = await redis.hgetall<Record<string, string>>(
        `ritual:occurrence:${r.id}:${yesterday}`,
      );
      if (occ && Object.keys(occ).length > 0) continue;

      const weekKey = currentWeekKey(closesAtMs);
      await recordObedienceEventForWeek(
        "Besho",
        "ritual_missed",
        `${r.id}:${yesterday}`,
        weekKey,
      );
      count++;
    }
    return count;
  } catch (err) {
    logger.error("[cron/obedience-sweep] ritual sweep failed", err);
    return 0;
  }
}

function hhmmToMs(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return ((h ?? 0) * 60 + (m ?? 0)) * 60_000;
}
