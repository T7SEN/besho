"use server";

// src/app/actions/games/truth-or-dare.ts
//
// Server actions for the Truth or Dare game. Symmetric — both authors
// can issue and respond. Obedience-scored on the Kitten direction only
// (Sir has no obedience score). Single-slot per ISSUER: each author can
// have at most one outgoing challenge in flight; either author can have
// at most one incoming challenge in flight (the partner's outgoing).
//
// State machine (see truth-or-dare-constants.ts for full union):
//   pending  ──pick──▶  picked  ──submit──▶  completed
//           ↘ refuse                  ↘ refuse / safeword
//           ↘ safeword                ↘ TTL expired (cron)
//           ↘ TTL expired (cron)
//   any active → withdrawn (issuer-initiated cancel)
//   any active → cancelled (Sir admin force-cancel — no penalty)
//
// Restraint interaction: Kitten cannot ISSUE or WITHDRAW her own
// challenges while restrained (initiating writes). She CAN pick,
// respond, refuse, or safeword on a challenge Sir already issued
// (responsive — otherwise the game stalls until restraint lifts). Sir
// is never restrained.

import { redis } from "@/lib/redis";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { decrypt } from "@/lib/auth-utils";
import { sendNotification } from "@/app/actions/notifications";
import { logger } from "@/lib/logger";
import { moveToTrash } from "@/lib/trash";
import { recordObedienceEvent } from "@/lib/obedience";
import { assertWriteAllowed } from "@/lib/restraint";
import { partnerOf, TITLE_BY_AUTHOR, type Author } from "@/lib/constants";
import {
  ACTIVE_STATUSES,
  DEFAULT_TOD_STATS,
  MAX_PROMPT_LEN,
  MAX_REFUSE_REASON_LEN,
  MAX_RESPONSE_LEN,
  TERMINAL_STATUSES,
  TOD_HISTORY_MAX_LIMIT,
  TOD_HISTORY_PAGE_SIZE,
  TOD_INDEX_KEY,
  TOD_PAYLOAD_KIND,
  TOD_PENDING_TTL_SEC,
  TOD_PICKED_TTL_SEC,
  todActiveKey,
  todChallengeKey,
  todStatsKey,
  type ChallengeType,
  type TodChallenge,
  type TodStats,
} from "@/lib/games/truth-or-dare-constants";

// ── Session helper ───────────────────────────────────────────────────────

async function getSession() {
  const cookieStore = await cookies();
  const value = cookieStore.get("session")?.value;
  if (!value) return null;
  return decrypt(value);
}

// ── Read helpers ─────────────────────────────────────────────────────────

async function readActiveByIssuer(
  issuer: Author,
): Promise<TodChallenge | null> {
  try {
    const id = await redis.get<string>(todActiveKey(issuer));
    if (!id) return null;
    const record = await redis.get<TodChallenge>(todChallengeKey(id));
    if (!record) return null;
    // Sentinel can outlive a state transition during a half-failed
    // pipeline. Treat any non-active state as no active challenge.
    if (!ACTIVE_STATUSES.includes(record.status)) return null;
    return record;
  } catch (err) {
    logger.error("[tod] readActiveByIssuer failed", err, { issuer });
    return null;
  }
}

/** Both authors see both authors' active challenges from their own POV:
 *  `incoming` = the partner's outgoing (waiting on me to engage),
 *  `outgoing` = my own outgoing (waiting on the partner). */
export async function getActiveChallenges(): Promise<{
  incoming: TodChallenge | null;
  outgoing: TodChallenge | null;
  error?: string;
}> {
  const session = await getSession();
  if (!session?.author) {
    return { incoming: null, outgoing: null, error: "Not authenticated." };
  }
  const me = session.author;
  const partner = partnerOf(me);
  try {
    const [outgoing, incoming] = await Promise.all([
      readActiveByIssuer(me),
      readActiveByIssuer(partner),
    ]);
    return { incoming, outgoing };
  } catch (err) {
    logger.error("[tod] getActiveChallenges failed", err);
    return {
      incoming: null,
      outgoing: null,
      error: "Failed to read active challenges.",
    };
  }
}

