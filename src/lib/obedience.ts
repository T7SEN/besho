// src/lib/obedience.ts
//
// Obedience-score core. Lives next to `restraint.ts` because it's the
// same shape: a Sir-tunable Besho-affecting flag layer with a 5s
// in-process cache, raw setters used only by Sir-authenticated admin
// actions, and a `record*` helper called from feature actions.
//
// Score model (per AGENTS.md § 4 / SKILL.md § 1):
//  - Each scorable event becomes a member of `obedience:events:{author}:{weekKey}`
//    ZSET, with the points value as the score. Member id is
//    `{eventType}:{eventId}`, so the same eventId retried is a ZADD
//    overwrite, not a double credit.
//  - Week boundary aligns with `/review` (Sun→Sat Cairo). `currentWeekKey`
//    delegates to `currentReviewWeekDate`.
//  - Multiplier ladder maps consecutive prior high-score weeks to a
//    score multiplier. The current-week multiplier is computed against
//    the streak ENTERING the week. Past weeks use a frozen value
//    captured at finalize time.
//  - Finalize at week-close: store the multiplier used, bump the streak
//    counter (or reset to 0), set a sentinel so the operation is
//    idempotent. Driven by the obedience cron and as a fallback by
//    lazy on-read attempts in `getWeekState`.

import { Redis } from "@upstash/redis";
import type { Author } from "./constants";
import {
  currentReviewWeekDate,
  formatWeekLabel,
  weekRangeMs,
} from "./review-utils";
import { addDaysCairo } from "./cairo-time";
import {
  DEFAULT_OBEDIENCE_WEIGHTS,
  DEFAULT_REWARD_TIERS,
  DEFAULT_STREAK_THRESHOLD,
  DEFAULT_MULTIPLIERS,
  type ObedienceEventType,
  type ObedienceWeights,
  type RewardTier,
  type ObedienceWeekScore,
  type ObedienceBreakdownEntry,
  type ObedienceWeekState,
} from "./reward-types";
import { sendNotification } from "@/app/actions/notifications";

const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

// ── Key helpers ──────────────────────────────────────────────────────────

export const WEIGHTS_KEY = "obedience:weights";
export const TIERS_KEY = "rewards:tiers";
export const STREAK_THRESHOLD_KEY = "obedience:streak-threshold";
export const MULTIPLIERS_KEY = "obedience:multipliers";

export const eventsKey = (author: Author, weekKey: string) =>
  `obedience:events:${author}:${weekKey}`;
export const streakKey = (author: Author) =>
  `obedience:streak:${author}`;
export const multiplierFrozenKey = (author: Author, weekKey: string) =>
  `obedience:multiplier:${author}:${weekKey}`;
export const finalizedKey = (author: Author, weekKey: string) =>
  `obedience:finalized:${author}:${weekKey}`;
/** Highest tier-threshold already announced this week (string ms-int).
 *  Per-week so tier crossings notify once per week, not once per repeat. */
export const tierNotifiedKey = (author: Author, weekKey: string) =>
  `obedience:tier-notified:${author}:${weekKey}`;
/** Audit ZSET — score = emit ts (ms), member = `{type}:{eventId}` (matches
 *  the events ZSET so a join recovers points). On retry the member is
 *  identical and the ZADD updates the score to the latest emit ts. */
export const auditKey = (author: Author, weekKey: string) =>
  `obedience:audit:${author}:${weekKey}`;

// ── 5s in-process cache, mirroring restraint.ts ──────────────────────────

interface CacheEntry<T> {
  value: T;
  until: number;
}
const CACHE_MS = 5_000;
const cache = new Map<string, CacheEntry<unknown>>();

function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.until < Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value as T;
}

function setCached<T>(key: string, value: T): void {
  cache.set(key, { value, until: Date.now() + CACHE_MS });
}

export function invalidateObedienceCache(): void {
  cache.clear();
}

// ── Tunable read/write — Sir-only writers, both authors read ─────────────

