"use server";

// src/app/actions/admin/games.ts
//
// Sir-only admin tooling for the /games subtree. Currently surfaces the
// Truth or Dare game; future games hook in their own admin bundles
// here. Tunables (weights) are already covered by the rewards admin
// surface — the TOD obedience event types register into the standard
// `obedience:weights` hash and surface in `/admin/rewards` Weights tab
// automatically.
//
// This module owns:
//   - bundled reader for the /admin/games/truth-or-dare page
//   - force-cancel (no penalty, distinct from withdraw)
//   - mass cancel of all active TOD challenges
//   - stat reset / per-stat edit
//   - purge-all (Sir-only mass soft-delete)
//   - active-count accessor for the /admin landing dashboard strip

import { revalidatePath } from "next/cache";
import { logger } from "@/lib/logger";
import { moveManyToTrash } from "@/lib/trash";
import type { Author } from "@/lib/constants";
import {
  ACTIVE_STATUSES,
  DEFAULT_TOD_STATS,
  MAX_CANCEL_REASON_LEN,
  MAX_TOD_STAT_VALUE,
  TOD_HISTORY_MAX_LIMIT,
  TOD_INDEX_KEY,
  TOD_STAT_KEYS,
  todActiveKey,
  todChallengeKey,
  todStatsKey,
  type TodChallenge,
  type TodStats,
} from "@/lib/games/truth-or-dare-constants";
import { redis, requireSir } from "./_shared";

// ── Bundle reader ────────────────────────────────────────────────────────

/** One-shot admin payload — both active slots, full history (up to
 *  `TOD_HISTORY_MAX_LIMIT`), and both authors' stats. Feeds the
 *  `/admin/games/truth-or-dare` tabbed UI. */
export interface TodAdminBundle {
  active: {
    sirOutgoing: TodChallenge | null;
    kittenOutgoing: TodChallenge | null;
  };
  history: TodChallenge[];
  historyTotal: number;
  stats: {
    T7SEN: TodStats;
    Besho: TodStats;
  };
  generatedAt: number;
}

/** Standard `{ bundle? | error? }` result shape used by the page-level
 *  fetch + setBundle effect. */
export interface TodAdminBundleResult {
  bundle?: TodAdminBundle;
  error?: string;
}

async function readActiveByIssuer(
  issuer: Author,
): Promise<TodChallenge | null> {
  try {
    const id = await redis.get<string>(todActiveKey(issuer));
    if (!id) return null;
    const record = await redis.get<TodChallenge>(todChallengeKey(id));
    if (!record) return null;
    if (!ACTIVE_STATUSES.includes(record.status)) return null;
    return record;
  } catch {
    return null;
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

/**
 * Sir-only admin bundle. Reads both active sentinels, both stats
 * hashes, the index ZCARD, and the most-recent N records in parallel.
 * `historyLimit` clamps to `TOD_HISTORY_MAX_LIMIT`. Returns
 * `{ error }` for non-Sir callers (`requireSir` enforced).
 */
export async function getTodAdminBundle(
  historyLimit: number = TOD_HISTORY_MAX_LIMIT,
): Promise<TodAdminBundleResult> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };

  const safeLimit = Math.max(
    1,
    Math.min(TOD_HISTORY_MAX_LIMIT, Math.floor(Number(historyLimit) || 0)),
  );

  try {
    const [sirOutgoing, kittenOutgoing, sirStats, beshoStats, total, idsRaw] =
      await Promise.all([
        readActiveByIssuer("T7SEN"),
        readActiveByIssuer("Besho"),
        readStats("T7SEN"),
        readStats("Besho"),
        redis.zcard(TOD_INDEX_KEY),
        redis.zrange<string[]>(TOD_INDEX_KEY, 0, safeLimit - 1, {
          rev: true,
        }),
      ]);

    let history: TodChallenge[] = [];
    const ids = (idsRaw ?? []).map(String);
    if (ids.length > 0) {
      const recs = await redis.mget<(TodChallenge | null)[]>(
        ...ids.map(todChallengeKey),
      );
      history = (recs ?? []).filter(
        (r): r is TodChallenge => r !== null,
      );
    }

    return {
      bundle: {
        active: { sirOutgoing, kittenOutgoing },
        history,
        historyTotal: Number(total) || 0,
        stats: { T7SEN: sirStats, Besho: beshoStats },
        generatedAt: Date.now(),
      },
    };
  } catch (err) {
    logger.error("[admin] tod bundle failed", err);
    return { error: "Failed to load admin bundle." };
  }
}

// ── Force-cancel (Sir override, no penalty either direction) ─────────────

