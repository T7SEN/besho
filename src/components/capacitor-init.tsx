"use client";

import { useEffect } from "react";

/**
 * Initializes Capacitor native plugins on app start.
 * Only handles visual setup (StatusBar, SplashScreen).
 * FCM registration is intentionally excluded — it requires a confirmed
 * authenticated user and is handled by useFCMRegistration() in the
 * dashboard after getCurrentAuthor() resolves.
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

  return null;
}
