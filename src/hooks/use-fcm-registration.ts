"use client";

import { useEffect, useRef } from "react";

/**
 * Registers the device for FCM push notifications.
 *
 * Guarantees:
 * - Only runs on Capacitor native platform (no-op on PWA/browser)
 * - Only runs after `author` is confirmed non-null (user is authenticated)
 * - Idempotent — will not re-register if already registered this session
 * - Re-registers automatically if the author changes (account switch)
 * - Cleans up all listeners on unmount to prevent duplicates
 * - Never stores a token under the wrong author
 *
 * @param author - The authenticated author from getCurrentAuthor().
 *                 Pass null until auth is resolved — the hook will wait.
 */
export function useFCMRegistration(author: string | null) {
  const registeredForAuthor = useRef<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    // Wait until we have a confirmed authenticated author
    if (!author) return;

    // Don't re-register if we already did for this author this session
    if (registeredForAuthor.current === author) return;

    // Check if we're on a native Capacitor platform
    const cap = (
      globalThis as unknown as {
        Capacitor?: { isNativePlatform?: () => boolean };
      }
    ).Capacitor;
    if (!cap?.isNativePlatform?.()) return;

    // Clean up any previous listeners before registering again
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
          console.warn(
            `[fcm] Notification permission not granted for ${author}.`,
          );
          return;
        }

        if (cancelled) return;

        // ── Listeners ───────────────────────────────────────────────────
        // Remove all existing listeners before adding new ones to prevent
        // duplicate handlers if this effect runs more than once.
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
                const body = await res.text();
                console.error(
                  `[fcm] Server rejected token for ${author}:`,
                  res.status,
                  body,
                );
                return;
              }

              registeredForAuthor.current = author;
              console.log(`[fcm] Token stored successfully for ${author}.`);
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

        const foregroundListener = await PushNotifications.addListener(
          "pushNotificationReceived",
          (notification) => {
            console.log("[fcm] Foreground notification:", notification);
          },
        );

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

        // Store cleanup function
        cleanupRef.current = () => {
          void registrationListener.remove();
          void errorListener.remove();
          void foregroundListener.remove();
          void actionListener.remove();
        };

        if (cancelled) return;

        // ── Register — triggers the registration listener above ─────────
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