export async function getWeights(): Promise<ObedienceWeights> {
  const cached = getCached<ObedienceWeights>(WEIGHTS_KEY);
  if (cached) return cached;
  try {
    const stored = await redis.get<ObedienceWeights>(WEIGHTS_KEY);
    const merged = { ...DEFAULT_OBEDIENCE_WEIGHTS, ...(stored ?? {}) };
    setCached(WEIGHTS_KEY, merged);
    return merged;
  } catch {
    return { ...DEFAULT_OBEDIENCE_WEIGHTS };
  }
}

export async function setWeightsRaw(
  weights: ObedienceWeights,
): Promise<void> {
  await redis.set(WEIGHTS_KEY, weights);
  cache.delete(WEIGHTS_KEY);
}

export async function getTiers(): Promise<RewardTier[]> {
  const cached = getCached<RewardTier[]>(TIERS_KEY);
  if (cached) return cached;
  try {
    const stored = await redis.get<RewardTier[]>(TIERS_KEY);
    const tiers =
      Array.isArray(stored) && stored.length > 0 ? stored : DEFAULT_REWARD_TIERS;
    setCached(TIERS_KEY, tiers);
    return tiers;
  } catch {
    return DEFAULT_REWARD_TIERS;
  }
}

export async function setTiersRaw(tiers: RewardTier[]): Promise<void> {
  await redis.set(TIERS_KEY, tiers);
  cache.delete(TIERS_KEY);
}

export async function getStreakThreshold(): Promise<number> {
  const cached = getCached<number>(STREAK_THRESHOLD_KEY);
  if (cached !== null) return cached;
  try {
    const stored = await redis.get<number | string>(STREAK_THRESHOLD_KEY);
    const n = Number(stored);
    const value = Number.isFinite(n) && n > 0 ? n : DEFAULT_STREAK_THRESHOLD;
    setCached(STREAK_THRESHOLD_KEY, value);
    return value;
  } catch {
    return DEFAULT_STREAK_THRESHOLD;
  }
}

export async function setStreakThresholdRaw(value: number): Promise<void> {
  await redis.set(STREAK_THRESHOLD_KEY, value);
  cache.delete(STREAK_THRESHOLD_KEY);
}

export async function getMultipliers(): Promise<readonly number[]> {
  const cached = getCached<readonly number[]>(MULTIPLIERS_KEY);
  if (cached) return cached;
  try {
    const stored = await redis.get<number[]>(MULTIPLIERS_KEY);
    const mults =
      Array.isArray(stored) && stored.length > 0 ? stored : DEFAULT_MULTIPLIERS;
    setCached(MULTIPLIERS_KEY, mults);
    return mults;
  } catch {
    return DEFAULT_MULTIPLIERS;
  }
}

export async function setMultipliersRaw(mults: number[]): Promise<void> {
  await redis.set(MULTIPLIERS_KEY, mults);
  cache.delete(MULTIPLIERS_KEY);
}

// ── Week-key helper ──────────────────────────────────────────────────────

/** Aligns with /review week-key (Sun→Sat Cairo). */
export function currentWeekKey(now: number = Date.now()): string {
  return currentReviewWeekDate(now);
}

/** N weeks before `weekKey`. */
export function shiftWeekKey(weekKey: string, weeks: number): string {
  return addDaysCairo(weekKey, weeks * 7);
}

// ── Event emission ───────────────────────────────────────────────────────

/**
 * Emits an obedience event. Idempotent — same eventId retried is a ZADD
 * overwrite. Best-effort — failures must never break the calling write
 * path. Score lands in the week containing `ts` (defaults to now).
 *
 * On positive-points emit, fires a tier-unlock check that may FCM Besho
 * if she just crossed a new tier threshold. Negative emits skip the
 * check — there's no notification for tier-DROP.
 */