/**
 * Sir override on a single challenge. Status → `cancelled`; NO stat
 * increment, NO obedience emit. Distinct from `withdrawChallenge`
 * (issuer-only withdrawal) — this works on either direction and skips
 * the issuer-identity check. Optional `reason` is captured in
 * `adminCancelReason` as Sir's audit trail.
 */
export async function forceCancelTodChallenge(
  id: string,
  reason?: string,
): Promise<{ success?: boolean; error?: string }> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };

  const cleanReason = (reason ?? "").trim();
  if (cleanReason.length > MAX_CANCEL_REASON_LEN) {
    return { error: `Reason too long (max ${MAX_CANCEL_REASON_LEN}).` };
  }

  try {
    const record = await redis.get<TodChallenge>(todChallengeKey(id));
    if (!record) return { error: "Challenge not found." };
    if (!ACTIVE_STATUSES.includes(record.status)) {
      return { error: "Challenge is already finalized." };
    }

    const closedAt = Date.now();
    const updated: TodChallenge = {
      ...record,
      status: "cancelled",
      closedAt,
      ...(cleanReason.length > 0 && { adminCancelReason: cleanReason }),
    };

    const pipeline = redis.pipeline();
    pipeline.set(todChallengeKey(id), updated);
    pipeline.del(todActiveKey(record.issuer));
    await pipeline.exec();

    // Force-cancel does NOT increment any stat counter and does NOT
    // emit an obedience event. It's a clean rollback — Sir's audit
    // trail is the `adminCancelReason` field + the activity log.

    logger.warn("[admin] tod challenge force-cancelled", {
      id,
      issuer: record.issuer,
      recipient: record.recipient,
      fromStatus: record.status,
      reason: cleanReason || undefined,
      by: guard.session.author,
    });
    revalidatePath("/games/truth-or-dare");
    revalidatePath("/admin/games/truth-or-dare");
    return { success: true };
  } catch (err) {
    logger.error("[admin] forceCancelTodChallenge failed", err);
    return { error: "Cancel failed." };
  }
}

/**
 * Sir convenience that walks both active sentinels and force-cancels
 * each. Used when game state is wedged (e.g. both directions in flight
 * during a UI bug); recovers without affecting stats or score. Returns
 * the count of records actually cancelled (0–2).
 */
export async function cancelAllActiveTodChallenges(): Promise<{
  success?: boolean;
  error?: string;
  cancelled?: number;
}> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };

  try {
    const [sirId, kittenId] = await Promise.all([
      redis.get<string>(todActiveKey("T7SEN")),
      redis.get<string>(todActiveKey("Besho")),
    ]);
    const ids = [sirId, kittenId].filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    );
    let cancelled = 0;
    for (const id of ids) {
      const r = await forceCancelTodChallenge(id, "mass-cancel");
      if (r.success) cancelled++;
    }
    return { success: true, cancelled };
  } catch (err) {
    logger.error("[admin] cancelAllActiveTodChallenges failed", err);
    return { error: "Mass cancel failed." };
  }
}

// ── Stat reset / per-stat edit ───────────────────────────────────────────

/**
 * Sir-only stat wipe for one author. `DEL`s the entire
 * `tod:stats:{author}` HASH; subsequent reads fall back to
 * `DEFAULT_TOD_STATS` zeros. Does NOT touch the per-challenge records
 * or obedience score — stats and score are independent axes.
 */
export async function resetTodStats(
  author: Author,
): Promise<{ success?: boolean; error?: string }> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  if (author !== "T7SEN" && author !== "Besho") {
    return { error: "Invalid author." };
  }
  try {
    await redis.del(todStatsKey(author));
    logger.warn("[admin] tod stats reset", {
      author,
      by: guard.session.author,
    });
    revalidatePath("/games/truth-or-dare");
    revalidatePath("/admin/games/truth-or-dare");
    return { success: true };
  } catch (err) {
    logger.error("[admin] resetTodStats failed", err);
    return { error: "Reset failed." };
  }
}

/** Arguments to `adjustTodStat`. `value` is the target absolute value
 *  (not a delta) — `0..MAX_TOD_STAT_VALUE`. */
export interface AdjustTodStatArgs {
  author: Author;
  key: keyof TodStats;
  value: number;
}

/**
 * Sir-only per-stat editor. Sets one counter to an absolute value
 * (not a delta) clamped to `0..MAX_TOD_STAT_VALUE`. A value of `0`
 * `HDEL`s the field so subsequent reads fall back to the zero default.
 */
