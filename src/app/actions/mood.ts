"use server";

import { Redis } from "@upstash/redis";
import { cookies } from "next/headers";
import { decrypt } from "@/lib/auth-utils";
import { MY_TZ } from "@/lib/constants";
import { pushNotificationToHistory } from "@/app/actions/notifications";

export interface MoodData {
  myMood: string | null;
  partnerMood: string | null;
  myState: string | null;
  partnerState: string | null;
  myHugSent: boolean;
  hugReceivedFrom: string | null;
}

const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

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
  const ttl = secondsUntilMidnight();

  try {
    await redis.set(moodKey(today, session.author), emoji, { ex: ttl });
    return { success: true };
  } catch (error) {
    console.error("[mood] Failed to submit mood:", error);
    return { error: "Failed to save mood." };
  }
}

export async function submitState(
  emoji: string,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };

  const today = todayInCairo();
  const ttl = secondsUntilMidnight();

  try {
    await redis.set(stateKey(today, session.author), emoji, { ex: ttl });
    return { success: true };
  } catch (error) {
    console.error("[mood] Failed to submit state:", error);
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

    return { success: true };
  } catch (error) {
    console.error("[mood] Failed to send hug:", error);
    return { error: "Failed to send hug." };
  }
}

async function sendHugPush(to: string, from: string): Promise<void> {
  const payload = {
    title: "💝 Virtual Hug!",
    body: `${from} sent you a hug`,
    url: "/",
  };

  let currentPage: string | null = null;
  try {
    currentPage = await redis.get<string>(`presence:${to}`);
  } catch {
    /* proceed */
  }

  try {
    await pushNotificationToHistory(to, {
      ...payload,
      timestamp: Date.now(),
    });
  } catch (err) {
    console.error("[push] Failed to write hug notification history:", err);
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

      console.log(`[push] Hug FCM sent to ${to}.`);
      return;
    } catch (err) {
      console.error("[push] Hug FCM failed:", err);
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
    console.error("[mood] Web Push failed:", error);
  }
}
