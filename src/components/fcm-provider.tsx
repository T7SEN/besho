// src/components/fcm-provider.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { dispatchPushToast } from "@/components/push-toast";
import { getCurrentAuthor } from "@/app/actions/auth";
import { isNative } from "@/lib/native";
import { logger } from "@/lib/logger";
import {
  isOsNotificationsDisabledError,
  OS_NOTIF_HINT,
} from "@/lib/os-notifications";
import {
  DIRECTIVE_ARRIVED_EVENT,
  DIRECTIVE_PAYLOAD_KIND,
} from "@/lib/directive-constants";
import {
  PUNISHMENT_ARRIVED_EVENT,
  PUNISHMENT_PAYLOAD_KIND,
} from "@/lib/punishment-constants";

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
    let appStateCleanup: (() => void) | null = null;

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

        // Foreground notification — branch on `data.kind` so feature
        // surfaces (DirectiveDialog, future PunishmentOverlay, ...)
        // can intercept payloads addressed to them. Default path
        // dispatches the standard PushToast.
        const foregroundListener = await PushNotifications.addListener(
          "pushNotificationReceived",
          (notification) => {
            if (cancelled) return;
            const kind = notification.data?.kind as string | undefined;

            if (kind === DIRECTIVE_PAYLOAD_KIND) {
              const directiveId = notification.data?.directiveId as
                | string
                | undefined;
              try {
                (
                  globalThis as unknown as {
                    dispatchEvent: (e: Event) => void;
                  }
                ).dispatchEvent(
                  new CustomEvent(DIRECTIVE_ARRIVED_EVENT, {
                    detail: { id: directiveId },
                  }),
                );
              } catch (err) {
                // Falling back to a toast keeps the user informed
                // even if the dialog event-dispatch path breaks. The
                // directive record is still durable in Redis;
                // refresh-listener pulls will pick it up.
                logger.warn("[fcm] directive dispatch failed", { err });
                dispatchPushToast({
                  title: notification.title ?? "🎯 New directive",
                  body: notification.body ?? "",
                  url: "/",
                });
              }
              return;
            }

            if (kind === PUNISHMENT_PAYLOAD_KIND) {
              const punishmentId = notification.data?.punishmentId as
                | string
                | undefined;
              try {
                (
                  globalThis as unknown as {
                    dispatchEvent: (e: Event) => void;
                  }
                ).dispatchEvent(
                  new CustomEvent(PUNISHMENT_ARRIVED_EVENT, {
                    detail: { id: punishmentId },
                  }),
                );
              } catch (err) {
                logger.warn("[fcm] punishment dispatch failed", { err });
                dispatchPushToast({
                  title: notification.title ?? "🔔 Punishment timer",
                  body: notification.body ?? "",
                  url: "/",
                });
              }
              return;
            }

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
        // fresh install. Detection helper lives in
        // `@/lib/os-notifications` so the same shape applies to the
        // local-notifications hook.
        if (isOsNotificationsDisabledError(err)) {
          logger.warn(
            `[fcm] OS-level notifications disabled for ${author}.`,
            { author, hint: OS_NOTIF_HINT },
          );
          return;
        }
        logger.warn(`[fcm] Init failed for ${author}:`, {
          error: err,
        });
      }
    };

    // Retry on app foreground if registration hasn't yet succeeded.
    // Handles the case where the user toggled a system setting (OS-
    // level "Allow notifications", app permission, etc.) while the app
    // was backgrounded — the first mount-time `register()` failed
    // before the gate was flipped, but we can succeed on resume now
    // that it is. Without this, the user has to fully relaunch the
    // app to retry, which isn't obvious post-fix from the user's POV.
    const setupAppStateRetry = async () => {
      try {
        const { App } = await import("@capacitor/app");
        const handle = await App.addListener("appStateChange", (state) => {
          if (cancelled) return;
          if (!state.isActive) return;
          if (registeredForAuthor.current === author) return;
          logger.info(
            `[fcm] App resumed; retrying registration for ${author}.`,
          );
          void register();
        });
        if (cancelled) {
          void handle.remove();
          return;
        }
        appStateCleanup = () => void handle.remove();
      } catch (err) {
        logger.warn(
          `[fcm] Failed to register app-state retry listener for ${author}:`,
          { error: err },
        );
      }
    };

    void register();
    void setupAppStateRetry();

    return () => {
      cancelled = true;
      cleanupRef.current?.();
      cleanupRef.current = null;
      appStateCleanup?.();
    };
  }, [author]);

  return null;
}