/** One page of challenge history returned by `getChallengeHistory`.
 *  `total` is the full ZCARD of the index so the caller can render a
 *  "showing N of M" affordance and load-more button without a separate
 *  count call. */
export interface TodHistoryPage {
  records: TodChallenge[];
  total: number;
  /** Echo of the limit + offset applied, so the client can paginate. */
  limit: number;
  offset: number;
  error?: string;
}

/**
 * Read a page of challenge history newest-first. Tolerates over-large
 * `limit` values by clamping to `TOD_HISTORY_MAX_LIMIT`; tolerates a
 * partially-populated index (records that are null after a half-failed
 * write get filtered out). Both authors see every challenge in history
 * regardless of direction.
 */
export async function getChallengeHistory(
  limit = TOD_HISTORY_PAGE_SIZE,
  offset = 0,
): Promise<TodHistoryPage> {
  const safeLimit = Math.max(
    1,
    Math.min(TOD_HISTORY_MAX_LIMIT, Math.floor(Number(limit) || 0)),
  );
  const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
  try {
    const [idsRaw, total] = await Promise.all([
      redis.zrange<string[]>(
        TOD_INDEX_KEY,
        safeOffset,
        safeOffset + safeLimit - 1,
        { rev: true },
      ),
      redis.zcard(TOD_INDEX_KEY),
    ]);
    const ids = (idsRaw ?? []).map(String);
    if (ids.length === 0) {
      return {
        records: [],
        total: Number(total) || 0,
        limit: safeLimit,
        offset: safeOffset,
      };
    }
    const recs = await redis.mget<(TodChallenge | null)[]>(
      ...ids.map(todChallengeKey),
    );
    const records = (recs ?? []).filter(
      (r): r is TodChallenge => r !== null,
    );
    return {
      records,
      total: Number(total) || 0,
      limit: safeLimit,
      offset: safeOffset,
    };
  } catch (err) {
    logger.error("[tod] getChallengeHistory failed", err);
    return {
      records: [],
      total: 0,
      limit: safeLimit,
      offset: safeOffset,
      error: "Failed to load history.",
    };
  }
}

async function readStats(author: Author): Promise<TodStats> {
  try {
    const raw = await redis.hgetall<Record<string, string | number>>(
      todStatsKey(author),
    );
    const result: TodStats = { ...DEFAULT_TOD_STATS };
    if (raw && typeof raw === "object") {
      for (const key of Object.keys(result) as (keyof TodStats)[]) {
        const v = raw[key as string];
        const n = Number(v);
        if (Number.isFinite(n) && n >= 0) result[key] = n;
      }
    }
    return result;
  } catch {
    return { ...DEFAULT_TOD_STATS };
  }
}

/** Stats for both authors, returned together so the game page can
 *  render the both-author footer in a single fetch. */
export interface TodStatsBundle {
  T7SEN: TodStats;
  Besho: TodStats;
  error?: string;
}

/** Read both authors' stats hashes in parallel. Always returns a
 *  fully-populated bundle — missing HASH fields fall back to
 *  `DEFAULT_TOD_STATS` zeros. */
export async function getStatsBundle(): Promise<TodStatsBundle> {
  try {
    const [a, b] = await Promise.all([readStats("T7SEN"), readStats("Besho")]);
    return { T7SEN: a, Besho: b };
  } catch (err) {
    logger.error("[tod] getStatsBundle failed", err);
    return {
      T7SEN: { ...DEFAULT_TOD_STATS },
      Besho: { ...DEFAULT_TOD_STATS },
      error: "Failed to load stats.",
    };
  }
}

// ── Issue (either author) ────────────────────────────────────────────────

