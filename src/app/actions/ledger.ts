"use server";

import { Redis } from "@upstash/redis";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { decrypt } from "@/lib/auth-utils";
import { pushNotificationToHistory } from "@/app/actions/notifications";
import {
  REWARD_CATEGORIES,
  PUNISHMENT_CATEGORIES,
  type LedgerEntryType,
} from "@/lib/ledger-constants";
import { logger } from "@/lib/logger";

export interface LedgerEntry {
  id: string;
  type: LedgerEntryType;
  category: string;
  title: string;
  description?: string;
  timestamp: number;
  author: "T7SEN" | "Besho";
}

const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

const INDEX_KEY = "ledger:index";
const entryKey = (id: string) => `ledger:${id}`;

async function getSession() {
  const cookieStore = await cookies();
  const value = cookieStore.get("session")?.value;
  if (!value) return null;
  return decrypt(value);
}

// ─── Push helper ──────────────────────────────────────────────────────────────

async function sendLedgerNotification(
  to: string,
  payload: { title: string; body: string; url: string },
): Promise<void> {
  try {
    await pushNotificationToHistory(to, {
      ...payload,
      timestamp: Date.now(),
    });

    let currentPage: string | null = null;
    try {
      const presenceRaw = await redis.get<string>(`presence:${to}`);
      if (presenceRaw) {
        const { page, ts } = JSON.parse(presenceRaw) as {
          page: string;
          ts: number;
        };
        if (Date.now() - ts < 9_000) currentPage = page;
      }
    } catch {
      /* proceed */
    }

    if (currentPage === payload.url) return;
    const isAppOpen = currentPage !== null;

    const fcmToken = await redis.get<string>(`push:fcm:${to}`);
    if (fcmToken) {
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
              notification: { title: payload.title, body: payload.body },
              data: { url: payload.url },
              android: { priority: "high" },
            }),
      });
      return;
    }

    // Web Push fallback
    const subscription = await redis.get(`push:subscription:${to}`);
    if (!subscription) return;

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
    logger.error("[ledger] Notification failed:", err);
  }
}

// ─── Actions ──────────────────────────────────────────────────────────────────

export async function getLedgerEntries(): Promise<LedgerEntry[]> {
  try {
    const ids = (await redis.zrange(INDEX_KEY, 0, -1, {
      rev: true,
    })) as string[];
    if (!ids.length) return [];
    const entries = await redis.mget<(LedgerEntry | null)[]>(
      ...ids.map(entryKey),
    );
    return entries.filter((e): e is LedgerEntry => e !== null);
  } catch (error) {
    logger.error("[ledger] Failed to fetch:", error);
    return [];
  }
}

export async function createLedgerEntry(
  prevState: unknown,
  formData: FormData,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "T7SEN") return { error: "Only Sir can log entries." };

  const type = formData.get("type") as LedgerEntryType;
  const category = (formData.get("category") as string)?.trim();
  const title = (formData.get("title") as string)?.trim();
  const description = (formData.get("description") as string)?.trim();
  const timestampStr = formData.get("timestamp") as string;

  if (type !== "reward" && type !== "punishment")
    return { error: "Invalid type." };
  if (!title) return { error: "Title is required." };
  if (!category) return { error: "Category is required." };

  const validCategories =
    type === "reward" ? REWARD_CATEGORIES : PUNISHMENT_CATEGORIES;
  if (!(validCategories as readonly string[]).includes(category))
    return { error: "Invalid category." };

  const timestamp = timestampStr
    ? new Date(timestampStr).getTime()
    : Date.now();
  if (isNaN(timestamp)) return { error: "Invalid date." };

  const entry: LedgerEntry = {
    id: crypto.randomUUID(),
    type,
    category,
    title,
    ...(description && { description }),
    timestamp,
    author: session.author,
  };

  try {
    const pipeline = redis.pipeline();
    pipeline.set(entryKey(entry.id), entry);
    pipeline.zadd(INDEX_KEY, { score: timestamp, member: entry.id });
    await pipeline.exec();

    await sendLedgerNotification("Besho", {
      title:
        type === "reward" ? "🏆 You earned a reward" : "⚠️ Punishment logged",
      body: `${category}: ${title}`,
      url: "/ledger",
    });

    logger.interaction("[ledger] Entry created", {
      id: entry.id,
      type: entry.type,
      category: entry.category,
      title: entry.title,
      by: session.author,
    });
    revalidatePath("/ledger");
    return { success: true };
  } catch (error) {
    logger.error("[ledger] Failed to create:", error);
    return { error: "Failed to save entry." };
  }
}

export async function deleteLedgerEntry(
  id: string,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "T7SEN")
    return { error: "Only Sir can delete entries." };

  try {
    const existing = await redis.get<LedgerEntry>(entryKey(id));
    if (!existing) return { error: "Entry not found." };

    const pipeline = redis.pipeline();
    pipeline.del(entryKey(id));
    pipeline.zrem(INDEX_KEY, id);
    await pipeline.exec();

    logger.interaction("[ledger] Entry deleted", {
      id,
      type: existing.type,
      category: existing.category,
      title: existing.title,
      by: session.author,
    });
    revalidatePath("/ledger");
    return { success: true };
  } catch (error) {
    logger.error("[ledger] Failed to delete:", error);
    return { error: "Failed to delete entry." };
  }
}
