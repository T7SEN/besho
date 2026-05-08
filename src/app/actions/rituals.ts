// src/app/actions/rituals.ts
"use server";

import { redis } from "@/lib/redis";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { decrypt } from "@/lib/auth-utils";
import { sendNotification } from "@/app/actions/notifications";
import { logger } from "@/lib/logger";
import { moveToTrash, moveManyToTrash } from "@/lib/trash";
import { assertWriteAllowed } from "@/lib/restraint";
import { recordObedienceEvent } from "@/lib/obedience";
import {
  HISTORY_DOT_ROW_DAYS,
  MAX_EVERY_N_DAYS,
  MAX_SUBMISSION_TEXT_LENGTH,
  MAX_WINDOW_DURATION_MINUTES,
  MIN_EVERY_N_DAYS,
  MIN_WINDOW_DURATION_MINUTES,
  SUPPORTED_CADENCES,
} from "@/lib/rituals-constants";
import {
  computeRitualTodayState,
  computeStreak,
  parseAndNormalizeHHMM,
  type CadenceConfig,
  type RitualTodayState,
} from "@/lib/rituals";
import {
  dateKeyInTz,
  previousDateKey,
  todayKeyCairo,
  tzWallClockToUtcMs,
} from "@/lib/cairo-time";

export type RitualOwner = "T7SEN" | "Besho";
export type RitualCadence = "daily" | "weekly" | "every_n_days";

export interface Ritual {
  id: string;
  title: string;
  description?: string;
  owner: RitualOwner;
  cadence: RitualCadence;
  /** Required for `weekly` — JS-style weekday indices (Sun=0..Sat=6). */
  weekdays?: number[];
  /** Required for `every_n_days`. */
  everyNDays?: number;
  /** Required for `every_n_days` — Cairo date the ritual is phased to. */
  anchorDateKey?: string;
  windowStart: string;
  windowDurationMinutes: number;
  createdAt: number;
  createdBy: RitualOwner;
  active: boolean;
  pausedUntil?: number;
  /** Set on every `updateRitual`. Absent on rituals never edited. */
  updatedAt?: number;
}

export interface RitualOccurrence {
  ritualId: string;
  dateKey: string;
  submittedAt: number;
  text: string;
  skippedBy?: RitualOwner;
}

/**
 * Lightweight per-day status used by the history dot row UI. `prescribed`
 * is computed client-side from cadence config; the server only surfaces
 * what's in Redis.
 */
export interface RitualHistoryEntry {
  dateKey: string;
  submitted: boolean;
  skipped: boolean;
}

export interface RitualWithToday extends Ritual {
  todayState: RitualTodayState;
  owningDateKey: string;
  windowOpensAtMs: number;
  windowClosesAtMs: number;
  currentStreak: number;
  longestStreak: number;
  todaySubmission: RitualOccurrence | null;
  /**
   * Cairo date keys (YYYY-MM-DD) strictly in the future where Sir has
   * granted a skip-day. Any future occurrence record is necessarily a
   * skip — `submitOccurrence` rejects future submissions — so the
   * server fetches all future occurrences and returns their date keys
   * here.
   */
  upcomingSkipDateKeys: string[];
  /**
   * Last `HISTORY_DOT_ROW_DAYS` calendar days (oldest first, today last)
   * with submission/skip status. Drives the dot row UI.
   */
  history: RitualHistoryEntry[];
}

const INDEX_KEY = "rituals:index";
const ritualKey = (id: string) => `ritual:${id}`;
const occurrenceKey = (id: string, dateKey: string) =>
  `ritual:occurrence:${id}:${dateKey}`;
const occurrencesIndexKey = (id: string) => `ritual:occurrences:${id}`;
const streakKey = (id: string) => `ritual:streak:${id}`;
const longestStreakKey = (id: string) => `ritual:streak:${id}:longest`;

