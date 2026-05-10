// src/app/actions/admin/rewards.ts
"use server";

import { revalidatePath } from "next/cache";
import { logger } from "@/lib/logger";
import type { Author } from "@/lib/constants";
import { sendNotification } from "@/app/actions/notifications";
import {
  recordObedienceEvent,
  recordObedienceEventForWeek,
  getTiers as readTiers,
  setTiersRaw,
  getWeights as readObedienceWeights,
  setWeightsRaw,
  getStreakThreshold as readStreakThreshold,
  setStreakThresholdRaw,
  getStreakRiskMinDeficit as readStreakRiskMinDeficit,
  setStreakRiskMinDeficitRaw,
  getMultipliers as readMultipliers,
  setMultipliersRaw,
  getStreak,
  setStreakRaw,
  finalizeWeek,
  computeWeekScore,
  currentWeekKey,
  getEventLog,
  deleteObedienceEvent,
  getTestMode,
  setTestModeRaw,
  setManualAdjustReason,
  entryStreakKey,
  finalizedKey,
  multiplierFrozenKey,
  type ObedienceAuditEntry,
} from "@/lib/obedience";
import { redis } from "@/lib/redis";
import { SIR_NOTE_MAX } from "@/lib/reward-types";
import type { RewardClaim } from "@/lib/reward-types";
import {
  type RewardTier,
  type RewardItem,
  type ObedienceWeights,
  type ObedienceEventType,
  REWARD_TIER_COUNT,
  TUNABLE_EVENT_TYPES,
  OBEDIENCE_EVENT_TYPES,
  REWARD_LABEL_MAX,
  REWARD_BODY_MAX,
  REWARD_EMOJI_MAX,
  TIER_EMOJI_MAX,
  TIER_NAME_MAX,
  MAX_REWARDS_PER_TIER,
  MAX_TIER_THRESHOLD,
  MAX_MULTIPLIER,
  MAX_STREAK_RISK_MIN_DEFICIT,
  MANUAL_ADJUST_MIN,
  MANUAL_ADJUST_MAX,
  MANUAL_ADJUST_REASON_MAX,
} from "@/lib/reward-types";
import { requireSir } from "./_shared";

// ──────────────────────────────────────────────────────────────────
// Rewards / obedience tunables — Sir-only catalog + weight editor.
// ──────────────────────────────────────────────────────────────────

export interface RewardTiersResult {
  tiers?: RewardTier[];
  error?: string;
}

export async function getRewardTiers(): Promise<RewardTiersResult> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  try {
    return { tiers: await readTiers() };
  } catch (err) {
    logger.error("[admin] tiers read failed", err);
    return { error: "Failed to read tiers." };
  }
}

