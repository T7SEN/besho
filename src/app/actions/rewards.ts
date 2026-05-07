// src/app/actions/rewards.ts
"use server";

import { Redis } from "@upstash/redis";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { decrypt } from "@/lib/auth-utils";
import { sendNotification } from "@/app/actions/notifications";
import { logger } from "@/lib/logger";
import { assertWriteAllowed } from "@/lib/restraint";
import type { Author } from "@/lib/constants";
import {
  currentWeekKey,
  getStreakThreshold,
  getWeekState,
  shiftWeekKey,
  multiplierForStreak,
  getMultipliers,
  getTestMode,
} from "@/lib/obedience";
import {
  type ObedienceWeekState,
  type RewardClaim,
  type ClaimStatus,
  SIR_NOTE_MAX,
} from "@/lib/reward-types";

const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

const claimKey = (id: string) => `reward:claim:${id}`;
const claimsByAuthorKey = (author: Author) =>
  `rewards:claims:by-author:${author}`;
const CLAIMS_PENDING_KEY = "rewards:claims:pending";
const claimByWeekKey = (author: Author, weekKey: string) =>
  `rewards:claims:by-week:${author}:${weekKey}`;

async function getSession() {
  const cookieStore = await cookies();
  const value = cookieStore.get("session")?.value;
  if (!value) return null;
  return decrypt(value);
}

// ── Bundle for /rewards page ─────────────────────────────────────────────

export interface RewardsBundle {
  viewer: Author;
  /** Score state of the score-bearing user (always Besho currently). */
  besho: ObedienceWeekState;
  currentWeekKey: string;
  /** Most-recent finalized prior week (the claimable one if any). */
  priorWeekKey: string;
  priorBesho: ObedienceWeekState;
  /** Sir-only — the claim awaiting his decision, if any. */
  pendingClaim: RewardClaim | null;
  /** Caller's own claim history (Besho only — Sir has none). */
  myClaims: RewardClaim[];
  /** Whether Besho already claimed for the prior week. */
  priorClaim: RewardClaim | null;
  /** Whether Besho already claimed for the CURRENT week (only meaningful
   *  when test mode is on; null otherwise to keep the UI simple). */
  currentClaim: RewardClaim | null;
  /** Sir-controlled flag that opens current-week claims. */
  testModeOn: boolean;
  streakThreshold: number;
  multipliers: readonly number[];
}

/** Both authors. Sir gets Besho's score view; Besho gets her own. */
export async function getRewardsBundle(): Promise<{
  bundle?: RewardsBundle;
  error?: string;
}> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };

  try {
    // Finalization is cron-only. Page reads must NEVER finalize a week —
    // that fires recap FCMs as a side-effect, and on a fresh deploy or
    // long absence catchUpFinalizations would push 4×2=8 notifications
    // on a single /rewards visit. The obedience-sweep cron at
    // `/api/cron/obedience-sweep` (daily) is the sole finalize trigger.
    // Until the cron runs, prior weeks read unfinalized — `computeWeekScore`
    // handles that path correctly (live multiplier from stored streak).
    const current = currentWeekKey();
    const prior = shiftWeekKey(current, -1);

    const [
      besho,
      priorBesho,
      threshold,
      mults,
      myClaims,
      priorClaim,
      currentClaim,
      testModeOn,
    ] = await Promise.all([
      getWeekState("Besho", current),
      getWeekState("Besho", prior),
      getStreakThreshold(),
      getMultipliers(),
      listClaimsForAuthor(session.author === "Besho" ? "Besho" : "Besho"),
      readClaimForWeek("Besho", prior),
      readClaimForWeek("Besho", current),
      getTestMode(),
    ]);

    let pendingClaim: RewardClaim | null = null;
    if (session.author === "T7SEN") {
      // Sir sees the most recent pending claim.
      pendingClaim = await readMostRecentPendingClaim();
    }

    return {
      bundle: {
        viewer: session.author,
        besho,
        currentWeekKey: current,
        priorWeekKey: prior,
        priorBesho,
        pendingClaim,
        myClaims: session.author === "Besho" ? myClaims : [],
        priorClaim,
        currentClaim,
        testModeOn,
        streakThreshold: threshold,
        multipliers: mults,
      },
    };
  } catch (err) {
    logger.error("[rewards] bundle failed", err);
    return { error: "Failed to load rewards." };
  }
}

// ── Claim flow ───────────────────────────────────────────────────────────

export interface ClaimRewardArgs {
  weekKey: string;
  tierId: string;
  rewardId: string;
}