async function getSession() {
  const cookieStore = await cookies();
  const value = cookieStore.get("session")?.value;
  if (!value) return null;
  return decrypt(value);
}

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * Returns all rituals enriched with today's state, current streak, longest
 * streak, and today's submission (if any). Sorted by `windowStart` ascending
 * for stable list rendering.
 */
export async function getRituals(): Promise<RitualWithToday[]> {
  try {
    const ids = (await redis.zrange(INDEX_KEY, 0, -1, {
      rev: true,
    })) as string[];
    if (!ids.length) return [];

    const rituals = await redis.mget<(Ritual | null)[]>(...ids.map(ritualKey));
    const present = rituals.filter((r): r is Ritual => r !== null);
    if (!present.length) return [];

    const now = Date.now();
    const todayKey = todayKeyCairo(now);
    // Cairo midnight of today as UTC ms — used as exclusive lower bound
    // for the future-occurrences ZRANGE-BYSCORE. Today's skip is surfaced
    // via `todaySubmission`, not this list, so we exclude today.
    const todayMidnightMs = tzWallClockToUtcMs(todayKey, "00:00");
    const futureScoreMin = todayMidnightMs + 1;

    // Pre-compute the date keys for the last HISTORY_DOT_ROW_DAYS (oldest
    // first, today last). Same for every ritual, so build it once.
    const historyDateKeys: string[] = [];
    {
      let cursor = todayKey;
      for (let i = 0; i < HISTORY_DOT_ROW_DAYS; i += 1) {
        historyDateKeys.unshift(cursor);
        cursor = previousDateKey(cursor);
      }
    }

    const enriched = await Promise.all(
      present.map(async (r) => {
        const todayInfo = computeRitualTodayState({
          active: r.active,
          pausedUntilMs: r.pausedUntil ?? null,
          cadence: r.cadence,
          weekdays: r.weekdays,
          everyNDays: r.everyNDays,
          anchorDateKey: r.anchorDateKey,
          windowStart: r.windowStart,
          durationMinutes: r.windowDurationMinutes,
          now,
          hasOccurrenceForOwningDate: () => false,
        });

        // Pipeline layout (index-accessed below):
        //   0: streak counter (string|number|null)
        //   1: longest-streak counter (string|number|null)
        //   2: future skip-day keys (string[]|null)
        //   3..(3 + HISTORY_DOT_ROW_DAYS - 1): per-day occurrence HGETALLs
        // owningDateKey is always one of the historyDateKeys (today or
        // yesterday for midnight-crossing windows), so we read it out of
        // the history slice instead of issuing a separate HGETALL.
        const pipeline = redis.pipeline();
        pipeline.get(streakKey(r.id));
        pipeline.get(longestStreakKey(r.id));
        pipeline.zrange(
          occurrencesIndexKey(r.id),
          futureScoreMin,
          Number.MAX_SAFE_INTEGER,
          { byScore: true },
        );
        for (const dk of historyDateKeys) {
          pipeline.hgetall(occurrenceKey(r.id, dk));
        }
        const results = (await pipeline.exec()) as unknown[];

        const streakRaw = results[0] as string | number | null;
        const longestRaw = results[1] as string | number | null;
        const futureSkipKeysRaw = results[2] as string[] | null;
        const historyHashes = results.slice(3) as (Record<
          string,
          string
        > | null)[];

        const history: RitualHistoryEntry[] = historyDateKeys.map((dk, i) => {
          const hash = historyHashes[i];
          const submitted = !!hash && Object.keys(hash).length > 0;
          const skipped = submitted && !!hash?.skippedBy;
          return { dateKey: dk, submitted, skipped };
        });

        // Find owning date inside history. owningDateKey is guaranteed to
        // be in the last 1-2 entries (today / yesterday).
        const owningIndex = historyDateKeys.indexOf(todayInfo.owningDateKey);
        const owningHash = owningIndex >= 0 ? historyHashes[owningIndex] : null;

        const todaySubmission =
          owningHash && Object.keys(owningHash).length > 0
            ? hashToOccurrence(r.id, todayInfo.owningDateKey, owningHash)
            : null;

        const finalState: RitualTodayState = todaySubmission
          ? "completed_today"
          : todayInfo.state;

        return {
          ...r,
          todayState: finalState,
          owningDateKey: todayInfo.owningDateKey,
          windowOpensAtMs: todayInfo.bounds.opensAtMs,
          windowClosesAtMs: todayInfo.bounds.closesAtMs,
          currentStreak: Number(streakRaw ?? 0),
          longestStreak: Number(longestRaw ?? 0),
          todaySubmission,
          upcomingSkipDateKeys: futureSkipKeysRaw ?? [],
          history,
        } satisfies RitualWithToday;
      }),
    );

    enriched.sort((a, b) => {
      if (a.windowStart === b.windowStart) {
        return a.createdAt - b.createdAt;
      }
      return a.windowStart.localeCompare(b.windowStart);
    });

    return enriched;
  } catch (error) {
    logger.error("[rituals] Failed to fetch:", error);
    return [];
  }
}

