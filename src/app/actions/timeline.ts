"use server";

import { redis } from "@/lib/redis";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { decrypt } from "@/lib/auth-utils";
import { logger } from "@/lib/logger";
import { moveToTrash, moveManyToTrash } from "@/lib/trash";
import type { Author } from "@/lib/constants";

export interface Milestone {
  id: string;
  title: string;
  description?: string;
  date: number; // Unix timestamp of the event itself
  emoji: string;
  author: string;
  createdAt: number; // When it was added to the app
}

const INDEX_KEY = "milestones:index";
const milestoneKey = (id: string) => `milestone:${id}`;

async function getSessionAuthor(): Promise<"T7SEN" | "Besho" | null> {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get("session")?.value;
  if (!sessionCookie) return null;
  const session = await decrypt(sessionCookie);
  return session?.author ?? null;
}

export async function getMilestones(): Promise<Milestone[]> {
  try {
    const ids = (await redis.zrange(INDEX_KEY, 0, -1, {
      rev: true, // newest event first
    })) as string[];

    if (!ids.length) return [];

    const rawMilestones = await redis.mget<(Milestone | null)[]>(
      ...ids.map(milestoneKey),
    );

    return rawMilestones.filter((m): m is Milestone => m !== null);
  } catch (error) {
    logger.error("[timeline] Failed to fetch milestones:", error);
    return [];
  }
}

export async function addMilestone(
  prevState: unknown,
  formData: FormData,
): Promise<{ success?: boolean; error?: string }> {
  const author = await getSessionAuthor();
  if (!author) return { error: "Not authenticated." };

  const title = (formData.get("title") as string)?.trim();
  const description = (formData.get("description") as string)?.trim();
  const dateStr = formData.get("date") as string;
  const emoji = (formData.get("emoji") as string) || "✨";

  if (!title) return { error: "Title is required." };
  if (!dateStr) return { error: "Date is required." };

  const date = new Date(dateStr).getTime();
  if (isNaN(date)) return { error: "Invalid date." };

  const milestone: Milestone = {
    id: crypto.randomUUID(),
    title,
    ...(description && { description }),
    date,
    emoji,
    author,
    createdAt: Date.now(),
  };

  try {
    const pipeline = redis.pipeline();
    pipeline.set(milestoneKey(milestone.id), milestone);
    pipeline.zadd(INDEX_KEY, { score: milestone.date, member: milestone.id });
    await pipeline.exec();

    logger.interaction("[timeline] Milestone added", {
      id: milestone.id,
      title: milestone.title,
      emoji: milestone.emoji,
      author,
    });
    revalidatePath("/timeline");
    return { success: true };
  } catch (error) {
    logger.error("[timeline] Failed to add milestone:", error);
    return { error: "Failed to save. Please try again." };
  }
}

export async function deleteMilestone(
  id: string,
): Promise<{ success?: boolean; error?: string }> {
  const author = await getSessionAuthor();
  if (!author) return { error: "Not authenticated." };

  try {
    const existing = await redis.get<Milestone>(milestoneKey(id));
    if (!existing) return { error: "Milestone not found." };
    if (existing.author !== author) {
      return { error: "You can only delete your own milestones." };
    }

    const score = await redis.zscore(INDEX_KEY, id);
    await moveToTrash(redis, {
      feature: "timeline",
      id,
      label: `${existing.emoji} ${existing.title}`,
      deletedBy: author as Author,
      payload: existing,
      indexScore:
        typeof score === "number" ? score : Number(score) || existing.date,
      recordKey: milestoneKey(id),
      indexKey: INDEX_KEY,
    });

    const pipeline = redis.pipeline();
    pipeline.del(milestoneKey(id));
    pipeline.zrem(INDEX_KEY, id);
    await pipeline.exec();

    logger.interaction("[timeline] Milestone deleted", {
      id,
      title: existing.title,
      author,
    });
    revalidatePath("/timeline");
    return { success: true };
  } catch (error) {
    logger.error("[timeline] Failed to delete milestone:", error);
    return { error: "Failed to delete. Please try again." };
  }
}

// ─── Sir-only destructive ─────────────────────────────────────────────────────

export async function purgeAllMilestones(): Promise<{
  success?: boolean;
  error?: string;
  deletedCount?: number;
}> {
  const author = await getSessionAuthor();
  if (!author) return { error: "Not authenticated." };
  if (author !== "T7SEN")
    return { error: "Only Sir can purge the timeline." };

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
        (await redis.mget<Milestone[]>(...ids.map(milestoneKey))) ?? [];
      await moveManyToTrash(
        redis,
        pairs.map((p, i) => {
          const m = records[i];
          return {
            feature: "timeline" as const,
            id: p.id,
            label: m ? `${m.emoji} ${m.title}` : p.id,
            deletedBy: author as Author,
            payload: m ?? null,
            indexScore: p.score,
            recordKey: milestoneKey(p.id),
            indexKey: INDEX_KEY,
          };
        }),
      );
    }

    const pipeline = redis.pipeline();
    for (const id of ids) pipeline.del(milestoneKey(id));
    pipeline.del(INDEX_KEY);
    if (ids.length > 0) await pipeline.exec();

    revalidatePath("/timeline");
    logger.warn(`[timeline] Sir purged ${ids.length} milestones.`);
    return { success: true, deletedCount: ids.length };
  } catch (err) {
    logger.error("[timeline] purgeAllMilestones failed:", err);
    return { error: "Purge failed." };
  }
}
