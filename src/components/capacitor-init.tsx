"use client";

import { useEffect } from "react";
import { useBadge } from "@/hooks/use-badge";
import { useLocalNotifications } from "@/hooks/use-local-notifications";
import { isNative } from "@/lib/native";
import { logger } from "@/lib/logger";

/**
 * Initializes Capacitor native plugins on app start.
 *
 * - StatusBar: overlays webview for true edge-to-edge immersive UI
 * - SplashScreen: hides with a smooth fade
 * - LocalNotifications: requests permission and sets the daily nudge
 * - Badge: syncs app icon badge count
 */
export function CapacitorInit() {
  // Badge sync — runs on mount, every 5 min, and on app foreground
  useBadge();

  const { requestPermission, scheduleMoodNudge } = useLocalNotifications();

  // StatusBar + SplashScreen
  useEffect(() => {
    if (!isNative()) return;

    void (async () => {
      try {
        const { StatusBar, Style } = await import("@capacitor/status-bar");

        // Architectural Fix: True Native Immersive Mode
        // This allows the webview to flow underneath the system clock and battery
        // Your CSS `env(safe-area-inset-top)` will now perfectly pad the content
        await StatusBar.setOverlaysWebView({ overlay: true });
        await StatusBar.setStyle({ style: Style.Dark });
      } catch (err) {
        logger.error("[native] StatusBar init failed:", err);
      }

      try {
        const { SplashScreen } = await import("@capacitor/splash-screen");
        await SplashScreen.hide({ fadeOutDuration: 300 });
      } catch (err) {
        logger.error("[native] SplashScreen hide failed:", err);
      }
    })();
  }, []);

  // Local notification permission + daily mood nudge
  useEffect(() => {
    if (!isNative()) return;

    void (async () => {
      const isGranted = await requestPermission();
      if (isGranted) {
        // Utilize the DRY hook method instead of duplicating the Date math
        await scheduleMoodNudge();
      }
    })();
  }, [requestPermission, scheduleMoodNudge]);

  return null;
}
