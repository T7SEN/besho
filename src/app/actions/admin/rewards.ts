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
  type ObedienceAuditEntry,
} from "@/lib/obedience";
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
