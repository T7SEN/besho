"use client";

import { useEffect, useRef } from "react";
import { dispatchPushToast } from "@/components/push-toast";

/**
 * Registers the device for FCM push notifications.
 *
 * Guarantees:
 * - Only runs on Capacitor native platform
 * - Only runs after `author` is confirmed non-null (authenticated)
 * - Idempotent within a session
 * - Re-registers if author changes
 * - Cleans up all listeners on unmount
 * - Shows in-app toast for foreground notifications
 * - Navigates to the notification URL when toast or notification is tapped
 */
export function useFCMRegistration(author: string | null) {
  const registeredForAuthor = useRef<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!author) return;
    if (registeredForAuthor.current === author) return;

    const cap = (
      globalThis as unknown as {
        Capacitor?: { isNativePlatform?: () => boolean };
      }
    ).Capacitor;
    if (!cap?.isNativePlatform?.()) return;

    cleanupRef.current?.();

    let cancelled = false;

    const register = async () => {
      try {
        const { PushNotifications } =
          await import("@capacitor/push-notifications");

        if (cancelled) return;

        // ── Permission ──────────────────────────────────────────────────
        let permStatus = await PushNotifications.checkPermissions();
        if (permStatus.receive === "prompt") {
          permStatus = await PushNotifications.requestPermissions();
        }
        if (permStatus.receive !== "granted") {
          console.warn(`[fcm] Permission not granted for ${author}.`);
          return;
        }

        if (cancelled) return;

        // ── Remove stale listeners before adding fresh ones ─────────────
        await PushNotifications.removeAllListeners();

        // ── Registration ────────────────────────────────────────────────
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
            console.error(`[fcm] Registration error for ${author}:`, err);
          },
        );

        // ── Foreground notification — show in-app toast ─────────────────
        // The OS notification is suppressed by the server (presence check).
        // This listener fires when the app is open and a push arrives.
        const foregroundListener = await PushNotifications.addListener(
          "pushNotificationReceived",
          (notification) => {
            if (cancelled) return;
            dispatchPushToast({
              title: notification.title ?? "Our Space",
              body: notification.body ?? "",
              url: notification.data?.url as string | undefined,
            });
          },
        );

        // ── Notification tap — navigate to URL ──────────────────────────
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
        console.error(`[fcm] Init failed for ${author}:`, err);
      }
    };

    void register();

    return () => {
      cancelled = true;
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, [author]);
}
