// src/app/actions/rewards.ts
"use server";

import { redis } from "@/lib/redis";
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
  type ClaimAuditEntry,
  SIR_NOTE_MAX,
  REVOKE_REASON_MAX,
  ACKNOWLEDGE_NOTE_MAX,
  CLAIM_AUDIT_LIMIT,
  BULK_DENY_MAX_DAYS,
} from "@/lib/reward-types";

const claimKey = (id: string) => `reward:claim:${id}`;
const claimsByAuthorKey = (author: Author) =>
  `rewards:claims:by-author:${author}`;
const CLAIMS_PENDING_KEY = "rewards:claims:pending";
const claimByWeekKey = (author: Author, weekKey: string) =>
  `rewards:claims:by-week:${author}:${weekKey}`;
/** Per-claim audit log. Capped via LTRIM 0 19 (20 entries). Mirrors
 *  `permission:audit:{id}`. Each entry is a snapshot of the prior
 *  state taken before the next mutation; the latest state is on the
 *  claim record itself. */
const claimAuditKey = (id: string) => `reward:claim:audit:${id}`;

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
      priorClaimRaw,
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
    // Prior-week claim must be a real one. A leftover test claim from
    // when the prior week was current shouldn't trigger the
    // "Last week's claim" path — it pollutes the real claim flow.
    const priorClaim =
      priorClaimRaw && priorClaimRaw.testMode === true
        ? null
        : priorClaimRaw;

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
    // Identify test-path claims by their weekKey at claim time. The
    // current week is only acceptable when test mode is on (gated
    // above), so weekKey === current is a reliable test signal.
    const isTestClaim = args.weekKey === current;
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
      ...(isTestClaim && { testMode: true }),
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
    if (existing.status === "revoked") {
      return { error: "Revoked claims can't be re-decided." };
    }
    // Re-decides allowed:
    //   pending  → delivered / denied  (initial decision)
    //   delivered ⇄ denied              (Sir changed his mind)
    //   rerolled → delivered / denied   (Sir reverses his own reroll —
    //     either honors the originally-claimed reward after all, or
    //     hardens the refusal into a denial). The per-week slot key
    //     is intentionally NOT re-set when transitioning out of
    //     rerolled — kitten may have already claimed something else
    //     for the week. Sir manages double-claim cases via revoke
    //     on the newer record if needed.
    // Only `revoked` is terminal; rerolled accepts deliver/deny but
    // can't be re-rerolled (see `rerollClaim` pending-only guard).

    const now = Date.now();
    const updated: RewardClaim = {
      ...existing,
      status: decision,
      respondedAt: now,
      respondedBy: by,
      sirNote: trimmed.length > 0 ? trimmed : undefined,
      // Re-deciding clears revoke fields (defensive — `revoked` is
      // blocked above, but if a future state allows the flip clear
      // here too).
      revokedAt: undefined,
      revokeReason: undefined,
    };

    const pipeline = redis.pipeline();
    pipeline.set(claimKey(claimId), updated);
    pipeline.zrem(CLAIMS_PENDING_KEY, claimId);
    // Audit only when this is a re-decide (existing was already
    // decided OR was rerolled). First decisions on a pending claim
    // skip the audit since there's no prior state worth preserving.
    if (existing.status !== "pending") {
      // Pick the "note" capturing the prior state: delivered/denied
      // carry it on `sirNote`; rerolled carries it on `rerollReason`.
      // This way the History pill's audit list shows Sir's prior
      // reasoning even when reversing a reroll.
      const priorNote =
        existing.status === "rerolled"
          ? existing.rerollReason
          : existing.sirNote;
      const entry: ClaimAuditEntry = {
        status: existing.status,
        changedAt: now,
        changedBy: by,
        ...(priorNote && { note: priorNote }),
      };
      pipeline.lpush(claimAuditKey(claimId), JSON.stringify(entry));
      pipeline.ltrim(claimAuditKey(claimId), 0, CLAIM_AUDIT_LIMIT - 1);
    }
    await pipeline.exec();

    const isReDecide = existing.status !== "pending";
    const titleByDecision: Record<"delivered" | "denied", string> = {
      delivered: isReDecide
        ? `🎁 Reward — now delivered`
        : "🎁 Reward delivered",
      denied: isReDecide
        ? `✗ Reward — now denied`
        : "✗ Reward denied",
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
      prevStatus: existing.status,
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

// ── Revoke / acknowledge ─────────────────────────────────────────────────

export async function revokeClaim(
  claimId: string,
  reasonRaw: string,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "T7SEN") {
    return { error: "Only Sir can revoke claims." };
  }
  const reason = (reasonRaw ?? "").trim();
  if (!reason) return { error: "Reason is required." };
  if (reason.length > REVOKE_REASON_MAX) {
    return { error: `Reason too long (max ${REVOKE_REASON_MAX}).` };
  }
  try {
    const existing = await redis.get<RewardClaim>(claimKey(claimId));
    if (!existing) return { error: "Claim not found." };
    if (existing.status === "revoked") {
      return { error: "Already revoked." };
    }
    if (existing.status === "rerolled") {
      return {
        error:
          "Rerolled claims can't be revoked directly — deliver or deny first, then revoke if needed.",
      };
    }
    if (existing.status === "pending") {
      return {
        error:
          "Pending claims aren't revoked — deny them instead.",
      };
    }

    const now = Date.now();
    const prevStatus = existing.status;
    const updated: RewardClaim = {
      ...existing,
      status: "revoked",
      revokedAt: now,
      revokeReason: reason,
      respondedAt: now,
      respondedBy: session.author,
    };

    const pipeline = redis.pipeline();
    pipeline.set(claimKey(claimId), updated);
    pipeline.zrem(CLAIMS_PENDING_KEY, claimId);
    const entry: ClaimAuditEntry = {
      status: prevStatus,
      changedAt: now,
      changedBy: session.author,
      ...(existing.sirNote && { note: existing.sirNote }),
    };
    pipeline.lpush(claimAuditKey(claimId), JSON.stringify(entry));
    pipeline.ltrim(claimAuditKey(claimId), 0, CLAIM_AUDIT_LIMIT - 1);
    await pipeline.exec();

    await sendNotification(existing.author, {
      title: "✗ Reward revoked",
      body: `${existing.tierName}: ${existing.rewardLabel} — ${reason}`,
      url: "/rewards",
    });

    logger.warn("[rewards] claim revoked", {
      claimId,
      prevStatus,
      tier: existing.tierId,
      reward: existing.rewardId,
      reason,
      by: session.author,
    });
    revalidatePath("/rewards");
    return { success: true };
  } catch (err) {
    logger.error("[rewards] revoke failed", err);
    return { error: "Revoke failed." };
  }
}

