// src/lib/fcm-tokens.ts
//
// Multi-token-per-author FCM helpers. The canonical storage shape is
//   `push:fcm:{author}` SET — every device's token lands here on
//   registration; sends fan out to all members; stale tokens are
//   SREM'd on FCM error responses.
//
// Backwards-compat: legacy STRING values from the prior single-token
// shape are tolerated on read AND migrated on the first write after
// deploy. Don't write a one-shot migration cron — the registration
// path will heal organically as each device opens the app.
//
// Why SET, not LIST/HASH/ZSET:
//   • SET — natural dedup (no double-add on retry), trivial SADD/SREM/
//     SCARD/SMEMBERS, ~one round-trip per op.
//   • LIST — needs explicit dedup loop; LREM is positional.
//   • HASH — would let us track per-token metadata (registeredAt,
//     userAgent), but adds complexity for marginal value at two-user
//     scale. Reach for HASH only if we need expiry-on-stale logic.
//   • ZSET — same as HASH but with score for last-seen-at; reach for
//     it if we add periodic dead-token sweeps.

import type { Redis } from "@upstash/redis";
import type { Author } from "./constants";

export const fcmKey = (author: Author) => `push:fcm:${author}`;

/**
 * Read every FCM token registered for `author`. Tolerates legacy
 * STRING values; returns `[]` when nothing is registered (don't
 * special-case Honor / no-GMS at the call site — empty array is the
 * canonical "no devices to push to" signal).
 */
export async function readFcmTokens(
  redis: Redis,
  author: Author,
): Promise<string[]> {
  const key = fcmKey(author);
  try {
    const type = await redis.type(key);
    if (type === "set") {
      const members = (await redis.smembers(key)) ?? [];
      return members.filter(
        (t): t is string => typeof t === "string" && t.length > 0,
      );
    }
    if (type === "string") {
      const single = await redis.get<string>(key);
      return typeof single === "string" && single.length > 0 ? [single] : [];
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Token count without serializing every value. Cheaper than
 * `readFcmTokens(...).length` because we never round-trip the token
 * payloads. Used by the health snapshot + admin devices view.
 */
export async function countFcmTokens(
  redis: Redis,
  author: Author,
): Promise<number> {
  const key = fcmKey(author);
  try {
    const type = await redis.type(key);
    if (type === "set") return (await redis.scard(key)) ?? 0;
    if (type === "string") {
      const v = await redis.get<string>(key);
      return typeof v === "string" && v.length > 0 ? 1 : 0;
    }
    return 0;
  } catch {
    return 0;
  }
}

/**
 * Register `token` for `author`. Idempotent — SADD is naturally
 * deduplicating, so a device that registers twice in one launch
 * doesn't bloat the set. If a legacy STRING value lives at the key,
 * it's converted to a SET in the same atomic step (read STRING, DEL,
 * SADD existing + new together).
 *
 * Returns the post-write token count for logging.
 */
export async function addFcmToken(
  redis: Redis,
  author: Author,
  token: string,
): Promise<number> {
  const key = fcmKey(author);
  const trimmed = token.trim();
  if (!trimmed) return 0;

  // Migrate legacy STRING → SET on first write after deploy.
  const type = await redis.type(key);
  if (type === "string") {
    const existing = await redis.get<string>(key);
    await redis.del(key);
    if (typeof existing === "string" && existing.length > 0) {
      await redis.sadd(key, existing);
    }
  }
  await redis.sadd(key, trimmed);
  return (await redis.scard(key)) ?? 0;
}

/**
 * Remove specific tokens from the author's set. Used by `sendNotification`
 * to evict tokens that FCM rejects with `messaging/registration-token-
 * not-registered` or `messaging/invalid-registration-token`. Tolerates
 * the legacy STRING shape — if the only token is the one being pruned,
 * we DEL the key entirely.
 */
export async function pruneStaleFcmTokens(
  redis: Redis,
  author: Author,
  tokens: string[],
): Promise<number> {
  if (!tokens.length) return 0;
  const key = fcmKey(author);
  try {
    const type = await redis.type(key);
    if (type === "set") {
      return (await redis.srem(key, ...tokens)) ?? 0;
    }
    if (type === "string") {
      const single = await redis.get<string>(key);
      if (typeof single === "string" && tokens.includes(single)) {
        await redis.del(key);
        return 1;
      }
      return 0;
    }
    return 0;
  } catch {
    return 0;
  }
}

/**
 * The single FCM error codes that mean "this token is permanently dead;
 * stop sending to it." Other failures (transient network, throttling,
 * mismatched sender id) are NOT tokens-faults and must not trigger a
 * SREM — that would over-prune live devices.
 *
 * `messaging/mismatched-credential` is debatable but exclusion-safe;
 * if the credential genuinely doesn't match, every send fails until
 * Sir refreshes FIREBASE_*, and SREM-ing real tokens hides the issue.
 */
export const PERMANENTLY_DEAD_FCM_ERROR_CODES = new Set<string>([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument", // covers malformed-token cases
]);