export async function recordObedienceEvent(
  author: Author,
  type: ObedienceEventType,
  eventId: string,
  ts: number = Date.now(),
  weightOverride?: number,
): Promise<void> {
  try {
    const points =
      typeof weightOverride === "number"
        ? weightOverride
        : (await getWeights())[type];
    if (!Number.isFinite(points)) return;
    const weekKey = currentWeekKey(ts);
    const member = `${type}:${eventId}`;
    const pipeline = redis.pipeline();
    pipeline.zadd(eventsKey(author, weekKey), { score: points, member });
    pipeline.zadd(auditKey(author, weekKey), { score: ts, member });
    await pipeline.exec();
    if (points > 0 && author === "Besho") {
      // Best-effort — never break the caller on FCM hiccups.
      void maybeNotifyTierUnlock(author, weekKey).catch(() => {});
    }
  } catch {
    // Side-channel must never break the caller.
  }
}

/**
 * Variant for cron sweeps that already know the target week (e.g.
 * yesterday's missed-task scan needs to land in yesterday's week, not
 * today's, when the day boundary just crossed).
 */
export async function recordObedienceEventForWeek(
  author: Author,
  type: ObedienceEventType,
  eventId: string,
  weekKey: string,
  weightOverride?: number,
): Promise<void> {
  try {
    const points =
      typeof weightOverride === "number"
        ? weightOverride
        : (await getWeights())[type];
    if (!Number.isFinite(points)) return;
    const member = `${type}:${eventId}`;
    const ts = Date.now();
    const pipeline = redis.pipeline();
    pipeline.zadd(eventsKey(author, weekKey), { score: points, member });
    pipeline.zadd(auditKey(author, weekKey), { score: ts, member });
    await pipeline.exec();
  } catch {
    // best-effort
  }
}

// ── Streak + multiplier ──────────────────────────────────────────────────

