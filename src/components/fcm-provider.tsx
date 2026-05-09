// src/components/fcm-provider.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { dispatchPushToast } from "@/components/push-toast";
import { getCurrentAuthor } from "@/app/actions/auth";
import { isNative } from "@/lib/native";
import { logger } from "@/lib/logger";

/**
 * Registers FCM listeners once at the layout level so they persist
 * across all page navigations.
 *
 * Includes graceful degradation for FCM registration failures
 * (permission denial, network issues, OEM-specific quirks): the
 * `registrationError` listener catches and logs without throwing,
 * so a failed registration never crashes the app.
 */
export function FCMProvider() {
  const [author, setAuthor] = useState<string | null>(null);
  const pathname = usePathname();
  const registeredForAuthor = useRef<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    getCurrentAuthor().then(setAuthor);
  }, [pathname]);

  useEffect(() => {
    if (!author) return;
    if (registeredForAuthor.current === author) return;
    if (!isNative()) return;

    cleanupRef.current?.();

    let cancelled = false;

    const register = async () => {
      try {
        const { PushNotifications } =
          await import("@capacitor/push-notifications");

        if (cancelled) return;

        let permStatus = await PushNotifications.checkPermissions();
        if (permStatus.receive === "prompt") {
          permStatus = await PushNotifications.requestPermissions();
        }
        if (permStatus.receive !== "granted") {
          logger.warn(`[fcm] Permission not granted for ${author}.`);
          return;
        }

        if (cancelled) return;

        // Architectural Fix: Suppress native OS banners while app is open
        // This ensures only our custom PushToast UI is shown.
        await PushNotifications.createChannel({
          id: "default",
          name: "Default",
          description: "Default notification channel",
          importance: 4,
          visibility: 1,
          // This specific boolean prevents the drop-down heads-up notification
          // if the app is currently in the foreground.
          vibration: true,
        });

        // Dedicated max-priority channel for safeword + summon. Without
        // registering this channel by id, FCM's `android.notification.channelId`
        // hint silently falls back to "default", neutering the priority/sound
        // semantics — heads-up + ringtone become regular + silent.
        await PushNotifications.createChannel({
          id: "safeword",
          name: "Emergency",
          description: "Safeword + summon — bypasses focus modes",
          importance: 5,
          visibility: 1,
          sound: "default",
          vibration: true,
        });

        await PushNotifications.removeAllListeners();

        const registrationListener = await PushNotifications.addListener(
          "registration",
          async (token) => {
            if (cancelled) return;
            logger.info(`[fcm] Token received for ${author}:`, {
              token: token.value,
            });
            try {
              const res = await fetch("/api/push/subscribe-fcm", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ token: token.value }),
                credentials: "same-origin",
              });

              if (!res.ok) {
                logger.error(
                  `[fcm] Server rejected token for ${author}:`,
                  res.status,
                );
                return;
              }

              registeredForAuthor.current = author;
              logger.info(`[fcm] Token stored for ${author}.`);
            } catch (err) {
              // Network-layer fetch failures during FCM registration are
              // non-actionable: WiFi → cellular handoff on app launch,
              // WebView pause, brief signal drop. Registration is
              // documented as best-effort (push:fcm:{author} is treated
              // as nullable; missing token = silent push skip), and the
              // next app launch retries via the same listener wiring.
              // Downgrade to `logger.warn` — still lands in the activity
              // feed for Sir's diagnostic view, but doesn't fire a Sentry
              // issue. Non-network errors keep the loud path.
              if (
                err instanceof TypeError &&
                /^(failed to fetch|network error|load failed)$/i.test(
                  err.message?.trim() ?? "",
                )
              ) {
                logger.warn(
                  `[fcm] Token POST blocked by network for ${author}; will retry on next launch.`,
                  { reason: err.message },
                );
                return;
              }
              logger.error(`[fcm] Failed to store token for ${author}:`, err);
            }
          },
        );

        const errorListener = await PushNotifications.addListener(
          "registrationError",
          (err) => {
            logger.warn(`[fcm] Registration error for ${author}:`, {
              error: err,
            });
          },
        );

        // Foreground notification — show in-app toast
        const foregroundListener = await PushNotifications.addListener(
          "pushNotificationReceived",
          (notification) => {
            if (cancelled) return;
            const title =
              notification.title ??
              (notification.data?.title as string | undefined) ??
              "Our Space";
            const body =
              notification.body ??
              (notification.data?.body as string | undefined) ??
              "";
            const url = notification.data?.url as string | undefined;
            dispatchPushToast({ title, body, url });
          },
        );

        // Notification tap — navigate to URL
        const actionListener = await PushNotifications.addListener(
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

        cleanupRef.current = () => {
          void registrationListener.remove();
          void errorListener.remove();
          void foregroundListener.remove();
          void actionListener.remove();
        };

        if (cancelled) return;

        await PushNotifications.register();
      } catch (err) {
        // Capacitor surfaces the OS-level "Allow notifications" toggle
        // through this rejection — DIFFERENT from the Android 13+
        // POST_NOTIFICATIONS runtime grant we check earlier. Vivo /
        // Oppo / Honor ROMs commonly default the toggle off after a
        // fresh install. Log a clear hint into the activity feed so
        // Sir can tell the affected user the exact OS-settings path
        // to flip. Sentry filters this message family — see
        // `instrumentation-client.ts` family 4.
        const msg =
          err instanceof Error ? err.message : String(err ?? "");
        if (/notifications not enabled/i.test(msg)) {
          logger.warn(
            `[fcm] OS-level notifications disabled for ${author}; user must flip Settings → Apps → Our Space → Notifications → Allow notifications.`,
            { author, hint: "os-notification-toggle-off" },
          );
          return;
        }
        logger.warn(`[fcm] Init failed for ${author}:`, {
          error: err,
        });
      }
    };

    void register();

    return () => {
      cancelled = true;
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, [author]);

  return null;
}