// ── Reroll ───────────────────────────────────────────────────────────────
//
// Sir-only third option on a pending claim — "not this one, pick again."
// Distinct from deny (which consumes kitten's once-per-week claim slot
// and ends the cycle) and from revoke (which annuls a prior decision).
// Reroll DELs the per-week slot so kitten can immediately claim a
// different reward in the same week. The original record stays in
// history with status "rerolled" (terminal for THIS record; kitten can
// still claim in this week).
//
// Allowed only on `pending` claims. Once Sir has delivered or denied,
// he uses revoke / re-decide instead — reroll is a first-decision
// alternative, not an undo path.
//
// No obedience emit. Reroll is operational, not behavioral.

export async function rerollClaim(
  claimId: string,
  reasonRaw: string,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "T7SEN") {
    return { error: "Only Sir can reroll claims." };
  }
  const reason = (reasonRaw ?? "").trim();
  if (!reason) return { error: "Reason is required." };
  if (reason.length > SIR_NOTE_MAX) {
    return { error: `Reason too long (max ${SIR_NOTE_MAX}).` };
  }
  try {
    const existing = await redis.get<RewardClaim>(claimKey(claimId));
    if (!existing) return { error: "Claim not found." };
    if (existing.status !== "pending") {
      return {
        error:
          existing.status === "rerolled"
            ? "Already rerolled."
            : "Only pending claims can be rerolled — use revoke or re-decide instead.",
      };
    }

    const now = Date.now();
    const updated: RewardClaim = {
      ...existing,
      status: "rerolled",
      rerolledAt: now,
      rerollReason: reason,
      respondedAt: now,
      respondedBy: session.author,
    };

    const pipeline = redis.pipeline();
    pipeline.set(claimKey(claimId), updated);
    pipeline.zrem(CLAIMS_PENDING_KEY, claimId);
    // Free the per-week slot — kitten can immediately claim again in
    // the same week. The new claim becomes the slot's value.
    pipeline.del(claimByWeekKey(existing.author, existing.weekKey));
    // Audit entry capturing the prior pending state. Mirrors the
    // revoke pattern so the History pill reflects this transition.
    const entry: ClaimAuditEntry = {
      status: "pending",
      changedAt: now,
      changedBy: session.author,
    };
    pipeline.lpush(claimAuditKey(claimId), JSON.stringify(entry));
    pipeline.ltrim(claimAuditKey(claimId), 0, CLAIM_AUDIT_LIMIT - 1);
    await pipeline.exec();

    await sendNotification(existing.author, {
      title: "🔄 Pick another reward",
      body: `${existing.tierName}: ${existing.rewardLabel} — ${reason}`,
      url: "/rewards",
    });

    logger.interaction("[rewards] claim rerolled", {
      claimId,
      tier: existing.tierId,
      reward: existing.rewardId,
      weekKey: existing.weekKey,
      reason,
      by: session.author,
    });
    revalidatePath("/rewards");
    return { success: true };
  } catch (err) {
    logger.error("[rewards] reroll failed", err);
    return { error: "Reroll failed." };
  }
}