/**
 * `useActionState`-compatible. Writes one truth prompt + one dare prompt
 * in a single submission — the recipient picks which to engage with.
 * Refuses when the caller's outgoing slot is already occupied (single-
 * slot per issuer). Restraint-gated for Kitten (initiating write); Sir
 * is never restrained. Fires presence-aware FCM to the recipient with
 * `data.kind === TOD_PAYLOAD_KIND`.
 */
export async function issueChallenge(
  _prevState: unknown,
  formData: FormData,
): Promise<{ success?: boolean; error?: string; id?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };

  // Kitten initiating a challenge is a write — blocked under restraint.
  // Sir is never restrained, but the helper short-circuits for him.
  const block = await assertWriteAllowed(session.author);
  if (block) return block;

  const truthPrompt = String(formData.get("truthPrompt") ?? "").trim();
  const darePrompt = String(formData.get("darePrompt") ?? "").trim();

  if (!truthPrompt) return { error: "Truth prompt is required." };
  if (!darePrompt) return { error: "Dare prompt is required." };
  if (truthPrompt.length > MAX_PROMPT_LEN) {
    return { error: `Truth prompt is capped at ${MAX_PROMPT_LEN} chars.` };
  }
  if (darePrompt.length > MAX_PROMPT_LEN) {
    return { error: `Dare prompt is capped at ${MAX_PROMPT_LEN} chars.` };
  }

  const issuer = session.author;
  const recipient = partnerOf(issuer);

  // Single-slot guard on the issuer's outgoing direction. Refuse if
  // there's already an outgoing challenge — issuer withdraws first.
  try {
    const existing = await redis.get<string>(todActiveKey(issuer));
    if (existing) {
      return {
        error:
          "You already have a challenge in flight. Withdraw it first.",
      };
    }
  } catch (err) {
    logger.warn("[tod] active-sentinel read failed (issue)", { err });
    // Fall through — a transient Redis hiccup shouldn't block.
  }

  const createdAt = Date.now();
  const expiresAt = createdAt + TOD_PENDING_TTL_SEC * 1000;
  const record: TodChallenge = {
    id: crypto.randomUUID(),
    issuer,
    recipient,
    truthPrompt,
    darePrompt,
    pick: null,
    status: "pending",
    response: null,
    createdAt,
    pickedAt: null,
    respondedAt: null,
    closedAt: null,
    expiresAt,
  };

  try {
    const pipeline = redis.pipeline();
    pipeline.set(todChallengeKey(record.id), record);
    pipeline.zadd(TOD_INDEX_KEY, { score: createdAt, member: record.id });
    pipeline.set(todActiveKey(issuer), record.id, {
      ex: TOD_PENDING_TTL_SEC,
    });
    pipeline.hincrby(todStatsKey(issuer), "issued", 1);
    await pipeline.exec();

    // Presence-aware FCM. The standard route handles the foreground vs
    // background payload shape; we just pipe the standard fields.
    await sendNotification(
      recipient,
      {
        title: "🎲 New challenge",
        body: `${TITLE_BY_AUTHOR[issuer]} issued a Truth or Dare.`,
        url: "/games/truth-or-dare",
      },
      {
        extraData: {
          kind: TOD_PAYLOAD_KIND,
          challengeId: record.id,
        },
      },
    );

    logger.interaction("[tod] challenge issued", {
      id: record.id,
      issuer,
      recipient,
    });
    revalidatePath("/games/truth-or-dare");
    revalidatePath("/admin/games/truth-or-dare");
    return { success: true, id: record.id };
  } catch (err) {
    logger.error("[tod] issueChallenge failed", err);
    return { error: "Failed to issue challenge." };
  }
}

// ── Pick (recipient-only) ────────────────────────────────────────────────

