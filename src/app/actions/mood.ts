"use server";

import { Redis } from "@upstash/redis";
import { cookies } from "next/headers";
import { decrypt } from "@/lib/auth-utils";
import { MY_TZ } from "@/lib/constants";
import { pushNotificationToHistory } from "@/app/actions/notifications";
import { logger } from "@/lib/logger";

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

const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

// Mood and state keys persist for 7 days so getMoodHistory
// can query past dates. The daily-reset behaviour is unaffected
// because getTodayMoods reads today's date-scoped key only.
const MOOD_RETENTION_TTL = 7 * 24 * 60 * 60; // 7 days in seconds

function todayInCairo(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: MY_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function secondsUntilMidnight(): number {
  const cairoNow = new Date(
    new Date().toLocaleString("en-US", { timeZone: MY_TZ }),
  );
  const midnight = new Date(cairoNow);
  midnight.setHours(24, 0, 0, 0);
  return Math.max(
    60,
    Math.floor((midnight.getTime() - cairoNow.getTime()) / 1000),
  );
}

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
  const today = todayInCairo();

  const [
    myMood,
    partnerMood,
    myState,
    partnerState,
    myHugSent,
    partnerHugSent,
  ] = await Promise.all([
    redis.get<string>(moodKey(today, author)),
    redis.get<string>(moodKey(today, partner)),
    redis.get<string>(stateKey(today, author)),
    redis.get<string>(stateKey(today, partner)),
    redis.get<string>(hugKey(today, author)),
    redis.get<string>(hugKey(today, partner)),
  ]);

  return {
    myMood: myMood ?? null,
    partnerMood: partnerMood ?? null,
    myState: myState ?? null,
    partnerState: partnerState ?? null,
    myHugSent: myHugSent === "1",
    hugReceivedFrom: partnerHugSent === "1" ? partner : null,
  };
}

export async function submitMood(
  emoji: string,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };

  const VALID_EMOJIS = [
    "😴",
    "😊",
    "😍",
    "🥺",
    "😤",
    "🥰",
    "😂",
    "🌟",
    "😌",
    "🤗",
  ];
  if (!VALID_EMOJIS.includes(emoji)) return { error: "Invalid emoji." };

  const today = todayInCairo();

  try {
    await redis.set(moodKey(today, session.author), emoji, {
      ex: MOOD_RETENTION_TTL,
    });
    logger.interaction("[mood] Mood submitted", {
      author: session.author,
      emoji,
    });
    return { success: true };
  } catch (error) {
    logger.error("[mood] Failed to submit mood:", error);
    return { error: "Failed to save mood." };
  }
}

export async function submitState(
  emoji: string,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };

  const today = todayInCairo();

  try {
    await redis.set(stateKey(today, session.author), emoji, {
      ex: MOOD_RETENTION_TTL,
    });
    logger.interaction("[mood] State submitted", {
      author: session.author,
      emoji,
    });
    return { success: true };
  } catch (error) {
    logger.error("[mood] Failed to submit state:", error);
    return { error: "Failed to save state." };
  }
}

export async function sendHug(): Promise<{
  success?: boolean;
  error?: string;
}> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };

  const author = session.author as "T7SEN" | "Besho";
  const partner = author === "T7SEN" ? "Besho" : "T7SEN";
  const today = todayInCairo();
  const ttl = secondsUntilMidnight();

  try {
    const [myMood, partnerMood] = await Promise.all([
      redis.get<string>(moodKey(today, author)),
      redis.get<string>(moodKey(today, partner)),
    ]);

    if (!myMood || !partnerMood) {
      return { error: "Both of you need to log a mood first." };
    }

    await redis.set(hugKey(today, author), "1", { ex: ttl });
    await sendHugPush(partner, author);

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
 * mget call — no N+1. Keys must still exist (MOOD_RETENTION_TTL
 * guarantees they do for 7 days after submission).
 */
export async function getMoodHistory(days = 7): Promise<MoodHistoryEntry[]> {
  const session = await getSession();
  if (!session?.author) return [];

  const author = session.author as "T7SEN" | "Besho";
  const partner = author === "T7SEN" ? "Besho" : "T7SEN";

  // Build date strings oldest → newest (today is last)
  const dateStrings = Array.from({ length: days }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (days - 1 - i));
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: MY_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  });

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

async function sendHugPush(to: string, from: string): Promise<void> {
  const payload = {
    title: "💝 Virtual Hug!",
    body: `${from} sent you a hug`,
    url: "/",
  };

  let currentPage: string | null = null;
  try {
    const presenceRaw = await redis.get<string>(`presence:${to}`);
    if (presenceRaw) {
      try {
        const { page, ts } = JSON.parse(presenceRaw) as {
          page: string;
          ts: number;
        };
        if (Date.now() - ts < 9_000) {
          currentPage = page;
        }
      } catch {
        currentPage = presenceRaw;
      }
    }
  } catch {
    /* proceed */
  }

  try {
    await pushNotificationToHistory(to, {
      ...payload,
      timestamp: Date.now(),
    });
  } catch (err) {
    logger.error("[push] Failed to write hug notification history:", err);
  }

  const isAppOpen = currentPage !== null;

  const fcmToken = await redis.get<string>(`push:fcm:${to}`);
  if (fcmToken) {
    try {
      const { getApps, initializeApp, cert } =
        await import("firebase-admin/app");
      const { getMessaging } = await import("firebase-admin/messaging");

      if (!getApps().length) {
        initializeApp({
          credential: cert({
            projectId: process.env.FIREBASE_PROJECT_ID!,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL!,
            privateKey: process.env.FIREBASE_PRIVATE_KEY!.replace(/\\n/g, "\n"),
          }),
        });
      }

      await getMessaging().send({
        token: fcmToken,
        ...(isAppOpen
          ? {
              data: {
                url: payload.url,
                title: payload.title,
                body: payload.body,
              },
            }
          : {
              notification: {
                title: payload.title,
                body: payload.body,
              },
              data: { url: payload.url },
              android: { priority: "high" },
            }),
      });

      logger.info(`[push] Hug FCM sent to ${to}.`);
      return;
    } catch (err) {
      logger.error("[push] Hug FCM failed:", err);
    }
  }

  const subscription = await redis.get(`push:subscription:${to}`);
  if (!subscription) return;

  try {
    const webpush = (await import("web-push")).default;
    webpush.setVapidDetails(
      process.env.VAPID_EMAIL!,
      process.env.VAPID_PUBLIC_KEY!,
      process.env.VAPID_PRIVATE_KEY!,
    );

    await webpush.sendNotification(
      subscription as Parameters<typeof webpush.sendNotification>[0],
      JSON.stringify(payload),
    );
  } catch (error) {
    logger.error("[mood] Web Push failed:", error);
  }
}