export async function claimReward(
  args: ClaimRewardArgs,
): Promise<{ success?: boolean; error?: string; claimId?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "Besho") {
    return { error: "Only kitten can claim rewards." };
  }

  const block = await assertWriteAllowed(session.author);
  if (block) return block;

  const current = currentWeekKey();
  const prior = shiftWeekKey(current, -1);
  // Test mode lets Sir exercise the full claim → deliver flow against
  // the CURRENT week. The week itself isn't finalized — no streak
  // bump, no frozen multiplier — so testing leaves the score
  // machinery unaffected. Otherwise the normal rule applies: only the
  // immediately prior week is claimable; older weeks lapse.
  const testMode = await getTestMode();
  const allowed = testMode ? new Set([prior, current]) : new Set([prior]);
  if (!allowed.has(args.weekKey)) {
    if (args.weekKey >= current) {
      return {
        error: testMode
          ? "Pick the current or prior week."
          : "Week is not closed yet.",
      };
    }
    return { error: "That week's claim window has closed." };
  }

  try {
    // Enforce one claim per week.
    const existingId = await redis.get<string>(
      claimByWeekKey("Besho", args.weekKey),
    );
    if (existingId) {
      return { error: "You already claimed for this week." };
    }

    const state = await getWeekState("Besho", args.weekKey);
    const tier = state.tiers.find((t) => t.id === args.tierId);
    if (!tier) return { error: "Tier not found." };
    if (state.displayedScore < tier.threshold) {
      return { error: "You did not earn that tier." };
    }
    const reward = tier.rewards.find((r) => r.id === args.rewardId);
    if (!reward) return { error: "Reward not found." };

    const now = Date.now();
    const claim: RewardClaim = {
      id: crypto.randomUUID(),
      author: "Besho",
      weekKey: args.weekKey,
      tierId: tier.id,
      tierName: tier.name,
      ...(tier.emoji && { tierEmoji: tier.emoji }),
      rewardId: reward.id,
      rewardLabel: reward.label,
      ...(reward.body && { rewardBody: reward.body }),
      ...(reward.emoji && { rewardEmoji: reward.emoji }),
      status: "pending",
      requestedAt: now,
      claimedScore: state.displayedScore,
      claimedTierThreshold: tier.threshold,
    };

    const pipeline = redis.pipeline();
    pipeline.set(claimKey(claim.id), claim);
    pipeline.zadd(claimsByAuthorKey("Besho"), {
      score: now,
      member: claim.id,
    });
    pipeline.zadd(CLAIMS_PENDING_KEY, { score: now, member: claim.id });
    pipeline.set(claimByWeekKey("Besho", args.weekKey), claim.id);
    await pipeline.exec();

    await sendNotification("T7SEN", {
      title: "🎁 Reward claim",
      body: `kitten claimed ${tier.name}: ${reward.label}`,
      url: "/rewards",
    });

    logger.interaction("[rewards] claim submitted", {
      claimId: claim.id,
      weekKey: args.weekKey,
      tier: tier.id,
      reward: reward.id,
      score: state.displayedScore,
    });
    revalidatePath("/rewards");
    return { success: true, claimId: claim.id };
  } catch (err) {
    logger.error("[rewards] claim failed", err);
    return { error: "Claim failed." };
  }
}

export async function deliverClaim(
  claimId: string,
  noteRaw?: string,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "T7SEN") {
    return { error: "Only Sir can deliver claims." };
  }
  return updateClaimDecision(claimId, "delivered", session.author, noteRaw);
}

export async function denyClaim(
  claimId: string,
  noteRaw?: string,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "T7SEN") {
    return { error: "Only Sir can deny claims." };
  }
  return updateClaimDecision(claimId, "denied", session.author, noteRaw);
}

async function updateClaimDecision(
  claimId: string,
  decision: ClaimStatus,
  by: Author,
  noteRaw?: string,
): Promise<{ success?: boolean; error?: string }> {
  if (decision !== "delivered" && decision !== "denied") {
    return { error: "Invalid decision." };
  }
  const trimmed = (noteRaw ?? "").trim();
  if (trimmed.length > SIR_NOTE_MAX) {
    return { error: `Note too long (max ${SIR_NOTE_MAX}).` };
  }

  try {
    const existing = await redis.get<RewardClaim>(claimKey(claimId));
    if (!existing) return { error: "Claim not found." };
    if (existing.status !== "pending") {
      return { error: "Claim already decided." };
    }

    const now = Date.now();
    const updated: RewardClaim = {
      ...existing,
      status: decision,
      respondedAt: now,
      respondedBy: by,
      ...(trimmed.length > 0 && { sirNote: trimmed }),
    };

    const pipeline = redis.pipeline();
    pipeline.set(claimKey(claimId), updated);
    pipeline.zrem(CLAIMS_PENDING_KEY, claimId);
    await pipeline.exec();

    const titleByDecision: Record<"delivered" | "denied", string> = {
      delivered: "🎁 Reward delivered",
      denied: "✗ Reward denied",
    };
    const body = trimmed.length > 0
      ? trimmed
      : `${existing.tierName}: ${existing.rewardLabel}`;
    await sendNotification(existing.author, {
      title: titleByDecision[decision],
      body,
      url: "/rewards",
    });

    logger.interaction("[rewards] claim decided", {
      claimId,
      decision,
      tier: existing.tierId,
      reward: existing.rewardId,
      by,
    });
    revalidatePath("/rewards");
    return { success: true };
  } catch (err) {
    logger.error("[rewards] claim decision failed", err);
    return { error: "Decision failed." };
  }
}