/**
 * Recipient commits to either the truth or the dare on a pending
 * challenge. Status flips `pending → picked`; expiry resets to a
 * tighter `TOD_PICKED_TTL_SEC` window (48h). Idempotent — re-picking
 * the same type returns success silently. Intentionally NOT restraint-
 * gated: see file header (responsive vs initiating writes).
 */
export async function pickPrompt(
  id: string,
  pick: ChallengeType,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (pick !== "truth" && pick !== "dare") return { error: "Invalid pick." };

  try {
    const record = await redis.get<TodChallenge>(todChallengeKey(id));
    if (!record) return { error: "Challenge not found." };
    if (record.recipient !== session.author) {
      return { error: "Only the recipient can pick." };
    }
    // Picking is responsive — intentionally NOT gated on restraint.
    // The architectural call: restraint locks INITIATING writes only;
    // responding to a challenge already in flight stays open so the
    // game doesn't stall indefinitely. See file header.
    if (record.status === "picked" && record.pick === pick) {
      return { success: true };
    }
    if (record.status !== "pending") {
      return { error: "Challenge is no longer pending a pick." };
    }
    if (record.expiresAt < Date.now()) {
      return { error: "Challenge has expired." };
    }

    const pickedAt = Date.now();
    const newExpiresAt = pickedAt + TOD_PICKED_TTL_SEC * 1000;
    const updated: TodChallenge = {
      ...record,
      pick,
      status: "picked",
      pickedAt,
      expiresAt: newExpiresAt,
    };
    const pipeline = redis.pipeline();
    pipeline.set(todChallengeKey(id), updated);
    // Refresh the active sentinel TTL to the new (tighter) window.
    pipeline.set(todActiveKey(record.issuer), id, {
      ex: TOD_PICKED_TTL_SEC,
    });
    await pipeline.exec();

    await sendNotification(record.issuer, {
      title: pick === "truth" ? "🪞 Truth picked" : "🎯 Dare picked",
      body: `${TITLE_BY_AUTHOR[record.recipient]} picked ${pick}.`,
      url: "/games/truth-or-dare",
    });

    logger.interaction("[tod] prompt picked", {
      id,
      pick,
      recipient: record.recipient,
    });
    revalidatePath("/games/truth-or-dare");
    revalidatePath("/admin/games/truth-or-dare");
    return { success: true };
  } catch (err) {
    logger.error("[tod] pickPrompt failed", err);
    return { error: "Failed to pick." };
  }
}

// ── Submit response (recipient-only) ─────────────────────────────────────

/**
 * Submit the truth answer or dare-completion note. Requires status
 * `picked` and a non-empty response ≤ `MAX_RESPONSE_LEN`. On success:
 * flips status to `completed`, increments the recipient's stat counter
 * (`truthsAnswered` or `daresCompleted`), frees the active sentinel,
 * emits an obedience event for Kitten (`tod_truth_answered` +3 OR
 * `tod_dare_completed` +6 default), and FCMs the issuer. No optimistic
 * UI — the response field is load-bearing and rollback would leave it
 * visually present but server-absent.
 */
