"use client";

import { useEffect } from "react";
import { useBadge } from "@/hooks/use-badge";
import { isNative } from "@/lib/native";

/**
 * Initializes Capacitor native plugins on app start.
 *
 * - StatusBar: sets dark style and background colour
 * - SplashScreen: hides with a fade
 * - LocalNotifications: requests POST_NOTIFICATIONS permission (Android 13+)
 * and schedules the daily mood nudge
 * - Badge: syncs app icon badge count with pending tasks + unacknowledged rules
 *
 * FCM registration is intentionally excluded — it requires a confirmed
 * authenticated user and is handled by useFCMRegistration() after
 * getCurrentAuthor() resolves.
 */
export function CapacitorInit() {
  // Badge sync — runs on mount, every 5 min, and on app foreground
  useBadge();

  // StatusBar + SplashScreen
  useEffect(() => {
    if (!isNative()) return;

    void (async () => {
      try {
        const { StatusBar, Style } = await import("@capacitor/status-bar");
        await StatusBar.setStyle({ style: Style.Dark });
        await StatusBar.setBackgroundColor({ color: "#09090b" });
      } catch (err) {
        console.error("[native] StatusBar init failed:", err);
      }

      try {
        const { SplashScreen } = await import("@capacitor/splash-screen");
        await SplashScreen.hide({ fadeOutDuration: 300 });
      } catch (err) {
        console.error("[native] SplashScreen hide failed:", err);
      }
    })();
  }, []);

  // Local notification permission + daily mood nudge
  useEffect(() => {
    if (!isNative()) return;

    void (async () => {
      try {
        const { LocalNotifications } =
          await import("@capacitor/local-notifications");

        const { display } = await LocalNotifications.requestPermissions();
        if (display !== "granted") return;

        // Schedule the daily mood nudge at 21:00 local time.
        // Re-scheduling replaces any existing nudge with the same ID.
        const now = new Date();
        const target = new Date(
          now.getFullYear(),
          now.getMonth(),
          now.getDate(),
          21,
          0,
          0,
          0,
        );

        if (target.getTime() <= now.getTime()) {
          target.setDate(target.getDate() + 1);
        }

        await LocalNotifications.schedule({
          notifications: [
            {
              id: 100, // NOTIF_ID.MOOD_NUDGE
              title: "💝 How are you feeling?",
              body: "Don't forget to log your mood today.",
              schedule: { at: target, allowWhileIdle: true },
              smallIcon: "ic_launcher_foreground",
              sound: undefined,
              extra: null,
            },
          ],
        });
      } catch (err) {
        console.error("[local-notif] Init failed:", err);
      }
    })();
  }, []);

  return null;
}
