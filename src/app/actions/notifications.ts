// src/app/actions/notifications.ts
"use server";

import { redis } from "@/lib/redis";
import { cookies } from "next/headers";
import { decrypt } from "@/lib/auth-utils";
import { logger } from "@/lib/logger";

export interface NotificationRecord {
  id: string;
  title: string;
  body: string;
  url: string;
  timestamp: number;
  read: boolean;
}

const MAX_HISTORY = 50;
const historyKey = (author: string) => `notifications:${author}`;
/** Forward-only outbound audit. Lives independently from the per-
 *  author drawer LIST so a user clearing their drawer (or LTRIM
 *  rolling at the 50-cap) doesn't erase the audit record. Sir-only
 *  read via `admin.getOutboundNotificationAudit`. ZSET scored by ts;
 *  capped at 200 via ZREMRANGEBYRANK. */
const AUDIT_KEY = "notifications:audit";
const AUDIT_CAP = 200;

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
    logger.error("[notifications] Failed to fetch history:", error);
    return [];
  }
}

// Lua: atomic read-modify-write of the drawer LIST. Inside an EVAL
// the entire script runs uninterrupted (Redis is single-threaded), so
// a concurrent `pushNotificationToHistory` LPUSH cannot land between
// our LRANGE and DEL/RPUSH cycle. Without this, the previous JS
// pipeline leaked: read snapshot → DEL clears the list → re-push the
// stale snapshot, dropping any LPUSH that arrived in the window.
//
// String mutation: Upstash JSON-stringifies stored objects via the
// canonical `JSON.stringify` form (no whitespace), so `"read":false`
// is the exact byte sequence to swap. The `1` arg to `gsub` caps at
// one replacement per record — defensive against any future field
// that happens to contain the same substring nested in user content.
const MARK_ALL_READ_LUA = `
local items = redis.call("LRANGE", KEYS[1], 0, -1)
if #items == 0 then return 0 end
redis.call("DEL", KEYS[1])
for i = 1, #items do
  redis.call("RPUSH", KEYS[1], string.gsub(items[i], '"read":false', '"read":true', 1))
end
return #items
`;

export async function markAllNotificationsRead(): Promise<void> {
  const author = await getSessionAuthor();
  if (!author) return;

  try {
    const updated = await redis.eval(
      MARK_ALL_READ_LUA,
      [historyKey(author)],
      [],
    );
    logger.interaction("[notifications] All marked as read", {
      author,
      updated,
    });
  } catch (error) {
    logger.error("[notifications] Failed to mark read:", error);
  }
}

/**
 * Persists a notification record to `notifications:{author}` (LIST,
 * capped at 50 via LTRIM) AND mirrors the send into the global
 * `notifications:audit` ZSET (capped 200, scored by ts). Called from
 * `sendNotification` before attempting FCM delivery so both records
 * are durable even when FCM is unavailable (Honor / no-GMS) or the
 * recipient is on the target page and the push is intentionally
 * skipped.
 *
 * The drawer LIST is mutable user state — Besho or Sir can clear it,
 * and LTRIM rolls old entries off the end. The audit ZSET is
 * forward-only Sir-private state with its own retention; clearing a
 * drawer doesn't touch the audit. Both writes share the same
 * record id so the admin re-send path can resolve by id from either
 * source.
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
    const auditEntry = {
      id: full.id,
      to: author,
      title: full.title,
      body: full.body,
      url: full.url,
      ts: full.timestamp,
    };
    const pipeline = redis.pipeline();
    pipeline.lpush(historyKey(author), full);
    pipeline.ltrim(historyKey(author), 0, MAX_HISTORY - 1);
    pipeline.zadd(AUDIT_KEY, {
      score: auditEntry.ts,
      member: JSON.stringify(auditEntry),
    });
    pipeline.zremrangebyrank(AUDIT_KEY, 0, -AUDIT_CAP - 1);
    await pipeline.exec();
  } catch (error) {
    logger.error("[notifications] Failed to push to history:", error);
  }
}

export async function clearAllNotifications(): Promise<void> {
  const author = await getSessionAuthor();
  if (!author) return;

  try {
    await redis.del(historyKey(author));
    logger.interaction("[notifications] All notifications cleared", { author });
  } catch (error) {
    logger.error("[notifications] Failed to clear history:", error);
  }
}

/**
 * Server-side push notification routing. Single source of truth for
 * every server action that notifies the partner.
 *
 * Algorithm:
 *
 * 1. Always write to `notifications:{to}` history first — this is the
 *    only artifact Besho's Honor device will see.
 * 2. Read `presence:{to}` (12s freshness window). Tolerates the legacy
 *    plain-string format alongside `{ page, ts }` JSON.
 * 3. If recipient is on `payload.url` and `bypassPresence` is not set,
 *    return — SSE / `useRefreshListener` cover the UI; a push would
 *    double-notify.
 * 4. Read `push:fcm:{to}`. If absent, return (Honor / no-GMS — silent).
 * 5. Send via FCM:
 *    - `bypassPresence: true` → full `notification` payload regardless
 *      of foreground state, with optional `android` overrides for
 *      channel / priority / sound. Used by `/safeword`.
 *    - Foreground (presence fresh, different page) → data-only payload.
 *      `FCMProvider` intercepts and dispatches an in-app `PushToast`.
 *      The `notification` field MUST NOT be set here, or Android draws
 *      the heads-up banner and the in-app toast simultaneously.
 *    - Background / closed → full `notification` payload + `data.url`.
 *
 * No external fallback. Web Push and `web-push` are intentionally
 * removed (see `SKILL.md` Section 2.1). FCM failures are logged and
 * the history record stands as the only artifact.
 *
 * `firebase-admin` is imported dynamically to keep the Edge bundle
 * slim per `SKILL.md` Section 4.
 *
 * @example Standard partner notification
 * await sendNotification("Besho", {
 *   title: "📜 New Rule",
 *   body: `Sir set a new rule: ${rule.title}`,
 *   url: "/rules",
 * });
 *
 * @example Safe-word — bypass presence, dedicated channel
 * await sendNotification("T7SEN", payload, {
 *   bypassPresence: true,
 *   android: {
 *     channelId: "safeword",
 *     priority: "max",
 *     sound: "default",
 *   },
 * });
 */