function validateTiers(tiers: unknown): RewardTier[] | { error: string } {
  if (!Array.isArray(tiers)) return { error: "Tiers must be an array." };
  if (tiers.length !== REWARD_TIER_COUNT) {
    return {
      error: `Tier count is fixed at ${REWARD_TIER_COUNT}.`,
    };
  }
  const seenTierIds = new Set<string>();
  let lastThreshold = -Infinity;
  const out: RewardTier[] = [];
  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i] as Partial<RewardTier> | null | undefined;
    if (!t || typeof t !== "object") {
      return { error: `Tier ${i + 1} is malformed.` };
    }
    const id = typeof t.id === "string" ? t.id.trim() : "";
    if (!id) return { error: `Tier ${i + 1} is missing an id.` };
    if (seenTierIds.has(id)) {
      return { error: `Duplicate tier id: ${id}.` };
    }
    seenTierIds.add(id);

    const name = typeof t.name === "string" ? t.name.trim() : "";
    if (!name) return { error: `Tier ${i + 1} needs a name.` };
    if (name.length > TIER_NAME_MAX) {
      return { error: `Tier name too long (max ${TIER_NAME_MAX}).` };
    }

    const tierEmoji = typeof t.emoji === "string" ? t.emoji.trim() : "";
    if (tierEmoji.length > TIER_EMOJI_MAX) {
      return {
        error: `Tier emoji too long (max ${TIER_EMOJI_MAX} chars).`,
      };
    }

    const threshold = Number(t.threshold);
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > MAX_TIER_THRESHOLD) {
      return {
        error: `Tier ${i + 1} threshold must be 0-${MAX_TIER_THRESHOLD}.`,
      };
    }
    if (threshold < lastThreshold) {
      return { error: "Tier thresholds must be ascending." };
    }
    lastThreshold = threshold;

    if (!Array.isArray(t.rewards)) {
      return { error: `Tier ${i + 1} rewards must be an array.` };
    }
    if (t.rewards.length > MAX_REWARDS_PER_TIER) {
      return {
        error: `Too many rewards in ${name} (max ${MAX_REWARDS_PER_TIER}).`,
      };
    }
    const seenRewardIds = new Set<string>();
    const rewards: RewardItem[] = [];
    for (let j = 0; j < t.rewards.length; j++) {
      const r = t.rewards[j] as Partial<RewardItem> | null | undefined;
      if (!r || typeof r !== "object") {
        return { error: `Reward ${j + 1} in ${name} is malformed.` };
      }
      const rid = typeof r.id === "string" ? r.id.trim() : "";
      if (!rid) {
        return { error: `Reward ${j + 1} in ${name} is missing an id.` };
      }
      if (seenRewardIds.has(rid)) {
        return { error: `Duplicate reward id in ${name}: ${rid}.` };
      }
      seenRewardIds.add(rid);

      const label = typeof r.label === "string" ? r.label.trim() : "";
      if (!label) {
        return { error: `Reward ${j + 1} in ${name} needs a label.` };
      }
      if (label.length > REWARD_LABEL_MAX) {
        return {
          error: `Reward label too long (max ${REWARD_LABEL_MAX}).`,
        };
      }
      const body = typeof r.body === "string" ? r.body.trim() : "";
      if (body.length > REWARD_BODY_MAX) {
        return {
          error: `Reward body too long (max ${REWARD_BODY_MAX}).`,
        };
      }
      const emoji = typeof r.emoji === "string" ? r.emoji.trim() : "";
      if (emoji.length > REWARD_EMOJI_MAX) {
        return {
          error: `Reward emoji too long (max ${REWARD_EMOJI_MAX} chars).`,
        };
      }
      rewards.push({
        id: rid,
        label,
        ...(body.length > 0 && { body }),
        ...(emoji.length > 0 && { emoji }),
      });
    }

    out.push({
      id,
      name,
      threshold,
      rewards,
      ...(tierEmoji.length > 0 && { emoji: tierEmoji }),
    });
  }
  return out;
}

export async function setRewardTiers(
  tiers: RewardTier[],
): Promise<{ success?: boolean; error?: string }> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };

  const validated = validateTiers(tiers);
  if ("error" in validated) return { error: validated.error };

  try {
    await setTiersRaw(validated);
    logger.interaction("[admin] reward tiers updated", {
      by: guard.session.author,
      count: validated.length,
    });
    revalidatePath("/rewards");
    revalidatePath("/admin/rewards");
    return { success: true };
  } catch (err) {
    logger.error("[admin] tiers write failed", err);
    return { error: "Save failed." };
  }
}

export interface ObedienceWeightsResult {
  weights?: ObedienceWeights;
  error?: string;
}

export async function getObedienceWeights(): Promise<ObedienceWeightsResult> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  try {
    return { weights: await readObedienceWeights() };
  } catch (err) {
    logger.error("[admin] weights read failed", err);
    return { error: "Failed to read weights." };
  }
}

