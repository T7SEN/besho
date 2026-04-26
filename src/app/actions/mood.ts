"use server";

import { Redis } from "@upstash/redis";
import { cookies } from "next/headers";
import { decrypt } from "@/lib/auth-utils";
import { MY_TZ } from "@/lib/constants";

export interface MoodData {
  myMood: string | null;
  partnerMood: string | null;
  myHugSent: boolean;
  hugReceivedFrom: string | null;
}

const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

// ── Key helpers ───────────────────────────────────────────────────────────────

function todayInCairo(): string {
  // Returns YYYY-MM-DD in Cairo local time
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
const hugKey = (date: string, from: string) => `mood:hug:${date}:${from}`;

// ── Session helper ────────────────────────────────────────────────────────────

async function getSession() {
  const cookieStore = await cookies();
  const value = cookieStore.get("session")?.value;
  if (!value) return null;
  return decrypt(value);
}

// ── Actions ───────────────────────────────────────────────────────────────────

export async function getTodayMoods(): Promise<MoodData> {
  const session = await getSession();
  if (!session?.author) {
    return {
      myMood: null,
      partnerMood: null,
      myHugSent: false,
      hugReceivedFrom: null,
    };
  }

  const author = session.author as "T7SEN" | "Besho";
  const partner = author === "T7SEN" ? "Besho" : "T7SEN";
  const today = todayInCairo();

  const [myMood, partnerMood, myHugSent, partnerHugSent] = await Promise.all([
    redis.get<string>(moodKey(today, author)),
    redis.get<string>(moodKey(today, partner)),
    redis.get<string>(hugKey(today, author)),
    redis.get<string>(hugKey(today, partner)),
  ]);

  return {
    myMood: myMood ?? null,
    partnerMood: partnerMood ?? null,
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
    // Check both moods exist before allowing hug
    const [myMood, partnerMood] = await Promise.all([
      redis.get<string>(moodKey(today, author)),
      redis.get<string>(moodKey(today, partner)),
    ]);

    if (!myMood || !partnerMood) {
      return { error: "Both of you need to log a mood first." };
    }

    await redis.set(hugKey(today, author), "1", { ex: ttl });

    // Fire-and-forget push to partner
    sendHugPush(partner, author).catch(console.error);

    return { success: true };
  } catch (error) {
    console.error("[mood] Failed to send hug:", error);
    return { error: "Failed to send hug." };
  }
}

async function sendHugPush(to: string, from: string): Promise<void> {
  try {
    const subscription = await redis.get(`push:subscription:${to}`);
    if (!subscription) return;

    const currentPage = await redis.get<string>(`presence:${to}`);
    if (currentPage === "/") {
      console.log(`[push] Skipping hug push — ${to} is on dashboard.`);
      return;
    }

    const webpush = (await import("web-push")).default;
    webpush.setVapidDetails(
      process.env.VAPID_EMAIL!,
      process.env.VAPID_PUBLIC_KEY!,
      process.env.VAPID_PRIVATE_KEY!,
    );

    await webpush.sendNotification(
      subscription as Parameters<typeof webpush.sendNotification>[0],
      JSON.stringify({
        title: "💝 Virtual Hug!",
        body: `${from} sent you a hug`,
        url: "/",
      }),
    );
  } catch (error) {
    console.error("[mood] Push failed:", error);
  }
}