export async function submitResponse(
  id: string,
  formData: FormData,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };

  const response = String(formData.get("response") ?? "").trim();
  if (!response) return { error: "Response is required." };
  if (response.length > MAX_RESPONSE_LEN) {
    return { error: `Response is capped at ${MAX_RESPONSE_LEN} chars.` };
  }

  try {
    const record = await redis.get<TodChallenge>(todChallengeKey(id));
    if (!record) return { error: "Challenge not found." };
    if (record.recipient !== session.author) {
      return { error: "Only the recipient can respond." };
    }
    if (record.status === "completed") return { success: true };
    if (record.status !== "picked") {
      return { error: "Pick a prompt first." };
    }
    if (record.expiresAt < Date.now()) {
      return { error: "Challenge has expired." };
    }
    if (record.pick !== "truth" && record.pick !== "dare") {
      return { error: "Pick was lost — pick again." };
    }

    const respondedAt = Date.now();
    const updated: TodChallenge = {
      ...record,
      status: "completed",
      response,
      respondedAt,
      closedAt: respondedAt,
    };

    const statCounterKey: keyof TodStats =
      record.pick === "truth" ? "truthsAnswered" : "daresCompleted";

    const pipeline = redis.pipeline();
    pipeline.set(todChallengeKey(id), updated);
    pipeline.del(todActiveKey(record.issuer));
    pipeline.hincrby(todStatsKey(record.recipient), statCounterKey, 1);
    await pipeline.exec();

    // Obedience emit — Kitten direction only. Sir's responses are
    // tracked in stats but don't move any score (he has none).
    if (record.recipient === "Besho") {
      const eventType =
        record.pick === "truth" ? "tod_truth_answered" : "tod_dare_completed";
      void recordObedienceEvent("Besho", eventType, id, respondedAt);
    }

    await sendNotification(record.issuer, {
      title: "✓ Challenge answered",
      body: `${TITLE_BY_AUTHOR[record.recipient]} answered your ${record.pick}.`,
      url: "/games/truth-or-dare",
    });

    logger.interaction("[tod] response submitted", {
      id,
      pick: record.pick,
      recipient: record.recipient,
    });
    revalidatePath("/games/truth-or-dare");
    revalidatePath("/admin/games/truth-or-dare");
    return { success: true };
  } catch (err) {
    logger.error("[tod] submitResponse failed", err);
    return { error: "Failed to submit response." };
  }
}

// ── Refuse (recipient-only) — counts as compliance miss for Besho ────────

/**
 * Recipient declines a challenge. Status → `refused`; increments
 * `tod:stats:{recipient}.refused`; emits `tod_refused` (−6 default) for
 * Kitten recipients only. Distinct from `safewordChallenge`, which
 * fires no obedience event — refuse is a compliance signal, safeword
 * is a hard-no on a specific prompt. Optional `reason` ≤
 * `MAX_REFUSE_REASON_LEN` (200 chars) lands on the record.
 */
export async function refuseChallenge(
  id: string,
  reason?: string,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };

  const cleanReason = (reason ?? "").trim();
  if (cleanReason.length > MAX_REFUSE_REASON_LEN) {
    return { error: `Reason too long (max ${MAX_REFUSE_REASON_LEN}).` };
  }

  try {
    const record = await redis.get<TodChallenge>(todChallengeKey(id));
    if (!record) return { error: "Challenge not found." };
    if (record.recipient !== session.author) {
      return { error: "Only the recipient can refuse." };
    }
    if (record.status === "refused") return { success: true };
    if (!ACTIVE_STATUSES.includes(record.status)) {
      return { error: "Challenge is no longer active." };
    }

    const closedAt = Date.now();
    const updated: TodChallenge = {
      ...record,
      status: "refused",
      closedAt,
      ...(cleanReason.length > 0 && { refuseReason: cleanReason }),
    };

    const pipeline = redis.pipeline();
    pipeline.set(todChallengeKey(id), updated);
    pipeline.del(todActiveKey(record.issuer));
    pipeline.hincrby(todStatsKey(record.recipient), "refused", 1);
    await pipeline.exec();

    if (record.recipient === "Besho") {
      void recordObedienceEvent("Besho", "tod_refused", id, closedAt);
    }

    await sendNotification(record.issuer, {
      title: "✗ Challenge refused",
      body: `${TITLE_BY_AUTHOR[record.recipient]} refused.`,
      url: "/games/truth-or-dare",
    });

    logger.interaction("[tod] challenge refused", {
      id,
      recipient: record.recipient,
      hasReason: cleanReason.length > 0,
    });
    revalidatePath("/games/truth-or-dare");
    revalidatePath("/admin/games/truth-or-dare");
    return { success: true };
  } catch (err) {
    logger.error("[tod] refuseChallenge failed", err);
    return { error: "Failed to refuse." };
  }
}

