// src/app/actions/reviews.ts
"use server";

import { redis } from "@/lib/redis";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { decrypt } from "@/lib/auth-utils";
import { sendNotification } from "@/app/actions/notifications";
import { logger } from "@/lib/logger";
import { moveToTrash, moveManyToTrash } from "@/lib/trash";
import { assertWriteAllowed } from "@/lib/restraint";
import type { SafeWordEvent } from "@/app/actions/safeword";
import {
  HISTORY_PAGE_SIZE,
  MAX_FIELD_LENGTH,
  REVIEW_FIELDS,
  type RevealedHistoryItem,
  type RevealedPair,
  type ReviewAuthor,
  type ReviewBundle,
  type ReviewRecord,
  type WeekMoodCell,
  type WeekSummary,
} from "@/lib/review-constants";
import {
  currentReviewWeekDate,
  formatWeekLabel,
  isWithinSubmissionWindow,
  nextSubmissionWindowOpenMs,
  partnerOf,
  submissionWindowCloseMs,
  weekDays,
  weekRangeMs,
} from "@/lib/review-utils";

const REVEALED_INDEX = "reviews:revealed";
const reviewKey = (weekDate: string, author: ReviewAuthor) =>
  `review:${weekDate}:${author}`;

async function getSession() {
  const cookieStore = await cookies();
  const value = cookieStore.get("session")?.value;
  if (!value) return null;
  return decrypt(value);
}

function isAuthor(value: unknown): value is ReviewAuthor {
  return value === "T7SEN" || value === "Besho";
}

// ─── Submit ─────────────────────────────────────────────────────────────

/**
 * Both authors. Upserts the caller's own record for the current
 * review week, then atomically attempts to fire a reveal if the
 * partner has already submitted.
 *
 * Reveal correctness — race-free design:
 *  1. Pipeline: SET own record, GET partner record (post-write).
 *  2. If partner record exists, attempt `ZADD reviews:revealed` with
 *     `nx: true`. The single member ensures only one push fires
 *     even if both authors submit within the same millisecond.
 *  3. The author whose ZADD returns `1` is responsible for the FCM
 *     fan-out. The other author's ZADD returns `0` — silent.
 *
 * Edits-until-reveal is allowed: the SET overwrites freely, but the
 * pre-write `ZSCORE reviews:revealed` gate rejects edits after reveal.
 */
