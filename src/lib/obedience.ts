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

import { redis } from "@/lib/redis";
import type { Author } from "./constants";
import { formatWeekLabel, weekRangeMs } from "./review-utils";
import {
  addDaysCairo,
  todayKeyCairo,
  weekdayOfDateKey,
} from "./cairo-time";
import {
  DEFAULT_OBEDIENCE_WEIGHTS,
  DEFAULT_REWARD_TIERS,
  DEFAULT_STREAK_THRESHOLD,
  DEFAULT_MULTIPLIERS,
  DEFAULT_STREAK_RISK_MIN_DEFICIT,
  type ObedienceEventType,
  type ObedienceWeights,
  type RewardTier,
  type ObedienceWeekScore,
  type ObedienceBreakdownEntry,
  type ObedienceWeekState,
} from "./reward-types";
import { sendNotification } from "@/app/actions/notifications";
import { logger } from "./logger";

// ── Key helpers ──────────────────────────────────────────────────────────

export const WEIGHTS_KEY = "obedience:weights";
export const TIERS_KEY = "rewards:tiers";
export const STREAK_THRESHOLD_KEY = "obedience:streak-threshold";
export const MULTIPLIERS_KEY = "obedience:multipliers";
/** Minimum deficit in displayed pts required to fire the Friday-evening
 *  streak-at-risk FCM. Default 1 means any deficit triggers. Sir raises
 *  it to suppress trivial nudges. */
export const STREAK_RISK_MIN_DEFICIT_KEY = "obedience:streak-risk-min-deficit";
/** Sir-only test-mode flag. When "on", `claimReward` accepts the
 *  current week (in addition to the immediately prior week), so the
 *  full claim → deliver → status flow can be exercised without ending
 *  the week and bumping the streak / freezing the multiplier. */
export const TEST_MODE_KEY = "obedience:test-mode";

export const eventsKey = (author: Author, weekKey: string) =>
  `obedience:events:${author}:${weekKey}`;
export const streakKey = (author: Author) =>
  `obedience:streak:${author}`;
/** Per-week snapshot of the streak value ENTERING this week. Written
 *  at the end of the prior week's `finalizeWeek` (so the snapshot is
 *  locked in BEFORE the week begins) and consumed by the next
 *  finalize + by `computeWeekScore` for past unfinalized weeks.
 *
 *  Why it exists: without this snapshot, `computeWeekScore` for an
 *  unfinalized past week falls back to live `streakKey`, which means
 *  any `adminSetStreakRaw` adjustment between week-end and cron-run
 *  retroactively shifts the past week's display AND the multiplier
 *  the cron eventually freezes. With the snapshot, the entry-streak
 *  is fixed the moment the prior week finalizes, so streak
 *  adjustments during week N only affect future weeks. */
export const entryStreakKey = (author: Author, weekKey: string) =>
  `obedience:entry-streak:${author}:${weekKey}`;
export const multiplierFrozenKey = (author: Author, weekKey: string) =>
  `obedience:multiplier:${author}:${weekKey}`;
export const finalizedKey = (author: Author, weekKey: string) =>
  `obedience:finalized:${author}:${weekKey}`;
/** Highest tier-threshold already announced this week (string ms-int).
 *  Per-week so tier crossings notify once per week, not once per repeat. */
export const tierNotifiedKey = (author: Author, weekKey: string) =>
  `obedience:tier-notified:${author}:${weekKey}`;
/** Sentinel — set NX EX 30h once the Friday streak-at-risk FCM has
 *  fired for this (author, week). Per-week so each Friday gets at
 *  most one nudge regardless of how many times the obedience-sweep
 *  cron retries. */
export const streakRiskNotifiedKey = (author: Author, weekKey: string) =>
  `streak-risk:fcm:sent:${author}:${weekKey}`;
/** Sentinel — set NX EX 30d once the stale-claim nudge has fired for
 *  this claim id. One nudge per claim ever; if Sir lets a claim sit
 *  past 24h, he gets exactly one prod, not a daily one. */
export const staleClaimNudgeSentKey = (claimId: string) =>
  `reward:claim:nudge-sent:${claimId}`;