export async function setObedienceWeights(
  weights: ObedienceWeights,
): Promise<{ success?: boolean; error?: string }> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  if (!weights || typeof weights !== "object") {
    return { error: "Invalid weights." };
  }
  const sanitized = {} as ObedienceWeights;
  for (const type of TUNABLE_EVENT_TYPES) {
    const v = Number((weights as Record<string, unknown>)[type]);
    if (!Number.isFinite(v) || v < -100 || v > 100) {
      return { error: `Weight for ${type} must be -100..100.` };
    }
    sanitized[type] = Math.round(v);
  }
  // manual_adjust is non-tunable; the stored default is 0 and unused
  // (every emit supplies its points value explicitly).
  sanitized.manual_adjust = 0;
  try {
    await setWeightsRaw(sanitized);
    logger.interaction("[admin] obedience weights updated", {
      by: guard.session.author,
    });
    revalidatePath("/admin/rewards");
    return { success: true };
  } catch (err) {
    logger.error("[admin] weights write failed", err);
    return { error: "Save failed." };
  }
}

export interface StreakSettingsResult {
  threshold?: number;
  multipliers?: readonly number[];
  error?: string;
}

export async function getStreakSettings(): Promise<StreakSettingsResult> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  try {
    const [threshold, multipliers] = await Promise.all([
      readStreakThreshold(),
      readMultipliers(),
    ]);
    return { threshold, multipliers };
  } catch (err) {
    logger.error("[admin] streak settings read failed", err);
    return { error: "Failed to read streak settings." };
  }
}

export async function setStreakSettings(
  threshold: number,
  multipliers: number[],
  streakRiskMinDeficit?: number,
): Promise<{ success?: boolean; error?: string }> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  if (
    !Number.isFinite(threshold) ||
    threshold < 0 ||
    threshold > MAX_TIER_THRESHOLD
  ) {
    return { error: `Threshold must be 0-${MAX_TIER_THRESHOLD}.` };
  }
  if (!Array.isArray(multipliers) || multipliers.length === 0) {
    return { error: "Multipliers must be a non-empty array." };
  }
  if (multipliers.length > 10) {
    return { error: "Too many multiplier steps (max 10)." };
  }
  for (const m of multipliers) {
    if (!Number.isFinite(m) || m < 0 || m > MAX_MULTIPLIER) {
      return { error: `Each multiplier must be 0-${MAX_MULTIPLIER}.` };
    }
  }
  let normalizedDeficit: number | undefined;
  if (streakRiskMinDeficit !== undefined) {
    if (
      !Number.isFinite(streakRiskMinDeficit) ||
      streakRiskMinDeficit < 1 ||
      streakRiskMinDeficit > MAX_STREAK_RISK_MIN_DEFICIT
    ) {
      return {
        error: `Streak-risk min deficit must be 1-${MAX_STREAK_RISK_MIN_DEFICIT}.`,
      };
    }
    normalizedDeficit = Math.round(streakRiskMinDeficit);
  }
  try {
    const writes: Promise<unknown>[] = [
      setStreakThresholdRaw(Math.round(threshold)),
      setMultipliersRaw(multipliers.map((m) => Number(m.toFixed(2)))),
    ];
    if (normalizedDeficit !== undefined) {
      writes.push(setStreakRiskMinDeficitRaw(normalizedDeficit));
    }
    await Promise.all(writes);
    logger.interaction("[admin] streak settings updated", {
      by: guard.session.author,
      threshold,
      multipliers,
      ...(normalizedDeficit !== undefined
        ? { streakRiskMinDeficit: normalizedDeficit }
        : {}),
    });
    revalidatePath("/admin/rewards");
    return { success: true };
  } catch (err) {
    logger.error("[admin] streak settings write failed", err);
    return { error: "Save failed." };
  }
}

export interface RecomputeWeekResult {
  success?: boolean;
  error?: string;
  finalized?: boolean;
  reason?: string;
  displayedScore?: number;
}

export async function recomputeWeek(
  author: Author,
  weekKey: string,
): Promise<RecomputeWeekResult> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  if (author !== "T7SEN" && author !== "Besho") {
    return { error: "Invalid author." };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekKey)) {
    return { error: "Invalid week key." };
  }
  try {
    const result = await finalizeWeek(author, weekKey);
    logger.interaction("[admin] week recomputed", {
      by: guard.session.author,
      author,
      weekKey,
      ...result,
    });
    revalidatePath("/rewards");
    revalidatePath("/admin/rewards");
    return { success: true, ...result };
  } catch (err) {
    logger.error("[admin] recompute failed", err);
    return { error: "Recompute failed." };
  }
}