export async function submitReview(
  _prevState: unknown,
  formData: FormData,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!isAuthor(session?.author)) return { error: "Not authenticated." };
  const author = session.author;
  const partner = partnerOf(author);

  const block = await assertWriteAllowed(author);
  if (block) return block;

  // Fields. Server is the only authority on weekDate — ignore any
  // client-supplied value.
  const fields: Record<string, string> = {};
  for (const meta of REVIEW_FIELDS) {
    const raw = (formData.get(meta.key) as string) ?? "";
    const trimmed = raw.trim();
    if (trimmed.length > MAX_FIELD_LENGTH) {
      return { error: `${meta.label} exceeds ${MAX_FIELD_LENGTH} chars.` };
    }
    fields[meta.key] = trimmed;
  }
  const hasContent = REVIEW_FIELDS.some((m) => fields[m.key].length > 0);
  if (!hasContent) return { error: "At least one field required." };

  const now = Date.now();
  const weekDate = currentReviewWeekDate(now);
  if (!isWithinSubmissionWindow(weekDate, now)) {
    return { error: "Submission window is closed for this week." };
  }

  try {
    // Reveal-gate: refuse edits after reveal.
    const revealedScore = await redis.zscore(REVEALED_INDEX, weekDate);
    if (revealedScore !== null && revealedScore !== undefined) {
      return { error: "This week is already revealed and locked." };
    }

    const ownKey = reviewKey(weekDate, author);
    const existing = await redis.get<ReviewRecord>(ownKey);

    const record: ReviewRecord = {
      weekDate,
      author,
      whatWorked: fields.whatWorked,
      whatDidnt: fields.whatDidnt,
      friction: fields.friction,
      goalsNext: fields.goalsNext,
      submittedAt: existing?.submittedAt ?? now,
      ...(existing ? { editedAt: now } : {}),
    };

    // SET own + GET partner in one round-trip. Cross-author ordering
    // is handled by the post-pipeline ZADD-nx below.
    const pipeline = redis.pipeline();
    pipeline.set(ownKey, record);
    pipeline.get<ReviewRecord>(reviewKey(weekDate, partner));
    const results = (await pipeline.exec()) as [unknown, ReviewRecord | null];
    const partnerRecord = results[1];

    if (partnerRecord) {
      // Both records exist — try to claim the reveal.
      const added = await redis.zadd(
        REVEALED_INDEX,
        { nx: true },
        { score: now, member: weekDate },
      );
      if (added === 1) {
        // We won the reveal race. Fan out push to both authors.
        // Step-3 of the 4-step push algorithm naturally suppresses
        // pushes for authors currently on `/review`; whichever side is
        // backgrounded gets the FCM banner.
        const label = formatWeekLabel(weekDate);
        await Promise.all([
          sendNotification("T7SEN", {
            title: "🪞 Review revealed",
            body: `Both reflections for ${label} are ready.`,
            url: "/review",
          }),
          sendNotification("Besho", {
            title: "🪞 Review revealed",
            body: `Both reflections for ${label} are ready.`,
            url: "/review",
          }),
        ]);
        logger.interaction("[reviews] Week revealed", {
          weekDate,
          revealedBy: author,
        });
      }
    } else if (!existing) {
      // First-submit path, partner hasn't submitted yet. Notify the
      // partner that a reflection is waiting — informational only,
      // no urgency, no submission pressure. Skipped on edits because
      // the partner was already notified on the original submission;
      // an "edited" push would be noise.
      const label = formatWeekLabel(weekDate);
      await sendNotification(partner, {
        title: "🪞 Reflection waiting",
        body: `${author === "T7SEN" ? "Sir" : "Besho"} submitted theirs for ${label}.`,
        url: "/review",
      });
      logger.interaction("[reviews] Partner-submitted notice sent", {
        weekDate,
        submittedBy: author,
      });
    }

    logger.interaction("[reviews] Review submitted", {
      weekDate,
      author,
      isEdit: !!existing,
    });
    revalidatePath("/review");
    return { success: true };
  } catch (error) {
    logger.error("[reviews] Failed to submit:", error);
    return { error: "Failed to submit review." };
  }
}

// ─── Read paths ─────────────────────────────────────────────────────────

/** Returns the caller's own record for the given week. */
export async function getMyReview(
  weekDate?: string,
): Promise<ReviewRecord | null> {
  const session = await getSession();
  if (!isAuthor(session?.author)) return null;
  const finalWeek = weekDate ?? currentReviewWeekDate(Date.now());
  try {
    return await redis.get<ReviewRecord>(reviewKey(finalWeek, session.author));
  } catch (error) {
    logger.error("[reviews] Failed to fetch own:", error);
    return null;
  }
}

/**
 * Returns the reveal envelope iff the week is in `reviews:revealed`.
 * Server is the sole authority on the gate.
 */
export async function getRevealedReview(
  weekDate: string,
): Promise<RevealedPair | null> {
  const session = await getSession();
  if (!isAuthor(session?.author)) return null;

  try {
    const score = await redis.zscore(REVEALED_INDEX, weekDate);
    if (score === null || score === undefined) return null;

    const pipeline = redis.pipeline();
    pipeline.get<ReviewRecord>(reviewKey(weekDate, "T7SEN"));
    pipeline.get<ReviewRecord>(reviewKey(weekDate, "Besho"));
    const [t7sen, besho] = (await pipeline.exec()) as [
      ReviewRecord | null,
      ReviewRecord | null,
    ];
    if (!t7sen || !besho) {
      logger.warn("[reviews] Revealed week missing a record:", { weekDate });
      return null;
    }

    return {
      weekDate,
      revealedAt: score,
      T7SEN: t7sen,
      Besho: besho,
    };
  } catch (error) {
    logger.error("[reviews] Failed to fetch revealed:", error);
    return null;
  }
}