/**
 * Returns the last `days` calendar days of submission status for a ritual,
 * oldest-first. Each entry is a date key + submitted/skipped flags. For the
 * dot-row UI.
 */
export async function getRitualHistory(
  id: string,
  days: number = HISTORY_DOT_ROW_DAYS,
): Promise<{ dateKey: string; submitted: boolean; skipped: boolean }[]> {
  try {
    const dateKeys: string[] = [];
    let cursor = todayKeyCairo();
    for (let i = 0; i < days; i += 1) {
      dateKeys.unshift(cursor);
      cursor = previousDateKey(cursor);
    }

    const pipeline = redis.pipeline();
    for (const k of dateKeys) {
      pipeline.hgetall(occurrenceKey(id, k));
    }
    const results = (await pipeline.exec()) as (Record<
      string,
      string
    > | null)[];

    return dateKeys.map((dateKey, i) => {
      const hash = results[i];
      const submitted = !!hash && Object.keys(hash).length > 0;
      const skipped = submitted && !!hash?.skippedBy;
      return { dateKey, submitted, skipped };
    });
  } catch (error) {
    logger.error("[rituals] Failed to fetch history:", error);
    return [];
  }
}

// ── Mutations ────────────────────────────────────────────────────────────────

/**
 * Shared form validator for create + update. Returns either a fully
 * normalized field set or a user-facing error message. Pure function —
 * no Redis, no session, no side effects.
 */
type ValidatedRitualFields = {
  title: string;
  description: string | undefined;
  owner: RitualOwner;
  cadence: RitualCadence;
  weekdays: number[] | undefined;
  everyNDays: number | undefined;
  windowStart: string;
  duration: number;
};