export interface ObedienceAdminSnapshot {
  besho: {
    currentWeek: { weekKey: string; rawScore: number; displayedScore: number };
    streak: number;
  };
  weights: ObedienceWeights;
  tiers: RewardTier[];
  streakThreshold: number;
  /** Minimum displayed-pts deficit before the Friday streak-at-risk
   *  FCM fires. Default 1; raise to suppress trivial nudges. */
  streakRiskMinDeficit: number;
  multipliers: readonly number[];
  generatedAt: number;
}

export async function getObedienceAdminSnapshot(): Promise<{
  snapshot?: ObedienceAdminSnapshot;
  error?: string;
}> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  try {
    const [tiers, weights, threshold, mults, streak, streakRiskMinDeficit] =
      await Promise.all([
        readTiers(),
        readObedienceWeights(),
        readStreakThreshold(),
        readMultipliers(),
        getStreak("Besho"),
        readStreakRiskMinDeficit(),
      ]);
    const weekKey = currentWeekKey();
    const score = await computeWeekScore("Besho", weekKey);
    return {
      snapshot: {
        besho: {
          currentWeek: {
            weekKey,
            rawScore: score.rawScore,
            displayedScore: score.displayedScore,
          },
          streak,
        },
        weights,
        tiers,
        streakThreshold: threshold,
        streakRiskMinDeficit,
        multipliers: mults,
        generatedAt: Date.now(),
      },
    };
  } catch (err) {
    logger.error("[admin] obedience snapshot failed", err);
    return { error: "Snapshot failed." };
  }
}

export async function adminSetStreakRaw(
  author: Author,
  value: number,
): Promise<{ success?: boolean; error?: string }> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  if (author !== "T7SEN" && author !== "Besho") {
    return { error: "Invalid author." };
  }
  const n = Math.max(0, Math.floor(Number(value)));
  if (!Number.isFinite(n)) return { error: "Invalid streak value." };
  try {
    await setStreakRaw(author, n);
    logger.interaction("[admin] streak override", {
      by: guard.session.author,
      author,
      value: n,
    });
    revalidatePath("/admin/rewards");
    revalidatePath("/rewards");
    return { success: true };
  } catch (err) {
    logger.error("[admin] streak override failed", err);
    return { error: "Override failed." };
  }
}

// ──────────────────────────────────────────────────────────────────
// Manual obedience adjustment — Sir grants ad-hoc points or penalty.
// Lands as a `manual_adjust` event with the supplied points value.
// ──────────────────────────────────────────────────────────────────

export interface AdjustScoreArgs {
  author: Author;
  points: number;
  reason: string;
  /** Optional override; defaults to the current week. */
  weekKey?: string;
  /** When true, also fire an FCM to the affected author with the
   *  reason as the body. Default false — Sir often makes silent
   *  adjustments and shouldn't be forced to ping every time. */
  notify?: boolean;
}

// ──────────────────────────────────────────────────────────────────
// Obedience event log — Sir-only audit per (author, weekKey).
// ──────────────────────────────────────────────────────────────────

export interface ObedienceEventLogResult {
  entries?: ObedienceAuditEntry[];
  /** Total members in the audit ZSET for this (author, weekKey).
   *  Lets the UI render "showing N of M" + load-more affordance. */
  total?: number;
  /** Echo of the offset applied — useful to detect drift between the
   *  client's accumulated buffer and the server's slice. */
  offset?: number;
  weekKey?: string;
  author?: Author;
  error?: string;
}

// ──────────────────────────────────────────────────────────────────
// Test mode — Sir-only flag that opens current-week claims so the
// full claim → deliver flow can be exercised without ending the week.
// ──────────────────────────────────────────────────────────────────