export async function acknowledgeClaim(
  claimId: string,
  noteRaw?: string,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "Besho") {
    return { error: "Only kitten can confirm receipt." };
  }
  const block = await assertWriteAllowed(session.author);
  if (block) return block;

  const note = (noteRaw ?? "").trim();
  if (note.length > ACKNOWLEDGE_NOTE_MAX) {
    return { error: `Note too long (max ${ACKNOWLEDGE_NOTE_MAX}).` };
  }
  try {
    const existing = await redis.get<RewardClaim>(claimKey(claimId));
    if (!existing) return { error: "Claim not found." };
    if (existing.author !== "Besho") {
      return { error: "Not your claim." };
    }
    if (existing.status !== "delivered") {
      return { error: "Only delivered claims can be acknowledged." };
    }
    if (existing.acknowledgedAt) {
      return { error: "Already acknowledged." };
    }

    const now = Date.now();
    const updated: RewardClaim = {
      ...existing,
      acknowledgedAt: now,
      ...(note.length > 0 && { acknowledgeNote: note }),
    };
    await redis.set(claimKey(claimId), updated);

    await sendNotification("T7SEN", {
      title: "✓ Reward received",
      body:
        note.length > 0
          ? `kitten — ${note}`
          : `kitten received: ${existing.rewardLabel}`,
      url: "/rewards",
    });

    logger.interaction("[rewards] claim acknowledged", {
      claimId,
      hasNote: note.length > 0,
    });
    revalidatePath("/rewards");
    return { success: true };
  } catch (err) {
    logger.error("[rewards] ack failed", err);
    return { error: "Ack failed." };
  }
}

export async function getClaimAudit(
  claimId: string,
): Promise<ClaimAuditEntry[]> {
  const session = await getSession();
  if (!session?.author) return [];
  try {
    const raw = await redis.lrange<unknown>(
      claimAuditKey(claimId),
      0,
      CLAIM_AUDIT_LIMIT - 1,
    );
    if (!raw) return [];
    const out: ClaimAuditEntry[] = [];
    for (const v of raw) {
      try {
        const parsed =
          typeof v === "string" ? (JSON.parse(v) as ClaimAuditEntry) : (v as ClaimAuditEntry);
        if (parsed && parsed.status) out.push(parsed);
      } catch {
        // skip malformed entries
      }
    }
    return out;
  } catch (err) {
    logger.error("[rewards] audit read failed", err);
    return [];
  }
}

// ── List + read helpers ──────────────────────────────────────────────────

/** Pipeline LLEN on each claim's audit key to surface `auditCount`
 *  inline. Mirrors the permission-list pattern. Claims with zero
 *  history skip the field. */