// ── List + read helpers ──────────────────────────────────────────────────

export async function listClaimsForAuthor(
  author: Author,
  limit: number = 30,
): Promise<RewardClaim[]> {
  try {
    const ids =
      ((await redis.zrange<unknown[]>(
        claimsByAuthorKey(author),
        0,
        limit - 1,
        { rev: true },
      )) ?? []).map(String);
    if (!ids.length) return [];
    const records = (await redis.mget<RewardClaim[]>(
      ...ids.map((id) => claimKey(id)),
    )) ?? [];
    return records.filter((r): r is RewardClaim => !!r);
  } catch (err) {
    logger.error("[rewards] list failed", err);
    return [];
  }
}

export async function listPendingClaims(): Promise<RewardClaim[]> {
  const session = await getSession();
  if (session?.author !== "T7SEN") return [];
  try {
    const ids =
      ((await redis.zrange<unknown[]>(CLAIMS_PENDING_KEY, 0, -1, {
        rev: true,
      })) ?? []).map(String);
    if (!ids.length) return [];
    const records = (await redis.mget<RewardClaim[]>(
      ...ids.map((id) => claimKey(id)),
    )) ?? [];
    return records.filter((r): r is RewardClaim => !!r);
  } catch (err) {
    logger.error("[rewards] pending list failed", err);
    return [];
  }
}

async function readMostRecentPendingClaim(): Promise<RewardClaim | null> {
  try {
    const ids =
      ((await redis.zrange<unknown[]>(CLAIMS_PENDING_KEY, 0, 0, {
        rev: true,
      })) ?? []).map(String);
    if (!ids.length) return null;
    const rec = await redis.get<RewardClaim>(claimKey(ids[0]));
    return rec ?? null;
  } catch {
    return null;
  }
}

async function readClaimForWeek(
  author: Author,
  weekKey: string,
): Promise<RewardClaim | null> {
  try {
    const id = await redis.get<string>(claimByWeekKey(author, weekKey));
    if (!id) return null;
    const rec = await redis.get<RewardClaim>(claimKey(id));
    return rec ?? null;
  } catch {
    return null;
  }
}

// ── Sir-only multiplier preview (for /admin/rewards display) ──────────────

export async function previewMultiplierForStreak(
  streak: number,
): Promise<number> {
  const mults = await getMultipliers();
  return multiplierForStreak(streak, mults);
}

// ── Score history archive ────────────────────────────────────────────────

export interface RewardsHistoryEntry {
  weekKey: string;
  rawScore: number;
  displayedScore: number;
  multiplier: number;
  tier: {
    id: string;
    name: string;
    threshold: number;
    emoji?: string;
  } | null;
  claim: RewardClaim | null;
  finalized: boolean;
}

export interface RewardsHistoryResult {
  entries?: RewardsHistoryEntry[];
  error?: string;
}

/**
 * Walks back `limit` past weeks (newest first) and returns score state +
 * claim outcome for each. Both authors can read — Sir sees Besho's
 * history, Besho sees her own. Skips empty weeks (zero events AND no
 * claim) so the list doesn't pad with inactivity. Always includes the
 * immediately prior week regardless, so the display has something to
 * anchor on after a quiet stretch.
 */
export async function getRewardsHistory(
  limit: number = 12,
): Promise<RewardsHistoryResult> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };

  const safeLimit = Math.max(1, Math.min(52, Math.floor(limit)));
  try {
    const current = currentWeekKey();
    const out: RewardsHistoryEntry[] = [];
    for (let i = 1; i <= safeLimit; i++) {
      const weekKey = shiftWeekKey(current, -i);
      const [state, claim] = await Promise.all([
        getWeekState("Besho", weekKey),
        readClaimForWeek("Besho", weekKey),
      ]);
      const isEmpty =
        state.breakdown.length === 0 && state.displayedScore === 0 && !claim;
      const isFirstPrior = i === 1;
      if (isEmpty && !isFirstPrior) continue;
      out.push({
        weekKey,
        rawScore: state.rawScore,
        displayedScore: state.displayedScore,
        multiplier: state.multiplier,
        tier: state.unlockedTier
          ? {
              id: state.unlockedTier.id,
              name: state.unlockedTier.name,
              threshold: state.unlockedTier.threshold,
              ...(state.unlockedTier.emoji && {
                emoji: state.unlockedTier.emoji,
              }),
            }
          : null,
        claim,
        finalized: weekKey < current, // current is never finalized
      });
    }
    return { entries: out };
  } catch (err) {
    logger.error("[rewards] history failed", err);
    return { error: "History failed." };
  }
}