export interface TestModeResult {
  on?: boolean;
  error?: string;
}

export async function getTestModeState(): Promise<TestModeResult> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  try {
    return { on: await getTestMode() };
  } catch (err) {
    logger.error("[admin] test mode read failed", err);
    return { error: "Read failed." };
  }
}

export async function setTestModeState(
  on: boolean,
): Promise<{ success?: boolean; error?: string; on?: boolean }> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  try {
    await setTestModeRaw(on);
    logger.interaction("[admin] test mode toggled", {
      on,
      by: guard.session.author,
    });
    revalidatePath("/admin/rewards");
    revalidatePath("/rewards");
    return { success: true, on };
  } catch (err) {
    logger.error("[admin] test mode toggle failed", err);
    return { error: "Toggle failed." };
  }
}

export async function adminPurgeTestClaims(): Promise<{
  success?: boolean;
  error?: string;
  removed?: number;
}> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  try {
    const { purgeTestClaimsRaw } = await import("@/app/actions/rewards");
    const result = await purgeTestClaimsRaw();
    logger.warn("[admin] test claims purged", {
      by: guard.session.author,
      removed: result.removed,
    });
    revalidatePath("/admin/rewards");
    revalidatePath("/rewards");
    return { success: true, removed: result.removed };
  } catch (err) {
    logger.error("[admin] test claim purge failed", err);
    return { error: "Purge failed." };
  }
}

export interface DeleteObedienceEventArgs {
  author: Author;
  weekKey: string;
  type: ObedienceEventType;
  eventId: string;
}

export async function adminDeleteObedienceEvent(
  args: DeleteObedienceEventArgs,
): Promise<{
  success?: boolean;
  error?: string;
  pointsRemoved?: number;
  removed?: boolean;
}> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  if (args.author !== "T7SEN" && args.author !== "Besho") {
    return { error: "Invalid author." };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.weekKey)) {
    return { error: "Invalid week key." };
  }
  if (!OBEDIENCE_EVENT_TYPES.includes(args.type)) {
    return { error: "Invalid event type." };
  }
  if (
    !args.eventId ||
    typeof args.eventId !== "string" ||
    args.eventId.length > 200
  ) {
    return { error: "Invalid event id." };
  }
  try {
    const result = await deleteObedienceEvent(
      args.author,
      args.weekKey,
      args.type,
      args.eventId,
    );
    logger.interaction("[admin] obedience event deleted", {
      by: guard.session.author,
      author: args.author,
      weekKey: args.weekKey,
      type: args.type,
      eventId: args.eventId,
      pointsRemoved: result.pointsRemoved,
      removedFromEvents: result.removedFromEvents,
      removedFromAudit: result.removedFromAudit,
    });
    revalidatePath("/admin/rewards");
    revalidatePath("/rewards");
    return {
      success: true,
      pointsRemoved: result.pointsRemoved,
      removed: result.removedFromEvents > 0,
    };
  } catch (err) {
    logger.error("[admin] event delete failed", err);
    return { error: "Delete failed." };
  }
}

export async function getObedienceEventLog(
  author: Author,
  weekKey?: string,
  limit: number = 200,
  offset: number = 0,
): Promise<ObedienceEventLogResult> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  if (author !== "T7SEN" && author !== "Besho") {
    return { error: "Invalid author." };
  }
  const targetWeek = weekKey?.trim() || currentWeekKey();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetWeek)) {
    return { error: "Invalid week key." };
  }
  const safeLimit = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 0)));
  const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
  try {
    const page = await getEventLog(author, targetWeek, safeLimit, safeOffset);
    return {
      entries: page.entries,
      total: page.total,
      offset: safeOffset,
      weekKey: targetWeek,
      author,
    };
  } catch (err) {
    logger.error("[admin] event log read failed", err);
    return { error: "Read failed." };
  }
}

