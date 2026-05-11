// src/app/actions/admin/notifications.ts
"use server";

import { logger } from "@/lib/logger";
import type { Author } from "@/lib/constants";
import { sendNotification } from "../notifications";
import type { NotificationRecord } from "../notifications";
import { redis, requireSir } from "./_shared";

// ──────────────────────────────────────────────────────────────────
// Summon kitten — bypass presence + safeword channel + max priority.
// Possessive, dominant copy. Mirrors the safeword delivery shape but
// fires from Sir to Besho instead of the other way around.
// ──────────────────────────────────────────────────────────────────

export interface SummonResult {
  success?: boolean;
  error?: string;
}

export async function summonKitten(): Promise<SummonResult> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };

  try {
    await sendNotification(
      "Besho",
      {
        title: "Heel, kitten.",
        body: "You're mine. Drop everything and come to me — now.",
        url: "/",
      },
      {
        bypassPresence: true,
        android: {
          channelId: "safeword",
          priority: "max",
          sound: "default",
        },
      },
    );
    logger.interaction("[admin] kitten summoned", {
      by: guard.session.author,
    });
    return { success: true };
  } catch (err) {
    logger.error("[admin] summon failed", err, {
      by: guard.session.author,
    });
    return { error: "Summon failed." };
  }
}

// ──────────────────────────────────────────────────────────────────
// Send test push — wrap sendNotification with a Sir-only form.
// ──────────────────────────────────────────────────────────────────

export interface SendTestPushResult {
  success?: boolean;
  error?: string;
}

export async function sendTestPushAction(
  _prevState: unknown,
  formData: FormData,
): Promise<SendTestPushResult> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };

  const to = formData.get("to");
  const title = String(formData.get("title") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();
  const urlRaw = String(formData.get("url") ?? "").trim();
  const url = urlRaw.length > 0 ? urlRaw : "/";

  if (to !== "T7SEN" && to !== "Besho" && to !== "Both") {
    return { error: "Pick a recipient." };
  }
  if (title.length === 0) return { error: "Title is required." };
  if (title.length > 80) return { error: "Title is too long (max 80)." };
  if (body.length === 0) return { error: "Body is required." };
  if (body.length > 240) return { error: "Body is too long (max 240)." };
  if (url.length > 200) return { error: "URL is too long (max 200)." };

  const recipients: Author[] =
    to === "Both" ? ["T7SEN", "Besho"] : [to];

  try {
    const results = await Promise.allSettled(
      recipients.map((r) =>
        sendNotification(r, { title, body, url }, { bypassPresence: true }),
      ),
    );
    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length === recipients.length) {
      logger.error("[admin] test push failed", failed[0]?.status === "rejected" ? failed[0].reason : null, {
        to,
        by: guard.session.author,
      });
      return { error: "Send failed." };
    }
    logger.interaction("[admin] test push sent", {
      to,
      title,
      url,
      by: guard.session.author,
      recipients: recipients.length,
      failed: failed.length,
    });
    if (failed.length > 0) {
      return { error: `Sent to ${recipients.length - failed.length}/${recipients.length}.` };
    }
    return { success: true };
  } catch (err) {
    logger.error("[admin] test push failed", err, { to, by: guard.session.author });
    return { error: "Send failed." };
  }
}

// ──────────────────────────────────────────────────────────────────
// Outbound notification audit — Sir-private forward-only log of
// every send-time notification. Independent storage from the per-
// author `notifications:{author}` drawers, so a user clearing their
// drawer (or LTRIM rolling at the 50-cap) doesn't erase the audit.
// Source: `notifications:audit` ZSET capped at 200 via ZREMRANGEBYRANK,
// written from `pushNotificationToHistory` in the same pipeline as
// the drawer push.
// ──────────────────────────────────────────────────────────────────

export interface OutboundNotificationAuditEntry {
  id: string;
  to: Author;
  title: string;
  body: string;
  url: string;
  ts: number;
}

export interface NotificationAuditPair {
  author: Author;
  records: OutboundNotificationAuditEntry[];
}

export interface NotificationAuditResult {
  pairs?: NotificationAuditPair[];
  generatedAt?: number;
  error?: string;
}

const NOTIFICATION_AUDIT_KEY = "notifications:audit";
const NOTIFICATION_AUDIT_LIMIT = 200;
const NOTIFICATION_HISTORY_MAX = 50;
const notificationHistoryKey = (author: Author) => `notifications:${author}`;