function validateRitualFormData(
  formData: FormData,
): ValidatedRitualFields | { error: string } {
  const title = (formData.get("title") as string)?.trim();
  const description = (formData.get("description") as string)?.trim() || "";
  const owner = formData.get("owner") as string;
  const cadence = (formData.get("cadence") as string) || "daily";
  const windowStartRaw = formData.get("windowStart") as string;
  const durationStr = formData.get("windowDurationMinutes") as string;

  if (!title) return { error: "Title is required." };
  if (owner !== "T7SEN" && owner !== "Besho")
    return { error: "Owner must be T7SEN or Besho." };
  if (!SUPPORTED_CADENCES.includes(cadence as RitualCadence))
    return { error: "Unsupported cadence." };

  const windowStart = parseAndNormalizeHHMM(windowStartRaw ?? "");
  if (!windowStart) return { error: "Window start must be HH:MM." };

  const duration = Number(durationStr);
  if (
    !Number.isFinite(duration) ||
    duration < MIN_WINDOW_DURATION_MINUTES ||
    duration > MAX_WINDOW_DURATION_MINUTES
  ) {
    return {
      error: `Duration must be ${MIN_WINDOW_DURATION_MINUTES}–${MAX_WINDOW_DURATION_MINUTES} minutes.`,
    };
  }

  let weekdays: number[] | undefined;
  let everyNDays: number | undefined;

  if (cadence === "weekly") {
    const raw = formData.getAll("weekdays").map(String);
    if (raw.length === 0) {
      return { error: "Select at least one day for weekly cadence." };
    }
    const parsed = raw.map((s) => Number(s));
    for (const w of parsed) {
      if (!Number.isInteger(w) || w < 0 || w > 6) {
        return { error: "Weekday values must be integers 0–6." };
      }
    }
    weekdays = Array.from(new Set(parsed)).sort((a, b) => a - b);
  } else if (cadence === "every_n_days") {
    const nRaw = formData.get("everyNDays") as string;
    const n = Number(nRaw);
    if (!Number.isInteger(n) || n < MIN_EVERY_N_DAYS || n > MAX_EVERY_N_DAYS) {
      return {
        error: `Every-N-days must be ${MIN_EVERY_N_DAYS}–${MAX_EVERY_N_DAYS}. Use daily for 1.`,
      };
    }
    everyNDays = n;
  }

  return {
    title,
    description: description || undefined,
    owner: owner as RitualOwner,
    cadence: cadence as RitualCadence,
    weekdays,
    everyNDays,
    windowStart,
    duration,
  };
}

/**
 * Returns true if two cadence configs differ enough that any persisted
 * streak counter under the old config is no longer meaningful.
 */
function cadenceConfigChanged(
  before: Pick<Ritual, "cadence" | "weekdays" | "everyNDays">,
  after: Pick<Ritual, "cadence" | "weekdays" | "everyNDays">,
): boolean {
  if (before.cadence !== after.cadence) return true;
  if (before.cadence === "weekly") {
    const a = (before.weekdays ?? [])
      .slice()
      .sort((x, y) => x - y)
      .join(",");
    const b = (after.weekdays ?? [])
      .slice()
      .sort((x, y) => x - y)
      .join(",");
    if (a !== b) return true;
  }
  if (before.cadence === "every_n_days") {
    if (before.everyNDays !== after.everyNDays) return true;
  }
  return false;
}

export async function createRitual(
  prevState: unknown,
  formData: FormData,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "T7SEN")
    return { error: "Only Sir can create rituals." };

  const validated = validateRitualFormData(formData);
  if ("error" in validated) return { error: validated.error };

  const createdAt = Date.now();
  const anchorDateKey = dateKeyInTz(createdAt);

  const ritual: Ritual = {
    id: crypto.randomUUID(),
    title: validated.title,
    ...(validated.description && { description: validated.description }),
    owner: validated.owner,
    cadence: validated.cadence,
    ...(validated.weekdays && { weekdays: validated.weekdays }),
    ...(validated.everyNDays && {
      everyNDays: validated.everyNDays,
      anchorDateKey,
    }),
    windowStart: validated.windowStart,
    windowDurationMinutes: validated.duration,
    createdAt,
    createdBy: session.author,
    active: true,
  };

  try {
    const pipeline = redis.pipeline();
    pipeline.set(ritualKey(ritual.id), ritual);
    pipeline.zadd(INDEX_KEY, { score: ritual.createdAt, member: ritual.id });
    await pipeline.exec();

    if (ritual.owner === "Besho") {
      await sendNotification("Besho", {
        title: "🕯️ New Ritual",
        body: `Sir set a new ritual: ${ritual.title}`,
        url: "/rituals",
      });
    }

    logger.interaction("[rituals] Ritual created", {
      id: ritual.id,
      title: ritual.title,
      owner: ritual.owner,
      cadence: ritual.cadence,
    });
    revalidatePath("/rituals");
    return { success: true };
  } catch (error) {
    logger.error("[rituals] Failed to create:", error);
    return { error: "Failed to save ritual." };
  }
}