export async function adminAdjustScore(
  args: AdjustScoreArgs,
): Promise<{ success?: boolean; error?: string; eventId?: string }> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  if (args.author !== "T7SEN" && args.author !== "Besho") {
    return { error: "Invalid author." };
  }
  if (
    !Number.isFinite(args.points) ||
    args.points < MANUAL_ADJUST_MIN ||
    args.points > MANUAL_ADJUST_MAX
  ) {
    return {
      error: `Points must be ${MANUAL_ADJUST_MIN}..${MANUAL_ADJUST_MAX}.`,
    };
  }
  const rounded = Math.round(args.points);
  if (rounded === 0) return { error: "Adjustment cannot be zero." };
  const reason = (args.reason ?? "").trim();
  if (!reason) return { error: "Reason is required." };
  if (reason.length > MANUAL_ADJUST_REASON_MAX) {
    return {
      error: `Reason too long (max ${MANUAL_ADJUST_REASON_MAX}).`,
    };
  }
  if (
    args.weekKey !== undefined &&
    !/^\d{4}-\d{2}-\d{2}$/.test(args.weekKey)
  ) {
    return { error: "Invalid week key." };
  }
  try {
    const ts = Date.now();
    const eventId = crypto.randomUUID();
    const targetWeekKey = args.weekKey ?? currentWeekKey(ts);
    // Pass `reason` as the obedience helper's `note` arg — it rides
    // into the `[obedience] event` activity-log entry next to the
    // points/eventId. Mirrors the `setRestraintState(on, note?)` shape.
    if (args.weekKey) {
      await recordObedienceEventForWeek(
        args.author,
        "manual_adjust",
        eventId,
        args.weekKey,
        rounded,
        reason,
      );
    } else {
      await recordObedienceEvent(
        args.author,
        "manual_adjust",
        eventId,
        ts,
        rounded,
        reason,
      );
    }
    // Persist the reason so the Event log row + Breakdown row can
    // render with the actual reason instead of the generic "Manual
    // adjustment" label. See `manualReasonsKey` for the storage shape.
    await setManualAdjustReason(args.author, targetWeekKey, eventId, reason);
    // Activity-log headline uses the reason directly so Sir scanning
    // /admin/logs sees the WHY first, not a generic "manual obedience
    // adjust" string. The `[admin]` prefix keeps it filtered alongside
    // other admin actions.
    logger.interaction(`[admin] ${reason}`, {
      by: guard.session.author,
      author: args.author,
      points: rounded,
      weekKey: args.weekKey ?? "current",
      eventId,
      notified: !!args.notify,
    });

    // Optional FCM. The toggle defaults off in the UI — Sir frequently
    // makes silent adjustments. When on, the recipient sees a push
    // titled with the signed points and the reason as the body.
    if (args.notify) {
      const sign = rounded >= 0 ? "+" : "";
      try {
        await sendNotification(args.author, {
          title: `${sign}${rounded} pts`,
          body: reason,
          url: "/rewards",
        });
      } catch (err) {
        // Best-effort — the obedience event already landed. Don't
        // surface this to the caller; activity log captures the failure.
        logger.error("[admin] manual adjust notify failed", err, {
          eventId,
          author: args.author,
        });
      }
    }

    revalidatePath("/admin/rewards");
    revalidatePath("/rewards");
    return { success: true, eventId };
  } catch (err) {
    logger.error("[admin] manual adjust failed", err);
    return { error: "Adjust failed." };
  }
}