/** Boolean only — never returns partner content pre-reveal. */
export async function getPartnerSubmissionStatus(
  weekDate?: string,
): Promise<boolean> {
  const session = await getSession();
  if (!isAuthor(session?.author)) return false;
  const finalWeek = weekDate ?? currentReviewWeekDate(Date.now());
  const partner = partnerOf(session.author);
  try {
    const record = await redis.get<ReviewRecord>(reviewKey(finalWeek, partner));
    return !!record;
  } catch (error) {
    logger.error("[reviews] Failed to fetch partner status:", error);
    return false;
  }
}

/** Recent revealed weeks, newest first. */
export async function getRevealedHistory(
  limit = HISTORY_PAGE_SIZE,
): Promise<RevealedHistoryItem[]> {
  const session = await getSession();
  if (!isAuthor(session?.author)) return [];
  try {
    const pairs = (await redis.zrange(REVEALED_INDEX, 0, limit - 1, {
      rev: true,
      withScores: true,
    })) as (string | number)[];
    const items: RevealedHistoryItem[] = [];
    for (let i = 0; i < pairs.length; i += 2) {
      const weekDate = String(pairs[i]);
      const revealedAt = Number(pairs[i + 1]);
      items.push({
        weekDate,
        revealedAt,
        label: formatWeekLabel(weekDate),
      });
    }
    return items;
  } catch (error) {
    logger.error("[reviews] Failed to fetch history:", error);
    return [];
  }
}

// ─── Aggregator ─────────────────────────────────────────────────────────

interface RuleSnap {
  createdAt?: number;
  acknowledgedAt?: number;
  completedAt?: number;
}
interface TaskSnap {
  createdAt?: number;
  completedAt?: number;
}
interface LedgerSnap {
  type?: "reward" | "punishment";
  occurredAt?: number;
}
interface PermSnap {
  status?: "pending" | "approved" | "denied" | "queued" | "withdrawn";
}
interface NoteSnap {
  author?: ReviewAuthor;
}

/**
 * Aggregates existing data for the reviewed week. Intended to be
 * rendered alongside the writing surface so the writer has facts on
 * screen.
 *
 * Performance: rules and tasks are fetched in full because the
 * counters (created / acknowledged / completed) span multiple
 * timestamp fields, none of which are individually indexed. At the
 * scale of a two-user app this is trivially cheap (≤ a few hundred
 * records each, single MGET round-trip). Ledger / permissions /
 * notes use BYSCORE range fetches because their counters are
 * single-timestamp and the index score matches.
 *
 * Mood history is `mood:{date}:{author}` STRING values with a 7-day
 * TTL — viewing weeks > 7 days back will surface null cells, by
 * design (the daily-view feature was never an archive).
 */
export async function getReviewWeekSummary(
  weekDate?: string,
): Promise<WeekSummary> {
  const session = await getSession();
  const author = isAuthor(session?.author) ? session.author : null;
  const finalWeek = weekDate ?? currentReviewWeekDate(Date.now());
  if (!author) return makeEmptySummary(finalWeek);
  return computeWeekSummary(finalWeek, author);
}