export async function adjustTodStat(
  args: AdjustTodStatArgs,
): Promise<{ success?: boolean; error?: string }> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  if (args.author !== "T7SEN" && args.author !== "Besho") {
    return { error: "Invalid author." };
  }
  if (!TOD_STAT_KEYS.includes(args.key)) {
    return { error: "Invalid stat key." };
  }
  const n = Math.floor(Number(args.value));
  if (!Number.isFinite(n) || n < 0 || n > MAX_TOD_STAT_VALUE) {
    return {
      error: `Value must be 0..${MAX_TOD_STAT_VALUE}.`,
    };
  }
  try {
    if (n === 0) {
      await redis.hdel(todStatsKey(args.author), args.key as string);
    } else {
      await redis.hset(todStatsKey(args.author), {
        [args.key as string]: n,
      });
    }
    logger.interaction("[admin] tod stat adjusted", {
      author: args.author,
      key: args.key,
      value: n,
      by: guard.session.author,
    });
    revalidatePath("/games/truth-or-dare");
    revalidatePath("/admin/games/truth-or-dare");
    return { success: true };
  } catch (err) {
    logger.error("[admin] adjustTodStat failed", err);
    return { error: "Adjust failed." };
  }
}

// ── Purge all challenges (Sir-only) ──────────────────────────────────────

/**
 * Sir-only mass soft-delete. Walks the entire index, moves every
 * terminal record to `trash` (`feature: "tod_challenges"`), then
 * `DEL`s the records + index. **Refuses if any record is still in
 * `pending` or `picked`** — Sir mass-cancels first. Mirrors the
 * `purgeAllDirectives` / `purgeAllPunishments` pattern.
 */
export async function purgeAllTodChallenges(): Promise<{
  success?: boolean;
  error?: string;
  deletedCount?: number;
}> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };

  try {
    const raw =
      ((await redis.zrange<(string | number)[]>(TOD_INDEX_KEY, 0, -1, {
        withScores: true,
      })) as (string | number)[]) ?? [];
    const pairs: { id: string; score: number }[] = [];
    for (let i = 0; i < raw.length; i += 2) {
      pairs.push({ id: String(raw[i]), score: Number(raw[i + 1]) || 0 });
    }
    const ids = pairs.map((p) => p.id);

    if (ids.length > 0) {
      const records =
        (await redis.mget<TodChallenge[]>(...ids.map(todChallengeKey))) ?? [];

      const active = records.find(
        (r) => r && ACTIVE_STATUSES.includes(r.status),
      );
      if (active) {
        return {
          error:
            "An active challenge exists. Cancel all active ones before purging.",
        };
      }

      await moveManyToTrash(
        redis,
        pairs.map((p, i) => {
          const rec = records[i];
          const label = rec
            ? rec.pick === "truth"
              ? `🎲 truth: ${rec.truthPrompt.slice(0, 40)}`
              : rec.pick === "dare"
                ? `🎲 dare: ${rec.darePrompt.slice(0, 40)}`
                : `🎲 ${rec.truthPrompt.slice(0, 40)}`
            : p.id;
          return {
            feature: "tod_challenges" as const,
            id: p.id,
            label,
            deletedBy: guard.session.author,
            payload: rec ?? null,
            indexScore: p.score,
            recordKey: todChallengeKey(p.id),
            indexKey: TOD_INDEX_KEY,
          };
        }),
      );
    }

    const pipeline = redis.pipeline();
    for (const id of ids) pipeline.del(todChallengeKey(id));
    pipeline.del(TOD_INDEX_KEY);
    if (ids.length > 0) await pipeline.exec();

    revalidatePath("/games/truth-or-dare");
    revalidatePath("/admin/games/truth-or-dare");
    logger.warn(`[admin] tod challenges purged`, {
      deletedCount: ids.length,
      by: guard.session.author,
    });
    return { success: true, deletedCount: ids.length };
  } catch (err) {
    logger.error("[admin] purgeAllTodChallenges failed", err);
    return { error: "Purge failed." };
  }
}

// ── Windowed stats (Sir-only) ────────────────────────────────────────────

/** Counter shape for the windowed-stats view. Subset of `TodStats` —
 *  excludes the streak fields, which are sequential and don't make
 *  sense for a time-window aggregation (computing "streak in the last
 *  7 days" requires walking the timeline in order, which the
 *  cumulative HASH already encodes). */
export interface TodWindowedCounters {
  issued: number;
  truthsAnswered: number;
  daresCompleted: number;
  refused: number;
  safeworded: number;
  expired: number;
  withdrawn: number;
}

const ZERO_WINDOWED_COUNTERS: TodWindowedCounters = {
  issued: 0,
  truthsAnswered: 0,
  daresCompleted: 0,
  refused: 0,
  safeworded: 0,
  expired: 0,
  withdrawn: 0,
};

export interface TodWindowedStats {
  T7SEN: TodWindowedCounters;
  Besho: TodWindowedCounters;
  /** Null when the caller passed no window (all-time aggregation). */
  windowDays: number | null;
  /** Inclusive range covered by the read. `toMs` is always now. */
  range: { fromMs: number; toMs: number };
  /** Total challenges in the window (regardless of status). */
  total: number;
  generatedAt: number;
}

