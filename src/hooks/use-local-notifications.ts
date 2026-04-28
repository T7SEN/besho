"use client";

import { useCallback } from "react";

// ── Notification ID ranges ────────────────────────────────────────────────────
// Stable IDs prevent duplicate notifications when re-scheduling.
// Derive task/rule IDs from their string IDs using these offsets.
export const NOTIF_ID = {
  MOOD_NUDGE: 100,
  taskDeadline: (numericSuffix: number) => 1000 + (numericSuffix % 900),
  ruleAckDeadline: (numericSuffix: number) => 2000 + (numericSuffix % 900),
} as const;

function isNative(): boolean {
  const cap = (
    globalThis as unknown as {
      Capacitor?: { isNativePlatform?: () => boolean };
    }
  ).Capacitor;
  return typeof cap !== "undefined" && !!cap.isNativePlatform?.();
}

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
      console.error("[local-notif] Permission request failed:", err);
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
              extra: null,
            },
          ],
        });
      } catch (err) {
        console.error("[local-notif] Schedule failed:", err);
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
      console.error("[local-notif] Cancel failed:", err);
    }
  }, []);

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

  return { requestPermission, schedule, cancel, scheduleMoodNudge };
}