async function decorateAuditCount(
  claims: RewardClaim[],
): Promise<RewardClaim[]> {
  if (!claims.length) return claims;
  try {
    const pipeline = redis.pipeline();
    for (const c of claims) pipeline.llen(claimAuditKey(c.id));
    const lengths = ((await pipeline.exec()) as (number | null)[]) ?? [];
    return claims.map((c, i) => {
      const n = Number(lengths[i] ?? 0);
      return n > 0 ? { ...c, auditCount: n } : c;
    });
  } catch {
    return claims;
  }
}

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
    // Test-path claims are filtered from the history view. They still
    // exist (so deliver/deny works during the test cycle); they just
    // don't count as part of her permanent history.
    const current = currentWeekKey();
    const filtered = records.filter((r): r is RewardClaim => {
      if (!r) return false;
      if (r.testMode === true) return false;
      // Legacy fallback for claims created before `testMode` was a
      // field — anything for the current week or a future week is by
      // definition a test claim, since the normal flow only accepts
      // the immediately prior week.
      if (r.weekKey >= current) return false;
      return true;
    });
    return decorateAuditCount(filtered);
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
    return decorateAuditCount(records.filter((r): r is RewardClaim => !!r));
  } catch (err) {
    logger.error("[rewards] pending list failed", err);
    return [];
  }
}

/** Sir-only — returns the most-recent N claims across both authors,
 *  any status, including delivered/denied/revoked. Powers the Sir-side
 *  "Recent decisions" list with revoke buttons. Filters out test
 *  claims by the same rule as `listClaimsForAuthor`. */
export async function listAllClaims(
  limit: number = 20,
): Promise<RewardClaim[]> {
  const session = await getSession();
  if (session?.author !== "T7SEN") return [];
  try {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const authors: Author[] = ["T7SEN", "Besho"];
    const idLists = await Promise.all(
      authors.map((a) =>
        redis.zrange<unknown[]>(claimsByAuthorKey(a), 0, safeLimit - 1, {
          rev: true,
        }),
      ),
    );
    const ids = Array.from(
      new Set(idLists.flat().map((v) => String(v))),
    );
    if (!ids.length) return [];
    const records =
      (await redis.mget<RewardClaim[]>(...ids.map((id) => claimKey(id)))) ?? [];
    const current = currentWeekKey();
    const filtered = records.filter((r): r is RewardClaim => {
      if (!r) return false;
      if (r.testMode === true) return false;
      if (r.weekKey >= current) return false;
      return true;
    });
    filtered.sort(
      (a, b) =>
        (b.respondedAt ?? b.requestedAt) - (a.respondedAt ?? a.requestedAt),
    );
    return decorateAuditCount(filtered.slice(0, safeLimit));
  } catch (err) {
    logger.error("[rewards] listAll failed", err);
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

// ── Lifetime stats ───────────────────────────────────────────────────────

export interface LifetimeStats {
  /** Number of finalized weeks (incl. empty ones), from
   *  `obedience:weeks-tracked:Besho` counter. */
  weeksTracked: number;
  /** Best-ever single-week displayed score, with the weekKey it was
   *  achieved. Updated at finalize when surpassed. */
  bestWeek: { weekKey: string; displayedScore: number } | null;
  /** Longest consecutive high-score streak ever achieved. */
  longestStreak: number;
  /** Total non-test claims ever submitted. */
  totalClaims: number;
  /** Of those, how many Sir delivered. */
  deliveredClaims: number;
  /** Current consecutive high-score streak (streakEntering THIS week). */
  currentStreak: number;
}

export async function getLifetimeStats(): Promise<{
  stats?: LifetimeStats;
  error?: string;
}> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };

  try {
    const claims = await listClaimsForAuthor("Besho", 200);
    const totalClaims = claims.length;
    const deliveredClaims = claims.filter(
      (c) => c.status === "delivered",
    ).length;

    const [bestWeek, longestStreakRaw, weeksTrackedRaw, currentStreakRaw] =
      await Promise.all([
        (async () => {
          try {
            return await redis.get<{
              weekKey: string;
              displayedScore: number;
            }>("obedience:best-week:Besho");
          } catch {
            return null;
          }
        })(),
        redis.get<number | string>("obedience:longest-streak:Besho"),
        redis.get<number | string>("obedience:weeks-tracked:Besho"),
        redis.get<number | string>("obedience:streak:Besho"),
      ]);

    return {
      stats: {
        weeksTracked: Number(weeksTrackedRaw) || 0,
        bestWeek: bestWeek ?? null,
        longestStreak: Number(longestStreakRaw) || 0,
        totalClaims,
        deliveredClaims,
        currentStreak: Number(currentStreakRaw) || 0,
      },
    };
  } catch (err) {
    logger.error("[rewards] lifetime stats failed", err);
    return { error: "Stats failed." };
  }
}

