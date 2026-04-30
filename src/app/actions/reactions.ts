"use server";

import { Redis } from "@upstash/redis";
import { cookies } from "next/headers";
import { decrypt } from "@/lib/auth-utils";
import { type ReactionEmoji } from "@/lib/reaction-constants";
import { logger } from "@/lib/logger";

const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

// reactions:{noteId} → Redis HASH { author: emoji }
const reactionsKey = (noteId: string) => `reactions:${noteId}`;

async function getSessionAuthor(): Promise<"T7SEN" | "Besho" | null> {
  const cookieStore = await cookies();
  const value = cookieStore.get("session")?.value;
  if (!value) return null;
  const session = await decrypt(value);
  return session?.author ?? null;
}

/**
 * Toggle a reaction on a note.
 * - If the author hasn't reacted: add the emoji
 * - If the author reacted with the same emoji: remove it
 * - If the author reacted with a different emoji: replace it
 */
export async function reactToNote(
  noteId: string,
  emoji: ReactionEmoji,
): Promise<{ reactions: Record<string, string>; error?: string }> {
  const author = await getSessionAuthor();
  if (!author) return { reactions: {}, error: "Not authenticated." };

  const key = reactionsKey(noteId);

  try {
    const existing = await redis.hget<string>(key, author);

    let action: "added" | "removed" | "replaced";
    if (existing === emoji) {
      await redis.hdel(key, author);
      action = "removed";
    } else {
      await redis.hset(key, { [author]: emoji });
      action = existing ? "replaced" : "added";
    }

    const all = await redis.hgetall<Record<string, string>>(key);
    logger.interaction("[reactions] Reaction toggled", {
      author,
      noteId,
      emoji,
      action,
    });
    return { reactions: all ?? {} };
  } catch (error) {
    logger.error("[reactions] Failed to react:", error);
    return { reactions: {}, error: "Failed to save reaction." };
  }
}

/**
 * Fetch reactions for multiple notes in a single pipeline.
 * Returns a map of noteId → { author: emoji }
 */
export async function getReactionsForNotes(
  noteIds: string[],
): Promise<Record<string, Record<string, string>>> {
  if (!noteIds.length) return {};

  try {
    const pipeline = redis.pipeline();
    for (const id of noteIds) {
      pipeline.hgetall(reactionsKey(id));
    }

    const results = await pipeline.exec<(Record<string, string> | null)[]>();

    const map: Record<string, Record<string, string>> = {};
    for (let i = 0; i < noteIds.length; i++) {
      map[noteIds[i]] = results[i] ?? {};
    }
    return map;
  } catch (error) {
    logger.error("[reactions] Failed to fetch reactions:", error);
    return {};
  }
}
