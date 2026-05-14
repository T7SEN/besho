"use server";

// src/app/actions/reactions.ts
//
// Reactions are HASH-per-target where field = author and value = emoji.
// Each author has at most one reaction per target (toggling replaces or
// removes). The original surface was notes-only (`reactions:{noteId}`);
// the generalized API exposes `reactToTarget` and `getReactionsForTargets`
// so the same module backs Truth or Dare challenge reactions and any
// future feature.
//
// Storage asymmetry: notes preserved the legacy unprefixed key shape
// `reactions:{id}` to avoid a data migration. New target types use the
// prefixed form `reactions:{type}:{id}`. The `reactionKeyFor` helper is
// the single source of truth for this mapping — touch it once if a
// migration ever happens.

import { redis } from "@/lib/redis";
import { cookies } from "next/headers";
import { decrypt } from "@/lib/auth-utils";
import { type ReactionEmoji } from "@/lib/reaction-constants";
import { logger } from "@/lib/logger";
import { assertWriteAllowed } from "@/lib/restraint";

/** Reactable target categories. Add new types here as features adopt
 *  reactions; the helper expects every value to be a stable kebab-safe
 *  identifier that survives in Redis keys. */
export type ReactionTargetType = "note" | "tod";

/** Resolves the Redis HASH key for a given reaction target. Notes use
 *  the legacy unprefixed shape (`reactions:{id}`) for backward compat
 *  with already-stored data; new types use the prefixed form
 *  (`reactions:{type}:{id}`). Touch this in exactly one place if you
 *  ever migrate the notes keys to the uniform shape. */
function reactionKeyFor(type: ReactionTargetType, id: string): string {
  if (type === "note") return `reactions:${id}`;
  return `reactions:${type}:${id}`;
}

async function getSessionAuthor(): Promise<"T7SEN" | "Besho" | null> {
  const cookieStore = await cookies();
  const value = cookieStore.get("session")?.value;
  if (!value) return null;
  const session = await decrypt(value);
  return session?.author ?? null;
}

/**
 * Toggle a reaction on any target type. Atomicity matches the original
 * notes implementation: read-then-write per author.
 * - If the author hasn't reacted: add the emoji.
 * - If the author reacted with the same emoji: remove it.
 * - If the author reacted with a different emoji: replace it.
 *
 * Restraint-gated for Kitten — reactions are writes. Sir is never
 * restrained.
 */
export async function reactToTarget(
  type: ReactionTargetType,
  targetId: string,
  emoji: ReactionEmoji,
): Promise<{ reactions: Record<string, string>; error?: string }> {
  const author = await getSessionAuthor();
  if (!author) return { reactions: {}, error: "Not authenticated." };

  const block = await assertWriteAllowed(author);
  if (block) return { reactions: {}, error: block.error };

  const key = reactionKeyFor(type, targetId);

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
      type,
      targetId,
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
 * Batch read reactions for many targets of the same type. Returns a
 * map of `targetId → { author: emoji }`. Empty result for any target
 * with no reactions stored.
 */
export async function getReactionsForTargets(
  type: ReactionTargetType,
  targetIds: string[],
): Promise<Record<string, Record<string, string>>> {
  if (!targetIds.length) return {};

  try {
    const pipeline = redis.pipeline();
    for (const id of targetIds) {
      pipeline.hgetall(reactionKeyFor(type, id));
    }

    const results = await pipeline.exec<(Record<string, string> | null)[]>();

    const map: Record<string, Record<string, string>> = {};
    for (let i = 0; i < targetIds.length; i++) {
      map[targetIds[i]] = results[i] ?? {};
    }
    return map;
  } catch (error) {
    logger.error("[reactions] Failed to fetch reactions:", error);
    return {};
  }
}

/**
 * Notes-specific wrapper kept for backward compatibility — the notes
 * page + `<NoteReactions>` import this directly. Delegates to
 * `reactToTarget("note", ...)` so the toggle behavior + audit log line
 * stay identical.
 */
export async function reactToNote(
  noteId: string,
  emoji: ReactionEmoji,
): Promise<{ reactions: Record<string, string>; error?: string }> {
  return reactToTarget("note", noteId, emoji);
}

/**
 * Notes-specific batch reader kept for backward compatibility. Same
 * shape as before — delegates to `getReactionsForTargets("note", ...)`.
 */
export async function getReactionsForNotes(
  noteIds: string[],
): Promise<Record<string, Record<string, string>>> {
  return getReactionsForTargets("note", noteIds);
}