// ── Safeword on this dare (recipient-only) — no obedience penalty ────────

/**
 * Recipient hard-nos this specific prompt. Status → `safeworded`;
 * increments `tod:stats:{recipient}.safeworded`; fires NO obedience
 * event. Intended as a free out — refusal cost would conflate "this
 * prompt is unsafe" with "I'm being non-compliant." Distinct from the
 * global `/safeword` route (panic channel with bypass-presence FCM);
 * TOD safeword is local to this challenge.
 */
export async function safewordChallenge(
  id: string,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };

  try {
    const record = await redis.get<TodChallenge>(todChallengeKey(id));
    if (!record) return { error: "Challenge not found." };
    if (record.recipient !== session.author) {
      return { error: "Only the recipient can safeword." };
    }
    if (record.status === "safeworded") return { success: true };
    if (!ACTIVE_STATUSES.includes(record.status)) {
      return { error: "Challenge is no longer active." };
    }

    const closedAt = Date.now();
    const updated: TodChallenge = {
      ...record,
      status: "safeworded",
      closedAt,
    };

    const pipeline = redis.pipeline();
    pipeline.set(todChallengeKey(id), updated);
    pipeline.del(todActiveKey(record.issuer));
    pipeline.hincrby(todStatsKey(record.recipient), "safeworded", 1);
    await pipeline.exec();

    // No obedience emit — safeword on a specific dare is intentionally
    // free. It's a hard-no signal, not a compliance miss.

    await sendNotification(record.issuer, {
      title: "🛡️ Safeworded",
      body: `${TITLE_BY_AUTHOR[record.recipient]} safeworded this one.`,
      url: "/games/truth-or-dare",
    });

    logger.warn("[tod] challenge safeworded", {
      id,
      recipient: record.recipient,
    });
    revalidatePath("/games/truth-or-dare");
    revalidatePath("/admin/games/truth-or-dare");
    return { success: true };
  } catch (err) {
    logger.error("[tod] safewordChallenge failed", err);
    return { error: "Failed to safeword." };
  }
}

// ── Withdraw (issuer-only) — no obedience effect either direction ────────

/**
 * Issuer cancels their own outgoing challenge. Status → `withdrawn`;
 * increments `tod:stats:{issuer}.withdrawn`; fires NO obedience event.
 * Distinct from `forceCancelTodChallenge` (admin override on either
 * direction). Restraint-gated for Kitten — withdrawing her own slot is
 * still an initiating write on her own state.
 */
export async function withdrawChallenge(
  id: string,
  reason?: string,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };

  // Withdrawing is initiating-style on the issuer's own slot → restraint
  // blocks it for Kitten. Sir is never restrained.
  const block = await assertWriteAllowed(session.author);
  if (block) return block;

  const cleanReason = (reason ?? "").trim();
  if (cleanReason.length > MAX_REFUSE_REASON_LEN) {
    return { error: `Reason too long (max ${MAX_REFUSE_REASON_LEN}).` };
  }

  try {
    const record = await redis.get<TodChallenge>(todChallengeKey(id));
    if (!record) return { error: "Challenge not found." };
    if (record.issuer !== session.author) {
      return { error: "Only the issuer can withdraw." };
    }
    if (record.status === "withdrawn") return { success: true };
    if (!ACTIVE_STATUSES.includes(record.status)) {
      return { error: "Challenge is no longer active." };
    }

    const closedAt = Date.now();
    const updated: TodChallenge = {
      ...record,
      status: "withdrawn",
      closedAt,
      ...(cleanReason.length > 0 && { withdrawReason: cleanReason }),
    };

    const pipeline = redis.pipeline();
    pipeline.set(todChallengeKey(id), updated);
    pipeline.del(todActiveKey(record.issuer));
    pipeline.hincrby(todStatsKey(record.issuer), "withdrawn", 1);
    await pipeline.exec();

    // No obedience emit. Withdraw is allowed without penalty in either
    // direction (per locked-in default — "yes" to back-out support).

    await sendNotification(record.recipient, {
      title: "↩ Challenge withdrawn",
      body: `${TITLE_BY_AUTHOR[record.issuer]} took it back.`,
      url: "/games/truth-or-dare",
    });

    logger.interaction("[tod] challenge withdrawn", {
      id,
      issuer: record.issuer,
    });
    revalidatePath("/games/truth-or-dare");
    revalidatePath("/admin/games/truth-or-dare");
    return { success: true };
  } catch (err) {
    logger.error("[tod] withdrawChallenge failed", err);
    return { error: "Failed to withdraw." };
  }
}

