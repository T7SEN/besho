"use server";

import { Redis } from "@upstash/redis";
import { cookies } from "next/headers";
import { decrypt } from "@/lib/auth-utils";

export interface NotificationRecord {
  id: string;
  title: string;
  body: string;
  url: string;
  timestamp: number;
  read: boolean;
}

const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

const MAX_HISTORY = 50;
const historyKey = (author: string) => `notifications:${author}`;

async function getSessionAuthor(): Promise<"T7SEN" | "Besho" | null> {
  const cookieStore = await cookies();
  const value = cookieStore.get("session")?.value;
  if (!value) return null;
  const session = await decrypt(value);
  return session?.author ?? null;
}

export async function getNotificationHistory(): Promise<NotificationRecord[]> {
  const author = await getSessionAuthor();
  if (!author) return [];

  try {
    const records = await redis.lrange<NotificationRecord>(
      historyKey(author),
      0,
      MAX_HISTORY - 1,
    );
    return records ?? [];
  } catch (error) {
    console.error("[notifications] Failed to fetch history:", error);
    return [];
  }
}

export async function markAllNotificationsRead(): Promise<void> {
  const author = await getSessionAuthor();
  if (!author) return;

  try {
    const records = await redis.lrange<NotificationRecord>(
      historyKey(author),
      0,
      -1,
    );
    if (!records?.length) return;

    const updated = records.map((r) => ({ ...r, read: true }));

    const pipeline = redis.pipeline();
    pipeline.del(historyKey(author));
    for (const record of updated) {
      pipeline.rpush(historyKey(author), record);
    }
    await pipeline.exec();
  } catch (error) {
    console.error("[notifications] Failed to mark read:", error);
  }
}

/**
 * Called server-side from sendPushToUser and sendHugPush
 * to persist a record before sending the push.
 */
export async function pushNotificationToHistory(
  author: string,
  record: Omit<NotificationRecord, "id" | "read">,
): Promise<void> {
  try {
    const full: NotificationRecord = {
      ...record,
      id: crypto.randomUUID(),
      read: false,
    };
    const pipeline = redis.pipeline();
    pipeline.lpush(historyKey(author), full);
    pipeline.ltrim(historyKey(author), 0, MAX_HISTORY - 1);
    await pipeline.exec();
  } catch (error) {
    console.error("[notifications] Failed to push to history:", error);
  }
}

export async function clearAllNotifications(): Promise<void> {
  const author = await getSessionAuthor();
  if (!author) return;

  try {
    await redis.del(historyKey(author));
  } catch (error) {
    console.error("[notifications] Failed to clear history:", error);
  }
}
