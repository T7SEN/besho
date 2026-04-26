"use server";

import { Redis } from "@upstash/redis";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { decrypt } from "@/lib/auth-utils";

export interface Milestone {
  id: string;
  title: string;
  description?: string;
  date: number; // Unix timestamp of the event itself
  emoji: string;
  author: string;
  createdAt: number; // When it was added to the app
}

const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

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
    console.error("[timeline] Failed to fetch milestones:", error);
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

    revalidatePath("/timeline");
    return { success: true };
  } catch (error) {
    console.error("[timeline] Failed to add milestone:", error);
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

    const pipeline = redis.pipeline();
    pipeline.del(milestoneKey(id));
    pipeline.zrem(INDEX_KEY, id);
    await pipeline.exec();

    revalidatePath("/timeline");
    return { success: true };
  } catch (error) {
    console.error("[timeline] Failed to delete milestone:", error);
    return { error: "Failed to delete. Please try again." };
  }
}
