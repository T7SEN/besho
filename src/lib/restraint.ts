// src/lib/restraint.ts
import { redis } from "@/lib/redis";
import type { Author } from "./constants";

export const RESTRAINT_KEY = "mode:restraint:Besho";

/** Cached value bounds the per-request Redis hit. Rebuilt on each
 *  process; admin toggles `setRestraint()` invalidate via direct write
 *  + a tiny cache TTL so the cutover is bounded by ~5s. */
interface CacheEntry {
  on: boolean;
  until: number;
}
let cache: CacheEntry | null = null;
const CACHE_MS = 5_000;

export async function isRestrained(author: Author): Promise<boolean> {
  if (author !== "Besho") return false;
  const now = Date.now();
  if (cache && cache.until > now) return cache.on;
  try {
    const v = await redis.get<string>(RESTRAINT_KEY);
    const on = v === "on";
    cache = { on, until: now + CACHE_MS };
    return on;
  } catch {
    return false;
  }
}

/**
 * Standard guard for any Besho-writable server action. Sir is never
 * restrained. Returns the canonical error shape so callers can `return`
 * it directly:
 *
 * ```ts
 * const block = await assertWriteAllowed(session.author)
 * if (block) return block
 * ```
 */
export async function assertWriteAllowed(
  author: Author,
): Promise<{ error: string } | null> {
  if (await isRestrained(author)) {
    return { error: "Sir put you on restraint." };
  }
  return null;
}

/** Sir-only writer. Caller is responsible for the role check. */
export async function setRestraintRaw(on: boolean): Promise<void> {
  if (on) {
    await redis.set(RESTRAINT_KEY, "on");
  } else {
    await redis.del(RESTRAINT_KEY);
  }
  cache = { on, until: Date.now() + CACHE_MS };
}

export async function readRestraintRaw(): Promise<boolean> {
  try {
    const v = await redis.get<string>(RESTRAINT_KEY);
    return v === "on";
  } catch {
    return false;
  }
}
