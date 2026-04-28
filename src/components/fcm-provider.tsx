"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { dispatchPushToast } from "@/components/push-toast";
import { getCurrentAuthor } from "@/app/actions/auth";
import { isNative } from "@/lib/native";

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
          console.warn(`[fcm] Permission not granted for ${author}.`);
          return;
        }

        if (cancelled) return;

        await PushNotifications.removeAllListeners();

        const registrationListener = await PushNotifications.addListener(
          "registration",
          async (token) => {
            if (cancelled) return;
            console.log(`[fcm] Token received for ${author}:`, token.value);
            try {
              const res = await fetch("/api/push/subscribe-fcm", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ token: token.value }),
                credentials: "same-origin",
              });

              if (!res.ok) {
                console.error(
                  `[fcm] Server rejected token for ${author}:`,
                  res.status,
                );
                return;
              }

              registeredForAuthor.current = author;
              console.log(`[fcm] Token stored for ${author}.`);
            } catch (err) {
              console.error(`[fcm] Failed to store token for ${author}:`, err);
            }
          },
        );

        const errorListener = await PushNotifications.addListener(
          "registrationError",
          (err) => {
            // CRITICAL FOR HONOR DEVICES:
            // FCM will fire this if Play Services are missing. We catch it
            // gracefully to prevent unhandled promise rejections.
            console.warn(
              `[fcm] Registration error for ${author} (Likely No GMS):`,
              err,
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

        // Attempt registration. Will throw on devices without GMS.
        await PushNotifications.register();
      } catch (err) {
        console.warn(
          `[fcm] Init failed for ${author} (Graceful Degradation):`,
          err,
        );
        // TODO: In the future, we can initialize standard Web Push Service Worker
        // here as a fallback mechanism for Besho's devices.
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