export interface TodWindowedStatsResult {
  stats?: TodWindowedStats;
  error?: string;
}

/**
 * Sir-only windowed aggregation across the TOD index. Walks records
 * whose `createdAt` falls within the window (or all records when
 * `windowDays` is null/undefined), then increments per-author
 * counters based on each record's terminal status. The issuer's
 * `issued` counter increments for every record in the window;
 * recipient-side counters (`truthsAnswered` / `daresCompleted` /
 * `refused` / `safeworded` / `expired`) follow the status. Withdrawn
 * counts on the issuer side (mirrors the cumulative HASH semantics).
 * Cancelled challenges are intentionally not counted anywhere —
 * admin overrides are clean rollbacks.
 *
 * Performance: O(N) where N is the number of challenges in the
 * window. Fine at two-user scale; a year of regular play is a few
 * hundred records.
 */
export async function getTodWindowedStats(
  windowDays?: number | null,
): Promise<TodWindowedStatsResult> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };

  const now = Date.now();
  let fromMs = 0;
  const toMs = now;
  let resolvedWindow: number | null = null;
  if (typeof windowDays === "number" && Number.isFinite(windowDays)) {
    if (windowDays <= 0 || windowDays > 3650) {
      return { error: "Window must be 1..3650 days, or omitted for all time." };
    }
    resolvedWindow = Math.floor(windowDays);
    fromMs = now - resolvedWindow * 24 * 60 * 60_000;
  }

  try {
    const idsRaw =
      resolvedWindow === null
        ? ((await redis.zrange<string[]>(TOD_INDEX_KEY, 0, -1)) ?? [])
        : ((await redis.zrange<string[]>(
            TOD_INDEX_KEY,
            fromMs,
            toMs,
            { byScore: true },
          )) ?? []);
    const ids = idsRaw.map(String);
    if (ids.length === 0) {
      return {
        stats: {
          T7SEN: { ...ZERO_WINDOWED_COUNTERS },
          Besho: { ...ZERO_WINDOWED_COUNTERS },
          windowDays: resolvedWindow,
          range: { fromMs, toMs },
          total: 0,
          generatedAt: now,
        },
      };
    }
    const recs =
      (await redis.mget<(TodChallenge | null)[]>(
        ...ids.map(todChallengeKey),
      )) ?? [];

    const counters: Record<Author, TodWindowedCounters> = {
      T7SEN: { ...ZERO_WINDOWED_COUNTERS },
      Besho: { ...ZERO_WINDOWED_COUNTERS },
    };

    for (const r of recs) {
      if (!r) continue;
      // Every record in the window counts as "issued" against the issuer.
      counters[r.issuer].issued++;
      switch (r.status) {
        case "completed":
          if (r.pick === "truth") counters[r.recipient].truthsAnswered++;
          else if (r.pick === "dare") counters[r.recipient].daresCompleted++;
          break;
        case "refused":
          counters[r.recipient].refused++;
          break;
        case "safeworded":
          counters[r.recipient].safeworded++;
          break;
        case "expired":
          counters[r.recipient].expired++;
          break;
        case "withdrawn":
          counters[r.issuer].withdrawn++;
          break;
        case "cancelled":
        case "pending":
        case "picked":
          // Admin overrides + active states aren't counted in stats.
          break;
      }
    }

    return {
      stats: {
        T7SEN: counters.T7SEN,
        Besho: counters.Besho,
        windowDays: resolvedWindow,
        range: { fromMs, toMs },
        total: recs.filter((r): r is TodChallenge => r !== null).length,
        generatedAt: now,
      },
    };
  } catch (err) {
    logger.error("[admin] getTodWindowedStats failed", err);
    return { error: "Failed to compute windowed stats." };
  }
}

// ── Active-count for the /admin landing dashboard strip ──────────────────

/**
 * Sir-only count of active TOD challenges (0–2). Reads both
 * `tod:active:{author}` sentinels in parallel. Surfaces on the
 * `/admin` landing dashboard strip alongside pending perms / claims /
 * cron freshness / errors-24h. Stand-alone accessor; the bundled count
 * also lives in `getAdminLandingSummary.activeTodChallenges`.
 */
export async function getActiveTodCount(): Promise<{
  count?: number;
  error?: string;
}> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  try {
    const [sirId, kittenId] = await Promise.all([
      redis.get<string>(todActiveKey("T7SEN")),
      redis.get<string>(todActiveKey("Besho")),
    ]);
    let count = 0;
    if (sirId) count++;
    if (kittenId) count++;
    return { count };
  } catch (err) {
    logger.error("[admin] getActiveTodCount failed", err);
    return { error: "Count failed." };
  }
}
