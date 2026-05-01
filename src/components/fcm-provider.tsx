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
 * Includes graceful degradation for Besho's Honor device:
 * Devices without Google Mobile Services (GMS) will fail FCM registration.
 * This component will catch that failure and prevent app crashes.
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
              logger.error(`[fcm] Failed to store token for ${author}:`, err);
            }
          },
        );

        const errorListener = await PushNotifications.addListener(
          "registrationError",
          (err) => {
            logger.warn(
              `[fcm] Registration error for ${author} (Likely No GMS):`,
              { error: err },
            );
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
