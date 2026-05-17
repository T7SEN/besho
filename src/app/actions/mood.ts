// src/app/actions/mood.ts
"use server";

import { redis } from "@/lib/redis";
import { cookies } from "next/headers";
import { decrypt } from "@/lib/auth-utils";
import { addDaysCairo, todayKeyCairo } from "@/lib/cairo-time";
import { sendNotification } from "@/app/actions/notifications";
import { logger } from "@/lib/logger";
import { assertWriteAllowed } from "@/lib/restraint";
import { recordObedienceEvent } from "@/lib/obedience";

export interface MoodData {
  myMood: string | null;
  partnerMood: string | null;
  myState: string | null;
  partnerState: string | null;
  myHugSent: boolean;
  hugReceivedFrom: string | null;
}

export interface MoodHistoryEntry {
  date: string; // 'YYYY-MM-DD'
  myMood: string | null;
  partnerMood: string | null;
  myState: string | null;
  partnerState: string | null;
}

// Mood, state, and hug keys persist permanently. The previous 7-day TTL
// was vestigial — at two-user scale, storage cost is invisible (≈2,200
// keys/year), and a permanent record unblocks /review historical
// browsing beyond 7 days back, plus future longitudinal views. The
// "daily reset" semantics come from the date being part of the key,
// not from expiry.

const moodKey = (date: string, author: string) => `mood:${date}:${author}`;
const stateKey = (date: string, author: string) => `state:${date}:${author}`;
const hugKey = (date: string, from: string) => `mood:hug:${date}:${from}`;

async function getSession() {
  const cookieStore = await cookies();
  const value = cookieStore.get("session")?.value;
  if (!value) return null;
  return decrypt(value);
}

export async function getTodayMoods(): Promise<MoodData> {
  const session = await getSession();
  if (!session?.author) {
    return {
      myMood: null,
      partnerMood: null,
      myState: null,
      partnerState: null,
      myHugSent: false,
      hugReceivedFrom: null,
    };
  }

  const author = session.author as "T7SEN" | "Besho";
  const partner = author === "T7SEN" ? "Besho" : "T7SEN";
  const today = todayKeyCairo();

  // Single MGET — 6 STRING keys in one Redis command (was 6 GETs via
  // Promise.all). Folded in the Redis-cost audit; mirrors the mget
  // pattern in getMoodHistory below.
  const [
    myMood,
    partnerMood,
    myState,
    partnerState,
    myHugSent,
    partnerHugSent,
  ] = await redis.mget<(string | null)[]>(
    moodKey(today, author),
    moodKey(today, partner),
    stateKey(today, author),
    stateKey(today, partner),
    hugKey(today, author),
    hugKey(today, partner),
  );

  return {
    myMood: myMood ?? null,
    partnerMood: partnerMood ?? null,
    myState: myState ?? null,
    partnerState: partnerState ?? null,
    myHugSent: myHugSent === "1",
    hugReceivedFrom: partnerHugSent === "1" ? partner : null,
  };
}

/**
 * Direct-call action — caller invokes as `submitMood(emoji)`. Not a
 * `useActionState` form action. Returns `{ success?, error? }` per
 * the codebase action contract.
 */
export async function submitMood(
  mood: string,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };

  const block = await assertWriteAllowed(session.author);
  if (block) return block;

  const trimmed = mood?.trim();
  if (!trimmed) return { error: "Mood is required." };

  try {
    const author = session.author as "T7SEN" | "Besho";
    const today = todayKeyCairo();

    await redis.set(moodKey(today, author), trimmed);

    // Obedience: +1 mood check-in per day (Besho only). Member-key
    // dedup by date — multiple mood updates on the same day still
    // credit only once. State submissions are intentionally NOT scored
    // (per user spec: state remains a free expressive surface).
    if (author === "Besho") {
      void recordObedienceEvent("Besho", "mood_checkin", `mood:${today}`);
    }

    logger.interaction("[mood] Mood set", { author, mood: trimmed });
    return { success: true };
  } catch (error) {
    logger.error("[mood] Failed to set mood:", error);
    return { error: "Failed to set mood." };
  }
}

/**
 * Direct-call action — caller invokes as `submitState(value)`. Not a
 * form action.
 */
export async function submitState(
  value: string,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };

  const block = await assertWriteAllowed(session.author);
  if (block) return block;

  const trimmed = value?.trim();
  if (!trimmed) return { error: "State is required." };

  try {
    const author = session.author as "T7SEN" | "Besho";
    const today = todayKeyCairo();

    await redis.set(stateKey(today, author), trimmed);

    logger.interaction("[mood] State set", { author, state: trimmed });
    return { success: true };
  } catch (error) {
    logger.error("[mood] Failed to set state:", error);
    return { error: "Failed to set state." };
  }
}

export async function sendHug(): Promise<{
  success?: boolean;
  error?: string;
}> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };

  const block = await assertWriteAllowed(session.author);
  if (block) return block;

  try {
    const author = session.author as "T7SEN" | "Besho";
    const partner = author === "T7SEN" ? "Besho" : "T7SEN";
    const today = todayKeyCairo();

    await redis.set(hugKey(today, author), "1");

    await sendNotification(partner, {
      title: "🤗 Hug",
      body: `${author} sent you a hug`,
      url: "/",
    });

    logger.interaction("[mood] Hug sent", { from: author, to: partner });
    return { success: true };
  } catch (error) {
    logger.error("[mood] Failed to send hug:", error);
    return { error: "Failed to send hug." };
  }
}

/**
 * Returns the last `days` days of mood + state data for both users,
 * oldest entry first. Reads up to `days × 4` Redis keys in a single
 * mget call — no N+1.
 *
 * Now that mood keys persist permanently, callers can request
 * arbitrary historical depth (e.g., `getMoodHistory(30)` for a
 * monthly view, or `getMoodHistory(365)` for a yearly grid). Days
 * with no logged mood naturally return null per cell.
 */
export async function getMoodHistory(days = 7): Promise<MoodHistoryEntry[]> {
  const session = await getSession();
  if (!session?.author) return [];

  const author = session.author as "T7SEN" | "Besho";
  const partner = author === "T7SEN" ? "Besho" : "T7SEN";

  const today = todayKeyCairo();
  // Build date strings oldest → newest (today is last).
  const dateStrings = Array.from({ length: days }, (_, i) =>
    addDaysCairo(today, -(days - 1 - i)),
  );

  // Flatten all keys: [myMood, partnerMood, myState, partnerState] × days
  const keys = dateStrings.flatMap((date) => [
    moodKey(date, author),
    moodKey(date, partner),
    stateKey(date, author),
    stateKey(date, partner),
  ]);

  const values = await redis.mget<(string | null)[]>(...keys);

  return dateStrings.map((date, i) => ({
    date,
    myMood: values[i * 4] ?? null,
    partnerMood: values[i * 4 + 1] ?? null,
    myState: values[i * 4 + 2] ?? null,
    partnerState: values[i * 4 + 3] ?? null,
  }));
}