/**
 * Edits an existing ritual. Sir-only. Preserves id / createdAt /
 * createdBy / active / pausedUntil. Resets the current streak counter
 * if cadence config changed (longest streak preserved as achievement).
 *
 * Reminder reconciliation on the client picks up windowStart changes
 * automatically because the page composes the reminder ID from
 * `idToNumeric(`${id}:${windowStart}`)`. Title/description changes do
 * NOT refresh already-scheduled reminder bodies (LocalNotifications
 * snapshots them at schedule time) — known Phase 2.5 limitation.
 */
export async function updateRitual(
  ritualId: string,
  prevState: unknown,
  formData: FormData,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "T7SEN")
    return { error: "Only Sir can edit rituals." };

  if (!ritualId) return { error: "Missing ritualId." };

  const validated = validateRitualFormData(formData);
  if ("error" in validated) return { error: validated.error };

  try {
    const existing = await redis.get<Ritual>(ritualKey(ritualId));
    if (!existing) return { error: "Ritual not found." };

    // Preserve anchor when staying within every_n_days; recompute when
    // entering every_n_days from another cadence.
    const anchorDateKey =
      validated.cadence === "every_n_days"
        ? existing.cadence === "every_n_days" && existing.anchorDateKey
          ? existing.anchorDateKey
          : todayKeyCairo()
        : undefined;

    const updated: Ritual = {
      // Immutable fields preserved from existing.
      id: existing.id,
      createdAt: existing.createdAt,
      createdBy: existing.createdBy,
      active: existing.active,
      ...(existing.pausedUntil ? { pausedUntil: existing.pausedUntil } : {}),

      // Editable fields from validated input.
      title: validated.title,
      ...(validated.description && { description: validated.description }),
      owner: validated.owner,
      cadence: validated.cadence,
      ...(validated.weekdays && { weekdays: validated.weekdays }),
      ...(validated.everyNDays && {
        everyNDays: validated.everyNDays,
        anchorDateKey,
      }),
      windowStart: validated.windowStart,
      windowDurationMinutes: validated.duration,
      updatedAt: Date.now(),
    };

    const cadenceChanged = cadenceConfigChanged(existing, updated);

    const pipeline = redis.pipeline();
    pipeline.set(ritualKey(ritualId), updated);
    if (cadenceChanged) {
      // Reset current streak — the meaning of "consecutive prescribed
      // days" is no longer the same. Preserve longest as achievement.
      pipeline.del(streakKey(ritualId));
    }
    await pipeline.exec();

    if (updated.owner === "Besho") {
      await sendNotification("Besho", {
        title: "✏️ Ritual Updated",
        body: `Sir updated: ${updated.title}`,
        url: "/rituals",
      });
    }

    logger.interaction("[rituals] Ritual updated", {
      id: ritualId,
      title: updated.title,
      cadenceChanged,
    });
    revalidatePath("/rituals");
    return { success: true };
  } catch (error) {
    logger.error("[rituals] Failed to update:", error);
    return { error: "Failed to update ritual." };
  }
}