async function computeWeekSummary(
  weekDate: string,
  viewer: ReviewAuthor,
): Promise<WeekSummary> {
  const range = weekRangeMs(weekDate);
  const days = weekDays(weekDate);

  try {
    const moodKeys = days.flatMap((d) => [
      `mood:${d}:T7SEN`,
      `mood:${d}:Besho`,
    ]);
    const stateKeys = days.flatMap((d) => [
      `state:${d}:T7SEN`,
      `state:${d}:Besho`,
    ]);
    const hugKeys = days.flatMap((d) => [
      `mood:hug:${d}:T7SEN`,
      `mood:hug:${d}:Besho`,
    ]);

    const [
      moodVals,
      stateVals,
      hugVals,
      ruleIds,
      taskIds,
      ledgerIds,
      permIds,
      noteIds,
      safewordHistory,
    ] = await Promise.all([
      redis.mget<(string | null)[]>(...moodKeys),
      redis.mget<(string | null)[]>(...stateKeys),
      redis.mget<(string | null)[]>(...hugKeys),
      redis.zrange("rules:index", 0, -1) as Promise<string[]>,
      redis.zrange("tasks:index", 0, -1) as Promise<string[]>,
      redis.zrange("ledger:index", range.start, range.end, {
        byScore: true,
      }) as Promise<string[]>,
      redis.zrange("permissions:index", range.start, range.end, {
        byScore: true,
      }) as Promise<string[]>,
      redis.zrange("notes:index", range.start, range.end, {
        byScore: true,
      }) as Promise<string[]>,
      redis.lrange<SafeWordEvent>("safeword:history", 0, -1),
    ]);

    const [rules, tasks, ledger, permissions, notes] = await Promise.all([
      ruleIds.length
        ? redis.mget<(RuleSnap | null)[]>(...ruleIds.map((id) => `rule:${id}`))
        : Promise.resolve([] as (RuleSnap | null)[]),
      taskIds.length
        ? redis.mget<(TaskSnap | null)[]>(...taskIds.map((id) => `task:${id}`))
        : Promise.resolve([] as (TaskSnap | null)[]),
      ledgerIds.length
        ? redis.mget<(LedgerSnap | null)[]>(
            ...ledgerIds.map((id) => `ledger:${id}`),
          )
        : Promise.resolve([] as (LedgerSnap | null)[]),
      permIds.length
        ? redis.mget<(PermSnap | null)[]>(
            ...permIds.map((id) => `permission:${id}`),
          )
        : Promise.resolve([] as (PermSnap | null)[]),
      noteIds.length
        ? redis.mget<(NoteSnap | null)[]>(...noteIds.map((id) => `note:${id}`))
        : Promise.resolve([] as (NoteSnap | null)[]),
    ]);

    // Mood + state cells per day per author.
    const cells = (which: "T7SEN" | "Besho"): WeekMoodCell[] => {
      const off = which === "T7SEN" ? 0 : 1;
      return days.map((date, i) => ({
        date,
        mood: moodVals[i * 2 + off] ?? null,
        state: stateVals[i * 2 + off] ?? null,
      }));
    };

    const hugs = { T7SEN: 0, Besho: 0 };
    days.forEach((_, i) => {
      if (hugVals[i * 2]) hugs.T7SEN += 1;
      if (hugVals[i * 2 + 1]) hugs.Besho += 1;
    });

    const rulesAgg = { created: 0, acknowledged: 0, completed: 0 };
    for (const r of rules) {
      if (!r) continue;
      if (
        r.createdAt !== undefined &&
        r.createdAt >= range.start &&
        r.createdAt <= range.end
      ) {
        rulesAgg.created += 1;
      }
      if (
        r.acknowledgedAt !== undefined &&
        r.acknowledgedAt >= range.start &&
        r.acknowledgedAt <= range.end
      ) {
        rulesAgg.acknowledged += 1;
      }
      if (
        r.completedAt !== undefined &&
        r.completedAt >= range.start &&
        r.completedAt <= range.end
      ) {
        rulesAgg.completed += 1;
      }
    }

    const tasksAgg = { created: 0, completed: 0 };
    for (const t of tasks) {
      if (!t) continue;
      if (
        t.createdAt !== undefined &&
        t.createdAt >= range.start &&
        t.createdAt <= range.end
      ) {
        tasksAgg.created += 1;
      }
      if (
        t.completedAt !== undefined &&
        t.completedAt >= range.start &&
        t.completedAt <= range.end
      ) {
        tasksAgg.completed += 1;
      }
    }

    const ledgerAgg = { rewards: 0, punishments: 0 };
    for (const l of ledger) {
      if (!l) continue;
      if (l.type === "reward") ledgerAgg.rewards += 1;
      else if (l.type === "punishment") ledgerAgg.punishments += 1;
    }

    const permsAgg = {
      submitted: 0,
      approved: 0,
      denied: 0,
      queued: 0,
      withdrawn: 0,
    };
    for (const p of permissions) {
      if (!p) continue;
      permsAgg.submitted += 1;
      if (p.status === "approved") permsAgg.approved += 1;
      else if (p.status === "denied") permsAgg.denied += 1;
      else if (p.status === "queued") permsAgg.queued += 1;
      else if (p.status === "withdrawn") permsAgg.withdrawn += 1;
    }
    // No `decidedByRuleId` or auto-attribution leaks — counts only.

    const notesAgg = { total: 0, T7SEN: 0, Besho: 0 };
    for (const n of notes) {
      if (!n) continue;
      notesAgg.total += 1;
      if (n.author === "T7SEN") notesAgg.T7SEN += 1;
      else if (n.author === "Besho") notesAgg.Besho += 1;
    }

    const triggeredTimestamps: number[] = [];
    for (const ev of safewordHistory ?? []) {
      if (!ev || typeof ev.timestamp !== "number") continue;
      if (ev.timestamp >= range.start && ev.timestamp <= range.end) {
        triggeredTimestamps.push(ev.timestamp);
      }
    }
    const safewordOut = {
      triggered: triggeredTimestamps.length,
      timestamps: viewer === "T7SEN" ? triggeredTimestamps : [],
    };

    return {
      weekDate,
      range,
      mood: { T7SEN: cells("T7SEN"), Besho: cells("Besho") },
      hugs,
      rules: rulesAgg,
      tasks: tasksAgg,
      ledger: ledgerAgg,
      permissions: permsAgg,
      notes: notesAgg,
      safeword: safewordOut,
    };
  } catch (error) {
    logger.error("[reviews] Failed to compute summary:", error);
    return makeEmptySummary(weekDate);
  }
}

