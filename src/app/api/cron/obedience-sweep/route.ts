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
  computeWeekScore,
  currentWeekKey,
  getStreak,
  getStreakRiskMinDeficit,
  getStreakThreshold,
  recordObedienceEventForWeek,
  staleClaimNudgeSentKey,
  streakRiskNotifiedKey,
} from "@/lib/obedience";
import {
  previousDateKey,
  todayKeyCairo,
  weekdayOfDateKey,
  cairoMidnightMs,
} from "@/lib/cairo-time";
import { writeCronTelemetry } from "@/lib/cron-telemetry";
import { sendNotification } from "@/app/actions/notifications";
import { STALE_CLAIM_NUDGE_HOURS } from "@/lib/reward-types";
import type { RewardClaim } from "@/lib/reward-types";
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
  /** Streak-at-risk FCM fired this tick (0 or 1; Friday-only). */
  streakRiskFired: number;
  /** Per-claim stale-pending nudges fired this tick. */
  staleClaimsNudged: number;
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
    streakRiskFired: 0,
    staleClaimsNudged: 0,
  };

  try {
    const [
      tasksMissed,
      ritualsMissed,
      rulesUnacked,
      weeksFinalized,
      streakRiskFired,
      staleClaimsNudged,
    ] = await Promise.all([
      sweepTasks(),
      sweepRituals(),
      sweepRules(),
      catchUpFinalizations("Besho", 4),
      sweepStreakRisk(),
      sweepStaleClaims(),
    ]);
    result.tasksMissed = tasksMissed;
    result.ritualsMissed = ritualsMissed;
    result.rulesUnacked = rulesUnacked;
    result.weeksFinalized = weeksFinalized;
    result.streakRiskFired = streakRiskFired;
    result.staleClaimsNudged = staleClaimsNudged;

    const durationMs = Date.now() - startedAt;
    await writeCronTelemetry("obedience-sweep", {
      ok: true,
      durationMs,
      summary: { ...result },
    });
    return Response.json({
      ok: true,
      ...result,
      durationMs,
    });
  } catch (err) {
    logger.error("[cron/obedience-sweep] failed", err);
    const durationMs = Date.now() - startedAt;
    await writeCronTelemetry("obedience-sweep", {
      ok: false,
      durationMs,
      summary: { ...result },
      error: err instanceof Error ? err.message : "Sweep failed.",
    });
    return Response.json(
      {
        ok: false,
        error: "Sweep failed.",
        ...result,
        durationMs,
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

// ── Streak-at-risk (Friday only) ─────────────────────────────────────────

/** TTL on the per-week "already nudged" sentinel. 30h covers the rest
 *  of Friday + all of Saturday; the week rolls over Sunday and the
 *  sentinel becomes irrelevant. */
const STREAK_RISK_TTL_SECONDS = 30 * 60 * 60;

/**
 * Fires once per Cairo Friday when Besho is on a streak (`streak > 0`)
 * and her current week's displayed score sits below the streak
 * threshold by at least the Sir-tunable min-deficit. Skips on every
 * other weekday. Sentinel is `streak-risk:fcm:sent:{author}:{weekKey}`
 * via SET NX EX so a re-tick on the same Friday is a no-op. The week
 * itself isn't mutated — just notification.
 */
async function sweepStreakRisk(): Promise<number> {
  try {
    const today = todayKeyCairo();
    const weekday = weekdayOfDateKey(today); // 0=Sun..6=Sat
    if (weekday !== 5) return 0; // Friday only

    const author = "Besho" as const;
    const weekKey = currentWeekKey();
    const [streak, threshold, score, minDeficit] = await Promise.all([
      getStreak(author),
      getStreakThreshold(),
      computeWeekScore(author, weekKey),
      getStreakRiskMinDeficit(),
    ]);
    if (streak <= 0) return 0;
    const deficit = threshold - score.displayedScore;
    if (deficit < minDeficit) return 0;

    // Atomic dedup: SET NX with TTL. "OK" means we won the race.
    let claim: string | null = null;
    try {
      claim = (await redis.set(
        streakRiskNotifiedKey(author, weekKey),
        "1",
        { nx: true, ex: STREAK_RISK_TTL_SECONDS },
      )) as string | null;
    } catch (err) {
      logger.error("[cron/obedience-sweep] streak-risk dedup SET failed", err);
      return 0;
    }
    if (claim !== "OK") return 0;

    // Days remaining including today. Sun=0..Sat=6 → daysLeft = 7 - weekday.
    // Friday(5) → 2 (today + Sat). Cron normally fires on Fri so daysLeft = 2.
    const daysLeft = 7 - weekday;
    try {
      await sendNotification(author, {
        title: "🔥 Streak at risk",
        body: `You're ${deficit} pt${deficit === 1 ? "" : "s"} behind your streak. ${daysLeft} day${daysLeft === 1 ? "" : "s"} left.`,
        url: "/rewards",
      });
      logger.interaction("[cron/obedience-sweep] streak-risk fired", {
        author,
        weekKey,
        streak,
        displayedScore: score.displayedScore,
        threshold,
        deficit,
        daysLeft,
      });
      return 1;
    } catch (err) {
      // Best-effort. Sentinel already claimed — accept "no nudge this
      // week" rather than risk a duplicate on the next tick.
      logger.error("[cron/obedience-sweep] streak-risk FCM send failed", err);
      return 0;
    }
  } catch (err) {
    logger.error("[cron/obedience-sweep] streak-risk sweep failed", err);
    return 0;
  }
}

// ── Stale pending claim nudge ────────────────────────────────────────────

const STALE_CLAIM_NUDGE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30d
const CLAIMS_PENDING_KEY = "rewards:claims:pending";
const claimKey = (id: string) => `reward:claim:${id}`;

/**
 * Walks the pending-claims ZSET (scored by requestedAt). For each
 * claim older than `STALE_CLAIM_NUDGE_HOURS`, fires a single nudge
 * FCM to Sir (`reward:claim:nudge-sent:{id}` SET NX EX 30d). Skips
 * test-mode claims and any claim that's already been decided
 * (defensive — index drift shouldn't happen, but pending ZSET
 * membership is the source of truth here).
 */
async function sweepStaleClaims(): Promise<number> {
  try {
    const now = Date.now();
    const cutoff = now - STALE_CLAIM_NUDGE_HOURS * 60 * 60 * 1000;
    const ids =
      ((await redis.zrange<unknown[]>(
        CLAIMS_PENDING_KEY,
        0,
        cutoff,
        { byScore: true },
      )) ?? []).map(String);
    if (!ids.length) return 0;

    const claims =
      (await redis.mget<RewardClaim[]>(...ids.map((id) => claimKey(id)))) ?? [];
    let fired = 0;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const claim = claims[i];
      if (!claim) continue;
      if (claim.status !== "pending") continue;
      if (claim.testMode) continue;

      let claimed: string | null = null;
      try {
        claimed = (await redis.set(staleClaimNudgeSentKey(id), "1", {
          nx: true,
          ex: STALE_CLAIM_NUDGE_TTL_SECONDS,
        })) as string | null;
      } catch (err) {
        logger.error("[cron/obedience-sweep] stale-claim dedup SET failed", err, {
          claimId: id,
        });
        continue;
      }
      if (claimed !== "OK") continue;

      const ageHours = Math.max(
        STALE_CLAIM_NUDGE_HOURS,
        Math.round((now - claim.requestedAt) / (60 * 60 * 1000)),
      );
      const tierFragment = claim.tierEmoji
        ? `${claim.tierEmoji} ${claim.tierName}`
        : claim.tierName;
      const rewardFragment = claim.rewardEmoji
        ? `${claim.rewardEmoji} ${claim.rewardLabel}`
        : claim.rewardLabel;
      try {
        await sendNotification("T7SEN", {
          title: "🔔 Claim still waiting",
          body: `kitten's ${tierFragment} claim (${rewardFragment}) has been pending ${ageHours}h.`,
          url: "/rewards",
        });
        fired++;
        logger.interaction("[cron/obedience-sweep] stale-claim nudged", {
          claimId: id,
          ageHours,
          requestedAt: claim.requestedAt,
        });
      } catch (err) {
        // Best-effort. Sentinel already claimed.
        logger.error("[cron/obedience-sweep] stale-claim FCM send failed", err, {
          claimId: id,
        });
      }
    }
    return fired;
  } catch (err) {
    logger.error("[cron/obedience-sweep] stale-claim sweep failed", err);
    return 0;
  }
}
