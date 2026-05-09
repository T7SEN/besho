// src/hooks/use-local-notifications.ts
"use client";

import { useCallback, useEffect } from "react";
import { isNative } from "@/lib/native";
import { logger } from "@/lib/logger";
import {
  isOsNotificationsDisabledError,
  OS_NOTIF_HINT,
} from "@/lib/os-notifications";

// ── Notification ID ranges ────────────────────────────────────────────────────
// Stable IDs prevent duplicate notifications when re-scheduling.
// Derive task/rule IDs from their string IDs using these offsets.
//
// Ritual reminders use a 2-tier scheme so that (ritualId, day) pairs don't
// collide within the 7-day forward horizon: 112 ritual slots × 8 day slots
// = 896 IDs in the band [3000, 3895]. `daysSinceEpoch % 8` is collision-free
// for any 7 consecutive days.
export const NOTIF_ID = {
  MOOD_NUDGE: 100,
  taskDeadline: (numericSuffix: number) => 1000 + (numericSuffix % 900),
  ruleAckDeadline: (numericSuffix: number) => 2000 + (numericSuffix % 900),
  ritualReminder: (numericSuffix: number, daysSinceEpoch: number) =>
    3000 + (numericSuffix % 112) * 8 + (daysSinceEpoch % 8),
  TASK_BAND_START: 1000,
  TASK_BAND_END: 1899,
  RULE_BAND_START: 2000,
  RULE_BAND_END: 2899,
  RITUAL_BAND_START: 3000,
  RITUAL_BAND_END: 3895,
} as const;

/**
 * Converts an arbitrary string ID (e.g. Redis ULID) to a stable
 * numeric suffix in range [0, 899] for use with NOTIF_ID helpers.
 */
export function idToNumeric(stringId: string): number {
  let hash = 0;
  for (let i = 0; i < stringId.length; i++) {
    hash = (hash * 31 + stringId.charCodeAt(i)) >>> 0;
  }
  return hash % 900;
}

export interface ScheduleNotificationOptions {
  id: number;
  title: string;
  body: string;
  /** Unix timestamp in milliseconds */
  atMs: number;
  /**
   * Optional in-app URL to navigate to when the user taps the
   * notification. Stored on Capacitor's `extra` field and read by the
   * action listener registered below.
   */
  url?: string;
}

// Module-level singleton for the `localNotificationActionPerformed`
// listener. Capacitor allows multiple listeners but registering once is
// cleaner and avoids duplicate navigation on tap.
//
// The hook calls `ensureActionListener()` from a one-time `useEffect`.
// The promise gate makes concurrent first-render mounts converge on a
// single registration without races.
let actionListenerPromise: Promise<void> | null = null;

function ensureActionListener(): Promise<void> {
  if (actionListenerPromise) return actionListenerPromise;
  actionListenerPromise = (async () => {
    if (!isNative()) return;
    try {
      const { LocalNotifications } =
        await import("@capacitor/local-notifications");
      await LocalNotifications.addListener(
        "localNotificationActionPerformed",
        (action) => {
          const extra = action.notification.extra as { url?: string } | null;
          const url = extra?.url;
          if (typeof url === "string" && url.length > 0) {
            (
              globalThis as unknown as { location: { href: string } }
            ).location.href = url;
          }
        },
      );
    } catch (err) {
      // Reset so a future caller can retry. Not strictly necessary —
      // the failure mode is "tap doesn't deep-link" which is recoverable.
      actionListenerPromise = null;
      if (isOsNotificationsDisabledError(err)) {
        logger.warn(
          "[local-notif] Action listener skipped — OS-level notifications disabled.",
          { hint: OS_NOTIF_HINT },
        );
        return;
      }
      logger.error("[local-notif] Action listener register failed:", err);
    }
  })();
  return actionListenerPromise;
}

/**
 * Hook wrapping @capacitor/local-notifications.
 *
 * All methods are no-ops on web. On native, failures are caught and
 * logged without throwing so callers never need try/catch.
 */
