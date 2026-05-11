// src/lib/activity.ts
//
// CANNOT use the `@/lib/redis` singleton because this module is
// transitively reachable from client components (logger imports it,
// `error-boundary.tsx` and other client components import logger).
// Adding `import "server-only"` would fail the build, and importing
// `./redis` (which IS server-only) would fail it via the dependency
// graph — Turbopack tracks dynamic imports for chunk graphs, so even
// `await import("./activity")` from logger doesn't break the chain.
//
// Instead: lazy null-safe pattern. Module-load is harmless (no
// `new Redis(...)` until called); env vars are undefined client-side
// so `getRedis()` returns null and `recordActivity` no-ops. Only the
// server path actually instantiates a client. This is the lone
// exception to the singleton; every other module uses `@/lib/redis`.

import { Redis } from "@upstash/redis";

const ACTIVITY_KEY = "activity:log";
const ACTIVITY_CAP = 500;

let _redis: Redis | null = null;

function getRedis(): Redis | null {
  if (_redis) return _redis;
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  _redis = new Redis({ url, token });
  return _redis;
}

export interface ActivityRecord {
  at: number;
  level: "info" | "interaction" | "warn" | "error" | "fatal";
  message: string;
  context?: Record<string, unknown>;
}

/**
 * Append an activity record to the Redis-backed feed and trim to the
 * most recent ACTIVITY_CAP entries. Fire-and-forget — never throws so
 * the logger pipeline cannot recurse.
 */
export async function recordActivity(
  level: ActivityRecord["level"],
  message: string,
  context?: Record<string, unknown>,
): Promise<void> {
  const r = getRedis();
  if (!r) return;
  const at = Date.now();
  const record: ActivityRecord = { at, level, message, context };
  try {
    await r
      .pipeline()
      .zadd(ACTIVITY_KEY, { score: at, member: JSON.stringify(record) })
      .zremrangebyrank(ACTIVITY_KEY, 0, -ACTIVITY_CAP - 1)
      .exec();
  } catch {
    // Swallow — activity logging is a side effect, never propagate.
  }
}

/**
 * Read the most recent N activity records, newest first. Tolerates
 * malformed entries by skipping them.
 */
export async function getActivity(limit = 100): Promise<ActivityRecord[]> {
  const r = getRedis();
  if (!r) return [];
  const raw = (await r.zrange<unknown[]>(ACTIVITY_KEY, 0, limit - 1, {
    rev: true,
  })) as unknown[];
  const out: ActivityRecord[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      try {
        out.push(JSON.parse(entry) as ActivityRecord);
      } catch {
        // skip malformed
      }
    } else if (entry && typeof entry === "object") {
      out.push(entry as ActivityRecord);
    }
  }
  return out;
}

/**
 * Clears activity entries. With no argument, hard-deletes the whole
 * ZSET (the "Clear on the All tab" path). When passed a level, scans
 * the ZSET, filters in-memory, and ZREMs only the matching members —
 * so "Clear" on the Warnings filter chip removes warnings but leaves
 * interactions / errors / fatals intact.
 *
 * The ZSET is capped at 500 entries, so the read-and-ZREM path is
 * cheap. Returns the count of entries actually removed.
 *
 * Round-trip on object members: Upstash auto-deserializes JSON-encoded
 * ZSET members back into objects on read. To ZREM by member, we re-
 * stringify with `JSON.stringify`. V8's JSON.parse + JSON.stringify is
 * deterministic (insertion-order preserving), so the round-trip
 * matches the originally-written string and ZREM hits. If any record
 * fails the round-trip (e.g. a future malformed write), it stays in
 * the ZSET — better than corrupting the audit by removing the wrong
 * entry.
 */
export async function clearActivity(
  level?: ActivityRecord["level"],
): Promise<number> {
  const r = getRedis();
  if (!r) return 0;

  if (!level) {
    const count = (await r.zcard(ACTIVITY_KEY)) ?? 0;
    await r.del(ACTIVITY_KEY);
    return typeof count === "number" ? count : 0;
  }

  const raw =
    ((await r.zrange<unknown[]>(ACTIVITY_KEY, 0, -1)) ?? []) as unknown[];
  const toRemove: string[] = [];
  for (const entry of raw) {
    let parsed: ActivityRecord | null = null;
    let memberStr: string;
    if (typeof entry === "string") {
      memberStr = entry;
      try {
        parsed = JSON.parse(entry) as ActivityRecord;
      } catch {
        continue;
      }
    } else if (entry && typeof entry === "object") {
      parsed = entry as ActivityRecord;
      memberStr = JSON.stringify(entry);
    } else {
      continue;
    }
    if (parsed && parsed.level === level) {
      toRemove.push(memberStr);
    }
  }

  if (toRemove.length === 0) return 0;
  await r.zrem(ACTIVITY_KEY, ...toRemove);
  return toRemove.length;
}