export async function submitOccurrence(
  prevState: unknown,
  formData: FormData,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };

  const block = await assertWriteAllowed(session.author);
  if (block) return block;

  const ritualId = formData.get("ritualId") as string;
  const text = ((formData.get("text") as string) ?? "").trim();

  if (!ritualId) return { error: "Missing ritualId." };
  if (text.length === 0) return { error: "Submission text is required." };
  if (text.length > MAX_SUBMISSION_TEXT_LENGTH) {
    return {
      error: `Submission too long (${MAX_SUBMISSION_TEXT_LENGTH} max).`,
    };
  }

  try {
    const ritual = await redis.get<Ritual>(ritualKey(ritualId));
    if (!ritual) return { error: "Ritual not found." };
    if (!ritual.active) return { error: "Ritual is inactive." };
    if (ritual.pausedUntil && Date.now() < ritual.pausedUntil) {
      return { error: "Ritual is paused." };
    }
    if (ritual.owner !== session.author) {
      return { error: "Only the ritual owner can submit." };
    }

    const now = Date.now();
    const cadenceConfig: CadenceConfig = {
      cadence: ritual.cadence,
      weekdays: ritual.weekdays,
      everyNDays: ritual.everyNDays,
      anchorDateKey: ritual.anchorDateKey,
    };
    const todayInfo = computeRitualTodayState({
      active: ritual.active,
      pausedUntilMs: ritual.pausedUntil ?? null,
      cadence: ritual.cadence,
      weekdays: ritual.weekdays,
      everyNDays: ritual.everyNDays,
      anchorDateKey: ritual.anchorDateKey,
      windowStart: ritual.windowStart,
      durationMinutes: ritual.windowDurationMinutes,
      now,
      hasOccurrenceForOwningDate: () => false,
    });
    if (todayInfo.state !== "open") {
      return {
        error:
          todayInfo.state === "upcoming"
            ? "Window has not opened yet."
            : todayInfo.state === "not_prescribed_today"
              ? "Today is not a prescribed day for this ritual."
              : "Window has closed for this ritual.",
      };
    }

    const dateKey = todayInfo.owningDateKey;

    // Idempotency — reject duplicate submission for the same owning date.
    const existing = await redis.hgetall<Record<string, string>>(
      occurrenceKey(ritualId, dateKey),
    );
    if (existing && Object.keys(existing).length > 0) {
      return { error: "Already submitted for this window." };
    }

    // Compute the new streak by walking back from today through the ZSET.
    const recentKeys = await collectRecentDateKeys(ritualId, dateKey, 365);
    recentKeys.add(dateKey);
    const sortedAsc = Array.from(recentKeys).sort();
    const newStreak = computeStreak(cadenceConfig, sortedAsc, dateKey);

    const previousLongestRaw = await redis.get<string | number>(
      longestStreakKey(ritualId),
    );
    const previousLongest = Number(previousLongestRaw ?? 0);

    const writePipeline = redis.pipeline();
    writePipeline.hset(occurrenceKey(ritualId, dateKey), {
      ritualId,
      dateKey,
      submittedAt: String(now),
      text,
    });
    writePipeline.zadd(occurrencesIndexKey(ritualId), {
      score: tzWallClockToUtcMs(dateKey, "00:00"),
      member: dateKey,
    });
    writePipeline.set(streakKey(ritualId), String(newStreak));
    if (newStreak > previousLongest) {
      writePipeline.set(longestStreakKey(ritualId), String(newStreak));
    }
    await writePipeline.exec();

    // Obedience emit — Besho-owned rituals only. Submitting INSIDE the
    // window means on-time (the action rejects out-of-window submits
    // already, so reaching here is sufficient). Member-key dedup uses
    // `${ritualId}:${dateKey}` so retries within the same window
    // overwrite rather than double-credit.
    if (ritual.owner === "Besho") {
      void recordObedienceEvent(
        "Besho",
        "ritual_on_time",
        `${ritualId}:${dateKey}`,
        now,
      );
    }

    const partner: RitualOwner = session.author === "T7SEN" ? "Besho" : "T7SEN";
    await sendNotification(partner, {
      title: "✓ Ritual Submitted",
      body: `${ritual.title} — ${text.slice(0, 80)}${text.length > 80 ? "…" : ""}`,
      url: "/rituals",
    });

    logger.interaction("[rituals] Occurrence submitted", {
      ritualId,
      dateKey,
      by: session.author,
      newStreak,
    });
    revalidatePath("/rituals");
    revalidatePath("/"); // nav badge depends on this
    return { success: true };
  } catch (error) {
    logger.error("[rituals] Failed to submit:", error);
    return { error: "Failed to submit." };
  }
}