export async function sendNotification(
  to: "T7SEN" | "Besho",
  payload: { title: string; body: string; url: string },
  options?: {
    bypassPresence?: boolean;
    android?: {
      channelId?: string;
      priority?: "default" | "high" | "max";
      sound?: string;
    };
  },
): Promise<void> {
  // 1. Always record to history first — the only artifact for no-GMS.
  try {
    await pushNotificationToHistory(to, {
      ...payload,
      timestamp: Date.now(),
    });
  } catch (err) {
    logger.error("[push] Failed to write notification history:", err);
  }

  // 2. Read presence — JSON `{ page, ts }` with legacy string fallback.
  let currentPage: string | null = null;
  try {
    const presenceRaw = await redis.get<string>(`presence:${to}`);
    if (presenceRaw) {
      try {
        const { page, ts } = JSON.parse(presenceRaw) as {
          page: string;
          ts: number;
        };
        if (Date.now() - ts < 12_000) {
          currentPage = page;
        }
      } catch {
        currentPage = presenceRaw;
      }
    }
  } catch {
    /* proceed */
  }

  // 3. Skip if recipient is on the target page (unless bypassed).
  if (!options?.bypassPresence && currentPage === payload.url) {
    logger.info(`[push] Skipping — ${to} is on ${payload.url}.`);
    return;
  }

  // 4. Resolve FCM token. Absent → done (Honor / no-GMS).
  let fcmToken: string | null = null;
  try {
    fcmToken = await redis.get<string>(`push:fcm:${to}`);
  } catch (err) {
    logger.error("[push] Failed to read FCM token:", err);
    return;
  }
  if (!fcmToken) {
    logger.info(`[push] No FCM token for ${to}.`);
    return;
  }
  
  // 5. Initialize firebase-admin and send.
  try {
    const { getApps, initializeApp, cert } = await import("firebase-admin/app");
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

    const isAppOpen = currentPage !== null;
    const useFullNotification = options?.bypassPresence === true || !isAppOpen;

    if (useFullNotification) {
      const a = options?.android;
      await getMessaging().send({
        token: fcmToken,
        notification: {
          title: payload.title,
          body: payload.body,
        },
        data: { url: payload.url },
        android: {
          priority: "high",
          ...(a
            ? {
                notification: {
                  ...(a.channelId ? { channelId: a.channelId } : {}),
                  ...(a.priority ? { priority: a.priority } : {}),
                  ...(a.sound ? { sound: a.sound } : {}),
                },
              }
            : {}),
        },
      });
    } else {
      // Foreground, different page: data-only.
      // CRITICAL: no `notification` field, or Android double-notifies.
      await getMessaging().send({
        token: fcmToken,
        data: {
          url: payload.url,
          title: payload.title,
          body: payload.body,
        },
      });
    }

    logger.info(`[push] FCM sent to ${to}.`);
  } catch (err) {
    logger.error("[push] FCM send failed:", err);
  }
}