export function useLocalNotifications() {
  /**
   * Requests POST_NOTIFICATIONS permission (Android 13+).
   * Returns true if granted, false otherwise.
   * Call once on app start — already handled in CapacitorInit.
   */
  const requestPermission = useCallback(async (): Promise<boolean> => {
    if (!isNative()) return false;
    try {
      const { LocalNotifications } =
        await import("@capacitor/local-notifications");
      const { display } = await LocalNotifications.requestPermissions();
      return display === "granted";
    } catch (err) {
      if (isOsNotificationsDisabledError(err)) {
        logger.warn(
          "[local-notif] Permission request skipped — OS-level notifications disabled.",
          { hint: OS_NOTIF_HINT },
        );
        return false;
      }
      logger.error("[local-notif] Permission request failed:", err);
      return false;
    }
  }, []);

  /**
   * Schedules a single local notification at an exact time.
   * Silently skips if the timestamp is in the past.
   */
  const schedule = useCallback(
    async (options: ScheduleNotificationOptions): Promise<void> => {
      if (!isNative()) return;
      if (options.atMs <= Date.now()) return;

      try {
        const { LocalNotifications } =
          await import("@capacitor/local-notifications");
        await LocalNotifications.schedule({
          notifications: [
            {
              id: options.id,
              title: options.title,
              body: options.body,
              schedule: { at: new Date(options.atMs), allowWhileIdle: true },
              smallIcon: "ic_launcher_foreground",
              sound: undefined,
              extra: options.url ? { url: options.url } : null,
            },
          ],
        });
      } catch (err) {
        if (isOsNotificationsDisabledError(err)) {
          logger.warn(
            "[local-notif] Schedule skipped — OS-level notifications disabled.",
            { hint: OS_NOTIF_HINT, notifId: options.id },
          );
          return;
        }
        logger.error("[local-notif] Schedule failed:", err);
      }
    },
    [],
  );

  /**
   * Cancels one or more scheduled notifications by ID.
   */
  const cancel = useCallback(async (ids: number[]): Promise<void> => {
    if (!isNative() || ids.length === 0) return;
    try {
      const { LocalNotifications } =
        await import("@capacitor/local-notifications");
      await LocalNotifications.cancel({
        notifications: ids.map((id) => ({ id })),
      });
    } catch (err) {
      if (isOsNotificationsDisabledError(err)) {
        logger.warn(
          "[local-notif] Cancel skipped — OS-level notifications disabled.",
          { hint: OS_NOTIF_HINT },
        );
        return;
      }
      logger.error("[local-notif] Cancel failed:", err);
    }
  }, []);

  /**
   * Cancels every pending notification whose id falls in `[idStart, idEnd]`
   * (inclusive). Used for cleanup of stale band-scoped schedules — e.g.,
   * Sir's device wiping out task/rule notifications that were
   * (incorrectly) scheduled by the legacy "schedule on creator's device"
   * pattern. `LocalNotifications.getPending()` enumerates the queue;
   * we filter by id range and pass only those to `cancel()`. Capacitor
   * has no native "cancel all" or "cancel by range" API.
   */
  const cancelInRange = useCallback(
    async (idStart: number, idEnd: number): Promise<void> => {
      if (!isNative()) return;
      try {
        const { LocalNotifications } =
          await import("@capacitor/local-notifications");
        const pending = await LocalNotifications.getPending();
        const toCancel = pending.notifications.filter(
          (n) => n.id >= idStart && n.id <= idEnd,
        );
        if (toCancel.length === 0) return;
        await LocalNotifications.cancel({
          notifications: toCancel.map((n) => ({ id: n.id })),
        });
        logger.info(
          `[local-notif] Cancelled ${toCancel.length} pending notif(s) in band [${idStart}, ${idEnd}].`,
        );
      } catch (err) {
        if (isOsNotificationsDisabledError(err)) {
          logger.warn(
            "[local-notif] cancelInRange skipped — OS-level notifications disabled.",
            { hint: OS_NOTIF_HINT },
          );
          return;
        }
        logger.error("[local-notif] cancelInRange failed:", err);
      }
    },
    [],
  );

  /**
   * Schedules a daily mood check-in nudge at 21:00 local time.
   * Re-calling this replaces the existing scheduled notification.
   */
  const scheduleMoodNudge = useCallback(async (): Promise<void> => {
    if (!isNative()) return;
    const now = new Date();
    const target = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      21, // 9 PM
      0,
      0,
      0,
    );

    // If 9 PM has already passed today, schedule for tomorrow
    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1);
    }

    await schedule({
      id: NOTIF_ID.MOOD_NUDGE,
      title: "💝 How are you feeling?",
      body: "Don't forget to log your mood today.",
      atMs: target.getTime(),
    });
  }, [schedule]);

  // Ensure the global tap-to-navigate listener is registered. Cheap on
  // re-runs because `ensureActionListener` is a module-level singleton.
  useEffect(() => {
    void ensureActionListener();
  }, []);

  return {
    requestPermission,
    schedule,
    cancel,
    cancelInRange,
    scheduleMoodNudge,
  };
}