// ──────────────────────────────────────────────────────────────────
// Recovery: force-recompute a past week with an explicit entry-streak.
//
// Use case: the week was finalized with the wrong entry-streak (e.g.
// a streak adjustment was made in the gap between week-end and cron-
// run on a pre-fix deploy, OR the first-ever obedience week was
// finalized against a non-zero streak left over from testing). The
// existing `recomputeWeek` action calls `finalizeWeek` directly, but
// `finalizeWeek` bails when the finalized sentinel already exists, so
// it has no effect on already-finalized weeks.
//
// This action atomically:
//   1. Writes the entry-streak snapshot for the target week (so
//      finalizeWeek's `computeWeekScore` reads the correct value)
//   2. DELs `obedience:finalized:{author}:{weekKey}` (release the lock)
//   3. DELs `obedience:multiplier:{author}:{weekKey}` (clear the freeze)
//   4. Calls `finalizeWeek` which reads the new snapshot and re-freezes
//
// Caveats Sir should know:
//   - This overwrites `obedience:entry-streak:{author}:{nextWeekKey}`
//     because the finalize writes that as a side effect. If the next
//     week was already finalized, its frozen multiplier won't change
//     (it was frozen earlier), but its streakEntering display may
//     shift the next time `computeWeekScore` reads it for an
//     unfinalized state. For a clean cascade, re-run this action on
//     each subsequent finalized week with the corrected entry-streak.
//   - The recap FCM may re-fire because `notifyWeekClosed` has its
//     own dedup sentinel (`obedience:week-wrapped-fcm:*`). If that
//     sentinel is also DEL'd by Sir via /admin/redis, the FCM
//     re-fires; otherwise it's a silent recompute.
// ──────────────────────────────────────────────────────────────────

export interface AdminForceRecomputeWeekArgs {
  author: Author;
  weekKey: string;
  entryStreak: number;
}

export async function adminForceRecomputeWeek(
  args: AdminForceRecomputeWeekArgs,
): Promise<{
  success?: boolean;
  error?: string;
  displayedScore?: number;
  multiplier?: number;
}> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  if (args.author !== "T7SEN" && args.author !== "Besho") {
    return { error: "Invalid author." };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.weekKey)) {
    return { error: "Invalid week key (expected YYYY-MM-DD)." };
  }
  const n = Math.max(0, Math.floor(Number(args.entryStreak)));
  if (!Number.isFinite(n)) {
    return { error: "Entry streak must be a non-negative integer." };
  }
  // The week must be in the past — finalizeWeek refuses current/future.
  if (args.weekKey >= currentWeekKey()) {
    return { error: "Week must be in the past." };
  }

  try {
    // Step 1+2+3: write entry-streak snapshot AND release the
    // finalize lock + frozen multiplier in one pipeline. The
    // snapshot lands first so when finalizeWeek calls
    // computeWeekScore, the snapshot is already in place.
    const pipeline = redis.pipeline();
    if (n <= 0) {
      pipeline.del(entryStreakKey(args.author, args.weekKey));
    } else {
      pipeline.set(entryStreakKey(args.author, args.weekKey), n);
    }
    pipeline.del(finalizedKey(args.author, args.weekKey));
    pipeline.del(multiplierFrozenKey(args.author, args.weekKey));
    await pipeline.exec();

    // Step 4: re-finalize. Now the lock is released so the SET NX
    // inside finalizeWeek succeeds; it reads the entry-streak we
    // just wrote and freezes the correct multiplier.
    const result = await finalizeWeek(args.author, args.weekKey);

    logger.warn("[admin] force-recompute week", {
      by: guard.session.author,
      author: args.author,
      weekKey: args.weekKey,
      entryStreak: n,
      result,
    });
    revalidatePath("/admin/rewards");
    revalidatePath("/rewards");
    return {
      success: true,
      displayedScore: result.displayedScore,
    };
  } catch (err) {
    logger.error("[admin] force-recompute failed", err);
    return { error: "Force-recompute failed." };
  }
}

// ──────────────────────────────────────────────────────────────────
// Recovery: grant a reward retroactively.
//
// Use case: kitten claimed a reward for a past week, Sir denied then
// revoked the denial (or some other terminal-state mishap), and the
// reward never got delivered. The normal claim flow is closed — only
// the immediately prior week is claimable, the revoked record is
// terminal, and the per-week slot key may still be held.
//
// This action creates a FRESH `reward:claim:{id}` record directly in
// `delivered` state. It does NOT touch the existing claim record(s)
// for that week — those stay as historical audit. It does NOT touch
// the per-week slot key (intentionally — the slot's semantic is
// "kitten's choice for the week"; this is Sir's grant, parallel).
//
// Constraints:
//   - Sir picks the tier + reward from the current tier catalog.
//   - The week must be a past week. Future weeks make no sense for
//     a retroactive grant; current week kitten can claim normally.
//   - Tier-threshold enforcement is bypassed — Sir's discretion.
// ──────────────────────────────────────────────────────────────────