/** Audit ZSET — score = emit ts (ms), member = `{type}:{eventId}` (matches
 *  the events ZSET so a join recovers points). On retry the member is
 *  identical and the ZADD updates the score to the latest emit ts. */
export const auditKey = (author: Author, weekKey: string) =>
  `obedience:audit:${author}:${weekKey}`;
/** HASH — manual_adjust reasons, keyed by eventId (the part after the
 *  colon in the audit/events member). Field-level TTL isn't possible
 *  on Redis HASHes; cleanup is per-event via `HDEL` in
 *  `deleteObedienceEvent` and a full `DEL` when the week is purged.
 *  Orphan entries (event deleted but reason left behind) don't break
 *  reads since the merge join is by eventId. Other obedience event
 *  types (rule_acked, ritual_done, etc.) do NOT use this HASH — they
 *  aggregate by type in the breakdown and don't carry per-event prose. */
export const manualReasonsKey = (author: Author, weekKey: string) =>
  `obedience:manual-reasons:${author}:${weekKey}`;
/** Sentinel — set NX EX 60d once the "📊 Week wrapped" recap FCM has
 *  fired for this (author, weekKey). Independent of `finalizedKey` so
 *  the recap stays once-per-week even if the finalize sentinel is
 *  re-acquired (e.g., admin `recomputeWeek` after a transient failure
 *  released the lock, OR the legacy "1" sentinel was lost to Upstash
 *  JSON-parse weirdness). Mirrors the established pattern of
 *  `review:fcm:opener:{weekDate}`, `streak-risk:fcm:sent:*`,
 *  `reward:claim:nudge-sent:*`. 60d TTL is comfortably longer than any
 *  catch-up horizon `catchUpFinalizations` walks (currently 4 weeks). */
export const weekWrappedFcmSentKey = (author: Author, weekKey: string) =>
  `obedience:week-wrapped-fcm:${author}:${weekKey}`;
/** Lifetime stats — updated at finalize. Only ever overwritten when the
 *  new value beats the stored one, so they're append-style records of
 *  her best-ever performance. */
export const bestWeekKey = (author: Author) =>
  `obedience:best-week:${author}`;
export const longestStreakRecordKey = (author: Author) =>
  `obedience:longest-streak:${author}`;
export const weeksTrackedKey = (author: Author) =>
  `obedience:weeks-tracked:${author}`;

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

export async function getStreakRiskMinDeficit(): Promise<number> {
  const cached = getCached<number>(STREAK_RISK_MIN_DEFICIT_KEY);
  if (cached !== null) return cached;
  try {
    const stored = await redis.get<number | string>(STREAK_RISK_MIN_DEFICIT_KEY);
    const n = Number(stored);
    const value =
      Number.isFinite(n) && n >= 1 ? n : DEFAULT_STREAK_RISK_MIN_DEFICIT;
    setCached(STREAK_RISK_MIN_DEFICIT_KEY, value);
    return value;
  } catch {
    return DEFAULT_STREAK_RISK_MIN_DEFICIT;
  }
}

