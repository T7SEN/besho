"use server";

import { Redis } from "@upstash/redis";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { decrypt } from "@/lib/auth-utils";
import { sendNotification } from "@/app/actions/notifications";
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

    await sendNotification("Besho", {
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