// ── Test-claim cleanup (admin) ───────────────────────────────────────────

/**
 * Purges every test-path claim across both authors. Called from the
 * Sir-only admin tooling (UI in `/admin/rewards`). Identifies a claim
 * as a test claim if either:
 *  - `claim.testMode === true` (modern flag), or
 *  - `claim.weekKey >= currentWeekKey()` (legacy fallback for claims
 *    created before the flag existed; the normal claim flow only
 *    accepts the immediately prior week, so a current/future weekKey
 *    is necessarily a test artifact).
 *
 * Hard-delete (no soft-delete via trash) — these are diagnostic
 * artifacts, not restorable user content.
 *
 * Caller must verify Sir before invoking; this helper does no auth.
 */
export async function purgeTestClaimsRaw(): Promise<{
  removed: number;
}> {
  const current = currentWeekKey();
  const authors: Author[] = ["T7SEN", "Besho"];
  let removed = 0;

  for (const author of authors) {
    const ids = ((await redis.zrange<unknown[]>(
      claimsByAuthorKey(author),
      0,
      -1,
    )) ?? []).map(String);
    if (!ids.length) continue;
    const records =
      (await redis.mget<RewardClaim[]>(...ids.map((id) => claimKey(id)))) ??
      [];

    const toDelete: { claim: RewardClaim; id: string }[] = [];
    for (let i = 0; i < ids.length; i++) {
      const r = records[i];
      if (!r) continue;
      const isTest = r.testMode === true || r.weekKey >= current;
      if (isTest) toDelete.push({ claim: r, id: ids[i] });
    }
    if (!toDelete.length) continue;

    const pipeline = redis.pipeline();
    for (const { claim, id } of toDelete) {
      pipeline.del(claimKey(id));
      pipeline.del(claimAuditKey(id));
      pipeline.zrem(claimsByAuthorKey(author), id);
      pipeline.zrem(CLAIMS_PENDING_KEY, id);
      pipeline.del(claimByWeekKey(author, claim.weekKey));
    }
    await pipeline.exec();
    removed += toDelete.length;
  }

  return { removed };
}

// ── Bulk Sir-only ops ────────────────────────────────────────────────────

export async function bulkDeliverPending(
  noteRaw?: string,
): Promise<{
  success?: boolean;
  error?: string;
  delivered?: number;
}> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "T7SEN") {
    return { error: "Only Sir can bulk-deliver." };
  }
  const note = (noteRaw ?? "").trim();
  if (note.length > SIR_NOTE_MAX) {
    return { error: `Note too long (max ${SIR_NOTE_MAX}).` };
  }
  try {
    const ids =
      ((await redis.zrange<unknown[]>(CLAIMS_PENDING_KEY, 0, -1)) ?? []).map(
        String,
      );
    if (!ids.length) return { success: true, delivered: 0 };
    const records =
      (await redis.mget<RewardClaim[]>(...ids.map((id) => claimKey(id)))) ?? [];
    const now = Date.now();
    let delivered = 0;
    const pipeline = redis.pipeline();
    const recipients = new Set<Author>();
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      if (!r || r.status !== "pending") continue;
      const updated: RewardClaim = {
        ...r,
        status: "delivered",
        respondedAt: now,
        respondedBy: session.author,
        sirNote: note.length > 0 ? note : undefined,
      };
      pipeline.set(claimKey(r.id), updated);
      pipeline.zrem(CLAIMS_PENDING_KEY, r.id);
      recipients.add(r.author);
      delivered++;
    }
    if (delivered === 0) return { success: true, delivered: 0 };
    await pipeline.exec();

    // Single summary FCM per recipient — bulk action, not per-claim.
    await Promise.all(
      Array.from(recipients).map((a) =>
        sendNotification(a, {
          title: "🎁 Rewards delivered (bulk)",
          body: `Sir delivered ${delivered} pending ${delivered === 1 ? "reward" : "rewards"}.`,
          url: "/rewards",
        }),
      ),
    );

    logger.warn("[rewards] bulk delivered", {
      by: session.author,
      delivered,
    });
    revalidatePath("/rewards");
    revalidatePath("/admin/rewards");
    return { success: true, delivered };
  } catch (err) {
    logger.error("[rewards] bulk deliver failed", err);
    return { error: "Bulk deliver failed." };
  }
}