function makeEmptySummary(weekDate: string): WeekSummary {
  const range = weekRangeMs(weekDate);
  const emptyCells: WeekMoodCell[] = weekDays(weekDate).map((date) => ({
    date,
    mood: null,
    state: null,
  }));
  return {
    weekDate,
    range,
    mood: { T7SEN: emptyCells, Besho: emptyCells },
    hugs: { T7SEN: 0, Besho: 0 },
    rules: { created: 0, acknowledged: 0, completed: 0 },
    tasks: { created: 0, completed: 0 },
    ledger: { rewards: 0, punishments: 0 },
    permissions: {
      submitted: 0,
      approved: 0,
      denied: 0,
      queued: 0,
      withdrawn: 0,
    },
    notes: { total: 0, T7SEN: 0, Besho: 0 },
    safeword: { triggered: 0, timestamps: [] },
  };
}

// ─── Page bundle ────────────────────────────────────────────────────────

/**
 * Single-call page-load convenience. Fetches own record, partner-
 * submitted boolean, optional reveal envelope, summary, and window
 * state in one round-trip. Used by `src/app/review/page.tsx`.
 */
export async function getReviewBundle(
  weekDate?: string,
): Promise<ReviewBundle> {
  const session = await getSession();
  const author = isAuthor(session?.author) ? session.author : null;
  const finalWeek = weekDate ?? currentReviewWeekDate(Date.now());

  if (!author) return makeEmptyBundle(finalWeek);

  try {
    const partner = partnerOf(author);
    const [myRecord, partnerRecord, revealedScore, summary] = await Promise.all(
      [
        redis.get<ReviewRecord>(reviewKey(finalWeek, author)),
        redis.get<ReviewRecord>(reviewKey(finalWeek, partner)),
        redis.zscore(REVEALED_INDEX, finalWeek),
        computeWeekSummary(finalWeek, author),
      ],
    );

    const isRevealed = revealedScore !== null && revealedScore !== undefined;

    let revealed: RevealedPair | null = null;
    if (isRevealed && myRecord && partnerRecord) {
      revealed = {
        weekDate: finalWeek,
        revealedAt: revealedScore,
        T7SEN: author === "T7SEN" ? myRecord : partnerRecord,
        Besho: author === "Besho" ? myRecord : partnerRecord,
      };
    }

    const now = Date.now();
    const withinWindow = isWithinSubmissionWindow(finalWeek, now);

    return {
      weekDate: finalWeek,
      withinWindow,
      windowOpensAt: withinWindow ? null : nextSubmissionWindowOpenMs(now),
      windowClosesAt: submissionWindowCloseMs(finalWeek),
      revealed,
      myRecord: myRecord ?? null,
      partnerSubmitted: !!partnerRecord,
      summary,
    };
  } catch (error) {
    logger.error("[reviews] Failed to load bundle:", error);
    return makeEmptyBundle(finalWeek);
  }
}

function makeEmptyBundle(weekDate: string): ReviewBundle {
  const now = Date.now();
  const withinWindow = isWithinSubmissionWindow(weekDate, now);
  return {
    weekDate,
    withinWindow,
    windowOpensAt: withinWindow ? null : nextSubmissionWindowOpenMs(now),
    windowClosesAt: submissionWindowCloseMs(weekDate),
    revealed: null,
    myRecord: null,
    partnerSubmitted: false,
    summary: makeEmptySummary(weekDate),
  };
}