// Upstash auto-deserializes JSON-encoded ZSET members back to objects
// on read, so `raw` is always an object here. The earlier branch that
// JSON.parsed string members was defensive code that never executed —
// removed.
function parseAuditEntry(raw: unknown): OutboundNotificationAuditEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Partial<OutboundNotificationAuditEntry>;
  if (
    typeof entry.id !== "string" ||
    (entry.to !== "T7SEN" && entry.to !== "Besho") ||
    typeof entry.title !== "string" ||
    typeof entry.body !== "string" ||
    typeof entry.url !== "string" ||
    typeof entry.ts !== "number"
  ) {
    return null;
  }
  return entry as OutboundNotificationAuditEntry;
}

export async function getOutboundNotificationAudit(): Promise<NotificationAuditResult> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  try {
    const raws =
      ((await redis.zrange<unknown[]>(
        NOTIFICATION_AUDIT_KEY,
        0,
        NOTIFICATION_AUDIT_LIMIT - 1,
        { rev: true },
      )) ?? []);
    const entries: OutboundNotificationAuditEntry[] = [];
    for (const raw of raws) {
      const e = parseAuditEntry(raw);
      if (e) entries.push(e);
    }
    const authors: Author[] = ["T7SEN", "Besho"];
    const pairs: NotificationAuditPair[] = authors.map((author) => ({
      author,
      records: entries.filter((e) => e.to === author),
    }));
    return { pairs, generatedAt: Date.now() };
  } catch (err) {
    logger.error("[admin] notification audit read failed", err);
    return { error: "Failed to read notification audit." };
  }
}

/**
 * Re-fires a notification by id. Looks up in the audit ZSET first,
 * which is the durable record — drawer-only entries (pre-audit)
 * fall through to the LIST as a transitional fallback. Calls
 * `sendNotification` with the recorded title/body/url; the new fire
 * is additive and creates fresh audit + drawer entries with new ids.
 * The original audit entry is untouched.
 */
export async function resendNotification(
  author: Author,
  notificationId: string,
): Promise<{ success?: boolean; error?: string }> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  if (author !== "T7SEN" && author !== "Besho") {
    return { error: "Invalid author." };
  }
  if (!notificationId || typeof notificationId !== "string") {
    return { error: "Invalid notification id." };
  }
  try {
    let target: { title: string; body: string; url: string } | null = null;

    // Audit ZSET — the durable source.
    const raws =
      ((await redis.zrange<unknown[]>(
        NOTIFICATION_AUDIT_KEY,
        0,
        NOTIFICATION_AUDIT_LIMIT - 1,
        { rev: true },
      )) ?? []);
    for (const raw of raws) {
      const e = parseAuditEntry(raw);
      if (e && e.id === notificationId && e.to === author) {
        target = { title: e.title, body: e.body, url: e.url };
        break;
      }
    }

    // Transitional fallback — drawer LIST may carry pre-audit entries.
    if (!target) {
      const records = await redis.lrange<NotificationRecord>(
        notificationHistoryKey(author),
        0,
        NOTIFICATION_HISTORY_MAX - 1,
      );
      const drawer = (records ?? []).find((r) => r?.id === notificationId);
      if (drawer) {
        target = {
          title: drawer.title,
          body: drawer.body,
          url: drawer.url,
        };
      }
    }

    if (!target) {
      return { error: "Notification not found in audit or recent drawer." };
    }
    await sendNotification(author, target);
    logger.interaction("[admin] notification re-sent", {
      by: guard.session.author,
      to: author,
      originalId: notificationId,
    });
    return { success: true };
  } catch (err) {
    logger.error("[admin] notification re-send failed", err);
    return { error: "Re-send failed." };
  }
}

/**
 * Hard-deletes the outbound notification audit ZSET. Sir-only. The
 * per-user notification drawers (`notifications:{author}`) are
 * SEPARATE and NOT affected — this only wipes the audit trail Sir
 * uses to re-fire pushes. Each user clears their own drawer
 * independently.
 */
export async function clearOutboundNotificationAudit(): Promise<{
  success?: boolean;
  error?: string;
  deletedCount?: number;
}> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  try {
    const count = (await redis.zcard(NOTIFICATION_AUDIT_KEY)) ?? 0;
    await redis.del(NOTIFICATION_AUDIT_KEY);
    logger.interaction("[admin] outbound audit cleared", {
      by: guard.session.author,
      deletedCount: count,
    });
    return {
      success: true,
      deletedCount: typeof count === "number" ? count : 0,
    };
  } catch (err) {
    logger.error("[admin] outbound audit clear failed", err);
    return { error: "Clear failed." };
  }
}
