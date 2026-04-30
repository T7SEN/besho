"use server";

import { Redis } from "@upstash/redis";
import { cookies } from "next/headers";
import { decrypt } from "@/lib/auth-utils";
import { pushNotificationToHistory } from "@/app/actions/notifications";
import { logger } from "@/lib/logger";

const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

const COOLDOWN_SECONDS = 300; // 5 minutes
const cooldownKey = (author: string) => `safeword:cooldown:${author}`;

async function getSession() {
  const cookieStore = await cookies();
  const value = cookieStore.get("session")?.value;
  if (!value) return null;
  return decrypt(value);
}

const HISTORY_KEY = "safeword:history";
const MAX_HISTORY_ENTRIES = 50;

export interface SafeWordEvent {
  timestamp: number;
  triggeredBy: string;
}

/**
 * Appends a safe-word event to the persistent history list.
 * Called internally from triggerSafeWord — not exported.
 */
async function recordSafeWordEvent(author: string): Promise<void> {
  const event: SafeWordEvent = {
    timestamp: Date.now(),
    triggeredBy: author,
  };
  const pipeline = redis.pipeline();
  pipeline.lpush(HISTORY_KEY, event);
  pipeline.ltrim(HISTORY_KEY, 0, MAX_HISTORY_ENTRIES - 1);
  await pipeline.exec();
}

/**
 * Returns the full safe-word activation history.
 * Restricted to T7SEN only.
 */
export async function getSafeWordHistory(): Promise<SafeWordEvent[]> {
  const session = await getSession();
  if (session?.author !== "T7SEN") return [];

  try {
    const events = await redis.lrange<SafeWordEvent>(
      HISTORY_KEY,
      0,
      MAX_HISTORY_ENTRIES - 1,
    );
    return events ?? [];
  } catch {
    return [];
  }
}

export async function triggerSafeWord(): Promise<{
  success?: boolean;
  cooldown?: number;
  error?: string;
}> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };

  const author = session.author as "T7SEN" | "Besho";
  const dom = "T7SEN"; // Always notifies T7SEN

  // ── Cooldown check ────────────────────────────────────────────────────────
  const existing = await redis.get<number>(cooldownKey(author));
  if (existing) {
    const ttl = await redis.ttl(cooldownKey(author));
    return { cooldown: ttl };
  }

  // Set cooldown
  await redis.set(cooldownKey(author), 1, { ex: COOLDOWN_SECONDS });
  await recordSafeWordEvent(author);
  logger.interaction("[safeword] Safe word triggered", { by: author });

  const payload = {
    title: "🔴 Safe Word",
    body: `${author} needs you. Stop everything.`,
    url: "/dashboard",
  };

  // ── Write to history ──────────────────────────────────────────────────────
  try {
    await pushNotificationToHistory(dom, {
      ...payload,
      timestamp: Date.now(),
    });
  } catch (err) {
    logger.error("[safeword] Failed to write history:", err);
  }

  // ── FCM — ALWAYS send, bypass ALL presence checks ─────────────────────────
  const fcmToken = await redis.get<string>(`push:fcm:${dom}`);
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

      // Always send as full notification — no data-only, no presence skip
      await getMessaging().send({
        token: fcmToken,
        notification: {
          title: payload.title,
          body: payload.body,
        },
        data: { url: payload.url },
        android: {
          priority: "high",
          notification: {
            sound: "default",
            priority: "max",
            channelId: "safeword",
          },
        },
      });

      logger.info("[safeword] FCM sent to", { dom });
      return { success: true };
    } catch (err) {
      logger.error("[safeword] FCM failed:", err);
    }
  }

  // ── Web Push fallback ─────────────────────────────────────────────────────
  const subscription = await redis.get(`push:subscription:${dom}`);
  if (subscription) {
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
    } catch (err) {
      logger.error("[safeword] Web Push failed:", err);
    }
  }

  return { success: true };
}

export async function getSafeWordCooldown(): Promise<number> {
  const session = await getSession();
  if (!session?.author) return 0;
  const ttl = await redis.ttl(cooldownKey(session.author));
  return Math.max(0, ttl);
}