export async function pauseRitual(
  id: string,
  pausedUntilMs?: number,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "T7SEN")
    return { error: "Only Sir can pause rituals." };

  try {
    const existing = await redis.get<Ritual>(ritualKey(id));
    if (!existing) return { error: "Ritual not found." };

    const updated: Ritual = {
      ...existing,
      pausedUntil: pausedUntilMs ?? Date.now() + 30 * 24 * 3_600_000,
    };
    await redis.set(ritualKey(id), updated);

    if (existing.owner === "Besho") {
      await sendNotification("Besho", {
        title: "⏸️ Ritual Paused",
        body: `Sir paused: ${existing.title}`,
        url: "/rituals",
      });
    }

    logger.interaction("[rituals] Ritual paused", { id });
    revalidatePath("/rituals");
    return { success: true };
  } catch (error) {
    logger.error("[rituals] Failed to pause:", error);
    return { error: "Failed to pause." };
  }
}

export async function resumeRitual(
  id: string,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "T7SEN")
    return { error: "Only Sir can resume rituals." };

  try {
    const existing = await redis.get<Ritual>(ritualKey(id));
    if (!existing) return { error: "Ritual not found." };

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { pausedUntil: _removed, ...rest } = existing;
    const updated: Ritual = { ...rest };
    await redis.set(ritualKey(id), updated);

    if (existing.owner === "Besho") {
      await sendNotification("Besho", {
        title: "▶️ Ritual Resumed",
        body: `Sir resumed: ${existing.title}`,
        url: "/rituals",
      });
    }

    logger.interaction("[rituals] Ritual resumed", { id });
    revalidatePath("/rituals");
    return { success: true };
  } catch (error) {
    logger.error("[rituals] Failed to resume:", error);
    return { error: "Failed to resume." };
  }
}

export async function grantSkipDay(
  id: string,
  dateKey: string,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "T7SEN")
    return { error: "Only Sir can grant skip days." };

  try {
    const ritual = await redis.get<Ritual>(ritualKey(id));
    if (!ritual) return { error: "Ritual not found." };

    // Refuse to overwrite an existing real submission.
    const existing = await redis.hgetall<Record<string, string>>(
      occurrenceKey(id, dateKey),
    );
    if (existing && existing.text && !existing.skippedBy) {
      return { error: "A real submission already exists for that date." };
    }

    const writePipeline = redis.pipeline();
    writePipeline.hset(occurrenceKey(id, dateKey), {
      ritualId: id,
      dateKey,
      submittedAt: String(Date.now()),
      text: "",
      skippedBy: session.author,
    });
    writePipeline.zadd(occurrencesIndexKey(id), {
      score: tzWallClockToUtcMs(dateKey, "00:00"),
      member: dateKey,
    });
    await writePipeline.exec();

    if (ritual.owner === "Besho") {
      await sendNotification("Besho", {
        title: "🕊️ Skip Day Granted",
        body: `Sir granted you a skip on: ${ritual.title}`,
        url: "/rituals",
      });
    }

    logger.interaction("[rituals] Skip day granted", { id, dateKey });
    revalidatePath("/rituals");
    return { success: true };
  } catch (error) {
    logger.error("[rituals] Failed to grant skip:", error);
    return { error: "Failed to grant skip." };
  }
}

export async function deleteRitual(
  id: string,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "T7SEN")
    return { error: "Only Sir can delete rituals." };

  try {
    const existing = await redis.get<Ritual>(ritualKey(id));
    if (existing) {
      const score = await redis.zscore(INDEX_KEY, id);
      await moveToTrash(redis, {
        feature: "rituals",
        id,
        label: existing.title,
        deletedBy: session.author,
        payload: existing,
        indexScore:
          typeof score === "number"
            ? score
            : Number(score) || existing.createdAt,
        recordKey: ritualKey(id),
        indexKey: INDEX_KEY,
      });
    }

    const dateKeys = (await redis.zrange(
      occurrencesIndexKey(id),
      0,
      -1,
    )) as string[];

    const pipeline = redis.pipeline();
    pipeline.del(ritualKey(id));
    pipeline.zrem(INDEX_KEY, id);
    pipeline.del(streakKey(id));
    pipeline.del(longestStreakKey(id));
    pipeline.del(occurrencesIndexKey(id));
    for (const dk of dateKeys) {
      pipeline.del(occurrenceKey(id, dk));
    }
    await pipeline.exec();

    logger.interaction("[rituals] Ritual deleted", { id });
    revalidatePath("/rituals");
    return { success: true };
  } catch (error) {
    logger.error("[rituals] Failed to delete:", error);
    return { error: "Failed to delete." };
  }
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function hashToOccurrence(
  ritualId: string,
  dateKey: string,
  hash: Record<string, string>,
): RitualOccurrence {
  return {
    ritualId,
    dateKey,
    submittedAt: Number(hash.submittedAt ?? 0),
    text: hash.text ?? "",
    ...(hash.skippedBy ? { skippedBy: hash.skippedBy as RitualOwner } : {}),
  };
}