export async function setStreakRiskMinDeficitRaw(value: number): Promise<void> {
  await redis.set(STREAK_RISK_MIN_DEFICIT_KEY, value);
  cache.delete(STREAK_RISK_MIN_DEFICIT_KEY);
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

export async function getTestMode(): Promise<boolean> {
  const cached = getCached<boolean>(TEST_MODE_KEY);
  if (cached !== null) return cached;
  try {
    const v = await redis.get<string>(TEST_MODE_KEY);
    const on = v === "on";
    setCached(TEST_MODE_KEY, on);
    return on;
  } catch {
    return false;
  }
}

export async function setTestModeRaw(on: boolean): Promise<void> {
  if (on) {
    await redis.set(TEST_MODE_KEY, "on");
  } else {
    await redis.del(TEST_MODE_KEY);
  }
  cache.delete(TEST_MODE_KEY);
}

// ── Week-key helper ──────────────────────────────────────────────────────

/**
 * Sunday-`YYYY-MM-DD` (Cairo) of the week CONTAINING `now`. The rewards
 * system buckets events by the week they occurred in, so on Thursday
 * `currentWeekKey()` must return *this Sunday*, not last Sunday.
 *
 * Historical caveat: this used to delegate to `currentReviewWeekDate`,
 * which has a different semantic — it returns the Sunday of the
 * most-recently-completed reflection week (i.e. last Sunday on a
 * Thursday). That semantic is correct for `/review` (you reflect on
 * the just-completed week) but wrong for `/rewards`, where event
 * bucketing follows the calendar week containing the event timestamp.
 *
 * The off-by-one bug shipped with the rewards system; it manifested
 * as week-wrap notifications firing for two-weeks-back labels and
 * events bucketing into the prior Sunday's key. Buckets created
 * under the buggy semantic must be migrated forward by 7 days — see
 * `migrateObedienceBucketShift` in `admin.ts`. Don't reintroduce the
 * delegation to `currentReviewWeekDate`; the helpers serve different
 * features with the same input shape but different output semantics.
 */
export function currentWeekKey(now: number = Date.now()): string {
  const todayStr = todayKeyCairo(now);
  const dow = weekdayOfDateKey(todayStr); // 0=Sun .. 6=Sat
  return addDaysCairo(todayStr, -dow);
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
 * `note` is optional context (e.g. "engaged for ignoring rule X" for
 * `restraint_engaged`). When non-empty it goes to the activity log via
 * `logger.interaction` only — the ZSET member is unchanged so dedup
 * still works on `{type}:{eventId}`. Mirrors the `manual_adjust` reason
 * pattern.
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
  note?: string,
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
    if (typeof note === "string" && note.trim().length > 0) {
      try {
        logger.interaction("[obedience] event", {
          author,
          type,
          eventId,
          weekKey,
          points,
          note: note.trim(),
        });
      } catch {
        // logger side-channel — never break the caller.
      }
    }
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
  note?: string,
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
    if (typeof note === "string" && note.trim().length > 0) {
      try {
        logger.interaction("[obedience] event", {
          author,
          type,
          eventId,
          weekKey,
          points,
          note: note.trim(),
        });
      } catch {
        // logger side-channel — never break the caller.
      }
    }
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
  // Mirror to the CURRENT week's entry-streak snapshot so the next
  // finalize honors Sir's adjustment. Without this, the snapshot
  // written by the prior week's finalize would override Sir's
  // intent at the next cron tick. Past-week snapshots are
  // intentionally NOT touched — they represent locked-in history
  // and should not be retroactively rewritten by a streak override.
  const wk = currentWeekKey();
  if (value <= 0) {
    await redis.del(entryStreakKey(author, wk));
  } else {
    await redis.set(entryStreakKey(author, wk), value);
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

// ── Manual-adjust reason side-channel ────────────────────────────────────
//
// `manual_adjust` events carry a free-form Sir-supplied reason (e.g.
// "kept her promise", "skipped the chore"). The reason needs to render
// in two surfaces — the per-event row in the Event log AND the
// per-event row in the Breakdown — both of which read from the audit /
// events ZSETs whose member format is `{type}:{eventId}` and can't
// carry prose. So the reason lives in a per-week HASH keyed by
// eventId, joined into the audit/breakdown reads.
//
// Other event types (rule_acked, ritual_done, etc.) do NOT use this
// HASH — they aggregate by type in the breakdown and don't carry
// per-event prose. Only manual_adjust gets a reason.

/** Persists the reason for a manual_adjust event. Idempotent — same
 *  eventId overwrites. Best-effort: a failure here doesn't undo the
 *  event itself, the row will just render with its fallback label. */
export async function setManualAdjustReason(
  author: Author,
  weekKey: string,
  eventId: string,
  reason: string,
): Promise<void> {
  try {
    await redis.hset(manualReasonsKey(author, weekKey), {
      [eventId]: reason,
    });
  } catch {
    // Best-effort — caller already has the obedience event in place.
  }
}

/** Removes a single manual_adjust reason. Called from
 *  `deleteObedienceEvent` for `type === "manual_adjust"`. */
export async function removeManualAdjustReason(
  author: Author,
  weekKey: string,
  eventId: string,
): Promise<void> {
  try {
    await redis.hdel(manualReasonsKey(author, weekKey), eventId);
  } catch {
    // Best-effort — orphans are harmless (read-side join is by eventId).
  }
}

/** Reads every manual_adjust reason for a given (author, weekKey).
 *  Returns an empty record on read failure or empty HASH. */
async function readManualAdjustReasons(
  author: Author,
  weekKey: string,
): Promise<Record<string, string>> {
  try {
    const raw = await redis.hgetall<Record<string, string>>(
      manualReasonsKey(author, weekKey),
    );
    return raw ?? {};
  } catch {
    return {};
  }
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

  const [events, mults, streakStored, reasons] = await Promise.all([
    readWeekEvents(author, weekKey),
    getMultipliers(),
    getStreak(author),
    readManualAdjustReasons(author, weekKey),
  ]);

  // Determine the streak ENTERING this week. For past weeks, prefer
  // the snapshot written by the prior week's `finalizeWeek`. Without
  // this, an unfinalized past week would compute against the live
  // streak — meaning any `adminSetStreakRaw` between week-end and
  // cron-run retroactively shifts the past week's display and the
  // multiplier the cron eventually freezes.
  //
  // Current week always uses live streak (intentional — mid-week
  // streak adjustments by Sir DO affect the current week's display,
  // which is the expected behavior). The snapshot is only consulted
  // for past weeks.
  //
  // Degraded fallback: the very first finalize after this snapshot
  // mechanism shipped has no prior snapshot to read, so it falls
  // back to live streak. From the second finalize onward, the
  // snapshot is always present.
  let entryStreak = streakStored;
  if (isPastWeek) {
    try {
      const snap = await redis.get<number | string>(
        entryStreakKey(author, weekKey),
      );
      const n = Number(snap);
      if (Number.isFinite(n) && n >= 0) entryStreak = n;
    } catch {
      // ignore — falls back to live streak
    }
  }

  // Past weeks: use frozen multiplier when available (finalized).
  // Past unfinalized: compute from entry-streak snapshot (locked in)
  // OR live streak (fallback).
  // Current week: compute from live streak (entry-streak ignored).
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
    multiplier = multiplierForStreak(entryStreak, mults);
  }

  let rawScore = 0;
  // `manual_adjust` events get one breakdown row per event (each carries
  // its own reason as the label); every other type aggregates by type
  // as before. Mixing the two approaches in the same buckets map would
  // collapse manual_adjust events under one row — we want them split.
  const aggregateBuckets = new Map<ObedienceEventType, ObedienceBreakdownEntry>();
  const manualEntries: ObedienceBreakdownEntry[] = [];
  for (const ev of events) {
    rawScore += ev.score;
    const colon = ev.member.indexOf(":");
    const typeStr = colon > 0 ? ev.member.slice(0, colon) : ev.member;
    const eventId = colon > 0 ? ev.member.slice(colon + 1) : "";
    const type = typeStr as ObedienceEventType;

    if (type === "manual_adjust") {
      manualEntries.push({
        type,
        count: 1,
        points: ev.score,
        eventId,
        reason: reasons[eventId],
      });
      continue;
    }

    const entry = aggregateBuckets.get(type);
    if (entry) {
      entry.count++;
      entry.points += ev.score;
    } else {
      aggregateBuckets.set(type, { type, count: 1, points: ev.score });
    }
  }
  const breakdown = [
    ...Array.from(aggregateBuckets.values()),
    ...manualEntries,
  ].sort((a, b) => Math.abs(b.points) - Math.abs(a.points));

  const displayedScore = Math.round(rawScore * multiplier);

  return {
    weekKey,
    rawScore,
    multiplier,
    displayedScore,
    // Past weeks: snapshot when available, else live streak. Current
    // week: always live streak. This is what `finalizeWeek` uses to
    // derive the new streak value (newStreak = entryStreak + 1 on
    // high score, 0 otherwise) — keeping the snapshot here means
    // mid-week streak adjustments don't pollute the just-ending
    // week's finalize math.
    streakEntering: entryStreak,
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
    const v = await redis.get<string | number>(finalizedKey(author, weekKey));
    // Truthy check instead of `=== "1"` because:
    // (a) `finalizeWeek` now writes a timestamp string (`String(Date.now())`)
    //     instead of `"1"`, and
    // (b) Upstash auto-parses "1" → number 1 on read for keys whose
    //     value is JSON-valid, which silently broke the strict equality
    //     check against `"1"` for legacy sentinels.
    return v != null && v !== "" && v !== 0;
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

  // Atomic lock acquisition. The earlier read-then-write pattern (an
  // `isWeekFinalized` check followed by ~5 awaits, then a pipeline
  // that finally wrote the sentinel) had a multi-second race window
  // where two concurrent invocations could both pass the guard and
  // both fire the recap FCM — observed in production as duplicate
  // "Week wrapped" notifications when cron-job.org retried within
  // seconds, OR when Sir hit `recomputeWeek` while the cron was
  // running. SET NX collapses the entire window to a single Redis
  // op: the first caller wins the lock, the second sees the sentinel
  // already exists and bails.
  //
  // The sentinel value carries the finalize timestamp instead of "1"
  // so post-mortem debugging can answer "when did this week
  // finalize" without trawling activity log; `isWeekFinalized` only
  // checks truthiness so any non-empty string works.
  const acquired = await redis.set(
    finalizedKey(author, weekKey),
    String(Date.now()),
    { nx: true },
  );
  if (!acquired) {
    return { finalized: false, reason: "already_finalized" };
  }

  try {
    const score = await computeWeekScore(author, weekKey);
    const threshold = await getStreakThreshold();
    const isHighScore = score.displayedScore >= threshold;
    const newStreak = isHighScore ? score.streakEntering + 1 : 0;

    // Lifetime records — read first so we know whether to overwrite.
    // Race-safe at two-user scale (single finalize per author per
    // week, gated by the SET NX above).
    const [prevBestRaw, prevLongestRaw] = await Promise.all([
      (async () => {
        try {
          return await redis.get<{
            weekKey: string;
            displayedScore: number;
          }>(bestWeekKey(author));
        } catch {
          return null;
        }
      })(),
      (async () => {
        try {
          return await redis.get<number | string>(
            longestStreakRecordKey(author),
          );
        } catch {
          return null;
        }
      })(),
    ]);
    const prevBestScore = prevBestRaw?.displayedScore ?? -Infinity;
    const prevLongest = Number(prevLongestRaw) || 0;
    const isNewBest = score.displayedScore > prevBestScore;
    const isNewLongest = newStreak > prevLongest;

    // Note: the finalized sentinel was already written by the SET NX
    // above; the pipeline below covers everything else.
    //
    // We also write `entry-streak:{author}:{nextWeekKey}` = newStreak
    // so the NEXT week's finalize (and any `computeWeekScore` for
    // that week while still past-unfinalized) has a locked-in
    // snapshot to compute the multiplier from. This is the load-
    // bearing piece that prevents mid-week streak adjustments from
    // retroactively shifting a past unfinalized week's display or
    // poisoning the next finalize's frozen multiplier.
    const nextWeekKey = shiftWeekKey(weekKey, 1);
    const pipeline = redis.pipeline();
    pipeline.set(multiplierFrozenKey(author, weekKey), score.multiplier);
    if (newStreak <= 0) pipeline.del(streakKey(author));
    else pipeline.set(streakKey(author), newStreak);
    pipeline.set(entryStreakKey(author, nextWeekKey), newStreak);
    pipeline.incr(weeksTrackedKey(author));
    if (isNewBest) {
      pipeline.set(bestWeekKey(author), {
        weekKey,
        displayedScore: score.displayedScore,
      });
    }
    if (isNewLongest) {
      pipeline.set(longestStreakRecordKey(author), newStreak);
    }
    await pipeline.exec();
    cache.clear();

    // Recap FCM to both authors — best-effort.
    void notifyWeekClosed(author, weekKey, score, newStreak).catch(() => {});

    return { finalized: true, displayedScore: score.displayedScore };
  } catch (err) {
    // Release the lock on catastrophic failure so a retry can
    // re-attempt the work. Without this, a one-off Upstash hiccup mid
    // pipeline would leave the week stuck "finalized" with no data
    // updates and Sir would have to manually clear the sentinel.
    await redis.del(finalizedKey(author, weekKey)).catch(() => {});
    throw err;
  }
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
  // Three gates that ALL must pass to fire the recap:
  //
  // 1. Only the immediately prior week notifies. Older weeks (caught
  //    up after a deploy or a long absence) finalize silently — the
  //    claim window for those has already lapsed (`claimReward` only
  //    allows the immediately prior week), so a recap for week-3
  //    would be unactionable noise.
  //
  // 2. Empty weeks (zero events) stay silent even when they're the
  //    immediately prior week. "0 pts • no tier" for a week neither
  //    author engaged with is also noise.
  //
  // 3. **The FCM-sent sentinel** must be acquirable. Independent of
  //    `finalizedKey`'s correctness — observed in production
  //    (2026-05-08 onward) as a daily duplicate "Week wrapped"
  //    notification when the finalize lock was somehow re-acquired
  //    each cron run (legacy `"1"` sentinel value vs Upstash
  //    auto-parse, OR the SETNX release-on-error path firing). This
  //    sentinel is single-purpose dedup for the FCM only; it never
  //    releases on error and survives 60 days. Mirrors the existing
  //    pattern used by review-window-open, streak-risk, stale-claim,
  //    ritual-windows.
  const immediatelyPriorKey = shiftWeekKey(currentWeekKey(), -1);
  if (weekKey !== immediatelyPriorKey) return;
  if (score.breakdown.length === 0 && score.rawScore === 0) return;
  const sentinelAcquired = await redis.set(
    weekWrappedFcmSentKey(author, weekKey),
    String(Date.now()),
    { nx: true, ex: 60 * 24 * 60 * 60 },
  );
  if (!sentinelAcquired) return;

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
    // best-effort — sentinel stays set, no retry. This is intentional:
    // a partial-failure FCM (e.g., one author's token expired) is
    // better than re-firing both notifications later.
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

// ── Audit log mutations (Sir-only via admin actions) ─────────────────────

/**
 * Removes a single event from both the events ZSET and the audit ZSET.
 * Score recomputation is implicit — `computeWeekScore` sums the events
 * ZSET fresh on every read, so removing a member with score `-10`
 * effectively adds 10 to the displayed score. Idempotent: if the member
 * doesn't exist, the ZREM is a no-op and returns 0.
 *
 * Caveat: removing events from a finalized past week does NOT roll back
 * the streak counter or unfreeze the stored multiplier — those captured
 * the at-finalize state and are immutable history. The recomputed score
 * still uses the frozen multiplier. Removals are most meaningful for
 * the current (unfinalized) week.
 */
export async function deleteObedienceEvent(
  author: Author,
  weekKey: string,
  type: ObedienceEventType,
  eventId: string,
): Promise<{
  removedFromEvents: number;
  removedFromAudit: number;
  pointsRemoved: number;
}> {
  const member = `${type}:${eventId}`;
  let pointsRemoved = 0;
  try {
    const raw = await redis.zscore(eventsKey(author, weekKey), member);
    if (typeof raw === "number") pointsRemoved = raw;
    else if (raw != null) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) pointsRemoved = parsed;
    }
  } catch {
    // best-effort — fall through with 0
  }
  const pipeline = redis.pipeline();
  pipeline.zrem(eventsKey(author, weekKey), member);
  pipeline.zrem(auditKey(author, weekKey), member);
  // For manual_adjust events, also drop the reason field. Orphans are
  // harmless (read-side join is by eventId, missing → no reason →
  // fallback label), but cleaning up keeps the HASH bounded.
  if (type === "manual_adjust") {
    pipeline.hdel(manualReasonsKey(author, weekKey), eventId);
  }
  const results = (await pipeline.exec()) as [number, number, ...number[]];
  return {
    removedFromEvents: results[0] ?? 0,
    removedFromAudit: results[1] ?? 0,
    pointsRemoved,
  };
}

// ── Audit log read ───────────────────────────────────────────────────────

export interface ObedienceAuditEntry {
  type: ObedienceEventType;
  eventId: string;
  points: number;
  ts: number;
  /** For `manual_adjust` only — the reason supplied at adjustment
   *  time, looked up from the per-week reasons HASH. Renders in place
   *  of the generic "Manual adjustment" label. Absent for legacy
   *  events recorded before the reasons HASH shipped. */
  reason?: string;
}

export interface ObedienceEventLogPage {
  entries: ObedienceAuditEntry[];
  /** Total members in the audit ZSET for this (author, weekKey).
   *  Used to surface "showing N of M" + load-more affordance. */
  total: number;
}

/** Hard ceiling on how many entries can be hydrated in one call.
 *  Keeps the combined audit + events read bounded regardless of caller. */
const EVENT_LOG_MAX_LIMIT = 1000;

/**
 * Joins the per-week events ZSET (member → points) with the audit ZSET
 * (member → ts). Returns the requested slice newest-first plus the
 * total audit-ZSET cardinality so the caller can decide whether to
 * page. Members present only in one of the two ZSETs (write half-fail)
 * are skipped here; use `repairObedienceZsetDrift` to reconcile.
 */
export async function getEventLog(
  author: Author,
  weekKey: string,
  limit: number = 200,
  offset: number = 0,
): Promise<ObedienceEventLogPage> {
  try {
    const safeLimit = Math.max(
      1,
      Math.min(EVENT_LOG_MAX_LIMIT, Math.floor(limit)),
    );
    const safeOffset = Math.max(0, Math.floor(offset));
    const start = safeOffset;
    const stop = safeOffset + safeLimit - 1;
    // Reasons HASH joins on eventId for `manual_adjust` rows. Fetched
    // unconditionally — the cost of an HGETALL on a small per-week
    // hash is negligible vs the cost of detecting whether any
    // manual_adjust entry is in the page first.
    const [auditRaw, eventsRaw, total, reasons] = await Promise.all([
      redis.zrange<(string | number)[]>(
        auditKey(author, weekKey),
        start,
        stop,
        { rev: true, withScores: true },
      ),
      redis.zrange<(string | number)[]>(
        eventsKey(author, weekKey),
        0,
        -1,
        { withScores: true },
      ),
      redis.zcard(auditKey(author, weekKey)),
      readManualAdjustReasons(author, weekKey),
    ]);
    const points = new Map<string, number>();
    if (eventsRaw) {
      for (let i = 0; i < eventsRaw.length; i += 2) {
        points.set(String(eventsRaw[i]), Number(eventsRaw[i + 1]) || 0);
      }
    }
    const entries: ObedienceAuditEntry[] = [];
    if (auditRaw) {
      for (let i = 0; i < auditRaw.length; i += 2) {
        const member = String(auditRaw[i]);
        const ts = Number(auditRaw[i + 1]) || 0;
        if (!points.has(member)) continue;
        const colon = member.indexOf(":");
        if (colon < 0) continue;
        const type = member.slice(0, colon) as ObedienceEventType;
        const eventId = member.slice(colon + 1);
        const entry: ObedienceAuditEntry = {
          type,
          eventId,
          points: points.get(member)!,
          ts,
        };
        if (type === "manual_adjust" && reasons[eventId]) {
          entry.reason = reasons[eventId];
        }
        entries.push(entry);
      }
    }
    return { entries, total: Number(total) || 0 };
  } catch {
    return { entries: [], total: 0 };
  }
}

// ── ZSET drift repair ────────────────────────────────────────────────────

export interface ObedienceDriftRepairResult {
  /** Members that existed in `events:` but were missing from `audit:`
   *  — re-added to audit with score = now (best available timestamp). */
  eventsToAuditAdded: number;
  /** Members that existed in `audit:` but had no matching points in
   *  `events:` — removed from audit (no points to recover, so the
   *  audit entry has no meaning). */
  auditOrphansRemoved: number;
  /** Total members in events ZSET after repair. */
  eventsCountAfter: number;
  /** Total members in audit ZSET after repair. */
  auditCountAfter: number;
}

/**
 * Walk the per-week events + audit ZSETs and reconcile drift. Either
 * direction can drift if a `recordObedienceEvent` write half-failed
 * (one ZADD landed, the other didn't). Audit-only orphans cost the user
 * nothing — the score read uses the events ZSET — but they show up in
 * the event log as missing-points rows. Events-only members are worse:
 * the score still counts but the row never renders.
 *
 * Symmetric to `repairIndexes` for notes. Idempotent — running twice in
 * a row is a no-op on the second pass.
 */
export async function repairObedienceZsetDrift(
  author: Author,
  weekKey: string,
): Promise<ObedienceDriftRepairResult> {
  const ek = eventsKey(author, weekKey);
  const ak = auditKey(author, weekKey);
  const [eventsRaw, auditRaw] = await Promise.all([
    redis.zrange<(string | number)[]>(ek, 0, -1, { withScores: true }),
    redis.zrange<(string | number)[]>(ak, 0, -1, { withScores: true }),
  ]);
  const eventMembers = new Set<string>();
  if (eventsRaw) {
    for (let i = 0; i < eventsRaw.length; i += 2) {
      eventMembers.add(String(eventsRaw[i]));
    }
  }
  const auditMembers = new Set<string>();
  if (auditRaw) {
    for (let i = 0; i < auditRaw.length; i += 2) {
      auditMembers.add(String(auditRaw[i]));
    }
  }

  const orphans: string[] = [];
  for (const m of auditMembers) if (!eventMembers.has(m)) orphans.push(m);
  const missingFromAudit: string[] = [];
  for (const m of eventMembers) if (!auditMembers.has(m)) missingFromAudit.push(m);

  if (orphans.length === 0 && missingFromAudit.length === 0) {
    return {
      eventsToAuditAdded: 0,
      auditOrphansRemoved: 0,
      eventsCountAfter: eventMembers.size,
      auditCountAfter: auditMembers.size,
    };
  }

  const now = Date.now();
  const pipeline = redis.pipeline();
  if (orphans.length > 0) {
    pipeline.zrem(ak, ...orphans);
  }
  for (const m of missingFromAudit) {
    pipeline.zadd(ak, { score: now, member: m });
  }
  await pipeline.exec();

  return {
    eventsToAuditAdded: missingFromAudit.length,
    auditOrphansRemoved: orphans.length,
    eventsCountAfter: eventMembers.size,
    auditCountAfter:
      auditMembers.size - orphans.length + missingFromAudit.length,
  };
}

/**
 * Sweep both authors over the current week + the prior `weeks` past
 * weeks (default 4). Returns the per-week breakdown so the admin UI
 * can summarize. Older weeks are typically immutable post-finalize, but
 * a half-failed write before finalize can still leave drift there —
 * the sweep is cheap so we include them.
 */
export async function repairAllObedienceZsetDrift(
  weeks: number = 4,
): Promise<{
  totals: {
    eventsToAuditAdded: number;
    auditOrphansRemoved: number;
    weeksScanned: number;
  };
  perWeek: Array<
    { author: Author; weekKey: string } & ObedienceDriftRepairResult
  >;
}> {
  const authors: Author[] = ["T7SEN", "Besho"];
  const current = currentWeekKey();
  const weekKeys: string[] = [current];
  for (let i = 1; i <= Math.max(0, Math.floor(weeks)); i++) {
    weekKeys.push(shiftWeekKey(current, -i));
  }
  const perWeek: Array<
    { author: Author; weekKey: string } & ObedienceDriftRepairResult
  > = [];
  let addedTotal = 0;
  let removedTotal = 0;
  for (const author of authors) {
    for (const wk of weekKeys) {
      try {
        const r = await repairObedienceZsetDrift(author, wk);
        perWeek.push({ author, weekKey: wk, ...r });
        addedTotal += r.eventsToAuditAdded;
        removedTotal += r.auditOrphansRemoved;
      } catch {
        // best-effort per (author, week)
      }
    }
  }
  return {
    totals: {
      eventsToAuditAdded: addedTotal,
      auditOrphansRemoved: removedTotal,
      weeksScanned: weekKeys.length * authors.length,
    },
    perWeek,
  };
}

// ── Range helpers re-exported for callers that don't want to import twice ─

export { weekRangeMs };