// ── Cron-driven expiration ───────────────────────────────────────────────

/** Sweep the most-recent N challenges and expire any active record
 *  past its `expiresAt`. Called once per cron tick from
 *  `/api/cron/timer-expire`. No session in the cron context — auth
 *  happens at the route layer via the bearer token. */
export async function expireDueChallenges(
  scanLimit = 200,
): Promise<{ scanned: number; expired: number }> {
  let scanned = 0;
  let expired = 0;
  try {
    const idsRaw = (await redis.zrange(
      TOD_INDEX_KEY,
      0,
      Math.max(0, scanLimit - 1),
      { rev: true },
    )) as string[];
    if (!idsRaw || idsRaw.length === 0) return { scanned, expired };
    const records = await redis.mget<(TodChallenge | null)[]>(
      ...idsRaw.map(todChallengeKey),
    );
    const now = Date.now();
    for (const record of records ?? []) {
      if (!record) continue;
      scanned++;
      if (!ACTIVE_STATUSES.includes(record.status)) continue;
      if (record.expiresAt > now) continue;

      const closedAt = now;
      const updated: TodChallenge = {
        ...record,
        status: "expired",
        closedAt,
      };

      try {
        const pipeline = redis.pipeline();
        pipeline.set(todChallengeKey(record.id), updated);
        pipeline.del(todActiveKey(record.issuer));
        pipeline.hincrby(todStatsKey(record.recipient), "expired", 1);
        await pipeline.exec();

        if (record.recipient === "Besho") {
          void recordObedienceEvent(
            "Besho",
            "tod_expired",
            record.id,
            closedAt,
          );
        }

        // Notify BOTH authors — they both lost something.
        try {
          await Promise.all([
            sendNotification(record.issuer, {
              title: "⌛ Challenge expired",
              body: `${TITLE_BY_AUTHOR[record.recipient]} let your challenge lapse.`,
              url: "/games/truth-or-dare",
            }),
            sendNotification(record.recipient, {
              title: "⌛ Challenge expired",
              body: `${TITLE_BY_AUTHOR[record.issuer]}'s challenge to you lapsed.`,
              url: "/games/truth-or-dare",
            }),
          ]);
        } catch {
          // best-effort — cron sweeps every minute, FCM can fail
        }

        logger.warn("[tod] challenge expired", {
          id: record.id,
          issuer: record.issuer,
          recipient: record.recipient,
          fromStatus: record.status,
        });
        expired++;
      } catch (err) {
        logger.error("[tod] expire per-record failed", err, {
          id: record.id,
        });
      }
    }
  } catch (err) {
    logger.error("[tod] expireDueChallenges sweep failed", err);
  }
  return { scanned, expired };
}

// ── Soft-delete (Sir-only, terminal only) ────────────────────────────────

/**
 * Soft-delete a terminal-state challenge via `moveToTrash`
 * (`feature: "tod_challenges"`). Sir-only; refuses while the record is
 * still in `pending` or `picked` — cancel first. Restores via the
 * standard `/admin/trash` UI; the auxiliary stat counters are NOT
 * rolled back on restore (matches the reactions/occurrences pattern).
 */