// ─── Sir-only destructive ─────────────────────────────────────────────────────

export async function deleteReviewWeek(
  weekDate: string,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "T7SEN")
    return { error: "Only Sir can delete reviews." };

  try {
    const [t7sen, besho, scoreRaw] = await Promise.all([
      redis.get<ReviewRecord>(reviewKey(weekDate, "T7SEN")),
      redis.get<ReviewRecord>(reviewKey(weekDate, "Besho")),
      redis.zscore(REVEALED_INDEX, weekDate),
    ]);

    if (t7sen || besho) {
      await moveToTrash(redis, {
        feature: "reviews",
        id: weekDate,
        label: `Week of ${weekDate}`,
        deletedBy: session.author,
        payload: t7sen ?? null,
        indexScore:
          typeof scoreRaw === "number"
            ? scoreRaw
            : Number(scoreRaw) || Date.now(),
        recordKey: reviewKey(weekDate, "T7SEN"),
        indexKey: REVEALED_INDEX,
        extraRecords: [
          { key: reviewKey(weekDate, "Besho"), value: besho ?? null },
        ],
      });
    }

    const pipeline = redis.pipeline();
    pipeline.del(reviewKey(weekDate, "T7SEN"));
    pipeline.del(reviewKey(weekDate, "Besho"));
    pipeline.zrem(REVEALED_INDEX, weekDate);
    await pipeline.exec();

    revalidatePath("/review");
    logger.warn(`[reviews] Sir deleted week ${weekDate}.`);
    return { success: true };
  } catch (err) {
    logger.error("[reviews] deleteReviewWeek failed:", err);
    return { error: "Failed to delete week." };
  }
}

export async function purgeAllReviews(): Promise<{
  success?: boolean;
  error?: string;
  deletedCount?: number;
}> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "T7SEN")
    return { error: "Only Sir can purge reviews." };

  try {
    const raw =
      ((await redis.zrange<(string | number)[]>(REVEALED_INDEX, 0, -1, {
        withScores: true,
      })) as (string | number)[]) ?? [];
    const pairs: { weekDate: string; score: number }[] = [];
    for (let i = 0; i < raw.length; i += 2) {
      pairs.push({
        weekDate: String(raw[i]),
        score: Number(raw[i + 1]) || 0,
      });
    }
    const weekDates = pairs.map((p) => p.weekDate);

    if (weekDates.length > 0) {
      const t7senKeys = weekDates.map((wd) => reviewKey(wd, "T7SEN"));
      const beshoKeys = weekDates.map((wd) => reviewKey(wd, "Besho"));
      const [t7senRecords, beshoRecords] = await Promise.all([
        redis.mget<ReviewRecord[]>(...t7senKeys),
        redis.mget<ReviewRecord[]>(...beshoKeys),
      ]);
      await moveManyToTrash(
        redis,
        pairs.map((p, i) => ({
          feature: "reviews" as const,
          id: p.weekDate,
          label: `Week of ${p.weekDate}`,
          deletedBy: session.author,
          payload: t7senRecords?.[i] ?? null,
          indexScore: p.score,
          recordKey: reviewKey(p.weekDate, "T7SEN"),
          indexKey: REVEALED_INDEX,
          extraRecords: [
            {
              key: reviewKey(p.weekDate, "Besho"),
              value: beshoRecords?.[i] ?? null,
            },
          ],
        })),
      );
    }

    const pipeline = redis.pipeline();
    for (const wd of weekDates) {
      pipeline.del(reviewKey(wd, "T7SEN"));
      pipeline.del(reviewKey(wd, "Besho"));
    }
    pipeline.del(REVEALED_INDEX);
    if (weekDates.length > 0) await pipeline.exec();

    revalidatePath("/review");
    logger.warn(`[reviews] Sir purged ${weekDates.length} weeks.`);
    return { success: true, deletedCount: weekDates.length };
  } catch (err) {
    logger.error("[reviews] purgeAllReviews failed:", err);
    return { error: "Purge failed." };
  }
}