/**
 * Returns up to `limit` most recent date keys (≤ `beforeOrEqual`) with
 * submissions for a ritual, walking the occurrences ZSET newest-first.
 */
async function collectRecentDateKeys(
  ritualId: string,
  beforeOrEqual: string,
  limit: number,
): Promise<Set<string>> {
  const all = (await redis.zrange(occurrencesIndexKey(ritualId), 0, -1, {
    rev: true,
  })) as string[];
  const set = new Set<string>();
  for (const k of all) {
    if (k <= beforeOrEqual) {
      set.add(k);
      if (set.size >= limit) break;
    }
  }
  return set;
}

// ─── Sir-only destructive ─────────────────────────────────────────────────────

export async function purgeAllRituals(): Promise<{
  success?: boolean;
  error?: string;
  deletedCount?: number;
}> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "T7SEN")
    return { error: "Only Sir can purge rituals." };

  try {
    const raw =
      ((await redis.zrange<(string | number)[]>(INDEX_KEY, 0, -1, {
        withScores: true,
      })) as (string | number)[]) ?? [];
    const pairs: { id: string; score: number }[] = [];
    for (let i = 0; i < raw.length; i += 2) {
      pairs.push({ id: String(raw[i]), score: Number(raw[i + 1]) || 0 });
    }
    const ids = pairs.map((p) => p.id);

    if (ids.length > 0) {
      const records =
        (await redis.mget<Ritual[]>(...ids.map(ritualKey))) ?? [];
      await moveManyToTrash(
        redis,
        pairs.map((p, i) => {
          const r = records[i];
          return {
            feature: "rituals" as const,
            id: p.id,
            label: r?.title ?? p.id,
            deletedBy: session.author,
            payload: r ?? null,
            indexScore: p.score,
            recordKey: ritualKey(p.id),
            indexKey: INDEX_KEY,
          };
        }),
      );
    }

    const allOccurrenceDateKeys: { ritualId: string; dateKey: string }[] = [];
    for (const id of ids) {
      const dks = (await redis.zrange(
        occurrencesIndexKey(id),
        0,
        -1,
      )) as string[];
      for (const dk of dks) {
        allOccurrenceDateKeys.push({ ritualId: id, dateKey: dk });
      }
    }

    const pipeline = redis.pipeline();
    for (const id of ids) {
      pipeline.del(ritualKey(id));
      pipeline.del(streakKey(id));
      pipeline.del(longestStreakKey(id));
      pipeline.del(occurrencesIndexKey(id));
    }
    for (const { ritualId, dateKey } of allOccurrenceDateKeys) {
      pipeline.del(occurrenceKey(ritualId, dateKey));
    }
    pipeline.del(INDEX_KEY);
    if (ids.length > 0) await pipeline.exec();

    revalidatePath("/rituals");
    logger.warn(
      `[rituals] Sir purged ${ids.length} rituals + ${allOccurrenceDateKeys.length} occurrences.`,
    );
    return { success: true, deletedCount: ids.length };
  } catch (err) {
    logger.error("[rituals] purgeAllRituals failed:", err);
    return { error: "Purge failed." };
  }
}