export async function deleteChallenge(
  id: string,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "T7SEN") {
    return { error: "Only Sir can delete challenges." };
  }

  try {
    const record = await redis.get<TodChallenge>(todChallengeKey(id));
    if (!record) return { error: "Challenge not found." };
    if (!TERMINAL_STATUSES.includes(record.status)) {
      return { error: "Cancel the challenge before deleting it." };
    }

    const score = await redis.zscore(TOD_INDEX_KEY, id);
    const label =
      record.pick === "truth"
        ? `🎲 truth: ${record.truthPrompt.slice(0, 40)}`
        : record.pick === "dare"
          ? `🎲 dare: ${record.darePrompt.slice(0, 40)}`
          : `🎲 ${record.truthPrompt.slice(0, 40)}`;

    await moveToTrash(redis, {
      feature: "tod_challenges",
      id,
      label,
      deletedBy: session.author,
      payload: record,
      indexScore:
        typeof score === "number"
          ? score
          : Number(score) || record.createdAt,
      recordKey: todChallengeKey(id),
      indexKey: TOD_INDEX_KEY,
    });

    const pipeline = redis.pipeline();
    pipeline.del(todChallengeKey(id));
    pipeline.zrem(TOD_INDEX_KEY, id);
    await pipeline.exec();

    logger.interaction("[tod] challenge deleted", { id });
    revalidatePath("/games/truth-or-dare");
    revalidatePath("/admin/games/truth-or-dare");
    return { success: true };
  } catch (err) {
    logger.error("[tod] deleteChallenge failed", err);
    return { error: "Failed to delete challenge." };
  }
}

// ── Bundle reader (one-shot for the game page) ───────────────────────────

/** Combined fetch result for the game page. Both directions of active
 *  play, the first page of history, both authors' stats, and the
 *  caller's identity in one round-trip-equivalent. */
export interface TodBundle {
  incoming: TodChallenge | null;
  outgoing: TodChallenge | null;
  history: TodChallenge[];
  historyTotal: number;
  stats: TodStatsBundle;
  /** Who the caller is — drives header + role-gated UI. */
  me: Author | null;
  error?: string;
}

/**
 * One-shot reader for the user-facing game page. Runs all four reads
 * in parallel (own outgoing, partner's outgoing, first history page,
 * stats). Returns `me: null` + an empty bundle when the caller isn't
 * authenticated so the page can render a fallback state.
 */
export async function getTodBundle(): Promise<TodBundle> {
  const session = await getSession();
  if (!session?.author) {
    return {
      incoming: null,
      outgoing: null,
      history: [],
      historyTotal: 0,
      stats: {
        T7SEN: { ...DEFAULT_TOD_STATS },
        Besho: { ...DEFAULT_TOD_STATS },
      },
      me: null,
      error: "Not authenticated.",
    };
  }
  const me = session.author;
  const partner = partnerOf(me);
  try {
    const [outgoing, incoming, history, stats] = await Promise.all([
      readActiveByIssuer(me),
      readActiveByIssuer(partner),
      getChallengeHistory(TOD_HISTORY_PAGE_SIZE, 0),
      getStatsBundle(),
    ]);
    return {
      incoming,
      outgoing,
      history: history.records,
      historyTotal: history.total,
      stats,
      me,
    };
  } catch (err) {
    logger.error("[tod] getTodBundle failed", err);
    return {
      incoming: null,
      outgoing: null,
      history: [],
      historyTotal: 0,
      stats: {
        T7SEN: { ...DEFAULT_TOD_STATS },
        Besho: { ...DEFAULT_TOD_STATS },
      },
      me,
      error: "Failed to load bundle.",
    };
  }
}

// All non-async exports — types, constants, key helpers — live in
// `@/lib/games/truth-or-dare-constants`. 'use server' files only export
// async functions (see AGENTS.md § 4). Importers of types should reach
// for the constants file directly.