export async function bulkDenyOlderThan(
  days: number,
  reasonRaw?: string,
): Promise<{
  success?: boolean;
  error?: string;
  denied?: number;
}> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "T7SEN") {
    return { error: "Only Sir can bulk-deny." };
  }
  if (
    !Number.isFinite(days) ||
    days < 1 ||
    days > BULK_DENY_MAX_DAYS
  ) {
    return { error: `Days must be 1-${BULK_DENY_MAX_DAYS}.` };
  }
  const reason = (reasonRaw ?? "").trim();
  if (reason.length > SIR_NOTE_MAX) {
    return { error: `Reason too long (max ${SIR_NOTE_MAX}).` };
  }
  try {
    const cutoff = Date.now() - Math.floor(days) * 86_400_000;
    const ids =
      ((await redis.zrange<unknown[]>(CLAIMS_PENDING_KEY, 0, -1)) ?? []).map(
        String,
      );
    if (!ids.length) return { success: true, denied: 0 };
    const records =
      (await redis.mget<RewardClaim[]>(...ids.map((id) => claimKey(id)))) ?? [];
    const now = Date.now();
    let denied = 0;
    const pipeline = redis.pipeline();
    const recipients = new Set<Author>();
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      if (!r || r.status !== "pending") continue;
      if (r.requestedAt > cutoff) continue;
      const updated: RewardClaim = {
        ...r,
        status: "denied",
        respondedAt: now,
        respondedBy: session.author,
        sirNote: reason.length > 0 ? reason : undefined,
      };
      pipeline.set(claimKey(r.id), updated);
      pipeline.zrem(CLAIMS_PENDING_KEY, r.id);
      recipients.add(r.author);
      denied++;
    }
    if (denied === 0) return { success: true, denied: 0 };
    await pipeline.exec();

    await Promise.all(
      Array.from(recipients).map((a) =>
        sendNotification(a, {
          title: "✗ Stale claims denied (bulk)",
          body: `Sir denied ${denied} ${denied === 1 ? "claim" : "claims"} older than ${days} ${days === 1 ? "day" : "days"}.`,
          url: "/rewards",
        }),
      ),
    );

    logger.warn("[rewards] bulk denied", {
      by: session.author,
      denied,
      days,
    });
    revalidatePath("/rewards");
    revalidatePath("/admin/rewards");
    return { success: true, denied };
  } catch (err) {
    logger.error("[rewards] bulk deny failed", err);
    return { error: "Bulk deny failed." };
  }
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

    // Parallelize the per-week fetches across the entire window. Each
    // iteration was previously `await Promise.all([state, claim])`
    // sequentially behind the loop, so a 12-week history was 12 RTTs
    // (× 2-3 sub-calls per week of state-fetching internals). Lifting
    // the Promise.all to the outer level collapses that to a single
    // wave on Upstash's REST tier.
    const weekKeys = Array.from({ length: safeLimit }, (_, idx) =>
      shiftWeekKey(current, -(idx + 1)),
    );
    const fetched = await Promise.all(
      weekKeys.map(async (weekKey) => {
        const [state, rawClaim] = await Promise.all([
          getWeekState("Besho", weekKey),
          readClaimForWeek("Besho", weekKey),
        ]);
        return { weekKey, state, rawClaim };
      }),
    );

    const out: RewardsHistoryEntry[] = [];
    for (let i = 0; i < fetched.length; i++) {
      const { weekKey, state, rawClaim } = fetched[i];
      // Test claims are excluded from the history view. See
      // `listClaimsForAuthor` for the same filter rationale.
      const claim =
        rawClaim && rawClaim.testMode === true ? null : rawClaim;
      const isEmpty =
        state.breakdown.length === 0 && state.displayedScore === 0 && !claim;
      const isFirstPrior = i === 0;
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