export async function getStreak(author: Author): Promise<number> {
  try {
    const v = await redis.get<number | string>(streakKey(author));
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

export async function setStreakRaw(
  author: Author,
  value: number,
): Promise<void> {
  if (value <= 0) {
    await redis.del(streakKey(author));
  } else {
    await redis.set(streakKey(author), value);
  }
}

export function multiplierForStreak(
  streakEntering: number,
  mults: readonly number[],
): number {
  if (mults.length === 0) return 1.0;
  const idx = Math.min(Math.max(streakEntering, 0), mults.length - 1);
  return mults[idx];
}

// ── Score computation ────────────────────────────────────────────────────

interface RawEvent {
  member: string;
  score: number;
}

async function readWeekEvents(
  author: Author,
  weekKey: string,
): Promise<RawEvent[]> {
  try {
    const raw =
      ((await redis.zrange<(string | number)[]>(
        eventsKey(author, weekKey),
        0,
        -1,
        { withScores: true },
      )) as (string | number)[]) ?? [];
    const out: RawEvent[] = [];
    for (let i = 0; i < raw.length; i += 2) {
      out.push({
        member: String(raw[i]),
        score: Number(raw[i + 1]) || 0,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export async function computeWeekScore(
  author: Author,
  weekKey: string,
): Promise<ObedienceWeekScore> {
  const todayKey = currentWeekKey();
  const isPastWeek = weekKey < todayKey;

  const [events, mults, streakStored] = await Promise.all([
    readWeekEvents(author, weekKey),
    getMultipliers(),
    getStreak(author),
  ]);

  // Past weeks: use frozen multiplier when available. Current week:
  // compute against the stored streak (which represents consecutive
  // weeks finalized prior to this one).
  let multiplier: number | null = null;
  if (isPastWeek) {
    try {
      const frozen = await redis.get<number | string>(
        multiplierFrozenKey(author, weekKey),
      );
      const n = Number(frozen);
      if (Number.isFinite(n) && n > 0) multiplier = n;
    } catch {
      // ignore
    }
  }
  if (multiplier === null) {
    multiplier = multiplierForStreak(streakStored, mults);
  }

  let rawScore = 0;
  const buckets = new Map<ObedienceEventType, ObedienceBreakdownEntry>();
  for (const ev of events) {
    rawScore += ev.score;
    const colon = ev.member.indexOf(":");
    const typeStr = colon > 0 ? ev.member.slice(0, colon) : ev.member;
    const type = typeStr as ObedienceEventType;
    const entry = buckets.get(type);
    if (entry) {
      entry.count++;
      entry.points += ev.score;
    } else {
      buckets.set(type, { type, count: 1, points: ev.score });
    }
  }
  const breakdown = Array.from(buckets.values()).sort(
    (a, b) => Math.abs(b.points) - Math.abs(a.points),
  );

  const displayedScore = Math.round(rawScore * multiplier);

  return {
    weekKey,
    rawScore,
    multiplier,
    displayedScore,
    streakEntering: streakStored,
    breakdown,
  };
}

export function unlockedTierFor(
  displayedScore: number,
  tiers: RewardTier[],
): RewardTier | null {
  let best: RewardTier | null = null;
  for (const t of tiers) {
    if (displayedScore >= t.threshold) {
      if (!best || t.threshold > best.threshold) best = t;
    }
  }
  return best;
}

export async function getWeekState(
  author: Author,
  weekKey: string,
): Promise<ObedienceWeekState> {
  const [score, tiers] = await Promise.all([
    computeWeekScore(author, weekKey),
    getTiers(),
  ]);
  const unlockedTier = unlockedTierFor(score.displayedScore, tiers);
  return { ...score, unlockedTier, tiers };
}

// ── Finalization ─────────────────────────────────────────────────────────

export async function isWeekFinalized(
  author: Author,
  weekKey: string,
): Promise<boolean> {
  try {
    const v = await redis.get<string>(finalizedKey(author, weekKey));
    return v === "1";
  } catch {
    return false;
  }
}

/**
 * Finalize a single past week. Idempotent. Bumps streak if displayed
 * score ≥ threshold, resets to 0 otherwise. Freezes the multiplier in
 * place so future score reads are stable.
 *
 * On successful finalize, fires a recap FCM to BOTH authors: title
 * carries the tier earned (or "no tier"), body carries the score and
 * multiplier. Best-effort — FCM failures don't roll back the
 * finalization.
 */
export async function finalizeWeek(
  author: Author,
  weekKey: string,
): Promise<{ finalized: boolean; reason?: string; displayedScore?: number }> {
  if (weekKey >= currentWeekKey()) {
    return { finalized: false, reason: "not_in_past" };
  }
  if (await isWeekFinalized(author, weekKey)) {
    return { finalized: false, reason: "already_finalized" };
  }
  const score = await computeWeekScore(author, weekKey);
  const threshold = await getStreakThreshold();
  const isHighScore = score.displayedScore >= threshold;
  const newStreak = isHighScore ? score.streakEntering + 1 : 0;

  const pipeline = redis.pipeline();
  pipeline.set(multiplierFrozenKey(author, weekKey), score.multiplier);
  pipeline.set(finalizedKey(author, weekKey), "1");
  if (newStreak <= 0) pipeline.del(streakKey(author));
  else pipeline.set(streakKey(author), newStreak);
  await pipeline.exec();
  cache.clear();

  // Recap FCM to both authors — best-effort.
  void notifyWeekClosed(author, weekKey, score, newStreak).catch(() => {});

  return { finalized: true, displayedScore: score.displayedScore };
}

// ── Tier-unlock + week-close notifications ───────────────────────────────

/**
 * Compares the current unlocked tier to the highest-notified tier for
 * this week and fires a single FCM to Besho if the threshold went up.
 * Stored sentinel is the threshold value (number) of the last-notified
 * tier — not the tier id, so renames in the catalog don't fire a
 * spurious re-notification.
 */
async function maybeNotifyTierUnlock(
  author: Author,
  weekKey: string,
): Promise<void> {
  const state = await getWeekState(author, weekKey);
  const tier = state.unlockedTier;
  if (!tier) return;
  const sentinelKey = tierNotifiedKey(author, weekKey);
  let lastNotifiedThreshold = -Infinity;
  try {
    const raw = await redis.get<string | number>(sentinelKey);
    const n = Number(raw);
    if (Number.isFinite(n)) lastNotifiedThreshold = n;
  } catch {
    // ignore — fail open and notify
  }
  if (tier.threshold <= lastNotifiedThreshold) return;
  try {
    await sendNotification(author, {
      title: `🏆 ${tier.name} unlocked`,
      body: `${state.displayedScore} pts this week. Reward unlocks at week close.`,
      url: "/rewards",
    });
    await redis.set(sentinelKey, tier.threshold);
  } catch {
    // best-effort
  }
}

async function notifyWeekClosed(
  author: Author,
  weekKey: string,
  score: ObedienceWeekScore,
  newStreak: number,
): Promise<void> {
  const tiers = await getTiers();
  const tier = unlockedTierFor(score.displayedScore, tiers);
  const label = formatWeekLabel(weekKey);
  const tierFragment = tier ? `${tier.name} earned` : "no tier";
  const multFragment =
    score.multiplier !== 1 ? ` • ×${score.multiplier.toFixed(1)}` : "";
  const streakFragment =
    newStreak > 1 ? ` • ${newStreak}-week streak` : "";
  const body = `${score.displayedScore} pts • ${tierFragment}${multFragment}${streakFragment}`;
  try {
    await Promise.all([
      sendNotification("T7SEN", {
        title: `📊 Week wrapped — ${label}`,
        body,
        url: "/rewards",
      }),
      sendNotification(author, {
        title: `📊 Week wrapped — ${label}`,
        body: tier
          ? `${body}. Claim your reward at /rewards.`
          : body,
        url: "/rewards",
      }),
    ]);
  } catch {
    // best-effort
  }
}

/**
 * Walk back up to `maxWeeks` finalizing any unfinalized prior weeks
 * (oldest first). Order matters because each finalization depends on
 * the streak state left by the prior one. Used as a robustness fallback
 * when the cron didn't run or the user opens the page after a long gap.
 */
export async function catchUpFinalizations(
  author: Author,
  maxWeeks: number = 4,
): Promise<number> {
  let count = 0;
  const current = currentWeekKey();
  // Build ordered list oldest → newest of past weekKeys to consider.
  const candidates: string[] = [];
  for (let i = maxWeeks; i >= 1; i--) {
    candidates.push(shiftWeekKey(current, -i));
  }
  for (const wk of candidates) {
    const result = await finalizeWeek(author, wk);
    if (result.finalized) count++;
  }
  return count;
}

// ── Audit log read ───────────────────────────────────────────────────────

export interface ObedienceAuditEntry {
  type: ObedienceEventType;
  eventId: string;
  points: number;
  ts: number;
}

/**
 * Joins the per-week events ZSET (member → points) with the audit ZSET
 * (member → ts). Returned newest-first, capped at `limit`. Members
 * present only in one of the two ZSETs (which shouldn't normally
 * happen, but can if a write half-failed) are skipped.
 */
export async function getEventLog(
  author: Author,
  weekKey: string,
  limit: number = 200,
): Promise<ObedienceAuditEntry[]> {
  try {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const [auditRaw, eventsRaw] = await Promise.all([
      redis.zrange<(string | number)[]>(
        auditKey(author, weekKey),
        0,
        safeLimit - 1,
        { rev: true, withScores: true },
      ),
      redis.zrange<(string | number)[]>(
        eventsKey(author, weekKey),
        0,
        -1,
        { withScores: true },
      ),
    ]);
    const points = new Map<string, number>();
    if (eventsRaw) {
      for (let i = 0; i < eventsRaw.length; i += 2) {
        points.set(String(eventsRaw[i]), Number(eventsRaw[i + 1]) || 0);
      }
    }
    const out: ObedienceAuditEntry[] = [];
    if (!auditRaw) return out;
    for (let i = 0; i < auditRaw.length; i += 2) {
      const member = String(auditRaw[i]);
      const ts = Number(auditRaw[i + 1]) || 0;
      if (!points.has(member)) continue;
      const colon = member.indexOf(":");
      if (colon < 0) continue;
      const type = member.slice(0, colon) as ObedienceEventType;
      const eventId = member.slice(colon + 1);
      out.push({ type, eventId, points: points.get(member)!, ts });
    }
    return out;
  } catch {
    return [];
  }
}

// ── Range helpers re-exported for callers that don't want to import twice ─

export { weekRangeMs };