export interface AdminGrantPastRewardArgs {
  author: Author;
  weekKey: string;
  tierId: string;
  rewardId: string;
  sirNote?: string;
}

export async function adminGrantPastReward(
  args: AdminGrantPastRewardArgs,
): Promise<{ success?: boolean; error?: string; claimId?: string }> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  if (args.author !== "T7SEN" && args.author !== "Besho") {
    return { error: "Invalid author." };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.weekKey)) {
    return { error: "Invalid week key (expected YYYY-MM-DD)." };
  }
  if (args.weekKey >= currentWeekKey()) {
    return { error: "Week must be in the past." };
  }
  const note = (args.sirNote ?? "").trim();
  if (note.length > SIR_NOTE_MAX) {
    return { error: `Note too long (max ${SIR_NOTE_MAX}).` };
  }

  try {
    const tiers = await readTiers();
    const tier = tiers.find((t) => t.id === args.tierId);
    if (!tier) return { error: "Tier not found in catalog." };
    const reward = tier.rewards.find((r) => r.id === args.rewardId);
    if (!reward) return { error: "Reward not found in tier." };

    // Read the week's actual displayedScore for the audit trail —
    // even though we're bypassing the threshold check.
    const score = await computeWeekScore(args.author, args.weekKey);

    const now = Date.now();
    const id = crypto.randomUUID();
    const claim: RewardClaim = {
      id,
      author: args.author,
      weekKey: args.weekKey,
      tierId: tier.id,
      tierName: tier.name,
      ...(tier.emoji && { tierEmoji: tier.emoji }),
      rewardId: reward.id,
      rewardLabel: reward.label,
      ...(reward.body && { rewardBody: reward.body }),
      ...(reward.emoji && { rewardEmoji: reward.emoji }),
      status: "delivered",
      requestedAt: now,
      respondedAt: now,
      respondedBy: guard.session.author,
      ...(note.length > 0 && { sirNote: note }),
      // Snapshot the score at grant time. Threshold-bypass is
      // surfaced by `claimedScore < claimedTierThreshold`.
      claimedScore: score.displayedScore,
      claimedTierThreshold: tier.threshold,
    };

    const pipeline = redis.pipeline();
    pipeline.set(`reward:claim:${id}`, claim);
    pipeline.zadd(`rewards:claims:by-author:${args.author}`, {
      score: now,
      member: id,
    });
    // Skip CLAIMS_PENDING_KEY (it's delivered, not pending).
    // Skip claim:by-week — intentional. This is a parallel admin
    // grant, not kitten's choice. Existing records for that week
    // (denied, revoked, rerolled, whatever) stay as history.
    await pipeline.exec();

    // Notify kitten with celebratory wording — this isn't a normal
    // delivery, it's a make-good.
    try {
      await sendNotification(args.author, {
        title: "🎁 Reward granted retroactively",
        body: note.length > 0
          ? `${tier.name}: ${reward.label} — ${note}`
          : `${tier.name}: ${reward.label}`,
        url: "/rewards",
      });
    } catch (err) {
      logger.error("[admin] retroactive grant notify failed", err, {
        claimId: id,
      });
    }

    logger.interaction("[admin] retroactive reward granted", {
      by: guard.session.author,
      author: args.author,
      weekKey: args.weekKey,
      tierId: tier.id,
      rewardId: reward.id,
      claimId: id,
      note: note.length > 0 ? note : undefined,
    });
    revalidatePath("/admin/rewards");
    revalidatePath("/rewards");
    return { success: true, claimId: id };
  } catch (err) {
    logger.error("[admin] retroactive grant failed", err);
    return { error: "Grant failed." };
  }
}
