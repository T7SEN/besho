"use client";

import { useEffect } from "react";

/**
 * Initializes Capacitor native plugins on app start.
 * Only runs when inside the native Android shell — no-op on PWA/browser.
 */
export function CapacitorInit() {
  useEffect(() => {
    const cap = (
      globalThis as unknown as {
        Capacitor?: { isNativePlatform?: () => boolean };
      }
    ).Capacitor;

    if (!cap?.isNativePlatform?.()) return;

    void (async () => {
      // ── Status Bar ──────────────────────────────────────────────────────
      try {
        const { StatusBar, Style } = await import("@capacitor/status-bar");
        await StatusBar.setStyle({ style: Style.Dark });
        await StatusBar.setBackgroundColor({ color: "#09090b" });
      } catch (err) {
        console.error("[native] StatusBar init failed:", err);
      }

      // ── Splash Screen ───────────────────────────────────────────────────
      try {
        const { SplashScreen } = await import("@capacitor/splash-screen");
        await SplashScreen.hide({ fadeOutDuration: 300 });
      } catch (err) {
        console.error("[native] SplashScreen hide failed:", err);
      }

      // ── Push Notifications (FCM) ────────────────────────────────────────
      try {
        const { PushNotifications } =
          await import("@capacitor/push-notifications");

        let permStatus = await PushNotifications.checkPermissions();

        if (permStatus.receive === "prompt") {
          permStatus = await PushNotifications.requestPermissions();
        }

        if (permStatus.receive !== "granted") {
          console.warn("[push] Notification permission not granted.");
          return;
        }

        await PushNotifications.register();

        await PushNotifications.addListener("registration", async (token) => {
          console.log("[push] FCM token:", token.value);
          try {
            await fetch("/api/push/subscribe-fcm", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ token: token.value }),
              credentials: "same-origin",
            });
            console.log("[push] FCM token stored on server.");
          } catch (err) {
            console.error("[push] Failed to store FCM token:", err);
          }
        });

        await PushNotifications.addListener("registrationError", (err) => {
          console.error("[push] FCM registration error:", err);
        });

        await PushNotifications.addListener(
          "pushNotificationReceived",
          (notification) => {
            console.log("[push] Foreground notification:", notification);
          },
        );

        await PushNotifications.addListener(
          "pushNotificationActionPerformed",
          (action) => {
            const url = action.notification.data?.url as string | undefined;
            if (url) {
              (
                globalThis as unknown as { location: { href: string } }
              ).location.href = url;
            }
          },
        );
      } catch (err) {
        console.error("[push] FCM init failed:", err);
      }
    })();
  }, []);

  return null;
}
